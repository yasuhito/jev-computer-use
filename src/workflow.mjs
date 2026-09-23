/**
 * The bounded browser message workflow: open one caller-named destination,
 * draft the caller's exact text into the conversation's composer, and submit
 * only on explicit request. Every semantic selection (which destination,
 * which composer, which send control) is one TypeSafe Jev Choice through the
 * existing decision core; every permission, threshold, freshness bound,
 * identity binding, exact-text comparison, and the decision to act at all is
 * deterministic code in this module and in CdpAdapter.
 *
 * Modes, in increasing authority:
 *   observe   snapshot only, no model call, no action
 *   dry-run   decisions only, no action (default)
 *   navigate  click the destination (unless the page is already exactly
 *             there) and verify the URL
 *   draft     navigate, then insert the text and verify the read-back
 *   send      draft, then click send and verify the message appeared
 */
import { validateRequest, ValidationError, isPlainObject } from "./validate.mjs";
import { buildRequest, runDecision } from "./decide.mjs";
import { applyPolicy } from "./policy.mjs";
import { RefusalError } from "./errors.mjs";
import { urlReached, sameUrl, assertFreshCandidate, editorValueIsEmpty, paragraphEqual } from "./cdp/adapter.mjs";

/** @typedef {import("./cdp/adapter.mjs").CdpAdapter} CdpAdapter */
/** @typedef {import("./cdp/adapter.mjs").Snapshot} Snapshot */
/** @typedef {import("./profiles/profile.mjs").Candidate} Candidate */
/** @typedef {import("./decide.mjs").DecideFn} DecideFn */

export const MODES = Object.freeze(["observe", "dry-run", "navigate", "draft", "send"]);
/** @typedef {"observe"|"dry-run"|"navigate"|"draft"|"send"} Mode */

/**
 * Acting in a browser is higher-stakes than reporting, so the default
 * threshold is stricter than jev-cu's 0.5 (TypeSafe confidence guidance:
 * thresholds scale with risk). Same value in dry-run so a dry-run predicts
 * exactly what an execution mode would do.
 */
export const DEFAULT_BROWSE_MIN_CONFIDENCE = 0.8;
export const MAX_TEXT_LENGTH = 4000;
export const MAX_DESTINATION_LENGTH = 200;

/** @typedef {"observed"|"selected"|"no_match"|"escalate"|"refused"|"executed"|"unverified"} WorkflowStatus */

/**
 * @param {unknown} text
 * @returns {string}
 * @throws {ValidationError}
 */
export function validateMessageText(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ValidationError("text must be a non-empty string", "invalid_text");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`text exceeds ${MAX_TEXT_LENGTH} characters`, "invalid_text");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(text)) {
    throw new ValidationError("text may not contain control characters other than newline and tab", "invalid_text");
  }
  return text;
}

/**
 * @param {unknown} destination
 * @returns {string}
 * @throws {ValidationError}
 */
export function validateDestination(destination) {
  if (typeof destination !== "string" || destination.trim().length === 0) {
    throw new ValidationError("destination must be a non-empty string", "invalid_destination");
  }
  const trimmed = destination.replace(/\s+/g, " ").trim();
  if (trimmed.length > MAX_DESTINATION_LENGTH) {
    throw new ValidationError(`destination exceeds ${MAX_DESTINATION_LENGTH} characters`, "invalid_destination");
  }
  return trimmed;
}

/**
 * Whether an observed destination name names exactly the requested
 * destination: the name is the requested string itself, or starts with it
 * and continues only with decoration that cannot belong to a name
 * (whitespace, a comma, or an opening bracket, ASCII or full-width).
 * "qa2-metrics (channel)", "qa2-metrics, 3 unread", and "qa2（チャンネル）"
 * match "qa2-metrics" and "qa2"; "qa2-metrics-old" and "qa2-metrics2" do
 * not. Comparison is case-sensitive after the same whitespace normalization
 * both sides already had.
 *
 * @param {string} name observed destination name
 * @param {string} requested normalized requested destination
 * @returns {boolean}
 */
