import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runDailyJob } from "../src/schedule/daily.mjs";
import { runReportJob } from "../bin/jev-cu-report.mjs";
import { createFakeCdp } from "./fake-cdp.mjs";
import { loadSyntheticPage } from "./fixtures/synthetic-slack.mjs";
import { decideByLabel, fakeClock } from "./helpers.mjs";
import { loadFixtureExecutor } from "../src/snowflake/executor.mjs";

const execFileAsync = promisify(execFile);
const FIXTURE = fileURLToPath(new URL("./fixtures/unity-data-access.json", import.meta.url));
const KEY = "unity-new-users:24601:31001:2026-09-20";
const SEND_FLOW = [/^qa2(?:$|\s|,|\()/, /^Message #qa2(?:$|\s)/, /^Send now/];
/** 09:00 UTC on the 21st; the target date (last complete UTC day) is 2026-09-20. */
const NOW_MS = Date.parse("2026-09-21T09:00:00Z");
const DATE = "2026-09-20";
const cExecutor = await loadFixtureExecutor(FIXTURE);
const cClock = fakeClock();
cClock.advance(NOW_MS - cClock.now());

/**
 * @param {Parameters<typeof createFakeCdp>[0]} [options]
 */
function createDailyFakeCdp(options = {}) {
  const page = loadSyntheticPage();
  const destination = page.conversations.find((conversation) => conversation.id === "C0QA2METRICS");
  assert.ok(destination);
  destination.id = "C0QA2";
  destination.name = "qa2";
  return createFakeCdp({ page, ...options });
}

/** @typedef {NonNullable<Parameters<typeof runDailyJob>[0]>} DailyIo */
/** @typedef {NonNullable<DailyIo["decide"]>} DecideFn */
/** @typedef {NonNullable<DailyIo["connect"]>} ConnectFn */
/** @typedef {NonNullable<DailyIo["executor"]>} Executor */

/** @param {number} attempts */
const sendFlow = (attempts) => Array.from({ length: attempts }, () => SEND_FLOW).flat();

/**
 * @typedef {object} CaptureOptions
 * @property {string[]} [extraArgv] appended to the default argv
 * @property {NodeJS.ProcessEnv} [env]
 * @property {ConnectFn} [connect]
 * @property {DecideFn} [decide]
 */

/**
 * @param {CaptureOptions} [overrides]
 */
async function captureIo(overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "jev-cu-daily-"));
  /** @type {string[]} */
  const err = [];
  /** @type {ReturnType<typeof createFakeCdp>[]} */
  const sessions = [];
  const clock = fakeClock();
  clock.advance(NOW_MS - clock.now());
  const executor = await loadFixtureExecutor(FIXTURE);
  const argv = ["--state-dir", stateDir];
  /** @type {DailyIo} */
  const io = {
    argv: [...argv, ...(overrides.extraArgv ?? [])],
    stderr: { write: (/** @type {string} */ c) => err.push(c) },
    env: overrides.env ?? {},
    executor,
    decide: overrides.decide ?? decideByLabel(sendFlow(3)),
    connect:
      overrides.connect ??
      (async () => {
        const fake = createDailyFakeCdp();
        sessions.push(fake);
        return fake.session;
      }),
    now: clock.now,
    sleep: clock.sleep,
    settleMs: 500,
  };
  return {
    io,
    err,
    executor,
    sessions,
    stateDir,
    recordPath: join(stateDir, "records", `${DATE}.json`),
    async cleanup() {
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

test("the daily CLI posts once, records the date, and prints a scrubbed payload", async () => {
  const c = await captureIo();
  try {
    const { code, payload } = await runDailyJob(c.io);
    assert.equal(code, 0);
    assert.equal(payload?.status, "posted");
    assert.equal(payload?.targetDate, DATE);
    assert.equal(payload?.record?.attempts, 1);
    // The record exists on disk, written by the file store.
    const onDisk = JSON.parse(await readFile(c.recordPath, "utf8"));
    assert.equal(onDisk.status, "posted");
    // The message went through the bounded workflow exactly once.
    const fake = c.sessions[0];
    assert.ok(fake);
    const messages = fake.currentMessages();
    assert.equal(messages.length, 1);
    const posted = messages[0];
    assert.ok(posted);
    assert.match(posted, /^QA2 new users \(Live\) for 2026-09-20 \(UTC\)/);
    assert.ok(posted.includes(KEY));
    assert.equal(fake.state.disconnected, true);
    // The daily payload itself carries no report data, message, destination, or key.
    const text = JSON.stringify(payload);
    assert.doesNotMatch(text, /1,234|idempotency|new users \(Live\)|#qa2/i);
    assert.equal(c.err.join(""), "");
  } finally {
    await c.cleanup();
  }
});

test("a second run for the same date posts nothing and queries nothing", async () => {
  const c = await captureIo();
  try {
    assert.equal((await runDailyJob(c.io)).code, 0);
    const queriesAfterFirst = c.executor.calls.length;
    const messagesAfterFirst = c.sessions[0]?.currentMessages().length;
    const second = await runDailyJob({ ...c.io, decide: decideByLabel(sendFlow(1)) });
    assert.equal(second.code, 0);
    assert.equal(second.payload?.status, "already-posted");
    assert.equal(c.executor.calls.length, queriesAfterFirst);
    assert.equal(c.sessions.length, 1); // never connected again
    assert.equal(c.sessions[0]?.currentMessages().length, messagesAfterFirst);
  } finally {
    await c.cleanup();
  }
});

test("a duplicate-marker refusal ends the run without drafting and without a record", async () => {
  // The marker may sit in an unposted draft as well as in a real post, so it
  // is never recorded as success; a human checks the channel.
  const c = await captureIo({
    connect: async () => {
      const fake = createDailyFakeCdp();
      fake.state.messages.set("/client/T0SYNTH/C0QA2", [`QA2 new users (Live) for 2026-09-20 (UTC)\n... key: ${KEY}`]);
      c.sessions.push(fake);
      return fake.session;
    },
  });
  try {
    const { code, payload } = await runDailyJob(c.io);
    assert.equal(code, 1);
    assert.equal(payload?.status, "failed");
    assert.equal(payload?.record, null);
    assert.equal(payload?.attempts[0]?.refusalCode, "duplicate_post");
    const fake = c.sessions[0];
    assert.ok(fake);
    assert.equal(fake.methodCalls("Input.insertText").length, 0);
    assert.equal(fake.currentMessages().length, 1);
    await assert.rejects(readFile(c.recordPath), { code: "ENOENT" });
  } finally {
    await c.cleanup();
  }
});

test("a split-paragraph post verifies and records the date (the 2026-09-21 fix)", async () => {
  // The 2026-09-21 incident: the send landed but the real client renders the
  // six paragraphs as separate accessibility nodes, so the post verification
  // failed and no record was written. With the paragraph-sequence
  // verification the same rendering verifies, so the unattended run records
  // the date like any other verified send.
  const c = await captureIo({
    connect: async () => {
      const fake = createDailyFakeCdp({ splitMessages: true });
      c.sessions.push(fake);
      return fake.session;
    },
  });
  try {
    const { code, payload } = await runDailyJob(c.io);
    assert.equal(code, 0);
    assert.equal(payload?.status, "posted");
    assert.equal(payload?.record?.attempts, 1);
    const onDisk = JSON.parse(await readFile(c.recordPath, "utf8"));
    assert.equal(onDisk.status, "posted");
    const fake = c.sessions[0];
    assert.ok(fake);
    assert.equal(fake.currentMessages().length, 1);
    assert.equal(fake.state.disconnected, true);
  } finally {
    await c.cleanup();
  }
});

test("an unverified send is retried, never recorded, and fails the run at the bound", async () => {
  const c = await captureIo({
    extraArgv: ["--max-attempts", "2", "--retry-base-sec", "1"],
    connect: async () => {
      // Every attempt starts from a fresh page whose send click is swallowed;
      // the workflow clicks send but can never verify the post.
      const fake = createDailyFakeCdp();
      fake.state.posting = false;
      c.sessions.push(fake);
      return fake.session;
    },
  });
  try {
    const { code, payload } = await runDailyJob(c.io);
    assert.equal(code, 1);
    assert.equal(payload?.status, "failed");
    assert.equal(payload?.record, null);
    assert.deepEqual(payload?.attempts.map((a) => a.status), ["unverified", "unverified"]);
    assert.equal(c.sessions.length, 2);
    // No record on disk: the date may be posted later, after a human checks the channel.
    await assert.rejects(readFile(c.recordPath), { code: "ENOENT" });
    assert.equal(c.sessions[0]?.currentMessages().length, 0);
  } finally {
    await c.cleanup();
  }
});

test("a retry after an unverified send hits the marker and still never records or double posts", async () => {
  // The recovery path: a send's verification failed, no record was written,
  // and by the retry the message is visible in the channel. The marker guard
  // must refuse the second send; the run fails with no record (the marker
  // alone is not proof of a send) and nothing is posted twice.
  const c = await captureIo({
    decide: decideByLabel([...SEND_FLOW, /^qa2(?:$|\s|,|\()/]), // attempt 2 refuses at the duplicate check, right after the destination decision
    connect: async () => {
      const fake = createDailyFakeCdp();
      if (c.sessions.length > 0) {
        fake.state.messages.set("/client/T0SYNTH/C0QA2", [`QA2 new users (Live) for 2026-09-20 (UTC)\nNew users on 2026-09-20: 1,234\n... key: ${KEY}`]);
      } else {
        fake.state.posting = false; // attempt 1: the send click is swallowed, the workflow cannot verify
      }
      c.sessions.push(fake);
      return fake.session;
    },
  });
  try {
    const { code, payload } = await runDailyJob(c.io);
    assert.equal(code, 1);
    assert.equal(payload?.status, "failed");
    assert.equal(payload?.record, null);
    assert.deepEqual(
      payload?.attempts.map((a) => [a.status, a.refusalCode]),
      [
        ["unverified", null],
        ["refused", "duplicate_post"],
      ],
    );
    assert.equal(c.sessions.length, 2);
    assert.equal(c.sessions[1]?.methodCalls("Input.insertText").length, 0);
    await assert.rejects(readFile(c.recordPath), { code: "ENOENT" });
  } finally {
    await c.cleanup();
  }
});

test("a composer left holding an unposted draft is refused, never appended to", async () => {
  // Unattended fail-safe: after a swallowed send the composer still holds the
  // exact draft (Slack keeps per-channel drafts), so a later run refuses at
  // insertText until a human clears it. The record stays unwritten. This
  // draft carries yesterday's key, so the duplicate-marker check passes and
  // the refusal comes from the composer guard itself.
  const sink = { write: () => {} };
  const probe = await runReportJob({ argv: [], executor: cExecutor, env: {}, now: cClock.now, sleep: cClock.sleep, stdout: sink, stderr: sink });
  const draft = /** @type {{message: unknown}} */ (probe.payload).message;
  assert.equal(typeof draft, "string");
  const c = await captureIo({
    extraArgv: ["--max-attempts", "2", "--retry-base-sec", "1"],
    decide: decideByLabel(sendFlow(2)),
    connect: async () => {
      const fake = createDailyFakeCdp();
      if (c.sessions.length > 0) {
        // The retry reconnects to the same channel, whose composer still
        // holds the unposted draft from the first attempt.
        fake.state.drafts.set("/client/T0SYNTH/C0QA2", /** @type {string} */ (draft).replaceAll("2026-09-20", "2026-09-19"));
      } else {
        fake.state.posting = false; // the send click is swallowed; the draft stays
      }
      c.sessions.push(fake);
      return fake.session;
    },
  });
  try {
    const { code, payload } = await runDailyJob(c.io);
    assert.equal(code, 1);
    assert.equal(payload?.status, "failed");
    assert.equal(payload?.attempts.length, 2);
    assert.equal(payload?.attempts[1]?.refusalCode, "text_mismatch");
    const fake = c.sessions[1];
    assert.ok(fake);
    assert.equal(fake.currentDraft(), /** @type {string} */ (draft).replaceAll("2026-09-20", "2026-09-19"));
    assert.equal(fake.currentMessages().length, 0);
  } finally {
    await c.cleanup();
  }
});

test("the operator environment cannot redirect the fixed qa2 destination", async () => {
  const c = await captureIo({ env: { JEV_CU_REPORT_DESTINATION: "qa2-metrics", JEV_CU_REPORT_ALLOW_DESTINATION: "qa2-metrics" } });
  try {
    const { code, payload } = await runDailyJob(c.io);
    assert.equal(code, 0);
    assert.equal(payload?.status, "posted");
    assert.equal(c.sessions[0]?.currentMessages().length, 1);
  } finally {
    await c.cleanup();
  }
});

test("a dry run executes the read path and writes no record", async () => {
  const c = await captureIo({ extraArgv: ["--dry-run"] });
  try {
    const { code, payload } = await runDailyJob(c.io);
    assert.equal(code, 0);
    assert.equal(payload?.status, "dry-run");
    assert.equal(c.sessions.length, 0); // dry-run touches no browser
    await assert.rejects(readFile(c.recordPath), { code: "ENOENT" });
  } finally {
    await c.cleanup();
  }
});

test("two concurrent runs with the real lock: exactly one posts", async () => {
  const c = await captureIo();
  try {
    // One run posts; the other either skips on the lock or sees the winner's
    // record. The loser never connects and never queries.
    const [first, second] = await Promise.all([runDailyJob(c.io), runDailyJob({ ...c.io, decide: decideByLabel(sendFlow(1)) })]);
    const statuses = [first.payload?.status, second.payload?.status];
    assert.equal(statuses.filter((s) => s === "posted").length, 1);
    assert.ok(statuses.every((s) => s === "posted" || s === "skipped-locked" || s === "already-posted"), statuses.join(","));
    assert.equal(c.sessions.length, 1);
    assert.equal(c.executor.calls.length, 2); // the two read-only SELECTs of the winner only
    const onDisk = JSON.parse(await readFile(c.recordPath, "utf8"));
    assert.equal(onDisk.status, "posted");
  } finally {
    await c.cleanup();
  }
});

test("the committed bin prints its usage and JSON usage errors", async () => {
  const bin = fileURLToPath(new URL("../bin/jev-cu-daily.mjs", import.meta.url));
  const help = await execFileAsync(process.execPath, [bin, "--help"], { env: {} });
  assert.equal(help.stdout, "");
  assert.match(help.stderr, /Usage: jev-cu-daily/);
  await assert.rejects(
    execFileAsync(process.execPath, [bin], { env: {} }),
    (/** @type {Error & {code: number, stdout: string, stderr: string}} */ err) => {
      assert.equal(err.code, 2);
      const payload = JSON.parse(err.stdout);
      assert.equal(payload.tool, "jev-cu-daily");
      assert.equal(payload.error.code, "usage");
      return true;
    },
  );
});
