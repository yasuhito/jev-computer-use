#!/usr/bin/env node
/**
 * jev-cu-report: the QA2 daily New Users report. Reads Unity Analytics Data
 * Access through the read-only Snowflake boundary,
 * builds the typed report and the exact Slack text deterministically, and
 * by default stops there (dry-run). Only `--mode send` hands the text to
 * the bounded jev-cu-browse workflow, and only for a destination that is
 * named exactly in the caller's allowlist; the workflow's own destination,
 * freshness, read-back, duplicate, and post-verification guards all apply.
 *
 * Exit codes: 0 an outcome was produced (dry-run, or any workflow status
 * including refused and unverified), 1 runtime error (snowflake, data,
 * api, transport, missing key or config), 2 usage or validation error.
 */
import { pathToFileURL } from "node:url";
import { ValidationError, DEFAULT_MAX_CANDIDATES, HARD_MAX_CANDIDATES } from "../src/validate.mjs";
import { createTypesafeDecide } from "../src/typesafe-decision.mjs";
import { RefusalError, TransportError } from "../src/errors.mjs";
import { CdpAdapter } from "../src/cdp/adapter.mjs";
import { DEFAULT_CDP_ENDPOINT, listPageTargets, selectPageTarget, connectPageSession } from "../src/cdp/transport.mjs";
import { PROFILES, DEFAULT_PROFILE_NAME } from "../src/profiles/index.mjs";
import { DEFAULT_BROWSE_MIN_CONFIDENCE, runWorkflow, validateMessageText, validateDestination } from "../src/workflow.mjs";
import { SnowflakeError } from "../src/snowflake/executor.mjs";
import { createSqlApiExecutor, MissingSnowflakeConfigError } from "../src/snowflake/sql-api.mjs";
import {
  DataAccessError,
  DEFAULT_GAME_NAME,
  DEFAULT_ENVIRONMENT_NAME,
  resolveGameEnvironment,
  fetchNewUsersByStartDate,
} from "../src/unity/data-access.mjs";
import { completeUtcWindow, DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS, MAX_WINDOW_DAYS } from "../src/report/dates.mjs";
import { buildNewUsersReport } from "../src/report/new-users.mjs";
import { renderSlackMessage, DEFAULT_SERIES_DAYS } from "../src/report/slack-message.mjs";

const TOOL = "jev-cu-report";
const VERSION = "0.1.0";

export const REPORT_MODES = Object.freeze(["dry-run", "send"]);
/** @typedef {"dry-run"|"send"} ReportMode */
const VALUE_FLAGS = new Set([
  "--days",
  "--series-days",
  "--mode",
  "--destination",
  "--allow-destination",
  "--profile",
  "--cdp",
  "--target",
  "--min-confidence",
  "--max-candidates",
  "--model",
]);

const USAGE = `Usage: jev-cu-report [options]

Daily New Users report from Unity Analytics Data Access (Snowflake share),
computed deterministically and rendered as exact Slack text. Dry-run is the
default and touches no browser. --mode send posts through jev-cu-browse's
bounded workflow, only to a destination named in --allow-destination.

Data options:
  --days N              complete UTC days in the window, ${MIN_WINDOW_DAYS}..${MAX_WINDOW_DAYS} (default ${DEFAULT_WINDOW_DAYS})
  --series-days N       days shown in the message series, 1..days (default ${DEFAULT_SERIES_DAYS})

Delivery options:
  --mode MODE           ${REPORT_MODES.join(" | ")} (default dry-run)
  --destination NAME    Slack channel name, exactly as the sidebar shows it (send only)
  --allow-destination NAME
                        allowlisted destination; repeatable; --destination must match one exactly
  --profile NAME        ${[...PROFILES.keys()].join(" | ")} (default ${DEFAULT_PROFILE_NAME})
  --cdp URL             DevTools HTTP endpoint (default ${DEFAULT_CDP_ENDPOINT})
  --target ID           page target id when more than one page matches
  --min-confidence N    Jev threshold in [0, 1] (default ${DEFAULT_BROWSE_MIN_CONFIDENCE})
  --max-candidates N    recognized-candidate bound in 1..${HARD_MAX_CANDIDATES} (default ${DEFAULT_MAX_CANDIDATES})
  --model NAME          TypeSafe model override
  --help                show this help and exit

Environment: SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PRIVATE_KEY_PATH,
  SNOWFLAKE_WAREHOUSE, SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA (required for
  optional SNOWFLAKE_ROLE, SNOWFLAKE_PRIVATE_KEY_PASSPHRASE,
  SNOWFLAKE_HOST); TYPESAFE_API_KEY (send only). Never printed or stored.
Exit codes: 0 outcome, 1 runtime error, 2 usage error.`;

