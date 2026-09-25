/**
 * Deterministic Slack text for a NewUsersReport: exactly four plain lines, no
 * markup, mentions, links, or audit footer. The Slack composer posts inserted
 * text literally, so bold markers such as `*` would appear as raw characters;
 * the only non-ASCII decoration is the three Unicode emoji line prefixes. The report source and full idempotency key
 * remain in the CLI payload; duplicate checks use the visible title plus the
 * legacy key for posts created by earlier versions. Same report in, same
 * string out; formatting has no locale input.
 */

/** @typedef {import("./new-users.mjs").NewUsersReport} NewUsersReport */

export const DEFAULT_SERIES_DAYS = 7;

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
 * Render an ISO calendar date as month/day without leading zeroes. This uses
 * the date's existing UTC calendar components rather than reparsing an instant.
 * @param {string} date
 * @returns {string}
 */
function formatShortDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`invalid report date: ${date}`);
  return `${Number(match[2])}/${Number(match[3])}`;
}

/**
 * The rendered title is also the new-message duplicate marker: it is exactly
 * the first Slack line.
 * @param {NewUsersReport} report
 * @returns {string}
 */
export function slackMessageDuplicateMarker(report) {
  const gameName = report.game.gameName === "QA2" ? "QA²" : report.game.gameName;
  return `${gameName} 新規ユーザー｜${formatShortDate(report.reportDate)}（UTC）`;
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
  const { comparison } = report;
  const day = comparison.dayBefore;
  const avg = comparison.trailing7DayAverage;
  const tail = report.series.slice(-seriesDays);
  const firstDay = tail[0];
  const lastDay = tail.at(-1);
  if (!firstDay || !lastDay) throw new Error("report series must not be empty");
  const series = tail.map((p) => formatNumber(p.newUsers)).join(" → ");
  const averageComparison =
    avg.delta > 0
      ? `${formatNumber(avg.delta)}人多め`
      : avg.delta < 0
        ? `${formatNumber(Math.abs(avg.delta))}人少なめ`
        : "同じ";
  const averageRelation = avg.delta === 0 ? "と" : "より";
  const averagePercent = avg.deltaPercent === null ? "" : `（${formatPercent(avg.deltaPercent)}）`;

  return [
    slackMessageDuplicateMarker(report),
    `👤 ${formatNumber(report.previousDay.newUsers)}人（前日より ${formatDelta(day.delta)}人）`,
    `⚖️ 直近${avg.days}日平均 ${formatNumber(avg.baseline)}人 ${averageRelation} ${averageComparison}${averagePercent}`,
    `📅 直近${tail.length}日（${formatShortDate(firstDay.date)}→${formatShortDate(lastDay.date)}）：${series}人`,
  ].join("\n");
}
