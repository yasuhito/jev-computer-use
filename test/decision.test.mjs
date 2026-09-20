import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { validateRequest, ValidationError, sanitizeLabel, NO_MATCH } from "../src/validate.mjs";
import { buildRequest, normalizeAnswer, runDecision, DECISION_QUESTION_ID } from "../src/decide.mjs";
import { applyPolicy, DEFAULT_MIN_CONFIDENCE } from "../src/policy.mjs";
import { runCli, parseArgs } from "../bin/jev-cu.mjs";

const BASE_REQUEST = {
  goal: "switch the calendar to the previous month",
  candidates: [
    { id: "btn_prev_month", role: "button", label: "previous month" },
    { id: "btn_next_month", role: "button", label: "next month" },
    { label: "Add Event" },
  ],
};

/**
 * @param {string} stdinText
 * @param {string[]} [argv]
 */
function captureIo(stdinText, argv = []) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  return {
    argv,
    stdin: Readable.from([stdinText]),
    stdout: { write: (/** @type {string} */ c) => out.push(c) },
    stderr: { write: (/** @type {string} */ c) => err.push(c) },
    env: {},
    out,
    err,
    text: () => JSON.parse(out.join("")),
  };
}

/**
 * @param {Record<string, unknown>} answers
 * @param {string} [model]
 */
function fakeDecide(answers, model = "jev-fake") {
  return async () => ({
    model,
    answers,
    usage: { input_tokens: 10, output_tokens: 2 },
  });
}

/* ----------------------------- validate ----------------------------- */

test("validateRequest passes a valid request through", () => {
  const r = validateRequest(BASE_REQUEST);
  assert.equal(r.goal, "switch the calendar to the previous month");
  assert.equal(r.context, null);
  assert.deepEqual(r.candidates[2], { id: "c2", role: null, label: "Add Event" });
});

test("validateRequest assigns unique auto ids when provided ids collide", () => {
  const r = validateRequest({
    goal: "g",
    candidates: [{ id: "c1", label: "A" }, { label: "B" }, { label: "C" }],
  });
  assert.deepEqual(r.candidates.map((c) => c.id), ["c1", "c1_0", "c2"]);
});

test("validateRequest rejects empty goal, non-object request, and missing candidates", () => {
  assert.throws(() => validateRequest({ candidates: [{ label: "x" }] }), ValidationError);
  assert.throws(() => validateRequest("nope"), ValidationError);
  assert.throws(() => validateRequest({ goal: "g" }), ValidationError);
  assert.throws(() => validateRequest({ goal: "g", candidates: [] }), ValidationError);
});

test("validateRequest rejects too many candidates and validates maxCandidates bound", () => {
  const many = Array.from({ length: 41 }, (_, i) => ({ label: `item ${i}` }));
  assert.throws(() => validateRequest({ goal: "g", candidates: many }), (/** @type {ValidationError} */ err) => {
    assert.equal(err.code, "too_many_candidates");
    return true;
  });
  const manyMax = Array.from({ length: 41 }, (_, i) => ({ label: `item ${i}` }));
  assert.doesNotThrow(() => validateRequest({ goal: "g", candidates: manyMax }, { maxCandidates: 41 }));
  assert.throws(() => validateRequest({ goal: "g", candidates: [{ label: "x" }] }, { maxCandidates: 0 }));
  assert.throws(() => validateRequest({ goal: "g", candidates: [{ label: "x" }] }, { maxCandidates: 256 }));
});

test("validateRequest rejects duplicate ids and the reserved no_match id", () => {
  assert.throws(
    () => validateRequest({ goal: "g", candidates: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }),
    (/** @type {ValidationError} */ err) => {
      assert.equal(err.code, "duplicate_id");
      return true;
    },
  );
  assert.throws(
    () => validateRequest({ goal: "g", candidates: [{ id: NO_MATCH, label: "A" }] }),
    (/** @type {ValidationError} */ err) => {
      assert.equal(err.code, "reserved_id");
      return true;
    },
  );
});

