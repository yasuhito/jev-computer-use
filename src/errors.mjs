/**
 * Error types shared by the browser-navigation slice. A RefusalError is a
 * deterministic "will not act" outcome decided in code; a TransportError is a
 * failure to talk to the browser. Neither is ever produced by the model.
 */

/** Stable machine-readable refusal codes. Every code is documented in README.md. */
export const REFUSAL_CODES = Object.freeze({
  target_not_allowed: "the observed page is outside the profile's allowed targets",
  no_target: "no page target matched the profile",
  ambiguous_target: "more than one page target matched the profile and none was named",
  no_candidates: "the page exposes no candidate the profile recognizes",
  too_many_candidates: "the page exposes more recognized candidates than the bound allows",
  untrusted_profile: "execution requires a trusted profile; this profile only observes",
  unsupported_action: "the profile does not allow acting on the selected candidate",
  ambiguous_identity: "the decision cannot be bound to exactly one observed element",
  stale_snapshot: "the snapshot is older than the freshness bound",
  stale_target: "the session no longer refers to the target the decision was made on",
  changed_state: "the page changed between the decision and the execution gate",
  not_actionable: "the selected element is disabled or has no clickable box inside the viewport",
  text_mismatch: "the composer text read back from the page differs from the caller text beyond paragraph blank-line differences",
  destination_mismatch: "the page is not at the selected destination",
  duplicate_post: "the page already shows content carrying the caller's duplicate marker",
});

/** @typedef {keyof typeof REFUSAL_CODES} RefusalCode */

export class RefusalError extends Error {
  /**
   * @param {RefusalCode} code
   * @param {string} message
   * @param {Record<string, unknown>} [details] safe, structured facts for the report
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RefusalError";
    this.code = code;
    this.details = details;
  }
}

/** Connection-level or protocol-level failure while talking to the browser. */
export class TransportError extends Error {
  /**
   * @param {string} message
   * @param {{phase?: string, cause?: unknown}} [details]
   */
  constructor(message, { phase = "transport", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TransportError";
    this.code = "transport";
    this.phase = phase;
  }
}

/** The browser answered a CDP method with an error response. */
export class CdpProtocolError extends TransportError {
  /**
   * @param {string} method
   * @param {{code?: number, message?: string}} error
   * @param {string} [phase]
   */
  constructor(method, error, phase) {
    super(`${method}: ${error.message ?? "unknown CDP error"}`, { phase });
    this.name = "CdpProtocolError";
    this.method = method;
    this.cdpCode = typeof error.code === "number" ? error.code : null;
  }
}
