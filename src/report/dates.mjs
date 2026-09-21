/**
 * UTC calendar arithmetic for the daily report. Dates are `YYYY-MM-DD`
 * strings on UTC boundaries; nothing here consults the local time zone.
 */

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Fewest complete days a report window may hold: the report day plus a 7-day trailing baseline. */
export const MIN_WINDOW_DAYS = 8;
export const MAX_WINDOW_DAYS = 90;
export const DEFAULT_WINDOW_DAYS = 14;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * @param {string} isoDate
 * @returns {number} epoch milliseconds at 00:00:00 UTC
 */
export function isoDateToMs(isoDate) {
  if (!isIsoDate(isoDate)) throw new Error(`not a calendar date: ${isoDate}`);
  return Date.parse(`${isoDate}T00:00:00Z`);
}

/**
 * @param {number} epochMs
 * @returns {string} the UTC calendar date containing the instant
 */
export function utcDateOf(epochMs) {
  if (!Number.isFinite(epochMs)) throw new Error("epochMs must be finite");
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * @param {string} isoDate
 * @param {number} days may be negative
 * @returns {string}
 */
export function addDays(isoDate, days) {
  if (!Number.isInteger(days)) throw new Error("days must be an integer");
  return utcDateOf(isoDateToMs(isoDate) + days * DAY_MS);
}

/**
 * @param {string} start inclusive
 * @param {string} end exclusive
 * @returns {string[]} every date in [start, end)
 */
export function datesBetween(start, end) {
  const startMs = isoDateToMs(start);
  const endMs = isoDateToMs(end);
  if (endMs < startMs) throw new Error(`end ${end} precedes start ${start}`);
  /** @type {string[]} */
  const out = [];
  for (let ms = startMs; ms < endMs; ms += DAY_MS) out.push(utcDateOf(ms));
  return out;
}

/**
 * @typedef {object} ReportWindow
 * @property {string} start first complete UTC day, inclusive
 * @property {string} end the current (incomplete) UTC day, exclusive
 * @property {number} days
 * @property {string} reportDate the last complete UTC day (end - 1)
 */

/**
 * The window of complete UTC days ending yesterday. The current UTC day is
 * always excluded because it is still accumulating.
 *
 * @param {number} nowMs
 * @param {number} [days]
 * @returns {ReportWindow}
 */
export function completeUtcWindow(nowMs, days = DEFAULT_WINDOW_DAYS) {
  if (!Number.isInteger(days) || days < MIN_WINDOW_DAYS || days > MAX_WINDOW_DAYS) {
    throw new Error(`window days must be an integer in ${MIN_WINDOW_DAYS}..${MAX_WINDOW_DAYS}`);
  }
  const end = utcDateOf(nowMs);
  return { start: addDays(end, -days), end, days, reportDate: addDays(end, -1) };
}
