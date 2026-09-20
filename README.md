# jev-computer-use

A Pi-usable computer-use system built in small vertical slices. This repository
currently contains only the first read-only slice: `jev-cu`, a small Node.js
CLI that asks TypeSafe Jev (System One) which textual UI candidate fits a goal,
and reports the answer as structured JSON. It never executes a UI action.

Design reference: https://github.com/Sac-Y/Jev-cu (read its decision loop and
policy gate for the long-term direction). This implementation is an original,
deliberately minimal slice; no code is copied from the reference.

## Safety boundary

`jev-cu` is read-only. It accepts text only, never screenshots or accessibility
trees, and its only output is a JSON report. It does not click, type, send,
delete, upload, install, or touch any application. Candidate text is treated as
data to match against, never as instructions to follow (the instruction
boundary is sent to the model explicitly). Later slices add execution, adapters,
and app integrations; none of that exists here.

## How a decision is made

1. The request is validated deterministically in code: schema, field types,
   candidate bounds, id uniqueness, and the reserved `no_match` id.
2. One TypeSafe Choice question is built: `Which single candidate should be
   acted on next to accomplish the goal?` with one option per candidate id plus
   `no_match`.
3. The model's answer is normalized in code: the chosen id must be one of the
   offered options, and confidence must be a finite number in [0, 1]. Anything
   else is unusable.
4. An explicit confidence threshold is applied in code. The model never decides
   whether its own answer may be used.
5. Exactly one JSON object is printed on stdout.

## Install

Node.js 20 or newer:

```sh
npm install
```

`TYPESAFE_API_KEY` is read from the environment only. It is never printed,
persisted, hashed, copied, or committed.

## Usage

Pi-callable example, from the repository root (key must be in the environment):

```sh
node bin/jev-cu.mjs --input examples/calendar-previous-month.json
```

Equivalent stdin form:

```sh
node bin/jev-cu.mjs <<'EOF'
{"goal": "switch the calendar to the previous month", "candidates": [{"id": "btn_prev_month", "role": "button", "label": "previous month"}, {"id": "btn_next_month", "role": "button", "label": "next month"}]}
EOF
```

Options:

| Option | Meaning | Default |
| --- | --- | --- |
| `--input FILE` | read request JSON from FILE instead of stdin | stdin |
| `--min-confidence N` | threshold in [0, 1] | `0.5` |
| `--max-candidates N` | candidate bound, integer in 1..255 | `40` |
| `--model NAME` | TypeSafe model override | `jev-latest` |
| `--help` | usage | |

## Input schema

```json
{
  "goal": "switch the calendar to the previous month",
  "context": "Calendar app, month view, title reads September 2026",
  "candidates": [
    {"id": "btn_prev_month", "role": "button", "label": "previous month"}
  ]
}
```

- `goal` (required): non-empty string, capped at 2000 chars.
- `candidates` (required): 1 to `--max-candidates` entries; each has a required
  non-empty `label` (capped at 400 chars) plus optional `id` (matches
  `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`, unique, must not be `no_match`) and
  optional `role`. Ids are assigned deterministically when omitted.
- `context` (optional): short textual state such as a window title, capped at
  2000 chars.
- Unknown fields are rejected so wrapper typos fail loudly.

## Output schema

One JSON object per run. `status` is one of:

- `selected`: Jev chose a candidate and its confidence is at or above the
  threshold. `candidate` carries the full entry.
- `no_match`: Jev chose `no_match` at or above the threshold; nothing in the
  candidate list fits the goal.
- `escalate`: a valid but unusable result. Covers confidence below the
  threshold (including a low-confidence `no_match`), an unknown choice id, or
  missing or out-of-range confidence. `reason` explains; a tentatively chosen
  candidate may still be present for context, but no action may be taken on an
  escalated result.
- `error`: the run failed before a decision existed (`error.code` says why:
  usage, invalid_json, validation codes, missing_key, api).

Exit codes: `0` for selected, no_match, and escalate; `1` for runtime errors
(API, network, missing key); `2` for usage and validation errors.

```json
{
  "tool": "jev-cu",
  "version": "0.1.0",
  "status": "selected",
  "goal": "switch the calendar to the previous month",
  "model": "jev-1.13.0",
  "threshold": 0.5,
  "decision": {"choice": "btn_prev_month", "confidence": 0.92, "probabilities": {"btn_prev_month": 0.92}},
  "candidate": {"id": "btn_prev_month", "role": "button", "label": "previous month"},
  "reason": null,
  "usage": {"input_tokens": 331, "output_tokens": 21}
}
```

## Confidence policy

The threshold defaults to 0.5 following the TypeSafe confidence guidance
(https://docs.typesafe.ai/confidence.md): below 0.5 the model is genuinely
unsure and the result must not be acted on. Raise it for higher-stakes
selections via `--min-confidence`. Threshold application, answer normalization,
and every error path are deterministic code, not model judgment.

## Tests and CI

Offline checks run deterministically with no network: `npm run lint` (ESLint),
`npm run typecheck` (tsc with checkJs over the JSDoc types), and `npm test`,
which injects a fake decision dependency so it never touches the API:

```sh
npm run lint && npm run typecheck && npm test
```

`.github/workflows/ci.yml` runs exactly these three checks with a lockfile
install (`npm ci`) on Node 20 and 22. CI never runs the real Jev API smoke and
needs no secrets.

One real smoke invocation against the live API (uses the environment key,
prints only the model's decision, no secrets):

```sh
node bin/jev-cu.mjs --input examples/calendar-previous-month.json
```
