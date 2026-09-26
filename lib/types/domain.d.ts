/**
 * Domain declaration and record schemas. The domain rides the host's
 * storage-domain facility (`ctx.storageDomain`) and is routed to whatever
 * backend the deployment configured (the standard web composition: json).
 *
 * The domain name is `daily_progress_tab`, deliberately distinct from the
 * upstream plugin's `daily_progress`: a domain name may be open only once per
 * process, so a distinct name lets this fork coexist with an upstream install
 * instead of failing open with `already-open`.
 *
 * The version stays at 1 even though `projects` and `global` were added later.
 * Bumping it would make the existing medium — already stamped version 1 —
 * reject at open, i.e. the plugin would refuse to start on the very store it
 * created. A new table simply loads empty and the unwritten global falls back to
 * its initial value, so no migration is needed.
 *
 * Optional fields are optional for the same reason: a required field would fail
 * every record written before it existed with `invalid-record` and the domain
 * would refuse to open.
 *
 * Record keys are `<scope>:<date>` for plans (see calendar.ts); V1 uses scope
 * `'default'`.
 * @module dsh-daily-progress-tab/domain
 */
import z from 'zod';
/** Chips per item. Keeps a task row readable and bounds what one suggest call writes. */
export declare const MAX_SUGGESTIONS = 6;
/** Hurdles/corrections tracked per check-in. Bounded so one record stays readable. */
export declare const MAX_CHECKIN_ITEMS = 20;
/** The verdict vocabulary: what the check-in decided to DO about the project. */
export declare const CHECKIN_VERDICTS: readonly ["continue", "fix", "kill", "pause"];
/** The domain spec: one `plans` table per (scope, date), plus `projects`, `checkins`, `backlog`, `sparks` and `plugins`. */
export declare const dailyProgressDomain: {
    name: string;
    version: number;
    global: {
        schema: z.ZodObject<{
            selectedProjectId: z.ZodNullable<z.ZodString>;
            selectedItemId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            selectedItemDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            updatedAt: z.ZodString;
        }, z.core.$strip>;
        initial: {
            selectedProjectId: null;
            selectedItemId: null;
            selectedItemDate: null;
            updatedAt: string;
        };
    };
    tables: {
        plans: {
            valueSchema: z.ZodObject<{
                date: z.ZodString;
                tz: z.ZodString;
                items: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    text: z.ZodString;
                    done: z.ZodBoolean;
                    doneAt: z.ZodNullable<z.ZodString>;
                    origin: z.ZodEnum<{
                        today: "today";
                        carried: "carried";
                        "tomorrow-write": "tomorrow-write";
                    }>;
                    projectId: z.ZodOptional<z.ZodString>;
                    summary: z.ZodOptional<z.ZodString>;
                    suggestions: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        id: z.ZodString;
                        label: z.ZodString;
                        action: z.ZodEnum<{
                            info: "info";
                            complete: "complete";
                            defer: "defer";
                            split: "split";
                            retitle: "retitle";
                            drop: "drop";
                        }>;
                        detail: z.ZodOptional<z.ZodString>;
                        date: z.ZodOptional<z.ZodString>;
                        items: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        text: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>>>;
                }, z.core.$strip>>;
                updatedAt: z.ZodString;
            }, z.core.$strip>;
        };
        projects: {
            valueSchema: z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                fulfills: z.ZodString;
                summary: z.ZodOptional<z.ZodString>;
                ttfdDays: z.ZodNullable<z.ZodNumber>;
                effortDays: z.ZodNullable<z.ZodNumber>;
                revenuePerMonth: z.ZodNullable<z.ZodNumber>;
                currency: z.ZodString;
                confidence: z.ZodNumber;
                rubric: z.ZodObject<{
                    forcingFunction: z.ZodNumber;
                    competitionThinness: z.ZodNumber;
                    assetLightness: z.ZodNumber;
                    aiRunnability: z.ZodNumber;
                    distribution: z.ZodNumber;
                    moat: z.ZodNumber;
                    regulatoryCost: z.ZodNumber;
                }, z.core.$strip>;
                status: z.ZodEnum<{
                    idea: "idea";
                    active: "active";
                    parked: "parked";
                    shipped: "shipped";
                    killed: "killed";
                }>;
                killSwitch: z.ZodOptional<z.ZodString>;
                metricName: z.ZodOptional<z.ZodString>;
                createdAt: z.ZodString;
                updatedAt: z.ZodString;
            }, z.core.$strip>;
        };
        checkins: {
            valueSchema: z.ZodObject<{
                projectId: z.ZodString;
                date: z.ZodString;
                metric: z.ZodNullable<z.ZodNumber>;
                metricNote: z.ZodNullable<z.ZodString>;
                revenue: z.ZodNullable<z.ZodNumber>;
                customers: z.ZodNullable<z.ZodNumber>;
                progress: z.ZodNullable<z.ZodString>;
                verdict: z.ZodEnum<{
                    continue: "continue";
                    fix: "fix";
                    kill: "kill";
                    pause: "pause";
                }>;
                note: z.ZodNullable<z.ZodString>;
                hurdles: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    text: z.ZodString;
                    done: z.ZodBoolean;
                    at: z.ZodString;
                    closedAt: z.ZodNullable<z.ZodString>;
                }, z.core.$strip>>;
                corrections: z.ZodArray<z.ZodObject<{
                    id: z.ZodString;
                    text: z.ZodString;
                    done: z.ZodBoolean;
                    at: z.ZodString;
                    closedAt: z.ZodNullable<z.ZodString>;
                }, z.core.$strip>>;
                createdAt: z.ZodString;
                updatedAt: z.ZodString;
            }, z.core.$strip>;
        };
        backlog: {
            valueSchema: z.ZodObject<{
                id: z.ZodString;
                projectId: z.ZodString;
                text: z.ZodString;
                summary: z.ZodOptional<z.ZodString>;
                createdAt: z.ZodString;
            }, z.core.$strip>;
        };
        sparks: {
            valueSchema: z.ZodObject<{
                id: z.ZodString;
                text: z.ZodString;
                sourceProjectId: z.ZodNullable<z.ZodString>;
                sourceProjectName: z.ZodNullable<z.ZodString>;
                sourceDate: z.ZodNullable<z.ZodString>;
                status: z.ZodEnum<{
                    open: "open";
                    promoted: "promoted";
                    dismissed: "dismissed";
                }>;
                promotedProjectId: z.ZodNullable<z.ZodString>;
                dismissedReason: z.ZodNullable<z.ZodString>;
                createdAt: z.ZodString;
                updatedAt: z.ZodString;
            }, z.core.$strip>;
        };
        plugins: {
            valueSchema: z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                origin: z.ZodEnum<{
                    ours: "ours";
                    fork: "fork";
                    "third-party": "third-party";
                }>;
                visibility: z.ZodEnum<{
                    showcase: "showcase";
                    internal: "internal";
                }>;
                status: z.ZodEnum<{
                    local: "local";
                    public: "public";
                }>;
                title: z.ZodOptional<z.ZodString>;
                summary: z.ZodOptional<z.ZodString>;
                upstream: z.ZodOptional<z.ZodString>;
                licence: z.ZodOptional<z.ZodString>;
                sourcePath: z.ZodOptional<z.ZodString>;
                publicUrl: z.ZodOptional<z.ZodString>;
                publishedAt: z.ZodOptional<z.ZodString>;
                installed: z.ZodOptional<z.ZodBoolean>;
                hasLicenseFile: z.ZodOptional<z.ZodBoolean>;
                hasReadme: z.ZodOptional<z.ZodBoolean>;
                hasScreenshot: z.ZodOptional<z.ZodBoolean>;
                sourceOutsideProfile: z.ZodOptional<z.ZodBoolean>;
                leakScanPassed: z.ZodOptional<z.ZodBoolean>;
                leakScanAt: z.ZodOptional<z.ZodString>;
                gitReady: z.ZodOptional<z.ZodBoolean>;
                verifiedAt: z.ZodOptional<z.ZodString>;
                notes: z.ZodOptional<z.ZodString>;
                createdAt: z.ZodString;
                updatedAt: z.ZodString;
            }, z.core.$strip>;
        };
    };
};
export type DailyProgressDomainSpec = typeof dailyProgressDomain;
