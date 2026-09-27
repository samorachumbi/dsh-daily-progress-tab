/**
 * The store contract for a plugin record.
 *
 * This file exists because of a bug that no other test could see. Three new
 * fields were added to the `PluginRecord` type and used all the way through —
 * the tool accepted them, the snapshot carried them, the gate read them — but
 * they were never added to `PluginSchema` in domain.ts. zod STRIPS unknown keys
 * by default, so the values were dropped on read.
 *
 * Why it took a restart to notice: the write's own response is built from the
 * record the planner has just written, so it looks perfect. Only reopening the
 * domain from disk showed that the facts were gone. That is the rule this file
 * encodes — persistence is verified by a REOPEN, never by the write's reply.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dailyProgressDomain } from '../src/domain.ts'

/** The domain's schema for one stored plugin, with the zod surface asserted on. */
interface ObjectSchema {
  shape: Record<string, unknown>
  parse: (value: unknown) => Record<string, unknown>
}

const pluginSchema = dailyProgressDomain.tables.plugins.valueSchema as unknown as ObjectSchema

/**
 * A record with every field the register can hold, all filled in. Listed in full
 * rather than spread from a fixture, because the FIRST test below is only as good
 * as this list: it compares the list against the schema's declared keys, so a
 * field added here and forgotten in the schema fails immediately.
 */
const EVERY_FIELD: Record<string, unknown> = {
  id: 'p1',
  name: 'dsh-cost-bubble',
  origin: 'ours',
  visibility: 'showcase',
  status: 'local',
  title: 'Cost bubble',
  summary: 'A pill showing the live cost of the chat.',
  upstream: 'omdsh-dev/x@bedbd28',
  licence: 'MIT',
  sourcePath: '~/projects/plugins/dsh-cost-bubble',
  publicUrl: 'https://github.com/octo-dev/dsh-cost-bubble',
  publishedAt: '2026-09-27',
  installed: true,
  hasLicenseFile: true,
  hasReadme: true,
  hasScreenshot: true,
  sourceOutsideProfile: true,
  leakScanPassed: true,
  leakScanAt: '2026-09-27',
  preflightPassed: true,
  preflightAt: '2026-09-27',
  preflightNote: '94 tests, 287 probes, build clean',
  gitReady: true,
  verifiedAt: '2026-09-27',
  notes: 'kept for the record',
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
}

describe('the stored plugin record', () => {
  it('declares every field the register can hold', () => {
    // The failure this catches: a field is added to the record and forgotten in
    // the schema. The write succeeds, the read drops it, and the feature quietly
    // half-works - with the gate reporting a fact it was just told.
    const declared = new Set(Object.keys(pluginSchema.shape))
    const missing = Object.keys(EVERY_FIELD).filter((key) => !declared.has(key))
    assert.deepEqual(missing, [])
  })

  it('keeps the pre-flight facts, which is how this file came to exist', () => {
    const parsed = pluginSchema.parse(EVERY_FIELD)
    assert.equal(parsed.preflightPassed, true)
    assert.equal(parsed.preflightAt, '2026-09-27')
    assert.equal(parsed.preflightNote, '94 tests, 287 probes, build clean')
  })

  it('strips a field it does not declare, which is why the check above is needed', () => {
    // The mechanism, asserted rather than assumed. If zod ever stopped stripping
    // unknown keys, the guard above would become unnecessary and this test would
    // fail and say so, instead of the guard quietly protecting nothing.
    const parsed = pluginSchema.parse({ ...EVERY_FIELD, notAField: 'gone' })
    assert.equal(Object.hasOwn(parsed, 'notAField'), false)
  })

  it('still validates the fields it does declare', () => {
    // A schema that accepts anything protects nothing, so the guard above must not
    // have been bought by loosening this one.
    assert.throws(() => pluginSchema.parse({ ...EVERY_FIELD, origin: 'borrowed' }))
    assert.throws(() => pluginSchema.parse({ ...EVERY_FIELD, name: '' }))
    assert.throws(() => pluginSchema.parse({ ...EVERY_FIELD, id: undefined }))
  })
})
