/**
 * Domain logic, independent of transport. Both the HTTP routes and the agent
 * tools are thin adapters over this module, so the two can never drift.
 *
 * Concurrency: ONE write chain serializes every read-modify-write in the
 * process. A per-date chain would be enough for single-day ops, but `moveItem`
 * touches two dates, and a single chain removes that whole class of
 * interleaving at no cost for a single-user planner. Upstream hand-rolled
 * get→put with no serialization at all: eight concurrent adds persisted one.
 *
 * Records are immutable — every mutation builds NEW DayPlan/PlanItem objects.
 * @module dsh-daily-progress-tab/planner
 */
import { randomUUID } from 'node:crypto';
import { addDays, computeStreak, rollover, weekCells, weekRate } from "./metrics.js";
import { DATE_RE, DEFAULT_SCOPE, isValidDateKey, recordKey } from "./calendar.js";
import { CHECKIN_VERDICTS, MAX_CHECKIN_ITEMS, MAX_SUGGESTIONS } from "./domain.js";
import { MAX_CHECKIN_TEXT, MAX_NAME, MAX_SPARKS, MAX_SUMMARY, normalizeProject, rankProjects, sparkBoard } from "./projects.js";
import { MAX_PLUGIN_REF, NO_PUBLISH_SETTINGS, PLUGIN_ORIGINS, PLUGIN_STATUSES, PLUGIN_VISIBILITIES, portfolioView } from "./portfolio.js";
export const MAX_ITEMS = 50;
export const MAX_TEXT = 500;
export const MAX_TZ = 64;
/**
 * How far the pickable pool reaches on either side of today. Bounded because the
 * pool is rendered as a flat list: an unbounded scan would let one stale store
 * turn the page into a wall of rows.
 */
export const POOL_BACK_DAYS = 14;
export const POOL_AHEAD_DAYS = 14;
/** Hard cap on pooled rows, whatever the window holds. */
export const MAX_POOL = 60;
/** Candidate tasks one project may hold. */
export const MAX_BACKLOG = 100;
const err = (code, message) => ({ ok: false, code, message });
/** A bounded, non-empty zone label; recorded for display only. */
export function normalizeTz(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TZ ? value : 'UTC';
}
export function normalizeText(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT)
        return null;
    return trimmed;
}
/** A short single-line preview of a value, for naming the offending item in an error. */
function errorPreview(value) {
    if (typeof value !== 'string')
        return typeof value;
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length > 40 ? JSON.stringify(flat.slice(0, 40) + '...') : JSON.stringify(flat);
}
/**
 * Validate a batch of new tasks and build their records, WITHOUT writing
 * anything.
 *
 * Exported so a caller adding to more than one day can reject every group
 * before the first write lands. Validating inside the write loop is exactly how
 * a half-written batch shipped: seven tasks were requested, the sixth had an
 * over-long summary, and five were already stored by the time the error
 * surfaced (2026-10-01, bug-census A14). One write per call plus this check up
 * front makes that impossible rather than merely unlikely.
 */
