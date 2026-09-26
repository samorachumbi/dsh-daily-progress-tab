/**
 * Agent-facing tools. These are why the planner can be driven by asking rather
 * than by typing: the model reads the plan, schedules tasks, completes them and
 * attaches suggestion chips, all through the same planner the HTTP routes use.
 *
 * Registered inside `ctx.inject(['tools'], …)` rather than listed in the
 * plugin's required `inject`: the tool registry is an OPTIONAL contribution, so
 * a profile composed without `tools` still boots this plugin instead of failing
 * the activation audit. This mirrors the harness's own `dsh-tool-todo`.
 *
 * Tasks are addressable by `itemId` OR by a unique case-insensitive substring of
 * their text, because a model usually knows what a task says, not its UUID.
 * @module dsh-daily-progress-tab/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Planner } from './planner.ts';
export interface ToolDeps {
    planner: Planner;
    /** Resolves "today" for agent calls, which carry no browser date. */
    today: () => string;
}
/** The tool definitions, unregistered — exported so tests can enumerate them. */
export declare function buildTools(deps: ToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition[];
/**
 * Register the tools on `ctx.tools`, optional-dependency style: a profile with
 * no tool registry simply gets no tools instead of a failed boot.
 */
export declare function registerTools(ctx: Context, deps: ToolDeps): void;
