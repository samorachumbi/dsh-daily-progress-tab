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
 * @module dsh-daily-progress-tab/config
 */

import z from '@deepseek-ai/schemastery'

/** The host process's own IANA zone, used as the default. */
export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export interface PluginConfig {
  /** IANA zone used to resolve "today" for agent-initiated calls. */
  timezone: string
}

export const Config: z<PluginConfig> = z.object({
  timezone: z.string().default(hostTimezone()),
})

/** The local YYYY-MM-DD date in `timezone` at `at`. Falls back to UTC on a bad zone. */
export function localDateIn(timezone: string, at: Date = new Date()): string {
  const format = (zone: string): string =>
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  try {
    return format(timezone)
  } catch {
    return format('UTC')
  }
}
