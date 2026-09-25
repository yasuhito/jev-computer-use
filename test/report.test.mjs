import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { completeUtcWindow, addDays, datesBetween, isIsoDate, utcDateOf, MIN_WINDOW_DAYS } from "../src/report/dates.mjs";
import {
  resolveGameEnvironment,
  fetchNewUsersByStartDate,
  accountGamesStatement,
  newUsersByStartDateStatement,
  ACCOUNT_GAMES_STATEMENT,
  NEW_USERS_BY_START_DATE_STATEMENT,
  DataAccessError,
} from "../src/unity/data-access.mjs";
import { buildNewUsersReport, compare, classifyTrend, round, idempotencyKey, FLAT_BAND_PERCENT } from "../src/report/new-users.mjs";
import { renderSlackMessage, slackMessageDuplicateMarker, formatNumber, formatDelta, formatPercent } from "../src/report/slack-message.mjs";
import { createFixtureExecutor, loadFixtureExecutor, assertReadOnlyStatement } from "../src/snowflake/executor.mjs";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/unity-data-access.json", import.meta.url));
const NOW = Date.parse("2026-09-21T09:00:00Z");

const GAME = { accountName: "Synthetic Studio", gameName: "QA2", gameId: 24601, environmentName: "Live", environmentId: 31001, unityProjectId: null, environmentsSeen: ["Live"] };

/**
 * @param {Array<[string, number]>} points
 * @param {number} [days]
 */
function reportFrom(points, days = 8, now = NOW) {
  const window = completeUtcWindow(now, days);
  return buildNewUsersReport({ game: GAME, window, rows: points.map(([date, newUsers]) => ({ date, newUsers })), generatedAt: new Date(now).toISOString() });
}

/* ----------------------------- dates ----------------------------- */

test("the report window holds only complete UTC days and always excludes today", () => {
  const window = completeUtcWindow(NOW, 14);
  assert.deepEqual(window, { start: "2026-09-07", end: "2026-09-21", days: 14, reportDate: "2026-09-20" });
  // 23:59:59 UTC still belongs to the 21st; the next second flips the window.
  assert.equal(completeUtcWindow(Date.parse("2026-09-21T23:59:59Z"), 8).reportDate, "2026-09-20");
  assert.equal(completeUtcWindow(Date.parse("2026-09-22T00:00:00Z"), 8).reportDate, "2026-09-21");
  assert.throws(() => completeUtcWindow(NOW, MIN_WINDOW_DAYS - 1), /8\.\.90/);
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.deepEqual(datesBetween("2026-09-19", "2026-09-21"), ["2026-09-19", "2026-09-20"]);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("2026-9-1"), false);
  assert.equal(utcDateOf(Date.parse("2026-09-21T00:00:00+09:00")), "2026-09-20");
});

/* ----------------------------- data access ----------------------------- */

test("statements are read-only, bound positionally, and resolve the game by name rather than a hard-coded id", () => {
  assert.equal(assertReadOnlyStatement(ACCOUNT_GAMES_STATEMENT), ACCOUNT_GAMES_STATEMENT);
  assert.equal(assertReadOnlyStatement(NEW_USERS_BY_START_DATE_STATEMENT), NEW_USERS_BY_START_DATE_STATEMENT);
  assert.match(ACCOUNT_GAMES_STATEMENT, /FROM ACCOUNT_GAMES/);
  assert.match(ACCOUNT_GAMES_STATEMENT, /WHERE GAME_NAME = \?/);
  assert.match(NEW_USERS_BY_START_DATE_STATEMENT, /COUNT\(DISTINCT USER_ID\) AS NEW_USERS/);
  assert.match(NEW_USERS_BY_START_DATE_STATEMENT, /START_DATE AS PLAYER_START_DATE/);
  assert.match(NEW_USERS_BY_START_DATE_STATEMENT, /GROUP BY START_DATE/);
  assert.doesNotMatch(NEW_USERS_BY_START_DATE_STATEMENT, /\d{4}-\d{2}-\d{2}|24601/);
  assert.deepEqual(accountGamesStatement("QA2").bindings, [{ type: "TEXT", value: "QA2" }]);
  assert.deepEqual(newUsersByStartDateStatement({ gameId: 24601, environmentId: 31001, start: "2026-09-07", end: "2026-09-21" }).bindings, [
    { type: "FIXED", value: "24601" },
    { type: "FIXED", value: "31001" },
    { type: "TEXT", value: "2026-09-07" },
    { type: "TEXT", value: "2026-09-21" },
  ]);
  assert.throws(() => newUsersByStartDateStatement({ gameId: 1.5, environmentId: 1, start: "2026-09-07", end: "2026-09-21" }));
});

