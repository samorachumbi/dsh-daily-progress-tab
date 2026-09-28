/**
 * The invariant companion. Two directions, and the second matters more than the first:
 *
 *   - every violation is caught and NAMED, and
 *   - the records this plugin actually writes PASS. These checks throw when they fire, so a
 *     false positive would take down a live host — measured against the durable store before
 *     the companion was written (4 day plans: 0 key/date mismatches, 0 id problems; 3 plugin
 *     records: 0 carrying derived fields).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DERIVED_FIELDS, DOMAIN, PACKAGE_NAME, dateFromKey, inject, name, validateChange } from '../src/invariant.ts'
import type { ChangeLike } from '../src/invariant.ts'

/** A day plan written the way the planner writes one: key and record date agree, ids are uuids. */
function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-09-28',
    tz: 'Africa/Nairobi',
    items: [
      { id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', text: 'one', done: false, doneAt: null, origin: 'today' },
      { id: '1a2b3c4d-5e6f-7081-8293-a4b5c6d7e8f9', text: 'two', done: false, doneAt: null, origin: 'today' },
    ],
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  }
}

const change = (over: Partial<ChangeLike> = {}): ChangeLike => ({
  domain: DOMAIN,
  table: 'plans',
  key: 'default:2026-09-28',
  operation: 'put',
  value: plan(),
  ...over,
})

describe('the invariant companion', () => {
  it('is shaped the way the loader expects', () => {
    // The harness loads this module as a cordis companion: a name, the service it needs,
    // and an apply that registers. A wrong service name here fails at boot, not at use.
    assert.equal(name, 'daily-progress-tab-invariant')
    assert.deepEqual([...inject], ['invariants'])
    assert.equal(PACKAGE_NAME, 'dsh-daily-progress-tab')
    assert.equal(DOMAIN, 'daily_progress_tab')
  })

  it('passes the records this plugin actually writes', () => {
    assert.equal(validateChange(change()), '')
    // A day with no items at all is legal (a plan is created before anything is added).
    assert.equal(validateChange(change({ value: plan({ items: [] }) })), '')
    // Other tables and other domains are not this package's business.
    assert.equal(validateChange(change({ table: 'projects' })), '')
    assert.equal(validateChange(change({ domain: 'someone_else' })), '')
    assert.equal(validateChange(change({ operation: 'deleted', value: undefined })), '')
  })

  it('catches a day record whose date does not match its key', () => {
    // The failure this exists for: no exception, no log — the page just shows yesterday.
    const problem = validateChange(change({ value: plan({ date: '2026-09-27' }) }))
    assert.match(problem, /must equal the date in its key/)
    assert.match(problem, /2026-09-27/)
    assert.equal(dateFromKey('default:2026-09-28'), '2026-09-28')
    assert.equal(dateFromKey('2026-09-28'), '2026-09-28', 'a key with no scope still yields its date')
  })

  it('catches an item with no id, and reports which day it was in', () => {
    const problem = validateChange(change({ value: plan({ items: [{ text: 'no id' }] }) }))
    assert.match(problem, /needs a non-empty id/)
    assert.match(problem, /default:2026-09-28/)
  })

  it('catches two items sharing an id, because every operation would hit the first', () => {
    const items = plan().items as Array<Record<string, unknown>>
    const problem = validateChange(change({ value: plan({ items: [items[0], { ...items[1], id: items[0]!.id }] }) }))
    assert.match(problem, /share the id/)
    assert.match(problem, /silently hit the first/)
  })

  it('catches EVERY derived field persisted on a plugin record', () => {
    // Iterated, not spot-checked: the list is the contract, and a field added to it without a
    // check would be exactly the silent loss this guards against (census A13).
    for (const field of DERIVED_FIELDS) {
      const problem = validateChange(change({
        table: 'plugins',
        key: 'dsh-cost-bubble',
        value: { name: 'dsh-cost-bubble', origin: 'ours', [field]: 'anything' },
      }))
      assert.match(problem, new RegExp('carries "' + field + '"'), 'no failure for ' + field)
      assert.match(problem, /zod strips it on reopen/)
    }
    assert.equal(validateChange(change({ table: 'plugins', key: 'x', value: { name: 'x', origin: 'ours' } })), '')
  })

  it('says nothing about a value that is not a record at all', () => {
    // The register holds records; a global or a malformed value is not this check's subject,
    // and guessing would produce failures nobody can act on.
    assert.equal(validateChange(change({ value: null })), '')
    assert.equal(validateChange(change({ value: 'a string' })), '')
    assert.equal(validateChange({}), '')
  })
})
