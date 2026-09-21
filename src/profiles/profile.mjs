/**
 * Profile contract for the browser slice. A profile is a thin, optional layer
 * of application semantics and safety policy on top of the generic
 * CdpAdapter: it says which page targets are acceptable, which observed
 * accessibility nodes count as candidates of which kind, and which typed
 * action may be performed on which kind. It never observes or executes
 * anything itself.
 *
 * Everything here is deterministic code. The model only ever chooses among
 * candidates a profile already recognized; it cannot widen the allowlist.
 */

/**
 * A page-level browser target as observed through CDP.
 * @typedef {object} ObservedTarget
 * @property {string} id
 * @property {string} url
 * @property {string} origin
 * @property {string} title
 */

/**
 * One accessibility node, reduced to generic textual facts.
 * @typedef {object} ObservedNode
 * @property {number} backendNodeId
 * @property {string} role
 * @property {string} name
 * @property {string|null} url absolute URL for link-like nodes, else null
 * @property {string|null} value current textual value for editable nodes, else null
 * @property {boolean} disabled
 * @property {boolean} focused
 */

/** @typedef {"destination"|"composer"|"send"|"control"} CandidateKind */

/** Typed browser actions the adapter can perform. */
export const ACTIONS = Object.freeze({
  click: "click",
  insertText: "insertText",
});
/** @typedef {keyof typeof ACTIONS} ActionType */

/**
 * @typedef {object} Recognition
 * @property {CandidateKind} kind
 * @property {string} label text the model sees for this candidate
 */

/**
 * @typedef {object} Candidate
 * @property {string} id stable within one snapshot, derived from the backend node id
 * @property {CandidateKind} kind
 * @property {string} role
 * @property {string} label
 * @property {string} name
 * @property {string|null} url
 * @property {string|null} value
 * @property {boolean} disabled
 * @property {number} backendNodeId
 */

/**
 * @typedef {object} Profile
 * @property {string} name
 * @property {string} description
 * @property {boolean} trusted execution is only ever possible under a trusted profile
 * @property {(target: ObservedTarget) => {ok: boolean, reason?: string}} checkTarget
 * @property {(node: ObservedNode, target: ObservedTarget) => Recognition|null} recognize
 * @property {(candidate: Candidate, action: ActionType, target: ObservedTarget) => {ok: boolean, reason?: string}} allowAction
 */

/**
 * @param {string} url
 * @returns {URL|null}
 */
export function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Generic profile for unknown web apps: observation and selection only.
 * Links are destinations, editable text fields are composers, buttons are
 * controls. It is never trusted, so no action can ever be executed under it.
 *
 * @type {Profile}
 */
export const GENERIC_PROFILE = Object.freeze({
  name: "generic-web",
  description: "Any http(s) page; observe and select only, never execute",
  trusted: false,
  checkTarget(target) {
    const parsed = parseUrl(target.url);
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return { ok: false, reason: `target URL is not http(s): ${target.url}` };
    }
    return { ok: true };
  },
  recognize(node) {
    if (node.name.length === 0) return null;
    if (node.role === "link" && node.url !== null) {
      const parsed = parseUrl(node.url);
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
      return { kind: "destination", label: node.name };
    }
    if (node.role === "textbox" || node.role === "searchbox" || node.role === "combobox") {
      return { kind: "composer", label: node.name };
    }
    if (node.role === "button") {
      return { kind: "control", label: node.name };
    }
    return null;
  },
  allowAction() {
    return { ok: false, reason: "the generic profile never permits execution" };
  },
});
