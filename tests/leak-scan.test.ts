/**
 * Tests for scripts/leak-scan.sh — the scanner the publish gate's command block
 * runs, and a shipped artefact in its own right.
 *
 * It is tested HERE, not by hand, because a scanner that reports CLEAN on a tree
 * it did not read is worse than no scanner: the register's gate would show twelve
 * green items over it. Each case below is a way that could happen, and each one
 * asserts the artefact rather than the message.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(REPO, 'scripts/leak-scan.sh')

interface Run {
  code: number
  out: string
}

/** Run the scanner the way the register's command block does: `bash <path> .` */
function run(args: string[], cwd: string): Run {
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string }
    return { code: failed.status ?? -1, out: (failed.stdout ?? '') + (failed.stderr ?? '') }
  }
}

/** A throwaway git repository with the given files tracked. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'leak-scan-test-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  execFileSync('git', ['add', '-A'], { cwd: dir })
  return dir
}

function termsFile(dir: string, body: string, name = '.leak-terms'): string {
  writeFileSync(join(dir, name), body, 'utf8')
  return join(dir, name)
}

describe('the leak scanner', () => {
  it('reports CLEAN on this repository, which is the line the gate promises', () => {
    // The command block says "must print SCAN CLEAN". This is that claim, on the
    // real tree, with the scanner the block points at.
    const empty = mkdtempSync(join(tmpdir(), 'leak-scan-terms-'))
    const terms = termsFile(empty, '')
    const result = run(['.', '--terms', terms], REPO)
    assert.equal(result.code, 0, result.out)
    assert.match(result.out, /SCAN CLEAN/)
    rmSync(empty, { recursive: true, force: true })
  })

  it('finds a planted term, names the place, and does NOT reprint the secret', () => {
    // A scanner that echoes the matched line into a terminal, a log or a
    // screenshot is a second leak. File and line number are enough to act on.
    const dir = repo({ 'notes.md': 'line one\nthe acme-internal-xyz pilot is behind schedule\n' })
    const terms = termsFile(dir, 'acme-internal-xyz\n')
    const result = run(['.', '--terms', terms], dir)
    assert.equal(result.code, 1)
    assert.match(result.out, /HIT {2}term "acme-internal-xyz" in notes\.md:2/)
    assert.match(result.out, /SCAN FAILED/)
    assert.equal(result.out.includes('behind schedule'), false, 'the matching text was printed')
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the terms file it finds in the tree, with no --terms needed', () => {
    const dir = repo({ 'a.md': 'nothing to see\n', 'b.md': 'a mention of hidden-client\n' })
    termsFile(dir, '# a comment\n\nhidden-client\n')
    const result = run(['.'], dir)
    assert.equal(result.code, 1)
    assert.match(result.out, /b\.md:1/)
    // The comment and the blank line are not terms, and the count says so.
    assert.match(result.out, /\(1 term\(s\)/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('searches terms as LITERALS, not patterns', () => {
    // A term containing dots is a file name or a hostname, not a regex.
    const dir = repo({ 'x.md': 'abc is fine\na.c is the literal one\n' })
    const terms = termsFile(dir, 'a.c\n', 'terms-lit')
    const result = run(['.', '--terms', terms], dir)
    assert.equal(result.code, 1)
    assert.match(result.out, /x\.md:2/)
    assert.equal(result.out.includes('x.md:1'), false, 'matched text the term does not literally contain')
    rmSync(dir, { recursive: true, force: true })
  })

  it('REFUSES when the terms file is itself tracked, which is the worst case', () => {
    // A tracked terms file is a list of everything that must not be published, on
    // its way to being published. A clean scan here would be the most dangerous
    // possible result, so the scanner refuses before it scans.
    const dir = repo({ 'README.md': '# fine\n' })
    termsFile(dir, 'secret-project\n')
    execFileSync('git', ['add', '-f', '.leak-terms'], { cwd: dir })
    // Rewrite it after staging so the tracked copy is not the one on disk.
    const result = run(['.'], dir)
    assert.equal(result.code, 2)
    assert.match(result.out, /REFUSING — the terms file is TRACKED by git: \.leak-terms/)
    assert.equal(/SCAN CLEAN/.test(result.out), false, 'refused but still reported clean')
    rmSync(dir, { recursive: true, force: true })
  })

  it('flags a secret-shaped file by NAME, without printing its contents', () => {
    const dir = repo({ '.env': 'API_TOKEN=abc123\n', 'ok.md': 'fine\n' })
    const empty = mkdtempSync(join(tmpdir(), 'leak-scan-terms-'))
    const result = run(['.', '--terms', termsFile(empty, '')], dir)
    assert.equal(result.code, 1)
    assert.match(result.out, /secret-shaped file is TRACKED: \.env/)
    assert.equal(result.out.includes('API_TOKEN=abc123'), false, 'the secret was printed')
    rmSync(dir, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  })

  it('refuses outside a git work tree instead of guessing what is publishable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leak-scan-nogit-'))
    const result = run(['.'], dir)
    assert.equal(result.code, 2)
    assert.match(result.out, /not inside a git work tree/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs the built-in checks with no terms file, and SAYS there are no terms', () => {
    // The silent-pass failure mode: no terms configured must never read as a
    // thorough scan. It says which checks ran.
    const dir = repo({ 'ok.md': 'fine\n' })
    const result = run(['.'], dir)
    assert.equal(result.code, 0, result.out)
    assert.match(result.out, /terms {6}NONE FOUND — built-in checks only/)
    assert.match(result.out, /SCAN CLEAN/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a --terms file that does not exist rather than scanning nothing', () => {
    const dir = repo({ 'ok.md': 'fine\n' })
    const result = run(['.', '--terms', join(dir, 'nope.txt')], dir)
    assert.equal(result.code, 2)
    assert.match(result.out, /--terms file not found/)
    rmSync(dir, { recursive: true, force: true })
  })
})
