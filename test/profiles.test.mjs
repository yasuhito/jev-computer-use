import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SLACK_PROFILE, SLACK_LOCAL_SYNTHETIC_PROFILE, classifySlackTarget, sidebarChannelUrl } from "../src/profiles/slack.mjs";
import { PROFILES, DEFAULT_PROFILE_NAME } from "../src/profiles/index.mjs";
import { ALLOWED_CDP_METHODS, CdpAdapter } from "../src/cdp/adapter.mjs";
import { createFakeCdp } from "./fake-cdp.mjs";
import { loadSyntheticPage } from "./fixtures/synthetic-slack.mjs";

const SLACK = { id: "T1", url: "https://app.slack.com/client/T0SYNTH/C0GENERAL", origin: "https://app.slack.com", title: "general" };
const QA2_URL = "https://app.slack.com/client/T0SYNTH/C0QA2";

/**
 * @param {Partial<import("../src/profiles/profile.mjs").ObservedNode>} overrides
 * @returns {import("../src/profiles/profile.mjs").ObservedNode}
 */
function node(overrides) {
  return { backendNodeId: 1, role: "link", name: "x", contentText: "", url: null, value: null, disabled: false, focused: false, attributes: {}, ...overrides };
}

/**
 * A sidebar row as the real Slack client renders it: role treeitem, an empty
 * accessible name, the visible name only in its contents, the conversation
 * id in data-item-key, and no link.
 * @param {string} key
 * @param {string} text
 * @param {Partial<import("../src/profiles/profile.mjs").ObservedNode>} [overrides]
 */
function row(key, text, overrides = {}) {
  return node({ role: "treeitem", name: "", contentText: text, attributes: { "data-qa": "virtual-list-item", "data-item-key": key, "aria-current": "false" }, ...overrides });
}

/**
 * @param {Partial<import("../src/profiles/profile.mjs").Candidate>} overrides
 * @returns {import("../src/profiles/profile.mjs").Candidate}
 */
function candidate(overrides) {
  return {
    id: "n1",
    kind: "destination",
    role: "link",
    label: "x",
    name: "x",
    url: "https://app.slack.com/client/T0SYNTH/C0GENERAL",
    value: null,
    disabled: false,
    backendNodeId: 1,
    attributes: {},
    ...overrides,
  };
}

/* ----------------------------- Slack profile ----------------------------- */

test("slack profile accepts only the Slack web client origin as a target", () => {
  assert.equal(SLACK_PROFILE.checkTarget(SLACK).ok, true);
  for (const url of [
    "https://slack.com/client/T0SYNTH/C0GENERAL",
    "http://app.slack.com/client/T0SYNTH/C0GENERAL",
    "https://app.slack.com.evil.example/client/T0SYNTH/C0GENERAL",
    "file:///tmp/page.html",
    "not a url",
  ]) {
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return "null";
      }
    })();
    assert.equal(SLACK_PROFILE.checkTarget({ ...SLACK, url, origin }).ok, false, url);
  }
});

test("slack profile recognizes only same-origin channel links as destinations", () => {
  const channel = SLACK_PROFILE.recognize(node({ name: "general", url: "https://app.slack.com/client/T0SYNTH/C0GENERAL" }), SLACK);
  assert.deepEqual(channel, { kind: "destination", label: "general [channel]" });
  for (const url of [
    "https://app.slack.com/client/T0SYNTH/D0ALICE",
    "https://app.slack.com/client/T0SYNTH/G0TRIO",
    "https://app.slack.com/client/T0SYNTH/",
  ]) {
    assert.equal(SLACK_PROFILE.recognize(node({ name: "not a channel", url }), SLACK), null, url);
  }
});

test("slack profile never recognizes external, query, admin, sign-out, download, or cross-origin links", () => {
  for (const url of [
    "https://example.com/help",
    "https://app.slack.com/client/T0SYNTH/C0GENERAL?settings=1",
    "https://app.slack.com/client/T0SYNTH/C0GENERAL#thread",
    "https://app.slack.com/admin/settings",
    "https://app.slack.com/admin/delete/C0GENERAL",
    "https://app.slack.com/signout",
    "https://app.slack.com/export.zip",
    "https://acme.slack.com/client/T0SYNTH/C0GENERAL",
    "https://app.slack.com/client/T0SYNTH/C0GENERAL/extra",
    "https://app.slack.com/client/lower/C0GENERAL",
  ]) {
    assert.equal(SLACK_PROFILE.recognize(node({ name: "x", url }), SLACK), null, url);
  }
  assert.equal(SLACK_PROFILE.recognize(node({ name: "", url: "https://app.slack.com/client/T0SYNTH/C0GENERAL" }), SLACK), null);
  assert.equal(classifySlackTarget("https://app.slack.com/client/T0SYNTH/C0GENERAL", "https://acme.slack.com"), null);
});

