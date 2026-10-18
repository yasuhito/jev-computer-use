import test from "node:test";
import assert from "node:assert/strict";
import { parseDailyArgs, runDailyJob } from "../src/schedule/daily.mjs";

/** @typedef {NonNullable<Parameters<typeof runDailyJob>[0]>} DailyIo */
/** @typedef {NonNullable<import("../src/schedule/state.mjs").PostedRecord>} PostedRecord */
/** @typedef {import("../src/schedule/daily.mjs").ReportResult} ReportResult */
/** @typedef {import("../src/schedule/state.mjs").DailyRecord} DailyRecord */
/** @typedef {Parameters<NonNullable<DailyIo["runReport"]>>[0]} ReportIo */
/** @typedef {Partial<ReportResult> & {throw?: Error, markAttempt?: boolean}} ScriptedResult */
/** @typedef {Partial<DailyIo> & {results?: ScriptedResult[]}} BaseOverrides */

/** 10:00 JST is 01:00 UTC; the last complete UTC day is 2026-09-20. */
const NOW_MS = Date.parse("2026-09-21T01:00:00Z");
const DATE = "2026-09-20";

/**
 * A report runner that consumes scripted results in order; a scripted result
 * with `markAttempt` crosses the send boundary before returning or throwing.
 *
 * @param {ScriptedResult[]} results
 * @returns {NonNullable<DailyIo["runReport"]> & {calls: ReportIo[]}}
 */
function fakeRunReport(results) {
  /** @type {ReportIo[]} */
  const calls = [];
  /**
   * @param {ReportIo} io
   * @returns {Promise<ReportResult>}
   */
  const fn = async (io) => {
    calls.push(io);
    const next = results.shift();
    if (next === undefined) throw new Error("unexpected extra report attempt");
    if (next.markAttempt) await io.beforeSend?.();
    if (next.throw) throw next.throw;
    return /** @type {ReportResult} */ (next);
  };
  return Object.assign(fn, { calls });
}

/** @returns {import("../src/schedule/state.mjs").RecordStore & {records: Map<string, DailyRecord>}} */
function memoryStore() {
  /** @type {Map<string, DailyRecord>} */
  const records = new Map();
  return {
    records,
    /**
     * @param {string} date
     */
    read: async (date) => records.get(date) ?? null,
    /**
     * @param {DailyRecord} record
     */
    write: async (record) => {
      records.set(record.date, record);
    },
  };
}

/** @returns {{lock: NonNullable<DailyIo["lock"]>, calls: object[], releases: number[]}} */
function fakeLock() {
  /** @type {object[]} */
  const calls = [];
  /** @type {number[]} */
  const releases = [];
  let holding = true;
  return {
    /**
     * @param {{dir: string}} input
     */
    lock: async (input) => {
      calls.push({ ...input });
      return holding
        ? { ok: /** @type {const} */ (true), release: async () => { holding = false; releases.push(1); } }
        : { ok: /** @type {const} */ (false), holder: null };
    },
    calls,
    releases,
  };
}

/**
 * @param {BaseOverrides} [overrides]
 * @returns {{io: DailyIo, clock: {t: number}, store: ReturnType<typeof memoryStore>, lock: ReturnType<typeof fakeLock>, runReport: ReturnType<typeof fakeRunReport>}}
 */
function baseIo(overrides = {}) {
  const clock = { t: NOW_MS };
  /** @type {NonNullable<DailyIo["sleep"]>} */
  const sleep = async (ms) => {
    clock.t += ms;
  };
  const store = memoryStore();
  const lock = fakeLock();
  const runReport = fakeRunReport(overrides.results ?? [verifiedSend()]);
  /** @type {DailyIo} */
  const io = {
    argv: ["--state-dir", "/state"],
    stderr: { write: () => {} },
    env: {},
    now: () => clock.t,
    sleep,
    store,
    lock: lock.lock,
    runReport,
    ...overrides,
  };
  return { io, clock, store, lock, runReport };
}

/** @returns {ScriptedResult} */
function verifiedSend() {
  return {
    markAttempt: true,
    code: 0,
    payload: {
      status: "executed",
      send: {
        status: "executed",
        steps: [{ step: "posted", verified: true, verification: "verified", emojiIdentity: "proven" }],
      },
    },
  };
}

const attemptedRecord = /** @type {import("../src/schedule/state.mjs").AttemptRecord} */ ({
  date: DATE,
  status: "attempted",
  attemptedAt: new Date(NOW_MS).toISOString(),
  attempts: 1,
});

const existingRecord = /** @type {PostedRecord} */ ({
  date: DATE,
  status: "posted",
  postedAt: "2026-09-21T01:00:00Z",
  attempts: 1,
  recordedAt: "2026-09-21T01:00:00Z",
});