export function destinationNameMatches(name, requested) {
  if (requested.length === 0) return false;
  if (name === requested) return true;
  if (!name.startsWith(requested)) return false;
  return /^[\s,([{（［｛]/.test(name.slice(requested.length));
}

/**
 * @param {Candidate} c
 */
function publicCandidate(c) {
  return { id: c.id, kind: c.kind, role: c.role, label: c.label, url: c.url, disabled: c.disabled };
}

/**
 * Usage accumulator: sums numeric token fields across decisions.
 * @param {{input_tokens: number, output_tokens: number, calls: number}} total
 * @param {object|null} usage
 */
function addUsage(total, usage) {
  total.calls += 1;
  if (!isPlainObject(usage)) return;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input === "number") total.input_tokens += input;
  if (typeof output === "number") total.output_tokens += output;
}

/**
 * Run one Jev Choice over candidates of one kind and apply the policy.
 *
 * @param {{step: string, goal: string, context: string, candidates: Candidate[], decide: DecideFn, threshold: number, maxCandidates: number}} input
 */
async function decideAmong({ step, goal, context, candidates, decide, threshold, maxCandidates }) {
  const request = validateRequest(
    { goal, context, candidates: candidates.map(({ id, role, label }) => ({ id, role, label })) },
    { maxCandidates },
  );
  const { model, normalized, usage } = await runDecision(buildRequest(request), { decide });
  const verdict = applyPolicy(normalized, request.candidates, threshold);
  const chosen = verdict.candidate ? candidates.find((c) => c.id === verdict.candidate?.id) ?? null : null;
  return {
    record: {
      step,
      phase: "decide",
      goal,
      status: verdict.status,
      model,
      decision: {
        choice: normalized.choice,
        confidence: normalized.confidence,
        probabilities: normalized.probabilities,
      },
      candidate: chosen ? publicCandidate(chosen) : null,
      reason: verdict.reason,
      offered: candidates.length,
    },
    status: verdict.status,
    chosen,
    usage,
  };
}

/**
 * A decision is made over labels, so it can only be bound to one element
 * when no other candidate of the same kind shares the label (for
 * destinations, shares the label while pointing elsewhere).
 *
 * @param {Candidate} chosen
 * @param {Candidate[]} candidates
 */
function assertUnambiguous(chosen, candidates) {
  const twin = candidates.find(
    (c) => c.id !== chosen.id && c.label === chosen.label && (chosen.url === null || c.url !== chosen.url),
  );
  if (twin) {
    throw new RefusalError(
      "ambiguous_identity",
      `label "${chosen.label}" belongs to more than one distinct ${chosen.kind} candidate`,
      { candidateIds: [chosen.id, twin.id] },
    );
  }
}

/**
 * @param {Snapshot} snapshot
 * @param {string} destinationUrl
 * @returns {{ok: true} | {ok: false, code: "destination_mismatch", reason: string}}
 */
function atDestination(snapshot, destinationUrl) {
  if (urlReached(snapshot.target.url, destinationUrl)) return { ok: true };
  return {
    ok: false,
    code: "destination_mismatch",
    reason: `page is at ${snapshot.target.url}, not at the selected destination ${destinationUrl}`,
  };
}

/**
 * The send-time composer check compares through the same canonical
 * paragraph-aware equality as the insertText read-back (see paragraphEqual
 * in CdpAdapter): the page's accessibility tree may read every paragraph
 * boundary as a blank line, so only blank-line differences are tolerated
 * and every non-empty line must match exactly and in order.
 *
 * @param {Snapshot} snapshot
 * @param {number} composerBackendNodeId
 * @param {string} text
 * @returns {{ok: true} | {ok: false, code: "text_mismatch", reason: string}}
 */
function composerHolds(snapshot, composerBackendNodeId, text) {
  const composer = snapshot.candidates.find((c) => c.backendNodeId === composerBackendNodeId);
  if (!composer) return { ok: false, code: "text_mismatch", reason: "the composer is no longer observable" };
  if (!paragraphEqual(composer.value, text)) {
    return { ok: false, code: "text_mismatch", reason: "the composer no longer holds the caller text" };
  }
  return { ok: true };
}

/**
 * @typedef {object} WorkflowReport
 * @property {Mode} mode
 * @property {string} profile
 * @property {boolean} trusted
 * @property {number} threshold
 * @property {WorkflowStatus} status
 * @property {"navigate"|"draft"|"send"|null} completed last workflow stage completed
 * @property {{id: string, url: string, title: string}|null} target
 * @property {{requested: string, candidate: ReturnType<typeof publicCandidate>|null}} destination
 * @property {string|null} text
 * @property {object[]} steps
 * @property {ReturnType<typeof publicCandidate>[]|null} candidates observe mode only
 * @property {{code: string, message: string, details: Record<string, unknown>}|null} refusal
 * @property {{input_tokens: number, output_tokens: number, calls: number}} usage
 */

/**
 * Run the workflow. RefusalErrors become a `refused` report; transport and
 * API failures propagate to the caller.
 *
 * Two optional caller guards tighten the workflow deterministically:
 * `exactDestination` requires the requested name to be exactly the leading
 * name of the chosen destination (see destinationNameMatches), so an
 * allowlisted name is never satisfied by a merely similar label;
 * `duplicateMarker` refuses to draft or send when the destination's currently
 * rendered accessibility tree contains the marker.
 * This is a best-effort preflight guard, not durable or atomic idempotency.
 *
 * @param {{mode: Mode, destination: string|null, text?: string|null, adapter: CdpAdapter, decide: DecideFn|null, threshold?: number, maxCandidates: number, exactDestination?: boolean, duplicateMarker?: string|null}} input
 * @returns {Promise<WorkflowReport>}
 */
export async function runWorkflow({
  mode,
  destination,
  text = null,
  adapter,
  decide,
  threshold = DEFAULT_BROWSE_MIN_CONFIDENCE,
  maxCandidates,
  exactDestination = false,
  duplicateMarker = null,
}) {
  const profile = adapter.profile;
  /** @type {WorkflowReport} */
  const report = {
    mode,
    profile: profile.name,
    trusted: profile.trusted,
    threshold,
    status: "refused",
    completed: null,
    target: null,
    destination: { requested: destination ?? "", candidate: null },
    text,
    steps: [],
    candidates: null,
    refusal: null,
    usage: { input_tokens: 0, output_tokens: 0, calls: 0 },
  };

  /**
   * @param {string} step
   * @param {string} goal
   * @param {string} context
   * @param {Candidate[]} candidates
   */
  const decideStep = async (step, goal, context, candidates) => {
    if (decide === null) throw new Error("a decide dependency is required beyond observe mode");
    if (candidates.length === 0) {
      throw new RefusalError("no_candidates", `the page exposes no ${step} candidate under profile ${profile.name}`);
    }
    const result = await decideAmong({ step, goal, context, candidates, decide, threshold, maxCandidates });
    report.steps.push(result.record);
    addUsage(report.usage, result.usage);
    if (result.status !== "selected" || result.chosen === null) {
      report.status = result.status === "selected" ? "escalate" : result.status;
      return null;
    }
    assertUnambiguous(result.chosen, candidates);
    return result.chosen;
  };

  /**
   * @param {Candidate} candidate
   * @param {import("./profiles/profile.mjs").ActionType} action
   * @param {Snapshot} snapshot
   */
  const assertAllowed = (candidate, action, snapshot) => {
    const allowed = profile.allowAction(candidate, action, snapshot.target);
    if (!allowed.ok) {
      throw new RefusalError("unsupported_action", allowed.reason ?? `${action} is not allowed`, {
        candidateId: candidate.id,
        action,
      });
    }
  };

  try {
    const first = await adapter.observe();
    report.target = { id: first.target.id, url: first.target.url, title: first.target.title };
    if (mode === "observe") {
      report.status = "observed";
      report.candidates = first.candidates.map(publicCandidate);
      return report;
    }
    if (destination === null) throw new Error("destination is required beyond observe mode");
    const pageContext = (/** @type {Snapshot} */ s) => `Page title: ${s.target.title || "(none)"}`;

    const destinations = first.candidates.filter((c) => c.kind === "destination");
    const chosenDestination = await decideStep(
      "destination",
      `Open the conversation the caller named "${destination}". Pick the destination whose label names that conversation.`,
      pageContext(first),
      destinations,
    );
    if (!chosenDestination) return report;
    if (chosenDestination.url === null) {
      throw new RefusalError("unsupported_action", "the selected destination has no URL to verify against");
    }
    if (exactDestination && !destinationNameMatches(chosenDestination.name, destination)) {
      throw new RefusalError(
        "destination_mismatch",
        `the selected destination is named "${chosenDestination.name}", which does not name exactly "${destination}"`,
        { candidateId: chosenDestination.id, requested: destination },
      );
    }
    report.destination.candidate = publicCandidate(chosenDestination);
    const destinationUrl = chosenDestination.url;

    if (mode === "dry-run") {
      // Speculative decisions over whatever the current page already shows,
      // so a dry-run previews the later stages without acting. Permission
      // outcomes are reported in the plan rather than refused, because the
      // page state before navigation (an empty composer, a disabled send
      // button) is not the state an execution mode would act on.
      /** @type {Record<string, unknown>} */
      const preview = {
        destination: { candidateId: chosenDestination.id, ...profile.allowAction(chosenDestination, "click", first.target) },
      };
      if (text !== null) {
        const composers = first.candidates.filter((c) => c.kind === "composer");
        if (composers.length > 0) {
          const composer = await decideStep(
            "composer",
            `Find the message composer where a new message to the conversation "${chosenDestination.name}" is typed.`,
            pageContext(first),
            composers,
          );
          if (composer) preview.composer = { candidateId: composer.id, ...profile.allowAction(composer, "insertText", first.target) };
        }
        const sends = first.candidates.filter((c) => c.kind === "send");
        if (sends.length > 0) {
          const send = await decideStep(
            "send",
            `Find the control that submits the drafted message to the conversation "${chosenDestination.name}".`,
            pageContext(first),
            sends,
          );
          if (send) preview.send = { candidateId: send.id, ...profile.allowAction(send, "click", first.target) };
        }
      }
      report.status = "selected";
      report.steps.push({
        step: "plan",
        phase: "plan",
        executable: profile.trusted,
        blocker: profile.trusted ? null : "untrusted_profile",
        actions: ["navigate", ...(text !== null ? ["draft"] : [])],
        guards: { exactDestination, duplicateMarker },
        preview,
      });
      return report;
    }

    // ---- navigate ----
    if (!profile.trusted) {
      throw new RefusalError("untrusted_profile", `profile ${profile.name} only observes; execution modes need a trusted profile`);
    }
    assertAllowed(chosenDestination, "click", first);
    if (sameUrl(first.target.url, destinationUrl)) {
      const fresh = await adapter.observe();
      if (fresh.target.id !== first.target.id || !sameUrl(fresh.target.url, destinationUrl)) {
        throw new RefusalError("changed_state", "page changed since the destination decision");
      }
      const candidate = assertFreshCandidate(first, fresh, chosenDestination);
      report.steps.push({
        step: "destination",
        phase: "verify",
        candidateId: candidate.id,
        backendNodeId: candidate.backendNodeId,
        alreadyAtDestination: true,
        url: fresh.target.url,
        verified: true,
      });
    } else {
      const navigated = await adapter.click(first, chosenDestination.id, { expectUrl: destinationUrl });
      report.steps.push({ step: "destination", phase: "act", ...navigated });
      report.completed = "navigate";
      if (!navigated.verified) {
        report.status = "unverified";
        return report;
      }
    }
    report.completed = "navigate";
    if (mode === "navigate") {
      report.status = "executed";
      return report;
    }
    if (text === null) throw new Error("text is required for draft and send modes");

    // ---- draft ----
    const atDest = await adapter.observe();
    const arrived = atDestination(atDest, destinationUrl);
    if (!arrived.ok) throw new RefusalError(arrived.code, arrived.reason);
    if (duplicateMarker !== null) {
      const existing = await adapter.findText(duplicateMarker, { match: "contains" });
      report.steps.push({ step: "duplicate", phase: "verify", marker: duplicateMarker, found: existing.count });
      if (existing.count > 0) {
        throw new RefusalError("duplicate_post", `the destination already shows ${existing.count} item(s) carrying the marker`, {
          marker: duplicateMarker,
          count: existing.count,
        });
      }
    }
    const composers = atDest.candidates.filter((c) => c.kind === "composer");
    const composer = await decideStep(
      "composer",
      `Find the message composer where a new message to the conversation "${chosenDestination.name}" is typed.`,
      `${pageContext(atDest)}; the page is at the selected destination`,
      composers,
    );
    if (!composer) return report;
    assertAllowed(composer, "insertText", atDest);
    const drafted = await adapter.insertText(atDest, composer.id, text, {
      require: (fresh) => atDestination(fresh, destinationUrl),
    });
    report.steps.push({ step: "composer", phase: "act", ...drafted });
    report.completed = "draft";
    if (mode === "draft") {
      report.status = "executed";
      return report;
    }

    // ---- send (explicit) ----
    const beforeSend = await adapter.observe();
    const stillThere = atDestination(beforeSend, destinationUrl);
    if (!stillThere.ok) throw new RefusalError(stillThere.code, stillThere.reason);
    const holds = composerHolds(beforeSend, composer.backendNodeId, text);
    if (!holds.ok) throw new RefusalError(holds.code, holds.reason);
    const sends = beforeSend.candidates.filter((c) => c.kind === "send");
    const sendControl = await decideStep(
      "send",
      `Find the control that submits the drafted message to the conversation "${chosenDestination.name}".`,
      `${pageContext(beforeSend)}; the composer holds the drafted message`,
      sends,
    );
    if (!sendControl) return report;
    assertAllowed(sendControl, "click", beforeSend);
    const sent = await adapter.click(beforeSend, sendControl.id, {
      require: (fresh) => {
        const here = atDestination(fresh, destinationUrl);
        if (!here.ok) return here;
        return composerHolds(fresh, composer.backendNodeId, text);
      },
    });
    report.steps.push({ step: "send", phase: "act", ...sent });
    report.completed = "send";

    // ---- verify the post ----
    const posted = await adapter.waitFor(async (snapshot) => {
      if (!urlReached(snapshot.target.url, destinationUrl)) return false;
      const composerNow = snapshot.candidates.find((c) => c.backendNodeId === composer.backendNodeId);
      // The same emptiness classification as insertText's precheck: a page
      // whose cleared composer keeps the exact single-U+000A blank editor
      // artifact counts as empty; every other nonempty value is a draft.
      if (!composerNow || !editorValueIsEmpty(composerNow.value)) return false;
      // The post verification compares under the canonical paragraph-aware
      // semantics (paragraphEqual/paragraphLines in CdpAdapter) within one
      // profile-declared message container: the real client renders each
      // paragraph of the posted message as its own accessibility node, so
      // the text's non-empty lines must be one contiguous run in tree order.
      // A missing, reordered, altered, or interleaved
      // non-empty line never verifies; unnamed container nodes around the
      // paragraphs never break the run.
      const found = await adapter.findText(text, { match: "sequence" });
      return found.count > 0;
    });
    report.steps.push({
      step: "posted",
      phase: "verify",
      verified: posted.ok,
      url: posted.snapshot.target.url,
    });
    report.status = posted.ok ? "executed" : "unverified";
    return report;
  } catch (err) {
    if (err instanceof RefusalError) {
      report.status = "refused";
      report.refusal = { code: err.code, message: err.message, details: err.details };
      return report;
    }
    throw err;
  }
}
