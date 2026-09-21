/**
 * The daily wrapper around `jev-cu-report --mode send` for unattended
 * scheduling (a systemd timer on the deployment host). It adds exactly the
 * three things unattended execution needs and the single-shot CLI cannot
 * provide:
 *
 * - Durable per-date idempotency: the target date is the report's own date
 *   rule (the last complete UTC day) computed from the same clock. A run
 *   posts, records, and only then reports success; a later run for a
 *   recorded date does nothing. A record is written only after the workflow
 *   verified the send - the one proof that Slack accepted this date's post.
 *   Every other outcome (runtime error, refusal, unverified, no_match,
 *   escalate) leaves no record, so a human or a later run can resume; the
 *   workflow's duplicate-marker guard keeps any such resume from posting
 *   twice for a date whose send did land but could not be verified.
 * - Single-run exclusion: an exclusive lock file in the state directory, so
 *   a timer catch-up and a manual run cannot race. Locks left by a previous
 *   boot or a dead process are broken; a live run is not.
 * - Bounded retry: a failed attempt (runtime error, refused, unverified,
 *   no_match, escalate) is retried at most `--max-attempts` times with
 *   exponential backoff. Two classes fail immediately because no backoff
 *   can fix them: configuration errors (missing credentials, usage, a
 *   destination outside the allowlist) and the `duplicate_post` refusal,
 *   where the destination already renders this date's idempotency key. The
 *   marker can sit in an unposted draft as well as in a real post, so a
 *   duplicate refusal is never recorded as success; it ends the run with no
 *   record and lets a human check the channel. Retries are safe because
 *   every attempt runs with the report's duplicate-marker guard: if an
 *   earlier attempt did post, the next attempt refuses instead of posting
 *   twice.
 *
 * Output scrubbing: the printed payload carries statuses and error codes
 * only - never report numbers, message text, the destination name, or any
 * key - so unattended logs stay free of report data and
 * deployment-specific values. The report's own stderr is captured and
 * dropped for the same reason. Debugging happens by running
 * `jev-cu-report` directly, by a person.
 */
import { addDays, utcDateOf } from "../report/dates.mjs";
import { DEFAULT_CDP_ENDPOINT } from "../cdp/transport.mjs";
import { DEFAULT_PROFILE_NAME } from "../profiles/index.mjs";
import { DEFAULT_MAX_CANDIDATES, HARD_MAX_CANDIDATES } from "../validate.mjs";
import { DEFAULT_BROWSE_MIN_CONFIDENCE } from "../workflow.mjs";
import { FileRecordStore, acquireRunLock } from "./state.mjs";
import { runReportJob } from "../../bin/jev-cu-report.mjs";

export const DAILY_TOOL = "jev-cu-daily";
export const DAILY_VERSION = "0.1.0";

/** @typedef {"posted"|"already-posted"|"skipped-locked"|"dry-run"|"failed"} DailyStatus */
/** @typedef {"send"|"dry-run"} DailyMode */

export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_ATTEMPTS_BOUND = 10;
export const DEFAULT_RETRY_BASE_SEC = 60;
export const MAX_RETRY_BASE_SEC = 3600;
export const DAILY_DESTINATION = "qa2";
/** Error codes no amount of retrying can fix; the run fails on the first one. */
export const NON_RETRYABLE_CODES = Object.freeze(
  new Set(["usage", "missing_key", "missing_snowflake_config", "destination_not_allowed", "invalid_text", "invalid_destination"]),
);

const VALUE_FLAGS = new Set([
  "--state-dir",
  "--max-attempts",
  "--retry-base-sec",
  "--profile",
  "--cdp",
  "--target",
  "--min-confidence",
  "--max-candidates",
  "--model",
]);