test("slack profile recognizes only the message composer and the send button among controls", () => {
  assert.deepEqual(SLACK_PROFILE.recognize(node({ role: "textbox", name: "Message #general" }), SLACK), {
    kind: "composer",
    label: "Message #general",
  });
  assert.deepEqual(SLACK_PROFILE.recognize(node({ role: "textbox", name: "Message Alice Example" }), SLACK), {
    kind: "composer",
    label: "Message Alice Example",
  });
  assert.equal(SLACK_PROFILE.recognize(node({ role: "textbox", name: "Search" }), SLACK), null);
  assert.equal(SLACK_PROFILE.recognize(node({ role: "textbox", name: "Reply to thread" }), SLACK), null);
  assert.deepEqual(SLACK_PROFILE.recognize(node({ role: "button", name: "Send now" }), SLACK), { kind: "send", label: "Send now" });
  assert.deepEqual(SLACK_PROFILE.recognize(node({ role: "button", name: "Send" }), SLACK), { kind: "send", label: "Send" });
  for (const name of ["Add reaction", "Upload file", "New message", "Schedule for later", "Delete message", "Send to thread", "Sign out"]) {
    assert.equal(SLACK_PROFILE.recognize(node({ role: "button", name }), SLACK), null, name);
  }
  assert.equal(SLACK_PROFILE.recognize(node({ role: "menuitem", name: "Send now" }), SLACK), null);
});

test("slack profile recognizes sidebar channel rows by their data-item-key and names them from their contents", () => {
  // The real client leaves the row's accessible name empty (its name sits
  // under a draggable wrapper), so recognition must not depend on it.
  assert.deepEqual(SLACK_PROFILE.recognize(row("C0QA2", "qa2"), SLACK), {
    kind: "destination",
    label: "qa2 [channel]",
    name: "qa2",
    url: QA2_URL,
  });
  // The client page may be at any conversation of the team; the row's URL is the team plus its key.
  const atDm = { ...SLACK, url: "https://app.slack.com/client/T0SYNTH/D0ALICE" };
  assert.equal(SLACK_PROFILE.recognize(row("C0QA2", "qa2"), atDm)?.url, QA2_URL);
  // A browser that does compute the row's name wins over its contents.
  assert.equal(SLACK_PROFILE.recognize(row("C0QA2", "qa2", { name: "qa2, 3 unread" }), SLACK)?.name, "qa2, 3 unread");
  // Unread badges and suffixes in the contents are decoration after the name.
  assert.equal(SLACK_PROFILE.recognize(row("C0QA2", "qa2 3"), SLACK)?.name, "qa2 3");
  assert.equal(sidebarChannelUrl(row("C0QA2", "qa2"), SLACK), QA2_URL);
});

test("slack profile never recognizes sidebar rows that are not channels of the current team page", () => {
  /** @type {Array<[string, string]>} */
  const notChannels = [
    ["D0ALICE", "Alice Example"], // direct message
    ["G0TRIO", "trio"], // group
    ["section-channels", "Channels"], // section header
    ["Vxxxxxxxxxxx", "Home"], // workspace views
    ["c0lower", "lower"],
    ["C", "too short"],
  ];
  for (const [key, text] of notChannels) {
    assert.equal(SLACK_PROFILE.recognize(row(key, text), SLACK), null, key);
  }
  assert.equal(SLACK_PROFILE.recognize(row("C0QA2", "qa2", { attributes: {} }), SLACK), null, "no attributes fetched");
  assert.equal(SLACK_PROFILE.recognize(row("C0QA2", ""), SLACK), null, "no visible name");
  assert.equal(SLACK_PROFILE.recognize(row("C0QA2", "qa2", { role: "listitem" }), SLACK), null, "not a tree row");
  for (const url of ["https://app.slack.com/", "https://app.slack.com/client/", "https://app.slack.com/client/lower/C0GENERAL", "https://app.slack.com/admin/T0SYNTH/C0GENERAL"]) {
    assert.equal(SLACK_PROFILE.recognize(row("C0QA2", "qa2"), { ...SLACK, url }), null, url);
  }
});

