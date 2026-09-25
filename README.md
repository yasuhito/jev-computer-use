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
   [jev-cu-report](#jev-cu-report-qa2-daily-new-users-report). Its unattended
   daily wrapper `jev-cu-daily` adds per-date durable idempotency, a run
   lock, bounded retries, and systemd templates for one run per day at
   10:00 JST. See
   [jev-cu-daily](#jev-cu-daily-unattended-daily-schedule).

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
  to role, name, contents text (the static text below a node whose accessible
  name the browser left empty), URL, value, and disabled facts, the element
  attributes of nodes whose roles a profile lists in `attributeRoles` (one
  `DOM.describeNode` each, at most 256 per observation), box models, hit
  testing, one left click, and inserting exact text into the focused editable.
  Which links or rows are destinations, which textbox is a composer, which
  button sends, and which action each kind permits come from a profile
  (`src/profiles/`). The adapter enforces the profile and can never widen it;
  `test/profiles.test.mjs` proves the adapter, transport, and workflow never
  mention Slack or carry its selectors.
- **Closed CDP method set.** The adapter can send only the methods listed in
  `ALLOWED_CDP_METHODS`. `Runtime.evaluate` (arbitrary JavaScript), key events,
  `Page.navigate`, network, storage, emulation, and DOM mutation methods are
  refused before they reach the transport.
- **Trusted profiles only execute.** `slack` and `slack-local-synthetic` are
  trusted; the adapter also refuses execution for any injected untrusted
  profile.
- **Slack allowlist.** The Slack profile recognizes exactly three kinds:
  destinations (same-origin `https://app.slack.com/client/<team>/<C id>`
  channel links with no query or fragment, sidebar `treeitem` rows whose
  `data-item-key` is a channel id on the page's team, and the single
  allowlisted self-DM row), the composer (a `textbox` named `Message ...` or
  carrying Slack's locale-independent `data-qa="texty_input"`), and the send
  control (a `button` named `Send` or `Send now` or carrying
  `data-qa="texty_send_button"`, only while enabled). The self-DM exception is
  only a `treeitem` whose exact visible name is `Yasuhito Takamiya (自分)` and
  whose `data-item-key` is a D id; its same-origin client URL is derived from
  the observed D id and the current page's team, then bound by the same
  freshness, URL, and click hit-test checks as channel rows. A same-name
  channel, a decorated or similarly named person, any other D row, and D links
  are not destinations. Duplicate exact-name D rows are refused as ambiguous,
  and the existing `exactDestination` guard refuses a fallback candidate before
  any click or typing. The current Slack client renders sidebar rows without
  links, wrapped in a `draggable` element that makes Chromium leave the row's
  accessible name empty, so the name comes from the row's visible contents and
  the URL from the key. It never recognizes, so the model is never offered and
  no action can reach: other direct messages, groups, sidebar sections,
  reactions, uploads, downloads, deletion, external links, sign-in or
  sign-out, workspace or account settings, search, threads, scheduling, or
  any other control.
- **Decisions are bound to identity and freshness.** A snapshot records the
  target id, URL, and a digest of every recognized candidate. Immediately
  before any action the adapter re-observes and refuses unless the target id,
  URL, digest, and the selected element's role, name, and URL are unchanged,
  the snapshot is younger than 20 s, the element is enabled with a box inside
  the viewport, and a hit test at the click point resolves to that element.
  When already at the destination's exact URL, navigation instead re-observes
  and requires the same target id, URL, candidate digest, and chosen destination
  identity before verifying without a click. A changed page or candidate refuses
  before typing or sending. Click hit testing still applies when navigation
  needs a click.
  Before typing it additionally requires the page to be at the selected
  destination and the composer to be empty (an absent value, `""`, or exactly
  one newline U+000A counts as empty because Chromium reports that newline for
  the visually blank contenteditable composer; every other value refuses);
  before sending, the page must still be at the destination and the composer
  must still hold the text under the same paragraph-aware comparison.
- **Exact text, read back, paragraph-aware.** The text is inserted with
  `Input.insertText` (never key events) and read back from the page;
  any difference is `text_mismatch`. One canonical comparison
  (`paragraphEqual`/`paragraphLines` in `src/cdp/adapter.mjs`) serves the
  read-back, the send-time composer check, and the post verification: both
  strings are split on LF (U+000A), only the empty segments are dropped, and
  every remaining line must match exactly and in order. Only blank-line
  differences are tolerated, because a rich-text editor renders each
  paragraph as its own block and the browser's accessibility tree reads every
  block boundary as a blank line.
  Spaces, tabs, NBSP, BOM, non-empty text, line order, and the count of
  non-empty lines are never normalized. Composer emptiness still uses only
  the three representations above, and the duplicate-marker containment check
  is unchanged. After sending, the workflow waits for the composer to be
  empty again (same classification) and the text to appear on the page; the
  post verification compares the text's non-empty lines against the page's
  rendered non-empty lines in accessibility-tree order and requires them as
  one contiguous sequence within a single message container (`findText`
  `match: "sequence"`), because the real client renders each paragraph of the posted message as its own
  accessibility node and no single node carries the joined text. A missing,
  reordered, altered, or interleaved non-empty line never verifies; unnamed
  container nodes and unrelated rendered content around the message never
  break the run; otherwise the status is `unverified`.
- **Emoji images, proven, never dropped.** Slack replaces a Unicode emoji in
  the composer and in a posted message with an `<img>`, and Chromium never
  reads an image into a contenteditable's accessibility value (with any
  `alt`), so the read-back of the QA² report lacked 👤 ⚖️ 📅 and refused
  before the send click (2026-09-25). A profile may therefore supply
  `inlineText`, which proves the text an element stands for; the adapter then
  reads the editable's DOM subtree with `DOM.describeNode` (already allowed;
  no new CDP method) and reconstructs its text (`domText`: text nodes, `<br>`
  and block boundaries as LF, proven elements as their text). The read-back
  and the send-time check pass only when the subtree holds no unresolved
  element (an image or other opaque element the profile cannot prove), and,
  when it holds a proven element, the accessibility value equals the DOM text
  without the proven elements and the DOM text with them equals the caller
  text, both through `paragraphEqual`; without a proven element the
  accessibility value alone decides as before. When the accessibility
  sequence match finds no posted message, a message container whose DOM text
  holds a proven element verifies only if its canonical lines carry the text
  as one contiguous run and the run's non-emoji text also appears in the
  container's accessibility text. The Slack profile (`slackEmojiText`) proves
  an `<img>` or `data-stringify-emoji` element only for the closed
  `SLACK_EMOJI` set (`:bust_in_silhouette:` 👤, `:scales:` ⚖️, `:date:` 📅)
  when every nonempty identity field agrees: shortcode attributes (`data-id`,
  `data-stringify-text`, `data-stringify-emoji`, and a shortcode `alt`).
  No signal, disagreeing signals, an
  unknown, custom, or skin-tone shortcode, or another emoji is unproven and
  refuses (or leaves the post `unverified`); a missing, extra, changed, or
  moved emoji is a text difference like any other. The one exception is a
  localized `alt`: the ja-JP client posts
  `<img data-stringify-type="emoji" data-stringify-emoji=":scales:" alt=":天秤:">`
  (observed read-only on 2026-09-25), so a colon-wrapped `alt` of letters,
  digits, and shortcode punctuation with at least one non-ASCII character is
  skipped, not treated as an identity field, only when the element also
  carries `data-stringify-type="emoji"` and a `data-stringify-emoji` in
  `SLACK_EMOJI`. An ASCII `alt` is still an identity field that must agree,
  and a localized `alt` without that stable identity proves nothing. This is
  proven against posted-message attributes only; how the live ja-JP composer
  renders its emoji images has not been observed.
- **Caller delivery guards.** A caller may pass two extra
  deterministic guards: `exactDestination` refuses (`destination_mismatch`)
  unless the requested name is exactly the leading name of the chosen
  destination's name (decoration such as `(channel)`, `（チャンネル）`, or
  `, 3 unread` may follow; `qa2-metrics-old` never matches `qa2-metrics`),
  and `duplicateMarker` accepts one marker or a list and refuses
  (`duplicate_post`) to draft or send when the destination's currently rendered
  accessibility tree contains any marker. This duplicate check is best-effort
  defense in depth: virtualized history may omit an earlier post, and
  concurrent runs can both pass the non-atomic check. `jev-cu-report` checks
  both the current visible title and the idempotency key retained by older
  posts.
