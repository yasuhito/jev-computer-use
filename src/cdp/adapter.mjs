/**
 * CdpAdapter: the application-agnostic boundary between the decision core
 * and a Chrome DevTools Protocol page target.
 *
 * It knows only generic browser concepts: a page target, its accessibility
 * tree reduced to role/name/contents/url/value facts, element attributes for
 * the roles a profile asks for, the text of a DOM subtree whose non-text
 * elements (emoji images) a profile proves, box models, hit testing, and two typed input
 * actions (a single left click, and inserting exact text into the focused
 * editable). Application semantics (which links or rows are destinations,
 * which textbox is a composer, which button sends) and permissions come from
 * an injected Profile; the adapter enforces the profile but never extends it.
 *
 * Every action passes the same deterministic gate immediately before it runs:
 * trusted profile, profile permission, snapshot freshness, a fresh
 * re-observation with the same target id, URL, and recognized-candidate
 * digest, the same element identity, an enabled element with a clickable box
 * inside the viewport, and a hit test resolving to that element. Any failure
 * is a RefusalError; nothing is dispatched.
 *
 * The set of CDP methods this module may send is closed (ALLOWED_CDP_METHODS).
 * Runtime.evaluate, key events, navigation, network, storage, and every other
 * method are refused before reaching the transport.
 */
import { createHash } from "node:crypto";
import { RefusalError, TransportError, CdpProtocolError } from "../errors.mjs";
import { DEFAULT_MAX_CANDIDATES, sanitizeLabel } from "../validate.mjs";
import { parseUrl } from "../profiles/profile.mjs";

/** @typedef {import("../profiles/profile.mjs").Profile} Profile */
/** @typedef {import("../profiles/profile.mjs").ObservedTarget} ObservedTarget */
/** @typedef {import("../profiles/profile.mjs").ObservedNode} ObservedNode */
/** @typedef {import("../profiles/profile.mjs").Candidate} Candidate */
/** @typedef {import("../profiles/profile.mjs").ActionType} ActionType */
/** @typedef {import("../profiles/profile.mjs").DomElementFacts} DomElementFacts */

/**
 * A page-bound CDP session. The real one lives in transport.mjs; tests inject
 * a fake with the same shape.
 * @typedef {object} CdpSession
 * @property {string|null} targetId
 * @property {(method: string, params?: Record<string, unknown>) => Promise<any>} send
 * @property {() => Promise<void>|void} close
 */

/**
 * @typedef {object} Snapshot
 * @property {ObservedTarget} target
 * @property {number} observedAt epoch milliseconds from the injected clock
 * @property {string} profile
 * @property {number} nodeCount accessibility nodes considered
 * @property {Candidate[]} candidates
 * @property {string} digest sha256 over (kind, role, name, url) of every candidate in order
 */

/**
 * A caller-supplied check evaluated on the fresh re-observation inside the
 * execution gate, so workflow-level facts (the page is still at the chosen
 * destination, the composer still holds the text under the canonical
 * paragraph-aware comparison) are revalidated
 * immediately before dispatch. Returning a refusal aborts the action.
 * @typedef {{ok: true} | {ok: false, code: import("../errors.mjs").RefusalCode, reason: string}} Verdict
 * @typedef {(fresh: Snapshot) => Verdict | Promise<Verdict>} Precondition
 */

/** The only CDP methods this adapter can ever send. */
export const ALLOWED_CDP_METHODS = Object.freeze([
  "Target.getTargetInfo",
  "DOM.enable",
  "Accessibility.enable",
  "DOM.getDocument",
  "Accessibility.getFullAXTree",
  "DOM.describeNode",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.getBoxModel",
  "Page.getLayoutMetrics",
  "DOM.getNodeForLocation",
  "Input.dispatchMouseEvent",
  "Input.insertText",
]);
const ALLOWED = new Set(ALLOWED_CDP_METHODS);

/** A decision must be acted on within this many milliseconds of its snapshot. */
export const DEFAULT_MAX_SNAPSHOT_AGE_MS = 20_000;
/** How long to wait for the page to reflect an action. */
export const DEFAULT_SETTLE_MS = 5_000;
export const DEFAULT_SETTLE_POLL_MS = 100;
/** Bound on the raw value text kept per node. */
export const MAX_VALUE_LENGTH = 8_000;
/**
 * Bound on the nodes whose element attributes one observation may fetch
 * (one DOM.describeNode each); beyond it the observation is refused rather
 * than made unboundedly slow by a page full of the profile's attribute roles.
 */
export const MAX_ATTRIBUTE_LOOKUPS = 256;

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {unknown} raw
 * @param {string} contentText
 * @returns {ObservedNode|null}
 */
function reduceAxNode(raw, contentText) {
  if (typeof raw !== "object" || raw === null) return null;
  const node = /** @type {Record<string, any>} */ (raw);
  if (node.ignored === true) return null;
  const backendNodeId = node.backendDOMNodeId;
  if (typeof backendNodeId !== "number") return null;
  const role = typeof node.role?.value === "string" ? node.role.value.toLowerCase() : "";
  const name = sanitizeLabel(typeof node.name?.value === "string" ? node.name.value : "");
  const value =
    typeof node.value?.value === "string" ? node.value.value.slice(0, MAX_VALUE_LENGTH) : null;
  let url = null;
  let disabled = false;
  let focused = false;
  if (Array.isArray(node.properties)) {
    for (const property of node.properties) {
      const propertyName = property?.name;
      const propertyValue = property?.value?.value;
      if (propertyName === "url" && typeof propertyValue === "string") url = propertyValue;
      else if (propertyName === "disabled") disabled = propertyValue === true;
      else if (propertyName === "focused") focused = propertyValue === true;
    }
  }
  return { backendNodeId, role, name, contentText, url, value, disabled, focused, attributes: {} };
}

