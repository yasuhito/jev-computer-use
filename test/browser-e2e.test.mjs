/**
 * Opt-in end-to-end run of the bounded workflow against the synthetic Slack
 * page in a real headless Chromium: the page's script turns the report's
 * Unicode emoji into images the way the real client does, so Chromium's own
 * accessibility tree and DOM exercise the insertText read-back, the
 * send-time composer check, and the post verification. Nothing leaves
 * 127.0.0.1, and the decision dependency is the offline label matcher.
 *
 * Skipped unless JEV_CU_E2E_CHROME names a Chromium or Chrome binary and the
 * runtime has a global WebSocket (Node 22 or newer):
 *
 *   JEV_CU_E2E_CHROME=$(command -v chromium) node --test test/browser-e2e.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpAdapter } from "../src/cdp/adapter.mjs";
import { listPageTargets, connectPageSession } from "../src/cdp/transport.mjs";
import { SLACK_LOCAL_SYNTHETIC_PROFILE } from "../src/profiles/slack.mjs";
import { runWorkflow } from "../src/workflow.mjs";
import { loadSyntheticPage, renderHtml, EMOJI_ASSET_PREFIX, BLANK_GIF } from "./fixtures/synthetic-slack.mjs";
import { decideByLabel } from "./helpers.mjs";

const CHROME = process.env.JEV_CU_E2E_CHROME;
const SKIP = !CHROME ? "set JEV_CU_E2E_CHROME to a Chromium binary to run" : typeof globalThis.WebSocket !== "function" ? "needs a global WebSocket (Node 22+)" : false;

const SELF_DM_NAME = "Yasuhito Takamiya (自分)";
const SELF_DM_FLOW = [/^Yasuhito Takamiya \(自分\) \[self direct message\]$/, /^Yasuhito Takamiya \(自分\) へのメッセージ$/, /^メッセージを送信$/];
/** The approved four-line QA² layout with synthetic numbers. */
const EMOJI_REPORT = [
  "QA² 新規ユーザー｜9/24（UTC）",
  "👤 1,234人（前日より +56人）",
  "⚖️ 直近7日平均 1,035.4人 より 198.6人多め（+19.2%）",
  "📅 直近7日（9/18→9/24）：1,300 → 1,220 → 1,185 → 1,160 → 1,205 → 1,178 → 1,234人",
].join("\n");
const MARKERS = ["QA² 新規ユーザー｜9/24（UTC）", "unity-new-users:24601:31001:2026-09-24"];

/** The real-shaped page with the allowlisted self-DM and a same-name channel. */
function page() {
  const synthetic = loadSyntheticPage({ shape: "tree" });
  synthetic.conversations = synthetic.conversations.filter((c) => c.kind === "channel");
  synthetic.conversations.push({ id: "C0SAME", name: SELF_DM_NAME, kind: "channel" });
  synthetic.conversations.push({ id: "D0SELF", name: SELF_DM_NAME, kind: "dm" });
  return synthetic;
}

/**
 * Serve the page and start a headless Chromium on it; returns a connected
 * page session plus a cleanup.
 */