- **Never a real Slack mutation in tests or smoke.** Offline tests use a fake
  CDP session over a synthetic page model; browser tests and the live-transport
  smoke use a local synthetic page. A real Slack post requires explicit
  authorization naming the destination and content (or an approved bounded
  daily-job mandate). The QA2 data source and report calculation are
  `jev-cu-report` below; the unattended wrapper is `jev-cu-daily`.

### Modes

| Mode | Model calls | Browser actions |
| --- | --- | --- |
| `observe` | none | none; prints the recognized candidates |
| `dry-run` (default) | destination; composer and send if visible | none; prints the plan and whether it would be executable |
| `navigate` | destination | one click on the destination, URL verified; no click when the page URL already equals the destination's exactly |
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
`completed` names the last workflow stage completed (`navigate`, `draft`, `send`,
or null). `steps` lists every decision (`phase: "decide"`, with the Jev choice,
confidence, and probabilities), every action (`phase: "act"`, with the click
point, URLs, and read-back), the post verification, and in dry-run a `plan`.
When the page was already exactly at the destination, the destination step is
`phase: "verify"` with `alreadyAtDestination: true` instead of a click (the
selected row can sit under a popover, where the hit test rightly refuses).
`refusal.code` is one of:

| Code | Meaning |
| --- | --- |
| `target_not_allowed` | the page origin is outside the profile's allowed targets |
| `no_target` / `ambiguous_target` | zero or several page targets match; pass `--target` |
| `no_candidates` / `too_many_candidates` | nothing recognized, or more than `--max-candidates`, or more than 256 nodes of the profile's attribute roles to look up |
| `untrusted_profile` | execution requested under a profile that only observes |
| `unsupported_action` | the profile does not permit that action on that candidate |
| `ambiguous_identity` | two distinct candidates share the chosen label, or the hit test resolved elsewhere |
| `stale_snapshot` / `stale_target` | the decision is older than 20 s, or the session's target changed |
| `changed_state` | URL, candidate set, or the selected element changed before acting |
| `not_actionable` | the element is disabled or has no clickable box in the viewport |
| `text_mismatch` | the composer is not absent, empty, or exactly one newline, or the read-back differs from the caller text beyond paragraph blank-line differences, or holds an element (an emoji image) whose text the profile cannot prove |
| `destination_mismatch` | the page is not at the selected destination, or (with `exactDestination`) the chosen link does not name the requested destination exactly |
| `duplicate_post` | (with `duplicateMarker`) the destination already shows content carrying any marker |

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
npm run serve:synthetic-slack -- --port 8765 [--shape links|tree]
chromium --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/jev-cu-chrome \
  http://127.0.0.1:8765/client/T0SYNTH/C0GENERAL
