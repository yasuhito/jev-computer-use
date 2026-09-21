import test from "node:test";
import assert from "node:assert/strict";
import { CdpAdapter, ALLOWED_CDP_METHODS } from "../src/cdp/adapter.mjs";
import { SLACK_PROFILE } from "../src/profiles/slack.mjs";
import { runWorkflow, validateMessageText, validateDestination, destinationNameMatches, DEFAULT_BROWSE_MIN_CONFIDENCE } from "../src/workflow.mjs";
import { ValidationError } from "../src/validate.mjs";
import { createFakeCdp } from "./fake-cdp.mjs";
import { loadSyntheticPage } from "./fixtures/synthetic-slack.mjs";
import { decideByLabel, decideFixed, fakeClock } from "./helpers.mjs";

const ALLOWED = new Set(ALLOWED_CDP_METHODS);
const QA2 = "https://app.slack.com/client/T0SYNTH/C0QA2METRICS";
const TEXT = "QA2 daily users: 1234 (+5% vs yesterday)";
const FULL_FLOW = [/^qa2-metrics/, /^Message #qa2-metrics/, /^Send now/];
/** The same three choices on the real-shaped (Japanese, tree-sidebar) page. */
const TREE_FLOW = [/^qa2-metrics \[channel\]$/, /^qa2-metrics へのメッセージ$/, /^メッセージを送信$/];
/** @returns {Parameters<typeof createFakeCdp>[0]} */
const treeShape = () => ({ page: loadSyntheticPage({ shape: "tree" }) });
const UNTRUSTED_PROFILE = { ...SLACK_PROFILE, name: "untrusted-test", trusted: false };

/**
 * @param {Parameters<typeof createFakeCdp>[0]} [fakeOptions]
 * @param {{profile?: import("../src/profiles/profile.mjs").Profile}} [options]
 */
function setup(fakeOptions = {}, { profile = SLACK_PROFILE } = {}) {
  const fake = createFakeCdp(fakeOptions);
  const clock = fakeClock();
  const adapter = new CdpAdapter({ session: fake.session, profile, now: clock.now, sleep: clock.sleep, settleMs: 500 });
  return { fake, clock, adapter };
}

/**
 * @param {ReturnType<typeof setup>} env
 * @param {Partial<Parameters<typeof runWorkflow>[0]>} overrides
 */
function run({ adapter }, overrides) {
  return runWorkflow({
    mode: "dry-run",
    destination: "qa2-metrics",
    text: null,
    adapter,
    decide: decideByLabel(FULL_FLOW),
    maxCandidates: 40,
    ...overrides,
  });
}

/** @param {ReturnType<typeof createFakeCdp>} fake */
function assertNoInput(fake) {
  assert.equal(fake.methodCalls("Input.dispatchMouseEvent").length, 0);
  assert.equal(fake.methodCalls("Input.insertText").length, 0);
}

/* ----------------------------- observe / dry-run ----------------------------- */

test("observe mode snapshots candidates with no model call and no input", async () => {
  const env = setup();
  const decide = decideByLabel([]);
  const report = await run(env, { mode: "observe", destination: null, decide });
  assert.equal(report.status, "observed");
  assert.ok(report.candidates && report.candidates.length === 5);
  assert.ok(report.candidates.every((c) => !("value" in c)));
  assert.equal(decide.calls.length, 0);
  assertNoInput(env.fake);
  assert.equal(report.target?.url, "https://app.slack.com/client/T0SYNTH/C0GENERAL");
});

test("dry-run decides the destination and previews composer and send without acting", async () => {
  const env = setup();
  // The dry-run previews the composer and send control of the page as it is
  // now (#general), since nothing navigates.
  const decide = decideByLabel([/^qa2-metrics/, /^Message #general/, /^Send now/]);
  const report = await run(env, { mode: "dry-run", text: TEXT, decide });
  assert.equal(report.status, "selected");
  assert.equal(report.completed, null);
  assert.equal(report.destination.candidate?.url, QA2);
  assert.equal(report.threshold, DEFAULT_BROWSE_MIN_CONFIDENCE);
  const plan = report.steps.find((s) => /** @type {{step: string}} */ (s).step === "plan");
  assert.ok(plan);
  const typedPlan = /** @type {{executable: boolean, blocker: string|null, actions: string[], preview: {destination: {ok: boolean}, composer: {ok: boolean}, send: {ok: boolean, reason: string}}}} */ (plan);
  assert.equal(typedPlan.executable, true);
  assert.equal(typedPlan.blocker, null);
  assert.deepEqual(typedPlan.actions, ["navigate", "draft"]);
  assert.equal(typedPlan.preview.destination.ok, true);
  assert.equal(typedPlan.preview.composer.ok, true);
  assert.equal(typedPlan.preview.send.ok, false);
  assert.match(typedPlan.preview.send.reason, /disabled/);
  assert.equal(decide.calls.length, 3);
  assert.equal(report.usage.calls, 3);
  assert.equal(report.usage.input_tokens, 300);
  assertNoInput(env.fake);
  assert.ok(env.fake.calls.every((c) => ALLOWED.has(c.method)));
});

test("dry-run sends the model only recognized candidates with the instruction boundary", async () => {
  const env = setup();
  const decide = decideByLabel([/^qa2-metrics/]);
  await run(env, { mode: "dry-run", decide });
  const request = decide.calls[0];
  assert.ok(request);
  const criteria = request.questions.element?.criteria ?? {};
  const ids = Object.keys(criteria);
  assert.equal(ids.length, 4);
  assert.ok(ids.includes("no_match"));
  const descriptions = Object.values(criteria).join("\n");
  assert.match(descriptions, /link: qa2-metrics \(channel\) \[channel\]/);
  assert.doesNotMatch(descriptions, /Delete channel|Sign out|Add reaction|Help center/);
  const instructions = request.questions.element?.instructions;
  assert.ok(instructions && typeof instructions === "object" && !Array.isArray(instructions));
  assert.match(String(instructions.question), /qa2-metrics/);
});

test("dry-run under an untrusted injected profile plans nothing executable", async () => {
  const env = setup({}, { profile: UNTRUSTED_PROFILE });
  const report = await run(env, { mode: "dry-run", destination: "qa2-metrics", decide: decideByLabel([/^qa2-metrics/]) });
  assert.equal(report.status, "selected");
  assert.equal(report.trusted, false);
  const plan = /** @type {{executable: boolean, blocker: string|null, preview: {destination: {ok: boolean}}}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "plan"));
  assert.ok(plan);
  assert.equal(plan.executable, false);
  assert.equal(plan.blocker, "untrusted_profile");
  assert.equal(plan.preview.destination.ok, true);
  assertNoInput(env.fake);
});

test("no_match, low confidence, and an unknown choice id stop before any action", async () => {
  for (const [decide, status] of /** @type {const} */ ([
    [decideByLabel([/nothing-like-this/]), "no_match"],
    [decideByLabel([/^qa2-metrics/], { confidence: 0.4 }), "escalate"],
    [decideFixed({ choice: "n999999", confidence: 1 }), "escalate"],
  ])) {
    const env = setup();
    const report = await run(env, { mode: "send", text: TEXT, decide });
    assert.equal(report.status, status);
    assert.equal(report.completed, null);
    assertNoInput(env.fake);
  }
});

test("no destination candidates and an untrusted profile refuse execution modes", async () => {
  /** @type {import("../src/profiles/profile.mjs").Profile} */
  const composersOnly = { ...SLACK_PROFILE, name: "composers-only", recognize: (n, t) => (n.role === "textbox" ? SLACK_PROFILE.recognize(n, t) : null) };
  const env = setup({}, { profile: composersOnly });
  const empty = await run(env, { mode: "navigate", decide: decideByLabel([]) });
  assert.equal(empty.status, "refused");
  assert.equal(empty.refusal?.code, "no_candidates");
  assertNoInput(env.fake);
  const generic = setup({}, { profile: UNTRUSTED_PROFILE });
  const report = await run(generic, { mode: "navigate", decide: decideByLabel([/^qa2-metrics/]) });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "untrusted_profile");
  assertNoInput(generic.fake);
});

test("a label shared by two distinct destinations is refused as ambiguous identity", async () => {
  const env = setup();
  env.fake.state.extraElements.push({
    key: "twin",
    role: "link",
    name: "qa2-metrics (channel)",
    text: "qa2-metrics (channel)",
    href: "/client/T0SYNTH/C0IMPOSTOR",
    value: null,
    disabled: false,
    attributes: {},
  });
  const report = await run(env, { mode: "navigate" });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "ambiguous_identity");
  assertNoInput(env.fake);
});

