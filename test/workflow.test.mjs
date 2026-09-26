import test from "node:test";
import assert from "node:assert/strict";
import { CdpAdapter, ALLOWED_CDP_METHODS } from "../src/cdp/adapter.mjs";
import { SLACK_PROFILE } from "../src/profiles/slack.mjs";
import { runWorkflow, validateMessageText, validateDestination, destinationNameMatches, DEFAULT_BROWSE_MIN_CONFIDENCE } from "../src/workflow.mjs";
import { ValidationError } from "../src/validate.mjs";
import { createFakeCdp } from "./fake-cdp.mjs";
import { loadSyntheticPage, emojiImageAttributes } from "./fixtures/synthetic-slack.mjs";
import { decideByLabel, decideFixed, fakeClock } from "./helpers.mjs";

const ALLOWED = new Set(ALLOWED_CDP_METHODS);
const QA2 = "https://app.slack.com/client/T0SYNTH/C0QA2METRICS";
const TREE_QA2 = "https://app.slack.com/client/T0SYNTH/C0QA2";
const SELF_DM_NAME = "Yasuhito Takamiya (自分)";
const SELF_DM_URL = "https://app.slack.com/client/T0SYNTH/D0SELF";
const SELF_DM_FLOW = [/^Yasuhito Takamiya \(自分\) \[self direct message\]$/, /^Yasuhito Takamiya \(自分\) へのメッセージ$/, /^メッセージを送信$/];
const TEXT = "QA2 daily users: 1234 (+5% vs yesterday)";
const FULL_FLOW = [/^qa2-metrics/, /^Message #qa2-metrics/, /^Send now/];
/** The same three choices on the real-shaped (Japanese, tree-sidebar) page. */
const TREE_FLOW = [/^qa2 \[channel\]$/, /^qa2 へのメッセージ$/, /^メッセージを送信$/];
/** @returns {Parameters<typeof createFakeCdp>[0]} */
const treeShape = () => {
  const page = loadSyntheticPage({ shape: "tree" });
  const qa2 = page.conversations.find((conversation) => conversation.id === "C0QA2METRICS");
  assert.ok(qa2);
  qa2.id = "C0QA2";
  qa2.name = "qa2";
  return { page };
};
const UNTRUSTED_PROFILE = { ...SLACK_PROFILE, name: "untrusted-test", trusted: false };

/** @returns {import("./fixtures/synthetic-slack.mjs").SyntheticPage} */
function selfDmPage() {
  const page = loadSyntheticPage({ shape: "tree" });
  page.conversations = page.conversations.filter((conversation) => conversation.kind === "channel");
  page.conversations.push({ id: "D0SELF", name: SELF_DM_NAME, kind: "dm" });
  return page;
}

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

test("draft mode accepts a composer whose only draft is the blank editor newline", async () => {
  // The Beelink reproduction: the qa2 composer is visually empty and its
  // send control is disabled, but the accessibility value is a single
  // U+000A newline; that whitespace-only artifact is empty, not a draft.
  const env = setup();
  env.fake.state.drafts.set("/client/T0SYNTH/C0QA2METRICS", "\n");
  const report = await run(env, { mode: "draft", text: TEXT });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "draft");
  assert.equal(env.fake.currentDraft(), TEXT);
});

test("draft mode refuses when the read-back differs from the exact text", async () => {
  const env = setup();
  env.fake.state.transformDraft = (d) => `${d} (edited by page)`;
  const report = await run(env, { mode: "draft", text: TEXT });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "text_mismatch");
  assert.deepEqual(env.fake.currentMessages(), []);
});

test("draft mode verifies the live reproduction: a multi-paragraph text whose paragraphs read back as blank lines", async () => {
  // The 2026-09 qa2 live attempt: the six-paragraph report was inserted
  // correctly, but the page read every paragraph boundary back as a blank
  // line (362 characters requested, 367 read back), so the exact read-back
  // refused and nothing was posted. The canonical paragraph-aware comparison
  // verifies exactly that representation.
  const env = setup();
  const text = [
    "QA2 new users (Live) for 2026-09-20 (UTC)",
    "New users on 2026-09-20: 1,234",
    "vs 2026-09-19 (1,100): +134 (+12.2%), trend: up",
    "Last 7 days (UTC): 09-14 900 | 09-15 1,000 | 09-16 1,100",
    "Source: Unity Analytics Data Access (Snowflake) | key: unity-new-users:24601:31001:2026-09-20",
  ].join("\n");
  const report = await run(env, { mode: "draft", text });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "draft");
  assert.equal(env.fake.currentDraft(), text, "the draft itself is the exact requested text");
  const draft = /** @type {{readBack: string, verified: boolean}|undefined} */ (report.steps.find((s) => /** @type {{step: string, phase: string}} */ (s).step === "composer" && /** @type {{phase: string}} */ (s).phase === "act"));
  assert.ok(draft);
  assert.equal(draft.verified, true);
  assert.equal(draft.readBack, text.replace(/\n/g, "\n\n"), "the page reads every paragraph boundary as a blank line");
});

