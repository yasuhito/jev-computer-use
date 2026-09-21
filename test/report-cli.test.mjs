import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runCli, parseArgs, assertAllowlisted } from "../bin/jev-cu-report.mjs";
import { createFakeCdp } from "./fake-cdp.mjs";
import { decideByLabel, fakeClock } from "./helpers.mjs";
import { loadFixtureExecutor } from "../src/snowflake/executor.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/unity-data-access.json", import.meta.url));
const FIXTURE_ARGS = ["--source", "fixture", "--fixture", FIXTURE, "--now", "2026-09-21T09:00:00Z"];
const KEY = "unity-new-users:24601:31001:2026-09-20";
const SEND_FLOW = [/^qa2-metrics/, /^Message #qa2-metrics/, /^Send now/];

/**
 * @param {string[]} argv
 * @param {Partial<Parameters<typeof runCli>[0]>} [overrides]
 */
function captureIo(argv, overrides = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const fake = createFakeCdp();
  const clock = fakeClock();
  return {
    io: {
      argv,
      stdout: { write: (/** @type {string} */ c) => out.push(c) },
      stderr: { write: (/** @type {string} */ c) => err.push(c) },
      env: {},
      connect: async () => fake.session,
      now: clock.now,
      sleep: clock.sleep,
      settleMs: 500,
      ...overrides,
    },
    fake,
    out,
    err,
    json: () => JSON.parse(out.join("")),
  };
}

test("parseArgs defaults to a snowflake dry-run and validates every flag", () => {
  const o = parseArgs([]);
  assert.equal(o.source, "snowflake");
  assert.equal(o.mode, "dry-run");
  assert.equal(o.game, "QA2");
  assert.equal(o.environment, "production");
  assert.equal(o.days, 14);
  assert.equal(o.seriesDays, 7);
  assert.equal(o.now, null);
  assert.equal(parseArgs(["--now", "2026-09-21T09:00:00Z"]).now, Date.parse("2026-09-21T09:00:00Z"));
  assert.deepEqual(parseArgs(["--mode", "send", "--destination", "a", "--allow-destination", "a", "--allow-destination", "b"]).allowDestinations, ["a", "b"]);
  assert.throws(() => parseArgs(["--source", "fixture"]), /requires --fixture/);
  assert.throws(() => parseArgs(["--fixture", "x.json"]), /only valid with --source fixture/);
  assert.throws(() => parseArgs(["--days", "7"]), /8\.\.90/);
  assert.throws(() => parseArgs(["--days", "8", "--series-days", "9"]), /may not exceed/);
  assert.throws(() => parseArgs(["--now", "2026-09-21"]), /ISO-8601 instant/);
  assert.throws(() => parseArgs(["--now", "2026-09-21T09:00:00"]), /ISO-8601 instant/);
  assert.throws(() => parseArgs(["--mode", "send", "--destination", "a"]), /requires at least one --allow-destination/);
  assert.throws(() => parseArgs(["--mode", "send", "--allow-destination", "a"]), /requires --destination/);
  assert.throws(() => parseArgs(["--mode", "observe"]), /--mode must be one of/);
  assert.throws(() => parseArgs(["--post"]), /unknown option/);
});

test("the destination allowlist is exact", () => {
  assert.equal(assertAllowlisted("qa2-metrics", ["general", "qa2-metrics"]), "qa2-metrics");
  assert.equal(assertAllowlisted("  qa2-metrics ", ["qa2-metrics"]), "qa2-metrics");
  for (const [destination, allow] of [
    ["qa2-metrics", ["qa2-metric"]],
    ["qa2-metrics", ["QA2-metrics"]],
    ["qa2-metrics-old", ["qa2-metrics"]],
    ["qa2-metrics", []],
  ]) {
    assert.throws(() => assertAllowlisted(String(destination), /** @type {string[]} */ (allow)), /not in the exact allowlist/);
  }
});

test("dry-run against the fixture prints the typed report and the exact message, touching no browser", async () => {
  let connected = false;
  const c = captureIo(FIXTURE_ARGS, {
    connect: async () => {
      connected = true;
      throw new Error("must not connect");
    },
  });
  assert.equal(await runCli(c.io), 0);
  const payload = c.json();
  assert.equal(payload.tool, "jev-cu-report");
  assert.equal(payload.status, "dry-run");
  assert.equal(payload.send, null);
  assert.equal(payload.source.kind, "fixture");
  assert.equal(payload.report.kind, "unity-analytics-new-users-daily");
  assert.equal(payload.report.reportDate, "2026-09-20");
  assert.equal(payload.report.previousDay.newUsers, 1234);
  assert.equal(payload.report.game.gameId, 24601);
  assert.equal(payload.report.idempotencyKey, KEY);
  assert.equal(payload.delivery.duplicateMarker, KEY);
  assert.match(payload.message, /^QA2 new users \(production\) for 2026-09-20 \(UTC\)\n/);
  assert.ok(payload.message.endsWith(`key: ${KEY}`));
  assert.equal(connected, false);
  assert.equal(c.err.join(""), "");
});

test("dry-run needs neither TYPESAFE_API_KEY nor a browser, and accepts a destination only when allowlisted", async () => {
  const ok = captureIo([...FIXTURE_ARGS, "--destination", "qa2-metrics", "--allow-destination", "qa2-metrics"]);
  assert.equal(await runCli(ok.io), 0);
  assert.equal(ok.json().delivery.destination, "qa2-metrics");
  const bad = captureIo([...FIXTURE_ARGS, "--destination", "general", "--allow-destination", "qa2-metrics"]);
  assert.equal(await runCli(bad.io), 2);
  assert.equal(bad.json().error.code, "destination_not_allowed");
});

test("the snowflake source without configuration fails with exit 1 and no value echo", async () => {
  const c = captureIo(["--now", "2026-09-21T09:00:00Z"], { env: { SNOWFLAKE_ACCOUNT: "acct" } });
  assert.equal(await runCli(c.io), 1);
  assert.equal(c.json().error.code, "missing_snowflake_config");
  assert.match(c.json().error.message, /SNOWFLAKE_USER/);
  assert.doesNotMatch(c.out.join(""), /acct/);
  assert.equal(c.err.join(""), "");
});

test("send mode without TYPESAFE_API_KEY exits 1 before any query or connection", async () => {
  let queried = 0;
  const executor = { kind: "probe", execute: async () => ((queried += 1), { columns: [], rows: [] }) };
  let connected = false;
  const c = captureIo([...FIXTURE_ARGS, "--mode", "send", "--destination", "qa2-metrics", "--allow-destination", "qa2-metrics"], {
    executor,
    connect: async () => {
      connected = true;
      throw new Error("must not connect");
    },
  });
  assert.equal(await runCli(c.io), 1);
  assert.equal(c.json().error.code, "missing_key");
  assert.equal(queried, 0);
  assert.equal(connected, false);
});

test("data conditions map to exit 1 with the data-access code", async () => {
  const empty = { kind: "probe", execute: async () => ({ columns: [{ name: "GAME_NAME", type: "TEXT" }], rows: [] }) };
  const c = captureIo(FIXTURE_ARGS, { executor: empty });
  assert.equal(await runCli(c.io), 1);
  assert.equal(c.json().error.code, "game_not_found");
  const other = captureIo([...FIXTURE_ARGS, "--environment", "staging"]);
  assert.equal(await runCli(other.io), 1);
  assert.equal(other.json().error.code, "environment_not_found");
  assert.deepEqual(other.json().details.environmentsSeen, ["development", "production"]);
});

test("send mode posts the exact rendered message through the bounded workflow and verifies it", async () => {
  const executor = await loadFixtureExecutor(FIXTURE);
  const c = captureIo([...FIXTURE_ARGS, "--mode", "send", "--destination", "qa2-metrics", "--allow-destination", "qa2-metrics"], {
    executor,
    decide: decideByLabel(SEND_FLOW),
  });
  assert.equal(await runCli(c.io), 0);
  const payload = c.json();
  assert.equal(payload.status, "executed");
  assert.equal(payload.send.completed, "send");
  assert.equal(payload.send.mode, "send");
  assert.deepEqual(c.fake.currentMessages(), [payload.message]);
  assert.ok(payload.message.includes(KEY));
  const duplicateStep = payload.send.steps.find((/** @type {{step: string}} */ s) => s.step === "duplicate");
  assert.deepEqual(duplicateStep, { step: "duplicate", phase: "verify", marker: KEY, found: 0 });
  assert.equal(c.fake.state.disconnected, true);
  assert.deepEqual(executor.calls.map((s) => s.name), ["account_games", "new_users_by_start_date"]);
});

test("send mode refuses a second post for the same report day without touching the composer", async () => {
  const c = captureIo([...FIXTURE_ARGS, "--mode", "send", "--destination", "qa2-metrics", "--allow-destination", "qa2-metrics"], {
    decide: decideByLabel(SEND_FLOW),
  });
  c.fake.state.messages.set("/client/T0SYNTH/C0QA2METRICS", [`QA2 new users (production) for 2026-09-20 (UTC)\n... key: ${KEY}`]);
  assert.equal(await runCli(c.io), 0);
  const payload = c.json();
  assert.equal(payload.status, "refused");
  assert.equal(payload.send.refusal.code, "duplicate_post");
  assert.equal(payload.send.completed, "navigate");
  assert.equal(c.fake.methodCalls("Input.insertText").length, 0);
  assert.equal(c.fake.currentMessages().length, 1);
});

test("send mode refuses when the chosen destination is not named exactly as requested", async () => {
  // Jev picks "qa2-metrics (channel)" for a prefix of it; code refuses because
  // "qa2-metric" is not the link's leading name.
  const c = captureIo([...FIXTURE_ARGS, "--mode", "send", "--destination", "qa2-metric", "--allow-destination", "qa2-metric"], {
    decide: decideByLabel(SEND_FLOW),
  });
  assert.equal(await runCli(c.io), 0);
  const payload = c.json();
  assert.equal(payload.status, "refused");
  assert.equal(payload.send.refusal.code, "destination_mismatch");
  assert.equal(payload.send.completed, null);
  assert.equal(c.fake.clicks().length, 0);
  assert.deepEqual(c.fake.currentMessages(), []);
});

test("draft mode leaves the exact message in the composer and never sends", async () => {
  const c = captureIo([...FIXTURE_ARGS, "--mode", "draft", "--destination", "qa2-metrics", "--allow-destination", "qa2-metrics"], {
    decide: decideByLabel([/^qa2-metrics/, /^Message #qa2-metrics/]),
  });
  assert.equal(await runCli(c.io), 0);
  const payload = c.json();
  assert.equal(payload.status, "executed");
  assert.equal(payload.send.completed, "draft");
  assert.equal(c.fake.currentDraft(), payload.message);
  assert.deepEqual(c.fake.currentMessages(), []);
});

test("--help exits 0 and usage errors exit 2 with a JSON error", async () => {
  const help = captureIo(["--help"]);
  assert.equal(await runCli(help.io), 0);
  assert.ok(help.err.join("").includes("Usage: jev-cu-report"));
  const bad = captureIo(["--mode", "send"]);
  assert.equal(await runCli(bad.io), 2);
  assert.equal(bad.json().error.code, "usage");
});