test("resolveGameEnvironment selects exactly the Live row of the named game", async () => {
  const executor = await loadFixtureExecutor(FIXTURE_PATH);
  const game = await resolveGameEnvironment(executor);
  assert.deepEqual(game, {
    accountName: "Synthetic Studio",
    gameName: "QA2",
    gameId: 24601,
    environmentName: "Live",
    environmentId: 31001,
    unityProjectId: "00000000-0000-4000-8000-000000000002",
    environmentsSeen: ["development", "Live"],
  });
  // ENVIRONMENT_NAME is matched exactly: a lowercase "live" is not the Live environment.
  await assert.rejects(
    resolveGameEnvironment(executor, { environmentName: "live" }),
    (/** @type {DataAccessError} */ err) => err instanceof DataAccessError && err.code === "environment_not_found",
  );
  assert.equal(executor.calls[0]?.name, "account_games");
});

const GAMES_COLUMNS = [
  { name: "ACCOUNT_NAME", type: "TEXT" },
  { name: "GAME_NAME", type: "TEXT" },
  { name: "GAME_ID", type: "FIXED" },
  { name: "ENVIRONMENT_NAME", type: "TEXT" },
  { name: "ENVIRONMENT_ID", type: "FIXED" },
  { name: "UNITY_PROJECT_ID", type: "TEXT" },
];

/** @param {Array<Array<string|null>>} rows */
const gamesExecutor = (rows) => createFixtureExecutor({ results: { account_games: { columns: GAMES_COLUMNS, rows } } });

test("resolveGameEnvironment fails closed on missing, ambiguous, or wrong-environment data", async () => {
  /** @param {string} code @param {Promise<unknown>} p */
  const expectCode = (code, p) => assert.rejects(p, (/** @type {DataAccessError} */ err) => err instanceof DataAccessError && err.code === code);
  await expectCode("game_not_found", resolveGameEnvironment(gamesExecutor([])));
  // Exact name match is repeated in code even though SQL already filtered.
  await expectCode("game_not_found", resolveGameEnvironment(gamesExecutor([["A", "qa2", "1", "Live", "2", null]])));
  await expectCode(
    "ambiguous_game",
    resolveGameEnvironment(gamesExecutor([["A", "QA2", "1", "Live", "2", null], ["A", "QA2", "9", "Live", "3", null]])),
  );
  await expectCode("environment_not_found", resolveGameEnvironment(gamesExecutor([["A", "QA2", "1", "development", "2", null]])));
  await expectCode(
    "ambiguous_environment",
    resolveGameEnvironment(gamesExecutor([["A", "QA2", "1", "Live", "2", null], ["A", "QA2", "1", "Live", "3", null]])),
  );
  await expectCode("invalid_row", resolveGameEnvironment(gamesExecutor([["A", "QA2", null, "Live", "2", null]])));
  await expectCode("invalid_name", resolveGameEnvironment(gamesExecutor([]), { gameName: " QA2" }));
  await expectCode("invalid_name", resolveGameEnvironment(gamesExecutor([]), { environmentName: "prod\u0007" }));
});