test("slack profile recognizes the composer and send button by Slack's data-qa hooks when the UI is not English", () => {
  const composer = node({ role: "textbox", name: "qa2 へのメッセージ", attributes: { "data-qa": "texty_input", contenteditable: "true", "aria-multiline": "true" } });
  assert.deepEqual(SLACK_PROFILE.recognize(composer, SLACK), { kind: "composer", label: "qa2 へのメッセージ" });
  const send = node({ role: "button", name: "メッセージを送信", attributes: { "data-qa": "texty_send_button" } });
  assert.deepEqual(SLACK_PROFILE.recognize(send, SLACK), { kind: "send", label: "メッセージを送信" });
  // Same names without the hooks, or the hooks on other roles or controls, are not enough.
  assert.equal(SLACK_PROFILE.recognize(node({ role: "textbox", name: "qa2 へのメッセージ" }), SLACK), null);
  assert.equal(SLACK_PROFILE.recognize(node({ role: "button", name: "メッセージを送信" }), SLACK), null);
  assert.equal(SLACK_PROFILE.recognize(node({ role: "textbox", name: "検索", attributes: { "data-qa": "top_nav_search" } }), SLACK), null);
  assert.equal(SLACK_PROFILE.recognize(node({ role: "button", name: "送信オプション", attributes: { "data-qa": "texty_send_options_button" } }), SLACK), null);
  assert.equal(SLACK_PROFILE.recognize(node({ role: "menuitem", name: "メッセージを送信", attributes: { "data-qa": "texty_send_button" } }), SLACK), null);
  assert.equal(SLACK_PROFILE.recognize(node({ role: "button", name: "", attributes: { "data-qa": "texty_send_button" } }), SLACK), null, "unnamed control");
  assert.deepEqual([...(SLACK_PROFILE.attributeRoles ?? [])].sort(), ["button", "textbox", "treeitem"]);
});

test("slack profile permission matrix: destination click, composer click/insertText, enabled send click", () => {
  const dest = candidate({});
  assert.equal(SLACK_PROFILE.allowAction(dest, "click", SLACK).ok, true);
  assert.equal(SLACK_PROFILE.allowAction(dest, "insertText", SLACK).ok, false);
  assert.equal(SLACK_PROFILE.allowAction(candidate({ url: "https://example.com/" }), "click", SLACK).ok, false);

  const composer = candidate({ kind: "composer", role: "textbox", name: "Message #general", label: "Message #general", url: null });
  assert.equal(SLACK_PROFILE.allowAction(composer, "click", SLACK).ok, true);
  assert.equal(SLACK_PROFILE.allowAction(composer, "insertText", SLACK).ok, true);
  assert.equal(SLACK_PROFILE.allowAction({ ...composer, name: "Search", label: "Search" }, "insertText", SLACK).ok, false);

  const send = candidate({ kind: "send", role: "button", name: "Send now", label: "Send now", url: null });
  assert.equal(SLACK_PROFILE.allowAction(send, "click", SLACK).ok, true);
  assert.equal(SLACK_PROFILE.allowAction(send, "insertText", SLACK).ok, false);
  assert.equal(SLACK_PROFILE.allowAction({ ...send, disabled: true }, "click", SLACK).ok, false);
  assert.equal(SLACK_PROFILE.allowAction({ ...send, name: "Upload file", label: "Upload file" }, "click", SLACK).ok, false);

  const control = candidate({ kind: "control", role: "button", name: "Add reaction", label: "Add reaction", url: null });
  assert.equal(SLACK_PROFILE.allowAction(control, "click", SLACK).ok, false);
});