/**
 * Reduce a full accessibility tree to observed nodes. The contents text of a
 * node is the whitespace-joined text of its static-text descendants, walked
 * through ignored nodes too, since the browser may leave a container's
 * accessible name empty while its visible text sits below it.
 *
 * @param {unknown[]} rawNodes
 * @returns {ObservedNode[]}
 */
function reduceAxTree(rawNodes) {
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  for (const raw of rawNodes) {
    if (typeof raw !== "object" || raw === null) continue;
    const node = /** @type {Record<string, any>} */ (raw);
    if (typeof node.nodeId === "string") byId.set(node.nodeId, node);
  }
  /** @type {Map<string, string>} */
  const memo = new Map();
  /** @param {string} nodeId */
  const contentText = (nodeId) => {
    const known = memo.get(nodeId);
    if (known !== undefined) return known;
    memo.set(nodeId, ""); // cycle guard; the tree has none but the protocol does not promise it
    const node = byId.get(nodeId);
    let text = "";
    if (node) {
      const role = typeof node.role?.value === "string" ? node.role.value.toLowerCase() : "";
      if (role === "statictext") {
        text = typeof node.name?.value === "string" ? node.name.value : "";
      } else if (Array.isArray(node.childIds)) {
        text = node.childIds
          .map((childId) => (typeof childId === "string" ? contentText(childId) : ""))
          .filter((part) => part.length > 0)
          .join(" ");
      }
    }
    text = sanitizeLabel(text);
    memo.set(nodeId, text);
    return text;
  };
  /** @type {ObservedNode[]} */
  const nodes = [];
  for (const raw of rawNodes) {
    const nodeId = typeof raw === "object" && raw !== null ? /** @type {Record<string, any>} */ (raw).nodeId : undefined;
    const node = reduceAxNode(raw, typeof nodeId === "string" ? contentText(nodeId) : "");
    if (node) nodes.push(node);
  }
  return nodes;
}

/**
 * @param {unknown} described a DOM.Node from DOM.describeNode
 * @returns {Record<string, string>}
 */
function reduceAttributes(described) {
  /** @type {Record<string, string>} */
  const attributes = {};
  const flat = typeof described === "object" && described !== null ? /** @type {Record<string, any>} */ (described).attributes : null;
  if (!Array.isArray(flat)) return attributes;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const name = flat[i];
    const value = flat[i + 1];
    if (typeof name === "string" && typeof value === "string") attributes[name] = value;
  }
  return attributes;
}

/** Elements whose content is not text; unless a profile proves their text, they are unresolved. */
const OPAQUE_ELEMENTS = new Set(["IMG", "SVG", "CANVAS", "PICTURE", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED"]);
/** Elements laid out as blocks: their boundaries are line boundaries. */
const BLOCK_ELEMENTS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE",
  "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
/** Elements that never render text. */
const SKIPPED_ELEMENTS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
/** Stands in for an unresolved element, on a line of its own, in DomText. */
export const UNRESOLVED_INLINE = "\uFFFC";

/**
 * @typedef {object} DomText
 * @property {string} text the subtree's text with every profile-proven inline element replaced by its proven text
 * @property {string} plain the same text with those replacements left out, which is what the accessibility layer reads
 * @property {number} replaced proven inline elements
 * @property {number} unresolved opaque or unproven elements, each an UNRESOLVED_INLINE line in text and plain
 */

/**
 * Reconstruct the text of a DOM subtree (a DOM.Node from DOM.describeNode
 * with depth -1), below the root: text nodes contribute their data, `<br>`
 * and block boundaries contribute LF, and an element the resolver proves
 * contributes the proven text in place (and nothing to `plain`). An element
 * the resolver marks unproven, an opaque element it leaves alone, and a
 * proven element with text of its own are unresolved. Nothing else is
 * normalized; callers compare the result through paragraphEqual or
 * paragraphLines.
 *
 * @param {unknown} root
 * @param {(element: DomElementFacts) => string|null|undefined} resolve
 * @returns {DomText}
 */
export function domText(root, resolve) {
  const out = { text: "", plain: "", replaced: 0, unresolved: 0 };
  /** @param {string} both */
  const append = (both) => {
    out.text += both;
    out.plain += both;
  };
  /** @param {unknown} node @returns {boolean} */
  const hasText = (node) => {
    const record = /** @type {Record<string, any>} */ (node);
    if (record?.nodeType === 3) return typeof record.nodeValue === "string" && record.nodeValue !== "";
    return Array.isArray(record?.children) && record.children.some(hasText);
  };
  /** @param {unknown} node */
  const walkChildren = (node) => {
    const children = /** @type {Record<string, any>} */ (node)?.children;
    if (Array.isArray(children)) for (const child of children) walk(child);
  };
  /** @param {unknown} node */
  const walk = (node) => {
    if (typeof node !== "object" || node === null) return;
    const record = /** @type {Record<string, any>} */ (node);
    if (record.nodeType === 3) {
      if (typeof record.nodeValue === "string") append(record.nodeValue);
      return;
    }
    if (record.nodeType !== 1) return;
    const nodeName = typeof record.nodeName === "string" ? record.nodeName.toUpperCase() : "";
    if (SKIPPED_ELEMENTS.has(nodeName)) return;
    if (nodeName === "BR") {
      append("\n");
      return;
    }
    const proven = resolve({ nodeName, attributes: Object.freeze(reduceAttributes(record)) });
    if (typeof proven === "string" && proven !== "" && !proven.includes("\n") && !proven.includes(UNRESOLVED_INLINE) && !hasText(record)) {
      out.text += proven;
      out.replaced += 1;
      return;
    }
    if (proven !== undefined || OPAQUE_ELEMENTS.has(nodeName)) {
      append(`\n${UNRESOLVED_INLINE}\n`);
      out.unresolved += 1;
      return;
    }
    const block = BLOCK_ELEMENTS.has(nodeName);
    if (block) append("\n");
    walkChildren(record);
    if (block) append("\n");
  };
  walkChildren(root);
  return out;
}

/**
 * @param {Candidate[]} candidates
 * @returns {string}
 */
export function digestCandidates(candidates) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(candidates.map((c) => [c.kind, c.role, c.name, c.url])));
  return hash.digest("hex");
}