test("validateRequest rejects malformed ids, labels, roles, and unknown fields", () => {
  assert.throws(() => validateRequest({ goal: "g", candidates: [{ id: "bad id!", label: "A" }] }), ValidationError);
  assert.throws(() => validateRequest({ goal: "g", candidates: [{ label: "" }] }), ValidationError);
  assert.throws(() => validateRequest({ goal: "g", candidates: [{ label: 42 }] }), ValidationError);
  assert.throws(() => validateRequest({ goal: "g", candidates: [{ label: "A", role: 7 }] }), ValidationError);
  assert.throws(() => validateRequest({ goal: "g", extra: true, candidates: [{ label: "A" }] }), (/** @type {ValidationError} */ err) => {
    assert.equal(err.code, "unknown_field");
    return true;
  });
  assert.throws(() => validateRequest({ goal: "g", candidates: [{ label: "A", text: "x" }] }), (/** @type {ValidationError} */ err) => {
    assert.equal(err.code, "unknown_field");
    return true;
  });
});

test("sanitizeLabel collapses whitespace and caps length", () => {
  assert.equal(sanitizeLabel("  a   b\tc  "), "a b c");
  const long = "x".repeat(500);
  assert.equal(sanitizeLabel(long).length, 400);
});

/* ----------------------------- decide ----------------------------- */

test("buildRequest offers every candidate id plus no_match and carries the goal", () => {
  const request = validateRequest(BASE_REQUEST);
  const { state, questions } = buildRequest(request);
  const q = questions[DECISION_QUESTION_ID];
  if (!q || typeof q.instructions !== "object" || q.instructions === null || Array.isArray(q.instructions)) {
    assert.fail("expected a choice question with structured instructions");
  }
  assert.equal(q.type, "choice");
  const questionText = q.instructions.question;
  assert.equal(typeof questionText, "string");
  assert.ok(/** @type {string} */ (questionText).includes("previous month"));
  assert.equal(Object.keys(q.criteria).length, 4);
  assert.ok(NO_MATCH in q.criteria);
  assert.ok("btn_prev_month" in q.criteria);
  assert.ok(q.criteria.btn_prev_month.includes("button"));
  assert.ok(q.criteria.btn_prev_month.includes("previous month"));
  assert.equal(state.goal, request.goal);
  assert.equal(state.candidates.length, 3);
  assert.equal(state.context, undefined);
});

test("buildRequest includes context only when present", () => {
  const request = validateRequest({ ...BASE_REQUEST, context: "month view" });
  const { state } = buildRequest(request);
  assert.equal(state.context, "month view");
});

test("normalizeAnswer accepts a valid candidate choice", () => {
  const n = normalizeAnswer({ choice: "btn_prev_month", confidence: 0.9, probabilities: { btn_prev_month: 0.9 } }, [
    "btn_prev_month",
    "btn_next_month",
  ]);
  assert.equal(n.choice, "btn_prev_month");
  assert.equal(n.confidence, 0.9);
  assert.equal(n.usable, true);
});

test("normalizeAnswer accepts no_match and rejects unknown ids and bad confidence", () => {
  const n = normalizeAnswer({ choice: NO_MATCH, confidence: 1 }, ["btn_prev_month"]);
  assert.equal(n.choice, NO_MATCH);
  assert.equal(n.usable, true);
  assert.equal(normalizeAnswer({ choice: "ghost", confidence: 1 }, ["btn_prev_month"]).choice, null);
  assert.equal(normalizeAnswer({ choice: "btn_prev_month" }, ["btn_prev_month"]).confidence, null);
  assert.equal(
    normalizeAnswer({ choice: "btn_prev_month", confidence: 1.5 }, ["btn_prev_month"]).confidence,
    null,
  );
  assert.equal(normalizeAnswer(null, ["btn_prev_month"]).usable, false);
});

test("runDecision normalizes the injected dependency's answer", async () => {
  const request = buildRequest(validateRequest(BASE_REQUEST));
  const { model, normalized } = await runDecision(request, {
    decide: fakeDecide({ element: { choice: "btn_prev_month", confidence: 0.86, probabilities: {} } }),
  });
  assert.equal(model, "jev-fake");
  assert.equal(normalized.choice, "btn_prev_month");
  assert.equal(normalized.confidence, 0.86);
});

/* ----------------------------- policy ----------------------------- */

test("policy: high-confidence selection passes", () => {
  const request = validateRequest(BASE_REQUEST);
  const n = normalizeAnswer({ choice: "btn_prev_month", confidence: 0.9 }, ["btn_prev_month"]);
  const v = applyPolicy(n, request.candidates, 0.5);
  assert.equal(v.status, "selected");
  assert.ok(v.candidate);
  assert.equal(v.candidate.id, "btn_prev_month");
  assert.equal(v.reason, null);
});