/* ----------------------------- navigate ----------------------------- */

test("navigate mode clicks the destination once and verifies the URL", async () => {
  const env = setup();
  const report = await run(env, { mode: "navigate" });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "navigate");
  assert.equal(env.fake.currentUrl(), QA2);
  assert.equal(env.fake.clicks().length, 1);
  assert.equal(env.fake.methodCalls("Input.insertText").length, 0);
  const act = /** @type {{verified: boolean, urlAfter: string}|undefined} */ (report.steps.find((s) => /** @type {{phase: string}} */ (s).phase === "act"));
  assert.ok(act);
  assert.equal(act.verified, true);
  assert.equal(act.urlAfter, QA2);
});

test("navigate mode reports unverified when the URL never changes", async () => {
  const env = setup();
  env.fake.state.navigating = false;
  const report = await run(env, { mode: "navigate" });
  assert.equal(report.status, "unverified");
  assert.equal(report.completed, "navigate");
});

/* ----------------------------- draft ----------------------------- */

test("draft mode navigates, inserts the exact text, verifies it, and never sends", async () => {
  const env = setup();
  const report = await run(env, { mode: "draft", text: TEXT });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "draft");
  assert.equal(env.fake.currentUrl(), QA2);
  assert.equal(env.fake.currentDraft(), TEXT);
  assert.deepEqual(env.fake.currentMessages(), []);
  assert.equal(env.fake.clicks().length, 2);
  assert.deepEqual(env.fake.methodCalls("Input.insertText").map((c) => c.params.text), [TEXT]);
  const draft = /** @type {{readBack: string, verified: boolean}|undefined} */ (report.steps.find((s) => /** @type {{step: string, phase: string}} */ (s).step === "composer" && /** @type {{phase: string}} */ (s).phase === "act"));
  assert.ok(draft);
  assert.equal(draft.readBack, TEXT);
  assert.deepEqual(env.fake.state.sideEffects, []);
});

