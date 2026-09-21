#!/usr/bin/env node
/**
 * jev-cu-browse: bounded browser message workflow over Chrome DevTools
 * Protocol, separate from the read-only jev-cu CLI (whose contract is
 * unchanged). Observation and dry-run are the default; navigate, draft, and
 * send must be requested explicitly and are refused unless a trusted profile
 * permits every action after deterministic revalidation.
 *
 * Exit codes: 0 a workflow outcome was produced (observed, selected,
 * no_match, escalate, refused, executed, unverified), 1 runtime error (API,
 * transport, missing key), 2 usage or validation error.
 */
import { pathToFileURL } from "node:url";
import { ValidationError, DEFAULT_MAX_CANDIDATES, HARD_MAX_CANDIDATES } from "../src/validate.mjs";
import { createTypesafeDecide } from "../src/typesafe-decision.mjs";
import { RefusalError, TransportError } from "../src/errors.mjs";
import { CdpAdapter } from "../src/cdp/adapter.mjs";
import { DEFAULT_CDP_ENDPOINT, listPageTargets, selectPageTarget, connectPageSession } from "../src/cdp/transport.mjs";
import { PROFILES, DEFAULT_PROFILE_NAME } from "../src/profiles/index.mjs";
import {
  MODES,
  DEFAULT_BROWSE_MIN_CONFIDENCE,
  runWorkflow,
  validateMessageText,
  validateDestination,
} from "../src/workflow.mjs";

const TOOL = "jev-cu-browse";
const VERSION = "0.1.0";

const VALUE_FLAGS = new Set([
  "--profile",
  "--destination",
  "--text",
  "--text-file",
  "--mode",
  "--cdp",
  "--target",
  "--min-confidence",
  "--max-candidates",
  "--model",
]);

const USAGE = `Usage: jev-cu-browse --destination NAME [options]

Bounded browser message workflow: open one named conversation, draft exact
text into its composer, and send only when --mode send is given. Every
selection is a TypeSafe Jev Choice; every permission and verification is code.

Modes (--mode, default dry-run):
  observe    snapshot the recognized candidates; no model call, no action
  dry-run    decide the destination (and composer/send if visible); no action
  navigate   click the selected destination and verify the URL
  draft      navigate, then insert --text and verify the read-back; never sends
  send       draft, then click the send control and verify the post

Options:
  --profile NAME        ${[...PROFILES.keys()].join(" | ")} (default ${DEFAULT_PROFILE_NAME})
  --destination NAME    conversation to open, as the caller names it
  --text TEXT           exact message text (draft and send modes)
  --text-file FILE      read the exact message text from FILE instead
  --cdp URL             DevTools HTTP endpoint (default ${DEFAULT_CDP_ENDPOINT})
  --target ID           page target id when more than one page matches
  --min-confidence N    threshold in [0, 1] (default ${DEFAULT_BROWSE_MIN_CONFIDENCE})
  --max-candidates N    recognized-candidate bound in 1..${HARD_MAX_CANDIDATES} (default ${DEFAULT_MAX_CANDIDATES})
  --model NAME          TypeSafe model override (default: SDK default, jev-latest)
  --help                show this help and exit

Environment: TYPESAFE_API_KEY (required beyond observe mode; never printed or stored).
Exit codes: 0 workflow outcome, 1 runtime error, 2 usage error.`;

