/** Named profiles selectable from the CLI. Allowlists live in code only. */
import { GENERIC_PROFILE } from "./profile.mjs";
import { SLACK_PROFILE, SLACK_LOCAL_SYNTHETIC_PROFILE } from "./slack.mjs";

/** @type {ReadonlyMap<string, import("./profile.mjs").Profile>} */
export const PROFILES = new Map([
  [SLACK_PROFILE.name, SLACK_PROFILE],
  [SLACK_LOCAL_SYNTHETIC_PROFILE.name, SLACK_LOCAL_SYNTHETIC_PROFILE],
  [GENERIC_PROFILE.name, GENERIC_PROFILE],
]);

export const DEFAULT_PROFILE_NAME = SLACK_PROFILE.name;