node bin/jev-cu-browse.mjs --profile slack-local-synthetic --mode observe
```

The synthetic page is rendered from the same JSON model the fake CDP uses; it
imitates only the shapes the Slack profile cares about plus decoys the profile
must never offer, and it stores nothing. It has two shapes, and the tests
cover both: `links` (the default; an English page with `<a href>` sidebar
links, a `Message #x` composer, and a `Send now` button) and `tree` (the shape
the real Slack client rendered in 2026 for a Japanese-locale account:
`lang="ja-JP"`, `treeitem` sidebar rows with `data-item-key` and no link whose
accessible name a real Chromium computes as empty, section and direct-message
rows the profile must skip, and a composer and send button that only Slack's
`data-qa` hooks identify). Observing the `tree` shape through a real Chromium
must yield exactly the three channel rows, the composer, and the send button.
The fake CDP also models Slack's paragraph representation: the editor renders
each paragraph as its own block and Chromium reads every block boundary as a
blank line, so text typed as `p1\np2` reads back as `p1\n\np2` (a single
U+000A blank-editor artifact is passed through untouched). Posted messages can
be modeled in the same joined form (the default) or as the real client
renders them in the message list, one element per paragraph
(`splitMessages`), which is what the post verification's paragraph-sequence
comparison handles. The safety comparisons are paragraph-aware for exactly
this reason. Both the fake and the served page also turn the emoji of
`SYNTHETIC_EMOJI` into images the way Slack does (an empty-`alt` image with
`data-id`/`data-stringify-text` in the composer, a `data-stringify-emoji`
image with the ja-JP localized `alt` in a posted rich-text section), so the
composer's accessibility value lacks them and only the proven DOM reading
verifies; `👥` is a counterexample the profile cannot prove.