/**
 * @typedef {object} Options
 * @property {number} days
 * @property {number} seriesDays
 * @property {ReportMode} mode
 * @property {string|null} destination
 * @property {string[]} allowDestinations
 * @property {string} profile
 * @property {string} cdp
 * @property {string|null} target
 * @property {number} minConfidence
 * @property {number} maxCandidates
 * @property {string|null} model
 * @property {boolean} help
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 * @throws {Error} on unknown or malformed options (usage error)
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = {
    days: DEFAULT_WINDOW_DAYS,
    seriesDays: DEFAULT_SERIES_DAYS,
    mode: "dry-run",
    destination: null,
    allowDestinations: [],
    profile: DEFAULT_PROFILE_NAME,
    cdp: DEFAULT_CDP_ENDPOINT,
    target: null,
    minConfidence: DEFAULT_BROWSE_MIN_CONFIDENCE,
    maxCandidates: DEFAULT_MAX_CANDIDATES,
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
    const eq = arg.indexOf("=");
    const flag = eq > -1 ? arg.slice(0, eq) : arg;
    let inline = eq > -1 ? arg.slice(eq + 1) : undefined;
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown option "${arg}"`);
    if (inline === undefined) {
      const next = argv[i + 1];
      const nameFlag = flag === "--destination" || flag === "--allow-destination";
      if (next === undefined || (next.startsWith("--") && !nameFlag)) throw new Error(`${flag} requires a value`);
      inline = next;
      i += 1;
    }
    switch (flag) {
      case "--days":
        options.days = integer(flag, inline, MIN_WINDOW_DAYS, MAX_WINDOW_DAYS);
        break;
      case "--series-days":
        options.seriesDays = integer(flag, inline, 1, MAX_WINDOW_DAYS);
        break;
      case "--mode":
        if (!REPORT_MODES.includes(inline)) throw new Error(`--mode must be one of ${REPORT_MODES.join(", ")}, got "${inline}"`);
        options.mode = /** @type {ReportMode} */ (inline);
        break;
      case "--destination":
        options.destination = inline;
        break;
      case "--allow-destination":
        options.allowDestinations.push(inline);
        break;
      case "--profile":
        if (!PROFILES.has(inline)) throw new Error(`unknown profile "${inline}" (known: ${[...PROFILES.keys()].join(", ")})`);
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
  if (options.seriesDays > options.days) throw new Error(`--series-days (${options.seriesDays}) may not exceed --days (${options.days})`);
  if (options.mode !== "dry-run") {
    if (options.destination === null) throw new Error(`--mode ${options.mode} requires --destination`);
    if (options.allowDestinations.length === 0) throw new Error(`--mode ${options.mode} requires at least one --allow-destination`);
  }
  return options;
}

/**
 * The allowlist is exact: byte-for-byte equality after the same whitespace
 * normalization the workflow applies to destinations. No prefixes, no
 * case folding, no patterns.
 *
 * @param {string} destination
 * @param {string[]} allowlist
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertAllowlisted(destination, allowlist) {
  const wanted = validateDestination(destination);
  const allowed = allowlist.map((d) => validateDestination(d));
  if (!allowed.includes(wanted)) {
    throw new ValidationError(`destination "${wanted}" is not in the exact allowlist (${allowed.map((d) => `"${d}"`).join(", ")})`, "destination_not_allowed");
  }
  return wanted;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
function errorPayload(code, message, extra = {}) {
  return { tool: TOOL, version: VERSION, status: "error", error: { code, message }, ...extra };
}

/** @typedef {{write: (chunk: string) => unknown}} WritableLike */
/** @typedef {(input: {endpoint: string, targetId: string|null, profile: import("../src/profiles/profile.mjs").Profile}) => Promise<import("../src/cdp/adapter.mjs").CdpSession>} ConnectFn */

/** @type {ConnectFn} */
async function defaultConnect({ endpoint, targetId, profile }) {
  const targets = await listPageTargets(endpoint);
  const target = selectPageTarget(targets, { targetId, profile });
  return connectPageSession(target);
}

/**
 * Run the CLI. The SQL executor, decision dependency, CDP connection, and
 * clock are injectable so tests run offline. Returns the process exit code.
 *
 * @param {{argv?: string[], stdout?: WritableLike, stderr?: WritableLike, env?: NodeJS.ProcessEnv, executor?: import("../src/snowflake/executor.mjs").SqlExecutor|null, decide?: import("../src/decide.mjs").DecideFn|null, connect?: ConnectFn, now?: () => number, sleep?: (ms: number) => Promise<void>, settleMs?: number}} [io]
 * @returns {Promise<number>}
 */
