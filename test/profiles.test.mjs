import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GENERIC_PROFILE } from "../src/profiles/profile.mjs";
import { SLACK_PROFILE, SLACK_LOCAL_SYNTHETIC_PROFILE, classifySlackTarget } from "../src/profiles/slack.mjs";
import { PROFILES, DEFAULT_PROFILE_NAME } from "../src/profiles/index.mjs";
import { ALLOWED_CDP_METHODS, CdpAdapter } from "../src/cdp/adapter.mjs";
import { createFakeCdp } from "./fake-cdp.mjs";

const SLACK = { id: "T1", url: "https://app.slack.com/client/T0SYNTH/C0GENERAL", origin: "https://app.slack.com", title: "general" };

/**
 * @param {Partial<import("../src/profiles/profile.mjs").ObservedNode>} overrides
 * @returns {import("../src/profiles/profile.mjs").ObservedNode}
 */
function node(overrides) {
  return { backendNodeId: 1, role: "link", name: "x", url: null, value: null, disabled: false, focused: false, ...overrides };
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

test("slack profile recognizes same-origin client links as destinations with a kind tag", () => {
  const channel = SLACK_PROFILE.recognize(node({ name: "general", url: "https://app.slack.com/client/T0SYNTH/C0GENERAL" }), SLACK);
  assert.deepEqual(channel, { kind: "destination", label: "general [channel]" });
  const dm = SLACK_PROFILE.recognize(node({ name: "Alice", url: "https://app.slack.com/client/T0SYNTH/D0ALICE" }), SLACK);
  assert.deepEqual(dm, { kind: "destination", label: "Alice [direct message]" });
  const group = SLACK_PROFILE.recognize(node({ name: "trio", url: "https://app.slack.com/client/T0SYNTH/G0TRIO" }), SLACK);
  assert.deepEqual(group, { kind: "destination", label: "trio [group message]" });
  const workspace = SLACK_PROFILE.recognize(node({ name: "Acme", url: "https://app.slack.com/client/T0SYNTH/" }), SLACK);
  assert.deepEqual(workspace, { kind: "destination", label: "Acme [workspace]" });
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

/* ----------------------------- generic profile ----------------------------- */

test("generic profile observes links, editables, and buttons but is never trusted and never allows an action", () => {
  const target = { id: "T", url: "https://example.com/app", origin: "https://example.com", title: "App" };
  assert.equal(GENERIC_PROFILE.trusted, false);
  assert.equal(GENERIC_PROFILE.checkTarget(target).ok, true);
  assert.equal(GENERIC_PROFILE.checkTarget({ ...target, url: "file:///x.html", origin: "null" }).ok, false);
  assert.deepEqual(GENERIC_PROFILE.recognize(node({ name: "Docs", url: "https://example.com/docs" }), target), { kind: "destination", label: "Docs" });
  assert.deepEqual(GENERIC_PROFILE.recognize(node({ role: "textbox", name: "Comment" }), target), { kind: "composer", label: "Comment" });
  assert.deepEqual(GENERIC_PROFILE.recognize(node({ role: "button", name: "Delete" }), target), { kind: "control", label: "Delete" });
  assert.equal(GENERIC_PROFILE.recognize(node({ name: "js", url: "javascript:alert(1)" }), target), null);
  for (const kind of /** @type {const} */ (["destination", "composer", "send", "control"])) {
    assert.equal(GENERIC_PROFILE.allowAction(candidate({ kind }), "click", target).ok, false);
  }
});

test("profile registry exposes the named profiles and defaults to slack", () => {
  assert.deepEqual([...PROFILES.keys()].sort(), ["generic-web", "slack", "slack-local-synthetic"]);
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