test("fetchNewUsersByStartDate validates and sorts rows and rejects data outside the window", async () => {
  const executor = await loadFixtureExecutor(FIXTURE_PATH);
  const rows = await fetchNewUsersByStartDate(executor, { gameId: 24601, environmentId: 31001, start: "2026-09-07", end: "2026-09-21" });
  assert.equal(rows.length, 13);
  assert.deepEqual(rows[0], { date: "2026-09-07", newUsers: 1100 });
  assert.deepEqual(rows[12], { date: "2026-09-20", newUsers: 1234 });
  const columns = [
    { name: "PLAYER_START_DATE", type: "DATE" },
    { name: "NEW_USERS", type: "FIXED" },
  ];
  /** @param {Array<Array<string|null>>} data */
  const withRows = (data) =>
    fetchNewUsersByStartDate(createFixtureExecutor({ results: { new_users_by_start_date: { columns, rows: data } } }), {
      gameId: 1,
      environmentId: 2,
      start: "2026-09-13",
      end: "2026-09-21",
    });
  await assert.rejects(withRows([["20716", "5"], ["20716", "6"]]), /repeat the date/);
  await assert.rejects(withRows([["20717", "5"]]), (/** @type {DataAccessError} */ err) => err.code === "unexpected_row");
  await assert.rejects(withRows([["20716", "-1"]]), /negative/);
  await assert.rejects(withRows([[null, "1"]]), /no PLAYER_START_DATE/);
  assert.deepEqual(await withRows([["20716", "5"], ["20710", "3"]]), [
    { date: "2026-09-14", newUsers: 3 },
    { date: "2026-09-20", newUsers: 5 },
  ]);
});

/* ----------------------------- report arithmetic ----------------------------- */

test("the report zero-fills missing days and defines every comparison once", () => {
  const report = reportFrom([
    ["2026-09-13", 100],
    ["2026-09-14", 100],
    ["2026-09-15", 100],
    ["2026-09-16", 100],
    ["2026-09-17", 100],
    ["2026-09-18", 100],
    ["2026-09-19", 80],
    ["2026-09-20", 120],
  ]);
  assert.equal(report.reportDate, "2026-09-20");
  assert.deepEqual(report.previousDay, { date: "2026-09-20", newUsers: 120 });
  assert.equal(report.series.length, 8);
  assert.deepEqual(report.missingDates, []);
  assert.deepEqual(report.comparison.dayBefore, { date: "2026-09-19", baseline: 80, delta: 40, deltaPercent: 50 });
  // Baseline is the seven days 09-13..09-19: (6 * 100 + 80) / 7 = 97.142...
  assert.deepEqual(report.comparison.trailing7DayAverage, { from: "2026-09-13", to: "2026-09-19", days: 7, baseline: 97.1, delta: 22.9, deltaPercent: 23.5 });
  assert.equal(report.comparison.trend, "up");
  assert.equal(report.idempotencyKey, "unity-new-users:24601:31001:2026-09-20");
  assert.equal(idempotencyKey(GAME, "2026-09-20"), report.idempotencyKey);

  const sparse = reportFrom([["2026-09-20", 7]]);
  assert.equal(sparse.missingDates.length, 7);
  assert.equal(sparse.series.filter((p) => p.newUsers === 0).length, 7);
  assert.deepEqual(sparse.comparison.dayBefore, { date: "2026-09-19", baseline: 0, delta: 7, deltaPercent: null });
  assert.equal(sparse.comparison.trailing7DayAverage.deltaPercent, null);
  assert.equal(sparse.comparison.trend, "up");
  assert.equal(reportFrom([]).comparison.trend, "flat");
});

test("trend uses the flat band around the trailing average and rounding never yields -0", () => {
  assert.equal(classifyTrend(105, 100), "flat");
  assert.equal(classifyTrend(95, 100), "flat");
  assert.equal(classifyTrend(106, 100), "up");
  assert.equal(classifyTrend(94, 100), "down");
  assert.equal(classifyTrend(0, 0), "flat");
  assert.equal(classifyTrend(1, 0), "up");
  assert.equal(FLAT_BAND_PERCENT, 5);
  assert.deepEqual(compare(10, 10), { baseline: 10, delta: 0, deltaPercent: 0 });
  assert.equal(Object.is(round(-0.04), -0), false);
  assert.equal(round(2.345, 2), 2.35);
});