export function buildNewItems(rawItems, existingCount, origin) {
    if (!Array.isArray(rawItems))
        return err('invalid_payload', 'items must be an array');
    if (rawItems.length === 0)
        return err('invalid_payload', 'items must contain at least one task');
    if (existingCount + rawItems.length > MAX_ITEMS) {
        return err('too_many_items', 'at most ' + MAX_ITEMS + ' items per day - that day holds ' + existingCount +
            ' and this call would add ' + rawItems.length);
    }
    const items = [];
    for (const [index, entry] of rawItems.entries()) {
        // Every message names which task is at fault. A bare "summary must be 1-500
        // chars" for a seven-task call forced the caller to guess.
        const at = 'task ' + (index + 1) + ' of ' + rawItems.length;
        if (typeof entry !== 'object' || entry === null) {
            return err('invalid_payload', at + ' must be an object');
        }
        const raw = entry;
        const text = normalizeText(raw.text);
        if (text === null) {
            return err('empty_text', at + ' (' + errorPreview(raw.text) + '): text must be 1-' + MAX_TEXT + ' chars');
        }
        const item = { id: randomUUID(), text, done: false, doneAt: null, origin };
        if (raw.summary !== undefined && raw.summary !== null && raw.summary !== '') {
            const summary = normalizeText(raw.summary);
            if (summary === null) {
                const got = typeof raw.summary === 'string' ? raw.summary.trim().length + ' chars' : typeof raw.summary;
                return err('invalid_payload', at + ' (' + errorPreview(text) + '): summary must be 1-' + MAX_TEXT + ' chars, got ' + got);
            }
            item.summary = summary;
        }
        items.push(item);
    }
    return { ok: true, items };
}
export function createPlanner(domainPromise, 
// The deployment's publish values, threaded to the register on every read. Two
// optional strings, not a new service: the register is pure, and config is the
// only thing that differs between two runs of the same build.
publish = NO_PUBLISH_SETTINGS) {
    let tablePromise = null;
    const table = () => {
        tablePromise ??= domainPromise.then((domain) => domain.table('plans'));
        return tablePromise;
    };
    // The single process-wide write chain.
    let chain = Promise.resolve();
    function serialize(task) {
        const next = chain.then(task, task);
        chain = next.then(() => undefined, () => undefined);
        return next;
    }
    const lookup = async (date) => (await table()).get(recordKey(DEFAULT_SCOPE, date)) ?? null;
    const store = async (plan) => (await table()).put(recordKey(DEFAULT_SCOPE, plan.date), plan);
    // ---- projects + the selection singleton ----------------------------------
    let projectsPromise = null;
    const projectsTable = () => (projectsPromise ??= domainPromise.then((domain) => domain.table('projects')));
    const listProjects = async () => [...(await projectsTable()).entries()].map(([, project]) => project);
    const saveProject = async (project) => {
        await (await projectsTable()).put(project.id, project);
    };
    // ---- check-ins: the feedback loop for shipped projects --------------------
    let checkinsPromise = null;
    const checkinsTable = () => (checkinsPromise ??= domainPromise.then((domain) => domain.table('checkins')));
    /** One record per (project, date): re-running a check-in updates that day. */
    const checkinKey = (projectId, when) => projectId + ':' + when;
    const listCheckins = async () => [...(await checkinsTable()).entries()].map(([, entry]) => entry);
    const projectCheckins = async (projectId) => (await listCheckins())
        .filter((entry) => entry.projectId === projectId)
        .sort((a, b) => a.date.localeCompare(b.date));
    const readCheckin = async (projectId, when) => (await checkinsTable()).get(checkinKey(projectId, when)) ?? null;
    const saveCheckin = async (entry) => {
        await (await checkinsTable()).put(checkinKey(entry.projectId, entry.date), entry);
    };
    // ---- plugins: the portfolio register -------------------------------------
    // Not a cache of what is installed: it is the record of what was AUTHORED,
    // with the provenance and the licence, because those are the facts a publish
    // decision rests on and neither is discoverable from the filesystem.
    let pluginsPromise = null;
    const pluginsTable = () => (pluginsPromise ??= domainPromise.then((domain) => domain.table('plugins')));
    const listPlugins = async () => [...(await pluginsTable()).entries()].map(([, plugin]) => plugin);
    const readPlugin = async (id) => {
        if (typeof id !== 'string' || id.length === 0)
            return null;
        return (await pluginsTable()).get(id) ?? null;
    };
    const savePlugin = async (plugin) => {
        await (await pluginsTable()).put(plugin.id, plugin);
    };
    /**
     * Resolve a plugin by id, or by a unique case-insensitive substring of its
     * NAME. The matcher is `plugin`, never `name`: `name` is the value field, and
     * letting one field be both is the A4 trap that silently broke editItemText.
     */
    function resolvePlugin(all, payload) {
        const id = payload.pluginId;
        if (typeof id === 'string' && id.length > 0) {
            const found = all.find((plugin) => plugin.id === id);
            return found ?? err('plugin_not_found', 'no plugin with id ' + id);
        }
        const match = payload.plugin;
        if (typeof match === 'string' && match.trim().length > 0) {
            const needle = match.trim().toLowerCase();
            const hits = all.filter((plugin) => plugin.name.toLowerCase().includes(needle));
            if (hits.length === 0)
                return err('plugin_not_found', 'no plugin matching ' + JSON.stringify(match));
            if (hits.length > 1) {
                return err('invalid_payload', 'ambiguous: ' + hits.length + ' plugins match ' + JSON.stringify(match)
                    + ' — ' + hits.map((plugin) => plugin.name).join(', '));
            }
            return hits[0];
        }
        return err('invalid_payload', 'pluginId or plugin required');
    }
    /**
     * Patch a text field: `undefined` leaves it, `null` clears it, a string sets
     * it. Collapsing the first two is what silently wiped fields in updateItem, so
     * the distinction is made once, here, and every field uses it.
     */
    const pickText = (value, prior, max) => {
        if (value === undefined)
            return prior;
        if (value === null)
            return undefined;
        if (typeof value !== 'string')
            return prior;
        const trimmed = value.trim();
        return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
    };
    const pickBool = (value, prior) => (typeof value === 'boolean' ? value : prior);
    const pickEnum = (value, prior, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : prior);
    /**
     * The optional half of a plugin record, defined ONCE: `addPlugin` passes no
     * prior and `updatePlugin` passes the stored record, so a field cannot be
     * added to one and forgotten in the other. `pickText` gives `undefined` =
     * "leave as it was" and `null` = "clear it", the distinction that silently
     * wiped fields in updateItem when it was collapsed.
     */
    const pluginFields = (prior, payload) => ({
        title: pickText(payload.title, prior?.title, MAX_NAME),
        summary: pickText(payload.summary, prior?.summary, MAX_SUMMARY),
        upstream: pickText(payload.upstream, prior?.upstream, MAX_PLUGIN_REF),
        licence: pickText(payload.licence, prior?.licence, 64),
        sourcePath: pickText(payload.sourcePath, prior?.sourcePath, MAX_PLUGIN_REF),
        publicUrl: pickText(payload.publicUrl, prior?.publicUrl, MAX_PLUGIN_REF),
        publishedAt: pickText(payload.publishedAt, prior?.publishedAt, 32),
        leakScanAt: pickText(payload.leakScanAt, prior?.leakScanAt, 32),
        preflightAt: pickText(payload.preflightAt, prior?.preflightAt, 32),
        preflightNote: pickText(payload.preflightNote, prior?.preflightNote, MAX_SUMMARY),
        verifiedAt: pickText(payload.verifiedAt, prior?.verifiedAt, 32),
        notes: pickText(payload.notes, prior?.notes, MAX_SUMMARY),
        installed: pickBool(payload.installed, prior?.installed),
        hasLicenseFile: pickBool(payload.hasLicenseFile, prior?.hasLicenseFile),
        hasReadme: pickBool(payload.hasReadme, prior?.hasReadme),
        hasScreenshot: pickBool(payload.hasScreenshot, prior?.hasScreenshot),
        sourceOutsideProfile: pickBool(payload.sourceOutsideProfile, prior?.sourceOutsideProfile),
        leakScanPassed: pickBool(payload.leakScanPassed, prior?.leakScanPassed),
        preflightPassed: pickBool(payload.preflightPassed, prior?.preflightPassed),
        gitReady: pickBool(payload.gitReady, prior?.gitReady),
    });
    // ---- sparks: business ideas sparked by live feedback ----------------------
    // Keyed by the spark's own id, never by project: see types.Spark for why a
    // spark has to outlive the venture whose feedback produced it.
    let sparksPromise = null;
    const sparksTable = () => (sparksPromise ??= domainPromise.then((domain) => domain.table('sparks')));
    const listSparks = async () => [...(await sparksTable()).entries()].map(([, spark]) => spark);
    const readSpark = async (id) => {
        if (typeof id !== 'string' || id.length === 0)
            return null;
        return (await sparksTable()).get(id) ?? null;
    };
    const saveSpark = async (spark) => {
        await (await sparksTable()).put(spark.id, spark);
    };
    const deleteSpark = async (id) => {
        await (await sparksTable()).delete(id);
    };
    /** Build a spark from a one-line idea and its optional source. */
    const makeSpark = (text, source, when, nowIso) => ({
        id: randomUUID(),
        text,
        sourceProjectId: source === null ? null : source.id,
        // Frozen at capture: after a deletion there is nothing left to look this up
        // from, and "sparked by —" is a worse record than a stale name.
        sourceProjectName: source === null ? null : source.name,
        sourceDate: when,
        status: 'open',
        promotedProjectId: null,
        dismissedReason: null,
        createdAt: nowIso,
        updatedAt: nowIso,
    });
    /**
     * Reconcile the sparks a check-in declares against the ones already on record.
     *
     * Only OPEN sparks are the check-in's to replace. A promoted or dismissed spark
     * is a decision already taken: re-running the check-in that produced it must not
     * resurrect a dismissed idea, nor un-promote one. Matching is by exact text, so
     * a spark still listed keeps its id — and a decision taken between two reads
     * stays attached to the right record.
     */
    async function reconcileSparks(project, when, raw, nowIso) {
        if (!Array.isArray(raw))
            return;
        const wanted = [];
        for (const entry of raw.slice(0, MAX_SPARKS)) {
            const label = typeof entry === 'string' ? entry.trim().slice(0, MAX_CHECKIN_TEXT) : '';
            if (label.length > 0 && !wanted.includes(label))
                wanted.push(label);
        }
        const mine = (await listSparks())
            .filter((spark) => spark.sourceProjectId === project.id && spark.sourceDate === when);
        for (const spark of mine) {
            if (spark.status === 'open' && !wanted.includes(spark.text))
                await deleteSpark(spark.id);
        }
        for (const label of wanted) {
            // `mine` covers decided sparks too, so an idea that was already dismissed
            // is not re-added every time the check-in is re-stated.
            if (mine.some((spark) => spark.text === label))
                continue;
            await saveSpark(makeSpark(label, project, when, nowIso));
        }
    }
    // ---- backlog: the undated candidate tasks the operator chooses from --------
    let backlogPromise = null;
    const backlogTable = () => (backlogPromise ??= domainPromise.then((domain) => domain.table('backlog')));
    /**
     * Oldest first, so a project's backlog reads as a queue rather than a heap.
     * Ties break on id so the order is stable across reads and a re-render cannot
     * shuffle two tasks added in the same millisecond.
     */
    const listBacklog = async () => [...(await backlogTable()).entries()]
        .map(([, entry]) => entry)
        .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
    const readBacklogItem = async (id) => (await backlogTable()).get(id) ?? null;
    const saveBacklogItem = async (entry) => {
        await (await backlogTable()).put(entry.id, entry);
    };
    const deleteBacklogItem = async (id) => {
        await (await backlogTable()).delete(id);
    };
    const globalState = async () => (await domainPromise).global.get();
    const patchGlobal = async (patch) => {
        const current = await globalState();
        await (await domainPromise).global.set({ ...current, ...patch, updatedAt: new Date().toISOString() });
    };
    /** Which project is being executed. */
    const selection = async () => (await globalState()).selectedProjectId;
    const select = async (id) => patchGlobal({ selectedProjectId: id });
    /** Which task is being worked on: an id plus the day it was on when picked. */
    const nowSelection = async () => {
        const state = await globalState();
        return { id: state.selectedItemId ?? null, date: state.selectedItemDate ?? null };
    };
    /**
     * Lazy, idempotent cross-day rollover: when today has no record yet and
     * yesterday has undone items, materialize today's plan with them carried
     * over. An existing record — even an empty one from clearToday — is never
     * touched again, which is what makes re-rollover impossible.
     *
     * The write is awaited and its failure contained. Upstream fired it with
     * `void` and no catch, so a backend failure raised an unhandled rejection
     * (fatal by default in Node) while the request still reported success.
     */
    async function ensureToday(date, tz) {
        const existing = await lookup(date);
        if (existing !== null)
            return existing;
        const created = rollover(await lookup(addDays(date, -1)), null, date, tz, new Date().toISOString());
        if (created.plan !== null) {
            try {
                await store(created.plan);
            }
            catch {
                // A failed carry-over must not fail the read; the next request retries.
            }
            return created.plan;
        }
        return { date, tz, items: [], updatedAt: new Date().toISOString() };
    }
    /**
     * Metrics need MANY dates (a streak walks up to a year back) and are pure
     * synchronous folds. The domain's `get` is itself synchronous over its
     * in-memory state, so metrics read straight through it after the table handle
     * resolves — no per-date preloading.
     */
    let liveTable = null;
    function syncLookup(date) {
        return liveTable === null ? null : liveTable.get(recordKey(DEFAULT_SCOPE, date)) ?? null;
    }
    /**
     * Every undone task that is not on today, so nothing is invisible just because
     * it happens to sit on another day.
     *
     * Overdue comes first — a past task is still asking for attention — and within
     * it the MOST RECENT day leads, because a task missed yesterday is likelier to
     * still matter than one missed a fortnight ago. Upcoming follows in date order,
     * so tomorrow leads that group.
     *
     * `done` items are excluded: the pool is a menu of work, not a history. The
     * week heatmap already carries the history.
     */
    function buildPool(date) {
        const overdue = [];
        for (let back = 1; back <= POOL_BACK_DAYS; back += 1) {
            const when = addDays(date, -back);
            for (const item of syncLookup(when)?.items ?? []) {
                if (!item.done)
                    overdue.push({ date: when, bucket: 'overdue', item });
            }
        }
        const upcoming = [];
        for (let ahead = 1; ahead <= POOL_AHEAD_DAYS; ahead += 1) {
            const when = addDays(date, ahead);
            for (const item of syncLookup(when)?.items ?? []) {
                if (!item.done)
                    upcoming.push({ date: when, bucket: 'upcoming', item });
            }
        }
        return [...overdue, ...upcoming].slice(0, MAX_POOL);
    }
    /**
     * Resolve the picked task, and self-heal a stale pick.
     *
     * The stored date is only a hint. The task may have been moved to another day
     * since it was picked — or deleted, or completed — so the id is re-resolved:
     * hint day → today → the whole pool window. Anything not found is reported as
     * no pick at all, which is why "work on this" can never point at a task that
     * no longer exists.
     */
    function resolveNow(date, hint, pool) {
        const id = hint.id;
        if (id === null)
            return null;
        const at = (when) => {
            const item = syncLookup(when)?.items.find((candidate) => candidate.id === id);
            return item === undefined ? null : { date: when, item };
        };
        if (hint.date !== null && isValidDateKey(hint.date)) {
            const found = at(hint.date);
            if (found !== null)
                return found;
        }
        const today = at(date);
        if (today !== null)
            return today;
        for (const entry of pool) {
            if (entry.item.id === id)
                return { date: entry.date, item: entry.item };
        }
        return null;
    }
    async function buildSnapshot(date, tz) {
        await ensureToday(date, tz);
        liveTable = await table();
        const pool = buildPool(date);
        return {
            today: syncLookup(date),
            tomorrow: syncLookup(addDays(date, 1)),
            week: weekCells(syncLookup, date),
            streak: computeStreak(syncLookup, date),
            weekRate: weekRate(syncLookup, date),
            // Ranked on every read, so the order can never drift from the inputs.
            projects: rankProjects(await listProjects(), await listCheckins(), date, await listSparks()),
            selectedProjectId: await selection(),
            now: resolveNow(date, await nowSelection(), pool),
            pool,
            backlog: await listBacklog(),
            sparks: sparkBoard(await listSparks(), date),
            portfolio: portfolioView(await listPlugins(), date, publish),
        };
    }
    /** Resolve one item by explicit id, or by a unique case-insensitive substring. */
    function resolveItem(plan, payload) {
        const id = payload.itemId;
        if (typeof id === 'string' && id.length > 0) {
            const found = plan.items.find((item) => item.id === id);
            return found ?? err('item_not_found', 'no item with id ' + id);
        }
        // The matcher is `match`, never `text`: `text` always means a text VALUE
        // (the new task text), so letting it double as the matcher made editItemText
        // read the same field for both and silently no-op.
        const match = payload.match;
        if (typeof match === 'string' && match.trim().length > 0) {
            const needle = match.trim().toLowerCase();
            const hits = plan.items.filter((item) => item.text.toLowerCase().includes(needle));
            if (hits.length === 0)
                return err('item_not_found', 'no item matching ' + JSON.stringify(match));
            if (hits.length > 1) {
                return err('invalid_payload', 'ambiguous: ' + hits.length + ' items match ' + JSON.stringify(match)
                    + ' — ' + hits.map((item) => JSON.stringify(item.text)).join(', '));
            }
            return hits[0];
        }
        return err('invalid_payload', 'itemId or match required');
    }
    /**
     * Resolve a project by explicit id, or by a unique case-insensitive substring
     * of its NAME. The matcher field is `project`, never `name`: `name` is the
     * value, and letting one field serve both is what silently broke
     * editItemText earlier.
     */
    function resolveProject(projects, payload) {
        const key = payload.projectId;
        if (typeof key === 'string' && key.length > 0) {
            return projects.find((project) => project.id === key) ?? err('project_not_found', 'no project with id ' + key);
        }
        const needleRaw = payload.project;
        if (typeof needleRaw === 'string' && needleRaw.trim().length > 0) {
            const needle = needleRaw.trim().toLowerCase();
            const hits = projects.filter((project) => project.name.toLowerCase().includes(needle));
            if (hits.length === 0)
                return err('project_not_found', 'no project matching ' + JSON.stringify(needleRaw));
            if (hits.length > 1) {
                return err('invalid_payload', 'ambiguous: ' + hits.length + ' projects match ' + JSON.stringify(needleRaw)
                    + ' — ' + hits.map((project) => JSON.stringify(project.name)).join(', '));
            }
            return hits[0];
        }
        return err('invalid_payload', 'projectId or project required');
    }
    const isFailed = (value) => typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
    /** Normalize one incoming suggestion, assigning an id and validating the action payload. */
    function normalizeSuggestion(raw) {
        if (typeof raw !== 'object' || raw === null)
            return err('invalid_payload', 'each suggestion must be an object');
        const s = raw;
        const label = normalizeText(s.label);
        if (label === null || label.length > 60)
            return err('invalid_payload', 'suggestion label must be 1-60 chars');
        const action = s.action;
        if (action !== 'info' && action !== 'complete' && action !== 'defer'
            && action !== 'split' && action !== 'retitle' && action !== 'drop') {
            return err('invalid_payload', 'suggestion action must be one of info|complete|defer|split|retitle|drop');
        }
        const out = {
            id: typeof s.id === 'string' && s.id.length > 0 && s.id.length <= 64 ? s.id : randomUUID(),
            label,
            action,
        };
        if (typeof s.detail === 'string' && s.detail.trim().length > 0)
            out.detail = s.detail.trim().slice(0, 500);
        if (action === 'defer') {
            const date = s.date;
            if (typeof date !== 'string')
                return err('invalid_payload', 'a defer suggestion needs date (YYYY-MM-DD or "tomorrow")');
            if (date !== 'tomorrow' && !isValidDateKey(date)) {
                return err('invalid_payload', 'defer date must be YYYY-MM-DD or "tomorrow"');
            }
            out.date = date;
        }
        if (action === 'split') {
            const items = s.items;
            if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
                return err('invalid_payload', 'a split suggestion needs 1-20 items');
            }
            const texts = [];
            for (const entry of items) {
                const text = normalizeText(entry);
                if (text === null)
                    return err('invalid_payload', 'every split item needs 1-500 char text');
                texts.push(text);
            }
            out.items = texts;
        }
        if (action === 'retitle') {
            const text = normalizeText(s.text);
            if (text === null)
                return err('invalid_payload', 'a retitle suggestion needs text (1-500 chars)');
            out.text = text;
        }
        return out;
    }
    async function apply(op, date, tz, payload) {
        return serialize(async () => {
            const tomorrowKey = addDays(date, 1);
            const nowIso = new Date().toISOString();
            await ensureToday(date, tz);
            const current = (d) => cachedPlan(d) ?? { date: d, tz, items: [], updatedAt: nowIso };
            const cachedPlan = (d) => syncLookup(d);
            const touch = (plan, items) => ({ ...plan, items, updatedAt: nowIso });
            const done = async () => ({ ok: true, snapshot: await buildSnapshot(date, tz) });
            const targetDate = () => (payload.target === 'tomorrow' ? tomorrowKey : date);
            /**
             * Which day holds the item being addressed. `target` (today|tomorrow) is
             * the original two-column vocabulary; `fromDate` names ANY day, which is
             * what the pool needs — a task offered there sits on a day the target
             * vocabulary cannot express. An explicit target is still honoured, so
             * every existing caller behaves exactly as before.
             */
            const sourceDate = () => {
                const raw = payload.fromDate;
                if (raw === undefined || raw === null || raw === '')
                    return targetDate();
                if (typeof raw !== 'string' || !isValidDateKey(raw)) {
                    return err('invalid_local_date', 'fromDate must be a valid YYYY-MM-DD');
                }
                return raw;
            };
            /** Point the pick at a task, or clear it. Both fields move together. */
            const pickNow = async (id, when) => patchGlobal({ selectedItemId: id, selectedItemDate: when });
            /** Resolve a backlog candidate by explicit id, or a unique text match. */
            const resolveBacklogItem = async () => {
                const id = payload.backlogItemId;
                if (typeof id === 'string' && id.length > 0) {
                    const found = await readBacklogItem(id);
                    return found ?? err('item_not_found', 'no backlog task with id ' + id);
                }
                const match = payload.match;
                if (typeof match === 'string' && match.trim().length > 0) {
                    let scoped = await listBacklog();
                    if (typeof payload.project === 'string' || typeof payload.projectId === 'string') {
                        const project = resolveProject(await listProjects(), payload);
                        if (isFailed(project))
                            return project;
                        scoped = scoped.filter((entry) => entry.projectId === project.id);
                    }
                    const needle = match.trim().toLowerCase();
                    const hits = scoped.filter((entry) => entry.text.toLowerCase().includes(needle));
                    if (hits.length === 0)
                        return err('item_not_found', 'no backlog task matching ' + JSON.stringify(match));
                    if (hits.length > 1) {
                        return err('invalid_payload', 'ambiguous: ' + hits.length + ' backlog tasks match ' + JSON.stringify(match)
                            + ' — ' + hits.map((entry) => JSON.stringify(entry.text)).join(', '));
                    }
                    return hits[0];
                }
                return err('invalid_payload', 'backlogItemId or match required');
            };
            liveTable = await table();
            switch (op) {
                case 'toggleItem': {
                    const d = sourceDate();
                    if (isFailed(d))
                        return d;
                    const plan = current(d);
                    const found = resolveItem(plan, payload);
                    if (isFailed(found))
                        return found;
                    const nextDone = typeof payload.done === 'boolean' ? payload.done : !found.done;
                    const items = plan.items.map((item) => item.id === found.id
                        ? { ...item, done: nextDone, doneAt: nextDone ? nowIso : null }
                        : item);
                    await store(touch(plan, items));
                    // Finishing the task you were on clears the pick: a done task cannot be
                    // what you are working on. Ticking something else changes nothing.
                    if (nextDone && (await nowSelection()).id === found.id)
                        await pickNow(null, null);
                    return done();
                }
                case 'addItem': {
                    const d = targetDate();
                    const plan = current(d);
                    const text = normalizeText(payload.text);
                    if (text === null)
                        return err('empty_text', 'text must be 1-500 chars');
                    if (plan.items.length >= MAX_ITEMS)
                        return err('too_many_items', 'at most ' + MAX_ITEMS + ' items per day');
                    const item = {
                        id: randomUUID(),
                        text,
                        done: false,
                        doneAt: null,
                        origin: d === tomorrowKey ? 'tomorrow-write' : 'today',
                    };
                    // Optional summary box and project link, so one call can schedule a
                    // task that is already described and attributed.
                    if (payload.summary !== undefined && payload.summary !== null && payload.summary !== '') {
                        const summary = normalizeText(payload.summary);
                        if (summary === null)
                            return err('invalid_payload', 'summary must be 1-500 chars');
                        item.summary = summary;
                    }
                    if (typeof payload.projectId === 'string' && payload.projectId.length > 0) {
                        if (!(await listProjects()).some((project) => project.id === payload.projectId)) {
                            return err('project_not_found', 'no project with id ' + payload.projectId);
                        }
                        item.projectId = payload.projectId;
                    }
                    await store(touch(plan, [...plan.items, item]));
                    return done();
                }
                case 'addItems': {
                    const d = targetDate();
                    const plan = current(d);
                    // Validate the WHOLE batch before the single write below: this op
                    // exists so that one bad task cannot leave the good ones stored.
                    const built = buildNewItems(payload.items, plan.items.length, d === tomorrowKey ? 'tomorrow-write' : 'today');
                    if (!built.ok)
                        return built;
                    let projectId;
                    if (payload.projectId !== undefined && payload.projectId !== null && payload.projectId !== '') {
                        if (typeof payload.projectId !== 'string' ||
                            !(await listProjects()).some((project) => project.id === payload.projectId)) {
                            return err('project_not_found', 'no project with id ' + String(payload.projectId));
                        }
                        projectId = payload.projectId;
                    }
                    const items = projectId === undefined
                        ? built.items
                        : built.items.map((item) => ({ ...item, projectId }));
                    await store(touch(plan, [...plan.items, ...items]));
                    return done();
                }
                case 'removeItem': {
                    const d = sourceDate();
                    if (isFailed(d))
                        return d;
                    const plan = current(d);
                    const found = resolveItem(plan, payload);
                    if (isFailed(found))
                        return found;
                    await store(touch(plan, plan.items.filter((item) => item.id !== found.id)));
                    // A deleted task cannot stay the one you are working on.
                    if ((await nowSelection()).id === found.id)
                        await pickNow(null, null);
                    return done();
                }
                case 'editItemText': {
                    const d = sourceDate();
                    if (isFailed(d))
                        return d;
                    const plan = current(d);
                    const found = resolveItem(plan, payload);
                    if (isFailed(found))
                        return found;
                    const text = normalizeText(payload.text ?? payload.newText);
                    if (text === null)
                        return err('empty_text', 'text must be 1-500 chars');
                    await store(touch(plan, plan.items.map((item) => (item.id === found.id ? { ...item, text } : item))));
                    return done();
                }
                case 'setTomorrow': {
                    const rawItems = payload.items;
                    if (!Array.isArray(rawItems) || rawItems.length > MAX_ITEMS) {
                        return err('invalid_payload', 'items must be an array of at most ' + MAX_ITEMS);
                    }
                    const items = [];
                    const seen = new Set();
                    for (const entry of rawItems) {
                        if (typeof entry !== 'object' || entry === null)
                            return err('invalid_payload', 'every entry must be an object');
                        const { id, text } = entry;
                        const normalized = normalizeText(text);
                        if (normalized === null)
                            return err('empty_text', 'every item needs 1-500 char text');
                        // Upstream accepted duplicate ids and toggleItem maps over every
                        // match, so one click flipped several items.
                        let itemId = typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : randomUUID();
                        if (seen.has(itemId))
                            itemId = randomUUID();
                        seen.add(itemId);
                        items.push({ id: itemId, text: normalized, done: false, doneAt: null, origin: 'tomorrow-write' });
                    }
                    await store(touch(current(tomorrowKey), items));
                    return done();
                }
                case 'clearToday': {
                    await store(touch(current(date), []));
                    return done();
                }
                case 'moveItem': {
                    const d = sourceDate();
                    if (isFailed(d))
                        return d;
                    const from = current(d);
                    const found = resolveItem(from, payload);
                    if (isFailed(found))
                        return found;
                    const rawTo = payload.toDate ?? payload.date;
                    if (typeof rawTo !== 'string' || !isValidDateKey(rawTo)) {
                        return err('invalid_local_date', 'toDate must be a valid YYYY-MM-DD');
                    }
                    if (rawTo === from.date)
                        return err('invalid_payload', 'toDate equals the current date');
                    const to = current(rawTo);
                    if (to.items.length >= MAX_ITEMS)
                        return err('too_many_items', 'target day already holds ' + MAX_ITEMS + ' items');
                    const moved = { ...found, origin: 'carried' };
                    await store(touch(from, from.items.filter((item) => item.id !== found.id)));
                    await store(touch(to, [...to.items, moved]));
                    // The stored pick carries the day it was on. Move that task and the
                    // hint would dangle — resolved only by the fallback scan. Repairing it
                    // here keeps the common path a single lookup.
                    const pick = await nowSelection();
                    if (pick.id === found.id)
                        await patchGlobal({ selectedItemDate: rawTo });
                    // Move AND pick in one call: dragging something onto today is usually
                    // also choosing to work on it, and two round trips can half-fail.
                    if (payload.select === true)
                        await pickNow(moved.id, rawTo);
                    return done();
                }
                /**
                 * Swap one item with its neighbour. Reordering is the smallest way to
                 * say "this first": the list already renders in array order, so the
                 * order of the array IS the priority and nothing else has to store it.
                 */
                case 'reorderItem': {
                    const d = targetDate();
                    const plan = current(d);
                    const found = resolveItem(plan, payload);
                    if (isFailed(found))
                        return found;
                    const direction = payload.direction;
                    if (direction !== 'up' && direction !== 'down') {
                        return err('invalid_payload', 'direction must be "up" or "down"');
                    }
                    const from = plan.items.findIndex((item) => item.id === found.id);
                    const to = direction === 'up' ? from - 1 : from + 1;
                    // Already at the end of the list: a no-op, not an error. A button that
                    // reports failure because you clicked it once too often is a bug.
                    if (to < 0 || to >= plan.items.length)
                        return done();
                    const items = [...plan.items];
                    const [lifted] = items.splice(from, 1);
                    items.splice(to, 0, lifted);
                    await store(touch(plan, items));
                    return done();
                }
                /** Choose — or clear — the single task being worked on now. */
                case 'selectItem': {
                    const rawId = payload.itemId;
                    if (rawId === null) {
                        await pickNow(null, null);
                        return done();
                    }
                    if (typeof rawId !== 'string' || rawId.length === 0) {
                        return err('invalid_payload', 'itemId must be a non-empty string, or null to clear the pick');
                    }
                    const hintDate = typeof payload.date === 'string' && isValidDateKey(payload.date) ? payload.date : null;
                    const found = resolveNow(date, { id: rawId, date: hintDate }, buildPool(date));
                    if (found === null) {
                        return err('item_not_found', 'no task with id ' + rawId + ' within ' + POOL_BACK_DAYS
                            + ' days back or ' + POOL_AHEAD_DAYS + ' days ahead of ' + date);
                    }
                    // A finished task is not work in progress. Refusing loudly beats
                    // silently showing a struck-through task as the thing you are on.
                    if (found.item.done) {
                        return err('invalid_payload', 'that task is already done — reopen it before working on it');
                    }
                    await pickNow(found.item.id, found.date);
                    return done();
                }
                case 'splitItem': {
                    const d = targetDate();
                    const plan = current(d);
                    const found = resolveItem(plan, payload);
                    if (isFailed(found))
                        return found;
                    const rawItems = payload.items;
                    if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 20) {
                        return err('invalid_payload', 'split needs 1-20 items');
                    }
                    const parts = [];
                    for (const entry of rawItems) {
                        const text = normalizeText(entry);
                        if (text === null)
                            return err('empty_text', 'every split item needs 1-500 char text');
                        parts.push({ id: randomUUID(), text, done: false, doneAt: null, origin: found.origin });
                    }
                    if (plan.items.length - 1 + parts.length > MAX_ITEMS) {
                        return err('too_many_items', 'split would exceed ' + MAX_ITEMS + ' items');
                    }
                    const items = [];
                    for (const item of plan.items) {
                        if (item.id === found.id)
                            items.push(...parts);
                        else
                            items.push(item);
                    }
                    await store(touch(plan, items));
                    return done();
                }
                case 'setSuggestions': {
                    const d = targetDate();
                    const plan = current(d);
                    const found = resolveItem(plan, payload);
                    if (isFailed(found))
                        return found;
                    const raw = payload.suggestions ?? [];
                    if (!Array.isArray(raw) || raw.length > MAX_SUGGESTIONS) {
                        return err('invalid_payload', 'suggestions must be an array of at most ' + MAX_SUGGESTIONS);
                    }
                    const suggestions = [];
                    for (const entry of raw) {
                        const normalized = normalizeSuggestion(entry);
                        if (isFailed(normalized))
                            return normalized;
                        suggestions.push(normalized);
                    }
                    const items = plan.items.map((item) => (item.id === found.id ? { ...item, suggestions } : item));
                    await store(touch(plan, items));
                    return done();
                }
                case 'applySuggestion': {
                    const d = targetDate();
                    const plan = current(d);
                    const found = resolveItem(plan, payload);
                    if (isFailed(found))
                        return found;
                    const suggestionId = payload.suggestionId;
                    if (typeof suggestionId !== 'string')
                        return err('invalid_payload', 'suggestionId required');
                    const chips = found.suggestions ?? [];
                    const chip = chips.find((c) => c.id === suggestionId);
                    if (chip === undefined)
                        return err('suggestion_not_found', 'no suggestion ' + suggestionId + ' on that item');
                    // Drop the applied chip; the action itself replaces the item's shape.
                    const withoutChip = (item) => ({ ...item, suggestions: chips.filter((c) => c.id !== suggestionId) });
                    const replace = (items) => items.map((item) => (item.id === found.id ? withoutChip(item) : item));
                    switch (chip.action) {
                        case 'info':
                            return done();
                        case 'complete': {
                            const items = replace(plan.items).map((item) => item.id === found.id ? { ...item, done: true, doneAt: nowIso } : item);
                            await store(touch(plan, items));
                            return done();
                        }
                        case 'drop': {
                            await store(touch(plan, plan.items.filter((item) => item.id !== found.id)));
                            return done();
                        }
                        case 'retitle': {
                            const text = chip.text ?? found.text;
                            const items = replace(plan.items).map((item) => (item.id === found.id ? { ...item, text } : item));
                            await store(touch(plan, items));
                            return done();
                        }
                        case 'defer': {
                            const toDate = chip.date === 'tomorrow' ? addDays(plan.date, 1) : chip.date;
                            if (toDate === undefined || !isValidDateKey(toDate))
                                return err('invalid_payload', 'defer target is not a valid date');
                            const to = current(toDate);
                            if (to.items.length >= MAX_ITEMS)
                                return err('too_many_items', 'target day already holds ' + MAX_ITEMS + ' items');
                            const moved = withoutChip({ ...found, origin: 'carried' });
                            await store(touch(plan, plan.items.filter((item) => item.id !== found.id)));
                            await store(touch(to, [...to.items, moved]));
                            return done();
                        }
                        case 'split': {
                            const texts = chip.items ?? [];
                            const parts = texts.map((text) => ({
                                id: randomUUID(), text, done: false, doneAt: null, origin: found.origin,
                            }));
                            if (plan.items.length - 1 + parts.length > MAX_ITEMS) {
                                return err('too_many_items', 'split would exceed ' + MAX_ITEMS + ' items');
                            }
                            const items = [];
                            for (const item of plan.items) {
                                if (item.id === found.id)
                                    items.push(...parts);
                                else
                                    items.push(item);
                            }
                            await store(touch(plan, items));
                            return done();
                        }
                        default:
                            return err('invalid_payload', 'unsupported suggestion action');
                    }
                }
                case 'updateItem': {
                    const d = targetDate();
                    const plan = current(d);
                    const found = resolveItem(plan, payload);
                    if (isFailed(found))
                        return found;
                    // `undefined` means "not supplied" and `null` means "clear". Using
                    // hasOwn alone treats a key sent as undefined as an instruction to set
                    // it, which made a summary-only update fail with empty_text.
                    const patch = {};
                    if (payload.text !== undefined || payload.newText !== undefined) {
                        const text = normalizeText(payload.text ?? payload.newText);
                        if (text === null)
                            return err('empty_text', 'text must be 1-500 chars');
                        patch.text = text;
                    }
                    // `summary` is the task's own summary box: what this task implements.
                    if (payload.summary !== undefined) {
                        if (payload.summary === null || payload.summary === '') {
                            patch.summary = undefined;
                        }
                        else {
                            const text = normalizeText(payload.summary);
                            if (text === null)
                                return err('invalid_payload', 'summary must be 1-500 chars');
                            patch.summary = text;
                        }
                    }
                    if (payload.projectId !== undefined) {
                        if (payload.projectId === null || payload.projectId === '') {
                            patch.projectId = undefined;
                        }
                        else {
                            if (typeof payload.projectId !== 'string')
                                return err('invalid_payload', 'projectId must be a string or null');
                            if (!(await listProjects()).some((project) => project.id === payload.projectId)) {
                                return err('project_not_found', 'no project with id ' + payload.projectId);
                            }
                            patch.projectId = payload.projectId;
                        }
                    }
                    await store(touch(plan, plan.items.map((item) => (item.id === found.id ? { ...item, ...patch } : item))));
                    return done();
                }
                case 'addProject': {
                    const normalized = normalizeProject(payload, { id: randomUUID(), nowIso });
                    if (!normalized.ok)
                        return err('invalid_payload', normalized.message);
                    const existing = await listProjects();
                    if (existing.some((project) => project.name.toLowerCase() === normalized.value.name.toLowerCase())) {
                        return err('invalid_payload', 'a project named ' + JSON.stringify(normalized.value.name) + ' already exists');
                    }
                    await saveProject(normalized.value);
                    return done();
                }
                case 'updateProject': {
                    const all = await listProjects();
                    const found = resolveProject(all, payload);
                    if (isFailed(found))
                        return found;
                    const normalized = normalizeProject(payload, { id: found.id, nowIso, existing: found });
                    if (!normalized.ok)
                        return err('invalid_payload', normalized.message);
                    await saveProject(normalized.value);
                    return done();
                }
                case 'removeProject': {
                    const all = await listProjects();
                    const found = resolveProject(all, payload);
                    if (isFailed(found))
                        return found;
                    await (await projectsTable()).delete(found.id);
                    // Check-ins belong to the project. Leaving them behind keeps a deleted
                    // venture's money, metrics and verdicts in the store — invisible on the
                    // board, but still read by anything walking the table (and by the next
                    // backup dump). Deleting the project deletes its history.
                    for (const entry of await projectCheckins(found.id)) {
                        await (await checkinsTable()).delete(checkinKey(found.id, entry.date));
                    }
                    // Backlog candidates belong to the project for exactly the same reason:
                    // left behind they are invisible on the board but still read by
                    // anything walking the table, and they would resurface under a future
                    // project that happened to reuse the id.
                    for (const entry of await listBacklog()) {
                        if (entry.projectId === found.id)
                            await deleteBacklogItem(entry.id);
                    }
                    // Sparks are the ONE thing deliberately NOT deleted here, and the
                    // asymmetry with check-ins is the point. A check-in is a child of the
                    // project; a spark is a lead the project produced. A venture that dies
                    // because of a hurdle is telling you the hurdle IS the business, so
                    // deleting its sparks at the kill would destroy the most valuable thing
                    // it made. They keep their id, their frozen source name and their place
                    // on the triage board; only `sourceProjectId` dangles, by design.
                    if ((await selection()) === found.id)
                        await select(null);
                    // Unlink today's and tomorrow's tasks so nothing points at a deleted
                    // project. Older days are read-only history and keep their tag.
                    for (const d of [date, tomorrowKey]) {
                        const plan = current(d);
                        if (!plan.items.some((item) => item.projectId === found.id))
                            continue;
                        await store(touch(plan, plan.items.map((item) => item.projectId === found.id ? { ...item, projectId: undefined } : item)));
                    }
                    return done();
                }
                case 'selectProject': {
                    if (Object.hasOwn(payload, 'projectId') && payload.projectId === null) {
                        await select(null);
                        return done();
                    }
                    const all = await listProjects();
                    const found = resolveProject(all, payload);
                    if (isFailed(found))
                        return found;
                    await select(found.id);
                    // Choosing a project starts it: an idea becomes active. `parked` counts
                    // too — parked means deferred, and picking it IS the decision to stop
                    // deferring. Anything already in flight is only selected.
                    if (found.status === 'idea' || found.status === 'parked') {
                        await saveProject({ ...found, status: 'active', updatedAt: nowIso });
                    }
                    return done();
                }
                // ---- the backlog: what you can choose from ---------------------------
                case 'addBacklogItem': {
                    const project = resolveProject(await listProjects(), payload);
                    if (isFailed(project))
                        return project;
                    const text = normalizeText(payload.text);
                    if (text === null)
                        return err('empty_text', 'text must be 1-500 chars');
                    const mine = (await listBacklog()).filter((entry) => entry.projectId === project.id);
                    if (mine.length >= MAX_BACKLOG) {
                        return err('too_many_items', project.name + ' already holds ' + MAX_BACKLOG + ' backlog tasks');
                    }
                    const entry = {
                        id: randomUUID(),
                        projectId: project.id,
                        text,
                        createdAt: nowIso,
                    };
                    const summary = normalizeText(payload.summary);
                    if (summary !== null)
                        entry.summary = summary;
                    await saveBacklogItem(entry);
                    return done();
                }
                case 'editBacklogItem': {
                    const entry = await resolveBacklogItem();
                    if (isFailed(entry))
                        return entry;
                    const next = { ...entry };
                    if (payload.text !== undefined && payload.text !== null) {
                        const text = normalizeText(payload.text);
                        if (text === null)
                            return err('empty_text', 'text must be 1-500 chars');
                        next.text = text;
                    }
                    // undefined leaves the summary alone; null clears it.
                    if (payload.summary === null)
                        delete next.summary;
                    else if (payload.summary !== undefined) {
                        const summary = normalizeText(payload.summary);
                        if (summary === null)
                            return err('invalid_payload', 'summary must be 1-500 chars');
                        next.summary = summary;
                    }
                    await saveBacklogItem(next);
                    return done();
                }
                case 'removeBacklogItem': {
                    const entry = await resolveBacklogItem();
                    if (isFailed(entry))
                        return entry;
                    await deleteBacklogItem(entry.id);
                    return done();
                }
                /**
                 * The move that makes the backlog useful: take a candidate task, put it
                 * on a day, and clear it from the backlog — in one operation, so the two
                 * halves cannot drift into a duplicate.
                 */
                case 'planBacklogItem': {
                    const entry = await resolveBacklogItem();
                    if (isFailed(entry))
                        return entry;
                    const rawTo = payload.toDate ?? payload.date;
                    let when = date;
                    if (rawTo === 'tomorrow')
                        when = tomorrowKey;
                    else if (rawTo !== undefined && rawTo !== null && rawTo !== '') {
                        if (typeof rawTo !== 'string' || !isValidDateKey(rawTo)) {
                            return err('invalid_local_date', 'toDate must be YYYY-MM-DD or "tomorrow"');
                        }
                        when = rawTo;
                    }
                    const plan = current(when);
                    if (plan.items.length >= MAX_ITEMS) {
                        return err('too_many_items', when + ' already holds ' + MAX_ITEMS + ' items');
                    }
                    const item = {
                        id: randomUUID(),
                        text: entry.text,
                        done: false,
                        doneAt: null,
                        origin: when === tomorrowKey ? 'tomorrow-write' : 'today',
                        projectId: entry.projectId,
                    };
                    if (entry.summary !== undefined)
                        item.summary = entry.summary;
                    await store(touch(plan, [...plan.items, item]));
                    await deleteBacklogItem(entry.id);
                    // Optionally pick it in the same call, so one click both schedules and
                    // starts a task.
                    if (payload.select === true)
                        await pickNow(item.id, when);
                    return done();
                }
                case 'logCheckin': {
                    const all = await listProjects();
                    const found = resolveProject(all, payload);
                    if (isFailed(found))
                        return found;
                    const when = typeof payload.date === 'string' && DATE_RE.test(payload.date) ? payload.date : date;
                    const prior = await readCheckin(found.id, when);
                    // `undefined` means "not provided, leave as it was"; `null` means
                    // "clear it". Collapsing the two is what silently wiped fields in
                    // updateItem, so the distinction is kept here too.
                    const asNumber = (value) => {
                        if (value === null)
                            return null;
                        if (typeof value === 'number' && Number.isFinite(value))
                            return value;
                        return undefined;
                    };
                    const asText = (value) => {
                        if (value === null)
                            return null;
                        if (typeof value === 'string')
                            return value.trim().slice(0, MAX_CHECKIN_TEXT) || null;
                        return undefined;
                    };
                    const asItems = (value, previous) => {
                        if (!Array.isArray(value))
                            return undefined;
                        return value.slice(0, MAX_CHECKIN_ITEMS).map((raw) => {
                            const label = typeof raw === 'string' ? raw.trim().slice(0, MAX_CHECKIN_TEXT) : '';
                            if (label.length === 0)
                                return null;
                            // Keep the identity of an item that already existed, so closing it
                            // later does not depend on the check-in being rewritten exactly.
                            const same = previous.find((item) => item.text === label);
                            return same ?? { id: randomUUID(), text: label, done: false, at: nowIso, closedAt: null };
                        }).filter((item) => item !== null);
                    };
                    const verdict = typeof payload.verdict === 'string' && CHECKIN_VERDICTS.includes(payload.verdict)
                        ? payload.verdict
                        : (prior?.verdict ?? 'continue');
                    const metric = asNumber(payload.metric);
                    const revenue = asNumber(payload.revenue);
                    const customers = asNumber(payload.customers);
                    const metricNote = asText(payload.metricNote);
                    const progress = asText(payload.progress);
                    const note = asText(payload.note);
                    const hurdles = asItems(payload.hurdles, prior?.hurdles ?? []);
                    const corrections = asItems(payload.corrections, prior?.corrections ?? []);
                    if (revenue !== undefined && revenue !== null && revenue < 0)
                        return err('invalid_payload', 'revenue cannot be negative');
                    await saveCheckin({
                        projectId: found.id,
                        date: when,
                        metric: metric === undefined ? (prior?.metric ?? null) : metric,
                        metricNote: metricNote === undefined ? (prior?.metricNote ?? null) : metricNote,
                        revenue: revenue === undefined ? (prior?.revenue ?? null) : revenue,
                        customers: customers === undefined ? (prior?.customers ?? null) : customers,
                        progress: progress === undefined ? (prior?.progress ?? null) : progress,
                        verdict,
                        note: note === undefined ? (prior?.note ?? null) : note,
                        hurdles: hurdles === undefined ? (prior?.hurdles ?? []) : hurdles,
                        corrections: corrections === undefined ? (prior?.corrections ?? []) : corrections,
                        createdAt: prior?.createdAt ?? nowIso,
                        updatedAt: nowIso,
                    });
                    // Capture the ideas this check-in sparked BEFORE the verdict lands: a
                    // kill is exactly the check-in most likely to carry the good ones.
                    await reconcileSparks(found, when, payload.sparks, nowIso);
                    // A kill verdict is a decision, not a note: the project leaves the
                    // board for the register, where the reason is recorded.
                    if (verdict === 'kill' && found.status !== 'killed') {
                        await saveProject({ ...found, status: 'killed', updatedAt: nowIso });
                    }
                    return done();
                }
                case 'checkinItem': {
                    const all = await listProjects();
                    const found = resolveProject(all, payload);
                    if (isFailed(found))
                        return found;
                    const kind = payload.kind === 'correction' ? 'corrections' : payload.kind === 'hurdle' ? 'hurdles' : null;
                    if (kind === null)
                        return err('invalid_payload', 'kind must be hurdle or correction');
                    const threshold = typeof payload.match === 'string' ? payload.match.trim().toLowerCase() : '';
                    if (threshold.length === 0)
                        return err('invalid_payload', 'match is required');
                    const entries = await projectCheckins(found.id);
                    const when = typeof payload.date === 'string' && DATE_RE.test(payload.date) ? payload.date : null;
                    const candidates = when === null ? entries : entries.filter((entry) => entry.date === when);
                    // Newest first: the latest statement of a hurdle is the live one.
                    const ordered = [...candidates].reverse();
                    let hit = null;
                    let ambiguous = 0;
                    for (const entry of ordered) {
                        const matches = entry[kind].filter((item) => item.text.toLowerCase().includes(threshold));
                        if (matches.length === 0)
                            continue;
                        if (hit === null) {
                            hit = { entry, item: matches[0] };
                            ambiguous = matches.length;
                        }
                        else {
                            ambiguous += matches.length;
                        }
                    }
                    if (hit === null)
                        return err('item_not_found', 'no ' + kind + ' matching ' + JSON.stringify(String(payload.match)));
                    if (ambiguous > 1)
                        return err('invalid_payload', 'ambiguous: ' + ambiguous + ' ' + kind + ' match ' + JSON.stringify(String(payload.match)));
                    const closing = payload.done === undefined ? true : payload.done === true;
                    const updated = {
                        ...hit.entry,
                        [kind]: hit.entry[kind].map((item) => item.id === hit.item.id
                            ? { ...item, done: closing, closedAt: closing ? nowIso : null }
                            : item),
                        updatedAt: nowIso,
                    };
                    await saveCheckin(updated);
                    return done();
                }
                case 'addPlugin': {
                    const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, MAX_NAME) : '';
                    if (name.length === 0)
                        return err('invalid_payload', 'name is required');
                    const all = await listPlugins();
                    if (all.some((plugin) => plugin.name === name)) {
                        return err('invalid_payload', name + ' is already in the register — use updatePlugin');
                    }
                    if (payload.origin !== 'ours' && payload.origin !== 'fork' && payload.origin !== 'third-party') {
                        return err('invalid_payload', 'origin must be one of ' + PLUGIN_ORIGINS.join('|'));
                    }
                    const origin = payload.origin;
                    await savePlugin({
                        id: randomUUID(),
                        name,
                        origin,
                        // The fail-safe default. Publishing is an explicit act: a plugin
                        // added without a visibility is internal, so no omission can put
                        // something of someone else's — or of ours that reads private
                        // material — one click from a public push.
                        visibility: pickEnum(payload.visibility, 'internal', PLUGIN_VISIBILITIES),
                        status: pickEnum(payload.status, 'local', PLUGIN_STATUSES),
                        createdAt: nowIso,
                        updatedAt: nowIso,
                        ...pluginFields(undefined, payload),
                    });
                    return done();
                }
                case 'updatePlugin': {
                    const all = await listPlugins();
                    const found = resolvePlugin(all, payload);
                    if (isFailed(found))
                        return found;
                    const renamed = pickText(payload.name, found.name, MAX_NAME);
                    const updated = {
                        ...found,
                        name: renamed ?? found.name,
                        origin: pickEnum(payload.origin, found.origin, PLUGIN_ORIGINS),
                        visibility: pickEnum(payload.visibility, found.visibility, PLUGIN_VISIBILITIES),
                        status: pickEnum(payload.status, found.status, PLUGIN_STATUSES),
                        updatedAt: nowIso,
                        ...pluginFields(found, payload),
                    };
                    await savePlugin(updated);
                    return done();
                }
                case 'removePlugin': {
                    const all = await listPlugins();
                    const found = resolvePlugin(all, payload);
                    if (isFailed(found))
                        return found;
                    // The register is a record, not the code: removing a row never touches
                    // the plugin, its repository or its files.
                    await (await pluginsTable()).delete(found.id);
                    return done();
                }
                case 'sparkAdd': {
                    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, MAX_CHECKIN_TEXT) : '';
                    if (text.length === 0)
                        return err('empty_text', 'text is required');
                    // The source is optional — an idea can strike with no live project
                    // behind it — but a source that was NAMED and does not resolve is an
                    // error, not a silent null: losing provenance quietly is how an idea
                    // ends up unattributable.
                    let source = null;
                    if (payload.projectId !== undefined || payload.project !== undefined) {
                        const found = resolveProject(await listProjects(), payload);
                        if (isFailed(found))
                            return found;
                        source = found;
                    }
                    const when = typeof payload.date === 'string' && DATE_RE.test(payload.date) ? payload.date : null;
                    await saveSpark(makeSpark(text, source, when, nowIso));
                    return done();
                }
                case 'sparkPromote': {
                    const spark = await readSpark(payload.sparkId);
                    if (spark === null)
                        return err('spark_not_found', 'no spark with id ' + String(payload.sparkId));
                    if (spark.status !== 'open') {
                        return err('invalid_payload', 'spark is already ' + spark.status
                            + (spark.dismissedReason === null ? '' : ': ' + spark.dismissedReason));
                    }
                    // `fulfills` is required on a project, so the default states where the
                    // idea came from. That is not tidiness: it is what carries the
                    // provenance into the register, so the same idea is not re-derived
                    // from scratch next session.
                    const fallbackFulfills = 'Sparked by feedback on ' + (spark.sourceProjectName ?? 'a live project')
                        + (spark.sourceDate === null ? '' : ' (' + spark.sourceDate + ')');
                    const named = typeof payload.name === 'string' && payload.name.trim().length > 0;
                    const served = typeof payload.fulfills === 'string' && payload.fulfills.trim().length > 0;
                    const normalized = normalizeProject({
                        name: named ? payload.name : spark.text.slice(0, MAX_NAME),
                        fulfills: served ? payload.fulfills : fallbackFulfills,
                        // `idea`, with no estimates: UNRANKED is the honest state for an idea
                        // we cannot price yet, and the planner already reports it as such.
                        status: 'idea',
                    }, { id: randomUUID(), nowIso });
                    if (!normalized.ok)
                        return err('invalid_payload', normalized.message);
                    await saveProject(normalized.value);
                    // The link lives on the SPARK only. A second copy on the project would
                    // be a second home for one fact, and the two would drift.
                    await saveSpark({
                        ...spark,
                        status: 'promoted',
                        promotedProjectId: normalized.value.id,
                        updatedAt: nowIso,
                    });
                    return done();
                }
                case 'sparkDismiss': {
                    const spark = await readSpark(payload.sparkId);
                    if (spark === null)
                        return err('spark_not_found', 'no spark with id ' + String(payload.sparkId));
                    if (spark.status !== 'open')
                        return err('invalid_payload', 'spark is already ' + spark.status);
                    const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, MAX_CHECKIN_TEXT) : '';
                    // A dismissal burns the option, so it carries the reason — the same
                    // rule the register applies to a killed project. Without it the idea is
                    // re-derived next session and assessed a second time.
                    if (reason.length === 0)
                        return err('invalid_payload', 'reason is required to dismiss a spark');
                    await saveSpark({ ...spark, status: 'dismissed', dismissedReason: reason, updatedAt: nowIso });
                    return done();
                }
                default:
                    return err('unknown_op', 'unknown op ' + String(op));
            }
        });
    }
    return {
        snapshot: (date, tz) => serialize(() => buildSnapshot(date, tz)),
        apply,
    };
}
