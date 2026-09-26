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
 *     reads the loan plan or the vault is `internal` for good, and it defaults
 *     to `internal` so that nothing is publishable by accident — only by an
 *     explicit act.
 *
 * The register answers the question actually asked — "how many plugins have I
 * created?" — as a DERIVED count over records, so it can never be a number
 * somebody typed.
 * @module dsh-daily-progress-tab/portfolio
 */
/** Who wrote it. `fork` is ours-with-an-upstream: publishable, with attribution. */
export const PLUGIN_ORIGINS = ['ours', 'fork', 'third-party'];
/**
 * Whether this plugin may ever be published. Defaults to `internal` — the
 * fail-safe direction: publishing is an explicit act, never an oversight.
 */
export const PLUGIN_VISIBILITIES = ['showcase', 'internal'];
export const PLUGIN_STATUSES = ['local', 'public'];
/** Longest upstream reference or URL kept on a record. */
export const MAX_PLUGIN_REF = 300;
/**
 * Facts about a plugin expire. A leak scan that passed last year says nothing
 * about the tree today, so an old verification is itself a blocker — the same
 * discipline as STALE_CHECKIN_DAYS: a measurement you did not take is not a
 * measurement.
 */
export const VERIFY_STALE_DAYS = 30;
const DAY_MS = 86400000;
function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}
/** True when this plugin may ever be published, regardless of readiness. */
export function isPublishable(plugin) {
    return (plugin.origin === 'ours' || plugin.origin === 'fork') && plugin.visibility === 'showcase';
}
/**
 * Every reason this plugin is not ready to publish, in the order they should be
 * fixed. Empty means ready. A plugin that is already public has nothing to
 * block, so it returns empty rather than re-litigating a finished decision.
 */
export function publishBlockers(plugin, today = '') {
    const blockers = [];
    if (plugin.origin === 'third-party')
        blockers.push('not ours — a third-party plugin is never publishable');
    if (plugin.visibility === 'internal')
        blockers.push('marked internal — never publishable');
    // Not publishable at all: report only why, never a to-do list for something
    // that must not happen.
    if (!isPublishable(plugin))
        return blockers;
    if (plugin.status === 'public')
        return blockers;
    if (plugin.leakScanPassed !== true)
        blockers.push('the leak scan has not passed for the current tree');
    if (!plugin.sourceOutsideProfile) {
        // The cost-bubble lesson: it lived only inside a profile node_modules that
        // this machine documents as crash-prone, so the portfolio's centrepiece had
        // a single point of failure.
        blockers.push('source lives only inside a profile — recover it into a source directory first');
    }
    if (!plugin.hasLicenseFile)
        blockers.push('no LICENSE file');
    if (plugin.origin === 'fork' && (plugin.upstream === undefined || plugin.upstream.length === 0)) {
        blockers.push('a fork must record its upstream repository and commit');
    }
    if (!plugin.hasReadme)
        blockers.push('no README');
    if (!plugin.hasScreenshot)
        blockers.push('no screenshot');
    if (!plugin.gitReady)
        blockers.push('no git repository with a clean tree');
    const age = verificationAgeDays(plugin, today);
    if (age !== null && age > VERIFY_STALE_DAYS) {
        blockers.push('these facts were verified ' + age + ' days ago — re-verify before trusting them');
    }
    return blockers;
}
/** Whole days since the recorded facts were verified, or null when never/no date. */
export function verificationAgeDays(plugin, today) {
    if (today === '' || plugin.verifiedAt === undefined || plugin.verifiedAt === '')
        return null;
    return Math.max(0, daysBetween(plugin.verifiedAt.slice(0, 10), today));
}
export function portfolioCounts(plugins) {
    let ours = 0;
    let fork = 0;
    let thirdParty = 0;
    let internal = 0;
    let published = 0;
    let ready = 0;
    let installed = 0;
    for (const plugin of plugins) {
        if (plugin.origin === 'ours')
            ours += 1;
        else if (plugin.origin === 'fork')
            fork += 1;
        else
            thirdParty += 1;
        if (plugin.visibility === 'internal')
            internal += 1;
        if (plugin.status === 'public')
            published += 1;
        if (plugin.installed === true)
            installed += 1;
        if (isPublishable(plugin) && plugin.status !== 'public' && publishBlockers(plugin).length === 0)
            ready += 1;
    }
    return {
        total: plugins.length,
        ours,
        fork,
        thirdParty,
        // "How many plugins have I created?" — the forks are ours too, with
        // attribution. Third-party work is never counted as ours.
        authored: ours + fork,
        internal,
        published,
        ready,
        installed,
    };
}
/**
 * The register as the page and the tools render it. Ordered by what to do next:
 * unpublished first, then fewest blockers, then name — so the row that needs one
 * more step sorts above the row that needs five.
 */
export function portfolioView(plugins, today = '') {
    const entries = plugins.map((plugin) => ({
        ...plugin,
        publishable: isPublishable(plugin),
        blockers: publishBlockers(plugin, today),
        verifiedDaysAgo: verificationAgeDays(plugin, today),
    }));
    entries.sort((a, b) => {
        if ((a.status === 'public') !== (b.status === 'public'))
            return a.status === 'public' ? 1 : -1;
        // A plugin that can never be published is NOT work, so it sorts below one
        // that merely needs a step. The list is read top-down as "what next", and a
        // third-party row sitting above a fixable one would be an invitation to
        // start something that must not happen.
        if (a.publishable !== b.publishable)
            return a.publishable ? -1 : 1;
        const blocking = a.blockers.length - b.blockers.length;
        if (blocking !== 0)
            return blocking;
        return a.name.localeCompare(b.name);
    });
    return { entries, counts: portfolioCounts(plugins) };
}