test("parseDailyArgs fixes unattended sends to qa2 regardless of environment", () => {
  const o = parseDailyArgs(["--state-dir", "/s"], { env: { JEV_CU_REPORT_DESTINATION: "qa3", JEV_CU_REPORT_ALLOW_DESTINATION: "qa3" } });
  assert.equal(o.mode, "send");
  assert.equal(o.destination, "qa2");
  assert.deepEqual(o.allowDestinations, ["qa2"]);
  assert.equal(parseDailyArgs(["--state-dir", "/s", "--dry-run"]).mode, "dry-run");
});

test("parseDailyArgs validates every flag and rejects destination overrides", () => {
  assert.throws(() => parseDailyArgs(["--state-dir", ""]), /state-dir/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--max-attempts", "1"]), /unknown option/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--retry-base-sec", "0"]), /unknown option/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--min-confidence", "1.5"]), /\[0, 1\]/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--max-candidates", "300"]), /1\.\.255/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--date", "2026-09-20"]), /unknown option/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--destination", "qa2"]), /unknown option/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--allow-destination", "qa2"]), /unknown option/);
  assert.throws(() => parseDailyArgs(["--state-dir"]), /requires a value/);
  // dry-run needs no destination.
  assert.equal(parseDailyArgs(["--state-dir", "/s", "--dry-run"]).destination, null);
});

test("the target date is the last complete UTC day, independent of the wall clock hour", async () => {
  /** @type {Array<[number, string]>} */
  const cases = [
    [Date.parse("2026-09-21T01:00:00Z"), "2026-09-20"], // 10:00 JST
    [Date.parse("2026-09-21T00:30:00Z"), "2026-09-20"], // 09:30 JST, catch-up after a reboot
    [Date.parse("2026-09-21T14:59:00Z"), "2026-09-20"],
    [Date.parse("2026-09-21T15:00:00Z"), "2026-09-20"], // still Sep 21 in UTC: last complete day is the 20th
    [Date.parse("2026-09-22T00:01:00Z"), "2026-09-21"], // UTC day rolled over to the 22nd
  ];
  for (const [nowMs, expected] of cases) {
    const { io } = baseIo({ now: () => nowMs });
    const { payload } = await runDailyJob(io);
    assert.equal(payload?.targetDate, expected, String(nowMs));
  }
});

test("a verified send writes the record and reports posted", async () => {
  const { io, store, runReport } = baseIo();
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 0);
  assert.equal(payload?.status, "posted");
  assert.equal(payload?.record?.attempts, 1);
  assert.equal(payload?.record?.date, DATE);
  assert.equal(store.records.get(DATE)?.status, "posted");
  assert.deepEqual(runReport.calls[0]?.argv?.slice(0, 6), ["--mode", "send", "--destination", "qa2", "--allow-destination", "qa2"]);
  assert.equal(runReport.calls.length, 1);
});

test("a recorded date is skipped without touching the report or the browser", async () => {
  const { io, store, runReport } = baseIo();
  store.records.set(DATE, existingRecord);
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 0);
  assert.equal(payload?.status, "already-posted");
  assert.equal(payload?.record?.attempts, 1);
  assert.equal(runReport.calls.length, 0);
});

test("a duplicate_post refusal is terminal and never recorded as success", async () => {
  // The marker may sit in an unposted draft as well as in a real post, so it
  // is not proof that a send happened: the run fails with no record.
  const { io, store, runReport } = baseIo({
    results: [{ code: 0, payload: { status: "refused", send: { refusal: { code: "duplicate_post" } } } }],
  });
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 1);
  assert.equal(payload?.status, "failed");
  assert.equal(payload?.record, null);
  assert.equal(payload?.attempts[0]?.refusalCode, "duplicate_post");
  assert.equal(runReport.calls.length, 1);
  assert.equal(store.records.size, 0);
});

test("the attempted marker is written at the callback, before a verified result", async () => {
  const { io, store } = baseIo();
  io.runReport = async (input) => {
    assert.equal(store.records.size, 0);
    assert.equal(typeof input.beforeSend, "function");
    await input.beforeSend?.();
    assert.deepEqual(store.records.get(DATE), attemptedRecord);
    return /** @type {ReportResult} */ (verifiedSend());
  };
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 0);
  assert.equal(payload?.status, "posted");
  assert.equal(store.records.get(DATE)?.status, "posted");
});

