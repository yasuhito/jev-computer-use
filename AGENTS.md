# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## jev-computer-use

- Scope is slices: the only slice so far is the read-only `jev-cu` CLI (Jev picks a UI candidate or no_match; confidence policy stays in code; nothing is ever executed). Later slices add execution, adapters, and app integrations - keep read-only guarantees when touching `jev-cu`.
- Run offline checks with `npm run lint && npm run typecheck && npm test` (node --test with an injected fake decision dependency, no network; tsc --noEmit over JSDoc types). `.github/workflows/ci.yml` runs the same three checks via `npm ci` on Node 20 and 22 and never calls the real API. A real smoke call needs `TYPESAFE_API_KEY` in the environment; never print, persist, or commit it, and read it only from the environment.
- CLI contract (one JSON object on stdout, statuses selected/no_match/escalate/error, exit codes 0/1/2) is documented in README.md; keep README and code in sync when changing it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