test("the report builder rejects rows outside its window and inconsistent windows", () => {
  assert.throws(() => reportFrom([["2026-09-21", 1]]), /outside the window/);
  assert.throws(() => reportFrom([["2026-09-20", 1], ["2026-09-20", 2]]), /duplicate row/);
  const window = completeUtcWindow(NOW, 8);
  assert.throws(() => buildNewUsersReport({ game: GAME, window: { ...window, reportDate: "2026-09-19" }, rows: [], generatedAt: "x" }), /day before the window end/);
});

/* ----------------------------- message ----------------------------- */

test("the Slack message matches the approved four-line QA² example exactly", () => {
  const report = reportFrom(
    [
      ["2026-09-17", 1],
      ["2026-09-18", 2],
      ["2026-09-19", 4],
      ["2026-09-20", 3],
      ["2026-09-21", 3],
      ["2026-09-22", 1],
      ["2026-09-23", 0],
      ["2026-09-24", 1],
    ],
    8,
    Date.parse("2026-09-25T09:00:00Z"),
  );
  const message = renderSlackMessage(report);
  assert.equal(
    message,
    [
      "*QA² 新規ユーザー｜9/24（UTC）*",
      "👤 *1人*（前日より *+1人*）",
      "⚖️ 直近7日平均 *2人* より *1人少なめ*（-50%）",
      "📅 直近7日（9/18→9/24）：*2 → 4 → 3 → 3 → 1 → 0 → 1人*",
    ].join("\n"),
  );
  assert.equal(renderSlackMessage(report), message);
  assert.equal(slackMessageDuplicateMarker(report), "QA² 新規ユーザー｜9/24（UTC）");
  assert.equal(report.missingDates.length, 0);
  assert.throws(() => renderSlackMessage(report, { seriesDays: 15 }), /1\.\.8/);
  assert.doesNotMatch(message, /<@|<#|https?:\/\/|unity-new-users|Snowflake|no rows/i);
});

test("the Slack comparison copy preserves positive, equal, negative, and zero-baseline semantics", () => {
  const now = Date.parse("2026-09-25T09:00:00Z");
  /** @param {number} lastValue @returns {Array<[string, number]>} */
  const points = (lastValue) => [
    ["2026-09-17", 2],
    ["2026-09-18", 2],
    ["2026-09-19", 2],
    ["2026-09-20", 2],
    ["2026-09-21", 2],
    ["2026-09-22", 2],
    ["2026-09-23", 2],
    ["2026-09-24", lastValue],
  ];
  assert.match(renderSlackMessage(reportFrom(points(3), 8, now)), /⚖️ 直近7日平均 \*2人\* より \*1人多め\*（\+50%）/);
  assert.match(renderSlackMessage(reportFrom(points(2), 8, now)), /⚖️ 直近7日平均 \*2人\* と \*同じ\*（\+0%）/);
  const zeroBaseline = renderSlackMessage(reportFrom([["2026-09-24", 1]], 8, now));
  assert.match(zeroBaseline, /⚖️ 直近7日平均 \*0人\* より \*1人多め\*/);
  assert.doesNotMatch(zeroBaseline.split("\n")[2] ?? "", /%/);
  assert.match(zeroBaseline, /前日より \*\+1人\*/);
});

test("number formatting is locale-free and always signs deltas", () => {
  assert.equal(formatNumber(1234567), "1,234,567");
  assert.equal(formatNumber(1035.4), "1,035.4");
  assert.equal(formatNumber(-56), "-56");
  assert.equal(formatNumber(0), "0");
  assert.equal(formatDelta(0), "+0");
  assert.equal(formatDelta(-3.5), "-3.5");
  assert.equal(formatPercent(null), "n/a");
  assert.equal(formatPercent(-12.5), "-12.5%");
  assert.throws(() => formatNumber(Number.NaN));
});
