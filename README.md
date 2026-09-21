# jev-computer-use

A Pi-usable computer-use system built in small vertical slices. This repository
contains three slices:

1. `jev-cu`: a read-only Node.js CLI that asks TypeSafe Jev (System One) which
   textual UI candidate fits a goal and reports the answer as structured JSON.
   It never executes a UI action. Its contract is unchanged by later slices.
2. `jev-cu-browse`: a bounded browser message workflow over the Chrome DevTools
   Protocol (CDP). A generic `CdpAdapter` observes a page and performs typed,
   policy-authorized actions; a thin `SlackProfile` supplies Slack Web
   semantics and the allowlist. Observation and dry-run are the default;
   navigate, draft, and send must be requested explicitly. See
   [jev-cu-browse](#jev-cu-browse-bounded-browser-message-workflow).
3. `jev-cu-report`: the QA2 daily New Users report. A read-only Snowflake
   boundary reads Unity Analytics Data Access, deterministic code computes a
   typed report and the exact Slack text, and dry-run is the default; only an
   explicit `--mode send` against an exact channel allowlist hands the text to
   the `jev-cu-browse` workflow. See
   [jev-cu-report](#jev-cu-report-qa2-daily-new-users-report).

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
workflow: open one caller-named Slack channel, draft the caller's exact text
into that channel's composer, and submit it only when the caller asks for
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
- **Caller guards for scheduled posts.** A caller may pass two extra
  deterministic guards: `exactDestination` refuses (`destination_mismatch`)
  unless the requested name is exactly the leading name of the chosen link's
  accessible name (decoration such as `(channel)` or `, 3 unread` may follow;
  `qa2-metrics-old` never matches `qa2-metrics`), and `duplicateMarker`
  refuses (`duplicate_post`) to draft or send when the destination page
  already shows a node whose text contains the marker. `jev-cu-report` always
  sets both.
- **Never a real Slack mutation in tests or smoke.** All tests use a fake CDP
  session over a synthetic page model, and the live-transport smoke uses a
  local synthetic page. A real Slack post requires a later, explicit
  authorization naming the destination and content (or a separately approved
  bounded daily-job mandate). The QA2 data source and report calculation are
  `jev-cu-report` below; the real workspace and channel, schedule, long-lived
  credentials, and deployment host remain a later, separately authorized step.

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
| `--destination NAME` | the Slack channel to open, as the caller names it | required beyond observe |
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
| `destination_mismatch` | the page is not at the selected destination, or (with `exactDestination`) the chosen link does not name the requested destination exactly |
| `duplicate_post` | (with `duplicateMarker`) the destination already shows content carrying the marker |

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

## jev-cu-report: QA2 daily New Users report

`jev-cu-report` produces one day's New Users report for the game QA2 from
Unity Analytics Data Access and renders it as exact Slack text. Everything
that decides a number, a date, a query, a retry, or a duplicate is
deterministic code; no model is involved until the optional Slack stage, and
there the model only ever picks among candidates the Slack profile already
recognized, exactly as in `jev-cu-browse`.

### Data source: Unity Analytics Data Access (Snowflake share)

Unity's supported path to raw analytics is the Snowflake Secure Data Share
`UNITYLIVEOPS.UNITY_ANALYTICS_PDA` (Unity docs: "Set up Data Access"). It is
a share, so it is read-only by construction; a database is created from it
in the consumer account and queried with the consumer's own warehouse. The
views and columns this slice uses follow the official reference
(https://docs.unity.com/en-us/analytics/data-access/data-access-views):

| View | Columns used | Purpose |
| --- | --- | --- |
| `ACCOUNT_GAMES` | `ACCOUNT_NAME`, `GAME_NAME`, `GAME_ID`, `ENVIRONMENT_NAME`, `ENVIRONMENT_ID`, `UNITY_PROJECT_ID` | resolve QA2 and its production environment at run time; no `GAME_ID` is hard-coded |
| `ACCOUNT_USERS` | `GAME_ID`, `ENVIRONMENT_ID`, `USER_ID`, `START_DATE` (DATE) | one row per user; `START_DATE` is the player's start date, the fact the event and fact views expose as `PLAYER_START_DATE` |

The two statements (`src/unity/data-access.mjs`) are single `SELECT`s with
positional bindings; the database, schema, warehouse, and role travel as
request context, so no identifier is ever interpolated into SQL:

```sql
SELECT ACCOUNT_NAME, GAME_NAME, GAME_ID, ENVIRONMENT_NAME, ENVIRONMENT_ID, UNITY_PROJECT_ID
FROM ACCOUNT_GAMES
WHERE GAME_NAME = ?
ORDER BY GAME_ID, ENVIRONMENT_ID
```

```sql
SELECT START_DATE AS PLAYER_START_DATE, COUNT(DISTINCT USER_ID) AS NEW_USERS
FROM ACCOUNT_USERS
WHERE GAME_ID = ? AND ENVIRONMENT_ID = ?
  AND START_DATE >= TO_DATE(?, 'YYYY-MM-DD') AND START_DATE < TO_DATE(?, 'YYYY-MM-DD')
GROUP BY START_DATE
ORDER BY START_DATE
```

Game resolution is code: rows whose `GAME_NAME` equals `QA2` exactly must
share one `GAME_ID`, and exactly one of them must have
`ENVIRONMENT_NAME` equal to `production` (compared case-insensitively). Zero
or several rows at any step is an error
(`game_not_found`, `ambiguous_game`, `environment_not_found`,
`ambiguous_environment`); the run never guesses.

### Definitions

All dates are UTC calendar days. With the current clock:

- **window**: the `--days` (default 14, at least 8) complete UTC days before
  today, `[today - days, today)`. The current UTC day is always excluded
  because it is still accumulating.
- **reportDate**: the last complete day, `today - 1`.
- **New users on a day**: `COUNT(DISTINCT USER_ID)` of users whose player
  start date is that day. Days with no row count 0 and are listed in
  `missingDates` (and in the message) so silence is visible.
- **dayBefore**: `reportDate - 1`; `delta = report - dayBefore`;
  `deltaPercent = delta / dayBefore * 100`, null when `dayBefore` is 0.
- **trailing7DayAverage**: mean of the 7 days `reportDate - 7 .. reportDate - 1`
  (the report day is not in its own baseline); delta and deltaPercent as
  above against the unrounded mean; values rounded to 1 decimal.
- **trend**: against the trailing average: `flat` when |deltaPercent| <= 5,
  otherwise `up` or `down` by sign; with a zero baseline, `up` if the day is
  positive, else `flat`.
- **idempotencyKey**: `unity-new-users:<GAME_ID>:<ENVIRONMENT_ID>:<reportDate>`.
  It is part of the message text and is the `duplicateMarker` handed to the
  Slack workflow, so re-running the job for the same day refuses instead of
  posting twice.

Message (plain text, no mrkdwn, no mentions, no links; identical input gives
identical output):

```
QA2 new users (production) for 2026-09-20 (UTC)
New users on 2026-09-20: 1,234
vs 2026-09-19 (1,178): +56 (+4.8%)
vs trailing 7-day avg 2026-09-13..2026-09-19 (1,035.4): +198.6 (+19.2%), trend: up
Last 7 days (UTC): 09-14 1,300 | 09-15 1,220 | 09-16 1,185 | 09-17 1,160 | 09-18 1,205 | 09-19 1,178 | 09-20 1,234
Days with no rows (counted as 0): 2026-09-13
Source: Unity Analytics Data Access (Snowflake) | key: unity-new-users:24601:31001:2026-09-20
```

### Snowflake access and cost expectations

The live executor (`src/snowflake/sql-api.mjs`) uses the Snowflake SQL REST
API with key-pair JWT authentication (RS256, built with `node:crypto`; no
Snowflake SDK), which suits an unattended read-only job: no password, no
browser login, a token that lives ten minutes. Connection facts are read from
the environment only and are never printed, echoed in errors, or written
anywhere:

| Variable | Meaning |
| --- | --- |
| `SNOWFLAKE_ACCOUNT` | account identifier (`ORGNAME-ACCOUNTNAME`, or a locator; region segments are dropped for the JWT) |
| `SNOWFLAKE_USER` | the service user that holds the public key |
| `SNOWFLAKE_PRIVATE_KEY_PATH` | PKCS#8 PEM private key file; `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` if encrypted |
| `SNOWFLAKE_WAREHOUSE` | warehouse to run on |
| `SNOWFLAKE_DATABASE` / `SNOWFLAKE_SCHEMA` | the database created from the Unity share and the schema holding the views |
| `SNOWFLAKE_ROLE` | optional role |
| `SNOWFLAKE_HOST` | optional host override (default `<account>.snowflakecomputing.com`) |

Safety properties of the executor: only a single `SELECT` without `;` and
without any DDL/DML keyword can be sent (checked in code before any request;
the service user's own read-only grants are the second fence); HTTP 429, 5xx,
and network failures are retried at most three times with fixed 1 s, 2 s,
4 s backoff; an in-progress statement (HTTP 202) is polled at most 30 times,
2 s apart; 4xx failures are not retried; a key that cannot be loaded fails
before any request. `parameters.TIMEZONE` is `UTC`; result cells are decoded
from the documented SQL API encoding (DATE as days since epoch, NUMBER as an
integer string).

Cost: the job runs two small queries once a day. Expect to run it on an
X-Small warehouse with auto-suspend set to the minimum (60 s) and auto-resume
on, so compute is billed for roughly one minimum billing period per run;
`ACCOUNT_USERS` is scanned once per run. This README does not claim a fixed
bill: warehouse settings, the share's size, and any other use of the
warehouse determine it, and none of them is created or changed by this code.

### Usage

Dry-run against Snowflake (SNOWFLAKE_* in the environment; SELECT only). It
prints the typed report and exact message without needing a TypeSafe key or
browser:

```sh
node bin/jev-cu-report.mjs
```

Send, only with an explicit request and an exact allowlist, through the
`jev-cu-browse` workflow (Chrome with remote debugging, `TYPESAFE_API_KEY` in
the environment). The destination must equal one `--allow-destination`
character for character; the workflow then additionally requires the chosen
sidebar link to name it exactly, refuses if the channel already shows the
day's idempotency key, and keeps every freshness, read-back, and
post-verification guard:

```sh
node bin/jev-cu-report.mjs --mode send --destination qa2-metrics --allow-destination qa2-metrics
```

Options:

| Option | Meaning | Default |
| --- | --- | --- |
| `--days N` | complete UTC days in the window, 8..90 | `14` |
| `--series-days N` | days shown in the message series, 1..days | `7` |
| `--mode MODE` | `dry-run`, `send` | `dry-run` |
| `--destination NAME` | Slack channel, exactly as the sidebar names it | required for send |
| `--allow-destination NAME` | exact allowlist entry; repeatable | required for send |
| `--profile`, `--cdp`, `--target`, `--min-confidence`, `--max-candidates`, `--model` | as in `jev-cu-browse` | same defaults |

### Output

One JSON object per run: `tool`, `version`, `mode`, `source` (`kind`, the
game and environment, and the window), `report` (the typed report:
`game`, `window`, `reportDate`, `previousDay`, `series`, `missingDates`,
`comparison`, `idempotencyKey`), `message` (the exact text), `delivery`
(destination, allowlist, and the two guards), `status`, and `send`. In
dry-run `status` is `dry-run` and `send` is null. In send mode
`send` is the full `jev-cu-browse` report and `status` repeats its status
(`executed`, `refused`, `unverified`, `no_match`, `escalate`).

Exit codes: `0` for every outcome including `refused` and `unverified`; `1`
for runtime errors (`error.code`: `snowflake_<code>` for transport, protocol,
auth, timeout, or decode failures; the data-access codes above;
`missing_snowflake_config`; `missing_key`; `transport`; `api`); `2` for usage
and validation errors (including `destination_not_allowed`).

### Tests and the fixture

`npm test` covers the read-only guard, SQL API encoding and the JWT (verified
against the generated public key), the REST executor with a scripted fetch
(polling, partitions, retries, auth failures), game resolution and every
failure mode, the report arithmetic, the message, and the CLI end to end with
the fake CDP session over the synthetic Slack page: a send that posts the
exact message, a duplicate refusal, and an exact-destination refusal.
`test/fixtures/unity-data-access.json` records result sets
in the SQL API encoding with the official column names; it is synthetic data,
not a real account. Tests inject that fixture executor and a fixed clock
through the programmatic CLI seam, so the test suite touches neither Snowflake
nor Slack.

A live read-only smoke (two `SELECT`s under process-scoped credentials, no
Slack) is the remaining validation once the Unity share has propagated; it is
not part of CI. The daily schedule, deployment host, long-lived credentials,
the real channel name, and the first real post are separate, explicitly
authorized steps.
