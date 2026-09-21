import test from "node:test";
import assert from "node:assert/strict";
import { runCli, parseArgs } from "../bin/jev-cu-browse.mjs";
import { RefusalError, TransportError } from "../src/errors.mjs";
import { createFakeCdp } from "./fake-cdp.mjs";
import { decideByLabel, fakeClock } from "./helpers.mjs";

const TEXT = "QA2 daily users: 1234";

/**
 * @param {string[]} argv
 * @param {Partial<Parameters<typeof runCli>[0]>} [overrides]
 */
function captureIo(argv, overrides = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const fake = createFakeCdp();
  const clock = fakeClock();
  return {
    io: {
      argv,
      stdout: { write: (/** @type {string} */ c) => out.push(c) },
      stderr: { write: (/** @type {string} */ c) => err.push(c) },
      env: {},
      connect: async () => fake.session,
      now: clock.now,
      sleep: clock.sleep,
      settleMs: 500,
      ...overrides,
    },
    fake,
    out,
    err,
    json: () => JSON.parse(out.join("")),
  };
}

test("parseArgs defaults to dry-run under the slack profile and validates modes and flags", () => {
  const o = parseArgs(["--destination", "qa2-metrics"]);
  assert.equal(o.mode, "dry-run");
  assert.equal(o.profile, "slack");
  assert.equal(o.minConfidence, 0.8);
  assert.equal(o.cdp, "http://127.0.0.1:9222");
  assert.equal(parseArgs(["--mode=observe"]).mode, "observe");
  assert.equal(parseArgs(["--destination", "--weird-name", "--mode", "navigate"]).destination, "--weird-name");
  assert.throws(() => parseArgs(["--mode", "execute", "--destination", "x"]), /--mode must be one of/);
  assert.throws(() => parseArgs(["--mode", "send", "--destination", "x"]), /requires --text/);
  assert.throws(() => parseArgs(["--mode", "draft", "--destination", "x"]), /requires --text/);
  assert.throws(() => parseArgs(["--mode", "navigate"]), /requires --destination/);
  assert.throws(() => parseArgs(["--destination", "x", "--text", "a", "--text-file", "b"]), /mutually exclusive/);
  assert.throws(() => parseArgs(["--profile", "nope", "--destination", "x"]), /unknown profile/);
  assert.throws(() => parseArgs(["--execute"]), /unknown option/);
  assert.throws(() => parseArgs(["--destination", "x", "--min-confidence", "2"]));
  assert.throws(() => parseArgs(["--destination", "x", "--max-candidates", "0"]));
});

test("runCli --help exits 0 and usage errors exit 2 with a JSON error", async () => {
  const help = captureIo(["--help"]);
  assert.equal(await runCli(help.io), 0);
  assert.ok(help.err.join("").includes("Usage:"));
  assert.equal(help.out.join(""), "");
  const bad = captureIo(["--mode", "send", "--destination", "x"]);
  assert.equal(await runCli(bad.io), 2);
  assert.equal(bad.json().status, "error");
  assert.equal(bad.json().error.code, "usage");
  assert.equal(bad.json().tool, "jev-cu-browse");
});

test("runCli observe mode needs no API key and closes the session", async () => {
  const c = captureIo(["--mode", "observe"]);
  assert.equal(await runCli(c.io), 0);
  const payload = c.json();
  assert.equal(payload.tool, "jev-cu-browse");
  assert.equal(payload.status, "observed");
  assert.equal(payload.candidates.length, 5);
  assert.equal(c.fake.state.disconnected, true);
});

test("runCli beyond observe mode exits 1 with missing_key before connecting", async () => {
  let connected = false;
  const c = captureIo(["--destination", "qa2-metrics"], {
    connect: async () => {
      connected = true;
      throw new Error("should not connect");
    },
  });
  assert.equal(await runCli(c.io), 1);
  assert.equal(c.json().error.code, "missing_key");
  assert.equal(connected, false);
  assert.ok(!c.out.join("").includes("TYPESAFE_API_KEY="));
});

test("runCli send mode runs the full flow with injected dependencies", async () => {
  const c = captureIo(["--destination", "qa2-metrics", "--mode", "send", "--text", TEXT, "--model", "jev-latest"], {
    decide: decideByLabel([/^qa2-metrics/, /^Message #qa2-metrics/, /^Send now/]),
  });
  assert.equal(await runCli(c.io), 0);
  const payload = c.json();
  assert.equal(payload.status, "executed");
  assert.equal(payload.completed, "send");
  assert.equal(payload.mode, "send");
  assert.deepEqual(c.fake.currentMessages(), [TEXT]);
  assert.equal(c.fake.state.disconnected, true);
});

test("runCli reads --text-file and rejects invalid text with exit 2", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(`${os.tmpdir()}/jev-cu-browse-test-`);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "message.txt");
  await fs.writeFile(file, `${TEXT}\nline two`);
  const ok = captureIo(["--destination", "qa2-metrics", "--mode", "draft", "--text-file", file], {
    decide: decideByLabel([/^qa2-metrics/, /^Message #qa2-metrics/]),
  });
  assert.equal(await runCli(ok.io), 0);
  assert.equal(ok.json().status, "executed");
  assert.equal(ok.fake.currentDraft(), `${TEXT}\nline two`);

  const bad = captureIo(["--destination", "qa2-metrics", "--mode", "draft", "--text", "bad\u0007"]);
  assert.equal(await runCli(bad.io), 2);
  assert.equal(bad.json().error.code, "invalid_text");
});

test("runCli maps refusals from target discovery to status refused (exit 0) and transport failures to exit 1", async () => {
  const refused = captureIo(["--mode", "observe"], {
    connect: async () => {
      throw new RefusalError("ambiguous_target", "2 pages match");
    },
  });
  assert.equal(await runCli(refused.io), 0);
  assert.equal(refused.json().status, "refused");
  assert.equal(refused.json().refusal.code, "ambiguous_target");

  const down = captureIo(["--mode", "observe"], {
    connect: async () => {
      throw new TransportError("cannot reach CDP endpoint", { phase: "discover" });
    },
  });
  assert.equal(await runCli(down.io), 1);
  assert.equal(down.json().error.code, "transport");
  assert.equal(down.json().phase, "discover");
});

test("runCli reports a refused workflow with exit 0 and never sends input", async () => {
  const c = captureIo(["--destination", "qa2-metrics", "--mode", "send", "--text", TEXT], {
    decide: decideByLabel([/^qa2-metrics/, /^Message #qa2-metrics/, /^Send now/]),
  });
  c.fake.state.drafts.set("/client/T0SYNTH/C0QA2METRICS", "stale draft");
  assert.equal(await runCli(c.io), 0);
  assert.equal(c.json().status, "refused");
  assert.equal(c.json().refusal.code, "text_mismatch");
  assert.equal(c.fake.methodCalls("Input.insertText").length, 0);
  assert.deepEqual(c.fake.currentMessages(), []);
});