export async function runCli({
  argv = [],
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  executor = null,
  decide = null,
  connect = defaultConnect,
  now = Date.now,
  sleep = undefined,
  settleMs = undefined,
} = {}) {
  /** @param {object} payload */
  const writeOut = (payload) => stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  /** @type {import("../src/cdp/adapter.mjs").CdpSession|null} */
  let session = null;
  try {
    let options;
    try {
      options = parseArgs(argv);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stderr.write(`${USAGE}\n`);
      writeOut(errorPayload("usage", message));
      return 2;
    }
    if (options.help) {
      stderr.write(`${USAGE}\n`);
      return 0;
    }
    const gameName = DEFAULT_GAME_NAME;
    const environmentName = DEFAULT_ENVIRONMENT_NAME;
    const destination = options.destination === null ? null : assertAllowlisted(options.destination, options.allowDestinations);

    // Everything the browser stage needs is resolved before any query runs,
    // so a missing key never leaves a warehouse running for nothing.
    /** @type {import("../src/decide.mjs").DecideFn|null} */
    let decideFn = null;
    const profile = PROFILES.get(options.profile);
    if (!profile) throw new Error(`profile ${options.profile} vanished from the registry`);
    if (options.mode !== "dry-run") {
      const base = decide ?? createTypesafeDecide({ env });
      const modelOverride = options.model;
      decideFn = modelOverride ? (payload) => base({ ...payload, model: modelOverride }) : base;
    }

    const source = executor ?? createSqlApiExecutor({ env, now, ...(sleep ? { sleep } : {}) });

    const clock = now();
    const window = completeUtcWindow(clock, options.days);
    const game = await resolveGameEnvironment(source, { gameName, environmentName });
    const rows = await fetchNewUsersByStartDate(source, { gameId: game.gameId, environmentId: game.environmentId, start: window.start, end: window.end });
    const report = buildNewUsersReport({ game, window, rows, generatedAt: new Date(clock).toISOString() });
    const message = validateMessageText(renderSlackMessage(report, { seriesDays: options.seriesDays }));

    const base = {
      tool: TOOL,
      version: VERSION,
      mode: options.mode,
      source: { kind: source.kind, game: gameName, environment: environmentName, window },
      report,
      message,
      delivery: {
        destination,
        allowlist: options.allowDestinations,
        exactDestination: true,
        duplicateMarker: report.idempotencyKey,
      },
    };
    if (options.mode === "dry-run") {
      writeOut({ ...base, status: "dry-run", send: null });
      return 0;
    }
    if (destination === null || decideFn === null) throw new Error("send needs a destination and a decision dependency");

    session = await connect({ endpoint: options.cdp, targetId: options.target, profile });
    const adapter = new CdpAdapter({
      session,
      profile,
      now,
      ...(sleep ? { sleep } : {}),
      ...(settleMs !== undefined ? { settleMs } : {}),
      maxCandidates: options.maxCandidates,
    });
    const send = await runWorkflow({
      mode: options.mode,
      destination,
      text: message,
      adapter,
      decide: decideFn,
      threshold: options.minConfidence,
      maxCandidates: options.maxCandidates,
      exactDestination: true,
      duplicateMarker: report.idempotencyKey,
    });
    writeOut({ ...base, status: send.status, send });
    return 0;
  } catch (err) {
    if (err instanceof ValidationError) {
      writeOut(errorPayload(err.code, err.message));
      return 2;
    }
    if (err instanceof RefusalError) {
      writeOut({ tool: TOOL, version: VERSION, status: "refused", refusal: { code: err.code, message: err.message, details: err.details } });
      return 0;
    }
    const message = err instanceof Error ? err.message : String(err);
    let code = "api";
    /** @type {Record<string, unknown>} */
    let extra = {};
    if (err instanceof TransportError) {
      code = "transport";
      extra = { phase: err.phase };
    } else if (err instanceof SnowflakeError) {
      code = `snowflake_${err.code}`;
      extra = { phase: err.phase, details: err.details };
    } else if (err instanceof DataAccessError) {
      code = err.code;
      extra = { details: err.details };
    } else if (err instanceof MissingSnowflakeConfigError) {
      code = err.code;
    } else if (err instanceof Error && /** @type {{code?: string}} */ (err).code === "missing_key") {
      code = "missing_key";
    }
    if (code !== "missing_key" && code !== "missing_snowflake_config") stderr.write(`${TOOL}: ${message}\n`);
    writeOut(errorPayload(code, message, extra));
    return 1;
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        /* closing is best-effort */
      }
    }
  }
}

const isMain = (() => {
  if (typeof process === "undefined") return false;
  const scriptArg = process.argv[1];
  return scriptArg !== undefined && import.meta.url === pathToFileURL(scriptArg).href;
})();
if (isMain) {
  runCli({ argv: process.argv.slice(2) }).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${TOOL}: unexpected failure: ${err?.stack ?? String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
