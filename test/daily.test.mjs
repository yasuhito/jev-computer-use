import test from "node:test";
import assert from "node:assert/strict";
import { parseDailyArgs, runDailyJob, DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_BASE_SEC, NON_RETRYABLE_CODES } from "../src/schedule/daily.mjs";

/** @typedef {NonNullable<Parameters<typeof runDailyJob>[0]>} DailyIo */
/** @typedef {NonNullable<import("../src/schedule/state.mjs").PostedRecord>} PostedRecord */
/** @typedef {import("../src/schedule/daily.mjs").ReportResult} ReportResult */
/** @typedef {Partial<ReportResult> & {throw?: Error}} ScriptedResult */
/** @typedef {Partial<DailyIo> & {results?: ScriptedResult[]}} BaseOverrides */

/** 10:00 JST is 01:00 UTC; the last complete UTC day is 2026-09-20. */
const NOW_MS = Date.parse("2026-09-21T01:00:00Z");
const DATE = "2026-09-20";

/**
 * A report runner that consumes scripted results in order; a scripted result
 * with `throw` makes the runner throw (an internal failure).
 *
 * @param {ScriptedResult[]} results
 * @returns {NonNullable<DailyIo["runReport"]> & {calls: DailyIo[]}}
 */
function fakeRunReport(results) {
  /** @type {DailyIo[]} */
  const calls = [];
  /**
   * @param {DailyIo} io
   * @returns {Promise<ReportResult>}
   */
  const fn = async (io) => {
    calls.push(io);
    const next = results.shift();
    if (next === undefined) throw new Error("unexpected extra report attempt");
    if (next.throw) throw next.throw;
    return /** @type {ReportResult} */ (next);
  };
  return Object.assign(fn, { calls });
}

/** @returns {import("../src/schedule/state.mjs").RecordStore & {records: Map<string, PostedRecord>}} */
function memoryStore() {
  /** @type {Map<string, PostedRecord>} */
  const records = new Map();
  return {
    records,
    /**
     * @param {string} date
     */
    read: async (date) => records.get(date) ?? null,
    /**
     * @param {PostedRecord} record
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
  const runReport = fakeRunReport(overrides.results ?? [{ code: 0, payload: { status: "executed" } }]);
  /** @type {DailyIo} */
  const io = {
    argv: ["--state-dir", "/state", "--destination", "qa2", "--allow-destination", "qa2"],
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

const existingRecord = /** @type {PostedRecord} */ ({
  date: DATE,
  status: "posted",
  postedAt: "2026-09-21T01:00:00Z",
  attempts: 1,
  recordedAt: "2026-09-21T01:00:00Z",
});

test("parseDailyArgs defaults to send mode with bounded attempts and accepts the env fallback", () => {
  const o = parseDailyArgs(["--state-dir", "/s", "--destination", "qa"]);
  assert.equal(o.mode, "send");
  assert.equal(o.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  assert.equal(o.retryBaseSec, DEFAULT_RETRY_BASE_SEC);
  assert.deepEqual(o.allowDestinations, ["qa"]);
  assert.equal(parseDailyArgs(["--state-dir", "/s", "--dry-run"]).mode, "dry-run");
  const env = parseDailyArgs(["--state-dir", "/s"], { env: { JEV_CU_REPORT_DESTINATION: "qa" } });
  assert.equal(env.destination, "qa");
  assert.deepEqual(env.allowDestinations, ["qa"]);
  const envAllow = parseDailyArgs(["--state-dir", "/s"], { env: { JEV_CU_REPORT_DESTINATION: "qa", JEV_CU_REPORT_ALLOW_DESTINATION: "qa, qa2 " } });
  assert.deepEqual(envAllow.allowDestinations, ["qa", "qa2"]);
  // An explicit allowlist wins over the env list; the flag wins over the env destination.
  const mixed = parseDailyArgs(["--state-dir", "/s", "--destination", "qa", "--allow-destination", "qa"], {
    env: { JEV_CU_REPORT_DESTINATION: "other", JEV_CU_REPORT_ALLOW_DESTINATION: "other" },
  });
  assert.equal(mixed.destination, "qa");
  assert.deepEqual(mixed.allowDestinations, ["qa"]);
});

test("parseDailyArgs validates every flag and requires a destination in send mode", () => {
  assert.throws(() => parseDailyArgs([]), /--destination/);
  assert.throws(() => parseDailyArgs(["--state-dir", ""]), /state-dir/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--max-attempts", "0"]), /1\.\.10/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--max-attempts", "11"]), /1\.\.10/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--retry-base-sec", "3601"]), /0\.\.3600/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--retry-base-sec", "-1"]), /0\.\.3600/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--min-confidence", "1.5"]), /\[0, 1\]/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--max-candidates", "300"]), /1\.\.255/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--date", "2026-09-20"]), /unknown option/);
  assert.throws(() => parseDailyArgs(["--state-dir", "/s", "--destination", "qa", "--post"]), /unknown option/);
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

test("a failed attempt is retried with exponential backoff until a verified send", async () => {
  const { io, clock } = baseIo({
    results: [
      { code: 1, payload: { status: "error", error: { code: "transport" } } },
      { code: 0, payload: { status: "unverified" } },
      { code: 0, payload: { status: "executed" } },
    ],
    argv: ["--state-dir", "/state", "--destination", "qa2", "--allow-destination", "qa2", "--retry-base-sec", "10"],
  });
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 0);
  assert.equal(payload?.status, "posted");
  assert.equal(payload?.record?.attempts, 3);
  assert.deepEqual(
    payload?.attempts.map((a) => [a.attempt, a.status, a.errorCode, a.refusalCode]),
    [
      [1, "error", "transport", null],
      [2, "unverified", null, null],
      [3, "executed", null, null],
    ],
  );
  // Backoff 10s then 20s advanced the fake clock.
  assert.equal(clock.t, NOW_MS + 30_000);
});

