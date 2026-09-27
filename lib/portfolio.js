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
/**
 * The GitHub account every plugin repository is published under. A constant
 * rather than a field on each record, because this value is composed into a
 * command the operator pastes into a shell: a URL assembled in three places is
 * a URL that eventually disagrees with itself.
 */
export const PUBLISH_OWNER = 'samorachumbi';
/** Where the leak scanner lives. Absolute, because the command runs from inside a repository. */
export const PUBLISH_SCAN = '~/projects/plugins/publish-scan.sh';
const DAY_MS = 86400000;
/**
 * A string safe to paste into a shell as a bare word: no quotes, no spaces, no
 * substitution, no backtick, no newline. Anything else yields NO commands
 * rather than a command that does something else — see `publishCommands`.
 */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./~-]+$/;
/** A package name doubles as a repository name, and can be matched more tightly. */
const SAFE_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}
/** True when this plugin may ever be published, regardless of readiness. */
export function isPublishable(plugin) {
    return (plugin.origin === 'ours' || plugin.origin === 'fork') && plugin.visibility === 'showcase';
}
/** One dated fact as a gate item: the detail is dropped when the fact holds. */
function fact(key, name, ok, detail) {
    return { key, name, ok, detail: ok ? '' : detail, fatal: false };
}
/** The source path, but only when it is safe to paste as a bare shell word. */
function pastablePath(plugin) {
    const path = (plugin.sourcePath ?? '').trim();
    return SAFE_WORD.test(path) ? path : '';
}
/**
 * Whether a publish command can be handed over at all: a pasteable source path
 * and a package name that is also a repository name.
 *
 * This is a GATE ITEM and not an implementation detail of `publishCommands`.
 * Without it a record whose path cannot be pasted would render READY TO PUBLISH
 * with no commands and no explanation — the panel contradicting itself in the
 * one place it has to be trustworthy. The two are kept in step by deriving both
 * from this function and `SAFE_REPO_NAME`, never by remembering to.
 */
function addressOk(plugin) {
    return pastablePath(plugin) !== '' && SAFE_REPO_NAME.test(plugin.name.trim());
}
/**
 * Every item of the publish gate, in the order they should be read: the two
 * refusals first, then the missing facts, then recency.
 *
 * The order is not cosmetic. The page renders these top-down as "what next", so
 * a fact that can never be satisfied must not be sitting above one that is a
 * single command away.
 */
export function gateChecks(plugin, today = '') {
    const thirdParty = plugin.origin === 'third-party';
    const internal = plugin.visibility === 'internal';
    const checks = [
        {
            key: 'origin',
            name: 'origin — ' + plugin.origin,
            ok: !thirdParty,
            detail: thirdParty ? 'not ours — a third-party plugin is never publishable' : '',
            fatal: thirdParty,
        },
        {
            key: 'visibility',
            name: 'visibility — ' + plugin.visibility,
            ok: !internal,
            detail: internal ? 'marked internal — never publishable' : '',
            fatal: internal,
        },
    ];
    // Not publishable at all: report the refusal and stop. A to-do list for
    // something that must not happen is an invitation to start it.
    if (thirdParty || internal)
        return checks;
    checks.push(fact('leak-scan', 'leak scan', plugin.leakScanPassed === true, 'the leak scan has not passed for the current tree'));
    // Deliberately NOT the same fact as the leak scan above: that one says the
    // tree is safe to publish, this one says it still WORKS.
    checks.push(fact('preflight', 'pre-flight', plugin.preflightPassed === true, 'the pre-flight has not passed for this tree — run it and record the result'));
    checks.push(fact('source', 'source location', plugin.sourceOutsideProfile === true, 
    // The cost-bubble lesson: it lived only inside a profile node_modules that
    // this machine documents as crash-prone, so the portfolio's centrepiece had
    // a single point of failure.
    'source lives only inside a profile — recover it into a source directory first'));
    // Where the source IS, versus whether it can be handed over: a path with a
    // space in it is a real source location and still not a pasteable command.
    checks.push(fact('address', 'address — source path and package name', addressOk(plugin), 'the source path or the package name cannot be pasted into a shell — no command can be handed over until one can'));
    checks.push(fact('licence', 'LICENSE', plugin.hasLicenseFile === true, 'no LICENSE file'));
    checks.push(fact('upstream', plugin.origin === 'fork' ? 'upstream attribution' : 'upstream attribution — not a fork', plugin.origin !== 'fork' || (plugin.upstream !== undefined && plugin.upstream.length > 0), 'a fork must record its upstream repository and commit'));
    checks.push(fact('readme', 'README', plugin.hasReadme === true, 'no README'));
    checks.push(fact('screenshot', 'screenshot', plugin.hasScreenshot === true, 'no screenshot'));
    checks.push(fact('git', 'git repository', plugin.gitReady === true, 'no git repository with a clean tree'));
    const age = verificationAgeDays(plugin, today);
    checks.push(fact('recency', age === null ? 'facts current — never verified' : 'facts current — ' + age + 'd old', age === null || age <= VERIFY_STALE_DAYS, 'these facts were verified ' + age + ' days ago — re-verify before trusting them'));
    return checks;
}
/**
 * Every reason this plugin is not ready to publish, in the order they should be
 * fixed. Empty means ready. A plugin that is already public has nothing to
 * block, so it returns empty rather than re-litigating a finished decision.
 *
 * Derived from `gateChecks`, never computed alongside it.
 */
