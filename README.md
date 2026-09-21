# jev-computer-use

A Pi-usable computer-use system built in small vertical slices. This repository
contains two slices:

1. `jev-cu`: a read-only Node.js CLI that asks TypeSafe Jev (System One) which
   textual UI candidate fits a goal and reports the answer as structured JSON.
   It never executes a UI action. Its contract is unchanged by later slices.
2. `jev-cu-browse`: a bounded browser message workflow over the Chrome DevTools
   Protocol (CDP). A generic `CdpAdapter` observes a page and performs typed,
   policy-authorized actions; a thin `SlackProfile` supplies Slack Web
   semantics and the allowlist. Observation and dry-run are the default;
   navigate, draft, and send must be requested explicitly. See
   [jev-cu-browse](#jev-cu-browse-bounded-browser-message-workflow).

Design reference: https://github.com/Sac-Y/Jev-cu (read its decision loop and
policy gate for the long-term direction). This implementation is an original,
deliberately minimal slice; no code is copied from the reference.

## Safety boundary

`jev-cu` is read-only. It accepts text only, never screenshots or accessibility
trees, and its only output is a JSON report. It does not click, type, send,
delete, upload, install, or touch any application. Candidate text is treated as
data to match against, never as instructions to follow (the instruction
boundary is sent to the model explicitly). Execution exists only in the
separate `jev-cu-browse` command, behind its own boundary described below.

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
`npm run typecheck` (tsc with checkJs over the JSDoc types), and `npm test`
(`node --test test/*.test.mjs`; the file list is passed explicitly because
Node 22 does not expand a bare directory argument), which injects a fake
decision dependency so it never touches the API:

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

## jev-cu-browse: bounded browser message workflow

`jev-cu-browse` drives one Chrome page over CDP through a fixed three-stage
workflow: open one caller-named conversation, draft the caller's exact text
into that conversation's composer, and submit it only when the caller asks for
`--mode send`. Each stage is one TypeSafe Jev Choice over candidates that a
profile already recognized, followed by deterministic validation in code.

### Safety boundary

- **Two layers, one allowlist.** `src/cdp/adapter.mjs` (`CdpAdapter`) knows
  only generic browser concepts: a page target, its accessibility tree reduced
  to role, name, URL, value, and disabled facts, box models, hit testing, one
  left click, and inserting exact text into the focused editable. Which links
  are destinations, which textbox is a composer, which button sends, and which
  action each kind permits come from a profile (`src/profiles/`). The adapter
  enforces the profile and can never widen it; `test/profiles.test.mjs` proves
  the adapter, transport, and workflow never mention Slack.
- **Closed CDP method set.** The adapter can send only the methods listed in
  `ALLOWED_CDP_METHODS`. `Runtime.evaluate` (arbitrary JavaScript), key events,
  `Page.navigate`, network, storage, emulation, and DOM mutation methods are
  refused before they reach the transport.
- **Trusted profiles only execute.** `slack` and `slack-local-synthetic` are
  trusted; the adapter also refuses execution for any injected untrusted
  profile.
- **Slack allowlist.** The Slack profile recognizes exactly three kinds:
  destinations (same-origin `https://app.slack.com/client/<team>/<C id>`
  channel links with no query or fragment), the composer (a `textbox` named
  `Message ...`), and the send
  control (a `button` named `Send` or `Send now`, only while enabled). It
  never recognizes, so the model is never offered and no action can reach:
  reactions, uploads, downloads, deletion, external links, sign-in or
  sign-out, workspace or account settings, search, threads, scheduling, or any
  other control.
- **Decisions are bound to identity and freshness.** A snapshot records the
  target id, URL, and a digest of every recognized candidate. Immediately
  before any action the adapter re-observes and refuses unless the target id,
  URL, digest, and the selected element's role, name, and URL are unchanged,
  the snapshot is younger than 20 s, the element is enabled with a box inside
  the viewport, and a hit test at the click point resolves to that element.
  Before typing it additionally requires the page to be at the selected
  destination and the composer to be empty; before sending, the page must still
  be at the destination and the composer must still hold the exact text.
- **Exact text, read back.** The text is inserted with `Input.insertText`
  (never key events) and read back from the accessibility tree; any difference
  is `text_mismatch`. After sending, the workflow waits for the composer to be
  empty and the exact text to appear on the page; otherwise the status is
  `unverified`.
- **Never a real Slack mutation in tests or smoke.** All tests use a fake CDP
  session over a synthetic page model, and the live-transport smoke uses a
  local synthetic page. A real Slack post requires a later, explicit
  authorization naming the destination and content (or a separately approved
  bounded daily-job mandate). The QA2 user-count data source, report
  calculation, real workspace and channel, schedule, credentials, and
  deployment are a later integration task and are not implemented here.

### Modes

