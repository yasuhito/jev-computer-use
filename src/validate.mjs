/**
 * Deterministic input validation for jev-cu. Pure: no network, no I/O.
 * The model never sees raw unvalidated input; schema, bounds, and id
 * assignment all happen here in ordinary code.
 */

export const NO_MATCH = "no_match";
export const DEFAULT_MAX_CANDIDATES = 40;
/** A TypeSafe Choice question accepts up to 255 options. */
export const HARD_MAX_CANDIDATES = 255;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const LIMITS = {
  goal: 2000,
  context: 2000,
  label: 400,
  role: 40,
};

export class ValidationError extends Error {
  /**
   * @param {string} message
   * @param {string} code stable machine-readable code
   */
  constructor(message, code) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

/** Collapse whitespace and cap length; UI labels are data, not formatting. */
export function sanitizeLabel(text, max = LIMITS.label) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, max);
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize a jev-cu request.
 *
 * @param {unknown} raw parsed JSON request
 * @param {{maxCandidates?: number}} [options]
 * @returns {{goal: string, context: string|null, candidates: Array<{id: string, role: string|null, label: string}>}}
 * @throws {ValidationError} with a stable code on any violation
 */
export function validateRequest(raw, { maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > HARD_MAX_CANDIDATES) {
    throw new ValidationError(
      `max-candidates must be an integer in 1..${HARD_MAX_CANDIDATES}`,
      "invalid_max_candidates",
    );
  }
  if (!isPlainObject(raw)) {
    throw new ValidationError("request must be a JSON object", "invalid_request");
  }
  const allowed = new Set(["goal", "context", "candidates"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`unknown request field "${key}" (allowed: goal, context, candidates)`, "unknown_field");
    }
  }
  if (typeof raw.goal !== "string" || raw.goal.trim().length === 0) {
    throw new ValidationError("goal is required and must be a non-empty string", "invalid_goal");
  }
  const goal = sanitizeLabel(raw.goal, LIMITS.goal);

  if (!Array.isArray(raw.candidates)) {
    throw new ValidationError("candidates is required and must be a JSON array", "invalid_candidates");
  }
  if (raw.candidates.length < 1) {
    throw new ValidationError("candidates must contain at least one entry", "empty_candidates");
  }
  if (raw.candidates.length > maxCandidates) {
    throw new ValidationError(
      `candidates has ${raw.candidates.length} entries, exceeding the bound of ${maxCandidates}`,
      "too_many_candidates",
    );
  }

  const used = new Set();
  const candidates = raw.candidates.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new ValidationError(`candidate ${i} must be a JSON object`, "invalid_candidate");
    }
    const allowedKeys = new Set(["id", "role", "label"]);
    for (const key of Object.keys(entry)) {
      if (!allowedKeys.has(key)) {
        throw new ValidationError(`candidate ${i} has unknown field "${key}" (allowed: id, role, label)`, "unknown_field");
      }
    }
    if (typeof entry.label !== "string" || entry.label.trim().length === 0) {
      throw new ValidationError(`candidate ${i} needs a non-empty string label`, "invalid_label");
    }
    const label = sanitizeLabel(entry.label);
    if (label.length === 0) {
      throw new ValidationError(`candidate ${i} label is empty after sanitization`, "invalid_label");
    }
    let role = null;
    if (entry.role !== undefined) {
      if (typeof entry.role !== "string") {
        throw new ValidationError(`candidate ${i} role must be a string when present`, "invalid_role");
      }
      role = sanitizeLabel(entry.role, LIMITS.role) || null;
    }
    let id;
    if (entry.id === undefined) {
      id = `c${i}`;
      let n = 0;
      while (used.has(id)) {
        id = `c${i}_${n}`;
        n += 1;
      }
    } else {
      if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) {
        throw new ValidationError(
          `candidate ${i} id must match ${ID_PATTERN} when present`,
          "invalid_id",
        );
      }
      if (entry.id === NO_MATCH) {
        throw new ValidationError(`candidate ${i} uses the reserved id "${NO_MATCH}"`, "reserved_id");
      }
      id = entry.id;
    }
    if (used.has(id)) {
      throw new ValidationError(`duplicate candidate id "${id}"`, "duplicate_id");
    }
    used.add(id);
    return { id, role, label };
  });

  let context = null;
  if (raw.context !== undefined) {
    if (typeof raw.context !== "string") {
      throw new ValidationError("context must be a string when present", "invalid_context");
    }
    context = sanitizeLabel(raw.context, LIMITS.context);
  }

  return { goal, context, candidates };
}