test("retries stop at the bound and the run fails with no record", async () => {
  const { io, runReport } = baseIo({
    results: [
      { code: 0, payload: { status: "refused", send: { refusal: { code: "destination_mismatch" } } } },
      { code: 0, payload: { status: "refused", send: { refusal: { code: "destination_mismatch" } } } },
    ],
    argv: ["--state-dir", "/state", "--destination", "qa2", "--allow-destination", "qa2", "--max-attempts", "2"],
  });
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 1);
  assert.equal(payload?.status, "failed");
  assert.equal(payload?.record, null);
  assert.equal(runReport.calls.length, 2);
});

test("configuration-class failures are not retried", async () => {
  assert.ok(NON_RETRYABLE_CODES.size >= 6);
  for (const result of [
    { code: 1, payload: { status: "error", error: { code: "missing_snowflake_config" } } },
    { code: 1, payload: { status: "error", error: { code: "missing_key" } } },
    { code: 2, payload: { status: "error", error: { code: "destination_not_allowed" } } },
  ]) {
    const { io, runReport } = baseIo({ results: [result] });
    const { code, payload } = await runDailyJob(io);
    assert.equal(code, 1);
    assert.equal(payload?.status, "failed");
    assert.equal(runReport.calls.length, 1, JSON.stringify(result));
  }
});

test("a thrown report runner is contained as an error attempt", async () => {
  const { io, runReport } = baseIo({
    results: [{ throw: new Error("boom") }, { throw: new Error("boom") }],
    argv: ["--state-dir", "/state", "--destination", "qa2", "--allow-destination", "qa2", "--max-attempts", "2"],
  });
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 1);
  assert.equal(payload?.attempts.length, 2);
  assert.equal(payload?.attempts[0]?.errorCode, "internal");
  assert.equal(runReport.calls.length, 2);
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
  ];
  for (const [label, over] of paths) {
    const { io, lock, store } = baseIo(over);
    if (label === "already") store.records.set(DATE, existingRecord);
    await runDailyJob(io);
    assert.equal(lock.calls.length, 1, label);
    assert.equal(lock.releases.length, 1, label);
  }
});

test("the printed payload carries no report data, destination, message, or key", async () => {
  const leaky = {
    status: "executed",
    report: { reportDate: DATE, previousDay: { newUsers: 1234 }, idempotencyKey: "unity-new-users:24601:31001:2026-09-20" },
    message: "QA2 new users (Live) for 2026-09-20 (UTC)\nNew users on 2026-09-20: 1,234",
    destination: "qa2-metrics",
    delivery: { allowlist: ["qa2-metrics"] },
  };
  const { io } = baseIo({ results: [{ code: 0, payload: leaky }] });
  const { code, payload } = await runDailyJob(io);
  assert.equal(code, 0);
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /1234|qa2-metrics|idempotency|Live|new users/i);
  assert.ok(payload?.record);
});

test("usage errors exit 2 with a JSON error payload", async () => {
  /** @type {string[]} */
  const err = [];
  const { code, payload } = await runDailyJob({ argv: ["--state-dir", "/state"], stderr: { write: (c) => err.push(c) }, env: {} });
  assert.equal(code, 2);
  assert.equal(payload?.status, "failed");
  assert.equal(payload?.error?.code, "usage");
  assert.match(String(payload?.error?.message), /--destination/);
  assert.match(err.join(""), /jev-cu-daily:/);
  const help = await runDailyJob({ argv: ["--help"], stderr: { write: (c) => err.push(c) }, env: {} });
  assert.equal(help.code, 0);
  assert.equal(help.payload, null);
  assert.match(err.join(""), /Usage: jev-cu-daily/);
});
