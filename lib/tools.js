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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { EXPORT_BEGIN, EXPORT_END, exportCounts, renderExportBlock, spliceExport } from "./export.js";
const suggestionOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        label: { type: 'string', required: true },
        action: { type: 'string', required: true },
    },
};
const taskOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        text: { type: 'string', required: true },
        done: { type: 'boolean', required: true },
        origin: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        projectId: { type: 'string', required: true },
        suggestions: { type: 'array', required: true, items: suggestionOutputSchema },
    },
};
const poolOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        text: { type: 'string', required: true },
        date: { type: 'string', required: true },
        bucket: { type: 'string', required: true },
        projectId: { type: 'string', required: true },
    },
};
const backlogOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        projectId: { type: 'string', required: true },
        text: { type: 'string', required: true },
        summary: { type: 'string', required: true },
    },
};
const nowOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        text: { type: 'string', required: true },
        date: { type: 'string', required: true },
        projectId: { type: 'string', required: true },
    },
};
const planOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        date: { type: 'string', required: true },
        streak: { type: 'integer', required: true },
        weekPercent: { type: 'integer', required: true },
        /** Null when nothing is picked. */
        now: { required: true, oneOf: [nowOutputSchema, { type: 'null' }] },
        today: { type: 'array', required: true, items: taskOutputSchema },
        tomorrow: { type: 'array', required: true, items: taskOutputSchema },
        pool: { type: 'array', required: true, items: poolOutputSchema },
        backlog: { type: 'array', required: true, items: backlogOutputSchema },
    },
};
function taskView(item) {
    return {
        id: item.id,
        text: item.text,
        done: item.done,
        origin: item.origin,
        summary: item.summary ?? '',
        projectId: item.projectId ?? '',
        suggestions: (item.suggestions ?? []).map((s) => ({ id: s.id, label: s.label, action: s.action })),
    };
}
function planView(date, snapshot) {
    const rows = (plan) => (plan?.items ?? []).map(taskView);
    return {
        date,
        streak: snapshot.streak,
        weekPercent: snapshot.weekRate === null ? -1 : Math.round(snapshot.weekRate * 100),
        now: snapshot.now === null ? null : {
            id: snapshot.now.item.id,
            text: snapshot.now.item.text,
            date: snapshot.now.date,
            projectId: snapshot.now.item.projectId ?? '',
        },
        today: rows(snapshot.today),
        tomorrow: rows(snapshot.tomorrow),
        pool: snapshot.pool.map((entry) => ({
            id: entry.item.id,
            text: entry.item.text,
            date: entry.date,
            bucket: entry.bucket,
            projectId: entry.item.projectId ?? '',
        })),
        backlog: snapshot.backlog.map((entry) => ({
            id: entry.id,
            projectId: entry.projectId,
            text: entry.text,
            summary: entry.summary ?? '',
        })),
    };
}
/** A compact, human-readable rendering, so the model does not have to parse JSON. */
function renderPlan(value) {
    const lines = [];
    lines.push(value.date + ' — streak ' + value.streak + ' day(s), week '
        + (value.weekPercent < 0 ? 'n/a' : value.weekPercent + '%'));
    lines.push('', 'Now: ' + (value.now === null
        ? '(nothing picked)'
        : value.now.text + '  [' + value.now.id + ']'));
    const section = (title, rows) => {
        lines.push('', title + ':');
        if (rows.length === 0) {
            lines.push('  (none)');
            return;
        }
        for (const row of rows) {
            const chips = row.suggestions.length
                ? '  {' + row.suggestions.map((s) => s.label).join(' | ') + '}'
                : '';
            lines.push('  [' + (row.done ? 'x' : ' ') + '] ' + row.text
                + (row.origin === 'carried' ? ' (carried)' : '') + chips);
        }
    };
    section('Today', value.today);
    section('Tomorrow', value.tomorrow);
    lines.push('', 'Pool — undone tasks on other days (pick with daily_now, pull in with daily_move_task):');
    if (value.pool.length === 0)
        lines.push('  (none)');
    for (const row of value.pool) {
        lines.push('  ' + row.date + ' [' + row.bucket + '] ' + row.text + '  [' + row.id + ']');
    }
    lines.push('', 'Backlog — unscheduled candidate tasks (schedule with daily_backlog_plan):');
    if (value.backlog.length === 0)
        lines.push('  (none)');
    for (const row of value.backlog) {
        lines.push('  ' + row.text + '  [' + row.id + ']');
    }
    return lines.join('\n');
}
const projectRowSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        fulfills: { type: 'string', required: true },
        status: { type: 'string', required: true },
        currency: { type: 'string', required: true },
        /** -1 means "not estimated yet". */
        ttfdDays: { type: 'integer', required: true },
        effortDays: { type: 'integer', required: true },
        revenuePerMonth: { type: 'integer', required: true },
        confidence: { type: 'number', required: true },
        /** Expected currency per month per day of effort; -1 when unranked. */
        score: { type: 'integer', required: true },
        weakest: { type: 'string', required: true },
        killSwitch: { type: 'string', required: true },
        summary: { type: 'string', required: true },
    },
};
const projectsOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        selectedProjectId: { type: 'string', required: true },
        selectedProjectName: { type: 'string', required: true },
        projects: { type: 'array', required: true, items: projectRowSchema },
    },
};
function projectRow(project) {
    return {
        id: project.id,
        name: project.name,
        fulfills: project.fulfills,
        status: project.status,
        currency: project.currency,
        ttfdDays: project.ttfdDays ?? -1,
        effortDays: project.effortDays ?? -1,
        revenuePerMonth: project.revenuePerMonth ?? -1,
        confidence: project.confidence,
        score: project.score.score === null ? -1 : Math.round(project.score.score),
        weakest: project.score.weakestDimension,
        killSwitch: project.killSwitch ?? '',
        summary: project.summary ?? '',
    };
}
function liveRow(project) {
    const m = project.monitoring;
    return {
        id: project.id,
        name: project.name,
        verdict: m.verdict ?? 'none',
        currency: project.currency,
        liveSince: m.liveSince ?? '',
        lastCheckin: m.lastCheckin ?? '',
        daysSinceCheckin: m.daysSinceCheckin ?? -1,
        stale: m.stale,
        checkins: m.checkins,
        totalRevenue: m.totalRevenue,
        lastRevenue: m.lastRevenue ?? -1,
        customers: m.customers ?? -1,
        metricName: m.metricName ?? '',
        latestMetric: m.latestMetric ?? -1,
        metricDelta: m.metricDelta ?? -1,
        progress: m.lastProgress ?? '',
        openHurdles: m.openHurdles.map((item) => item.text),
        openCorrections: m.openCorrections.map((item) => item.text),
        doneCorrections: m.doneCorrections,
        killSwitch: project.killSwitch ?? '',
        sparkOpen: project.sparkSummary.open,
        sparkTotal: project.sparkSummary.total,
    };
}
const liveRowSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        verdict: { type: 'string', required: true },
        currency: { type: 'string', required: true },
        liveSince: { type: 'string', required: true },
        lastCheckin: { type: 'string', required: true },
        /** -1 when there is no check-in yet. */
        daysSinceCheckin: { type: 'integer', required: true },
        stale: { type: 'boolean', required: true },
        checkins: { type: 'integer', required: true },
        totalRevenue: { type: 'number', required: true },
        /** -1 when not recorded. */
        lastRevenue: { type: 'number', required: true },
        customers: { type: 'integer', required: true },
        metricName: { type: 'string', required: true },
        latestMetric: { type: 'number', required: true },
        /** Change since the previous check-in; -1 when there is nothing to compare. */
        metricDelta: { type: 'number', required: true },
        progress: { type: 'string', required: true },
        openHurdles: { type: 'array', required: true, items: { type: 'string' } },
        openCorrections: { type: 'array', required: true, items: { type: 'string' } },
        doneCorrections: { type: 'integer', required: true },
        killSwitch: { type: 'string', required: true },
        sparkOpen: { type: 'integer', required: true },
        sparkTotal: { type: 'integer', required: true },
    },
};
const liveOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        staleCount: { type: 'integer', required: true },
        projects: { type: 'array', required: true, items: liveRowSchema },
    },
};
function liveView(snapshot) {
    const rows = snapshot.projects.filter((project) => project.live).map(liveRow);
    return { staleCount: rows.filter((row) => row.stale).length, projects: rows };
}
function renderLive(value) {
    if (value.projects.length === 0) {
        return 'Nothing is live yet. A project moves here when its status becomes `shipped` — that is when the feedback loop starts.';
    }
    const lines = ['Live projects (' + value.projects.length + '):'];
    for (const row of value.projects) {
        lines.push('');
        lines.push(row.name + '  [' + row.verdict.toUpperCase() + ']');
        lines.push('   money: ' + row.totalRevenue + ' ' + row.currency + ' total'
            + (row.lastRevenue < 0 ? '' : ' | ' + row.lastRevenue + ' last period')
            + (row.customers < 0 ? '' : ' | ' + row.customers + ' customers'));
        if (row.metricName) {
            lines.push('   ' + row.metricName + ': ' + (row.latestMetric < 0 ? 'not recorded' : String(row.latestMetric))
                + (row.metricDelta === -1 ? '' : row.metricDelta >= 0 ? ' (+' + row.metricDelta + ')' : ' (' + row.metricDelta + ')'));
        }
        lines.push('   live since ' + (row.liveSince || '?') + ' | ' + row.checkins + ' check-in(s) | last '
            + (row.lastCheckin || 'never') + (row.daysSinceCheckin < 0 ? '' : ' (' + row.daysSinceCheckin + 'd ago)'));
        if (row.stale)
            lines.push('   STALE: no check-in for over a week — the loop has gone quiet, and an unmeasured project cannot be judged.');
        if (row.progress)
            lines.push('   progress: ' + row.progress);
        for (const hurdle of row.openHurdles)
            lines.push('   hurdle (open): ' + hurdle);
        for (const fix of row.openCorrections)
            lines.push('   correction (to do): ' + fix);
        if (row.doneCorrections > 0)
            lines.push('   corrections done: ' + row.doneCorrections);
        if (row.sparkTotal > 0) {
            lines.push('   sparks: ' + row.sparkOpen + ' of ' + row.sparkTotal
                + ' idea(s) this feedback produced are still undecided — see daily_sparks');
        }
        if (row.killSwitch)
            lines.push('   kill-switch: ' + row.killSwitch);
    }
    if (value.staleCount > 0)
        lines.push('', value.staleCount + ' live project(s) are stale and need a check-in.');
    return lines.join('\n');
}
/** Whole days from an ISO timestamp to a YYYY-MM-DD key. -1 when unreadable. */
function sparkAgeDays(createdAt, today) {
    if (today === '' || createdAt === '')
        return -1;
    const from = Date.parse(createdAt.slice(0, 10) + 'T00:00:00Z');
    const to = Date.parse(today + 'T00:00:00Z');
    if (Number.isNaN(from) || Number.isNaN(to))
        return -1;
    return Math.max(0, Math.round((to - from) / 86400000));
}
function sparksView(snapshot) {
    const board = snapshot.sparks;
    const today = snapshot.today === null ? '' : snapshot.today.date;
    const nameOf = (id) => {
        if (id === null)
            return '';
        const found = snapshot.projects.find((project) => project.id === id);
        return found === undefined ? '(project since removed)' : found.name;
    };
    const toRow = (spark) => ({
        id: spark.id,
        text: spark.text,
        status: spark.status,
        source: spark.sourceProjectName === null
            ? (spark.sourceDate === null ? 'no source recorded' : 'unattributed, logged ' + spark.sourceDate)
            : spark.sourceProjectName + (spark.sourceDate === null ? '' : ' on ' + spark.sourceDate),
        ageDays: sparkAgeDays(spark.createdAt, today),
        outcome: spark.status === 'promoted'
            ? 'promoted to project: ' + nameOf(spark.promotedProjectId)
            : spark.status === 'dismissed'
                ? 'dismissed: ' + (spark.dismissedReason ?? 'no reason recorded')
                : '',
    });
    return {
        open: board.open,
        promoted: board.promoted,
        dismissed: board.dismissed,
        oldestOpenDays: board.oldestOpenDays ?? -1,
        triageDue: board.triageDue,
        // The open queue first — that is the decision list — then the decided history
        // newest first, so the model can see whether an idea was already rejected and
        // on what grounds.
        sparks: [...board.openSparks, ...board.decidedSparks].map(toRow),
    };
}
const sparkRowSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        text: { type: 'string', required: true },
        status: { type: 'string', required: true },
        source: { type: 'string', required: true },
        /** -1 when the age cannot be computed. */
        ageDays: { type: 'integer', required: true },
        outcome: { type: 'string', required: true },
    },
};
const sparkOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        open: { type: 'integer', required: true },
        promoted: { type: 'integer', required: true },
        dismissed: { type: 'integer', required: true },
        /** -1 when nothing is open. */
        oldestOpenDays: { type: 'integer', required: true },
        triageDue: { type: 'boolean', required: true },
        sparks: { type: 'array', required: true, items: sparkRowSchema },
    },
};
function renderSparks(value) {
    if (value.sparks.length === 0) {
        return 'No ideas captured yet. A spark is a business idea a live project\'s feedback suggested — '
            + 'a hurdle that turns out to be the real product, a customer request that is a different business. '
            + 'Log them with daily_checkin (its `sparks` list) or daily_spark; they outlive the venture that produced them.';
    }
    const lines = ['Sparks (' + value.open + ' open, ' + value.promoted + ' promoted, ' + value.dismissed + ' dismissed):'];
    for (const row of value.sparks) {
        lines.push('');
        lines.push('[' + row.status.toUpperCase() + '] ' + row.text + '   (' + row.id + ')');
        lines.push('   from ' + row.source + (row.ageDays < 0 ? '' : ' | waiting ' + row.ageDays + 'd'));
        if (row.outcome)
            lines.push('   ' + row.outcome);
    }
    if (value.triageDue) {
        lines.push('');
        lines.push('TRIAGE DUE: the oldest open idea has waited ' + value.oldestOpenDays + ' days. Promote it into a '
            + 'pending project or dismiss it with a reason — an undecided idea is not an option, it is a decision avoided.');
    }
    return lines.join('\n');
}
function portfolioReport(snapshot) {
    const { counts, entries } = snapshot.portfolio;
    return {
        authored: counts.authored,
        ours: counts.ours,
        fork: counts.fork,
        thirdParty: counts.thirdParty,
        internal: counts.internal,
        published: counts.published,
        ready: counts.ready,
        installed: counts.installed,
        plugins: entries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            title: entry.title ?? '',
            origin: entry.origin,
            visibility: entry.visibility,
            status: entry.status,
            licence: entry.licence ?? '',
            upstream: entry.upstream ?? '',
            sourcePath: entry.sourcePath ?? '',
            publicUrl: entry.publicUrl ?? '',
            publishable: entry.publishable,
            blockers: entry.blockers,
            verifiedDaysAgo: entry.verifiedDaysAgo ?? -1,
            summary: entry.summary ?? '',
            checks: entry.checks.map((item) => ({
                key: item.key,
                name: item.name,
                ok: item.ok,
                detail: item.detail,
                fatal: item.fatal,
            })),
            commands: entry.commands,
            commandsNote: entry.commandsNote,
        })),
    };
}
const pluginRowSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        title: { type: 'string', required: true },
        origin: { type: 'string', required: true },
        visibility: { type: 'string', required: true },
        status: { type: 'string', required: true },
        licence: { type: 'string', required: true },
        upstream: { type: 'string', required: true },
        sourcePath: { type: 'string', required: true },
        publicUrl: { type: 'string', required: true },
        publishable: { type: 'boolean', required: true },
        blockers: { type: 'array', required: true, items: { type: 'string' } },
        /** -1 when the facts have never been verified. */
        verifiedDaysAgo: { type: 'integer', required: true },
        summary: { type: 'string', required: true },
        /* Inlined rather than a named const: a const referenced here would have to
           be declared above this literal, and that ordering is easy to get wrong. */
        checks: {
            type: 'array',
            required: true,
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    key: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    ok: { type: 'boolean', required: true },
                    detail: { type: 'string', required: true },
                    fatal: { type: 'boolean', required: true },
                },
            },
        },
        /** EMPTY when publishing is refused or impossible. */
        commands: { type: 'string', required: true },
        /** Why a green row has none. EMPTY when there is nothing to explain. */
        commandsNote: { type: 'string', required: true },
    },
};
const portfolioOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        authored: { type: 'integer', required: true },
        ours: { type: 'integer', required: true },
        fork: { type: 'integer', required: true },
        thirdParty: { type: 'integer', required: true },
        internal: { type: 'integer', required: true },
        published: { type: 'integer', required: true },
        ready: { type: 'integer', required: true },
        installed: { type: 'integer', required: true },
        plugins: { type: 'array', required: true, items: pluginRowSchema },
    },
};
function renderPortfolioReport(value) {
    if (value.plugins.length === 0) {
        return 'The plugin portfolio register is empty. Record a plugin with daily_plugin — its origin '
            + '(ours | fork | third-party) is required, because that single field decides whether it can ever be published.';
    }
    const lines = ['Plugin portfolio — ' + value.authored + ' authored ('
            + value.ours + ' ours, ' + value.fork + ' fork' + (value.fork === 1 ? '' : 's') + ')'
            + ', ' + value.published + ' published, ' + value.ready + ' ready to publish'
            + ' | ' + value.thirdParty + ' third-party (never publishable)'
            + (value.internal > 0 ? ' | ' + value.internal + ' marked internal' : '')
            + (value.installed > 0 ? ' | ' + value.installed + ' installed' : '')];
    for (const plugin of value.plugins) {
        lines.push('');
        lines.push(plugin.name + (plugin.title === '' ? '' : '  (' + plugin.title + ')')
            + '  [' + plugin.origin.toUpperCase() + ' | ' + plugin.visibility + ' | ' + plugin.status + ']');
        if (plugin.summary !== '')
            lines.push('   ' + plugin.summary);
        const meta = [];
        if (plugin.licence !== '')
            meta.push('licence ' + plugin.licence);
        if (plugin.upstream !== '')
            meta.push('upstream ' + plugin.upstream);
        if (plugin.sourcePath !== '')
            meta.push(plugin.sourcePath);
        meta.push(plugin.verifiedDaysAgo < 0 ? 'facts never verified' : 'facts verified ' + plugin.verifiedDaysAgo + 'd ago');
        lines.push('   ' + meta.join(' | '));
        if (plugin.status === 'public') {
            lines.push('   PUBLISHED' + (plugin.publicUrl === '' ? '' : ' — ' + plugin.publicUrl));
        }
        else if (!plugin.publishable) {
            // A fact, not a to-do list: there is nothing to fix, and listing the
            // missing facts would read as work on something that must not happen.
            lines.push('   NOT PUBLISHABLE — ' + plugin.blockers.join('; '));
            for (const item of plugin.checks)
                lines.push('   ' + item.name + ': ' + (item.ok ? 'pass' : 'refused'));
        }
        else {
            // EVERY item, passed or not: "it said ready" is not a record of what was
            // checked, so the passed items are named as well as the failed ones.
            for (const item of plugin.checks) {
                lines.push('   ' + item.name + ': ' + (item.ok ? 'pass' : 'TODO — ' + item.detail));
            }
            if (plugin.blockers.length === 0)
                lines.push('   READY TO PUBLISH — every item above passes');
            if (plugin.commands !== '') {
                lines.push('');
                lines.push('   Paste this to publish it (step 1 is in the GitHub UI):');
                for (const line of plugin.commands.split('\n'))
                    lines.push('     ' + line);
            }
            else if (plugin.commandsNote !== '') {
                // The one state that would otherwise be silent: the gate is green and
                // there is nothing to paste. The model is told why, in the page's words.
                lines.push('   ' + plugin.commandsNote);
            }
        }
    }
    return lines.join('\n');
}
const resumeOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        published: { type: 'integer', required: true },
        ready: { type: 'integer', required: true },
        block: { type: 'string', required: true },
        /** The document with the block spliced in, or '' when none was passed or the splice was refused. */
        spliced: { type: 'string', required: true },
        /** Why the splice was refused, or ''. */
        spliceError: { type: 'string', required: true },
    },
};
function renderResume(value) {
    const lines = ['Public résumé section — ' + value.published + ' published, '
            + value.ready + ' in the queue.', '', value.block, ''];
    if (value.spliceError !== '') {
        lines.push('NOT spliced: ' + value.spliceError);
        lines.push('Add these two lines around the list you want generated, then call again:');
        lines.push('  ' + EXPORT_BEGIN);
        lines.push('  ' + EXPORT_END);
    }
    else if (value.spliced !== '') {
        lines.push('Spliced above into the document you passed (' + value.spliced.length
            + ' characters). Write it back to the file yourself — this plugin writes nothing.');
    }
    else {
        lines.push('Pass the current text of the target document as `document` and it comes back spliced.');
    }
    return lines.join('\n');
}
const RESUME_OUT = {
    schema: resumeOutputSchema,
    render: (_args, value) => [
        { type: 'text', text: renderResume(value) },
    ],
};
const PORTFOLIO_OUT = {
    schema: portfolioOutputSchema,
    render: (_args, value) => [
        { type: 'text', text: renderPortfolioReport(value) },
    ],
};
function projectsView(snapshot) {
    const rows = snapshot.projects.map(projectRow);
    const selected = snapshot.projects.find((project) => project.id === snapshot.selectedProjectId);
    return {
        selectedProjectId: snapshot.selectedProjectId ?? '',
        selectedProjectName: selected?.name ?? '',
        projects: rows,
    };
}
/** Ranked table, so the model reasons over the same order the UI shows. */
function renderProjects(value) {
    const lines = [];
    lines.push(value.projects.length === 0
        ? 'No projects yet. Add one with daily_add_project.'
        : 'Ranked by expected ' + value.projects[0].currency + '/month per day of build effort:');
    value.projects.forEach((row, index) => {
        const money = row.revenuePerMonth < 0 ? 'revenue not estimated' : row.revenuePerMonth + ' ' + row.currency + '/mo';
        const ttfd = row.ttfdDays < 0 ? 'first dollar: ?' : 'first dollar: day ' + row.ttfdDays;
        const effort = row.effortDays < 0 ? 'effort: ?' : 'effort: ' + row.effortDays + 'd';
        const score = row.score < 0 ? 'UNRANKED' : String(row.score);
        lines.push((index + 1) + '. ' + row.name + (row.id === value.selectedProjectId ? '  [SELECTED]' : ''));
        lines.push('   score ' + score + ' | ' + money + ' | ' + ttfd + ' | ' + effort + ' | conf ' + row.confidence);
        lines.push('   fulfils: ' + row.fulfills);
        if (row.summary)
            lines.push('   summary: ' + row.summary);
        if (row.killSwitch)
            lines.push('   kill-switch: ' + row.killSwitch);
        lines.push('   weakest dimension: ' + row.weakest);
    });
    if (value.selectedProjectName)
        lines.push('', 'Selected: ' + value.selectedProjectName + ' (' + value.selectedProjectId + ')');
    return lines.join('\n');
}
const RUBRIC_PARAM = {
    type: 'object',
    additionalProperties: false,
    description: 'Rubric ratings 1-5 where 5 is always the FAVOURABLE end (so for regulatoryCost, 5 = cheapest to enter, 1 = heavy licensing). Omit a dimension to leave it neutral at 3. These do NOT feed the score; the lowest one is reported as the real risk.',
    properties: {
        forcingFunction: { type: 'integer', description: 'Why now: regulatory change, platform shift, expiring status quo.' },
        competitionThinness: { type: 'integer', description: '5 = few or no players at the exact layer being entered.' },
        assetLightness: { type: 'integer', description: '5 = no inventory, credit risk or fixed opex.' },
        aiRunnability: { type: 'integer', description: '5 = most of the delivery loop runs without a human.' },
        distribution: { type: 'integer', description: '5 = a clear, cheap path to the buyer.' },
        moat: { type: 'integer', description: '5 = hard to copy in 90 days.' },
        regulatoryCost: { type: 'integer', description: '5 = cheap and compliant to enter.' },
    },
};
const PROJECT_REF_PARAMS = {
    projectId: { type: 'string', description: 'Exact project id. Use this or `project`, not both.' },
    project: { type: 'string', description: 'A unique case-insensitive substring of the project name. Use when you know the name but not the id.' },
};
/** Same refs, but `projectId: null` is legal and means "clear it". */
const PROJECT_REF_OR_NULL = {
    projectId: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Exact project id, or null to clear the selection entirely.',
    },
    project: PROJECT_REF_PARAMS.project,
};
/** Nullable project link on a task: a string links, null unlinks. */
const PROJECT_LINK_PARAM = {
    oneOf: [{ type: 'string' }, { type: 'null' }],
    description: 'Project id to link this task to, or null to unlink it.',
};
const TARGET_PARAM = {
    type: 'string',
    enum: ['today', 'tomorrow'],
    description: 'Which day to act on. Defaults to today.',
};
const FROM_DATE_PARAM = {
    type: 'string',
    description: 'The exact YYYY-MM-DD day the task currently sits on. Use this for tasks outside today/tomorrow — the pool in daily_plan lists each task with its date. Defaults to the target day (today, or tomorrow).',
};
const ITEM_ID_PARAM = {
    type: 'string',
    description: 'Exact task id. Use this or `text`, not both.',
};
const TASK_MATCH_PARAM = {
    type: 'string',
    description: 'A unique case-insensitive substring of the task text. Use instead of itemId when you know what the task says but not its id.',
};
const BACKLOG_ID_PARAM = {
    type: 'string',
    description: 'Exact backlog task id from daily_plan\'s backlog section. Use this or `task`, not both.',
};
const SELECT_PARAM = {
    type: 'boolean',
    description: 'When true, also make this the task the operator is working on now (the same as daily_now). Use it when the request is "start this", not merely "move this".',
};
/** Turn a planner failure into a tool error the model can read and correct. */
function unwrap(result, date) {
    if (!result.ok)
        throw new Error(result.code + ': ' + result.message);
    return planView(date, result.snapshot);
}
/** The tool definitions, unregistered — exported so tests can enumerate them. */
export function buildTools(deps) {
    const { planner, today } = deps;
    const renderOut = (_args, value) => [{ type: 'text', text: renderPlan(value) }];
    /**
     * Ops that address an existing item. When the caller gives no `target`, try
     * today and then tomorrow: a model usually knows the task TEXT, not which
     * column it lives in, and "not found because you guessed the wrong day" is a
     * confusing failure. An explicit target is always honoured as given.
     */
    const applyItemOp = async (op, base, date) => {
        const explicit = base.target;
        const first = await planner.apply(op, date, '', { ...base, target: explicit ?? 'today' });
        if (first.ok || explicit !== undefined || first.code !== 'item_not_found')
            return first;
        return planner.apply(op, date, '', { ...base, target: 'tomorrow' });
    };
    return [
        defineTool({
            name: 'daily_plan',
            description: 'Read the daily plan: today\'s tasks, tomorrow\'s plan, the current streak and the week completion rate. Call this before scheduling or completing anything so you act on real task ids.',
            parameters: {
                date: { type: 'string', description: 'Local date to read as YYYY-MM-DD. Defaults to today in the configured timezone.' },
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = args.date ?? today();
                return planView(date, await planner.snapshot(date, ''));
            },
        }),
        defineTool({
            name: 'daily_add_task',
            description: 'Add one task to today\'s checklist or to tomorrow\'s plan. Use `target: "tomorrow"` when the user is planning ahead.',
            parameters: {
                text: { type: 'string', required: true, description: 'The task, a short imperative line, 1-500 characters.' },
                target: TARGET_PARAM,
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await planner.apply('addItem', date, '', { target: args.target ?? 'today', text: args.text }), date);
            },
        }),
        defineTool({
            name: 'daily_set_task_done',
            description: 'Mark a task done or not done. Pass done:true to complete it, done:false to reopen it. Searches today then tomorrow unless you pass target; pass fromDate to tick a task that sits on any other day (for instance one you did after all, listed in the pool).',
            parameters: {
                done: { type: 'boolean', required: true, description: 'true marks the task complete, false reopens it.' },
                itemId: ITEM_ID_PARAM,
                task: TASK_MATCH_PARAM,
                target: TARGET_PARAM,
                fromDate: FROM_DATE_PARAM,
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await applyItemOp('toggleItem', {
                    itemId: args.itemId, match: args.task, done: args.done,
                    target: args.target, fromDate: args.fromDate,
                }, date), date);
            },
        }),
        defineTool({
            name: 'daily_edit_task',
            description: 'Rewrite the text of an existing task, on today or tomorrow. Searches today then tomorrow unless you pass target.',
            parameters: {
                newText: { type: 'string', required: true, description: 'The replacement text, 1-500 characters.' },
                itemId: ITEM_ID_PARAM,
                task: TASK_MATCH_PARAM,
                target: TARGET_PARAM,
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await applyItemOp('editItemText', {
                    target: args.target, itemId: args.itemId, match: args.task, newText: args.newText,
                }, date), date);
            },
        }),
        defineTool({
            name: 'daily_move_task',
            description: 'Move a task to a different date — use this to defer, reschedule, or PULL SOMETHING FORWARD from another day. Searches today then tomorrow unless you pass target; pass fromDate (from the pool section of daily_plan) to move a task that sits on any other day.',
            parameters: {
                toDate: { type: 'string', required: true, description: 'Destination local date as YYYY-MM-DD.' },
                itemId: ITEM_ID_PARAM,
                task: TASK_MATCH_PARAM,
                target: TARGET_PARAM,
                fromDate: FROM_DATE_PARAM,
                select: SELECT_PARAM,
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await applyItemOp('moveItem', {
                    target: args.target, itemId: args.itemId, match: args.task, toDate: args.toDate,
                    fromDate: args.fromDate, select: args.select,
                }, date), date);
            },
        }),
        /**
         * Choosing what to work on is the operator's call, not the ranking's. This
         * tool is how the model records that choice — and how it clears it.
         */
        defineTool({
            name: 'daily_now',
            description: 'Set, change or clear the ONE task the operator is working on right now, shown in the NOW banner at the top of the planner tab. Pass itemId to pick a task (any task on today, tomorrow or anywhere in the pool — get ids from daily_plan), or clear:true to pick nothing. Picking a task never changes what is done; it only says where the attention is.',
            parameters: {
                itemId: { type: 'string', description: 'The task to work on. Get it from daily_plan (any of today, tomorrow, now or pool).' },
                date: { type: 'string', description: 'The YYYY-MM-DD day that task sits on, when you know it. Optional — the planner resolves the task by id anyway.' },
                clear: { type: 'boolean', description: 'true clears the pick, so nothing is being worked on.' },
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                const payload = args.clear === true ? { itemId: null } : { itemId: args.itemId, date: args.date };
                return unwrap(await planner.apply('selectItem', date, '', payload), date);
            },
        }),
        defineTool({
            name: 'daily_reorder_task',
            description: 'Move a task one place up or down in its list, so the order of the plan is the operator\'s priority order. Use direction "up" to make a task more prominent. Targets today unless you pass target.',
            parameters: {
                direction: { type: 'string', required: true, enum: ['up', 'down'], description: 'Which way to move the task.' },
                itemId: ITEM_ID_PARAM,
                task: TASK_MATCH_PARAM,
                target: TARGET_PARAM,
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await applyItemOp('reorderItem', {
                    target: args.target, itemId: args.itemId, match: args.task, direction: args.direction,
                }, date), date);
            },
        }),
        defineTool({
            name: 'daily_remove_task',
            description: 'Delete a task from today or tomorrow. Searches today then tomorrow unless you pass target; pass fromDate to delete a task that sits on any other day.',
            parameters: {
                itemId: ITEM_ID_PARAM,
                task: TASK_MATCH_PARAM,
                target: TARGET_PARAM,
                fromDate: FROM_DATE_PARAM,
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await applyItemOp('removeItem', {
                    target: args.target, itemId: args.itemId, match: args.task, fromDate: args.fromDate,
                }, date), date);
            },
        }),
        // ---- the backlog: the menu of unscheduled work ---------------------------
        defineTool({
            name: 'daily_backlog_add',
            description: 'Add an UNSCHEDULED candidate task to a project\'s backlog. This is the menu of work the operator chooses from: a backlog task has no date until someone pulls it onto a day with daily_backlog_plan. Use this — not daily_add_task — whenever the user is listing what COULD be done for a project rather than committing to a day.',
            parameters: {
                text: { type: 'string', required: true, description: 'The candidate task, a short imperative line, 1-500 characters.' },
                project: { type: 'string', required: true, description: 'Project name, or a unique substring of it.' },
                summary: { type: 'string', description: 'One line on what the task implements, carried onto the plan item when it is scheduled.' },
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await planner.apply('addBacklogItem', date, '', {
                    text: args.text, project: args.project, summary: args.summary,
                }), date);
            },
        }),
        defineTool({
            name: 'daily_backlog_plan',
            description: 'Schedule a backlog candidate onto a day — the move that turns a possibility into a commitment. Removes it from the backlog and creates the task, linked to its project. Pass select:true to also make it the task the operator is working on now. Defaults to today; pass toDate "tomorrow" or a YYYY-MM-DD.',
            parameters: {
                backlogItemId: BACKLOG_ID_PARAM,
                task: { type: 'string', description: 'A unique case-insensitive substring of the backlog task text, when you do not have its id. Optionally scoped by `project`.' },
                project: { type: 'string', description: 'Project name or unique substring, to disambiguate a text match.' },
                toDate: { type: 'string', description: 'Destination: YYYY-MM-DD, the literal "tomorrow", or omitted for today.' },
                select: SELECT_PARAM,
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await planner.apply('planBacklogItem', date, '', {
                    backlogItemId: args.backlogItemId, match: args.task, project: args.project,
                    toDate: args.toDate, select: args.select,
                }), date);
            },
        }),
        defineTool({
            name: 'daily_backlog_remove',
            description: 'Drop a backlog candidate without ever scheduling it — the task is not wanted after all. Use daily_remove_task for tasks that already sit on a day.',
            parameters: {
                backlogItemId: BACKLOG_ID_PARAM,
                task: { type: 'string', description: 'A unique case-insensitive substring of the backlog task text. Optionally scoped by `project`.' },
                project: { type: 'string', description: 'Project name or unique substring, to disambiguate a text match.' },
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await planner.apply('removeBacklogItem', date, '', {
                    backlogItemId: args.backlogItemId, match: args.task, project: args.project,
                }), date);
            },
        }),
        defineTool({
            name: 'daily_suggest',
            description: 'Attach a row of suggestion chips to one task. The user sees them under the task in the planner tab and clicks one to apply it. Each suggestion needs a SHORT label (<=60 chars) and an action: '
                + 'info (explain only, put the text in detail), complete (mark done), defer (needs date), split (needs items), retitle (needs text), drop (delete the task). '
                + 'Offer at most 3-4 genuinely useful chips per task; replace the whole row each call.',
            parameters: {
                suggestions: {
                    type: 'array',
                    required: true,
                    description: 'The complete chip row for this task, 1-6 entries. Replaces any existing chips.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            label: { type: 'string', required: true, description: 'Chip text, at most 60 characters.' },
                            action: {
                                type: 'string',
                                required: true,
                                enum: ['info', 'complete', 'defer', 'split', 'retitle', 'drop'],
                                description: 'What clicking the chip does.',
                            },
                            detail: { type: 'string', description: 'Longer explanation, shown for info chips and as a tooltip.' },
                            date: { type: 'string', description: 'For defer: YYYY-MM-DD or the literal "tomorrow".' },
                            items: { type: 'array', items: { type: 'string' }, description: 'For split: the replacement task texts.' },
                            text: { type: 'string', description: 'For retitle: the new task text.' },
                        },
                    },
                },
                itemId: ITEM_ID_PARAM,
                task: TASK_MATCH_PARAM,
                target: TARGET_PARAM,
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await applyItemOp('setSuggestions', {
                    target: args.target,
                    itemId: args.itemId,
                    match: args.task,
                    suggestions: args.suggestions,
                }, date), date);
            },
        }),
        defineTool({
            name: 'daily_projects',
            description: 'Read every money-making project, RANKED by expected currency per month per day of build effort (WSJF: value x urgency / effort, discounted the further away the first dollar is). Shows the selected project and each project\'s weakest rubric dimension. Call this before choosing what to work on, or before breaking a project into tasks.',
            parameters: {},
            output: { schema: projectsOutputSchema, render: (_args, value) => [{ type: 'text', text: renderProjects(value) }] },
            execute: async () => projectsView(await planner.snapshot(today(), '')),
        }),
        defineTool({
            name: 'daily_add_project',
            description: 'Add a money-making project to the board. Only ttfdDays, effortDays and revenuePerMonth make it rankable — without all three it shows as UNRANKED until estimated. Never invent these numbers: ask, or leave them out.',
            parameters: {
                name: { type: 'string', required: true, description: 'Short project name.' },
                fulfills: { type: 'string', required: true, description: 'One sentence: who it serves and what need it fulfils.' },
                summary: { type: 'string', description: 'What "done" looks like and what it unblocks.' },
                ttfdDays: { type: 'integer', description: 'Estimated days from starting to the FIRST dollar.' },
                effortDays: { type: 'number', description: 'Estimated build effort in days.' },
                revenuePerMonth: { type: 'number', description: 'Expected revenue per month once running.' },
                currency: { type: 'string', description: 'Currency label, e.g. KSh. Defaults to KSh.' },
                confidence: { type: 'number', description: '0-1 confidence in the revenue estimate. Defaults to 0.5.' },
                status: { type: 'string', enum: ['idea', 'active', 'parked', 'shipped', 'killed'], description: 'Defaults to idea.' },
                killSwitch: { type: 'string', description: 'Falsifiable milestone, e.g. "first paid deal by day 30".' },
                metricName: { type: 'string', description: 'The ONE number that matters once this ships, e.g. "paid retainers". Keeps the live board readable.' },
                rubric: RUBRIC_PARAM,
            },
            output: { schema: projectsOutputSchema, render: (_args, value) => [{ type: 'text', text: renderProjects(value) }] },
            execute: async (args) => {
                const date = today();
                const result = await planner.apply('addProject', date, '', args);
                if (!result.ok)
                    throw new Error(result.code + ': ' + result.message);
                return projectsView(result.snapshot);
            },
        }),
        defineTool({
            name: 'daily_update_project',
            description: 'Change a project — estimates, rubric, status, kill-switch, wording. Only the fields you pass change.',
            parameters: {
                ...PROJECT_REF_PARAMS,
                name: { type: 'string', description: 'New name.' },
                fulfills: { type: 'string', description: 'New one-sentence purpose.' },
                summary: { type: 'string', description: 'New summary.' },
                ttfdDays: { type: 'integer', description: 'Days to the first dollar.' },
                effortDays: { type: 'number', description: 'Build effort in days.' },
                revenuePerMonth: { type: 'number', description: 'Expected revenue per month.' },
                currency: { type: 'string', description: 'Currency label.' },
                confidence: { type: 'number', description: '0-1 confidence.' },
                status: { type: 'string', enum: ['idea', 'active', 'parked', 'shipped', 'killed'], description: 'Pipeline status.' },
                killSwitch: { type: 'string', description: 'Falsifiable kill-switch.' },
                metricName: { type: 'string', description: 'The ONE number that matters once this ships.' },
                rubric: RUBRIC_PARAM,
            },
            output: { schema: projectsOutputSchema, render: (_args, value) => [{ type: 'text', text: renderProjects(value) }] },
            execute: async (args) => {
                const date = today();
                const result = await planner.apply('updateProject', date, '', args);
                if (!result.ok)
                    throw new Error(result.code + ': ' + result.message);
                return projectsView(result.snapshot);
            },
        }),
        defineTool({
            name: 'daily_select_project',
            description: 'Choose which project we are executing. Selecting an `idea` project moves it to `active`. Pass projectId:null to clear the selection.',
            parameters: { ...PROJECT_REF_OR_NULL },
            output: { schema: projectsOutputSchema, render: (_args, value) => [{ type: 'text', text: renderProjects(value) }] },
            execute: async (args) => {
                const date = today();
                const result = await planner.apply('selectProject', date, '', args);
                if (!result.ok)
                    throw new Error(result.code + ': ' + result.message);
                return projectsView(result.snapshot);
            },
        }),
        defineTool({
            name: 'daily_plan_project',
            description: 'Break the selected project (or a named one) into daily tasks in one call. Each task gets a short summary box saying what it implements, and is linked to the project so the planner can show the project\'s work as its own column. Defaults to today.',
            parameters: {
                ...PROJECT_REF_PARAMS,
                tasks: {
                    type: 'array',
                    required: true,
                    description: 'The tasks to schedule, 1-50.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            text: { type: 'string', required: true, description: 'The task, a short imperative line.' },
                            summary: { type: 'string', description: 'What this task implements — shown in the task\'s summary box.' },
                            target: { type: 'string', enum: ['today', 'tomorrow'], description: 'Which day. Defaults to today.' },
                        },
                    },
                },
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                const tasks = Array.isArray(args.tasks) ? args.tasks : [];
                if (tasks.length === 0)
                    throw new Error('invalid_payload: tasks must be a non-empty array');
                // Resolve the project to an ID first. Passing a NAME straight through to
                // addItem would silently create unlinked tasks, because addItem only
                // links by id.
                const snapshot0 = await planner.snapshot(date, '');
                let projectId = args.projectId;
                if (projectId === undefined) {
                    if (args.project === undefined) {
                        if (snapshot0.selectedProjectId === null) {
                            throw new Error('project_not_found: no project is selected — call daily_select_project first, or name one');
                        }
                        projectId = snapshot0.selectedProjectId;
                    }
                    else {
                        const needle = String(args.project).trim().toLowerCase();
                        const hits = snapshot0.projects.filter((candidate) => candidate.name.toLowerCase().includes(needle));
                        if (hits.length === 0)
                            throw new Error('project_not_found: no project matching ' + JSON.stringify(args.project));
                        if (hits.length > 1) {
                            throw new Error('invalid_payload: ambiguous — ' + hits.map((candidate) => JSON.stringify(candidate.name)).join(', '));
                        }
                        projectId = hits[0].id;
                    }
                }
                let view = null;
                for (const entry of tasks) {
                    if (typeof entry !== 'object' || entry === null)
                        throw new Error('invalid_payload: every task must be an object');
                    const task = entry;
                    const result = await planner.apply('addItem', date, '', {
                        target: task.target === 'tomorrow' ? 'tomorrow' : 'today',
                        text: task.text,
                        summary: task.summary,
                        projectId,
                    });
                    if (!result.ok)
                        throw new Error(result.code + ': ' + result.message);
                    view = planView(date, result.snapshot);
                }
                return view ?? planView(date, await planner.snapshot(date, ''));
            },
        }),
        defineTool({
            name: 'daily_update_task',
            description: 'Change one task\'s text, its summary box (what it implements), or which project it belongs to. Searches today then tomorrow unless you pass target. Pass projectId:null to unlink it.',
            parameters: {
                itemId: ITEM_ID_PARAM,
                task: TASK_MATCH_PARAM,
                target: TARGET_PARAM,
                newText: { type: 'string', description: 'Replacement task text.' },
                summary: { type: 'string', description: 'What this task implements — its summary box.' },
                projectId: PROJECT_LINK_PARAM,
            },
            output: { schema: planOutputSchema, render: renderOut },
            execute: async (args) => {
                const date = today();
                return unwrap(await applyItemOp('updateItem', {
                    target: args.target,
                    itemId: args.itemId,
                    match: args.task,
                    text: args.newText,
                    summary: args.summary,
                    projectId: args.projectId,
                }, date), date);
            },
        }),
        defineTool({
            name: 'daily_live',
            description: 'Read the Live board: every SHIPPED project with the money it has made, its one metric, open hurdles, corrections to do, the last verdict and whether the loop has gone quiet (no check-in for over a week). Use this before advising a fix, a pivot or a kill.',
            parameters: {},
            output: { schema: liveOutputSchema, render: (_args, value) => [{ type: 'text', text: renderLive(value) }] },
            execute: async () => liveView(await planner.snapshot(today(), '')),
        }),
        defineTool({
            name: 'daily_checkin',
            description: 'Log a check-in for a shipped project — the feedback loop. Records money taken THIS period, the one metric, paying customers, what progressed, open hurdles, corrections and a verdict. Recording a `kill` verdict also marks the project killed. Only the fields you pass change; a second check-in on the same day updates that day.',
            parameters: {
                ...PROJECT_REF_PARAMS,
                date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
                metric: { type: 'number', description: 'The value of the project\'s one metric (see metricName) at this check-in.' },
                metricNote: { type: 'string', description: 'One line of context for the metric.' },
                revenue: { type: 'number', description: 'Money taken in THIS period, not cumulative. The board totals it.' },
                customers: { type: 'integer', description: 'Paying customers as of this check-in.' },
                progress: { type: 'string', description: 'What actually advanced since the last check-in.' },
                verdict: { type: 'string', enum: ['continue', 'fix', 'kill', 'pause'], description: 'What this check-in decides to do about the project.' },
                note: { type: 'string', description: 'Anything else worth keeping.' },
                hurdles: { type: 'array', items: { type: 'string' }, description: 'Open hurdles, replacing the previous list. Close one with daily_checkin_item.' },
                corrections: { type: 'array', items: { type: 'string' }, description: 'Corrections to make, replacing the previous list. Close one with daily_checkin_item.' },
                sparks: { type: 'array', items: { type: 'string' }, description: 'Business ideas THIS feedback sparked: adjacent opportunities, or a hurdle that turns out to be the real product. Replaces the previous OPEN list only — ideas already promoted or dismissed are kept. Manage them with daily_sparks.' },
            },
            output: { schema: liveOutputSchema, render: (_args, value) => [{ type: 'text', text: renderLive(value) }] },
            execute: async (args) => {
                const date = today();
                const result = await planner.apply('logCheckin', date, '', args);
                if (!result.ok)
                    throw new Error(result.code + ': ' + result.message);
                return liveView(result.snapshot);
            },
        }),
        defineTool({
            name: 'daily_checkin_item',
            description: 'Close or reopen one hurdle or correction on a shipped project (default: the newest check-in that mentions it). Matched by a unique case-insensitive substring.',
            parameters: {
                ...PROJECT_REF_PARAMS,
                kind: { type: 'string', required: true, enum: ['hurdle', 'correction'], description: 'Which list the item is in.' },
                match: { type: 'string', required: true, description: 'A unique substring of the item text.' },
                done: { type: 'boolean', description: 'true closes it (default), false reopens it.' },
                date: { type: 'string', description: 'Restrict the search to one check-in date (YYYY-MM-DD). Defaults to the newest matching check-in.' },
            },
            output: { schema: liveOutputSchema, render: (_args, value) => [{ type: 'text', text: renderLive(value) }] },
            execute: async (args) => {
                const date = today();
                const result = await planner.apply('checkinItem', date, '', args);
                if (!result.ok)
                    throw new Error(result.code + ': ' + result.message);
                return liveView(result.snapshot);
            },
        }),
        defineTool({
            name: 'daily_plugins',
            description: 'Read the plugin portfolio register: every plugin authored or installed, with its origin (ours | fork | third-party), visibility, licence, source path, publication state and the full gate CHECKLIST — every item, passed or failed — plus, for work that may be published at all, the exact shell to publish it. Use it to answer "how many plugins have I built" and to check readiness BEFORE claiming anything is publishable.',
            parameters: {},
            output: PORTFOLIO_OUT,
            execute: async () => portfolioReport(await planner.snapshot(today(), '')),
        }),
        defineTool({
            name: 'daily_export',
            description: 'Render the PUBLIC résumé section from this register: only plugins that are already public AND carry a URL, with counts derived from the same records the gate reads, and none of the gate\'s own language (no commands, no scan notes, no blockers, no dates). Nothing unpublished, internal or third-party can appear — a résumé that links to a repository that does not exist is worse than a short one. Pass `document` (the current text of the README you mean to update) and it comes back with the block spliced between its markers; the splice REFUSES rather than appending when the markers are missing. This tool writes nothing: it returns text, and you write the file.',
            parameters: {
                document: { type: 'string', description: 'Optional: the current text of the target document. When given, the result includes it with the generated block spliced between the marker pair.' },
                date: { type: 'string', description: 'Local date to read the register as of, YYYY-MM-DD. Defaults to today in the configured timezone. The queue count moves with it, because a fact older than 30 days stops counting as current.' },
            },
            output: RESUME_OUT,
            execute: async (args) => {
                const snapshot = await planner.snapshot(args.date ?? today(), '');
                const block = renderExportBlock(snapshot.portfolio.entries);
                const counts = exportCounts(snapshot.portfolio.entries);
                const document = args.document ?? '';
                if (document === '') {
                    return { published: counts.published, ready: counts.ready, block, spliced: '', spliceError: '' };
                }
                const spliced = spliceExport(document, block);
                return {
                    published: counts.published,
                    ready: counts.ready,
                    block,
                    spliced: spliced ?? '',
                    spliceError: spliced === null
                        ? 'the document has no marker pair: ' + EXPORT_BEGIN + ' … ' + EXPORT_END
                        : '',
                };
            },
        }),
        defineTool({
            name: 'daily_plugin',
            description: 'Record or update ONE plugin in the portfolio register, keyed on its package name. `origin` is required the first time and is the field that decides everything: `ours` and `fork` can be published (a fork must also carry its upstream repo and commit), `third-party` never can. Visibility defaults to internal, because publishing is an explicit act and nothing should become publishable by omission. Record only facts you actually checked, and set `verifiedAt` to the day you checked them — the gate treats a stale verification as a blocker, not a pass.',
            parameters: {
                name: { type: 'string', required: true, description: 'Package name, e.g. dsh-cost-bubble. The register is keyed on it.' },
                origin: { type: 'string', enum: ['ours', 'fork', 'third-party'], description: 'Who wrote it. Required when first recording; third-party is never publishable.' },
                visibility: { type: 'string', enum: ['showcase', 'internal'], description: 'Whether it may EVER be published. Defaults to internal.' },
                status: { type: 'string', enum: ['local', 'public'], description: 'local (not published) or public. Defaults to local.' },
                title: { type: 'string', description: 'Display name.' },
                summary: { type: 'string', description: 'One or two lines on what it does.' },
                upstream: { type: 'string', description: 'For a fork: the upstream repo and commit, e.g. omdsh-dev/x@bedbd28.' },
                licence: { type: 'string', description: 'e.g. MIT, BSD-3-Clause.' },
                sourcePath: { type: 'string', description: 'Where the source lives on disk.' },
                publicUrl: { type: 'string', description: 'The public repository URL, once published.' },
                publishedAt: { type: 'string', description: 'The day it went public (YYYY-MM-DD).' },
                installed: { type: 'boolean', description: 'Registered with the harness profile.' },
                hasLicenseFile: { type: 'boolean', description: 'A LICENSE file exists in the source tree.' },
                hasReadme: { type: 'boolean', description: 'A README exists.' },
                hasScreenshot: { type: 'boolean', description: 'A screenshot exists in the repo.' },
                sourceOutsideProfile: { type: 'boolean', description: 'False when the only copy is inside a profile node_modules — a single point of failure.' },
                leakScanPassed: { type: 'boolean', description: 'The pre-publish leak scan passed for the CURRENT tree.' },
                leakScanAt: { type: 'string', description: 'The day the leak scan last ran (YYYY-MM-DD).' },
                gitReady: { type: 'boolean', description: 'A git repository exists with a clean working tree.' },
                preflightPassed: { type: 'boolean', description: 'The pre-flight passed for the CURRENT tree. A different fact from the leak scan: that one says the tree is safe to publish, this one says it still works.' },
                preflightAt: { type: 'string', description: 'The day the pre-flight last ran (YYYY-MM-DD).' },
                preflightNote: { type: 'string', description: 'What the pre-flight actually ran, e.g. "82 tests, 269 probes, build clean". The gate shows this, so "passed" can be read back and judged.' },
                verifiedAt: { type: 'string', description: 'The day ALL the facts above were checked (YYYY-MM-DD). They expire.' },
                notes: { type: 'string', description: 'Anything else worth keeping.' },
            },
            output: PORTFOLIO_OUT,
            execute: async (args) => {
                const name = typeof args.name === 'string' ? args.name.trim() : '';
                if (name.length === 0)
                    throw new Error('invalid_payload: name is required');
                // Resolve by exact name to an id, so a name that is a substring of
                // another plugin's cannot come back as an ambiguous match.
                const before = await planner.snapshot(today(), '');
                const existing = before.portfolio.entries.find((entry) => entry.name === name);
                const payload = existing === undefined ? args : { ...args, pluginId: existing.id };
                const result = await planner.apply(existing === undefined ? 'addPlugin' : 'updatePlugin', today(), '', payload);
                if (!result.ok)
                    throw new Error(result.code + ': ' + result.message);
                return portfolioReport(result.snapshot);
            },
        }),
        defineTool({
            name: 'daily_plugin_remove',
            description: 'Remove a plugin from the portfolio register. This is the RECORD only: it never touches the plugin, its source directory, its repository or the installed files. Use it to correct a mistaken entry.',
            parameters: {
                pluginId: { type: 'string', description: 'Exact plugin id from daily_plugins. Use this or `plugin`, not both.' },
                plugin: { type: 'string', description: 'A unique case-insensitive substring of the package name.' },
            },
            output: PORTFOLIO_OUT,
            execute: async (args) => {
                const result = await planner.apply('removePlugin', today(), '', args);
                if (!result.ok)
                    throw new Error(result.code + ': ' + result.message);
                return portfolioReport(result.snapshot);
            },
        }),
        defineTool({
            name: 'daily_sparks',
            description: 'Read the spark board: business ideas sparked by feedback from live projects, with the clock on how long they have waited. Open sparks are decisions not yet taken; dismissed ones carry the reason they were rejected, so a dead end stays dead. Check this before proposing any new venture, so an idea already logged — or already rejected — is not re-derived.',
            parameters: {},
            output: { schema: sparkOutputSchema, render: (_args, value) => [{ type: 'text', text: renderSparks(value) }] },
            execute: async () => sparksView(await planner.snapshot(today(), '')),
        }),
        defineTool({
            name: 'daily_spark',
            description: 'Capture ONE business idea sparked by what a live project is teaching us. Attribute it to the project whose feedback produced it: the source is frozen on the record, so the idea still says where it came from after that venture is gone. An idea with no source is allowed; capture is deliberately one line, so use it the moment the thought lands.',
            parameters: {
                text: { type: 'string', required: true, description: 'The idea, in one line.' },
                ...PROJECT_REF_PARAMS,
                date: { type: 'string', description: 'The check-in date it came from (YYYY-MM-DD). Defaults to none.' },
            },
            output: { schema: sparkOutputSchema, render: (_args, value) => [{ type: 'text', text: renderSparks(value) }] },
            execute: async (args) => {
                const result = await planner.apply('sparkAdd', today(), '', args);
                if (!result.ok)
                    throw new Error(result.code + ': ' + result.message);
                return sparksView(result.snapshot);
            },
        }),
        defineTool({
            name: 'daily_spark_promote',
            description: 'Promote a spark into a pending project. It is created as status `idea` with NO estimates, so it starts UNRANKED — the honest state for an idea that is not priced yet — and it lands in the Pending column to be estimated and ranked like anything else. The link is recorded on the spark, so the project does not carry a second copy of its own provenance.',
            parameters: {
                sparkId: { type: 'string', required: true, description: 'Spark id from daily_sparks.' },
                name: { type: 'string', description: 'Project name. Defaults to the spark text.' },
                fulfills: { type: 'string', description: 'Who the project serves. Defaults to a line naming the feedback it came from.' },
            },
            output: { schema: sparkOutputSchema, render: (_args, value) => [{ type: 'text', text: renderSparks(value) }] },
            execute: async (args) => {
                const result = await planner.apply('sparkPromote', today(), '', args);
                if (!result.ok)
                    throw new Error(result.code + ': ' + result.message);
                return sparksView(result.snapshot);
            },
        }),
        defineTool({
            name: 'daily_spark_dismiss',
            description: 'Dismiss a spark: close it without starting it. A reason is REQUIRED, because a dismissal burns the option and the reason is the only thing that stops the same idea being re-derived and assessed again later. Dismissed sparks are kept and stay readable in daily_sparks.',
            parameters: {
                sparkId: { type: 'string', required: true, description: 'Spark id from daily_sparks.' },
                reason: { type: 'string', required: true, description: 'Why this idea is being rejected. Recorded on the spark.' },
            },
            output: { schema: sparkOutputSchema, render: (_args, value) => [{ type: 'text', text: renderSparks(value) }] },
            execute: async (args) => {
                const result = await planner.apply('sparkDismiss', today(), '', args);
                if (!result.ok)
                    throw new Error(result.code + ': ' + result.message);
                return sparksView(result.snapshot);
            },
        }),
    ];
}
/**
 * Register the tools on `ctx.tools`, optional-dependency style: a profile with
 * no tool registry simply gets no tools instead of a failed boot.
 */
export function registerTools(ctx, deps) {
    ctx.inject(['tools'], (toolCtx) => {
        for (const tool of buildTools(deps))
            toolCtx.tools.register(tool);
    });
}
