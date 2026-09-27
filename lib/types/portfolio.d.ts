/**
 * The plugin portfolio register. Pure, no IO, unit-tested in
 * tests/portfolio.test.ts — the planner, the tools and the page all consume it,
 * so the count and the publish gate cannot differ between them.
 *
 * WHY A REGISTER AND A GATE, NOT A PUBLISH BUTTON. The obvious feature is "a
 * button that publishes this plugin to my GitHub". That shape is wrong, and the
 * reasons are encoded here rather than left to discipline:
 *
 *   - The list of INSTALLED plugins contains other people's work. A button on
 *     that list is one click from publishing someone else's repository under
 *     this operator's name. `origin` makes that impossible instead of merely
 *     inadvisable: a third-party plugin has no publishable state at all.
 *   - A push cannot be undone, and this machine holds material that must never
 *     be public. So the gate reads STORED FACTS WITH DATES — `leakScanPassed`
 *     is only true because a scan ran on a recorded day, and that day is shown
 *     and expires. A gate that trusts a checkbox is not a gate.
 *   - `visibility` is deliberately separate from `origin`: a plugin of ours that
 *     reads private material is `internal` for good, and it defaults to
 *     `internal` so that nothing is publishable by accident — only by an
 *     explicit act.
 *
 * WHY THE GATE IS A CHECKLIST AND NOT A LIST OF ERRORS. A gate that shows
 * nothing when it is green is indistinguishable from one that never ran, and
 * "it said ready" is not a record of what was checked. So `gateChecks` reports
 * EVERY item, passed or failed, with the passed ones named — and `publishBlockers`
 * is DERIVED from it, so the short list and the long one cannot disagree.
 *
 * The register answers the question actually asked — "how many plugins have I
 * created?" — as a DERIVED count over records, so it can never be a number
 * somebody typed.
 * @module dsh-daily-progress-tab/portfolio
 */
import type { GateCheck, PluginRecord, Portfolio, PortfolioCounts } from './types.ts';
/** Who wrote it. `fork` is ours-with-an-upstream: publishable, with attribution. */
export declare const PLUGIN_ORIGINS: readonly ["ours", "fork", "third-party"];
/**
 * Whether this plugin may ever be published. Defaults to `internal` — the
 * fail-safe direction: publishing is an explicit act, never an oversight.
 */
export declare const PLUGIN_VISIBILITIES: readonly ["showcase", "internal"];
export declare const PLUGIN_STATUSES: readonly ["local", "public"];
/** Longest upstream reference or URL kept on a record. */
export declare const MAX_PLUGIN_REF = 300;
/**
 * Facts about a plugin expire. A leak scan that passed last year says nothing
 * about the tree today, so an old verification is itself a blocker — the same
 * discipline as STALE_CHECKIN_DAYS: a measurement you did not take is not a
 * measurement.
 */
export declare const VERIFY_STALE_DAYS = 30;
/**
 * The deployment's own values for the command block, both supplied by config.
 *
 * These were CONSTANTS holding the author's GitHub account and the path to the
 * author's private scanner, which shipped a command a reader cannot run, aimed
 * at an account that is not theirs. A lexical leak scan cannot see that: an
 * account is a handle and a scanner is a path, so the scan reported CLEAN while
 * the rendered page handed over both. They are config now, with an empty
 * default, and empty means UNSET.
 *
 * Both fields degrade to LESS, never to something else: an unset owner withholds
 * the whole block, an unset scanner replaces one line with an instruction.
 */
export interface PublishSettings {
    owner: string;
    scan: string;
}
/** Nothing configured. The safe default for every caller that has no config. */
export declare const NO_PUBLISH_SETTINGS: PublishSettings;
/** True when this plugin may ever be published, regardless of readiness. */
export declare function isPublishable(plugin: PluginRecord): boolean;
/**
 * Every item of the publish gate, in the order they should be read: the two
 * refusals first, then the missing facts, then recency.
 *
 * The order is not cosmetic. The page renders these top-down as "what next", so
 * a fact that can never be satisfied must not be sitting above one that is a
 * single command away.
 */
export declare function gateChecks(plugin: PluginRecord, today?: string): GateCheck[];
/**
 * Every reason this plugin is not ready to publish, in the order they should be
 * fixed. Empty means ready. A plugin that is already public has nothing to
 * block, so it returns empty rather than re-litigating a finished decision.
 *
 * Derived from `gateChecks`, never computed alongside it.
 */
export declare function publishBlockers(plugin: PluginRecord, today?: string): string[];
/** Whole days since the recorded facts were verified, or null when never/no date. */
export declare function verificationAgeDays(plugin: PluginRecord, today: string): number | null;
/**
 * The exact shell the operator pastes to publish this plugin: the toil removed,
 * the irreversible step still theirs.
 *
 * The EMPTY STRING means no affordance at all, and that is a guarantee in code
 * rather than a button hidden at render time. A third-party plugin, anything
 * marked internal, anything already public, anything whose path cannot be pasted
 * safely, and anything with a single gate item still outstanding all return '' —
 * so neither the page nor the model has anything to offer.
 *
 * The equivalence is asserted in BOTH directions by the tests. Offering the
 * commands under a blocked row would let the gate be pasted past, and for a
 * failed leak scan that means publishing something that must never be public.
 *
 * The text is COPIED AND PASTED, so a metacharacter inside it is an instruction
 * to a shell. Every interpolated value — the source path, the package name, the
 * configured owner and the configured scanner — is matched against a bare-word
 * pattern first, and a value that fails yields NO commands rather than a
 * different one.
 *
 * The owner and the scanner have no default in code: they come from the
 * deployment's config, and an unconfigured deployment gets no commands rather
 * than somebody else's account. See `PublishSettings`.
 */
export declare function publishCommands(plugin: PluginRecord, today?: string, settings?: PublishSettings): string;
/**
 * Why a GREEN row is offered no commands — the state that would otherwise be
 * SILENT, and the whole reason this function exists.
 *
 * The register's own rule is that a blank panel must always have a reason:
 * `address` is a gate item for exactly that purpose. A deployment with no publish
 * owner configured is the one case the gate does not cover, because an account is
 * a property of the deployment rather than of the plugin — so the reason is
 * derived here instead of turning every publishable row red for someone who never
 * publishes anything.
 *
 * Empty whenever there is nothing to explain: the commands are present, or the
 * row already has a refusal or a failed gate item saying it.
 */
export declare function withheldNote(plugin: PluginRecord, today?: string, settings?: PublishSettings): string;
export declare function portfolioCounts(plugins: readonly PluginRecord[]): PortfolioCounts;
/**
 * The register as the page and the tools render it. Ordered by what to do next:
 * unpublished first, then fewest blockers, then name — so the row that needs one
 * more step sorts above the row that needs five.
 */
export declare function portfolioView(plugins: readonly PluginRecord[], today?: string, settings?: PublishSettings): Portfolio;
