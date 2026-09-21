# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## jev-computer-use

- Scope is slices. Slice 1 is the read-only `jev-cu` CLI (Jev picks a UI candidate or no_match; confidence policy stays in code; nothing is executed); keep its contract and read-only guarantees intact. Slice 2 is `jev-cu-browse`: a generic `CdpAdapter` (`src/cdp/`) plus thin profiles (`src/profiles/`) and the workflow (`src/workflow.mjs`). Keep application knowledge (selectors, names, allowlists) out of the adapter, transport, and workflow; `test/profiles.test.mjs` fails if they mention Slack. New CDP methods go into `ALLOWED_CDP_METHODS` only with a safety reason; arbitrary JavaScript, key events, and navigation methods stay out.
- Run offline checks with `npm run lint && npm run typecheck && npm test` (node --test with an injected fake decision dependency and a fake CDP session over `test/fixtures/synthetic-slack-page.json`, no network; tsc --noEmit over JSDoc types). `.github/workflows/ci.yml` runs the same three checks via `npm ci` on Node 20 and 22 and never calls the real API. A real Jev call needs `TYPESAFE_API_KEY` in the environment; never print, persist, or commit it, and read it only from the environment. A live CDP smoke uses `scripts/serve-synthetic-slack.mjs` plus a local Chrome (README "Tests and the synthetic page"); never point tests or smoke at a real Slack workspace.
- Both CLI contracts (one JSON object on stdout, statuses, refusal codes, exit codes 0/1/2) are documented in README.md; keep README and code in sync when changing them.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