test("pre-send failures leave no record and a later run may send once", async () => {
  for (const first of [
    { code: 1, payload: { status: "error", error: { code: "transport" } } },
    { code: 0, payload: { status: "refused", send: { refusal: { code: "destination_mismatch" } } } },
    { throw: new Error("boom") },
  ]) {
    const { io, store, runReport } = baseIo({ results: [first, verifiedSend()] });
    const failed = await runDailyJob(io);
    assert.equal(failed.code, 1);
    assert.equal(failed.payload?.status, "failed");
    assert.equal(failed.payload?.record, null);
    assert.equal(failed.payload?.attempts.length, 1);
    assert.equal(runReport.calls.length, 1);
    assert.equal(store.records.size, 0);
    const posted = await runDailyJob({ ...io, lock: fakeLock().lock });
    assert.equal(posted.code, 0);
    assert.equal(posted.payload?.status, "posted");
    assert.equal(runReport.calls.length, 2);
    assert.equal(posted.payload?.record?.attempts, 1);
  }
});

test("post-click nonverified outcomes are uncertain and never resent", async () => {
  /** @type {ScriptedResult[]} */
  const outcomes = [
    { code: 0, payload: { status: "unverified" } },
    { code: 1, payload: { status: "error", error: { code: "transport" } } },
    { code: 0, payload: { status: "refused", send: { refusal: { code: "duplicate_post" } } } },
    { throw: new Error("post-click failure") },
    { code: 0, payload: { status: "executed" } },
    { ...verifiedSend(), code: 1 },
  ];
  // Every required verified-send field must be present and exact.
  const posted = { step: "posted", verified: true, verification: "verified", emojiIdentity: "proven" };
  for (const step of [
    { ...posted, step: "send" },
    { ...posted, verified: false },
    { ...posted, verification: "not_found" },
    { ...posted, emojiIdentity: "unproven" },
  ]) {
    outcomes.push({ code: 0, payload: { status: "executed", send: { status: "executed", steps: [step] } } });
  }
  outcomes.push(
    { code: 0, payload: { status: "unverified", send: { status: "executed", steps: [posted] } } },
    { code: 0, payload: { status: "executed", send: { status: "unverified", steps: [posted] } } },
    { code: 0, payload: { status: "executed", send: { status: "executed", steps: [] } } },
  );
  for (const outcome of outcomes) {
    const { io, store, runReport } = baseIo({ results: [{ ...outcome, markAttempt: true }] });
    const uncertain = await runDailyJob(io);
    assert.equal(uncertain.code, 1);
    assert.equal(uncertain.payload?.status, "uncertain");
    assert.deepEqual(uncertain.payload?.record, attemptedRecord);
    assert.deepEqual(store.records.get(DATE), attemptedRecord);
    assert.equal(uncertain.payload?.attempts.length, 1);
    const skipped = await runDailyJob({ ...io, lock: fakeLock().lock });
    assert.equal(skipped.code, 1);
    assert.equal(skipped.payload?.status, "already-attempted");
    assert.deepEqual(skipped.payload?.record, attemptedRecord);
    assert.deepEqual(skipped.payload?.attempts, []);
    assert.equal(runReport.calls.length, 1);
  }
});

test("even a verified result without the pre-send callback fails without a record", async () => {
  const { io, store } = baseIo({ results: [{ ...verifiedSend(), markAttempt: false }] });
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 1);
  assert.equal(payload?.status, "failed");
  assert.equal(payload?.record, null);
  assert.equal(store.records.size, 0);
});

test("the report clock stays on the run's original UTC date at the click boundary", async () => {
  const start = Date.parse("2026-09-21T23:59:59Z");
  const { io, store } = baseIo({ now: (() => {
    let calls = 0;
    return () => (calls++ === 0 ? start : start + 2000);
  })() });
  io.runReport = async (input) => {
    assert.equal(input.reportNow, start);
    await input.beforeSend?.();
    assert.deepEqual(store.records.get(DATE), { ...attemptedRecord, attemptedAt: new Date(start + 2000).toISOString() });
    return /** @type {ReportResult} */ (verifiedSend());
  };
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 0);
  assert.equal(payload?.targetDate, DATE);
});

test("a thrown pre-send runner is contained as one internal error", async () => {
  const { io, runReport } = baseIo({ results: [{ throw: new Error("boom") }] });
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 1);
  assert.equal(payload?.status, "failed");
  assert.equal(payload?.record, null);
  assert.equal(payload?.attempts.length, 1);
  assert.equal(payload?.attempts[0]?.errorCode, "internal");
  assert.equal(runReport.calls.length, 1);
});

test("dry-run runs the report without a record and without a destination requirement", async () => {
  const { io, store, runReport } = baseIo({
    argv: ["--state-dir", "/state", "--dry-run"],
    results: [{ code: 0, payload: { status: "dry-run" } }],
  });
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 0);
  assert.equal(payload?.status, "dry-run");
  assert.equal(payload?.record, null);
  assert.deepEqual(runReport.calls[0]?.argv?.slice(0, 2), ["--mode", "dry-run"]);
  assert.ok(!runReport.calls[0]?.argv?.includes("--destination"));
  assert.equal(store.records.size, 0);
});