| Mode | Model calls | Browser actions |
| --- | --- | --- |
| `observe` | none | none; prints the recognized candidates |
| `dry-run` (default) | destination; composer and send if visible | none; prints the plan and whether it would be executable |
| `navigate` | destination | one click on the destination, URL verified |
| `draft` | destination, composer | navigate, then one focus click and one `insertText`, read-back verified; never sends |
| `send` | destination, composer, send | draft, then one click on the send control, post verified |

The default confidence threshold is 0.8 (higher than `jev-cu`'s 0.5 because
acting is higher-stakes than reporting); it applies in every mode so a dry-run
predicts exactly what an execution mode would do.

### Usage

Start Chrome with remote debugging (a dedicated profile, signed in to the
Slack workspace, with the web client open in exactly one tab), then:

```sh
# preview only (default dry-run): which sidebar link would be opened
node bin/jev-cu-browse.mjs --destination "qa2-metrics"

# open the channel
node bin/jev-cu-browse.mjs --destination "qa2-metrics" --mode navigate

# open it and leave the exact text in the composer, without sending
node bin/jev-cu-browse.mjs --destination "qa2-metrics" --mode draft --text-file message.txt

# explicit send
node bin/jev-cu-browse.mjs --destination "qa2-metrics" --mode send --text-file message.txt
```

Options:

| Option | Meaning | Default |
| --- | --- | --- |
| `--profile NAME` | `slack` or `slack-local-synthetic` | `slack` |
| `--destination NAME` | the conversation to open, as the caller names it | required beyond observe |
| `--text TEXT` / `--text-file FILE` | exact message text (draft and send); newline and tab allowed, other control characters rejected, at most 4000 characters | |
| `--mode MODE` | `observe`, `dry-run`, `navigate`, `draft`, `send` | `dry-run` |
| `--cdp URL` | DevTools HTTP endpoint | `http://127.0.0.1:9222` |
| `--target ID` | page target id when more than one page matches the profile | auto when exactly one matches |
| `--min-confidence N` | threshold in [0, 1] | `0.8` |
| `--max-candidates N` | bound on recognized candidates, integer in 1..255 | `40` |
| `--model NAME` | TypeSafe model override | `jev-latest` |

`TYPESAFE_API_KEY` is required beyond observe mode and is read from the
environment only. The live CDP transport uses the runtime's global WebSocket
(Node 22 or newer); the offline tests run on Node 20 as well.

### Output

One JSON object per run. `status` is one of `observed`, `selected` (dry-run),
`no_match`, `escalate`, `refused`, `executed`, `unverified`, or `error`.
`completed` names the last action stage that ran (`navigate`, `draft`, `send`,
or null). `steps` lists every decision (`phase: "decide"`, with the Jev choice,
confidence, and probabilities), every action (`phase: "act"`, with the click
point, URLs, and read-back), the post verification, and in dry-run a `plan`.
`refusal.code` is one of:

| Code | Meaning |
| --- | --- |
| `target_not_allowed` | the page origin is outside the profile's allowed targets |
| `no_target` / `ambiguous_target` | zero or several page targets match; pass `--target` |
| `no_candidates` / `too_many_candidates` | nothing recognized, or more than `--max-candidates` |
| `untrusted_profile` | execution requested under a profile that only observes |
| `unsupported_action` | the profile does not permit that action on that candidate |
| `ambiguous_identity` | two distinct candidates share the chosen label, or the hit test resolved elsewhere |
| `stale_snapshot` / `stale_target` | the decision is older than 20 s, or the session's target changed |
| `changed_state` | URL, candidate set, or the selected element changed before acting |
| `not_actionable` | the element is disabled or has no clickable box in the viewport |
| `text_mismatch` | the composer was not empty, or the read-back differs from the exact text |
| `destination_mismatch` | the page is not at the selected destination |

Exit codes: `0` for every workflow outcome including `refused` and
`unverified`; `1` for runtime errors (`error.code` is `api`, `transport`, or
`missing_key`); `2` for usage and validation errors.

### Tests and the synthetic page

`npm test` covers the profiles, the adapter gate, the workflow, the CLI, and
the transport with a fake CDP session (`test/fake-cdp.mjs`) over a synthetic
Slack-like page model (`test/fixtures/synthetic-slack-page.json`), and asserts
that only allowlisted CDP methods are sent and that no input reaches the page
on any refusal. No network, no Slack.

To exercise the live transport against a real Chrome with no credential:

```sh
npm run serve:synthetic-slack -- --port 8765
chromium --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/jev-cu-chrome \
  http://127.0.0.1:8765/client/T0SYNTH/C0GENERAL
node bin/jev-cu-browse.mjs --profile slack-local-synthetic --mode observe
```

The synthetic page is rendered from the same JSON model the fake CDP uses; it
imitates only the shapes the Slack profile cares about plus decoys the profile
must never offer, and it stores nothing.