test("draft mode refuses a multi-paragraph text when any non-empty line differs", async () => {
  const env = setup();
  env.fake.state.transformDraft = (d) => d.replace("1,234", "1,234 or more");
  const report = await run(env, { mode: "draft", text: "p1\nNew users on 2026-09-20: 1,234\np3" });
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

test("send mode verifies the post even when the cleared composer keeps the blank newline artifact", async () => {
  // A page whose cleared blank composer keeps the whitespace-only artifact
  // (Chromium: U+000A) counts as empty, so the post is still verified.
  const env = setup();
  env.fake.state.clearedDraft = "\n";
  const report = await run(env, { mode: "send", text: TEXT });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
  assert.deepEqual(env.fake.currentMessages(), [TEXT]);
  const posted = /** @type {{verified: boolean, url: string}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "posted"));
  assert.ok(posted);
  assert.equal(posted.verified, true);
  assert.equal(env.fake.currentDraft(), "\n");
});

test("send mode verifies the live reproduction end to end: multi-paragraph draft, composer check, and posted verification", async () => {
  // The 2026-09 qa2 live attempt refused before Send because every safety
  // comparison was exact while the page reads paragraph boundaries as blank
  // lines. All three now compare through the canonical paragraph-aware
  // equality, so the same flow verifies: the read-back, the send-time
  // composer check, and the posted-message verification (here in the joined
  // single-node form the composer representation takes; the split
  // message-list form is covered below).
  const env = setup();
  const text = [
    "QA2 new users (Live) for 2026-09-20 (UTC)",
    "New users on 2026-09-20: 1,234",
    "vs 2026-09-19 (1,100): +134 (+12.2%), trend: up",
    "Last 7 days (UTC): 09-14 900 | 09-15 1,000 | 09-16 1,100",
    "Source: Unity Analytics Data Access (Snowflake) | key: unity-new-users:24601:31001:2026-09-20",
  ].join("\n");
  const report = await run(env, { mode: "send", text });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
  const draft = /** @type {{readBack: string, verified: boolean}|undefined} */ (report.steps.find((s) => /** @type {{step: string, phase: string}} */ (s).step === "composer" && /** @type {{phase: string}} */ (s).phase === "act"));
  assert.ok(draft);
  assert.equal(draft.verified, true);
  assert.equal(draft.readBack, text.replace(/\n/g, "\n\n"), "the page reads every paragraph boundary as a blank line");
  assert.deepEqual(env.fake.currentMessages(), [text], "the posted content is the requested text");
  assert.equal(env.fake.currentDraft(), "");
  const posted = /** @type {{verified: boolean, url: string}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "posted"));
  assert.ok(posted);
  assert.equal(posted.verified, true);
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

/* ------------- the 2026-09-21 split-paragraph post verification ------------- */

/** The six-paragraph report the live qa2 job posts (six lines incl. a missing-days line). */
const REPORT_TEXT = [
  "QA2 new users (Live) for 2026-09-20 (UTC)",
  "New users on 2026-09-20: 1,234",
  "vs 2026-09-19 (1,100): +134 (+12.2%), trend: up",
  "vs trailing 7-day avg 09-14..09-20 (1,071): +163 (+15.2%), trend: up",
  "Last 7 days (UTC): 09-14 900 | 09-15 1,000 | 09-16 1,100 | 09-17 1,000 | 09-18 1,200 | 09-19 1,100 | 09-20 1,234",
  "Days with no rows (counted as 0): 09-13",
  "Source: Unity Analytics Data Access (Snowflake) | key: unity-new-users:24601:31001:2026-09-20",
].join("\n");

test("send mode verifies the 2026-09-21 reproduction: the posted message renders as six separate paragraph nodes", async () => {
  // The 2026-09-21 live qa2 run: the send landed (the immediate rerun was
  // refused with duplicate_post), but Slack renders the six paragraphs of the
  // posted report as six separate accessibility nodes, so no single node
  // carried the exact full text and the post verification failed. The run
  // stayed unverified and no success record was written for 2026-09-21.
  // The verification must read the paragraphs across the split nodes under
  // the same strict paragraph-aware semantics as the composer read-back.
  const env = setup({ splitMessages: true });
  const report = await run(env, { mode: "send", text: REPORT_TEXT });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
  assert.deepEqual(env.fake.currentMessages(), [REPORT_TEXT], "the posted content is the exact requested text");
  assert.equal(env.fake.currentDraft(), "");
  const posted = /** @type {{verified: boolean, url: string}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "posted"));
  assert.ok(posted);
  assert.equal(posted.verified, true);
  assert.equal(posted.url, QA2);
});

test("send mode does not verify a sequence assembled across posted messages", async () => {
  const env = setup({ splitMessages: true });
  env.fake.state.messages.set("/client/T0SYNTH/C0GENERAL", [REPORT_TEXT.split("\n")[0] ?? ""]);
  env.fake.state.transformPosted = (text) => text.split("\n").slice(1).join("\n");
  const report = await run(env, { mode: "send", text: REPORT_TEXT });
  assert.equal(report.status, "unverified");
  assert.equal(report.completed, "send");
});

test("send mode verifies split paragraphs surrounded by message metadata", async () => {
  const env = setup({ splitMessages: true });
  env.fake.state.extraElements.push({
    key: "message:0:pmeta",
    role: "statictext",
    name: "10:00 AM",
    text: "10:00 AM",
    href: null,
    value: null,
    disabled: false,
    attributes: {},
  });
  const report = await run(env, { mode: "send", text: REPORT_TEXT });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
});

test("after a split-paragraph send that failed to verify, a rerun still refuses at the duplicate marker", async () => {
  // The incident's signature: the post landed, so the rerun must refuse at
  // the duplicate marker (the marker line sits inside one paragraph node),
  // even though the previous attempt could not verify its own send.
  const env = setup({ splitMessages: true });
  const first = await run(env, { mode: "send", text: REPORT_TEXT, duplicateMarker: "unity-new-users:24601:31001:2026-09-20" });
  assert.equal(first.status, "executed");
  const again = await run(env, { mode: "send", text: REPORT_TEXT, duplicateMarker: "unity-new-users:24601:31001:2026-09-20" });
  assert.equal(again.status, "refused");
  assert.equal(again.refusal?.code, "duplicate_post");
  assert.deepEqual(env.fake.currentMessages(), [REPORT_TEXT], "nothing is posted twice");
  assert.equal(env.fake.clicks().length, 3, "the first send's three clicks; the rerun is already at the destination and clicks nothing");
});

test("send mode verifies split paragraphs only for the exact sequence: missing, reordered, altered, or extra non-empty paragraphs stay unverified", async () => {
  // The composer held the exact requested text and the send ran, but the
  // page rendered a different paragraph sequence; only the exact sequence
  // verifies, so every deviation reports unverified and no record would be
  // written.
  const cases = /** @type {const} */ ([
    ["a paragraph is missing", (/** @type {string} */ t) => t.replace("Days with no rows (counted as 0): 09-13\n", "")],
    [
      "paragraphs are reordered",
      (/** @type {string} */ t) => {
        const lines = t.split("\n");
        return lines.map((line, index) => (index === 1 ? (lines[2] ?? "") : index === 2 ? (lines[1] ?? "") : line)).join("\n");
      },
    ],
    ["a paragraph is altered", (/** @type {string} */ t) => t.replace("1,234", "1,235")],
    ["an extra non-empty paragraph is inserted", (/** @type {string} */ t) => t.replace("vs 2026-09-19", "unrelated note\nvs 2026-09-19")],
  ]);
  for (const [name, transform] of cases) {
    const env = setup({ splitMessages: true });
    env.fake.state.transformPosted = transform;
    const report = await run(env, { mode: "send", text: REPORT_TEXT });
    assert.equal(report.status, "unverified", name);
    assert.equal(report.completed, "send", name);
    const posted = /** @type {{verified: boolean}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "posted"));
    assert.ok(posted, name);
    assert.equal(posted.verified, false, name);
    assert.notDeepEqual(env.fake.currentMessages(), [REPORT_TEXT], name);
  }
});

test("send mode on the real-shaped page verifies split paragraph nodes and refuses the duplicate rerun", async () => {
  const env = setup({ ...treeShape(), splitMessages: true });
  const marker = "unity-new-users:24601:31001:2026-09-20";
  const report = await run(env, { mode: "send", destination: "qa2", text: REPORT_TEXT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: marker });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
  assert.deepEqual(env.fake.currentMessages(), [REPORT_TEXT]);
  assert.equal(env.fake.currentUrl(), TREE_QA2);
  // The rerun reads the marker inside one of the split paragraph nodes.
  const again = await run(env, { mode: "send", destination: "qa2", text: REPORT_TEXT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: marker });
  assert.equal(again.status, "refused");
  assert.equal(again.refusal?.code, "duplicate_post");
});

/* ----------------------------- emoji report ----------------------------- */

/** The approved four-line QA² layout with synthetic numbers. */
const EMOJI_REPORT = [
  "QA² 新規ユーザー｜9/24（UTC）",
  "👤 1,234人（前日より +56人）",
  "⚖️ 直近7日平均 1,035.4人 より 198.6人多め（+19.2%）",
  "📅 直近7日（9/18→9/24）：1,300 → 1,220 → 1,185 → 1,160 → 1,205 → 1,178 → 1,234人",
].join("\n");
const EMOJI_MARKERS = ["QA² 新規ユーザー｜9/24（UTC）", "unity-new-users:24601:31001:2026-09-24"];

/**
 * @param {ReturnType<typeof setup>} env
 * @param {Partial<Parameters<typeof runWorkflow>[0]>} [overrides]
 */
const sendEmojiToSelfDm = (env, overrides = {}) =>
  run(env, {
    mode: "send",
    destination: SELF_DM_NAME,
    text: EMOJI_REPORT,
    decide: decideByLabel(SELF_DM_FLOW),
    exactDestination: true,
    duplicateMarker: EMOJI_MARKERS,
    ...overrides,
  });

test("the four-line emoji report posts once to the exact self-DM: proven read-back, send-time check, and post verification", async () => {
  const page = selfDmPage();
  page.conversations.push({ id: "C0SAME", name: SELF_DM_NAME, kind: "channel" });
  const env = setup({ page, splitMessages: true });
  const report = await sendEmojiToSelfDm(env);
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
  assert.equal(env.fake.currentUrl(), SELF_DM_URL);
  assert.deepEqual(env.fake.currentMessages(), [EMOJI_REPORT]);
  assert.deepEqual(env.fake.state.sideEffects, []);
  const composer = /** @type {{inlineReplacements: number}|undefined} */ (report.steps.find((s) => /** @type {{step: string, phase: string}} */ (s).step === "composer" && /** @type {{phase: string}} */ (s).phase === "act"));
  assert.equal(composer?.inlineReplacements, 3);
  const posted = /** @type {{verified: boolean}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "posted"));
  assert.equal(posted?.verified, true);
  assert.equal(env.fake.currentMessages()[0]?.split("\n").length, 4);
  // Already posted: the rerun refuses at the title marker before any input.
  const again = await sendEmojiToSelfDm(env);
  assert.equal(again.status, "refused");
  assert.equal(again.refusal?.code, "duplicate_post");
  assert.equal(env.fake.methodCalls("Input.insertText").length, 1);
  assert.deepEqual(env.fake.currentMessages(), [EMOJI_REPORT]);
});

test("the four-line emoji report posts once to the qa2 channel on the real-shaped page", async () => {
  const env = setup({ ...treeShape(), splitMessages: true });
  const report = await run(env, { mode: "send", destination: "qa2", text: EMOJI_REPORT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: EMOJI_MARKERS });
  assert.equal(report.status, "executed");
  assert.deepEqual(env.fake.currentMessages(), [EMOJI_REPORT]);
  assert.equal(env.fake.currentUrl(), TREE_QA2);
});

test("the emoji report refuses before send when accessibility text alone is compared (the 2026-09-25 refusal)", async () => {
  const profile = { ...SLACK_PROFILE, name: "accessibility-only-test", inlineText: undefined };
  const env = setup({ page: selfDmPage(), splitMessages: true }, { profile });
  const report = await sendEmojiToSelfDm(env);
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "text_mismatch");
  assert.equal(report.refusal?.details.stage, "draft_readback");
  assert.equal(report.refusal?.details.check, "ax_value_differs");
  assert.equal(report.completed, "navigate");
  assert.equal(env.fake.clicks().length, 2, "destination and composer focus only; no send click");
  assert.deepEqual(env.fake.currentMessages(), []);
  assert.equal(env.fake.currentDraft(), EMOJI_REPORT, "the unsent draft stays in the composer");
});

test("an emoji changed in the draft between typing and sending refuses before the send click", async () => {
  const env = setup({ page: selfDmPage(), splitMessages: true });
  const decide = decideByLabel(SELF_DM_FLOW, {
    onCall: (index) => {
      if (index === 2) env.fake.state.drafts.set("/client/T0SYNTH/D0SELF", EMOJI_REPORT.replace("📅", "👤"));
    },
  });
  const report = await sendEmojiToSelfDm(env, { decide });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "text_mismatch");
  // The draft changed during the send decision, so the send click's own gate refuses.
  assert.equal(report.refusal?.details.stage, "send_gate");
  assert.equal(report.refusal?.details.check, "inline_text_differs");
  assert.equal(report.completed, "draft");
  assert.equal(env.fake.clicks().length, 2);
  assert.deepEqual(env.fake.currentMessages(), []);
});

test("an emoji image that turns unprovable after a passing read-back refuses at the send precheck and names the check", async () => {
  // The 2026-09-26 shape: the draft read back, then the composer no longer
  // held the text when checked before the send decision. The refusal must
  // say where and which check refused, and nothing is sent.
  const env = setup({ page: selfDmPage(), splitMessages: true });
  const send = env.fake.session.send.bind(env.fake.session);
  let inserted = false;
  let treeReads = 0;
  env.fake.session.send = async (method, params = {}) => {
    const result = await send(method, params);
    if (method === "Input.insertText") inserted = true;
    if (inserted && method === "DOM.describeNode" && params.depth === -1 && ++treeReads === 1) {
      env.fake.state.emojiAttributes = (emoji, where) => (where === "composer" ? { class: "emoji", alt: "", src: "/static/blank.png" } : emojiImageAttributes(emoji, where));
    }
    return result;
  };
  const report = await sendEmojiToSelfDm(env);
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "text_mismatch");
  assert.equal(report.refusal?.details.stage, "send_precheck");
  assert.equal(report.refusal?.details.check, "unresolved_inline");
  assert.equal(report.completed, "draft");
  const composerStep = /** @type {{verified?: boolean}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "composer" && /** @type {{phase: string}} */ (s).phase === "act"));
  assert.equal(composerStep?.verified, true, "the read-back itself passed");
  assert.equal(env.fake.clicks().length, 2, "destination and composer focus only; no send click");
  assert.deepEqual(env.fake.currentMessages(), []);
  assert.equal(env.fake.currentDraft(), EMOJI_REPORT, "the unsent draft stays in the composer");
});

test("a posted emoji message rendered differently or unprovably stays unverified", async () => {
  for (const arrange of [
    (/** @type {ReturnType<typeof setup>} */ env) => { env.fake.state.transformPosted = (draft) => draft.replace("⚖️", "📅"); },
    (/** @type {ReturnType<typeof setup>} */ env) => { env.fake.state.transformPosted = (draft) => draft.replace("👤 ", ""); },
    (/** @type {ReturnType<typeof setup>} */ env) => {
      env.fake.state.emojiAttributes = (emoji, where) => (where === "message" ? { alt: "", src: "/static/blank.png" } : emojiImageAttributes(emoji, where));
    },
    // A ja-JP localized alt alone, without the stable data-stringify-emoji, proves nothing.
    (/** @type {ReturnType<typeof setup>} */ env) => {
      env.fake.state.emojiAttributes = (emoji, where) => {
        const { "data-stringify-emoji": _code, ...rest } = emojiImageAttributes(emoji, where);
        return where === "message" ? rest : emojiImageAttributes(emoji, where);
      };
    },
  ]) {
    const env = setup({ page: selfDmPage(), splitMessages: true });
    arrange(env);
    const report = await sendEmojiToSelfDm(env);
    assert.equal(report.status, "unverified");
    assert.equal(report.completed, "send");
    const posted = /** @type {{verified: boolean}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "posted"));
    assert.equal(posted?.verified, false);
  }
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
  const report = await run(env, { mode: "send", text: TEXT, duplicateMarker: ["QA² 新規ユーザー｜9/20（UTC）", "job-2026-09-20"] });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "duplicate_post");
  assert.equal(report.refusal?.details.marker, "job-2026-09-20");
  assert.equal(report.completed, "navigate");
  assert.equal(env.fake.methodCalls("Input.insertText").length, 0);
  assert.deepEqual(env.fake.currentMessages(), ["earlier post key: job-2026-09-20"]);
  const steps = report.steps.filter((s) => /** @type {{step: string}} */ (s).step === "duplicate");
  assert.deepEqual(steps.map((s) => {
    const step = /** @type {{marker: string, found: number}} */ (s);
    return [step.marker, step.found];
  }), [
    ["QA² 新規ユーザー｜9/20（UTC）", 0],
    ["job-2026-09-20", 1],
  ]);

  const fresh = setup();
  const posted = await run(fresh, { mode: "send", text: TEXT, duplicateMarker: "job-2026-09-21" });
  assert.equal(posted.status, "executed");
  assert.deepEqual(fresh.fake.currentMessages(), [TEXT]);

  const titleCopy = setup();
  titleCopy.fake.state.messages.set("/client/T0SYNTH/C0QA2METRICS", ["*QA² 新規ユーザー｜9/20（UTC）*"]);
  const titleRefusal = await run(titleCopy, {
    mode: "send",
    text: TEXT,
    duplicateMarker: ["QA² 新規ユーザー｜9/20（UTC）", "job-2026-09-20"],
  });
  assert.equal(titleRefusal.status, "refused");
  assert.equal(titleRefusal.refusal?.code, "duplicate_post");
  assert.equal(titleCopy.fake.methodCalls("Input.insertText").length, 0);

  const plan = await run(setup(), { mode: "dry-run", text: TEXT, decide: decideByLabel([/^qa2-metrics/, /^Message #general/, /^Send now/]), exactDestination: true, duplicateMarker: "m" });
  const planStep = /** @type {{guards: object}|undefined} */ (plan.steps.find((s) => /** @type {{step: string}} */ (s).step === "plan"));
  assert.deepEqual(planStep?.guards, { exactDestination: true, duplicateMarker: "m" });
});

/* ----------------------------- allowlisted self-DM ----------------------------- */

test("the exact allowlisted self-DM can send once and its marker blocks a duplicate rerun", async () => {
  const page = selfDmPage();
  page.conversations.push({ id: "C0SAME", name: SELF_DM_NAME, kind: "channel" });
  const env = setup({ page });
  const marker = "synthetic-self-dm-run-1";
  const text = `${TEXT}\n${marker}`;
  const report = await run(env, {
    mode: "send",
    destination: SELF_DM_NAME,
    text,
    decide: decideByLabel(SELF_DM_FLOW),
    exactDestination: true,
    duplicateMarker: marker,
  });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
  assert.equal(report.destination.candidate?.url, SELF_DM_URL);
  assert.equal(env.fake.currentUrl(), SELF_DM_URL);
  assert.deepEqual(env.fake.currentMessages(), [text]);
  assert.equal(env.fake.clicks().length, 3);
  assert.deepEqual(env.fake.state.sideEffects, []);
  const posted = /** @type {{verified: boolean}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "posted"));
  assert.equal(posted?.verified, true);

  const again = await run(env, {
    mode: "send",
    destination: SELF_DM_NAME,
    text,
    decide: decideByLabel(SELF_DM_FLOW),
    exactDestination: true,
    duplicateMarker: marker,
  });
  assert.equal(again.status, "refused");
  assert.equal(again.refusal?.code, "duplicate_post");
  assert.equal(env.fake.methodCalls("Input.insertText").length, 1);
  assert.deepEqual(env.fake.currentMessages(), [text]);
});

test("a similarly named or other DM is not recognized as the allowlisted self-DM", async () => {
  for (const name of ["Yasuhito Takamiya", "Yasuhito Takamiya (自分) copy", "Alice Example"]) {
    const page = selfDmPage();
    const dm = page.conversations.find((conversation) => conversation.kind === "dm");
    assert.ok(dm);
    dm.name = name;
    const env = setup({ page });
    const report = await run(env, {
      mode: "send",
      destination: SELF_DM_NAME,
      text: TEXT,
      decide: decideByLabel([/^Yasuhito|^Alice/]),
      exactDestination: true,
    });
    assert.equal(report.status, "no_match", name);
    assert.equal(report.completed, null, name);
    assertNoInput(env.fake);
  }
});

test("an unproven self-DM identity cannot fall back to another channel", async () => {
  const page = selfDmPage();
  const dm = page.conversations.find((conversation) => conversation.kind === "dm");
  assert.ok(dm);
  dm.name = "Yasuhito Takamiya";
  const env = setup({ page });
  const report = await run(env, {
    mode: "send",
    destination: SELF_DM_NAME,
    text: TEXT,
    decide: decideByLabel([/^general \[channel\]$/]),
    exactDestination: true,
  });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "destination_mismatch");
  assert.equal(report.completed, null);
  assertNoInput(env.fake);
});

test("duplicate exact-name self-DM identities are refused as ambiguous", async () => {
  const page = selfDmPage();
  page.conversations.push({ id: "D0SECOND", name: SELF_DM_NAME, kind: "dm" });
  const env = setup({ page });
  const report = await run(env, {
    mode: "send",
    destination: SELF_DM_NAME,
    text: TEXT,
    decide: decideByLabel(SELF_DM_FLOW),
    exactDestination: true,
  });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "ambiguous_identity");
  assertNoInput(env.fake);
});

test("a same-name channel is not an eligible destination for the self-DM allowlist", async () => {
  const page = selfDmPage();
  page.conversations = page.conversations.filter((conversation) => conversation.kind === "channel");
  page.conversations.push({ id: "C0SAME", name: SELF_DM_NAME, kind: "channel" });
  const env = setup({ page });
  const observed = await env.adapter.observe();
  assert.equal(observed.candidates.some((candidate) => candidate.name === SELF_DM_NAME), false);
  const report = await run(env, {
    mode: "navigate",
    destination: SELF_DM_NAME,
    decide: decideByLabel([/^Yasuhito Takamiya/]),
    exactDestination: true,
  });
  assert.equal(report.status, "no_match");
  assertNoInput(env.fake);
});

test("a self-DM whose observed D identity changes after selection refuses before clicking", async () => {
  const page = selfDmPage();
  const dm = page.conversations.find((conversation) => conversation.kind === "dm");
  assert.ok(dm);
  const env = setup({ page });
  const decide = decideByLabel(SELF_DM_FLOW, { onCall: (index) => { if (index === 0) dm.id = "D0CHANGED"; } });
  const report = await run(env, {
    mode: "send",
    destination: SELF_DM_NAME,
    text: TEXT,
    decide,
    exactDestination: true,
  });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "changed_state");
  assertNoInput(env.fake);
});

test("an unverified self-DM send remains unverified and is never reported as posted", async () => {
  const env = setup({ page: selfDmPage(), startPath: "/client/T0SYNTH/D0SELF" });
  env.fake.state.posting = false;
  const report = await run(env, {
    mode: "send",
    destination: SELF_DM_NAME,
    text: TEXT,
    decide: decideByLabel(SELF_DM_FLOW),
    exactDestination: true,
    duplicateMarker: "synthetic-unverified-run",
  });
  assert.equal(report.status, "unverified");
  assert.equal(report.completed, "send");
  assert.deepEqual(env.fake.currentMessages(), []);
  assert.equal(env.fake.currentDraft(), TEXT);
  assert.equal(env.fake.clicks().length, 2);
  const posted = /** @type {{verified: boolean}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "posted"));
  assert.equal(posted?.verified, false);
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
      ["destination", "treeitem", "qa2 [channel]", TREE_QA2],
      ["destination", "treeitem", "random [channel]", "https://app.slack.com/client/T0SYNTH/C0RANDOM"],
      ["composer", "textbox", "general へのメッセージ", null],
      ["send", "button", "メッセージを送信", null],
    ],
  );
  assertNoInput(env.fake);
});

test("exactDestination on the real-shaped page matches the row's visible name, not its empty accessible name", async () => {
  const ok = await run(setup(treeShape()), { mode: "navigate", destination: "qa2", exactDestination: true, decide: decideByLabel(TREE_FLOW) });
  assert.equal(ok.status, "executed");
  assert.equal(ok.completed, "navigate");
  assert.equal(ok.destination.candidate?.role, "treeitem");
  assert.equal(ok.destination.candidate?.url, TREE_QA2);
  const env = setup(treeShape());
  const report = await run(env, { mode: "navigate", destination: "qa2-wrong", exactDestination: true, decide: decideByLabel(TREE_FLOW) });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "destination_mismatch");
  assertNoInput(env.fake);
});

test("send mode on the real-shaped page drafts through the localized composer and clicks the localized send button once", async () => {
  const env = setup(treeShape());
  const report = await run(env, { mode: "send", destination: "qa2", text: TEXT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: "QA2 daily" });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
  assert.deepEqual(env.fake.currentMessages(), [TEXT]);
  assert.equal(env.fake.currentUrl(), TREE_QA2);
  assert.equal(env.fake.clicks().length, 3);
  assert.deepEqual(env.fake.state.sideEffects, []);
  assert.ok(env.fake.calls.every((c) => ALLOWED.has(c.method)));
  // The second run sees the marker and refuses before typing.
  const again = await run(env, { mode: "send", destination: "qa2", text: TEXT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: "QA2 daily" });
  assert.equal(again.status, "refused");
  assert.equal(again.refusal?.code, "duplicate_post");
});

/**
 * The real client can open a popover over the sidebar (the DM peek card): a
 * hit test at any channel row's click point then resolves to a DM entry
 * inside the popover, outside the row's subtree.
 *
 * @param {ReturnType<typeof createFakeCdp>} fake
 */
function coverSidebarWithPopover(fake) {
  fake.state.extraElements.push({ key: "popover:dm", role: "paragraph", name: "", text: "Alice: see you tomorrow", href: null, value: null, disabled: false, attributes: {} });
  const rows = new Set(fake.page.conversations.map((c) => fake.idFor(`sidebar:${c.id}`)));
  const dmEntry = fake.idFor("popover:dm");
  fake.state.hitTestOverride = (_x, _y, id) => (id !== null && rows.has(id) ? dmEntry : id);
}

test("send mode on the real-shaped page already at the decided channel skips the covered row and posts once", async () => {
  const env = setup({ ...treeShape(), startPath: "/client/T0SYNTH/C0QA2" });
  coverSidebarWithPopover(env.fake);
  const report = await run(env, { mode: "send", destination: "qa2", text: TEXT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: "QA2 daily" });
  assert.equal(report.status, "executed");
  assert.equal(report.completed, "send");
  assert.deepEqual(env.fake.currentMessages(), [TEXT]);
  assert.equal(env.fake.currentUrl(), TREE_QA2);
  // composer and send only: the selected row is never clicked
  assert.equal(env.fake.clicks().length, 2);
  assert.deepEqual(env.fake.state.sideEffects, []);
  const destinationStep = /** @type {Record<string, unknown>|undefined} */ (report.steps.find((s) => /** @type {{step: string, phase: string}} */ (s).step === "destination" && /** @type {{phase: string}} */ (s).phase !== "decide"));
  assert.equal(destinationStep?.phase, "verify");
  assert.equal(destinationStep?.alreadyAtDestination, true);
  assert.equal(destinationStep?.url, TREE_QA2);
  const again = await run(env, { mode: "send", destination: "qa2", text: TEXT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: "QA2 daily" });
  assert.equal(again.status, "refused");
  assert.equal(again.refusal?.code, "duplicate_post");
  assert.equal(env.fake.clicks().length, 2);
});

test("an already selected channel that changes during the destination decision refuses before input", async () => {
  for (const mode of /** @type {const} */ (["navigate", "draft", "send"])) {
    const env = setup({ ...treeShape(), startPath: "/client/T0SYNTH/C0QA2" });
    const decide = decideByLabel(TREE_FLOW, {
      onCall: (index) => {
        if (index === 0) env.fake.state.path = "/client/T0SYNTH/C0GENERAL";
      },
    });
    const report = await run(env, { mode, destination: "qa2", text: TEXT, decide, exactDestination: true, duplicateMarker: "QA2 daily" });
    assert.equal(report.status, "refused");
    assert.equal(report.refusal?.code, "changed_state");
    assert.equal(report.completed, null);
    assertNoInput(env.fake);
  }
});

test("an already selected channel renamed during the destination decision refuses before input", async () => {
  for (const mode of /** @type {const} */ (["navigate", "draft", "send"])) {
    const env = setup({ ...treeShape(), startPath: "/client/T0SYNTH/C0QA2" });
    const qa2 = env.fake.page.conversations.find((conversation) => conversation.id === "C0QA2");
    assert.ok(qa2);
    const decide = decideByLabel(TREE_FLOW, {
      onCall: (index) => {
        if (index === 0) qa2.name = "qa2-renamed";
      },
    });
    const report = await run(env, { mode, destination: "qa2", text: TEXT, decide, exactDestination: true, duplicateMarker: "QA2 daily" });
    assert.equal(report.status, "refused");
    assert.equal(report.refusal?.code, "changed_state");
    assert.equal(report.completed, null);
    assertNoInput(env.fake);
  }
});

test("a popover over the decided row still refuses the navigation click when the page is elsewhere", async () => {
  const env = setup(treeShape());
  coverSidebarWithPopover(env.fake);
  const report = await run(env, { mode: "send", destination: "qa2", text: TEXT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: "QA2 daily" });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "ambiguous_identity");
  assert.equal(report.completed, null);
  assert.equal(env.fake.currentUrl(), "https://app.slack.com/client/T0SYNTH/C0GENERAL");
  assertNoInput(env.fake);
});

test("only the exact destination URL skips the navigation click; a page under it still clicks the row", async () => {
  const env = setup({ ...treeShape(), startPath: "/client/T0SYNTH/C0QA2/thread/C0QA2-1" });
  coverSidebarWithPopover(env.fake);
  const report = await run(env, { mode: "navigate", destination: "qa2", exactDestination: true, decide: decideByLabel(TREE_FLOW) });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "ambiguous_identity");
  assertNoInput(env.fake);
});

test("already at the decided channel, a wrong-name destination is still refused before any input", async () => {
  const env = setup({ ...treeShape(), startPath: "/client/T0SYNTH/C0QA2" });
  const report = await run(env, { mode: "send", destination: "qa2-wrong", text: TEXT, decide: decideByLabel(TREE_FLOW), exactDestination: true, duplicateMarker: "QA2 daily" });
  assert.equal(report.status, "refused");
  assert.equal(report.refusal?.code, "destination_mismatch");
  assertNoInput(env.fake);
});

test("on the real-shaped page a renamed row or a row whose key changed refuses before the click", async () => {
  const env = setup(treeShape());
  const first = await env.adapter.observe();
  const qa2 = first.candidates.find((c) => c.label === "qa2 [channel]");
  assert.ok(qa2);
  const conv = env.fake.page.conversations.find((c) => c.id === "C0QA2");
  assert.ok(conv);
  conv.name = "qa2-renamed";
  await assert.rejects(env.adapter.click(first, qa2.id), (/** @type {{code: string}} */ err) => err.code === "changed_state");
  conv.name = "qa2";
  conv.id = "C0MOVED";
  await assert.rejects(env.adapter.click(first, qa2.id), (/** @type {{code: string}} */ err) => err.code === "changed_state");
  assertNoInput(env.fake);
});