test("draft mode refuses when the page leaves the destination before typing", async () => {
  const env = setup();
  const decide = decideByLabel(FULL_FLOW, {
    onCall: (index) => {
      if (index === 1) env.fake.state.path = "/client/T0SYNTH/C0RANDOM";
    },
  });
  const report = await run(env, { mode: "draft", text: TEXT, decide });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "changed_state");
  assert.equal(env.fake.methodCalls("Input.insertText").length, 0);
});

test("draft mode refuses a composer that already holds a draft", async () => {
  const env = setup();
  env.fake.state.drafts.set("/client/T0SYNTH/C0QA2METRICS", "leftover");
  const report = await run(env, { mode: "draft", text: TEXT });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "text_mismatch");
  assert.equal(env.fake.methodCalls("Input.insertText").length, 0);
  assert.equal(env.fake.currentDraft(), "leftover");
});

test("draft mode refuses when the read-back differs from the exact text", async () => {
  const env = setup();
  env.fake.state.transformDraft = (d) => `${d} (edited by page)`;
  const report = await run(env, { mode: "draft", text: TEXT });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "text_mismatch");
  assert.deepEqual(env.fake.currentMessages(), []);
});

/* ----------------------------- send ----------------------------- */

test("send mode drafts, clicks send once, and verifies the message was posted", async () => {
  const env = setup();
  const report = await run(env, { mode: "send", text: TEXT });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
  assert.deepEqual(env.fake.currentMessages(), [TEXT]);
  assert.equal(env.fake.currentDraft(), "");
  assert.equal(env.fake.clicks().length, 3);
  assert.deepEqual(env.fake.state.sideEffects, []);
  const posted = /** @type {{verified: boolean, url: string}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "posted"));
  assert.ok(posted);
  assert.equal(posted.verified, true);
  assert.equal(posted.url, QA2);
  assert.ok(env.fake.calls.every((c) => ALLOWED.has(c.method)));
  assert.equal(env.fake.methodCalls("Input.dispatchKeyEvent").length, 0);
});

test("send mode reports unverified when the page swallows the send", async () => {
  const env = setup();
  env.fake.state.posting = false;
  const report = await run(env, { mode: "send", text: TEXT });
  assert.equal(report.status, "unverified");
  assert.equal(report.completed, "send");
  assert.equal(env.fake.clicks().length, 3);
});

test("send mode refuses when the draft changed between typing and sending", async () => {
  const env = setup();
  const decide = decideByLabel(FULL_FLOW, {
    onCall: (index) => {
      if (index === 2) env.fake.state.drafts.set("/client/T0SYNTH/C0QA2METRICS", `${TEXT} tampered`);
    },
  });
  const report = await run(env, { mode: "send", text: TEXT, decide });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "text_mismatch");
  assert.equal(env.fake.clicks().length, 2);
  assert.deepEqual(env.fake.currentMessages(), []);
});

test("send mode refuses when the page leaves the destination before sending", async () => {
  const env = setup();
  const decide = decideByLabel(FULL_FLOW, {
    onCall: (index) => {
      if (index === 2) env.fake.state.path = "/client/T0SYNTH/C0GENERAL";
    },
  });
  const report = await run(env, { mode: "send", text: TEXT, decide });
  assert.equal(report.status, "refused");
  assert.ok(["changed_state", "destination_mismatch"].includes(report.refusal?.code ?? ""));
  assert.deepEqual(env.fake.currentMessages(), []);
});

test("send mode stops when no send control is selected", async () => {
  const env = setup();
  const report = await run(env, { mode: "send", text: TEXT, decide: decideByLabel([/^qa2-metrics/, /^Message #qa2-metrics/, /nothing/]) });
  assert.equal(report.status, "no_match");
  assert.equal(report.completed, "draft");
  assert.equal(env.fake.currentDraft(), TEXT);
  assert.deepEqual(env.fake.currentMessages(), []);
});

/* ----------------------------- validation ----------------------------- */

test("message text and destination are validated deterministically", () => {
  assert.equal(validateMessageText("hello\n\tworld"), "hello\n\tworld");
  assert.throws(() => validateMessageText(""), ValidationError);
  assert.throws(() => validateMessageText("   "), ValidationError);
  assert.throws(() => validateMessageText("x".repeat(4001)), ValidationError);
  assert.throws(() => validateMessageText("bad\u0007bell"), ValidationError);
  assert.throws(() => validateMessageText(42), ValidationError);
  assert.equal(validateDestination("  qa2   metrics "), "qa2 metrics");
  assert.throws(() => validateDestination(""), ValidationError);
  assert.throws(() => validateDestination("x".repeat(201)), ValidationError);
});

/* ----------------------------- caller guards ----------------------------- */

test("destinationNameMatches accepts only the requested name followed by decoration", () => {
  assert.equal(destinationNameMatches("qa2-metrics", "qa2-metrics"), true);
  assert.equal(destinationNameMatches("qa2-metrics (channel)", "qa2-metrics"), true);
  assert.equal(destinationNameMatches("qa2-metrics, 3 unread messages", "qa2-metrics"), true);
  assert.equal(destinationNameMatches("qa2-metrics [muted]", "qa2-metrics"), true);
  assert.equal(destinationNameMatches("qa2（チャンネル）", "qa2"), true);
  assert.equal(destinationNameMatches("qa2［ミュート］", "qa2"), true);
  assert.equal(destinationNameMatches("qa2 3", "qa2"), true);
  assert.equal(destinationNameMatches("qa2ー旧", "qa2"), false);
  assert.equal(destinationNameMatches("qa2-metrics-old", "qa2-metrics"), false);
  assert.equal(destinationNameMatches("qa2-metrics2", "qa2-metrics"), false);
  assert.equal(destinationNameMatches("QA2-metrics", "qa2-metrics"), false);
  assert.equal(destinationNameMatches("qa2-metrics", "qa2-metric"), false);
  assert.equal(destinationNameMatches("qa2-metrics", ""), false);
});

test("exactDestination refuses before any click when the chosen link does not name the request", async () => {
  const env = setup();
  const report = await run(env, { mode: "navigate", destination: "qa2-metric", exactDestination: true });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "destination_mismatch");
  assert.equal(report.completed, null);
  assertNoInput(env.fake);
  const ok = await run(setup(), { mode: "navigate", destination: "qa2-metrics", exactDestination: true });
  assert.equal(ok.status, "executed");
});

test("duplicateMarker refuses when the rendered destination contains the marker, and is reported in the plan", async () => {
  const env = setup();
  env.fake.state.messages.set("/client/T0SYNTH/C0QA2METRICS", ["earlier post key: job-2026-09-20"]);
  const report = await run(env, { mode: "send", text: TEXT, duplicateMarker: "job-2026-09-20" });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "duplicate_post");
  assert.equal(report.completed, "navigate");
  assert.equal(env.fake.methodCalls("Input.insertText").length, 0);
  assert.deepEqual(env.fake.currentMessages(), ["earlier post key: job-2026-09-20"]);
  const step = /** @type {{step: string, found: number}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "duplicate"));
  assert.equal(step?.found, 1);

  const fresh = setup();
  const posted = await run(fresh, { mode: "send", text: TEXT, duplicateMarker: "job-2026-09-21" });
  assert.equal(posted.status, "executed");
  assert.deepEqual(fresh.fake.currentMessages(), [TEXT]);

  const plan = await run(setup(), { mode: "dry-run", text: TEXT, decide: decideByLabel([/^qa2-metrics/, /^Message #general/, /^Send now/]), exactDestination: true, duplicateMarker: "m" });
  const planStep = /** @type {{guards: object}|undefined} */ (plan.steps.find((s) => /** @type {{step: string}} */ (s).step === "plan"));
  assert.deepEqual(planStep?.guards, { exactDestination: true, duplicateMarker: "m" });
});