test("policy: confidence below threshold escalates and keeps the tentative candidate", () => {
  const request = validateRequest(BASE_REQUEST);
  const n = normalizeAnswer({ choice: "btn_prev_month", confidence: 0.3 }, ["btn_prev_month"]);
  const v = applyPolicy(n, request.candidates, 0.5);
  assert.equal(v.status, "escalate");
  assert.ok(v.candidate);
  assert.equal(v.candidate.id, "btn_prev_month");
  assert.ok(v.reason);
  assert.match(v.reason, /below the threshold/);
});

test("policy: no_match above threshold is reported as no_match", () => {
  const request = validateRequest(BASE_REQUEST);
  const n = normalizeAnswer({ choice: NO_MATCH, confidence: 1 }, ["btn_prev_month"]);
  const v = applyPolicy(n, request.candidates, 0.5);
  assert.equal(v.status, "no_match");
  assert.equal(v.candidate, null);
});

test("policy: low-confidence no_match escalates rather than reporting no_match", () => {
  const request = validateRequest(BASE_REQUEST);
  const n = normalizeAnswer({ choice: NO_MATCH, confidence: 0.2 }, ["btn_prev_month"]);
  const v = applyPolicy(n, request.candidates, 0.5);
  assert.equal(v.status, "escalate");
  assert.ok(v.reason);
  assert.match(v.reason, /below the threshold/);
});

test("policy: unknown choice or missing confidence escalates", () => {
  const request = validateRequest(BASE_REQUEST);
  const unknown = normalizeAnswer({ choice: "ghost", confidence: 1 }, ["btn_prev_month"]);
  assert.equal(applyPolicy(unknown, request.candidates, 0.5).status, "escalate");
  const noConf = normalizeAnswer({ choice: "btn_prev_month" }, ["btn_prev_month"]);
  const v = applyPolicy(noConf, request.candidates, 0.5);
  assert.equal(v.status, "escalate");
  assert.ok(v.reason);
  assert.match(v.reason, /confidence/);
});

test("policy: rejects a malformed threshold", () => {
  const request = validateRequest(BASE_REQUEST);
  const n = normalizeAnswer({ choice: "btn_prev_month", confidence: 0.9 }, ["btn_prev_month"]);
  assert.throws(() => applyPolicy(n, request.candidates, 1.5));
});

/* ----------------------------- CLI ----------------------------- */

test("runCli prints a selected decision with a fake decide", async () => {
  const io = captureIo(JSON.stringify(BASE_REQUEST));
  const code = await runCli({
    ...io,
    decide: fakeDecide({ element: { choice: "btn_prev_month", confidence: 0.86, probabilities: { btn_prev_month: 0.86 } } }),
  });
  assert.equal(code, 0);
  const payload = io.text();
  assert.equal(payload.status, "selected");
  assert.equal(payload.candidate.id, "btn_prev_month");
  assert.equal(payload.model, "jev-fake");
  assert.equal(payload.threshold, DEFAULT_MIN_CONFIDENCE);
  assert.equal(payload.usage.input_tokens, 10);
});

test("runCli escalates below the threshold and honors --min-confidence", async () => {
  const io = captureIo(JSON.stringify(BASE_REQUEST), ["--min-confidence", "0.9"]);
  const code = await runCli({
    ...io,
    decide: fakeDecide({ element: { choice: "btn_prev_month", confidence: 0.86, probabilities: {} } }),
  });
  assert.equal(code, 0);
  const payload = io.text();
  assert.equal(payload.status, "escalate");
  assert.equal(payload.threshold, 0.9);
  assert.ok(payload.candidate);
  assert.equal(payload.candidate.id, "btn_prev_month");
});

test("runCli reports no_match", async () => {
  const io = captureIo(JSON.stringify(BASE_REQUEST));
  const code = await runCli({
    ...io,
    decide: fakeDecide({ element: { choice: NO_MATCH, confidence: 1, probabilities: {} } }),
  });
  assert.equal(code, 0);
  assert.equal(io.text().status, "no_match");
});