const USAGE = `Usage: jev-cu-daily [options]

Run the daily New Users report once for its target date (the last complete
UTC day): skip when that date is already recorded as posted, otherwise run
jev-cu-report --mode send with bounded retries and record success only after
the send was verified. Designed for a daily systemd timer; credentials and
the browser session come from the operator's environment.

Options:
  --state-dir DIR        durable state directory (records + run lock); required
  --max-attempts N       send attempts per run, 1..${MAX_ATTEMPTS_BOUND} (default ${DEFAULT_MAX_ATTEMPTS})
  --retry-base-sec N     backoff base seconds, 0..${MAX_RETRY_BASE_SEC}; attempt n waits base*2^(n-1)
                         (default ${DEFAULT_RETRY_BASE_SEC})
  --dry-run              run the report in dry-run mode and write no record
  --profile NAME         as in jev-cu-report (default ${DEFAULT_PROFILE_NAME})
  --cdp URL              DevTools HTTP endpoint (default ${DEFAULT_CDP_ENDPOINT})
  --target ID            page target id when more than one page matches
  --min-confidence N     Jev threshold in [0, 1] (default ${DEFAULT_BROWSE_MIN_CONFIDENCE})
  --max-candidates N     recognized-candidate bound in 1..${HARD_MAX_CANDIDATES} (default ${DEFAULT_MAX_CANDIDATES})
  --model NAME           TypeSafe model override
  --help                 show this help and exit

Destination: the exact Slack channel qa2. Environment: SNOWFLAKE_* and
TYPESAFE_API_KEY as in jev-cu-report. Exit codes: 0 posted, already-posted,
skipped-locked, or dry-run; 1 failed; 2 usage error.`;

/**
 * @typedef {object} DailyOptions
 * @property {string|null} stateDir
 * @property {string|null} destination
 * @property {string[]} allowDestinations
 * @property {DailyMode} mode
 * @property {number} maxAttempts
 * @property {number} retryBaseSec
 * @property {string|null} profile
 * @property {string|null} cdp
 * @property {string|null} target
 * @property {number|null} minConfidence
 * @property {number|null} maxCandidates
 * @property {string|null} model
 * @property {boolean} help
 */

/**
 * @param {string[]} argv
 * @param {{env?: NodeJS.ProcessEnv}} [_context] reserved injection context; destination configuration is intentionally ignored
 * @returns {DailyOptions}
 * @throws {Error} on unknown or malformed options (usage error)
 */