`test/browser-e2e.test.mjs` runs the send workflow against the served
`tree` page with the self-DM in a real headless Chromium (localhost only,
offline label decisions) and checks the 2026-09-25 refusal with
accessibility text alone, the proven send and post verification, the rendered
four-line layout, and the duplicate rerun. It is skipped unless
`JEV_CU_E2E_CHROME` names a Chromium binary (Node 22+):
`JEV_CU_E2E_CHROME=$(command -v chromium) node --test test/browser-e2e.test.mjs`.

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
| `ACCOUNT_GAMES` | `ACCOUNT_NAME`, `GAME_NAME`, `GAME_ID`, `ENVIRONMENT_NAME`, `ENVIRONMENT_ID`, `UNITY_PROJECT_ID` | resolve QA2 and its Live environment at run time; no `GAME_ID` is hard-coded |
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
`ENVIRONMENT_NAME` equal to `Live`, compared exactly and case-sensitively
(Unity names QA2's environments `Live`, `staging`, and `develop`). Zero
or several rows at any step is an error
(`game_not_found`, `ambiguous_game`, `environment_not_found`,
`ambiguous_environment`); the run never guesses.

### Definitions

All dates are UTC calendar days. With the current clock:

- **window**: the 14 complete UTC days before today, `[today - 14 days, today)`.
  The current UTC day is always excluded
  because it is still accumulating.
- **reportDate**: the last complete day, `today - 1`.
- **New users on a day**: `COUNT(DISTINCT USER_ID)` of users whose player
  start date is that day. Days with no row count 0 and are listed in
  `missingDates` for audit; the Slack message does not add a missing-row note.
- **dayBefore**: `reportDate - 1`; `delta = report - dayBefore`;
  `deltaPercent = delta / dayBefore * 100`, null when `dayBefore` is 0.
- **trailing7DayAverage**: mean of the 7 days `reportDate - 7 .. reportDate - 1`
  (the report day is not in its own baseline); delta and deltaPercent as
  above against the unrounded mean; values rounded to 1 decimal.
- **trend**: against the trailing average: `flat` when |deltaPercent| <= 5,
  otherwise `up` or `down` by sign; with a zero baseline, `up` if the day is
  positive, else `flat`.
- **idempotencyKey**: `unity-new-users:<GAME_ID>:<ENVIRONMENT_ID>:<reportDate>`.
  It remains in the typed report and CLI payload, but is no longer printed in
  Slack. The workflow checks the plain visible title as the marker for new
  posts and also checks this key to recognize posts from the previous message
  format. Both checks use the currently rendered accessibility tree, so this
  remains a best-effort duplicate defense, not durable exactly-once delivery.

Slack message (plain text, exactly four lines; no markup, source footer, or
missing-row note; identical input gives identical output). The composer posts
inserted text literally, so the message carries no `*` bold markers; the three
Unicode emoji prefixes are the only decoration:

```
QA² 新規ユーザー｜9/24（UTC）
👤 1人（前日より +1人）
⚖️ 直近7日平均 2人 より 1人少なめ（-50%）
📅 直近7日（9/18→9/24）：2 → 4 → 3 → 3 → 1 → 0 → 1人
```

Source auditability is retained in the `jev-cu-report` JSON payload's
`source` metadata and typed `report` (including `missingDates` and the full
`idempotencyKey`); the unattended wrapper continues to scrub report details
from its logs.

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
sidebar link to name it exactly, refuses if the currently rendered channel
content shows the visible report title or a legacy idempotency key, and keeps
all freshness, read-back, and post-verification guards:

```sh
node bin/jev-cu-report.mjs --mode send --destination qa2-metrics --allow-destination qa2-metrics
```

Options:

| Option | Meaning | Default |
| --- | --- | --- |
| `--mode MODE` | `dry-run`, `send` | `dry-run` |
| `--destination NAME` | Slack channel, exactly as the sidebar names it | required for send |
| `--allow-destination NAME` | exact allowlist entry; repeatable | required for send |
| `--profile`, `--cdp`, `--target`, `--min-confidence`, `--max-candidates`, `--model` | as in `jev-cu-browse` | same defaults |

### Output

Except for `--help`, one JSON object is written to stdout per run: `tool`,
`version`, `mode`, `source` (`kind`, the
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
in the SQL API encoding with the official column names, plus the official
source-side columns of the two views (`schema`); the schema compile test
resolves every identifier and binding of the generated statements against
it. The fixture data is synthetic, not a real account. Tests inject that
fixture executor and a fixed clock
through the programmatic CLI seam, so the test suite touches neither Snowflake
nor Slack.

A live read-only smoke (two `SELECT`s under process-scoped credentials, no
Slack) is outside CI. Unattended execution is wrapped by `jev-cu-daily`, which
serializes executions and adds durable per-date idempotency on top of the
rendered-page check (it alone cannot prevent duplicates from concurrent runs
or unloaded history).

## jev-cu-daily: unattended daily schedule

`jev-cu-daily` runs the QA2 report once per target date for an unattended
scheduler (a systemd timer on the deployment host). One invocation posts at
most one report, and it adds exactly the three properties a single-shot
`jev-cu-report --mode send` run cannot provide:

- **Durable per-date idempotency.** The target date is the last complete UTC
  day, computed by the report's own date rule from the run's clock (at
  10:00 JST = 01:00 UTC, that is yesterday). If
  `<state-dir>/records/<date>.json` already marks the date posted, the run
  does nothing (`already-posted`): no query, no browser. Otherwise it runs
  the report in send mode and, only when the workflow verified the send, it
  writes the record atomically (temp file + rename). Any other outcome -
  runtime error, refusal, `unverified`, `no_match`, `escalate` - writes no
  record, so a later run can resume the date without a second post: the
  workflow's duplicate-marker guard refuses to send again while this date's
  visible title or a legacy idempotency key is in the channel. A corrupt or
  unreadable record fails the run (exit 1) instead of being ignored: fail
  closed, never risk a second post.
- **Single-run exclusion.** An exclusive lock file `<state-dir>/run.lock`
  (O_EXCL create, holding pid, start instant, and the kernel boot id) is
  held for the whole run. A live run makes a second invocation skip
  immediately (`skipped-locked`, exit 0). A lock is broken only when it can
  be proven stale: it names a boot other than the current one (left over
  from before a reboot), its pid no longer exists, or it is older than the
  staleness bound (12 h, covers pid reuse). An unreadable-but-young lock is
  treated as live: its creator may still be writing it.
- **Bounded retry.** A failed attempt is retried up to `--max-attempts`
  (default 3) with exponential backoff (`--retry-base-sec` × 2^(n−1),
  default base 60 s). Two classes fail on the first attempt because no
  backoff can fix them: configuration errors (`missing_key`,
  `missing_snowflake_config`, usage, a destination outside the allowlist)
  and the `duplicate_post` refusal. The duplicate refusal is never recorded
  as success: the marker may sit in an unposted draft (the composer's text
  is part of the rendered tree), so it is not proof that a send happened.
  The run then fails with no record and a human checks the channel.

Unattended logs stay clean: the printed payload carries statuses and error
codes only - never report numbers, the message text, the destination name,
or any key - and the report's own stdout and stderr are captured and
dropped. Debugging runs `jev-cu-report` directly, by a person.

### Usage

```sh
node bin/jev-cu-daily.mjs --state-dir /var/lib/jev-cu-report
```

The unattended destination and its allowlist are both fixed to the exact
channel `qa2`; flags and environment variables cannot redirect it.

| Option | Meaning | Default |
| --- | --- | --- |
| `--state-dir DIR` | durable state directory (records + run lock); must survive reboots | required |
| `--max-attempts N` | send attempts per run, 1..10 | `3` |
| `--retry-base-sec N` | backoff base seconds, 0..3600 | `60` |
| `--dry-run` | run the report in dry-run mode, write no record (wiring check; needs no `TYPESAFE_API_KEY` or browser) | off |
| `--profile`, `--cdp`, `--target`, `--min-confidence`, `--max-candidates`, `--model` | as in `jev-cu-report` | same defaults |

`SNOWFLAKE_*` and `TYPESAFE_API_KEY` are required exactly as in
`jev-cu-report` and are read from the environment only, never printed or
stored.

### Output

One JSON object on stdout: `tool` (`jev-cu-daily`), `version`, `status`,
`mode` (`send` or `dry-run`), `targetDate`, `attempts` (per attempt: the
report's `status`, `refusalCode`, `errorCode` - codes only), and `record`
(`date`, `status: "posted"`, `postedAt`, `attempts`, `recordedAt`) when one
was written or already existed. `status` is one of `posted`,
`already-posted` (recorded date), `skipped-locked` (another run holds the
lock), `dry-run`, or `failed`. A usage error adds `error.code: "usage"`.

Exit codes: `0` for posted, already-posted, skipped-locked, and dry-run; `1`
for failed (retries exhausted or a non-retryable failure); `2` for usage
errors. `--help` prints usage on stderr and exits 0.

### Deployment (systemd)

`deploy/systemd/jev-cu-report.service` and `jev-cu-report.timer` are
templates: the marked lines are operator-specific (the checkout path, the
user, the `EnvironmentFile` holding credentials, the
state directory) and must be adapted at deployment time; no credential,
account identifier, channel name, or other deployment-specific value belongs
in the committed files. The timer fires once per day at `10:00 Asia/Tokyo`
regardless of the host's time zone (`OnCalendar=*-*-* 10:00:00
Asia/Tokyo`) and `Persistent=true` makes a boot catch up a run missed while
the host was down; the per-date record makes that catch-up idempotent.

Deployment checklist (each step is a separate, explicitly authorized
operation; none of it is automated by this repository):

1. Provision the host user, checkout, and state directory; create the
   `EnvironmentFile` (mode 600) with the Snowflake and TypeSafe credentials;
   start Chrome with remote debugging signed
   in to the workspace.
2. Verify without posting: run the service once by hand in `--dry-run` (the
   report's dry-run needs no key and no browser), then confirm the timer's
   next elapse with `systemctl list-timers`.
3. Enabling the timer and the first real send require the operator's
   explicit approval of the content and the destination.

### Tests

`npm test` covers the wrapper end to end offline: the fixture executor and
the fake CDP session over the synthetic page (post, record, second-run skip,
duplicate refusal, unverified retries, the composer latch, concurrent runs
under the real lock), the state machinery against a temporary directory
(atomic records, corrupt-record failure, boot-id/pid/age staleness), and the
CLI contract including `--help` and usage errors through the committed bin.
No network, no Slack, no secrets.
