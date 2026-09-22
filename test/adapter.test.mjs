import test from "node:test";
import assert from "node:assert/strict";
import { CdpAdapter, ALLOWED_CDP_METHODS, MAX_ATTRIBUTE_LOOKUPS, urlReached, digestCandidates, editorValueIsEmpty, paragraphEqual } from "../src/cdp/adapter.mjs";
import { SLACK_PROFILE } from "../src/profiles/slack.mjs";
import { RefusalError, TransportError, CdpProtocolError } from "../src/errors.mjs";
import { createFakeCdp, TEXT_CHILD_OFFSET } from "./fake-cdp.mjs";
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
  // The synthetic page models the real editor: each paragraph boundary reads
  // back as a blank line, while the stored draft stays the exact text.
  assert.equal(report.readBack, "users today: 1234\n\nchange: +5%");
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

test("insertText accepts the exact blank-editor newline artifact", async () => {
  // The Beelink reproduction: a visually empty composer (no text, the send
  // control disabled) whose accessibility value is a single U+000A newline,
  // so an exact "" precheck misread the blank composer as an existing draft.
  const { fake, adapter } = setup();
  fake.state.drafts.set("/client/T0SYNTH/C0GENERAL", "\n");
  const snapshot = await adapter.observe();
  const composer = find(snapshot, /Message #general/);
  assert.equal(find(snapshot, /Send now/).disabled, true, "the blank draft leaves send disabled");
  const report = await adapter.insertText(snapshot, composer.id, "users today: 1234\nchange: +5%");
  assert.equal(report.verified, true);
  assert.equal(report.readBack, "users today: 1234\n\nchange: +5%");
  assert.equal(fake.currentDraft(), "users today: 1234\nchange: +5%");
  assert.deepEqual(fake.methodCalls("Input.insertText").map((c) => c.params.text), ["users today: 1234\nchange: +5%"]);
});

test("insertText refuses whitespace other than the exact blank-editor newline", async () => {
  for (const draft of ["\t", " ", "\r", "\r\n", "\n\n", "\u00A0", "\u3000", " \n\t ", "\u00A0\n"]) {
    const { fake, adapter } = setup();
    fake.state.drafts.set("/client/T0SYNTH/C0GENERAL", draft);
    const snapshot = await adapter.observe();
    const composer = find(snapshot, /Message #general/);
    await rejectsRefusal(adapter.insertText(snapshot, composer.id, "new"), "text_mismatch");
    assert.equal(fake.methodCalls("Input.insertText").length, 0);
    assert.equal(fake.methodCalls("Input.dispatchMouseEvent").length, 0);
    assert.equal(fake.currentDraft(), draft, "the refused draft is untouched");
  }
});

test("editor emptiness accepts only absent, empty, and exact single-newline values", () => {
  assert.equal(editorValueIsEmpty(null), true);
  assert.equal(editorValueIsEmpty(undefined), true);
  assert.equal(editorValueIsEmpty(""), true);
  assert.equal(editorValueIsEmpty("\n"), true);
  for (const value of [" ", "\t", "\r", "\r\n", "\n\n", "\u00A0", "\u3000"]) {
    assert.equal(editorValueIsEmpty(value), false);
  }
});

test("paragraphEqual compares non-empty lines exactly and in order, tolerating only blank-line differences", () => {
  assert.equal(paragraphEqual("p1\np2", "p1\n\np2"), true, "a paragraph boundary may read back as a blank line");
  assert.equal(paragraphEqual("p1", "p1"), true, "single-line messages are exact");
  assert.equal(paragraphEqual("p1\np2", "p1\np2\n\n"), true, "trailing blank lines are not significant");
  assert.equal(paragraphEqual("\n\np1\np2", "p1\np2"), true, "leading blank lines are not significant");
  assert.equal(paragraphEqual("p1\n\np2", "p1\n\n\n\np2"), true, "any number of blank lines is not significant");
  assert.equal(paragraphEqual("", "\n\n"), true, "two reads with no non-empty lines equal");
  assert.equal(paragraphEqual(null, "p1"), false);
  assert.equal(paragraphEqual("p1", undefined), false);
  assert.equal(paragraphEqual("p1", "p1 "), false, "a trailing space differs");
  assert.equal(paragraphEqual("p1", " p1"), false, "a leading space differs");
  assert.equal(paragraphEqual("a b", "a  b"), false, "extra spaces differ");
  assert.equal(paragraphEqual("a\tb", "a b"), false, "tab and space differ");
  assert.equal(paragraphEqual("a\u00A0b", "a b"), false, "NBSP differs");
  assert.equal(paragraphEqual("\uFEFFp1", "p1"), false, "BOM differs");
  assert.equal(paragraphEqual("p1\n \np2", "p1\np2"), false, "a whitespace-only line is non-empty content");
  assert.equal(paragraphEqual("p1\np2", "p1\np3"), false, "a changed non-empty line refuses");
  assert.equal(paragraphEqual("p1\np2", "p1\np2\np3"), false, "an added non-empty line refuses");
  assert.equal(paragraphEqual("p1\np2", "p2"), false, "a removed non-empty line refuses");
  assert.equal(paragraphEqual("p1\np2", "p2\np1"), false, "reordered lines refuse");
});

test("insertText verifies the live reproduction: a multi-paragraph draft reads back with blank-line joins", async () => {
  // The 2026-09 live qa2 attempt: the six-paragraph report was inserted
  // correctly, but the page read every paragraph boundary back as a blank
  // line (requested "p1\np2\n...\np6", 362 characters; read-back
  // "p1\n\np2\n\n...", 367 characters), so the exact read-back refused and
  // nothing was posted. The synthetic page models that representation, and
  // the canonical paragraph-aware read-back verifies it.
  const { fake, adapter } = setup();
  const snapshot = await adapter.observe();
  const composer = find(snapshot, /Message #general/);
  const text = "p1\np2\np3\np4\np5\np6";
  const report = await adapter.insertText(snapshot, composer.id, text);
  assert.equal(report.verified, true);
  assert.equal(report.readBack, "p1\n\np2\n\np3\n\np4\n\np5\n\np6");
  assert.equal(fake.currentDraft(), text, "the stored draft is still the exact requested text");
  assert.deepEqual(fake.methodCalls("Input.insertText").map((c) => c.params.text), [text]);
});

test("insertText still refuses any editor value holding a non-whitespace character", async () => {
  for (const draft of ["x", "\nx", "x\n", "\n x \n", "\u00A0x", "\t\tx", "\nhello\n", " \u3000x", "x\u00A0"]) {
    const { fake, adapter } = setup();
    fake.state.drafts.set("/client/T0SYNTH/C0GENERAL", draft);
    const snapshot = await adapter.observe();
    const composer = find(snapshot, /Message #general/);
    await rejectsRefusal(adapter.insertText(snapshot, composer.id, "new"), "text_mismatch");
    assert.equal(fake.methodCalls("Input.insertText").length, 0);
    assert.equal(fake.methodCalls("Input.dispatchMouseEvent").length, 0);
    assert.equal(fake.currentDraft(), draft, "the refused draft is untouched");
  }
});

test("insertText tolerates paragraph-boundary artifacts in the read-back and refuses within-line differences", async () => {
  // The paragraph-aware read-back tolerates exactly the blank-line artifact
  // class a per-paragraph editor produces; anything differing within a line
  // still refuses.
  {
    const { fake, adapter } = setup();
    fake.state.transformDraft = (draft) => `${draft}\n`;
    const snapshot = await adapter.observe();
    const composer = find(snapshot, /Message #general/);
    const report = await adapter.insertText(snapshot, composer.id, "exact");
    assert.equal(report.verified, true);
    assert.equal(report.readBack, "exact\n\n", "the trailing paragraph boundary reads back as a blank line");
  }
  {
    const { fake, adapter } = setup();
    fake.state.transformDraft = (draft) => `${draft} `;
    const snapshot = await adapter.observe();
    const composer = find(snapshot, /Message #general/);
    await assert.rejects(adapter.insertText(snapshot, composer.id, "exact"), (/** @type {unknown} */ err) => {
      assert.ok(err instanceof RefusalError);
      assert.equal(err.code, "text_mismatch");
      assert.equal(err.details.readBack, "exact ");
      return true;
    });
  }
});

/* ----------------------------- findText / waitFor ----------------------------- */

test("findText and waitFor observe posted messages without acting", async () => {
  const { fake, clock, adapter } = setup();
  assert.equal((await adapter.findText("users today: 1")).count, 0);
  fake.state.messages.set("/client/T0SYNTH/C0GENERAL", ["users today: 1"]);
  assert.equal((await adapter.findText("users today: 1")).count, 1);
  // Exact is exact within a line: whitespace is never normalized; only
  // blank-line paragraph-boundary differences are tolerated.
  assert.equal((await adapter.findText("users   today: 1")).count, 0);
  assert.equal((await adapter.findText("users today: 1 ")).count, 0);
  const hit = await adapter.waitFor((s) => s.candidates.length > 0);
  assert.equal(hit.ok, true);
  const before = clock.now();
  const miss = await adapter.waitFor(() => false, { timeoutMs: 300 });
  assert.equal(miss.ok, false);
  assert.ok(clock.now() - before >= 300);
  assert.equal(fake.methodCalls("Input.dispatchMouseEvent").length, 0);
});

test("findText exact verifies a multi-paragraph message across blank-line joins and rejects any non-empty difference", async () => {
  const { fake, adapter } = setup();
  // A posted two-paragraph message reads back with the paragraph boundary as
  // a blank line, the representation the real page reports.
  fake.state.messages.set("/client/T0SYNTH/C0GENERAL", ["users today: 1\nchange: +5%"]);
  assert.equal((await adapter.findText("users today: 1\nchange: +5%")).count, 1);
  assert.equal((await adapter.findText("users today: 1\n\nchange: +5%")).count, 1, "blank lines are not significant");
  assert.equal((await adapter.findText("users today: 1\nchange: -5%")).count, 0, "a changed non-empty line refuses");
  assert.equal((await adapter.findText("users today: 1")).count, 0, "a removed non-empty line refuses");
  assert.equal((await adapter.findText("users today: 1\nextra\nchange: +5%")).count, 0, "an added non-empty line refuses");
  assert.equal((await adapter.findText("change: +5%\nusers today: 1")).count, 0, "reordered lines refuse");
  assert.equal((await adapter.findText("users today: 1\nchange: +5%", { match: "contains" })).count, 1, "containment keeps matching the joined name");
});

test("findText sequence verifies a message whose paragraphs render as separate nodes", async () => {
  // The 2026-09-21 live qa2 post: the real client renders the six paragraphs
  // of the posted report as six separate accessibility nodes, so no single
  // node carries the exact full text. The sequence match reads the message's
  // non-empty lines as one contiguous run across those nodes.
  const { fake, adapter } = setup({ splitMessages: true });
  const text = "p1\np2\np3";
  fake.state.messages.set("/client/T0SYNTH/C0GENERAL", [text]);
  const found = await adapter.findText(text, { match: "sequence" });
  assert.equal(found.count, 3, "each split paragraph node contributes one line of the sequence");
  assert.deepEqual(found.backendNodeIds, [fake.idFor("message:0:p0"), fake.idFor("message:0:p1"), fake.idFor("message:0:p2")]);
  // Blank-line paragraph boundaries in the requested text are not significant.
  assert.equal((await adapter.findText("p1\n\np2\n\np3", { match: "sequence" })).count, 3);
  // Unrelated rendered content before and after the post never breaks the run.
  fake.state.messages.set("/client/T0SYNTH/C0GENERAL", ["earlier post", text, "later message"]);
  const amid = await adapter.findText(text, { match: "sequence" });
  assert.equal(amid.count, 3);
  assert.deepEqual(amid.backendNodeIds, [fake.idFor("message:1:p0"), fake.idFor("message:1:p1"), fake.idFor("message:1:p2")]);
});

test("findText sequence succeeds only for the exact paragraph sequence", async () => {
  // Rendered paragraphs vs requested text: a missing, reordered, altered, or
  // interleaved non-empty line never matches; blank lines and whitespace
  // inside a line are never normalized.
  const cases = /** @type {const} */ ([
    ["p1\np2", "p1\np2\np3"], // the page is missing the last paragraph
    ["p2\np3", "p1\np2\np3"], // the page is missing the first paragraph
    ["p1\np3", "p1\np2\np3"], // the page is missing a middle paragraph
    ["p2\np1\np3", "p1\np2\np3"], // reordered paragraphs
    ["p1\npX\np3", "p1\np2\np3"], // an altered paragraph
    ["p1\np2\nextra\np3", "p1\np2\np3"], // an extra non-empty paragraph inside the sequence
    ["p1\np2 \np3", "p1\np2\np3"], // a trailing space in a rendered line
    ["p1\np2\np3", "p1\n p2\np3"], // a leading space in the requested line
    ["p1 p2\np3", "p1\tp2\np3"], // tab and space differ
    ["p1\u00A0p2\np3", "p1 p2\np3"], // NBSP differs
    ["\uFEFFp1\np2\np3", "p1\np2\np3"], // BOM differs
  ]);
  for (const [rendered, requested] of cases) {
    const { fake, adapter } = setup({ splitMessages: true });
    fake.state.messages.set("/client/T0SYNTH/C0GENERAL", [rendered]);
    assert.equal((await adapter.findText(requested, { match: "sequence" })).count, 0, JSON.stringify({ rendered, requested }));
  }
  // Blank lines between rendered paragraphs are the one tolerated artifact.
  {
    const { fake, adapter } = setup({ splitMessages: true });
    fake.state.messages.set("/client/T0SYNTH/C0GENERAL", ["p1", "p3"]);
    assert.equal((await adapter.findText("p1\n\np3", { match: "sequence" })).count, 2, "blank-line boundaries stay non-significant");
  }
});

test("findText sequence still verifies the single-node paragraph representation", async () => {
  // The representation the composer read-back accepts (one node whose name
  // reads every paragraph boundary as a blank line) verifies through the same
  // sequence match: the run may span lines inside one node.
  const { fake, adapter } = setup();
  fake.state.messages.set("/client/T0SYNTH/C0GENERAL", ["p1\n\np2\n\np3"]);
  const found = await adapter.findText("p1\np2\np3", { match: "sequence" });
  assert.equal(found.count, 1);
  assert.deepEqual(found.backendNodeIds, [fake.idFor("message:0")]);
});

test("findText sequence reads each rendered line once and named leaf nodes contribute too", async () => {
  // The real client renders a paragraph as its own element whose accessible
  // name and StaticText child both carry the line; counting both would read
  // the line twice and break the run, so only the leaf text counts.
  const { fake, adapter } = setup();
  fake.state.extraElements.push(
    { key: "a", role: "statictext", name: "p1", text: "p1", href: null, value: null, disabled: false, attributes: {} },
    { key: "b", role: "paragraph", name: "p2", text: "p2", href: null, value: null, disabled: false, attributes: {} },
    { key: "c", role: "statictext", name: "p3", text: "p3", href: null, value: null, disabled: false, attributes: {} },
  );
  const found = await adapter.findText("p1\np2\np3", { match: "sequence" });
  assert.equal(found.count, 3, "the duplicated paragraph-node name is read once, through its StaticText leaf");
  assert.deepEqual(found.backendNodeIds, [fake.idFor("a"), fake.idFor("b") + TEXT_CHILD_OFFSET, fake.idFor("c")]);
  // A named node that carries no StaticText child still contributes its line.
  const plain = setup();
  plain.fake.state.extraElements.push({
    key: "labeled",
    role: "treeitem",
    name: "only label",
    text: null,
    href: null,
    value: null,
    disabled: false,
    attributes: {},
  });
  const labeled = await plain.adapter.findText("only label", { match: "sequence" });
  assert.equal(labeled.count, 1);
  assert.deepEqual(labeled.backendNodeIds, [plain.fake.idFor("labeled")]);
});

test("urlReached compares normalized URLs and accepts sub-paths only at a boundary", () => {
  assert.equal(urlReached("https://a/x/", "https://a/x"), true);
  assert.equal(urlReached("https://a/x/y", "https://a/x"), true);
  assert.equal(urlReached("https://a/xy", "https://a/x"), false);
  assert.equal(urlReached("https://a/z", "https://a/x"), false);
});
