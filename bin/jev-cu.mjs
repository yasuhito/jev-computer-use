#!/usr/bin/env node
/**
 * jev-cu: read-only Jev (TypeSafe System One) UI-candidate selection CLI.
 *
 * Reads a goal plus a bounded list of textual UI candidates, asks Jev to pick
 * one candidate or no_match, applies an explicit confidence threshold in code,
 * and prints exactly one JSON decision object on stdout. It never clicks,
 * types, sends, deletes, uploads, or executes any UI action.
 *
 * Exit codes: 0 decision produced (selected | no_match | escalate),
 * 1 runtime error (API, network, missing key), 2 usage or validation error.
 */
import { pathToFileURL } from "node:url";
import {
  ValidationError,
  validateRequest,
  DEFAULT_MAX_CANDIDATES,
  HARD_MAX_CANDIDATES,
} from "../src/validate.mjs";
import { buildRequest, runDecision } from "../src/decide.mjs";
import { applyPolicy, DEFAULT_MIN_CONFIDENCE } from "../src/policy.mjs";
import { createTypesafeDecide } from "../src/typesafe-decision.mjs";

const TOOL = "jev-cu";
const VERSION = "0.1.0";

const VALUE_FLAGS = new Set(["--input", "--min-confidence", "--max-candidates", "--model"]);

const USAGE = `Usage: jev-cu [options]

Read a goal plus a bounded list of textual UI candidates, ask TypeSafe Jev to
choose one candidate (or no_match), apply the confidence threshold, and print
one JSON decision object. Read-only: never executes a UI action.

Input: JSON on stdin, or --input FILE. Shape:
  {"goal": "...", "candidates": [{"id"?, "role"?, "label"}], "context"?}

Options:
  --input FILE          read request JSON from FILE instead of stdin
  --min-confidence N    threshold in [0, 1] (default ${DEFAULT_MIN_CONFIDENCE})
  --max-candidates N    candidate bound in 1..${HARD_MAX_CANDIDATES} (default ${DEFAULT_MAX_CANDIDATES})
  --model NAME          TypeSafe model override (default: SDK default, jev-latest)
  --help                show this help and exit

Environment: TYPESAFE_API_KEY (required for a real call; never printed or stored).
Exit codes: 0 selected/no_match/escalate, 1 runtime error, 2 usage error.`;

/**
 * @param {string[]} argv
 * @returns {{input: string|null, minConfidence: number, maxCandidates: number, model: string|null, help: boolean}}
 * @throws {Error} on unknown or malformed options (usage error)
 */
export function parseArgs(argv) {
  /** @type {{input: string|null, minConfidence: number, maxCandidates: number, model: string|null, help: boolean}} */
  const options = {
    input: null,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
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
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`unknown option "${arg}"`);
    }
    if (inline === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      inline = next;
      i += 1;
    }
    switch (flag) {
      case "--input":
        options.input = inline;
        break;
      case "--model":
        options.model = inline;
        break;
      case "--min-confidence": {
        const n = Number(inline);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          throw new Error(`--min-confidence must be a number in [0, 1], got "${inline}"`);
        }
        options.minConfidence = n;
        break;
      }
      case "--max-candidates": {
        const n = Number(inline);
        if (!Number.isInteger(n)) {
          throw new Error(`--max-candidates must be an integer, got "${inline}"`);
        }
        options.maxCandidates = n;
        break;
      }
    }
  }
  return options;
}

/**
 * @param {string} code
 * @param {string} message
 */
function errorPayload(code, message) {
  return { tool: TOOL, version: VERSION, status: "error", error: { code, message } };
}

/**
 * @param {AsyncIterable<Buffer | string>} stream
 * @returns {Promise<string>}
 */
async function readAll(stream) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** @typedef {{write: (chunk: string) => unknown}} WritableLike */

/**
 * Run the CLI. All I/O and the decision dependency are injectable so tests run
 * offline. Returns the process exit code.
 *
 * @param {{argv?: string[], stdin?: object, stdout?: WritableLike, stderr?: WritableLike, env?: NodeJS.ProcessEnv, decide?: import("../src/decide.mjs").DecideFn | null}} [io]
 * @returns {Promise<number>}
 */
export async function runCli({
  argv = [],
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  decide = null,
} = {}) {
  /** @param {object} payload */
  const writeOut = (payload) => stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stderr.write(`${USAGE}\n`);
      return 0;
    }

    let rawText;
    if (options.input !== null) {
      const { readFile } = await import("node:fs/promises");
      rawText = await readFile(options.input, "utf8");
    } else if (/** @type {{isTTY?: boolean}} */ (stdin).isTTY) {
      stderr.write(`${USAGE}\n`);
      writeOut(errorPayload("usage", "no input: pass JSON on stdin or use --input FILE"));
      return 2;
    } else {
      rawText = await readAll(/** @type {AsyncIterable<Buffer | string>} */ (stdin));
    }

    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeOut(errorPayload("invalid_json", `request is not valid JSON: ${message}`));
      return 2;
    }

    let request;
    try {
      request = validateRequest(raw, { maxCandidates: options.maxCandidates });
    } catch (err) {
      if (err instanceof ValidationError) {
        writeOut(errorPayload(err.code, err.message));
        return 2;
      }
      throw err;
    }

    const decideFn = decide ?? createTypesafeDecide({ env });
    const modelOverride = options.model;
    /** @type {import("../src/decide.mjs").DecideFn} */
    const decided = modelOverride
      ? (requestPayload) => decideFn({ ...requestPayload, model: modelOverride })
      : decideFn;
    const { model, normalized, usage } = await runDecision(buildRequest(request), {
      decide: decided,
    });
    const verdict = applyPolicy(normalized, request.candidates, options.minConfidence);

    writeOut({
      tool: TOOL,
      version: VERSION,
      status: verdict.status,
      goal: request.goal,
      model,
      threshold: options.minConfidence,
      decision: {
        choice: normalized.choice,
        confidence: normalized.confidence,
        probabilities: normalized.probabilities,
      },
      candidate: verdict.candidate,
      reason: verdict.reason,
      usage,
    });
    return 0;
  } catch (err) {
    if (err instanceof ValidationError) {
      writeOut(errorPayload(err.code, err.message));
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error && /** @type {{code?: string}} */ (err).code === "missing_key"
      ? "missing_key"
      : "api";
    if (code !== "missing_key") stderr.write(`${TOOL}: ${message}\n`);
    writeOut(errorPayload(code, message));
    return 1;
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
      process.stderr.write(`jev-cu: unexpected failure: ${err?.stack ?? String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