test("dry-run on a recorded date still reports already-posted without running", async () => {
  const { io, runReport } = baseIo({
    argv: ["--state-dir", "/state", "--dry-run"],
    results: [],
  });
  const store = /** @type {ReturnType<typeof memoryStore>} */ (io.store);
  store.records.set(DATE, existingRecord);
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 0);
  assert.equal(payload?.status, "already-posted");
  assert.equal(runReport.calls.length, 0);
});

test("a held lock skips the run entirely", async () => {
  const { io, runReport } = baseIo({
    lock: async () => ({ ok: false, holder: { pid: 1234, startedAt: "x", bootId: null } }),
  });
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 0);
  assert.equal(payload?.status, "skipped-locked");
  assert.equal(payload?.record, null);
  assert.equal(runReport.calls.length, 0);
});

test("the lock is released on every path out", async () => {
  /** @type {Array<[string, BaseOverrides]>} */
  const paths = [
    ["success", {}],
    ["failure", { results: [{ code: 1, payload: { status: "error", error: { code: "transport" } } }] }],
    ["already", { results: [] }],
    ["uncertain", { results: [{ markAttempt: true, code: 0, payload: { status: "unverified" } }] }],
    ["attempted", { results: [] }],
    ["throw", { results: [{ throw: new Error("boom") }] }],
  ];
  for (const [label, over] of paths) {
    const { io, lock, store } = baseIo(over);
    if (label === "already") store.records.set(DATE, existingRecord);
    if (label === "attempted") store.records.set(DATE, attemptedRecord);
    await runDailyJob(io);
    assert.equal(lock.calls.length, 1, label);
    assert.equal(lock.releases.length, 1, label);
  }
});

test("the printed payload carries no report data, destination, message, or key", async () => {
  const leaky = {
    ...verifiedSend().payload,
    report: { reportDate: DATE, previousDay: { newUsers: 1234 }, idempotencyKey: "unity-new-users:24601:31001:2026-09-20" },
    message: "QA2 new users (Live) for 2026-09-20 (UTC)\nNew users on 2026-09-20: 1,234",
    destination: "qa2-metrics",
    delivery: { allowlist: ["qa2-metrics"] },
  };
  const { io } = baseIo({ results: [{ markAttempt: true, code: 0, payload: leaky }] });
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 0);
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /1234|qa2-metrics|idempotency|Live|new users/i);
  assert.ok(payload?.record);
});

test("a refused attempt keeps only closed-set stage and check labels, never refusal text", async () => {
  const refused = (/** @type {Record<string, unknown>} */ details, /** @type {unknown} */ completed = "draft") => ({
    code: 0,
    payload: {
      status: "refused",
      message: "QA² 新規ユーザー｜9/20（UTC）\n👤 1,234人",
      send: {
        status: "refused",
        completed,
        refusal: { code: "text_mismatch", message: "qa2 へのメッセージ reads back differently", details },
      },
    },
  });
  const results = [
    refused({ stage: "send_precheck", check: "ax_dom_disagree", readBack: "QA² 新規ユーザー｜9/20（UTC）\n\n 1,234人", reason: "the composer no longer holds the caller text" }),
    refused({ stage: "QA² 1,234人", check: "1,234人 qa2" }, "somewhere"),
    refused({ readBack: "1,234人" }, "navigate"),
  ];
  const expected = [
    ["draft", "send_precheck", "ax_dom_disagree"],
    [null, "other", "other"],
    ["navigate", null, null],
  ];
  for (const [index, result] of results.entries()) {
    const { io, store } = baseIo({ results: [result] });
    const { code, payload } = await runDailyJob(io);
    assert.equal(code, 1);
    assert.equal(payload?.status, "failed");
    assert.equal(payload?.record, null);
    assert.equal(store.records.size, 0);
    assert.deepEqual(payload?.attempts.map((a) => [a.completed, a.stage, a.check]), [expected[index]]);
    assert.doesNotMatch(JSON.stringify(payload), /1,234|新規ユーザー|qa2|reads back|holds/);
  }
});

test("usage errors exit 2 with a JSON error payload", async () => {
  /** @type {string[]} */
  const err = [];
  const { code, payload } = await runDailyJob({ argv: [], stderr: { write: (c) => err.push(c) }, env: {} });
  assert.equal(code, 2);
  assert.equal(payload?.status, "failed");
  assert.equal(payload?.error?.code, "usage");
  assert.match(String(payload?.error?.message), /--state-dir/);
  assert.match(err.join(""), /jev-cu-daily:/);
  const help = await runDailyJob({ argv: ["--help"], stderr: { write: (c) => err.push(c) }, env: {} });
  assert.equal(help.code, 0);
  assert.equal(help.payload, null);
  assert.match(err.join(""), /Usage: jev-cu-daily/);
});