test("runCli escalates when the model returns an unknown choice id", async () => {
  const io = captureIo(JSON.stringify(BASE_REQUEST));
  const code = await runCli({
    ...io,
    decide: fakeDecide({ element: { choice: "btn_that_does_not_exist", confidence: 1, probabilities: {} } }),
  });
  assert.equal(code, 0);
  const payload = io.text();
  assert.equal(payload.status, "escalate");
  assert.equal(payload.decision.choice, null);
});

test("runCli exits 2 on invalid JSON and validation failures", async () => {
  const badJson = captureIo("{not json");
  assert.equal(await runCli(badJson), 2);
  assert.equal(badJson.text().status, "error");
  assert.equal(badJson.text().error.code, "invalid_json");

  const badRequest = captureIo(JSON.stringify({ goal: "", candidates: [{ label: "x" }] }));
  assert.equal(await runCli(badRequest), 2);
  assert.equal(badRequest.text().error.code, "invalid_goal");
});

test("runCli exits 1 with missing_key when the env key is absent on the real path", async () => {
  const io = captureIo(JSON.stringify(BASE_REQUEST));
  const code = await runCli({ ...io, env: {}, decide: null });
  assert.equal(code, 1);
  const payload = io.text();
  assert.equal(payload.status, "error");
  assert.equal(payload.error.code, "missing_key");
  assert.ok(!JSON.stringify(payload).includes("TYPESAFE_API_KEY="));
});

test("runCli exits 1 with api error when the dependency fails", async () => {
  const io = captureIo(JSON.stringify(BASE_REQUEST));
  const code = await runCli({
    ...io,
    decide: async () => {
      throw new Error("HTTP 500 from upstream");
    },
  });
  assert.equal(code, 1);
  const payload = io.text();
  assert.equal(payload.status, "error");
  assert.equal(payload.error.code, "api");
});

test("runCli reads --input from a file", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(`${os.tmpdir()}/jev-cu-test-`);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "req.json");
  await fs.writeFile(file, JSON.stringify(BASE_REQUEST));
  const io = captureIo("", ["--input", file]);
  const code = await runCli({
    ...io,
    decide: fakeDecide({ element: { choice: "btn_prev_month", confidence: 0.9, probabilities: {} } }),
  });
  assert.equal(code, 0);
  assert.equal(io.text().status, "selected");
});

test("runCli exits 2 when stdin is a TTY with no --input", async () => {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const code = await runCli({
    argv: [],
    stdin: { isTTY: true },
    stdout: { write: (/** @type {string} */ c) => out.push(c) },
    stderr: { write: (/** @type {string} */ c) => err.push(c) },
    env: {},
  });
  assert.equal(code, 2);
  assert.equal(JSON.parse(out.join("")).error.code, "usage");
  assert.ok(err.join("").includes("Usage:"));
});

test("runCli --help prints usage to stderr and exits 0 without deciding", async () => {
  const io = captureIo("");
  const code = await runCli({ ...io, argv: ["--help"], decide: fakeDecide({}) });
  assert.equal(code, 0);
  assert.ok(io.err.join("").includes("Usage:"));
  assert.equal(io.out.join(""), "");
});

test("runCli forwards --model to the decision dependency", async () => {
  /** @type {object[]} */
  const seen = [];
  const io = captureIo(JSON.stringify(BASE_REQUEST));
  const code = await runCli({
    ...io,
    argv: ["--model", "jev-latest"],
    decide: async (/** @type {object} */ req) => {
      seen.push(req);
      return { model: "jev-1.13.0", answers: { element: { choice: NO_MATCH, confidence: 1, probabilities: {} } } };
    },
  });
  assert.equal(code, 0);
  assert.equal(/** @type {Record<string, unknown>|undefined} */ (seen[0])?.model, "jev-latest");
});

test("parseArgs accepts = forms and rejects unknown flags and bad values", () => {
  const o = parseArgs(["--min-confidence=0.7", "--input=file.json"]);
  assert.equal(o.minConfidence, 0.7);
  assert.equal(o.input, "file.json");
  assert.throws(() => parseArgs(["--wat"]));
  assert.throws(() => parseArgs(["--min-confidence", "abc"]));
  assert.throws(() => parseArgs(["--min-confidence", "1.5"]));
  assert.throws(() => parseArgs(["--input"]));
});
