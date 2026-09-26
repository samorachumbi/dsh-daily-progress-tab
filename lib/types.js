/**
 * Shared wire types for the daily-progress domain. These are the shapes the
 * host routes serve, the agent tools return, and the planner page consumes;
 * keep them JSON-safe and free of implementation classes.
 */
/** The seven rubric dimensions, reused verbatim from the vault's own
 * `business-idea-generator` skill so the planner scores ideas the same way the
 * research memos do. Each is rated 1-5. */
export const RUBRIC_DIMENSIONS = [
    'forcingFunction',
    'competitionThinness',
    'assetLightness',
    'aiRunnability',
    'distribution',
    'moat',
    'regulatoryCost',
];
