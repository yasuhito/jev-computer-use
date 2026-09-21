/**
 * The typed daily New Users report. Pure arithmetic over validated rows: no
 * I/O, no model, no clock beyond the window it is handed. Every derived
 * number has one definition, stated here and repeated in README.md:
 *
 * - reportDate: the last complete UTC day (the window's end minus one).
 * - series: one entry per day in the window, ascending; a day with no row
 *   counts 0 and is listed in `missingDates`.
 * - dayBefore: reportDate - 1, with delta = report - dayBefore and
 *   deltaPercent = delta / dayBefore * 100 (null when dayBefore is 0).
 * - trailing7DayAverage: mean of the 7 days ending at reportDate - 1
 *   (the report day is excluded from its own baseline), rounded to 1
 *   decimal; delta and deltaPercent as above against the unrounded mean.
 * - trend: against the trailing 7-day average; "flat" when the absolute
 *   deltaPercent is at most FLAT_BAND_PERCENT, "up"/"down" by sign; when
 *   the average is 0, "up" if the day is positive, else "flat".
 * - idempotencyKey: one value per (game, environment, reportDate), enabling
 *   duplicate checks or durable idempotency outside this pure report module.
 */
import { addDays, datesBetween, isIsoDate } from "./dates.mjs";

/** @typedef {import("../unity/data-access.mjs").GameEnvironment} GameEnvironment */
/** @typedef {import("../unity/data-access.mjs").DailyNewUsers} DailyNewUsers */
/** @typedef {import("./dates.mjs").ReportWindow} ReportWindow */

export const REPORT_KIND = "unity-analytics-new-users-daily";
export const FLAT_BAND_PERCENT = 5;
export const TRAILING_DAYS = 7;
export const IDEMPOTENCY_PREFIX = "unity-new-users";

/**
 * @typedef {object} Comparison
 * @property {number} baseline
 * @property {number} delta
 * @property {number|null} deltaPercent rounded to 1 decimal; null when the baseline is 0
 */

/**
 * @typedef {object} NewUsersReport
 * @property {typeof REPORT_KIND} kind
 * @property {string} generatedAt ISO instant the report was computed
 * @property {{accountName: string|null, gameName: string, gameId: number, environmentName: string, environmentId: number, unityProjectId: string|null}} game
 * @property {{start: string, end: string, days: number}} window
 * @property {string} reportDate
 * @property {{date: string, newUsers: number}} previousDay
 * @property {DailyNewUsers[]} series
 * @property {string[]} missingDates window days with no row, counted as 0
 * @property {{dayBefore: Comparison & {date: string}, trailing7DayAverage: Comparison & {from: string, to: string, days: number}, trend: "up"|"down"|"flat"}} comparison
 * @property {string} idempotencyKey
 */

/**
 * @param {number} value
 * @param {number} [decimals]
 */
export function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * @param {number} current
 * @param {number} baseline
 * @returns {Comparison}
 */
export function compare(current, baseline) {
  const delta = round(current - baseline);
  const deltaPercent = baseline === 0 ? null : round(((current - baseline) / baseline) * 100);
  return { baseline: round(baseline), delta, deltaPercent };
}

/**
 * @param {number} current
 * @param {number} baseline
 * @returns {"up"|"down"|"flat"}
 */
export function classifyTrend(current, baseline) {
  if (baseline === 0) return current > 0 ? "up" : "flat";
  const percent = ((current - baseline) / baseline) * 100;
  if (Math.abs(percent) <= FLAT_BAND_PERCENT) return "flat";
  return percent > 0 ? "up" : "down";
}

/**
 * @param {{gameId: number, environmentId: number}} game
 * @param {string} reportDate
 */
export function idempotencyKey(game, reportDate) {
  return `${IDEMPOTENCY_PREFIX}:${game.gameId}:${game.environmentId}:${reportDate}`;
}

/**
 * @param {{game: GameEnvironment, window: ReportWindow, rows: DailyNewUsers[], generatedAt: string}} input
 * @returns {NewUsersReport}
 */
export function buildNewUsersReport({ game, window, rows, generatedAt }) {
  if (!isIsoDate(window.start) || !isIsoDate(window.end) || !isIsoDate(window.reportDate)) throw new Error("window dates must be YYYY-MM-DD");
  if (addDays(window.end, -1) !== window.reportDate) throw new Error("reportDate must be the day before the window end");
  const dates = datesBetween(window.start, window.end);
  if (dates.length !== window.days || dates.length < TRAILING_DAYS + 1) throw new Error("window must hold days complete days, at least 8");
  /** @type {Map<string, number>} */
  const byDate = new Map();
  for (const row of rows) {
    if (row.date < window.start || row.date >= window.end) throw new Error(`row ${row.date} is outside the window`);
    if (byDate.has(row.date)) throw new Error(`duplicate row for ${row.date}`);
    byDate.set(row.date, row.newUsers);
  }
  const series = dates.map((date) => ({ date, newUsers: byDate.get(date) ?? 0 }));
  const missingDates = dates.filter((date) => !byDate.has(date));
  const count = (/** @type {string} */ date) => byDate.get(date) ?? 0;

  const reportDate = window.reportDate;
  const current = count(reportDate);
  const dayBefore = addDays(reportDate, -1);
  const trailingFrom = addDays(reportDate, -TRAILING_DAYS);
  const trailingDates = datesBetween(trailingFrom, reportDate);
  const trailingMean = trailingDates.reduce((sum, date) => sum + count(date), 0) / TRAILING_DAYS;

  return {
    kind: REPORT_KIND,
    generatedAt,
    game: {
      accountName: game.accountName,
      gameName: game.gameName,
      gameId: game.gameId,
      environmentName: game.environmentName,
      environmentId: game.environmentId,
      unityProjectId: game.unityProjectId,
    },
    window: { start: window.start, end: window.end, days: window.days },
    reportDate,
    previousDay: { date: reportDate, newUsers: current },
    series,
    missingDates,
    comparison: {
      dayBefore: { date: dayBefore, ...compare(current, count(dayBefore)) },
      trailing7DayAverage: { from: trailingFrom, to: dayBefore, days: TRAILING_DAYS, ...compare(current, trailingMean) },
      trend: classifyTrend(current, trailingMean),
    },
    idempotencyKey: idempotencyKey(game, reportDate),
  };
}
