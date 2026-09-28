/**
 * The public-resume export: the register, rendered for people who are not the operator.
 *
 * WHY THIS EXISTS. The portfolio register is a private console: it carries the gate, the
 * blockers, the verification dates and the exact shell to publish. None of that belongs
 * in front of a client — and none of the numbers in a public résumé should be TYPED,
 * because a typed count drifts the first time a plugin is added. So the public section
 * is DERIVED from the same records the gate reads, and it is spliced into a hand-written
 * document rather than replacing it: the prose is the operator's voice, the facts are
 * generated facts, and the boundary between them is a pair of markers.
 *
 * WHAT IT REFUSES, and why each refusal is a rule rather than a preference:
 *
 *   - **Nothing unpublished appears.** A résumé that links to a repository that does not
 *     exist yet is worse than a shorter résumé: the link 404s, and the reader learns the
 *     author advertises vapour. So an entry is exported only when it is `public` AND
 *     carries a URL — which also means the published COUNT always equals the list.
 *   - **`internal` and `third-party` never appear**, at all. That is the gate's own
 *     refusal: someone else's work is not ours to advertise, and work marked internal is
 *     internal.
 *   - **No gate internals.** No commands, no pre-flight notes, no scan dates: they are
 *     the console's language, and one of them (`~/projects/plugins/publish-scan.sh`)
 *     is a private path.
 *   - **No silent append.** `spliceExport` refuses a document whose markers are missing
 *     or out of order, because appending a generated block to a hand-written file turns a
 *     readme into a mess the first time the marker is renamed.
 *
 * Pure: no IO, no clock, no context. The caller supplies the entries and the document
 * text, which is what makes the refusals above testable rather than hoped for.
 * @module dsh-daily-progress-tab/export
 */
import type { PortfolioEntry } from './types.ts';
/** The pair of markers the generated block lives between. */
export declare const EXPORT_BEGIN = "<!-- dsh-portfolio:begin \u2014 generated, do not edit by hand -->";
export declare const EXPORT_END = "<!-- dsh-portfolio:end -->";
/** True when this record may appear in public, on the evidence the register holds. */
export declare function isExportable(entry: PortfolioEntry): boolean;
/** The public-facing count, derived from the same predicate that decides the list. */
export declare function exportCounts(entries: readonly PortfolioEntry[]): {
    published: number;
    ready: number;
    open: number;
};
/**
 * An upstream reference as a link, when it looks like `owner/repo@commit`.
 *
 * Free text is passed through unlinked rather than guessed at: a link built from a string
 * that is not a repository is a 404 with extra steps.
 */
export declare function upstreamLink(upstream: string): string;
/** One plugin, as a résumé line. */
export declare function renderEntry(entry: PortfolioEntry): string;
/**
 * The generated block, markers included.
 *
 * Published first and then by name, so the same register always produces the same
 * document — a résumé that reshuffles itself between runs is a diff nobody can review.
 */
export declare function renderExportBlock(entries: readonly PortfolioEntry[]): string;
/**
 * Put `block` between the markers of `document`.
 *
 * Returns `null` — never a best guess — when the markers are missing, duplicated or
 * reversed. The caller reports that; the alternative is a generated block appended to the
 * end of a hand-written readme, which is how a document starts lying about itself.
 */
export declare function spliceExport(document: string, block: string): string | null;
/**
 * The same records as a standalone page — the destination the résumé links to, and what a
 * GitHub Pages site would serve. One source, two outputs.
 */
export declare function renderSiteIndex(entries: readonly PortfolioEntry[]): string;
