import test from "node:test";
import assert from "node:assert/strict";
import { CdpAdapter, ALLOWED_CDP_METHODS, MAX_ATTRIBUTE_LOOKUPS, urlReached, digestCandidates } from "../src/cdp/adapter.mjs";
import { SLACK_PROFILE } from "../src/profiles/slack.mjs";
import { RefusalError, TransportError, CdpProtocolError } from "../src/errors.mjs";
import { createFakeCdp } from "./fake-cdp.mjs";
import { loadSyntheticPage } from "./fixtures/synthetic-slack.mjs";
import { fakeClock } from "./helpers.mjs";

const ALLOWED = new Set(ALLOWED_CDP_METHODS);
const UNTRUSTED_PROFILE = { ...SLACK_PROFILE, name: "untrusted-test", trusted: false };

/**
 * @param {Parameters<typeof createFakeCdp>[0]} [fakeOptions]
 * @param {Partial<ConstructorParameters<typeof CdpAdapter>[0]>} [adapterOptions]
 */
function setup(fakeOptions = {}, adapterOptions = {}) {
  const fake = createFakeCdp(fakeOptions);
  const clock = fakeClock();
  const adapter = new CdpAdapter({
    session: fake.session,
    profile: SLACK_PROFILE,
    now: clock.now,
    sleep: clock.sleep,
    settleMs: 500,
    ...adapterOptions,
  });
  return { fake, clock, adapter };
}

/**
 * @param {import("../src/cdp/adapter.mjs").Snapshot} snapshot
 * @param {RegExp} label
 */