/**
 * @typedef {object} Options
 * @property {string} profile
 * @property {string|null} destination
 * @property {string|null} text
 * @property {string|null} textFile
 * @property {import("../src/workflow.mjs").Mode} mode
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
    profile: DEFAULT_PROFILE_NAME,
    destination: null,
    text: null,
    textFile: null,
    mode: "dry-run",
    cdp: DEFAULT_CDP_ENDPOINT,
    target: null,
    minConfidence: DEFAULT_BROWSE_MIN_CONFIDENCE,
    maxCandidates: DEFAULT_MAX_CANDIDATES,
    model: null,
    help: false,
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
      if (next === undefined || (next.startsWith("--") && flag !== "--text" && flag !== "--destination")) {
        throw new Error(`${flag} requires a value`);
      }
      inline = next;
      i += 1;
    }
    switch (flag) {
      case "--profile":
        if (!PROFILES.has(inline)) throw new Error(`unknown profile "${inline}" (known: ${[...PROFILES.keys()].join(", ")})`);
        options.profile = inline;
        break;
      case "--destination":
        options.destination = inline;
        break;
      case "--text":
        options.text = inline;
        break;
      case "--text-file":
        options.textFile = inline;
        break;
      case "--mode":
        if (!MODES.includes(inline)) throw new Error(`--mode must be one of ${MODES.join(", ")}, got "${inline}"`);
        options.mode = /** @type {import("../src/workflow.mjs").Mode} */ (inline);
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
      case "--max-candidates": {
        const n = Number(inline);
        if (!Number.isInteger(n) || n < 1 || n > HARD_MAX_CANDIDATES) {
          throw new Error(`--max-candidates must be an integer in 1..${HARD_MAX_CANDIDATES}, got "${inline}"`);
        }
        options.maxCandidates = n;
        break;
      }
    }
  }
  if (options.text !== null && options.textFile !== null) throw new Error("--text and --text-file are mutually exclusive");
  if ((options.mode === "draft" || options.mode === "send") && options.text === null && options.textFile === null) {
    throw new Error(`--mode ${options.mode} requires --text or --text-file`);
  }
  if (options.mode !== "observe" && options.destination === null && !options.help) {
    throw new Error(`--mode ${options.mode} requires --destination`);
  }
  return options;
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

/**
 * @typedef {(input: {endpoint: string, targetId: string|null, profile: import("../src/profiles/profile.mjs").Profile}) => Promise<import("../src/cdp/adapter.mjs").CdpSession>} ConnectFn
 */

/** @type {ConnectFn} */
async function defaultConnect({ endpoint, targetId, profile }) {
  const targets = await listPageTargets(endpoint);
  const target = selectPageTarget(targets, { targetId, profile });
  return connectPageSession(target);
}

/**
 * Run the CLI. I/O, the decision dependency, and the CDP connection are
 * injectable so tests run offline. Returns the process exit code.
 *
 * @param {{argv?: string[], stdout?: WritableLike, stderr?: WritableLike, env?: NodeJS.ProcessEnv, decide?: import("../src/decide.mjs").DecideFn | null, connect?: ConnectFn, now?: () => number, sleep?: (ms: number) => Promise<void>, settleMs?: number}} [io]
 * @returns {Promise<number>}
 */
export async function runCli({
  argv = [],
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
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
    const profile = PROFILES.get(options.profile);
    if (!profile) throw new Error(`profile ${options.profile} vanished from the registry`);

    let text = null;
    if (options.textFile !== null) {
      const { readFile } = await import("node:fs/promises");
      text = validateMessageText(await readFile(options.textFile, "utf8"));
    } else if (options.text !== null) {
      text = validateMessageText(options.text);
    }
    const destination = options.destination === null ? null : validateDestination(options.destination);

    /** @type {import("../src/decide.mjs").DecideFn|null} */
    let decideFn = null;
    if (options.mode !== "observe") {
      const base = decide ?? createTypesafeDecide({ env });
      const modelOverride = options.model;
      decideFn = modelOverride ? (payload) => base({ ...payload, model: modelOverride }) : base;
    }

    session = await connect({ endpoint: options.cdp, targetId: options.target, profile });
    const adapter = new CdpAdapter({
      session,
      profile,
      now,
      ...(sleep ? { sleep } : {}),
      ...(settleMs !== undefined ? { settleMs } : {}),
      maxCandidates: options.maxCandidates,
    });
    const report = await runWorkflow({
      mode: options.mode,
      destination,
      text,
      adapter,
      decide: decideFn,
      threshold: options.minConfidence,
      maxCandidates: options.maxCandidates,
    });
    writeOut({ tool: TOOL, version: VERSION, ...report });
    return 0;
  } catch (err) {
    if (err instanceof ValidationError) {
      writeOut(errorPayload(err.code, err.message));
      return 2;
    }
    if (err instanceof RefusalError) {
      writeOut({
        tool: TOOL,
        version: VERSION,
        status: "refused",
        refusal: { code: err.code, message: err.message, details: err.details },
      });
      return 0;
    }
    const message = err instanceof Error ? err.message : String(err);
    let code = "api";
    if (err instanceof TransportError) code = "transport";
    else if (err instanceof Error && /** @type {{code?: string}} */ (err).code === "missing_key") code = "missing_key";
    if (code !== "missing_key") stderr.write(`${TOOL}: ${message}\n`);
    writeOut(errorPayload(code, message, err instanceof TransportError ? { phase: err.phase } : {}));
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
