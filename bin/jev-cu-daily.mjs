#!/usr/bin/env node
/**
 * jev-cu-daily: the unattended daily wrapper for the QA2 New Users report.
 * One invocation posts at most one report for the target date (the last
 * complete UTC day): it skips a recorded date, runs jev-cu-report --mode
 * send (or dry-run) with bounded retries under an exclusive run lock, and
 * writes a durable record only after the send was verified - or after the
 * report's own duplicate marker was found in the channel, which is evidence
 * that a verified send for this date already happened. It is designed for a
 * daily systemd timer (deploy/systemd/); it never retries past its bound and
 * never prints report numbers, message text, destination names, or keys.
 *
 * Exit codes: 0 posted, already-posted, skipped-locked, or dry-run;
 * 1 failed (including retries exhausted and non-retryable failures);
 * 2 usage error.
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
