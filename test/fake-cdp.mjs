/**
 * Fake page-bound CDP session backed by the synthetic Slack page model. It
 * answers exactly the CDP methods a well-behaved adapter needs and throws on
 * anything else, so tests prove which methods are sent. Input events mutate
 * the model the way the real page would (link or sidebar-row click
 * navigates, composer click focuses, insertText appends to the focused
 * textbox, send posts).
 */
import { TransportError, CdpProtocolError } from "../src/errors.mjs";
import { loadSyntheticPage, buildElements } from "./fixtures/synthetic-slack.mjs";

/** @typedef {import("./fixtures/synthetic-slack.mjs").Element} Element */

const ROOT_ID = 1;
const FIRST_ELEMENT_ID = 10;
/** Offset between an element's backend node id and its StaticText child's id. */
export const TEXT_CHILD_OFFSET = 10_000;

/**
 * The AX representation the synthetic page reports for editor content: the
 * blank-editor artifact (a single U+000A value on a visually empty
 * composer) is passed through untouched, and any other paragraph-bearing
 * string reads every LF as a blank line (double LF), the way the real
 * client's editor is rendered and read back.
 *
 * @param {string} s
 */
const slackParagraphs = (s) => (s === "\n" ? s : s.replace(/\n/g, "\n\n"));

/**
 * @param {{origin?: string, startPath?: string, targetId?: string, viewport?: {width: number, height: number}, hitReturnsChild?: boolean, page?: import("./fixtures/synthetic-slack.mjs").SyntheticPage, splitMessages?: boolean}} [options]
 */
