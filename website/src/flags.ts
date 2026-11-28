// Website feature flags: try something on the live site with nobody else seeing it. See the
// README. Unrelated to packages/core/src/flags.ts, which is baked into the apps.

export const WEBSITE_FLAGS = ["crypto"] as const;
export type WebsiteFlag = (typeof WEBSITE_FLAGS)[number];
