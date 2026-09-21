/** Shared offline test helpers: fake decision dependencies and a fake clock. */

/**
 * A decide dependency that answers each call by matching the next pattern
 * against the offered option descriptions. No match answers no_match.
 *
 * @param {RegExp[]} patterns one per expected decision, consumed in order
 * @param {{confidence?: number, onCall?: (callIndex: number, request: import("../src/decide.mjs").RequestPayload) => void}} [options]
 * @returns {import("../src/decide.mjs").DecideFn & {calls: import("../src/decide.mjs").RequestPayload[]}}
 */
export function decideByLabel(patterns, { confidence = 0.95, onCall } = {}) {
  const queue = [...patterns];
  /** @type {import("../src/decide.mjs").RequestPayload[]} */
  const calls = [];
  /** @type {import("../src/decide.mjs").DecideFn & {calls: import("../src/decide.mjs").RequestPayload[]}} */
  const decide = Object.assign(
    async (/** @type {import("../src/decide.mjs").RequestPayload} */ request) => {
      const index = calls.length;
      calls.push(request);
      if (onCall) onCall(index, request);
      const pattern = queue.shift();
      const question = request.questions.element;
      const criteria = question ? question.criteria : {};
      let choice = "no_match";
      if (pattern) {
        for (const [id, description] of Object.entries(criteria)) {
          // Descriptions are "role: label"; match the label part so anchors work.
          const label = String(description).replace(/^[a-z]+: /, "");
          if (id !== "no_match" && pattern.test(label)) {
            choice = id;
            break;
          }
        }
      }
      const probabilities = { [choice]: confidence };
      return {
        model: "jev-fake",
        answers: { element: { type: "choice", choice, confidence: choice === "no_match" ? 1 : confidence, probabilities } },
        usage: { input_tokens: 100, output_tokens: 5 },
      };
    },
    { calls },
  );
  return decide;
}

/**
 * @param {{choice: string, confidence: number}} answer
 * @returns {import("../src/decide.mjs").DecideFn}
 */
export function decideFixed(answer) {
  return async () => ({
    model: "jev-fake",
    answers: { element: { type: "choice", ...answer, probabilities: {} } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

/** A clock that only advances when the code under test sleeps or a test bumps it. */
export function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    /** @param {number} ms */
    sleep: async (ms) => {
      t += ms;
    },
    /** @param {number} ms */
    advance: (ms) => {
      t += ms;
    },
  };
}