/**
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

/**
 * Composer/editor emptiness classification. A visually empty rich-text
 * editor does not always report an exact "": Chromium reports the
 * accessibility value of a blank contenteditable as a single newline
 * (U+000A), so an exact "" comparison would read the blank editor as an
 * existing draft. Only an absent value, an empty string, or that exact
 * single-newline artifact is empty. This classifies the observed value only -
 * the text an action inserts is never normalized or trimmed by it.
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function editorValueIsEmpty(value) {
  return value == null || value === "" || value === "\n";
}

/**
 * The canonical paragraph-aware text equality for every safety comparison
 * against page-read text: the insertText read-back, the send-time composer
 * check, and the post-verification sequence match all compare through this
 * one helper and through paragraphLines.
 *
 * A rich-text editor lays each paragraph out as its own block, and the
 * browser's accessibility tree reads every block boundary as a blank line,
 * so text typed as "p1\np2" reads back as "p1\n\np2". Both strings are
 * therefore split on LF (U+000A), only the empty segments are dropped, and
 * every remaining line must match exactly and in order. Nothing else is
 * normalized: spaces, tabs, NBSP, BOM, non-empty text, line order, and the
 * count of non-empty lines all matter. A null or undefined read never
 * equals.
 *
 * @param {string|null|undefined} actual
 * @param {string|null|undefined} expected
 * @returns {boolean}
 */
export function paragraphEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualLines = paragraphLines(actual);
  const expectedLines = paragraphLines(expected);
  return actualLines.length === expectedLines.length && actualLines.every((line, index) => line === expectedLines[index]);
}

/**
 * The canonical non-empty line split every paragraph-aware comparison is
 * built on: a string is split on LF (U+000A) and only the empty segments
 * are dropped. A null or undefined read contributes no lines. Nothing else
 * is normalized: spaces, tabs, NBSP, BOM, non-empty text, and line order
 * all matter.
 *
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
export function paragraphLines(text) {
  return typeof text === "string" ? text.split("\n").filter((line) => line !== "") : [];
}

/**
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
export function urlReached(actual, expected) {
  const a = normalizeUrl(actual);
  const e = normalizeUrl(expected);
  return a === e || a.startsWith(`${e}/`);
}

/**
 * Whether two URLs name exactly the same page (trailing slashes aside),
 * unlike urlReached, which also accepts deeper paths under the expected one.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameUrl(a, b) {
  return normalizeUrl(a) === normalizeUrl(b);
}

/**
 * @param {Snapshot} snapshot
 * @param {Snapshot} fresh
 * @param {Candidate} decided
 * @returns {Candidate}
 */
export function assertFreshCandidate(snapshot, fresh, decided) {
  if (fresh.digest !== snapshot.digest) {
    throw new RefusalError("changed_state", "the recognized candidates changed since the decision", {
      before: snapshot.candidates.length,
      after: fresh.candidates.length,
    });
  }
  const candidate = fresh.candidates.find((c) => c.backendNodeId === decided.backendNodeId);
  if (
    !candidate ||
    candidate.role !== decided.role ||
    candidate.name !== decided.name ||
    candidate.url !== decided.url ||
    candidate.kind !== decided.kind
  ) {
    throw new RefusalError("changed_state", `element ${decided.backendNodeId} no longer matches the decided candidate`);
  }
  return candidate;
}

/**
 * @param {unknown} node
 * @param {Set<number>} into
 */
function collectBackendNodeIds(node, into) {
  if (typeof node !== "object" || node === null) return;
  const record = /** @type {Record<string, any>} */ (node);
  if (typeof record.backendNodeId === "number") into.add(record.backendNodeId);
  if (Array.isArray(record.children)) {
    for (const child of record.children) collectBackendNodeIds(child, into);
  }
  if (Array.isArray(record.shadowRoots)) {
    for (const child of record.shadowRoots) collectBackendNodeIds(child, into);
  }
  if (record.contentDocument) collectBackendNodeIds(record.contentDocument, into);
}

export class CdpAdapter {
  /** @type {CdpSession} */ #session;
  /** @type {Profile} */ #profile;
  /** @type {() => number} */ #now;
  /** @type {(ms: number) => Promise<void>} */ #sleep;
  #maxCandidates;
  #maxSnapshotAgeMs;
  #settleMs;
  #settlePollMs;
  #enabled = false;

