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
 * @property {string} name accessible name as the browser computed it
 * @property {string} contentText whitespace-joined text of the node's static-text descendants, for nodes whose accessible name the browser left empty
 * @property {string|null} url absolute URL for link-like nodes, else null
 * @property {string|null} value current textual value for editable nodes, else null
 * @property {boolean} disabled
 * @property {boolean} focused
 * @property {Readonly<Record<string, string>>} attributes element attributes, fetched only for roles the profile lists in attributeRoles; empty otherwise
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
 * @property {string} [name] the candidate's name when the profile derives it from somewhere other than the accessible name (for example the node's contents); defaults to the accessible name
 * @property {string} [url] the candidate's URL when the profile derives it from somewhere other than the node's URL property (for example an element attribute); defaults to that property
 */

/**
 * @typedef {object} Candidate
 * @property {string} id stable within one snapshot, derived from the backend node id
 * @property {CandidateKind} kind
 * @property {string} role
 * @property {string} label
 * @property {string} name the recognition's name, else the accessible name
 * @property {string|null} url the recognition's URL, else the node's URL property
 * @property {string|null} value
 * @property {boolean} disabled
 * @property {number} backendNodeId
 * @property {Readonly<Record<string, string>>} attributes as on ObservedNode
 */

/**
 * @typedef {object} Profile
 * @property {string} name
 * @property {string} description
 * @property {boolean} trusted execution is only ever possible under a trusted profile
 * @property {ReadonlySet<string>} [attributeRoles] accessibility roles whose element attributes the adapter fetches (one DOM.describeNode per node) before recognition; absent means none
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
