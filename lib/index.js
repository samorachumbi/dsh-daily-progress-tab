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
import { Config, hostTimezone, localDateIn } from "./config.js";
import { dailyProgressDomain } from "./domain.js";
import { createPlanner } from "./planner.js";
import { ROUTE_PREFIX, createHandlers } from "./routes.js";
import { registerTools } from "./tools.js";
export { Config };
export const name = 'dsh-daily-progress-tab';
/** storageDomain: durable plans; webServer: the API + the planner page. `tools` is optional (see registerTools). */
export const inject = ['storageDomain', 'webServer'];
export function apply(ctx, config) {
    // The config schema supplies the default; stay defensive so a direct
    // programmatic apply (probe, test harness) cannot trip over a missing field.
    const timezone = typeof config?.timezone === 'string' && config.timezone.length > 0
        ? config.timezone
        : hostTimezone();
    const today = () => localDateIn(timezone);
    // Open resolves against the routed backend; the planner resolves the table
    // lazily, per request.
    const domainPromise = ctx.storageDomain.open(dailyProgressDomain);
    ctx.effect(() => async () => {
        try {
            const domain = await domainPromise;
            await domain.close();
        }
        catch {
            // The facility closes still-open domains on unmount; a failed open has
            // nothing to close. Never let teardown throw.
        }
    }, 'daily-progress-tab.domainClose');
    const planner = createPlanner(domainPromise);
    const handlers = createHandlers(planner, today);
    const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => handlers.handle(req, res),
    });
    ctx.effect(() => () => dispose(), 'daily-progress-tab.routes');
    // Agent tools are an optional contribution.
    registerTools(ctx, { planner, today });
}