  /**
   * @param {{session: CdpSession, profile: Profile, now?: () => number, sleep?: (ms: number) => Promise<void>, maxCandidates?: number, maxSnapshotAgeMs?: number, settleMs?: number, settlePollMs?: number}} options
   */
  constructor({
    session,
    profile,
    now = Date.now,
    sleep = defaultSleep,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    maxSnapshotAgeMs = DEFAULT_MAX_SNAPSHOT_AGE_MS,
    settleMs = DEFAULT_SETTLE_MS,
    settlePollMs = DEFAULT_SETTLE_POLL_MS,
  }) {
    this.#session = session;
    this.#profile = profile;
    this.#now = now;
    this.#sleep = sleep;
    this.#maxCandidates = maxCandidates;
    this.#maxSnapshotAgeMs = maxSnapshotAgeMs;
    this.#settleMs = settleMs;
    this.#settlePollMs = settlePollMs;
  }

  get profile() {
    return this.#profile;
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [phase]
   * @returns {Promise<any>}
   */
  async #send(method, params = {}, phase = "observe") {
    if (!ALLOWED.has(method)) {
      throw new Error(`CdpAdapter refuses to send CDP method ${method}: not in ALLOWED_CDP_METHODS`);
    }
    try {
      return await this.#session.send(method, params);
    } catch (err) {
      if (err instanceof TransportError) {
        if (err.phase === "transport") err.phase = phase;
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new TransportError(`${method} failed: ${message}`, { phase, cause: err });
    }
  }

  async #ensureEnabled() {
    if (this.#enabled) return;
    await this.#send("DOM.enable");
    await this.#send("Accessibility.enable");
    this.#enabled = true;
  }

  /**
   * @returns {Promise<ObservedTarget>}
   */
  async #target() {
    const { targetInfo } = await this.#send("Target.getTargetInfo");
    const url = typeof targetInfo?.url === "string" ? targetInfo.url : "";
    const parsed = parseUrl(url);
    return {
      id: typeof targetInfo?.targetId === "string" ? targetInfo.targetId : "",
      url,
      origin: parsed ? parsed.origin : "null",
      title: sanitizeLabel(typeof targetInfo?.title === "string" ? targetInfo.title : ""),
    };
  }

  /**
   * Observe the target: identity, then a bounded list of candidates the
   * profile recognizes from the accessibility tree.
   *
   * @returns {Promise<Snapshot>}
   */
  async observe() {
    await this.#ensureEnabled();
    const target = await this.#target();
    const expectedId = this.#session.targetId;
    if (expectedId !== null && target.id !== expectedId) {
      throw new RefusalError("stale_target", `session target ${expectedId} now reports ${target.id}`);
    }
    const check = this.#profile.checkTarget(target);
    if (!check.ok) {
      throw new RefusalError("target_not_allowed", check.reason ?? "target rejected by profile", {
        url: target.url,
      });
    }
    await this.#send("DOM.getDocument", { depth: 0 });
    const { nodes } = await this.#send("Accessibility.getFullAXTree");
    const observed = reduceAxTree(Array.isArray(nodes) ? nodes : []);
    const attributeRoles = this.#profile.attributeRoles;
    if (attributeRoles !== undefined && attributeRoles.size > 0) {
      const wanting = observed.filter((node) => attributeRoles.has(node.role));
      if (wanting.length > MAX_ATTRIBUTE_LOOKUPS) {
        throw new RefusalError(
          "too_many_candidates",
          `${wanting.length} nodes carry the profile's attribute roles; the bound is ${MAX_ATTRIBUTE_LOOKUPS}`,
        );
      }
      for (const node of wanting) {
        const { node: described } = await this.#send("DOM.describeNode", { backendNodeId: node.backendNodeId, depth: 0 });
        node.attributes = Object.freeze(reduceAttributes(described));
      }
    }
    /** @type {Candidate[]} */
    const candidates = [];
    for (const node of observed) {
      const recognized = this.#profile.recognize(node, target);
      if (!recognized) continue;
      if (candidates.length >= this.#maxCandidates) {
        throw new RefusalError(
          "too_many_candidates",
          `more than ${this.#maxCandidates} recognized candidates; raise --max-candidates or narrow the profile`,
        );
      }
      candidates.push({
        id: `n${node.backendNodeId}`,
        kind: recognized.kind,
        role: node.role,
        label: sanitizeLabel(recognized.label),
        name: recognized.name === undefined ? node.name : sanitizeLabel(recognized.name),
        url: recognized.url === undefined ? node.url : recognized.url,
        value: node.value,
        disabled: node.disabled,
        backendNodeId: node.backendNodeId,
        attributes: node.attributes,
      });
    }
    return {
      target,
      observedAt: this.#now(),
      profile: this.#profile.name,
      nodeCount: observed.length,
      candidates,
      digest: digestCandidates(candidates),
    };
  }

