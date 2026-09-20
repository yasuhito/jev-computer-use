/**
 * Default decision dependency: a real TypeSafe System One call through the
 * official JavaScript SDK. TYPESAFE_API_KEY is read from the environment; this
 * module never logs, stores, hashes, or returns it.
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";

export const DEFAULT_MODEL = "jev-latest";

/** Thrown when TYPESAFE_API_KEY is absent from the environment. */
export class MissingKeyError extends Error {
  constructor() {
    super("TYPESAFE_API_KEY is not set in the environment");
    this.name = "MissingKeyError";
    this.code = "missing_key";
  }
}

/**
 * Create the decide implementation used when the caller does not inject one.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {(request: {state: object, questions: object}) => Promise<{model?: string, answers: object, usage?: object}>}
 * @throws {MissingKeyError} when TYPESAFE_API_KEY is not set
 */
export function createTypesafeDecide({ env = process.env } = {}) {
  const apiKey = env.TYPESAFE_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new MissingKeyError();
  }
  const client = new TypeSafeClient({ apiKey });
  return async function decide(request) {
    const response = await client.systemOne(request);
    return { model: response.model, answers: response.answers, usage: response.usage };
  };
}