async function launch() {
  const synthetic = page();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith(EMOJI_ASSET_PREFIX)) {
      res.writeHead(200, { "content-type": "image/gif" });
      res.end(BLANK_GIF);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderHtml(synthetic, url.pathname));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const profileDir = await mkdtemp(join(tmpdir(), "jev-cu-e2e-"));
  const chrome = spawn(
    /** @type {string} */ (CHROME),
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--window-size=1280,2000", `http://127.0.0.1:${port}/client/T0SYNTH/C0GENERAL`],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const devtools = await new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not start")), 20_000);
    chrome.stderr.on("data", (chunk) => {
      buffered += String(chunk);
      const match = /DevTools listening on ws:\/\/([^/]+)\//.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve(`http://${match[1]}`);
      }
    });
  });
  /** @type {import("../src/cdp/transport.mjs").PageTarget|undefined} */
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    target = (await listPageTargets(/** @type {string} */ (devtools))).find((t) => t.type === "page" && t.url.includes("/client/T0SYNTH/"));
    if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(target, "the synthetic page target is up");
  const session = await connectPageSession(target);
  // Wait until the page has rendered its sidebar.
  const probe = new CdpAdapter({ session, profile: SLACK_LOCAL_SYNTHETIC_PROFILE });
  for (let i = 0; i < 100; i++) {
    const snapshot = await probe.observe().catch(() => null);
    if (snapshot && snapshot.candidates.some((c) => c.kind === "destination")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const cleanup = async () => {
    session.close();
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await exited;
    server.close();
    await rm(profileDir, { recursive: true, force: true });
  };
  return { session, cleanup };
}

/**
 * The posted messages as the page rendered them: each line's text with
 * every emoji image shown as its data-stringify-emoji shortcode, read over
 * the test's own CDP session (the adapter never evaluates JavaScript).
 *
 * @param {import("../src/cdp/adapter.mjs").CdpSession} session
 */
async function renderedMessages(session) {
  const { result } = await session.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll("#messages > li")).map(function (li) {
      var out = "";
      li.querySelectorAll(".p-rich_text_section").forEach(function (section) {
        section.childNodes.forEach(function (node) {
          if (node.nodeType === 3) out += node.nodeValue;
          else if (node.nodeName === "BR") out += "\\n";
          else { var img = node.querySelector("img"); out += img ? "[" + img.getAttribute("data-stringify-emoji") + "]" : "?"; }
        });
      });
      return out;
    })`,
  });
  return /** @type {string[]} */ (result.value);
}

/** @param {import("../src/cdp/adapter.mjs").CdpSession} session @param {import("../src/profiles/profile.mjs").Profile} profile */
const adapterFor = (session, profile) => new CdpAdapter({ session, profile });

/**
 * @param {CdpAdapter} adapter
 * @param {RegExp[]} [flow]
 */
const send = (adapter, flow = SELF_DM_FLOW) =>
  runWorkflow({
    mode: "send",
    destination: SELF_DM_NAME,
    text: EMOJI_REPORT,
    adapter,
    decide: decideByLabel(flow),
    maxCandidates: 40,
    exactDestination: true,
    duplicateMarker: MARKERS,
  });

test("real Chromium: accessibility text alone refuses the emoji report before the send click (the 2026-09-25 refusal)", { skip: SKIP }, async () => {
  const { session, cleanup } = await launch();
  try {
    const profile = { ...SLACK_LOCAL_SYNTHETIC_PROFILE, name: "accessibility-only-test", inlineText: undefined };
    const report = await send(adapterFor(session, profile));
    assert.equal(report.status, "refused");
    assert.equal(report.refusal?.code, "text_mismatch");
    assert.equal(report.completed, "navigate");
    // Chromium's own read-back: the text with every emoji image missing.
    assert.equal(
      String(report.refusal?.details.readBack).split("\n").filter((line) => line !== "").join("\n"),
      EMOJI_REPORT.replace(/👤|⚖️|📅/g, ""),
    );
    assert.deepEqual(await renderedMessages(session), []);
  } finally {
    await cleanup();
  }
});

test("real Chromium: the emoji report posts once to the self-DM in the approved four-line layout and a rerun refuses", { skip: SKIP }, async () => {
  const { session, cleanup } = await launch();
  try {
    const adapter = adapterFor(session, SLACK_LOCAL_SYNTHETIC_PROFILE);
    const report = await send(adapter);
    assert.equal(report.status, "executed", JSON.stringify(report.refusal));
    assert.match(report.destination.candidate?.url ?? "", /\/client\/T0SYNTH\/D0SELF$/);
    const composer = /** @type {{inlineReplacements: number}|undefined} */ (
      report.steps.find((s) => /** @type {{step: string, phase: string}} */ (s).step === "composer" && /** @type {{phase: string}} */ (s).phase === "act")
    );
    assert.equal(composer?.inlineReplacements, 3);
    const posted = /** @type {{verified: boolean}|undefined} */ (report.steps.find((s) => /** @type {{step: string}} */ (s).step === "posted"));
    assert.equal(posted?.verified, true);
    assert.deepEqual(await renderedMessages(session), [
      [
        "QA² 新規ユーザー｜9/24（UTC）",
        "[:bust_in_silhouette:] 1,234人（前日より +56人）",
        "[:scales:] 直近7日平均 1,035.4人 より 198.6人多め（+19.2%）",
        "[:date:] 直近7日（9/18→9/24）：1,300 → 1,220 → 1,185 → 1,160 → 1,205 → 1,178 → 1,234人",
      ].join("\n"),
    ]);
    const again = await send(adapterFor(session, SLACK_LOCAL_SYNTHETIC_PROFILE));
    assert.equal(again.status, "refused");
    assert.equal(again.refusal?.code, "duplicate_post");
    assert.equal((await renderedMessages(session)).length, 1);
  } finally {
    await cleanup();
  }
});
