/**
 * Package-owned invariant companion for `dsh-daily-progress-tab`.
 *
 * WHY THIS EXISTS. Every package in this harness ships a `./invariant` companion that
 * registers its runtime contracts with `@deepseek-ai/dsh-invariants`. The checks load only
 * where a profile enables that service, so a companion costs nothing where it is not wanted
 * and turns a silent divergence into a failure that names the package it came from.
 *
 * WHAT THIS PACKAGE OWNS is the STORED-RECORD CONTRACT of its own domain — the one
 * relationship here that can drift with nothing to notice:
 *
 *   1. A DAY RECORD'S DATE IS ITS KEY. `recordKey(scope, date)` composes the key and the
 *      record carries the same date. Change one without the other and reads start serving
 *      the wrong day: no exception, no log, the page simply shows yesterday's plan.
 *   2. ITEM IDS ARE UNIQUE AND NON-EMPTY WITHIN A DAY. Every id-addressed operation
 *      (toggle, move, edit, select) finds the FIRST match, so a duplicate id silently
 *      routes the second item's edits onto the first.
 *   3. DERIVED FIELDS ARE NEVER PERSISTED. `checks`, `commands`, `commandsNote`,
 *      `blockers`, `verifiedDaysAgo` and `publishable` are computed on every read, and zod
 *      strips unknown keys on read (census A13) — so a record written with them loses them
 *      silently: the write's own reply looks perfect and the field is gone on reopen.
 *
 * The check is a pure function ({@link validateChange}) with the event wiring around it, so
 * both directions are testable without a harness: every violation, and — more important for
 * a check that THROWS — that the records this plugin actually writes pass.
 * @module dsh-daily-progress-tab/invariant
 */
/** The npm package name the checks are attributed to in a failure. */
export const PACKAGE_NAME = 'dsh-daily-progress-tab';
/** The domain this package owns, spelled as its schema declares it. */
export const DOMAIN = 'daily_progress_tab';
/** The stored day-plan table. */
const DAY_TABLE = 'plans';
/** The plugin register table. */
const PLUGIN_TABLE = 'plugins';
/** Fields derived on every read — persisting one is silent data loss (census A13). */
export const DERIVED_FIELDS = [
    'checks', 'commands', 'commandsNote', 'blockers', 'verifiedDaysAgo', 'publishable',
];
/** Cordis companion plugin name. */
export const name = 'daily-progress-tab-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/** The date part of a `scope:date` record key. */
export function dateFromKey(key) {
    const at = key.indexOf(':');
    return at === -1 ? key : key.slice(at + 1);
}
/**
 * One stored change against this package's contract.
 *
 * @returns the violated contract as a message, or `''` when the change is in contract.
 *   Returning a message rather than throwing is what lets the tests enumerate violations
 *   without a harness, and keeps the throw in exactly one place.
 */
export function validateChange(change) {
    if (change.domain !== DOMAIN)
        return '';
    // A deletion has no value to validate; the record's absence is the point.
    if (String(change.operation ?? '') === 'deleted')
        return '';
    const value = change.value;
    if (value === null || typeof value !== 'object')
        return '';
    const record = value;
    const key = String(change.key ?? '');
    if (change.table === DAY_TABLE) {
        const date = dateFromKey(key);
        if (record.date !== date) {
            return 'a stored day plan\'s date (' + JSON.stringify(record.date)
                + ') must equal the date in its key (' + JSON.stringify(date) + ')';
        }
        const items = Array.isArray(record.items) ? record.items : [];
        const seen = new Set();
        for (const item of items) {
            const id = item !== null && typeof item === 'object'
                ? item.id
                : undefined;
            if (typeof id !== 'string' || id.length === 0) {
                return 'every item in a stored day plan needs a non-empty id, found '
                    + JSON.stringify(id) + ' in ' + JSON.stringify(key);
            }
            if (seen.has(id)) {
                return 'two items in ' + JSON.stringify(key) + ' share the id ' + JSON.stringify(id)
                    + ': every id-addressed operation would silently hit the first';
            }
            seen.add(id);
        }
        return '';
    }
    if (change.table === PLUGIN_TABLE) {
        for (const field of DERIVED_FIELDS) {
            if (field in record) {
                return 'a stored plugin record carries ' + JSON.stringify(field)
                    + ', which is derived on every read: zod strips it on reopen, so the write looks'
                    + ' right and the field is gone (census A13)';
            }
        }
    }
    return '';
}
/** Install the stored-record checks. Needs no services: the event carries everything. */
export const install = (ctx, fail) => {
    ctx.on('domain/changed', (change) => {
        const problem = validateChange(change);
        if (problem !== '')
            fail(problem);
    });
};
/**
 * Register the companion with the invariants service.
 *
 * The registration is package-attributed, so a failure reads as this package's contract
 * rather than as an anonymous runtime error.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