export function publishBlockers(plugin, today = '') {
    const failed = gateChecks(plugin, today).filter((check) => !check.ok);
    // A refusal is the whole answer: there is no work to do on it, and the other
    // items would read as a to-do list for something that must not happen.
    const fatal = failed.filter((check) => check.fatal);
    if (fatal.length > 0)
        return fatal.map((check) => check.detail);
    if (plugin.status === 'public')
        return [];
    return failed.map((check) => check.detail);
}
/** Whole days since the recorded facts were verified, or null when never/no date. */
export function verificationAgeDays(plugin, today) {
    if (today === '' || plugin.verifiedAt === undefined || plugin.verifiedAt === '')
        return null;
    return Math.max(0, daysBetween(plugin.verifiedAt.slice(0, 10), today));
}
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
 * failed leak scan that means publishing the vault.
 *
 * The text is COPIED AND PASTED, so a metacharacter inside it is an instruction
 * to a shell. Every interpolated value is matched against a bare-word pattern
 * first, and a value that fails yields NO commands rather than a different one.
 */
export function publishCommands(plugin, today = '', owner = PUBLISH_OWNER) {
    if (!isPublishable(plugin) || plugin.status === 'public')
        return '';
    // GREEN GATE FIRST, and the order is the safety property. A blocked plugin is
    // refused for the reason that matters, before any formatting detail about the
    // address is even considered.
    if (publishBlockers(plugin, today).length > 0)
        return '';
    // The same predicate the gate reports on, so a blank panel and a silently
    // empty string cannot part company.
    if (!addressOk(plugin) || !SAFE_REPO_NAME.test(owner))
        return '';
    const path = pastablePath(plugin);
    const name = plugin.name.trim();
    return [
        '# Publish ' + name + ' as ' + owner + '/' + name,
        '# 1. Create the repository on GitHub FIRST and leave it EMPTY:',
        '#    name ' + name + ', no README, no licence, no .gitignore.',
        'cd ' + path,
        'bash ' + PUBLISH_SCAN + ' .        # must print SCAN CLEAN',
        'git status --porcelain     # must print NOTHING',
        'git log --oneline -1       # must be the commit you mean to publish',
        'git remote -v              # must NOT already list origin',
        'git remote add origin https://github.com/' + owner + '/' + name + '.git',
        'git push -u origin main',
        '',
        '# 2. Run this repository own build and tests BEFORE step 3, and record the',
        '#    result in the register as preflightNote — the gate shows that note, so',
        '#    "the pre-flight passed" can always be read back and judged.',
        '# 3. Then set the description and topics in the GitHub UI, and read the',
        '#    rendered README once before anyone else does.',
    ].join('\n');
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
        // Derived here, once, so the page and the model cannot be shown different
        // checklists for the same record.
        checks: gateChecks(plugin, today),
        commands: publishCommands(plugin, today),
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