function find(snapshot, label) {
  const c = snapshot.candidates.find((x) => label.test(x.label));
  assert.ok(c, `candidate ${label} present`);
  return c;
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
async function rejectsRefusal(promise, code) {
  await assert.rejects(promise, (/** @type {unknown} */ err) => {
    assert.ok(err instanceof RefusalError, `expected RefusalError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

/* ----------------------------- observe ----------------------------- */

test("observe recognizes only profile candidates, assigns node ids, and keeps a stable digest", async () => {
  const { fake, adapter } = setup();
  const a = await adapter.observe();
  const b = await adapter.observe();
  assert.equal(a.target.url, "https://app.slack.com/client/T0SYNTH/C0GENERAL");
  assert.equal(a.profile, "slack");
  assert.ok(a.nodeCount > a.candidates.length);
  assert.deepEqual(
    a.candidates.map((c) => c.kind),
    ["destination", "destination", "destination", "composer", "send"],
  );
  assert.ok(a.candidates.every((c) => /^n\d+$/.test(c.id) && c.id === `n${c.backendNodeId}`));
  const labels = a.candidates.map((c) => c.label);
  for (const decoy of ["Help center", "Preferences", "Workspace settings", "Delete channel", "Sign out", "Download export", "Search", "Add reaction", "Upload file", "New message", "Schedule for later"]) {
    assert.ok(!labels.some((l) => l.includes(decoy)), `decoy ${decoy} must not be offered`);
  }
  assert.equal(a.digest, b.digest);
  assert.equal(a.digest, digestCandidates(a.candidates));
  assert.equal(find(a, /Send now/).disabled, true);
  assert.equal(find(a, /Message #general/).value, "");
  assert.ok(fake.calls.every((c) => ALLOWED.has(c.method)));
});

test("observe refuses a target the profile does not allow and a session whose target changed", async () => {
  const { adapter } = setup({ origin: "https://evil.example" });
  await rejectsRefusal(adapter.observe(), "target_not_allowed");
  const fake = createFakeCdp({ targetId: "PAGE-2" });
  const mismatched = new CdpAdapter({ session: { ...fake.session, targetId: "PAGE-1" }, profile: SLACK_PROFILE });
  await rejectsRefusal(mismatched.observe(), "stale_target");
});

test("observe bounds the recognized candidates", async () => {
  const { adapter } = setup({}, { maxCandidates: 3 });
  await rejectsRefusal(adapter.observe(), "too_many_candidates");
});

test("observe fetches element attributes only for the profile's attribute roles and bounds the lookups", async () => {
  {
    // No attribute roles: no describeNode at all during observation.
    const fake = createFakeCdp();
    const adapter = new CdpAdapter({ session: fake.session, profile: { ...SLACK_PROFILE, attributeRoles: undefined } });
    await adapter.observe();
    assert.equal(fake.methodCalls("DOM.describeNode").length, 0);
  }
  {
    const { fake, adapter } = setup();
    const snapshot = await adapter.observe();
    const lookups = fake.methodCalls("DOM.describeNode");
    assert.ok(lookups.length > 0);
    assert.ok(lookups.every((c) => c.params.depth === 0));
    for (const c of snapshot.candidates) {
      if (c.role === "link") assert.ok(!lookups.some((l) => l.params.backendNodeId === c.backendNodeId), "links are not looked up");
      else assert.ok(lookups.some((l) => l.params.backendNodeId === c.backendNodeId), `${c.role} is looked up`);
    }
    // The links shape carries no hooks; the decoy that does is still never a candidate.
    assert.ok(snapshot.candidates.every((c) => c.attributes["data-qa"] === undefined));
  }
  {
    const { fake, adapter } = setup();
    for (let i = 0; i < MAX_ATTRIBUTE_LOOKUPS; i += 1) {
      fake.state.extraElements.push({ key: `b${i}`, role: "button", name: `b${i}`, text: `b${i}`, href: null, value: null, disabled: false, attributes: {} });
    }
    await rejectsRefusal(adapter.observe(), "too_many_candidates");
  }
});

test("observe exposes the contents text of nodes whose accessible name is empty", async () => {
  /** @type {import("../src/profiles/profile.mjs").Profile} */
  const rows = {
    name: "rows",
    description: "test profile",
    trusted: false,
    attributeRoles: new Set(["treeitem"]),
    checkTarget: () => ({ ok: true }),
    recognize: (n) => (n.role === "treeitem" ? { kind: "control", label: `${n.name}|${n.contentText}|${n.attributes["data-item-key"] ?? "-"}` } : null),
    allowAction: () => ({ ok: false }),
  };
  const fake = createFakeCdp({ page: loadSyntheticPage({ shape: "tree" }) });
  const adapter = new CdpAdapter({ session: fake.session, profile: rows });
  const snapshot = await adapter.observe();
  assert.deepEqual(
    snapshot.candidates.map((c) => c.label),
    ["チャンネル||section-channels", "|general|C0GENERAL", "|qa2-metrics|C0QA2METRICS", "|random|C0RANDOM", "ダイレクトメッセージ||section-dms", "|Alice Example|D0ALICE"],
  );
});

test("observe surfaces transport failures as TransportError with a phase", async () => {
  const { fake, adapter } = setup();
  fake.state.failures.set("Accessibility.getFullAXTree", new Error("socket hiccup"));
  await assert.rejects(adapter.observe(), (/** @type {unknown} */ err) => {
    assert.ok(err instanceof TransportError);
    assert.equal(err.code, "transport");
    assert.equal(err.phase, "observe");
    return true;
  });
  fake.state.failures.clear();
  fake.session.close();
  await assert.rejects(adapter.observe(), TransportError);
});

/* ----------------------------- click ----------------------------- */

test("click performs exactly one hit-tested left click and verifies the expected URL", async () => {
  const { fake, adapter } = setup();
  const snapshot = await adapter.observe();
  const dest = find(snapshot, /^qa2-metrics/);
  const report = await adapter.click(snapshot, dest.id, { expectUrl: dest.url });
  assert.equal(report.action, "click");
  assert.equal(report.verified, true);
  assert.equal(report.urlAfter, "https://app.slack.com/client/T0SYNTH/C0QA2METRICS");
  assert.equal(fake.currentUrl(), report.urlAfter);
  const mouse = fake.methodCalls("Input.dispatchMouseEvent");
  assert.deepEqual(mouse.map((m) => m.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.ok(mouse.every((m) => m.params.button === "left" && m.params.clickCount === 1));
  assert.ok(fake.methodCalls("DOM.getNodeForLocation").length === 1);
  assert.ok(fake.calls.every((c) => ALLOWED.has(c.method)));
});

test("click accepts a hit test that resolves to a descendant of the target", async () => {
  const { fake, adapter } = setup({ hitReturnsChild: true });
  const snapshot = await adapter.observe();
  const dest = find(snapshot, /^random/);
  const report = await adapter.click(snapshot, dest.id, { expectUrl: dest.url });
  assert.equal(report.verified, true);
  assert.equal(fake.methodCalls("DOM.describeNode").filter((c) => c.params.depth === -1).length, 1);
});

test("click reports unverified when the page never reaches the expected URL", async () => {
  const { fake, adapter } = setup();
  fake.state.navigating = false;
  const snapshot = await adapter.observe();
  const dest = find(snapshot, /^random/);
  const report = await adapter.click(snapshot, dest.id, { expectUrl: dest.url });
  assert.equal(report.verified, false);
  assert.equal(report.urlAfter, report.urlBefore);
});

test("click gate: untrusted profile, unsupported action, stale snapshot", async () => {
  const generic = createFakeCdp();
  const untrusted = new CdpAdapter({ session: generic.session, profile: UNTRUSTED_PROFILE });
  const gSnap = await untrusted.observe();
  const gDest = gSnap.candidates.find((c) => c.kind === "destination");
  assert.ok(gDest);
  await rejectsRefusal(untrusted.click(gSnap, gDest.id), "untrusted_profile");
  assert.equal(generic.methodCalls("Input.dispatchMouseEvent").length, 0);

  const { fake, clock, adapter } = setup();
  const snapshot = await adapter.observe();
  const dest = find(snapshot, /^general/);
  await rejectsRefusal(adapter.insertText(snapshot, dest.id, "hi"), "unsupported_action");
  clock.advance(60_000);
  await rejectsRefusal(adapter.click(snapshot, dest.id), "stale_snapshot");
  assert.equal(fake.methodCalls("Input.dispatchMouseEvent").length, 0);
  assert.equal(fake.methodCalls("Input.insertText").length, 0);
});

test("click gate: changed candidates, changed URL, and a renamed element all refuse", async () => {
  {
    const { fake, adapter } = setup();
    const snapshot = await adapter.observe();
    const dest = find(snapshot, /^general/);
    fake.state.extraElements.push({ key: "late", role: "link", name: "late-channel (channel)", text: "late-channel (channel)", href: "/client/T0SYNTH/C0LATE", value: null, disabled: false, attributes: {} });
    await rejectsRefusal(adapter.click(snapshot, dest.id), "changed_state");
    assert.equal(fake.clicks().length, 0);
  }
  {
    const { fake, adapter } = setup();
    const snapshot = await adapter.observe();
    const dest = find(snapshot, /^general/);
    fake.state.path = "/client/T0SYNTH/C0RANDOM";
    await rejectsRefusal(adapter.click(snapshot, dest.id), "changed_state");
    assert.equal(fake.clicks().length, 0);
  }
  {
    const { fake, adapter } = setup();
    const snapshot = await adapter.observe();
    const dest = find(snapshot, /^qa2-metrics/);
    const conv = fake.page.conversations.find((c) => c.id === "C0QA2METRICS");
    assert.ok(conv);
    conv.name = "qa2-metrics-renamed";
    await rejectsRefusal(adapter.click(snapshot, dest.id), "changed_state");
    assert.equal(fake.clicks().length, 0);
  }
});

test("click gate: a caller precondition is evaluated on the fresh observation", async () => {
  const { fake, adapter } = setup();
  const snapshot = await adapter.observe();
  const dest = find(snapshot, /^general/);
  await rejectsRefusal(
    adapter.click(snapshot, dest.id, { require: () => ({ ok: false, code: "destination_mismatch", reason: "test" }) }),
    "destination_mismatch",
  );
  assert.equal(fake.clicks().length, 0);
});

test("click refuses when the hit test resolves to another element (overlay) or the element is not actionable", async () => {
  {
    const { fake, adapter } = setup();
    const snapshot = await adapter.observe();
    const dest = find(snapshot, /^general/);
    const overlayId = fake.idFor("decoy:help");
    fake.state.hitTestOverride = () => overlayId;
    await rejectsRefusal(adapter.click(snapshot, dest.id), "ambiguous_identity");
    assert.equal(fake.clicks().length, 0);
  }
  {
    const { fake, adapter } = setup();
    const snapshot = await adapter.observe();
    const send = find(snapshot, /Send now/);
    await rejectsRefusal(adapter.click(snapshot, send.id), "unsupported_action");
    assert.equal(fake.clicks().length, 0);
  }
  {
    const { fake, adapter } = setup({ viewport: { width: 1280, height: 50 } });
    const snapshot = await adapter.observe();
    const dest = find(snapshot, /^random/);
    await rejectsRefusal(adapter.click(snapshot, dest.id), "not_actionable");
    assert.equal(fake.clicks().length, 0);
  }
  {
    const { fake, adapter } = setup();
    const snapshot = await adapter.observe();
    const dest = find(snapshot, /^random/);
    fake.state.failures.set("DOM.getBoxModel", new CdpProtocolError("DOM.getBoxModel", { code: -32000, message: "Could not compute box model." }));
    await rejectsRefusal(adapter.click(snapshot, dest.id), "not_actionable");
    assert.equal(fake.clicks().length, 0);
  }
});

/* ----------------------------- insertText ----------------------------- */

test("insertText focuses with one click, inserts the exact text, and verifies the read-back", async () => {
  const { fake, adapter } = setup();
  const snapshot = await adapter.observe();
  const composer = find(snapshot, /Message #general/);
  const report = await adapter.insertText(snapshot, composer.id, "users today: 1234\nchange: +5%");
  assert.equal(report.action, "insertText");
  assert.equal(report.verified, true);
  assert.equal(report.readBack, "users today: 1234\nchange: +5%");
  assert.equal(fake.currentDraft(), "users today: 1234\nchange: +5%");
  assert.equal(fake.clicks().length, 1);
  assert.deepEqual(fake.methodCalls("Input.insertText").map((c) => c.params.text), ["users today: 1234\nchange: +5%"]);
  assert.equal(fake.methodCalls("Input.dispatchKeyEvent").length, 0);
  const after = await adapter.observe();
  assert.equal(find(after, /Send now/).disabled, false);
});

test("insertText refuses a composer that already holds text and a read-back that differs", async () => {
  {
    const { fake, adapter } = setup();
    fake.state.drafts.set("/client/T0SYNTH/C0GENERAL", "old draft");
    const snapshot = await adapter.observe();
    const composer = find(snapshot, /Message #general/);
    await rejectsRefusal(adapter.insertText(snapshot, composer.id, "new"), "text_mismatch");
    assert.equal(fake.methodCalls("Input.insertText").length, 0);
    assert.equal(fake.currentDraft(), "old draft");
  }
  {
    const { fake, adapter } = setup();
    fake.state.transformDraft = (draft) => draft.toUpperCase();
    const snapshot = await adapter.observe();
    const composer = find(snapshot, /Message #general/);
    await assert.rejects(adapter.insertText(snapshot, composer.id, "exact"), (/** @type {unknown} */ err) => {
      assert.ok(err instanceof RefusalError);
      assert.equal(err.code, "text_mismatch");
      assert.equal(err.details.readBack, "EXACT");
      return true;
    });
  }
});

/* ----------------------------- findText / waitFor ----------------------------- */

test("findText and waitFor observe posted messages without acting", async () => {
  const { fake, clock, adapter } = setup();
  assert.equal((await adapter.findText("users today: 1")).count, 0);
  fake.state.messages.set("/client/T0SYNTH/C0GENERAL", ["users today: 1"]);
  assert.equal((await adapter.findText("users   today: 1")).count, 1);
  const hit = await adapter.waitFor((s) => s.candidates.length > 0);
  assert.equal(hit.ok, true);
  const before = clock.now();
  const miss = await adapter.waitFor(() => false, { timeoutMs: 300 });
  assert.equal(miss.ok, false);
  assert.ok(clock.now() - before >= 300);
  assert.equal(fake.methodCalls("Input.dispatchMouseEvent").length, 0);
});

test("urlReached compares normalized URLs and accepts sub-paths only at a boundary", () => {
  assert.equal(urlReached("https://a/x/", "https://a/x"), true);
  assert.equal(urlReached("https://a/x/y", "https://a/x"), true);
  assert.equal(urlReached("https://a/xy", "https://a/x"), false);
  assert.equal(urlReached("https://a/z", "https://a/x"), false);
});
