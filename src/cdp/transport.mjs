/**
 * Live CDP transport: discover page targets over the DevTools HTTP endpoint
 * and open one page-bound WebSocket session. This module knows nothing about
 * any application; target selection is driven by the injected profile.
 *
 * The WebSocket client is the runtime's global WebSocket (Node 22 or newer).
 * It is looked up lazily so importing this module never requires it; on an
 * older runtime connecting fails with a TransportError.
 */
import { RefusalError, TransportError, CdpProtocolError } from "../errors.mjs";

export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} PageTarget
 * @property {string} id
 * @property {string} type
 * @property {string} url
 * @property {string} title
 * @property {string} webSocketDebuggerUrl
 */

/**
 * @param {string} endpoint
 * @param {{fetch?: typeof fetch}} [options]
 * @returns {Promise<PageTarget[]>}
 */
export async function listPageTargets(endpoint, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const base = endpoint.replace(/\/+$/, "");
  let response;
  try {
    response = await fetchImpl(`${base}/json/list`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TransportError(`cannot reach CDP endpoint ${base}: ${message}`, { phase: "discover", cause: err });
  }
  if (!response.ok) {
    throw new TransportError(`CDP endpoint ${base} answered HTTP ${response.status}`, { phase: "discover" });
  }
  const body = await response.json();
  if (!Array.isArray(body)) throw new TransportError("CDP /json/list did not return an array", { phase: "discover" });
  /** @type {PageTarget[]} */
  const targets = [];
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    const t = /** @type {Record<string, unknown>} */ (entry);
    if (t.type !== "page" || typeof t.id !== "string" || typeof t.webSocketDebuggerUrl !== "string") continue;
    targets.push({
      id: t.id,
      type: "page",
      url: typeof t.url === "string" ? t.url : "",
      title: typeof t.title === "string" ? t.title : "",
      webSocketDebuggerUrl: t.webSocketDebuggerUrl,
    });
  }
  return targets;
}

/**
 * Pick exactly one page target. With an explicit id it must exist; without
 * one, exactly one target must pass the profile's target check.
 *
 * @param {PageTarget[]} targets
 * @param {{targetId?: string|null, profile: import("../profiles/profile.mjs").Profile}} options
 * @returns {PageTarget}
 * @throws {RefusalError} no_target or ambiguous_target
 */
export function selectPageTarget(targets, { targetId = null, profile }) {
  if (targetId !== null) {
    const found = targets.find((t) => t.id === targetId);
    if (!found) throw new RefusalError("no_target", `no page target with id ${targetId}`);
    return found;
  }
  const matching = targets.filter((t) => {
    let origin;
    try {
      origin = new URL(t.url).origin;
    } catch {
      return false;
    }
    return profile.checkTarget({ id: t.id, url: t.url, origin, title: t.title }).ok;
  });
  const first = matching[0];
  if (first === undefined) {
    throw new RefusalError("no_target", `none of ${targets.length} page targets matches profile ${profile.name}`);
  }
  if (matching.length > 1) {
    throw new RefusalError(
      "ambiguous_target",
      `${matching.length} page targets match profile ${profile.name}; pass --target ID`,
      { targets: matching.map((t) => ({ id: t.id, url: t.url })) },
    );
  }
  return first;
}

/**
 * Open a page-bound CDP session.
 *
 * @param {PageTarget} target
 * @param {{WebSocket?: typeof WebSocket, callTimeoutMs?: number}} [options]
 * @returns {Promise<import("./adapter.mjs").CdpSession>}
 */
export async function connectPageSession(target, { WebSocket: WebSocketImpl, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
  const Impl = WebSocketImpl ?? /** @type {typeof WebSocket|undefined} */ (globalThis.WebSocket);
  if (typeof Impl !== "function") {
    throw new TransportError("no global WebSocket in this runtime; the live CDP transport needs Node 22 or newer", {
      phase: "connect",
    });
  }
  const socket = new Impl(target.webSocketDebuggerUrl);
  /** @type {Map<number, {method: string, resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout}>} */
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  /** @param {Error} err */
  const failAll = (err) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      pending.delete(id);
    }
  };

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(undefined), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new TransportError(`cannot open ${target.webSocketDebuggerUrl}`, { phase: "connect" })),
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(/** @type {{data: unknown}} */ (event).data));
    } catch {
      return;
    }
    if (typeof message?.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new CdpProtocolError(entry.method, message.error));
    } else {
      entry.resolve(message.result ?? {});
    }
  });
  socket.addEventListener("close", () => {
    closed = true;
    failAll(new TransportError("CDP session closed", { phase: "transport" }));
  });
  socket.addEventListener("error", () => {
    failAll(new TransportError("CDP socket error", { phase: "transport" }));
  });

  return {
    targetId: target.id,
    send(method, params = {}) {
      if (closed) return Promise.reject(new TransportError("CDP session is closed", { phase: "transport" }));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new TransportError(`${method} timed out after ${callTimeoutMs} ms`, { phase: "transport" }));
        }, callTimeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          const message = err instanceof Error ? err.message : String(err);
          reject(new TransportError(`cannot send ${method}: ${message}`, { phase: "transport", cause: err }));
        }
      });
    },
    close() {
      closed = true;
      failAll(new TransportError("CDP session closed by client", { phase: "transport" }));
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}
