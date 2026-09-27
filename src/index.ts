/**
 * dsh-daily-progress-tab host half (cordis plugin body).
 *
 * Owns the daily-plan domain, the HTTP surface for the standalone planner page,
 * and the `daily_*` agent tools. Everything is host-plane.
 *
 * There is no client half on purpose. The planner is a separate browser tab at
 * `<origin>/daily-progress-tab/ui`, which keeps the harness UI uncrowded and —
 * because no `dsh.client` manifest exists — keeps `dsh-client-modules` from
 * trying to compose a bundle that would have to be built and shipped. Upstream
 * declared exactly such a bundle without building it, which aborted the boot.
 *
 * Export shape: function/namespace plugin (name/inject/Config/apply, NO default —
 * a stray `export default` would collapse the module via the Loader's
 * unwrapExports and drop `inject`).
 * @module dsh-daily-progress-tab
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only side-effect imports: these packages augment `Context` via
// `declare module '@deepseek-ai/cordis'`. Without loading their declarations the
// augmentation is invisible and `ctx.webServer` / `ctx.tools` are type errors —
// which is exactly how upstream shipped a service name that does not exist.
// Both are erased at runtime.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Config, hostTimezone, localDateIn, settingText } from './config.ts'
import type { PluginConfig } from './config.ts'
import { dailyProgressDomain } from './domain.ts'
import type { DailyProgressDomainSpec } from './domain.ts'
import { createPlanner } from './planner.ts'
import { ROUTE_PREFIX, createHandlers } from './routes.ts'
import { registerTools } from './tools.ts'

export { Config }

export const name = 'dsh-daily-progress-tab'

/** storageDomain: durable plans; webServer: the API + the planner page. `tools` is optional (see registerTools). */
export const inject = ['storageDomain', 'webServer']

export function apply(ctx: Context, config: PluginConfig): void {
  // The config schema supplies the default; stay defensive so a direct
  // programmatic apply (probe, test harness) cannot trip over a missing field.
  const timezone = typeof config?.timezone === 'string' && config.timezone.length > 0
    ? config.timezone
    : hostTimezone()
  const today = (): string => localDateIn(timezone)

  // The two publish values, read the same defensive way as `timezone`. Empty
  // means UNSET: an unconfigured deployment withholds the publish commands
  // rather than naming an account — this plugin ships no owner and no scanner
  // path of its own.
  const publish = {
    owner: settingText(config?.publishOwner),
    scan: settingText(config?.leakScan),
  }

  // Open resolves against the routed backend; the planner resolves the table
  // lazily, per request.
  const domainPromise: Promise<Domain<DailyProgressDomainSpec>> = ctx.storageDomain.open(dailyProgressDomain)

  ctx.effect(() => async () => {
    try {
      const domain = await domainPromise
      await domain.close()
    } catch {
      // The facility closes still-open domains on unmount; a failed open has
      // nothing to close. Never let teardown throw.
    }
  }, 'daily-progress-tab.domainClose')

  const planner = createPlanner(domainPromise, publish)

  const handlers = createHandlers(planner, today)
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => handlers.handle(req, res),
  })
  ctx.effect(() => () => dispose(), 'daily-progress-tab.routes')

  // Agent tools are an optional contribution.
  registerTools(ctx, { planner, today })
}
