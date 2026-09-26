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
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
import type { PluginConfig } from './config.ts';
export { Config };
export declare const name = "dsh-daily-progress-tab";
/** storageDomain: durable plans; webServer: the API + the planner page. `tools` is optional (see registerTools). */
export declare const inject: string[];
export declare function apply(ctx: Context, config: PluginConfig): void;
