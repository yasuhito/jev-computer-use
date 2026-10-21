#!/usr/bin/env node
/**
 * jev-cu-daily: the unattended daily wrapper for the QA2 New Users report.
 * One invocation posts at most one report for the target date (the last
 * complete UTC day). Immediately before the send click it writes a durable
 * attempt marker; later runs skip that date. Verified posts become `posted`
 * records; completed sends with visible markers but failed post verification
 * become `posted_unverified` records. Uncertain attempts are never retried
 * automatically. Duplicate detection checks message containers, not drafts.
 * It is designed for a daily systemd timer
 * (deploy/systemd/) and never prints report numbers, message text, destination
 * names, or keys.
 *
 * Exit codes: 0 posted, already-posted, skipped-locked, or dry-run;
 * 1 posted_unverified, already-posted-unverified, already-attempted, uncertain,
 * or failed; 2 usage error.
 */
import { pathToFileURL } from "node:url";
import { runDailyJob } from "../src/schedule/daily.mjs";

const TOOL = "jev-cu-daily";

const isMain = (() => {
  if (typeof process === "undefined") return false;
  const scriptArg = process.argv[1];
  return scriptArg !== undefined && import.meta.url === pathToFileURL(scriptArg).href;
})();
if (isMain) {
  runDailyJob({ argv: process.argv.slice(2) }).then(
    ({ code, payload }) => {
      if (payload !== null) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${TOOL}: unexpected failure: ${err?.stack ?? String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
