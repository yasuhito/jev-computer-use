/**
 * Confidence policy, applied in ordinary code after Jev answers. The
 * threshold is explicit; the model never decides whether its own answer may
 * be used. This tool is read-only: every outcome is a report, never an
 * execution.
 */
import { NO_MATCH } from "./validate.mjs";

/**
 * Default threshold. Per the TypeSafe confidence guidance, values below 0.5
 * mean the model is genuinely unsure and should not be guessed from.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * @typedef {object} NormalizedAnswer
 * @property {string|null} choice
 * @property {number|null} confidence
 * @property {object} probabilities
 * @property {boolean} usable
 */

/**
 * Apply the confidence policy to a normalized answer.
 *
 * @param {NormalizedAnswer} normalized
 * @param {import("./validate.mjs").Candidate[]} candidates
 * @param {number} [threshold]
 * @returns {{status: "selected"|"no_match"|"escalate", candidate: import("./validate.mjs").Candidate|null, reason: string|null}}
 */
export function applyPolicy(normalized, candidates, threshold = DEFAULT_MIN_CONFIDENCE) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`threshold must be a number in [0, 1], got ${threshold}`);
  }
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const candidate = normalized.choice !== null ? byId.get(normalized.choice) ?? null : null;
  const { choice, confidence } = normalized;

  if (!normalized.usable || choice === null || confidence === null) {
    const why =
      choice === null
        ? "Jev returned an unknown or missing choice id"
        : "Jev returned missing or out-of-range confidence";
    return { status: "escalate", candidate, reason: why };
  }
  if (confidence < threshold) {
    return {
      status: "escalate",
      candidate,
      reason: `confidence ${confidence.toFixed(2)} is below the threshold ${threshold.toFixed(2)}`,
    };
  }
  if (choice === NO_MATCH) {
    return { status: "no_match", candidate: null, reason: null };
  }
  return { status: "selected", candidate, reason: null };
}