  /**
   * The execution gate. Returns the freshly re-observed candidate or throws
   * a RefusalError. Never dispatches input.
   *
   * @param {Snapshot} snapshot
   * @param {string} candidateId
   * @param {ActionType} action
   * @param {Precondition|null} require
   * @returns {Promise<{fresh: Snapshot, candidate: Candidate}>}
   */
  async #gate(snapshot, candidateId, action, require) {
    const decided = snapshot.candidates.find((c) => c.id === candidateId);
    if (!decided) throw new Error(`candidate ${candidateId} is not in the snapshot`);
    if (!this.#profile.trusted) {
      throw new RefusalError("untrusted_profile", `profile ${this.#profile.name} is not trusted for execution`);
    }
    const allowed = this.#profile.allowAction(decided, action, snapshot.target);
    if (!allowed.ok) {
      throw new RefusalError("unsupported_action", allowed.reason ?? `${action} not allowed`, {
        candidateId,
        action,
      });
    }
    const age = this.#now() - snapshot.observedAt;
    if (age > this.#maxSnapshotAgeMs) {
      throw new RefusalError("stale_snapshot", `snapshot is ${age} ms old; bound is ${this.#maxSnapshotAgeMs} ms`);
    }
    const fresh = await this.observe();
    if (fresh.target.id !== snapshot.target.id) {
      throw new RefusalError("stale_target", `target changed from ${snapshot.target.id} to ${fresh.target.id}`);
    }
    if (fresh.target.url !== snapshot.target.url) {
      throw new RefusalError("changed_state", `page URL changed from ${snapshot.target.url} to ${fresh.target.url}`);
    }
    const candidate = assertFreshCandidate(snapshot, fresh, decided);
    if (candidate.disabled) {
      throw new RefusalError("not_actionable", `${candidate.label} is disabled`);
    }
    const stillAllowed = this.#profile.allowAction(candidate, action, fresh.target);
    if (!stillAllowed.ok) {
      throw new RefusalError("unsupported_action", stillAllowed.reason ?? `${action} not allowed`);
    }
    if (require !== null) {
      const verdict = await require(fresh);
      if (!verdict.ok) throw new RefusalError(verdict.code, verdict.reason);
    }
    return { fresh, candidate };
  }

  /**
   * Resolve the click point for an element and prove the point hits it.
   *
   * @param {Candidate} candidate
   * @returns {Promise<{x: number, y: number}>}
   */
  async #locate(candidate) {
    const { backendNodeId } = candidate;
    let model;
    try {
      await this.#send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, "locate");
      ({ model } = await this.#send("DOM.getBoxModel", { backendNodeId }, "locate"));
    } catch (err) {
      if (err instanceof CdpProtocolError) {
        throw new RefusalError("not_actionable", `${candidate.label} has no box model: ${err.message}`);
      }
      throw err;
    }
    const quad = Array.isArray(model?.content) ? model.content : [];
    if (quad.length !== 8 || !(model.width > 0) || !(model.height > 0)) {
      throw new RefusalError("not_actionable", `${candidate.label} has an empty box`);
    }
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < 8; i += 2) {
      sx += Number(quad[i]);
      sy += Number(quad[i + 1]);
    }
    const x = Math.round(sx / 4);
    const y = Math.round(sy / 4);
    const { cssVisualViewport, cssLayoutViewport } = await this.#send("Page.getLayoutMetrics", {}, "locate");
    const viewport = cssVisualViewport ?? cssLayoutViewport;
    const width = Number(cssLayoutViewport?.clientWidth);
    const height = Number(cssLayoutViewport?.clientHeight);
    if (!(x >= 0 && y >= 0 && x < width && y < height)) {
      throw new RefusalError("not_actionable", `${candidate.label} center (${x}, ${y}) is outside the viewport`);
    }
    const hit = await this.#send(
      "DOM.getNodeForLocation",
      {
        x: x + Number(viewport?.pageX ?? 0),
        y: y + Number(viewport?.pageY ?? 0),
        includeUserAgentShadowDOM: false,
      },
      "locate",
    );
    const hitId = hit?.backendNodeId;
    if (hitId !== backendNodeId) {
      const { node } = await this.#send("DOM.describeNode", { backendNodeId, depth: -1 }, "locate");
      const subtree = new Set();
      collectBackendNodeIds(node, subtree);
      if (typeof hitId !== "number" || !subtree.has(hitId)) {
        throw new RefusalError(
          "ambiguous_identity",
          `the point (${x}, ${y}) resolves to element ${String(hitId)}, not to ${candidate.label}`,
        );
      }
    }
    return { x, y };
  }

  /**
   * @param {{x: number, y: number}} point
   */
  async #leftClick({ x, y }) {
    const base = { x, y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 };
    await this.#send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 0 }, "execute");
    await this.#send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, "execute");
    await this.#send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, "execute");
  }

  /**
   * Perform exactly one left click on a decided candidate. When expectUrl is
   * given, wait up to the settle window for the page to reach it.
   *
   * @param {Snapshot} snapshot
   * @param {string} candidateId
   * @param {{expectUrl?: string|null, require?: Precondition|null}} [options]
   * @returns {Promise<{action: "click", candidateId: string, backendNodeId: number, point: {x: number, y: number}, urlBefore: string, urlAfter: string, verified: boolean|null}>}
   */
  async click(snapshot, candidateId, { expectUrl = null, require = null } = {}) {
    const { fresh, candidate } = await this.#gate(snapshot, candidateId, "click", require);
    const point = await this.#locate(candidate);
    await this.#leftClick(point);
    /** @type {string} */
    let urlAfter;
    /** @type {boolean|null} */
    let verified = null;
    if (expectUrl !== null) {
      verified = false;
      const started = this.#now();
      for (;;) {
        urlAfter = (await this.#target()).url;
        if (urlReached(urlAfter, expectUrl)) {
          verified = true;
          break;
        }
        if (this.#now() - started >= this.#settleMs) break;
        await this.#sleep(this.#settlePollMs);
      }
    } else {
      urlAfter = (await this.#target()).url;
    }
    return {
      action: "click",
      candidateId,
      backendNodeId: candidate.backendNodeId,
      point,
      urlBefore: fresh.target.url,
      urlAfter,
      verified,
    };
  }

  /**
   * Describe a node's whole DOM subtree, or null when the node is gone.
   *
   * @param {number} backendNodeId
   * @returns {Promise<unknown>}
   */
  async #describeTree(backendNodeId) {
    try {
      const { node } = await this.#send("DOM.describeNode", { backendNodeId, depth: -1 });
      return node ?? null;
    } catch (err) {
      if (err instanceof CdpProtocolError) return null;
      throw err;
    }
  }

  /**
   * Whether an editable holds exactly the text, for the insertText read-back
   * and the send-time composer check. Read-only.
   *
   * Without a profile inlineText, this is paragraphEqual on the
   * accessibility value. With one, the editable's DOM is read too, because
   * the browser never reads an image into an editable's accessibility
   * value: a page that renders a typed emoji as an image reads back without
   * it. The DOM text (domText) must hold no unresolved element; when it
   * holds no proven inline element, the accessibility value alone decides as
   * before; otherwise the accessibility value must equal the DOM text with
   * the proven elements left out (so every non-emoji character is the
   * browser's own reading, in place) and the DOM text with each proven
   * element canonicalized to its text must equal the caller text. Both
   * comparisons go through paragraphEqual, so a missing, extra, changed, or
   * moved emoji or character refuses as before.
   *
   * @param {number} backendNodeId
   * @param {string|null} value the editable's accessibility value
   * @param {string} text
   * @returns {Promise<{ok: boolean, inlineReplacements: number, reason: string|null}>}
   */
  async editorHolds(backendNodeId, value, text) {
    const resolve = this.#profile.inlineText;
    if (resolve === undefined) {
      const ok = paragraphEqual(value, text);
      return { ok, inlineReplacements: 0, reason: ok ? null : "the accessibility value differs from the text" };
    }
    const described = await this.#describeTree(backendNodeId);
    if (described === null) return { ok: false, inlineReplacements: 0, reason: "the editable's contents cannot be described" };
    const dom = domText(described, resolve);
    if (dom.unresolved > 0) {
      return { ok: false, inlineReplacements: dom.replaced, reason: `${dom.unresolved} element(s) in the editable have no provable text` };
    }
    if (dom.replaced === 0) {
      const ok = paragraphEqual(value, text);
      return { ok, inlineReplacements: 0, reason: ok ? null : "the accessibility value differs from the text" };
    }
    if (!paragraphEqual(value, dom.plain)) {
      return { ok: false, inlineReplacements: dom.replaced, reason: "the accessibility value disagrees with the editable's DOM text" };
    }
    const ok = paragraphEqual(dom.text, text);
    return { ok, inlineReplacements: dom.replaced, reason: ok ? null : "the editable's text with proven inline elements differs from the text" };
  }

  /**
   * Focus a decided editable candidate with one click and insert exact text,
   * then read the value back and require it to equal the text under the
   * canonical paragraph-aware comparison (editorHolds, built on
   * paragraphEqual): only blank-line paragraph-boundary differences are
   * tolerated, every non-empty line must match exactly and in order, and an
   * inline element counts only as the text the profile proves it stands for.
   * The editable must be empty beforehand: an absent value, an empty string,
   * or Chromium's exact single-U+000A blank-editor artifact counts as empty;
   * every other value refuses.
   *
   * @param {Snapshot} snapshot
   * @param {string} candidateId
   * @param {string} text
   * @param {{require?: Precondition|null}} [options]
   * @returns {Promise<{action: "insertText", candidateId: string, backendNodeId: number, point: {x: number, y: number}, textLength: number, readBack: string|null, inlineReplacements: number, verified: true}>}
   */
  async insertText(snapshot, candidateId, text, { require = null } = {}) {
    const { fresh, candidate } = await this.#gate(snapshot, candidateId, "insertText", require);
    const focusAllowed = this.#profile.allowAction(candidate, "click", fresh.target);
    if (!focusAllowed.ok) {
      throw new RefusalError("unsupported_action", focusAllowed.reason ?? "focus click not allowed");
    }
    if (!editorValueIsEmpty(candidate.value)) {
      throw new RefusalError("text_mismatch", `${candidate.label} already contains text; refusing to append`, {
        readBack: candidate.value,
      });
    }
    const point = await this.#locate(candidate);
    await this.#leftClick(point);
    await this.#send("Input.insertText", { text }, "execute");
    const started = this.#now();
    /** @type {string|null} */
    let readBack;
    /** @type {number} */
    let inlineReplacements;
    for (;;) {
      const after = await this.observe();
      const current = after.candidates.find((c) => c.backendNodeId === candidate.backendNodeId);
      readBack = current ? current.value : null;
      const check = current
        ? await this.editorHolds(current.backendNodeId, readBack, text)
        : { ok: false, inlineReplacements: 0, reason: "the editable is no longer observable" };
      inlineReplacements = check.inlineReplacements;
      if (check.ok) break;
      if (this.#now() - started >= this.#settleMs) {
        throw new RefusalError("text_mismatch", `${candidate.label} reads back differently from the requested text`, {
          readBack,
          expectedLength: text.length,
          reason: check.reason,
        });
      }
      await this.#sleep(this.#settlePollMs);
    }
    return {
      action: "insertText",
      candidateId,
      backendNodeId: candidate.backendNodeId,
      point,
      textLength: text.length,
      readBack,
      inlineReplacements,
      verified: true,
    };
  }

  /**
   * Count accessibility nodes matching the text. Read-only; used to verify
   * that a message appeared on the page and to detect that content carrying
   * a caller's marker is already present.
   *
   * `exact` (the default) compares one node at a time: the raw accessible
   * name against the raw text through the canonical paragraph-aware
   * equality (paragraphEqual), or a container whose direct paragraph
   * children carry the paragraphs as their accessible names through their
   * blank-line join. Only blank-line paragraph-boundary differences are
   * tolerated, and every non-empty line must match exactly and in order.
   *
   * `sequence` compares within one profile-declared container, for the
   * post-send verification of a message the page renders as separate
   * paragraph elements: the text's non-empty lines (paragraphLines) must
   * appear as one contiguous run in accessibility-tree order. A single node
   * may also carry the whole sequence. A
   * node's name contributes its lines when it is a StaticText leaf, or when
   * no StaticText descendant carries the same text (Chromium derives such
   * containers' names from their contents, so counting both would read the
   * text twice and break the run). The same strict paragraph-aware
   * semantics as paragraphEqual apply line by line: spaces, tabs, NBSP,
   * BOM, wording, line order, and the count of non-empty lines are never
   * normalized, and a match is broken by any missing, reordered, altered, or
   * interleaved non-empty line. Nodes that contribute no line never break a
   * run, so the unnamed containers around the paragraphs are unrelated, not
   * content. The matched nodes are the distinct nodes carrying the matched lines.
   * When no accessibility run matches and the profile supplies inlineText,
   * a container whose rendering replaced characters with proven elements
   * (emoji images) can match through its DOM text instead; see
   * #sequenceInProvenInlineText. The matched node is then the container.
   *
   * `contains` keeps its containment semantics: it compares the
   * whitespace-collapsed name against the whitespace-collapsed text and is
   * what the duplicate-marker guard uses.
   *
   * @param {string} text
   * @param {{match?: "exact"|"contains"|"sequence"}} [options]
   * @returns {Promise<{count: number, backendNodeIds: number[]}>}
   */
  async findText(text, { match = "exact" } = {}) {
    await this.#ensureEnabled();
    const wanted = sanitizeLabel(text, MAX_VALUE_LENGTH);
    if (wanted.length === 0) return { count: 0, backendNodeIds: [] };
    const { nodes } = await this.#send("Accessibility.getFullAXTree");
    const raws = Array.isArray(nodes) ? nodes : [];
    const byId = new Map(
      raws
        .filter((node) => typeof node?.nodeId === "string")
        .map((node) => [node.nodeId, node]),
    );
    /** @param {Record<string, any>} raw */
    const paragraphText = (raw) => {
      if (!Array.isArray(raw?.childIds)) return null;
      const paragraphs = /** @type {string[]} */ (raw.childIds)
        .map((id) => byId.get(id))
        .filter((child) => child?.role?.value?.toLowerCase() === "paragraph")
        .map((child) => (typeof child?.name?.value === "string" ? child.name.value : null));
      return paragraphs.length > 1 && paragraphs.every((part) => part !== null) ? paragraphs.join("\n\n") : null;
    };
    if (match === "sequence") {
      const expected = paragraphLines(text);
      if (expected.length === 0) return { count: 0, backendNodeIds: [] };
      // A node's name contributes its lines only when its text is not
      // already represented by a StaticText descendant: a StaticText leaf is
      // the rendered text itself, while a container's name derived from its
      // contents would read the same text a second time.
      /** @type {Map<string, boolean>} */
      const staticBelowMemo = new Map();
      /** @param {string} nodeId @returns {boolean} */
      const staticBelow = (nodeId) => {
        const known = staticBelowMemo.get(nodeId);
        if (known !== undefined) return known;
        staticBelowMemo.set(nodeId, false); // cycle guard; the tree has none but the protocol does not promise it
        const raw = byId.get(nodeId);
        let found = false;
        if (raw && Array.isArray(raw.childIds)) {
          for (const childId of /** @type {string[]} */ (raw.childIds)) {
            if (typeof childId !== "string") continue;
            const child = byId.get(childId);
            const childRole = typeof child?.role?.value === "string" ? child.role.value.toLowerCase() : "";
            if (childRole === "statictext" || staticBelow(childId)) {
              found = true;
              break;
            }
          }
        }
        staticBelowMemo.set(nodeId, found);
        return found;
      };
      /** @param {Record<string, any>} raw @returns {{line: string, backendNodeId: number}[]} */
      const ownLines = (raw) => {
        const node = reduceAxNode(raw, "");
        if (!node) return [];
        const name = typeof raw?.name?.value === "string" ? raw.name.value : null;
        if (name === null) return [];
        const role = typeof raw?.role?.value === "string" ? raw.role.value.toLowerCase() : "";
        if (role !== "statictext") {
          const nodeId = typeof raw?.nodeId === "string" ? raw.nodeId : null;
          if (nodeId === null || staticBelow(nodeId)) return [];
        }
        return paragraphLines(name).map((line) => ({ line, backendNodeId: node.backendNodeId }));
      };
      /** @param {Record<string, any>} raw @returns {{line: string, backendNodeId: number}[]} */
      const subtreeLines = (raw) => {
        const lines = ownLines(raw);
        for (const childId of Array.isArray(raw?.childIds) ? raw.childIds : []) {
          const child = typeof childId === "string" ? byId.get(childId) : null;
          if (child) lines.push(...subtreeLines(child));
        }
        return lines;
      };
      const containerRoles = this.#profile.textSequenceContainerRoles ?? new Set();
      const candidates = raws.flatMap((raw) => {
        const own = ownLines(raw);
        if (own.length > 0) return [own];
        const role = typeof raw?.role?.value === "string" ? raw.role.value.toLowerCase() : "";
        return containerRoles.has(role) ? [subtreeLines(raw)] : [];
      });
      /** @type {Set<number>} */
      const hit = new Set();
      for (const lines of candidates) {
        for (let start = 0; start + expected.length <= lines.length; start++) {
          if (!expected.every((line, index) => lines[start + index]?.line === line)) continue;
          for (let index = 0; index < expected.length; index++) {
            const entry = lines[start + index];
            if (entry) hit.add(entry.backendNodeId);
          }
        }
      }
      const resolve = this.#profile.inlineText;
      if (hit.size === 0 && resolve !== undefined && !text.includes(UNRESOLVED_INLINE)) {
        for (const id of await this.#sequenceInProvenInlineText(raws, byId, containerRoles, expected, resolve)) hit.add(id);
      }
      const backendNodeIds = [...hit];
      return { count: backendNodeIds.length, backendNodeIds };
    }
    /** @type {number[]} */
    const backendNodeIds = [];
    for (const raw of raws) {
      const node = reduceAxNode(raw, "");
      if (!node) continue;
      const name = typeof raw?.name?.value === "string" ? raw.name.value : null;
      const hit =
        match === "contains"
          ? name !== null && sanitizeLabel(name, MAX_VALUE_LENGTH).includes(wanted)
          : paragraphEqual(name, text) || paragraphEqual(paragraphText(raw), text);
      if (hit) backendNodeIds.push(node.backendNodeId);
    }
    return { count: backendNodeIds.length, backendNodeIds };
  }

  /**
   * The sequence match for messages whose rendering replaced text with
   * inline elements (a posted emoji is an image, so no accessibility node
   * carries its character): within each profile-declared container (the
   * last MAX_ATTRIBUTE_LOOKUPS of them, newest last), the container's DOM
   * text (domText) with each proven element canonicalized must carry the
   * expected lines as one contiguous run under the same line semantics as
   * the accessibility path. Containers without a proven element are left to
   * the accessibility path. An unresolved element is a line of its own
   * that no expected line equals. The run's text without the proven
   * elements, whitespace aside, must also appear in the container's
   * accessibility text, so DOM text the browser does not expose never
   * verifies a post. Returns the matching containers.
   *
   * @param {Record<string, any>[]} raws
   * @param {Map<string, Record<string, any>>} byId
   * @param {ReadonlySet<string>} containerRoles
   * @param {string[]} expected
   * @param {(element: DomElementFacts) => string|null|undefined} resolve
   * @returns {Promise<number[]>}
   */
  async #sequenceInProvenInlineText(raws, byId, containerRoles, expected, resolve) {
    /** @param {Record<string, any>|undefined} raw @returns {string} */
    const staticText = (raw) => {
      if (!raw) return "";
      const role = typeof raw.role?.value === "string" ? raw.role.value.toLowerCase() : "";
      if (role === "statictext") return typeof raw.name?.value === "string" ? raw.name.value : "";
      return (Array.isArray(raw.childIds) ? raw.childIds : []).map((/** @type {unknown} */ id) => (typeof id === "string" ? staticText(byId.get(id)) : "")).join("");
    };
    const containers = raws
      .filter((raw) => raw?.ignored !== true && typeof raw?.backendDOMNodeId === "number")
      .filter((raw) => containerRoles.has(typeof raw.role?.value === "string" ? raw.role.value.toLowerCase() : ""))
      .slice(-MAX_ATTRIBUTE_LOOKUPS);
    /** @type {number[]} */
    const found = [];
    for (const raw of containers) {
      const described = await this.#describeTree(raw.backendDOMNodeId);
      if (described === null) continue;
      const dom = domText(described, resolve);
      if (dom.replaced === 0) continue;
      // Proven replacements never hold LF, so both strings split alike.
      const plainLines = dom.plain.split("\n");
      const lines = dom.text
        .split("\n")
        .map((line, index) => ({ line, plain: plainLines[index] ?? "" }))
        .filter((entry) => entry.line !== "");
      const exposed = staticText(raw).replace(/\s+/g, "");
      for (let start = 0; start + expected.length <= lines.length; start++) {
        if (!expected.every((line, index) => lines[start + index]?.line === line)) continue;
        const runPlain = lines.slice(start, start + expected.length).map((entry) => entry.plain).join("").replace(/\s+/g, "");
        if (exposed.includes(runPlain)) {
          found.push(raw.backendDOMNodeId);
          break;
        }
      }
    }
    return found;
  }

  /**
   * Poll observations until the predicate holds or the settle window ends.
   *
   * @param {(snapshot: Snapshot) => boolean|Promise<boolean>} predicate
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<{ok: boolean, snapshot: Snapshot}>}
   */
  async waitFor(predicate, { timeoutMs = this.#settleMs } = {}) {
    const started = this.#now();
    for (;;) {
      const snapshot = await this.observe();
      if (await predicate(snapshot)) return { ok: true, snapshot };
      if (this.#now() - started >= timeoutMs) return { ok: false, snapshot };
      await this.#sleep(this.#settlePollMs);
    }
  }
}
