/**
 * Calendar-key helpers with NO runtime dependencies: safe to import from
 * unit tests and browser-adjacent code alike. All date keys are the user's
 * LOCAL calendar dates (YYYY-MM-DD strings) — opaque labels, never UTC
 * instants.
 * @module dsh-daily-progress/calendar
 */
export declare const DATE_RE: RegExp;
/** The V1 isolation scope: per-user key prefix, `default` for single-user deployments. */
export declare const DEFAULT_SCOPE = "default";
/** Table record key for one (scope, date) plan. */
export declare const recordKey: (scope: string, date: string) => string;
/** Reject anything that is not YYYY-MM-DD of a real calendar day. */
export declare function isValidDateKey(value: string): boolean;