test("slack profile permission matrix for the real client's rows and localized controls", () => {
  const rowAttrs = { "data-qa": "virtual-list-item", "data-item-key": "C0QA2", "aria-current": "false" };
  const qa2 = candidate({ role: "treeitem", name: "qa2", label: "qa2 [channel]", url: QA2_URL, attributes: rowAttrs });
  assert.equal(SLACK_PROFILE.allowAction(qa2, "click", SLACK).ok, true);
  assert.equal(SLACK_PROFILE.allowAction(qa2, "insertText", SLACK).ok, false);
  // The row's key and its URL must agree, on the page's team, and be a channel.
  assert.equal(SLACK_PROFILE.allowAction({ ...qa2, url: "https://app.slack.com/client/T0SYNTH/C0OTHER" }, "click", SLACK).ok, false);
  assert.equal(SLACK_PROFILE.allowAction({ ...qa2, attributes: { ...rowAttrs, "data-item-key": "D0ALICE" }, url: "https://app.slack.com/client/T0SYNTH/D0ALICE" }, "click", SLACK).ok, false);
  assert.equal(SLACK_PROFILE.allowAction({ ...qa2, attributes: {} }, "click", SLACK).ok, false);
  assert.equal(SLACK_PROFILE.allowAction({ ...qa2, url: null }, "click", SLACK).ok, false);
  assert.equal(SLACK_PROFILE.allowAction({ ...qa2, role: "listitem" }, "click", SLACK).ok, false);
  assert.equal(SLACK_PROFILE.allowAction(qa2, "click", { ...SLACK, url: "https://app.slack.com/", origin: "https://app.slack.com" }).ok, false);

  const composer = candidate({ kind: "composer", role: "textbox", name: "qa2 へのメッセージ", label: "qa2 へのメッセージ", url: null, attributes: { "data-qa": "texty_input" } });
  assert.equal(SLACK_PROFILE.allowAction(composer, "click", SLACK).ok, true);
  assert.equal(SLACK_PROFILE.allowAction(composer, "insertText", SLACK).ok, true);
  assert.equal(SLACK_PROFILE.allowAction({ ...composer, attributes: {} }, "insertText", SLACK).ok, false);

  const send = candidate({ kind: "send", role: "button", name: "メッセージを送信", label: "メッセージを送信", url: null, attributes: { "data-qa": "texty_send_button" } });
  assert.equal(SLACK_PROFILE.allowAction(send, "click", SLACK).ok, true);
  assert.equal(SLACK_PROFILE.allowAction({ ...send, disabled: true }, "click", SLACK).ok, false);
  assert.equal(SLACK_PROFILE.allowAction({ ...send, attributes: { "data-qa": "texty_send_options_button" } }, "click", SLACK).ok, false);
  assert.equal(SLACK_PROFILE.allowAction({ ...send, attributes: {} }, "click", SLACK).ok, false);
});

test("observing the real-shaped synthetic page under the slack profile yields exactly the channel rows, the composer, and the send button", async () => {
  const fake = createFakeCdp({ page: loadSyntheticPage({ shape: "tree" }) });
  const adapter = new CdpAdapter({ session: fake.session, profile: SLACK_PROFILE });
  const snapshot = await adapter.observe();
  assert.deepEqual(
    snapshot.candidates.map((c) => [c.kind, c.role, c.name, c.label, c.url]),
    [
      ["destination", "treeitem", "general", "general [channel]", "https://app.slack.com/client/T0SYNTH/C0GENERAL"],
      ["destination", "treeitem", "qa2-metrics", "qa2-metrics [channel]", "https://app.slack.com/client/T0SYNTH/C0QA2METRICS"],
      ["destination", "treeitem", "random", "random [channel]", "https://app.slack.com/client/T0SYNTH/C0RANDOM"],
      ["composer", "textbox", "general へのメッセージ", "general へのメッセージ", null],
      ["send", "button", "メッセージを送信", "メッセージを送信", null],
    ],
  );
  // Attributes are fetched once per node of the profile's roles: 6 tree rows
  // (2 section headers, 3 channels, 1 DM), 2 textboxes (composer, search
  // decoy), 6 buttons (send + 5 decoys); never for links or headings.
  const lookups = fake.methodCalls("DOM.describeNode");
  assert.equal(lookups.length, 6 + 2 + 6);
  assert.ok(lookups.every((c) => c.params.depth === 0));
  assert.ok(fake.calls.every((c) => ALLOWED_CDP_METHODS.includes(c.method)));
  assert.equal(snapshot.digest, (await adapter.observe()).digest, "the digest is stable across observations");
});