export function createFakeCdp({
  origin = "https://app.slack.com",
  startPath = "/client/T0SYNTH/C0GENERAL",
  targetId = "PAGE-1",
  viewport = { width: 1280, height: 4000 },
  hitReturnsChild = false,
  page = loadSyntheticPage(),
  splitMessages = false,
} = {}) {
  /** @type {Map<string, number>} */
  const idsByKey = new Map();
  let nextId = FIRST_ELEMENT_ID;
  /** @param {string} key */
  const idFor = (key) => {
    let id = idsByKey.get(key);
    if (id === undefined) {
      id = nextId++;
      idsByKey.set(key, id);
    }
    return id;
  };

  const state = {
    origin,
    path: startPath,
    /** @type {Map<string, string>} draft per conversation path */
    drafts: new Map(),
    /** @type {Map<string, string[]>} messages per conversation path */
    messages: new Map(),
    /** @type {number|null} */
    focused: null,
    /** @type {string[]} names of decoy controls that were activated */
    sideEffects: [],
    /** Set false to simulate a page that swallows the send click. */
    posting: true,
    /** Set false to simulate a page that ignores link clicks. */
    navigating: true,
    disconnected: false,
    /** @type {Map<string, Error>} persistent failures by method */
    failures: new Map(),
    /** @type {((x: number, y: number, defaultId: number|null) => number|null)|null} */
    hitTestOverride: null,
    viewport,
    /** @type {string|null} extra title suffix to simulate unrelated page changes */
    titleSuffix: null,
    /** @type {Element[]} extra elements appended to the document */
    extraElements: [],
    /** @type {((draft: string) => string)|null} simulates a page that rewrites inserted text */
    transformDraft: null,
    /** @type {((draft: string) => string)|null} simulates a page that renders the posted message differently from the drafted text */
    transformPosted: null,
    /** Render each posted message as one element per paragraph (the real client's message list), not one joined node. */
    splitMessages,
    /**
     * Value a completed send leaves in the composer. Default ""; a page whose
     * cleared blank composer keeps the blank editor artifact reports a single
     * U+000A instead.
     */
    clearedDraft: "",
  };

  /** @type {Array<{method: string, params: Record<string, unknown>}>} */
  const calls = [];

  const currentDraft = () => state.drafts.get(state.path) ?? "";
  const currentMessages = () => state.messages.get(state.path) ?? [];

  /** @returns {{elements: Array<Element & {id: number, index: number}>, title: string}} */
  const render = () => {
    const built = buildElements(page, {
      path: state.path,
      draft: currentDraft(),
      messages: currentMessages(),
      splitMessages: state.splitMessages,
    });
    const elements = [...built.elements, ...state.extraElements].map((e, index) => ({ ...e, id: idFor(e.key), index }));
    const title = state.titleSuffix ? `${built.title} ${state.titleSuffix}` : built.title;
    return { elements, title };
  };

  /** @param {Element & {id: number, index: number}} e */
  const box = (e) => {
    const x = 20;
    const y = 20 + e.index * 40;
    const width = 300;
    const height = 30;
    return { x, y, width, height };
  };

  /**
   * @param {number} x
   * @param {number} y
   */
  const elementAt = (x, y) => {
    for (const e of render().elements) {
      const b = box(e);
      if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return e;
    }
    return null;
  };

  /** @param {number} id */
  const elementById = (id) => {
    const bare = id >= TEXT_CHILD_OFFSET ? id - TEXT_CHILD_OFFSET : id;
    return render().elements.find((e) => e.id === bare) ?? null;
  };

  const currentUrl = () => `${state.origin}${state.path}`;

  /** @param {Element & {id: number}} e */
  const axNode = (e) => {
    /** @type {Array<{name: string, value: {type: string, value: unknown}}>} */
    const properties = [];
    if (e.role === "link" && e.href !== null) {
      properties.push({ name: "url", value: { type: "string", value: new URL(e.href, currentUrl()).href } });
    }
    if (e.disabled) properties.push({ name: "disabled", value: { type: "boolean", value: true } });
    if (state.focused === e.id) properties.push({ name: "focused", value: { type: "boolean", value: true } });
    const node = {
      nodeId: String(e.id),
      ignored: false,
      role: { type: "role", value: e.role === "statictext" ? "StaticText" : e.role },
      name: { type: "computedString", value: e.role === "statictext" ? slackParagraphs(e.name) : e.name },
      properties,
      backendDOMNodeId: e.id,
      childIds: hasTextChild(e) ? [String(e.id + TEXT_CHILD_OFFSET)] : [],
    };
    if (e.value !== null) Object.assign(node, { value: { type: "string", value: slackParagraphs(e.value) } });
    return node;
  };

  /** @param {Element} e */
  const hasTextChild = (e) => e.role !== "statictext" && e.text !== null;

  /** @param {Element & {id: number}} e */
  const textChild = (e) => ({
    nodeId: String(e.id + TEXT_CHILD_OFFSET),
    ignored: false,
    role: { type: "role", value: "StaticText" },
    name: { type: "computedString", value: slackParagraphs(e.text ?? "") },
    properties: [],
    backendDOMNodeId: e.id + TEXT_CHILD_OFFSET,
    childIds: [],
  });

  /**
   * @param {Element & {id: number, index: number}} e
   */
  const activate = (e) => {
    if ((e.role === "link" || e.role === "treeitem") && e.href !== null) {
      if (!state.navigating) return;
      const target = new URL(e.href, currentUrl());
      if (target.origin === state.origin) {
        state.path = target.pathname + target.search + target.hash;
      } else {
        state.origin = target.origin;
        state.path = target.pathname + target.search + target.hash;
      }
      state.focused = null;
      return;
    }
    if (e.role === "textbox") {
      state.focused = e.id;
      return;
    }
    if (e.role === "button") {
      if (e.key === "send") {
        if (e.disabled || !state.posting) return;
        const draft = currentDraft();
        const posted = state.transformPosted ? state.transformPosted(draft) : draft;
        state.messages.set(state.path, [...currentMessages(), posted]);
        state.drafts.set(state.path, state.clearedDraft);
        return;
      }
      state.sideEffects.push(e.name);
    }
  };

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  const handle = (method, params) => {
    switch (method) {
      case "DOM.enable":
      case "Accessibility.enable":
      case "DOM.scrollIntoViewIfNeeded":
        return {};
      case "Target.getTargetInfo":
        return { targetInfo: { targetId, type: "page", title: render().title, url: currentUrl(), attached: true } };
      case "DOM.getDocument":
        return { root: { nodeId: ROOT_ID, backendNodeId: ROOT_ID, nodeName: "#document", childNodeCount: 1 } };
      case "Accessibility.getFullAXTree": {
        const { elements, title } = render();
        /** @type {object[]} */
        const nodes = [
          {
            nodeId: String(ROOT_ID),
            ignored: false,
            role: { type: "role", value: "RootWebArea" },
            name: { type: "computedString", value: title },
            properties: [],
            backendDOMNodeId: ROOT_ID,
            childIds: elements.map((e) => String(e.id)),
          },
        ];
        for (const e of elements) {
          nodes.push(axNode(e));
          if (hasTextChild(e)) nodes.push(textChild(e));
        }
        return { nodes };
      }
      case "DOM.getBoxModel": {
        const e = elementById(Number(params.backendNodeId));
        if (!e) throw new CdpProtocolError(method, { code: -32000, message: "Could not find node with given id" });
        const b = box(e);
        const content = [b.x, b.y, b.x + b.width, b.y, b.x + b.width, b.y + b.height, b.x, b.y + b.height];
        return { model: { content, padding: content, border: content, margin: content, width: b.width, height: b.height } };
      }
      case "Page.getLayoutMetrics":
        return {
          cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: state.viewport.width, clientHeight: state.viewport.height },
        };
      case "DOM.getNodeForLocation": {
        const e = elementAt(Number(params.x), Number(params.y));
        let id = e ? (hitReturnsChild ? e.id + TEXT_CHILD_OFFSET : e.id) : null;
        if (state.hitTestOverride) id = state.hitTestOverride(Number(params.x), Number(params.y), id);
        if (id === null) throw new CdpProtocolError(method, { code: -32000, message: "No node found at given location" });
        return { backendNodeId: id, frameId: "FRAME-1" };
      }
      case "DOM.describeNode": {
        const id = Number(params.backendNodeId);
        const e = elementById(id);
        if (!e) throw new CdpProtocolError(method, { code: -32000, message: "Could not find node with given id" });
        const children = hasTextChild(e) ? [{ nodeId: 0, backendNodeId: e.id + TEXT_CHILD_OFFSET, nodeName: "#text" }] : [];
        const attributes = Object.entries(e.attributes).flat();
        const node = { nodeId: 0, backendNodeId: e.id, nodeName: e.role.toUpperCase(), attributes };
        // depth 0 (the default) describes the node alone; anything else includes the subtree
        return { node: params.depth === undefined || params.depth === 0 ? node : { ...node, children } };
      }
      case "Input.dispatchMouseEvent": {
        if (params.type === "mouseReleased") {
          const e = elementAt(Number(params.x), Number(params.y));
          if (e) activate(e);
        }
        return {};
      }
      case "Input.insertText": {
        const focused = state.focused === null ? null : elementById(state.focused);
        if (focused && focused.role === "textbox") {
          if (focused.key === "composer") {
            const previous = currentDraft();
            // Chromium's single-U+000A blank-editor artifact is not document
            // content, so inserted text replaces it as on the real page.
            const next = previous === "" || previous === "\n" ? String(params.text) : previous + String(params.text);
            state.drafts.set(state.path, state.transformDraft ? state.transformDraft(next) : next);
          } else {
            state.sideEffects.push(`insertText into ${focused.name}`);
          }
        }
        return {};
      }
      default:
        throw new Error(`fake CDP: unsupported method ${method}`);
    }
  };

  /** @type {import("../src/cdp/adapter.mjs").CdpSession} */
  const session = {
    targetId,
    async send(method, params = {}) {
      calls.push({ method, params });
      if (state.disconnected) throw new TransportError("fake CDP socket is closed", { phase: "transport" });
      const failure = state.failures.get(method);
      if (failure) throw failure;
      return handle(method, params);
    },
    close() {
      state.disconnected = true;
    },
  };

  return {
    session,
    state,
    calls,
    page,
    /** @param {string} key */
    idFor,
    /** @param {string} method */
    methodCalls: (method) => calls.filter((c) => c.method === method),
    clicks: () => calls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased"),
    currentUrl,
    currentDraft,
    currentMessages,
  };
}