/* ----------------------------- real-shaped page ----------------------------- */

test("observe mode on the real-shaped page exposes the channel rows as destinations without any link", async () => {
  const env = setup(treeShape());
  const report = await run(env, { mode: "observe", destination: null, decide: decideByLabel([]) });
  assert.equal(report.status, "observed");
  assert.deepEqual(
    report.candidates?.map((c) => [c.kind, c.role, c.label, c.url]),
    [
      ["destination", "treeitem", "general [channel]", "https://app.slack.com/client/T0SYNTH/C0GENERAL"],
      ["destination", "treeitem", "qa2-metrics [channel]", QA2],
      ["destination", "treeitem", "random [channel]", "https://app.slack.com/client/T0SYNTH/C0RANDOM"],
      ["composer", "textbox", "general へのメッセージ", null],
      ["send", "button", "メッセージを送信", null],
    ],
  );
  assertNoInput(env.fake);
});

test("exactDestination on the real-shaped page matches the row's visible name, not its empty accessible name", async () => {
  const ok = await run(setup(treeShape()), { mode: "navigate", destination: "qa2-metrics", exactDestination: true, decide: decideByLabel(TREE_FLOW) });
  assert.equal(ok.status, "executed");
  assert.equal(ok.completed, "navigate");
  assert.equal(ok.destination.candidate?.role, "treeitem");
  assert.equal(ok.destination.candidate?.url, QA2);
  const env = setup(treeShape());
  const report = await run(env, { mode: "navigate", destination: "qa2-metric", exactDestination: true, decide: decideByLabel(TREE_FLOW) });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "destination_mismatch");
  assertNoInput(env.fake);
});

