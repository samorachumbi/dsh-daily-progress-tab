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
import type { Context } from '@deepseek-ai/cordis';
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants';
/** The npm package name the checks are attributed to in a failure. */
export declare const PACKAGE_NAME = "dsh-daily-progress-tab";
/** The domain this package owns, spelled as its schema declares it. */
export declare const DOMAIN = "daily_progress_tab";
/** Fields derived on every read — persisting one is silent data loss (census A13). */
export declare const DERIVED_FIELDS: readonly ["checks", "commands", "commandsNote", "blockers", "verifiedDaysAgo", "publishable"];
/** The shape this module needs from a `domain/changed` payload, structurally. */
export interface ChangeLike {
    domain?: unknown;
    table?: unknown;
    key?: unknown;
    operation?: unknown;
    value?: unknown;
}
/** Cordis companion plugin name. */
export declare const name = "daily-progress-tab-invariant";
/** Service required before the companion can reserve package ownership. */
export declare const inject: string[];
/** The date part of a `scope:date` record key. */
export declare function dateFromKey(key: string): string;
/**
 * One stored change against this package's contract.
 *
 * @returns the violated contract as a message, or `''` when the change is in contract.
 *   Returning a message rather than throwing is what lets the tests enumerate violations
 *   without a harness, and keeps the throw in exactly one place.
 */
export declare function validateChange(change: ChangeLike): string;
/** Install the stored-record checks. Needs no services: the event carries everything. */
export declare const install: InvariantInstaller;
/**
 * Register the companion with the invariants service.
 *
 * The registration is package-attributed, so a failure reads as this package's contract
 * rather than as an anonymous runtime error.
 */
export declare const apply: (ctx: Context) => Promise<unknown>;
