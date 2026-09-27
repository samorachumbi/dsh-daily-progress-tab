/**
 * Plugin config. Deployment-varying values belong here rather than in code, so
 * a profile's `cordis.yml` can retune them without a rebuild — and so the
 * runtime schema exists alongside the TypeScript interface, per the harness
 * plugin checklist.
 *
 * `timezone` exists because of an asymmetry upstream documented but did not
 * solve: browser requests carry the user's own zone and local date, while
 * AGENT-initiated calls (the `daily_*` tools) carry neither. Those resolve
 * "today" from this zone, which defaults to the host's zone at load.
 *
 * `publishOwner` and `leakScan` exist for the opposite reason: they are values
 * the AUTHOR of a deployment supplies, so shipping a value in code hands a reader
 * a command aimed at somebody else's account. Both default to EMPTY, and empty
 * means unset — see `PublishSettings` in portfolio.ts.
 * @module dsh-daily-progress-tab/config
 */
import z from '@deepseek-ai/schemastery';
/** The host process's own IANA zone, used as the default. */
export function hostTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    }
    catch {
        return 'UTC';
    }
}
export const Config = z.object({
    timezone: z.string().default(hostTimezone()),
    // Both default to '' — see the interface. The empty default is what keeps the
    // public code free of an account and a path of its own.
    publishOwner: z.string().default(''),
    leakScan: z.string().default(''),
});
/**
 * A config string, trimmed; '' for anything absent, empty or not a string.
 *
 * So a caller can treat "no value" and "not configured" as one case — which is
 * exactly what both publish fields need, and it lets a value with stray
 * whitespace work instead of being refused by the shell-safety guards.
 */
export function settingText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/** The local YYYY-MM-DD date in `timezone` at `at`. Falls back to UTC on a bad zone. */
export function localDateIn(timezone, at = new Date()) {
    const format = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    try {
        return format(timezone);
    }
    catch {
        return format('UTC');
    }
}