test("send mode on the real-shaped page drafts through the localized composer and clicks the localized send button once", async () => {
  const env = setup(treeShape());
  const report = await run(env, { mode: "send", text: TEXT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: "QA2 daily" });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
  assert.deepEqual(env.fake.currentMessages(), [TEXT]);
  assert.equal(env.fake.currentUrl(), QA2);
  assert.equal(env.fake.clicks().length, 3);
  assert.deepEqual(env.fake.state.sideEffects, []);
  assert.ok(env.fake.calls.every((c) => ALLOWED.has(c.method)));
  // The second run sees the marker and refuses before typing.
  const again = await run(env, { mode: "send", text: TEXT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: "QA2 daily" });
  assert.equal(again.status, "refused");
  assert.equal(again.refusal?.code, "duplicate_post");
});

test("on the real-shaped page a renamed row or a row whose key changed refuses before the click", async () => {
  const env = setup(treeShape());
  const first = await env.adapter.observe();
  const qa2 = first.candidates.find((c) => c.label === "qa2-metrics [channel]");
  assert.ok(qa2);
  const conv = env.fake.page.conversations.find((c) => c.id === "C0QA2METRICS");
  assert.ok(conv);
  conv.name = "qa2-metrics-renamed";
  await assert.rejects(env.adapter.click(first, qa2.id), (/** @type {{code: string}} */ err) => err.code === "changed_state");
  conv.name = "qa2-metrics";
  conv.id = "C0MOVED";
  await assert.rejects(env.adapter.click(first, qa2.id), (/** @type {{code: string}} */ err) => err.code === "changed_state");
  assertNoInput(env.fake);
});
