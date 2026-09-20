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
 * Apply the confidence policy to a normalized answer.
 *
 * @param {{choice: string|null, confidence: number|null, probabilities: object, usable: boolean}} normalized
 * @param {Array<{id: string, role: string|null, label: string}>} candidates
 * @param {number} [threshold]
 * @returns {{status: "selected"|"no_match"|"escalate", candidate: {id: string, role: string|null, label: string}|null, reason: string|null}}
 */
export function applyPolicy(normalized, candidates, threshold = DEFAULT_MIN_CONFIDENCE) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`threshold must be a number in [0, 1], got ${threshold}`);
  }
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const candidate = normalized.choice !== null ? byId.get(normalized.choice) ?? null : null;

  if (!normalized.usable) {
    const why =
      normalized.choice === null
        ? "Jev returned an unknown or missing choice id"
        : "Jev returned missing or out-of-range confidence";
    return { status: "escalate", candidate, reason: why };
  }
  if (normalized.confidence < threshold) {
    return {
      status: "escalate",
      candidate,
      reason: `confidence ${normalized.confidence.toFixed(2)} is below the threshold ${threshold.toFixed(2)}`,
    };
  }
  if (normalized.choice === NO_MATCH) {
    return { status: "no_match", candidate: null, reason: null };
  }
  return { status: "selected", candidate, reason: null };
}
