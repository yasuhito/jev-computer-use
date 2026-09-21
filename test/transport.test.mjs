import test from "node:test";
import assert from "node:assert/strict";
import { listPageTargets, selectPageTarget, connectPageSession } from "../src/cdp/transport.mjs";
import { SLACK_PROFILE } from "../src/profiles/slack.mjs";
import { RefusalError, TransportError, CdpProtocolError } from "../src/errors.mjs";

const SLACK_PAGE = { id: "A", type: "page", url: "https://app.slack.com/client/T1/C1", title: "Slack", webSocketDebuggerUrl: "ws://x/A" };
const OTHER_PAGE = { id: "B", type: "page", url: "https://example.com/", title: "Other", webSocketDebuggerUrl: "ws://x/B" };

test("selectPageTarget picks by explicit id, or the single profile match, else refuses", () => {
  assert.equal(selectPageTarget([SLACK_PAGE, OTHER_PAGE], { targetId: "B", profile: SLACK_PROFILE }).id, "B");
  assert.throws(() => selectPageTarget([SLACK_PAGE], { targetId: "Z", profile: SLACK_PROFILE }), (/** @type {RefusalError} */ e) => e.code === "no_target");
  assert.equal(selectPageTarget([SLACK_PAGE, OTHER_PAGE], { profile: SLACK_PROFILE }).id, "A");
  assert.throws(() => selectPageTarget([OTHER_PAGE], { profile: SLACK_PROFILE }), (/** @type {RefusalError} */ e) => e.code === "no_target");
  assert.throws(
    () => selectPageTarget([SLACK_PAGE, { ...SLACK_PAGE, id: "A2" }], { profile: SLACK_PROFILE }),
    (/** @type {RefusalError} */ e) => {
      assert.equal(e.code, "ambiguous_target");
      assert.deepEqual(e.details.targets, [
        { id: "A", url: SLACK_PAGE.url },
        { id: "A2", url: SLACK_PAGE.url },
      ]);
      return true;
    },
  );
  assert.throws(() => selectPageTarget([{ ...SLACK_PAGE, url: "not a url" }], { profile: SLACK_PROFILE }), RefusalError);
});

test("listPageTargets keeps only page targets and maps transport failures", async () => {
  const body = [SLACK_PAGE, { id: "W", type: "service_worker", url: "x", webSocketDebuggerUrl: "ws://x/W" }, { id: "N" }, "junk"];
  /** @type {typeof fetch} */
  const ok = async (input) => {
    assert.equal(String(input), "http://127.0.0.1:9222/json/list");
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const targets = await listPageTargets("http://127.0.0.1:9222/", { fetch: ok });
  assert.deepEqual(targets.map((t) => t.id), ["A"]);

  /** @type {typeof fetch} */
  const http500 = async () => new Response("nope", { status: 500 });
  await assert.rejects(listPageTargets("http://127.0.0.1:9222", { fetch: http500 }), (/** @type {TransportError} */ e) => e.phase === "discover");
  /** @type {typeof fetch} */
  const refused = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(listPageTargets("http://127.0.0.1:9222", { fetch: refused }), TransportError);
});

/**
 * Minimal in-memory WebSocket double: opens asynchronously and answers each
 * CDP request through a scripted responder.
 */
class FakeSocket extends EventTarget {
  /** @type {((message: {id: number, method: string, params: unknown}) => object|null)|null} */
  static responder = null;
  /** @type {FakeSocket|null} */
  static last = null;
  /** @param {string} url */
  constructor(url) {
    super();
    this.url = url;
    this.sent = /** @type {string[]} */ ([]);
    this.closed = false;
    FakeSocket.last = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  /** @param {string} data */
  send(data) {
    this.sent.push(data);
    const message = JSON.parse(data);
    const reply = FakeSocket.responder ? FakeSocket.responder(message) : { id: message.id, result: {} };
    if (reply === null) return;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(reply) })));
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}

test("connectPageSession maps results, protocol errors, timeouts, and closure", async () => {
  FakeSocket.responder = (m) => {
    if (m.method === "Target.getTargetInfo") return { id: m.id, result: { targetInfo: { targetId: "A" } } };
    if (m.method === "DOM.getBoxModel") return { id: m.id, error: { code: -32000, message: "Could not compute box model." } };
    return null; // never answers: exercises the timeout
  };
  const session = await connectPageSession(SLACK_PAGE, { WebSocket: /** @type {any} */ (FakeSocket), callTimeoutMs: 20 });
  assert.equal(session.targetId, "A");
  const info = await session.send("Target.getTargetInfo");
  assert.equal(info.targetInfo.targetId, "A");
  await assert.rejects(session.send("DOM.getBoxModel", { backendNodeId: 1 }), (/** @type {CdpProtocolError} */ e) => {
    assert.ok(e instanceof CdpProtocolError);
    assert.equal(e.cdpCode, -32000);
    return true;
  });
  await assert.rejects(session.send("Accessibility.getFullAXTree"), (/** @type {TransportError} */ e) => /timed out/.test(e.message));
  const pending = session.send("Target.getTargetInfo").catch((e) => e);
  session.close();
  assert.ok((await pending) instanceof TransportError);
  await assert.rejects(session.send("Target.getTargetInfo"), (/** @type {TransportError} */ e) => /closed/.test(e.message));
  assert.equal(FakeSocket.last?.closed, true);
  const sentMethods = (FakeSocket.last?.sent ?? []).map((s) => JSON.parse(s).method);
  assert.deepEqual(sentMethods, ["Target.getTargetInfo", "DOM.getBoxModel", "Accessibility.getFullAXTree", "Target.getTargetInfo"]);
});

test("connectPageSession fails clearly when the runtime has no WebSocket", async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true });
  try {
    await assert.rejects(connectPageSession(SLACK_PAGE, { callTimeoutMs: 10 }), (/** @type {TransportError} */ e) => {
      assert.ok(e instanceof TransportError);
      assert.equal(e.phase, "connect");
      assert.match(e.message, /Node 22/);
      return true;
    });
  } finally {
    if (saved) Object.defineProperty(globalThis, "WebSocket", saved);
    else delete (/** @type {any} */ (globalThis)).WebSocket;
  }
});
