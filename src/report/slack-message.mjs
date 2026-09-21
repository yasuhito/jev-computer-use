/**
 * Deterministic Slack message text for a NewUsersReport. Plain text (no
 * mrkdwn markup, no mentions, no links), so what is inserted into the
 * composer is exactly what the read-back and post verification compare.
 * The idempotency key is part of the text so a later run can recognize the
 * post. Same report in, same string out; formatting has no locale input.
 */

/** @typedef {import("./new-users.mjs").NewUsersReport} NewUsersReport */

export const DEFAULT_SERIES_DAYS = 7;
export const SOURCE_LABEL = "Unity Analytics Data Access (Snowflake)";

/**
 * @param {number} n integer or 1-decimal number
 * @returns {string} thousands separated with ","
 */
export function formatNumber(n) {
  if (!Number.isFinite(n)) throw new Error("cannot format a non-finite number");
  const negative = n < 0;
  const [whole = "0", fraction] = Math.abs(n).toString().split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/**
 * @param {number} delta
 * @returns {string} always signed, "+0" for zero
 */
export function formatDelta(delta) {
  return delta < 0 ? formatNumber(delta) : `+${formatNumber(delta)}`;
}

/**
 * @param {number|null} percent
 * @returns {string}
 */
export function formatPercent(percent) {
  if (percent === null) return "n/a";
  return `${formatDelta(percent)}%`;
}

/**
 * @param {NewUsersReport} report
 * @param {{seriesDays?: number}} [options]
 * @returns {string}
 */
export function renderSlackMessage(report, { seriesDays = DEFAULT_SERIES_DAYS } = {}) {
  if (!Number.isInteger(seriesDays) || seriesDays < 1 || seriesDays > report.series.length) {
    throw new Error(`seriesDays must be an integer in 1..${report.series.length}`);
  }
  const { game, comparison } = report;
  const day = comparison.dayBefore;
  const avg = comparison.trailing7DayAverage;
  const tail = report.series.slice(-seriesDays);
  const series = tail.map((p) => `${p.date.slice(5)} ${formatNumber(p.newUsers)}`).join(" | ");
  const lines = [
    `${game.gameName} new users (${game.environmentName}) for ${report.reportDate} (UTC)`,
    `New users on ${report.reportDate}: ${formatNumber(report.previousDay.newUsers)}`,
    `vs ${day.date} (${formatNumber(day.baseline)}): ${formatDelta(day.delta)} (${formatPercent(day.deltaPercent)})`,
    `vs trailing ${avg.days}-day avg ${avg.from}..${avg.to} (${formatNumber(avg.baseline)}): ${formatDelta(avg.delta)} (${formatPercent(avg.deltaPercent)}), trend: ${comparison.trend}`,
    `Last ${tail.length} days (UTC): ${series}`,
  ];
  if (report.missingDates.length > 0) {
    lines.push(`Days with no rows (counted as 0): ${report.missingDates.join(", ")}`);
  }
  lines.push(`Source: ${SOURCE_LABEL} | key: ${report.idempotencyKey}`);
  return lines.join("\n");
}