export function parseDailyArgs(argv, _context = {}) {
  /** @type {DailyOptions} */
  const options = {
    stateDir: null,
    destination: DAILY_DESTINATION,
    allowDestinations: [DAILY_DESTINATION],
    mode: "send",
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    retryBaseSec: DEFAULT_RETRY_BASE_SEC,
    profile: null,
    cdp: null,
    target: null,
    minConfidence: null,
    maxCandidates: null,
    model: null,
    help: false,
  };
  /**
   * @param {string} flag
   * @param {string} raw
   * @param {number} min
   * @param {number} max
   */
  const integer = (flag, raw, min, max) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be an integer in ${min}..${max}, got "${raw}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.mode = "dry-run";
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq > -1 ? arg.slice(0, eq) : arg;
    let inline = eq > -1 ? arg.slice(eq + 1) : undefined;
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown option "${arg}"`);
    if (inline === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      inline = next;
      i += 1;
    }
    switch (flag) {
      case "--state-dir":
        if (inline.length === 0) throw new Error("--state-dir must be a non-empty path");
        options.stateDir = inline;
        break;
      case "--max-attempts":
        options.maxAttempts = integer(flag, inline, 1, MAX_ATTEMPTS_BOUND);
        break;
      case "--retry-base-sec":
        options.retryBaseSec = integer(flag, inline, 0, MAX_RETRY_BASE_SEC);
        break;
      case "--profile":
        options.profile = inline;
        break;
      case "--cdp":
        options.cdp = inline;
        break;
      case "--target":
        options.target = inline;
        break;
      case "--model":
        options.model = inline;
        break;
      case "--min-confidence": {
        const n = Number(inline);
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`--min-confidence must be a number in [0, 1], got "${inline}"`);
        options.minConfidence = n;
        break;
      }
      case "--max-candidates":
        options.maxCandidates = integer(flag, inline, 1, HARD_MAX_CANDIDATES);
        break;
    }
  }
  if (options.mode === "dry-run") {
    options.destination = null;
    options.allowDestinations = [];
  }
  return options;
}

/**
 * @typedef {object} AttemptNote
 * @property {number} attempt
 * @property {string} status the report payload's status, or "error"
 * @property {string|null} refusalCode from the workflow's or the payload's refusal
 * @property {string|null} errorCode
 */

/** @typedef {{code: number, payload: Record<string, unknown>|null}} ReportResult */
/** @typedef {(input: {endpoint: string, targetId: string|null, profile: import("../profiles/profile.mjs").Profile}) => Promise<import("../cdp/adapter.mjs").CdpSession>} ConnectFn */

/**
 * Scrub one report result down to statuses and codes. No message, no
 * numbers, no destination, no key.
 *
 * @param {number} attempt
 * @param {ReportResult} result
 * @returns {AttemptNote}
 */
function noteOf(attempt, result) {
  const p = /** @type {Record<string, unknown>|null} */ (result.payload);
  const send = p !== null && typeof p.send === "object" && p.send !== null ? /** @type {Record<string, unknown>} */ (p.send) : null;
  const refusal =
    send !== null && typeof send.refusal === "object" && send.refusal !== null
      ? /** @type {Record<string, unknown>} */ (send.refusal)
      : p !== null && typeof p.refusal === "object" && p.refusal !== null
        ? /** @type {Record<string, unknown>} */ (p.refusal)
        : null;
  const error = p !== null && typeof p.error === "object" && p.error !== null ? /** @type {Record<string, unknown>} */ (p.error) : null;
  /** @param {Record<string, unknown>|null} v */
  const code = (v) => (v !== null && typeof v.code === "string" ? v.code : null);
  return {
    attempt,
    status: p !== null && typeof p.status === "string" ? p.status : "error",
    refusalCode: code(refusal),
    errorCode: code(error),
  };
}

/**
 * @typedef {object} DailyPayload
 * @property {typeof DAILY_TOOL} tool
 * @property {typeof DAILY_VERSION} version
 * @property {DailyStatus} status
 * @property {DailyMode} mode
 * @property {string} targetDate
 * @property {AttemptNote[]} attempts
 * @property {import("./state.mjs").PostedRecord|null} record
 * @property {{code: string, message: string}|null} [error] usage errors only
 */

/**
 * @param {object} parts
 * @param {DailyStatus} parts.status
 * @param {DailyMode} parts.mode
 * @param {string} parts.targetDate
 * @param {AttemptNote[]} parts.attempts
 * @param {import("./state.mjs").PostedRecord|null} parts.record
 * @returns {DailyPayload}
 */
function dailyPayload({ status, mode, targetDate, attempts, record }) {
  return { tool: DAILY_TOOL, version: DAILY_VERSION, status, mode, targetDate, attempts, record };
}

/** @typedef {{code: number, payload: DailyPayload|null}} DailyResult */

/**
 * Run the daily job once. Everything that varies in tests is injectable: the
 * report runner, the record store, the lock, the clock, and sleep.
 *
 * @param {{argv?: string[], stderr?: {write: (chunk: string) => unknown}, env?: NodeJS.ProcessEnv, executor?: import("../snowflake/executor.mjs").SqlExecutor|null, decide?: import("../decide.mjs").DecideFn|null, connect?: ConnectFn, settleMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>, store?: import("./state.mjs").RecordStore|null, lock?: ((input: {dir: string, pid?: number, bootId?: string|null, now: () => number, staleMs?: number}) => Promise<import("./state.mjs").LockResult>)|null, bootId?: string|null, runReport?: ((io: NonNullable<Parameters<typeof runReportJob>[0]> & {reportNow: number}) => Promise<ReportResult>)|null}} [io]
 * @returns {Promise<DailyResult>}
 */
export async function runDailyJob({
  argv = [],
  stderr = process.stderr,
  env = process.env,
  executor = null,
  decide = null,
  connect = undefined,
  settleMs = undefined,
  now = Date.now,
  sleep = (ms) => /** @type {Promise<void>} */ (new Promise((resolve) => setTimeout(resolve, ms))),
  store = null,
  lock = null,
  bootId = undefined,
  runReport = null,
} = {}) {
  try {
    const options = parseDailyArgs(argv, { env });
    if (options.help) {
      stderr.write(`${USAGE}\n`);
      return { code: 0, payload: null };
    }
    if (options.stateDir === null) throw new Error("--state-dir is required");
    return await runDaily(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`${DAILY_TOOL}: ${message}\n`);
    return {
      code: 2,
      payload: { ...dailyPayload({ status: "failed", mode: "send", targetDate: "", attempts: [], record: null }), error: { code: "usage", message } },
    };
  }
  /**
   * @param {DailyOptions} options
   * @returns {Promise<DailyResult>}
   */
  async function runDaily(options) {
    const runStartedAt = now();
    const runNow = () => runStartedAt;
    const stateDir = /** @type {string} */ (options.stateDir);
    const state = store ?? new FileRecordStore(stateDir);
    const acquire =
      lock ??
      ((/** @type {{dir: string, pid?: number, bootId?: string|null, now: () => number, staleMs?: number}} */ input) =>
        acquireRunLock({ ...input, ...(bootId !== undefined ? { bootId } : {}) }));

    const held = await acquire({ dir: stateDir, now: runNow });
    if (!held.ok) {
      return { code: 0, payload: dailyPayload({ status: "skipped-locked", mode: options.mode, targetDate: addDays(utcDateOf(runStartedAt), -1), attempts: [], record: null }) };
    }
    try {
      const targetDate = addDays(utcDateOf(runStartedAt), -1);
      /** @type {AttemptNote[]} */
      const attempts = [];
      const existing = await state.read(targetDate);
      if (existing) {
        return { code: 0, payload: dailyPayload({ status: "already-posted", mode: options.mode, targetDate, attempts, record: existing }) };
      }

      for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
        const result = await attemptOnce(options, runStartedAt);
        const note = noteOf(attempt, result);
        attempts.push(note);
        const p = result.payload;
        if (options.mode === "dry-run" && p !== null && p.status === "dry-run") {
          return { code: 0, payload: dailyPayload({ status: "dry-run", mode: options.mode, targetDate, attempts, record: null }) };
        }
        if (result.code === 0 && p !== null && p.status === "executed") {
          const record = /** @type {import("./state.mjs").PostedRecord} */ ({
            date: targetDate,
            status: "posted",
            postedAt: new Date(runStartedAt).toISOString(),
            attempts: attempt,
            recordedAt: new Date(runStartedAt).toISOString(),
          });
          await state.write(record);
          return { code: 0, payload: dailyPayload({ status: "posted", mode: options.mode, targetDate, attempts, record }) };
        }
        // A duplicate_post refusal is terminal but never recorded: the marker
        // may sit in an unposted draft (the composer's text is part of the
        // rendered tree), so it is not proof that a send happened. The run
        // fails without a record; a human checks the channel and either
        // clears the composer or accepts the existing post.
        const nonRetryable =
          result.code === 2 ||
          (note.errorCode !== null && NON_RETRYABLE_CODES.has(note.errorCode)) ||
          note.refusalCode === "duplicate_post";
        if (nonRetryable || attempt === options.maxAttempts) break;
        await sleep(options.retryBaseSec * 1000 * 2 ** (attempt - 1));
      }
      return { code: 1, payload: dailyPayload({ status: "failed", mode: options.mode, targetDate, attempts, record: null }) };
    } finally {
      await held.release();
    }
  }

  /**
   * Build the report argv for one attempt and run it. The report's stdout
   * and stderr are captured into a sink, never forwarded: its payload can
   * carry report data and channel names, and unattended logs must not.
   *
   * @param {DailyOptions} options
   * @param {number} reportNow
   * @returns {Promise<ReportResult>}
   */
  async function attemptOnce(options, reportNow) {
    const runOne = runReport ?? runReportJob;
    /** @type {string[]} */
    const reportArgv = ["--mode", options.mode];
    if (options.destination !== null) {
      reportArgv.push("--destination", options.destination);
      for (const d of options.allowDestinations) reportArgv.push("--allow-destination", d);
    }
    if (options.profile !== null) reportArgv.push("--profile", options.profile);
    if (options.cdp !== null) reportArgv.push("--cdp", options.cdp);
    if (options.target !== null) reportArgv.push("--target", options.target);
    if (options.minConfidence !== null) reportArgv.push("--min-confidence", String(options.minConfidence));
    if (options.maxCandidates !== null) reportArgv.push("--max-candidates", String(options.maxCandidates));
    if (options.model !== null) reportArgv.push("--model", options.model);
    const sink = { write: () => {} };
    try {
      return await runOne({
        argv: reportArgv,
        stdout: sink,
        stderr: sink,
        env,
        executor,
        decide,
        connect,
        now,
        reportNow,
        sleep,
        settleMs,
      });
    } catch (err) {
      return { code: 1, payload: { status: "error", error: { code: "internal", message: err instanceof Error ? err.message : String(err) } } };
    }
  }
}
