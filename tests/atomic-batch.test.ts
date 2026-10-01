/**
 * The batch write, and the half-written day it exists to prevent.
 *
 * On 2026-10-01 a seven-task `daily_plan_project` call had one summary over the
 * 500-character limit. The old implementation looped `addItem`, throwing on the
 * first failure — so FIVE tasks were already stored when the error surfaced. The
 * caller saw a failure and a half-written day, which is the worst of both: it
 * cannot safely retry (that duplicates the five) and it cannot trust the store.
 *
 * Two directions are asserted here, and the second matters more:
 *   - `buildNewItems` rejects the whole batch and NAMES the offending task, and
 *   - the write path is atomic BY CONSTRUCTION — validated before anything is
 *     written, then one store call — checked against the source, because the
 *     property is structural and a future refactor could quietly restore the loop.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAX_ITEMS, MAX_TEXT, buildNewItems } from '../src/planner.ts'

const plannerSource = readFileSync(new URL('../src/planner.ts', import.meta.url), 'utf8')
const toolsSource = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')

/** The body of one `case '<op>': { ... }` block, up to the next case at the same indent. */
function caseBody(source: string, op: string): string {
  const start = source.indexOf("case '" + op + "': {")
  assert.notEqual(start, -1, "case '" + op + "' not found")
  const rest = source.slice(start + 1)
  const next = rest.indexOf("\n        case '")
  return next === -1 ? rest : rest.slice(0, next)
}

/** The body of the daily_plan_project tool, from its declaration to the next defineTool. */
function planProjectTool(source: string): string {
  const start = source.indexOf("name: 'daily_plan_project'")
  assert.notEqual(start, -1, 'daily_plan_project not found')
  const rest = source.slice(start)
  const next = rest.indexOf('defineTool({')
  return next === -1 ? rest : rest.slice(0, next)
}

describe('buildNewItems', () => {
  it('builds every task in a valid batch, with distinct ids', () => {
    const built = buildNewItems(
      [
        { text: 'first', summary: 'why first' },
        { text: 'second' },
        { text: 'third', summary: 'why third' },
      ],
      0,
      'today',
    )
    assert.ok(built.ok)
    assert.deepEqual(built.items.map((item) => item.text), ['first', 'second', 'third'])
    assert.equal(built.items[0]!.summary, 'why first')
    assert.equal(built.items[1]!.summary, undefined)
    assert.equal(built.items[0]!.origin, 'today')
    assert.equal(new Set(built.items.map((item) => item.id)).size, 3)
    for (const item of built.items) {
      assert.equal(item.done, false)
      assert.equal(item.doneAt, null)
    }
  })

  it('rejects the WHOLE batch when one task is over-long, and names which one', () => {
    // The exact shape of the 2026-10-01 bug: task 6 of 7 was at fault.
    const tasks = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ text: 'task number ' + n }))
    tasks[5]!.summary = 'x'.repeat(MAX_TEXT + 1)
    const built = buildNewItems(tasks, 0, 'today')
    assert.equal(built.ok, false)
    if (built.ok) return
    assert.equal(built.code, 'invalid_payload')
    assert.match(built.message, /task 6 of 7/)
    assert.match(built.message, /summary must be 1-500 chars/)
    assert.match(built.message, /got 501 chars/)
    // And it says WHICH task in words, not just by index.
    assert.match(built.message, /task number 6/)
  })

  it('accepts a summary of exactly the limit and rejects one character more', () => {
    const atLimit = buildNewItems([{ text: 'boundary', summary: 'x'.repeat(MAX_TEXT) }], 0, 'today')
    assert.equal(atLimit.ok, true)
    const overLimit = buildNewItems([{ text: 'boundary', summary: 'x'.repeat(MAX_TEXT + 1) }], 0, 'today')
    assert.equal(overLimit.ok, false)
  })

  it('rejects empty or over-long text, naming the task and previewing it', () => {
    const empty = buildNewItems([{ text: 'ok' }, { text: '   ' }], 0, 'today')
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.match(empty.message, /task 2 of 2/)

    const long = buildNewItems([{ text: 'x'.repeat(MAX_TEXT + 1) }], 0, 'today')
    assert.equal(long.ok, false)
    if (!long.ok) assert.equal(long.code, 'empty_text')
  })

  it('rejects a non-object entry rather than storing a hole', () => {
    const built = buildNewItems(['just a string'], 0, 'today')
    assert.equal(built.ok, false)
    if (!built.ok) assert.match(built.message, /task 1 of 1 must be an object/)
  })

  it('refuses a batch that would exceed the day limit, before writing any of it', () => {
    const tooMany = buildNewItems(
      Array.from({ length: 5 }, (_, i) => ({ text: 'task ' + i })),
      MAX_ITEMS - 3,
      'today',
    )
    assert.equal(tooMany.ok, false)
    if (!tooMany.ok) {
      assert.equal(tooMany.code, 'too_many_items')
      assert.match(tooMany.message, new RegExp('at most ' + MAX_ITEMS))
      assert.match(tooMany.message, /holds 47/)
      assert.match(tooMany.message, /add 5/)
    }
    // Exactly filling the day is allowed.
    const exact = buildNewItems(Array.from({ length: 3 }, (_, i) => ({ text: 't' + i })), MAX_ITEMS - 3, 'today')
    assert.equal(exact.ok, true)
  })

  it('rejects a non-array and an empty array', () => {
    assert.equal(buildNewItems(undefined, 0, 'today').ok, false)
    assert.equal(buildNewItems([], 0, 'today').ok, false)
  })
})

describe('the batch write is atomic by construction', () => {
  it('addItems writes the whole batch in exactly ONE store call', () => {
    const body = caseBody(plannerSource, 'addItems')
    const stores = body.match(/await store\(/g) ?? []
    assert.equal(
      stores.length,
      1,
      'the addItems case must write once; ' + stores.length + ' store calls would allow a partial batch',
    )
    // And it must validate before that write, not during it.
    const validateAt = body.indexOf('buildNewItems(')
    const writeAt = body.indexOf('await store(')
    assert.ok(validateAt !== -1, 'addItems must call buildNewItems')
    assert.ok(validateAt < writeAt, 'buildNewItems must run BEFORE the store write')
  })

  it('daily_plan_project no longer loops one addItem per task', () => {
    const tool = planProjectTool(toolsSource)
    assert.equal(
      tool.includes("apply('addItem'"),
      false,
      "daily_plan_project must not call apply('addItem' — a per-task write loop is what left a half-written day",
    )
    assert.ok(tool.includes("apply('addItems'"), 'daily_plan_project must use the batch op')
  })

  it('daily_plan_project validates every task before it writes any', () => {
    const tool = planProjectTool(toolsSource)
    const validateAt = tool.indexOf('buildNewItems(')
    const writeAt = tool.indexOf("planner.apply('addItems'")
    assert.ok(validateAt !== -1, 'daily_plan_project must validate the batch up front')
    assert.ok(writeAt !== -1, 'daily_plan_project must call the batch op')
    assert.ok(
      validateAt < writeAt,
      'the batch must be validated before the first write, or a bad task on tomorrow leaves today already written',
    )
    // The tool's own failure must not be swallowed before the write.
    assert.match(tool, /if \(!check\.ok\) throw new Error/)
  })

  it('the tool tells the model the limit it enforces', () => {
    const tool = planProjectTool(toolsSource)
    assert.match(tool, /Max 500 characters/)
    assert.match(tool, /validated before ANY is written/)
  })
})