test("slack-local-synthetic profile accepts only loopback http origins", () => {
  const local = { ...SLACK, url: "http://127.0.0.1:8765/client/T0SYNTH/C0GENERAL", origin: "http://127.0.0.1:8765" };
  assert.equal(SLACK_LOCAL_SYNTHETIC_PROFILE.checkTarget(local).ok, true);
  assert.equal(
    SLACK_LOCAL_SYNTHETIC_PROFILE.checkTarget({ ...local, url: "http://localhost:3000/client/T0SYNTH/C0GENERAL", origin: "http://localhost:3000" }).ok,
    true,
  );
  assert.equal(SLACK_LOCAL_SYNTHETIC_PROFILE.checkTarget(SLACK).ok, false);
  assert.equal(
    SLACK_LOCAL_SYNTHETIC_PROFILE.checkTarget({ ...local, url: "http://evil.example/client/T0SYNTH/C0GENERAL", origin: "http://evil.example" }).ok,
    false,
  );
  assert.equal(SLACK_LOCAL_SYNTHETIC_PROFILE.trusted, true);
  const link = SLACK_LOCAL_SYNTHETIC_PROFILE.recognize(node({ name: "general", url: "http://127.0.0.1:8765/client/T0SYNTH/C0GENERAL" }), local);
  assert.deepEqual(link, { kind: "destination", label: "general [channel]" });
  assert.equal(SLACK_LOCAL_SYNTHETIC_PROFILE.recognize(node({ name: "general", url: "https://app.slack.com/client/T0SYNTH/C0GENERAL" }), local), null);
});

test("profile registry exposes the named profiles and defaults to slack", () => {
  assert.deepEqual([...PROFILES.keys()].sort(), ["slack", "slack-local-synthetic"]);
  assert.equal(DEFAULT_PROFILE_NAME, "slack");
});

/* ----------------------------- separation ----------------------------- */

test("the adapter and transport know nothing about Slack", () => {
  for (const file of ["../src/cdp/adapter.mjs", "../src/cdp/transport.mjs", "../src/workflow.mjs"]) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /slack/i, `${file} must not mention Slack`);
    assert.doesNotMatch(source, /profiles\/slack/, `${file} must not import the Slack profile`);
  }
});

test("the adapter's closed CDP method set excludes evaluation, key input, navigation, network, and storage", () => {
  const forbidden = [
    /^Runtime\./,
    /^Page\.navigate/,
    /^Page\.reload/,
    /^Page\.handleJavaScriptDialog/,
    /^Input\.dispatchKeyEvent/,
    /^Input\.dispatchDragEvent/,
    /^Network\./,
    /^Storage\./,
    /^Browser\./,
    /^Emulation\./,
    /^Fetch\./,
    /^DOM\.setAttributeValue/,
    /^DOM\.removeNode/,
    /^DOM\.setOuterHTML/,
    /^DOM\.setFileInputFiles/,
    /^Debugger\./,
    /^Target\.(createTarget|closeTarget|attachToTarget)/,
  ];
  for (const method of ALLOWED_CDP_METHODS) {
    for (const pattern of forbidden) assert.doesNotMatch(method, pattern);
  }
  assert.ok(ALLOWED_CDP_METHODS.includes("Input.dispatchMouseEvent"));
  assert.ok(ALLOWED_CDP_METHODS.includes("Input.insertText"));
  assert.ok(ALLOWED_CDP_METHODS.includes("Accessibility.getFullAXTree"));
});

test("a custom profile plugs into the adapter and an untrusted one can observe but never act", async () => {
  /** @type {import("../src/profiles/profile.mjs").Profile} */
  const buttonsOnly = {
    name: "buttons-only",
    description: "test profile",
    trusted: false,
    checkTarget: () => ({ ok: true }),
    recognize: (n) => (n.role === "button" ? { kind: "control", label: `button ${n.name}` } : null),
    allowAction: () => ({ ok: true }),
  };
  const fake = createFakeCdp({ origin: "https://anything.example" });
  const adapter = new CdpAdapter({ session: fake.session, profile: buttonsOnly });
  const snapshot = await adapter.observe();
  assert.ok(snapshot.candidates.length > 0);
  assert.ok(snapshot.candidates.every((c) => c.role === "button" && c.kind === "control" && c.label.startsWith("button ")));
  const first = snapshot.candidates[0];
  assert.ok(first);
  await assert.rejects(adapter.click(snapshot, first.id), (/** @type {import("../src/errors.mjs").RefusalError} */ err) => {
    assert.equal(err.code, "untrusted_profile");
    return true;
  });
  assert.equal(fake.methodCalls("Input.dispatchMouseEvent").length, 0);
});
