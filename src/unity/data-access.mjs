/**
 * Unity Analytics Data Access (the Snowflake share UNITYLIVEOPS.UNITY_ANALYTICS_PDA)
 * as a typed, read-only source. Column names follow the official view
 * reference, https://docs.unity.com/en-us/analytics/data-access/data-access-views:
 *
 *   ACCOUNT_GAMES  ACCOUNT_NAME, GAME_NAME, GAME_ID, ENVIRONMENT_NAME,
 *                  ENVIRONMENT_ID, UNITY_PROJECT_ID
 *   ACCOUNT_USERS  ..., GAME_ID, ENVIRONMENT_ID, USER_ID, START_DATE (DATE), ...
 *
 * The game is resolved by name from ACCOUNT_GAMES at run time (no hard-coded
 * GAME_ID) and exactly one environment row is selected in code. New users
 * per day are COUNT(DISTINCT USER_ID) grouped by the player's start date:
 * ACCOUNT_USERS holds one row per user whose START_DATE is that user's
 * player start date (the same fact the event and fact views expose as
 * PLAYER_START_DATE); the query aliases it accordingly. Every statement is a
 * single SELECT with positional bindings; identifiers are never interpolated.
 */
import { isIsoDate } from "../report/dates.mjs";
import { decodeRows } from "../snowflake/executor.mjs";

/** @typedef {import("../snowflake/executor.mjs").SqlExecutor} SqlExecutor */
/** @typedef {import("../snowflake/executor.mjs").Statement} Statement */

export const ACCOUNT_GAMES_STATEMENT = [
  "SELECT ACCOUNT_NAME, GAME_NAME, GAME_ID, ENVIRONMENT_NAME, ENVIRONMENT_ID, UNITY_PROJECT_ID",
  "FROM ACCOUNT_GAMES",
  "WHERE GAME_NAME = ?",
  "ORDER BY GAME_ID, ENVIRONMENT_ID",
].join("\n");

export const NEW_USERS_BY_START_DATE_STATEMENT = [
  "SELECT START_DATE AS PLAYER_START_DATE, COUNT(DISTINCT USER_ID) AS NEW_USERS",
  "FROM ACCOUNT_USERS",
  "WHERE GAME_ID = ? AND ENVIRONMENT_ID = ?",
  "  AND START_DATE >= TO_DATE(?, 'YYYY-MM-DD') AND START_DATE < TO_DATE(?, 'YYYY-MM-DD')",
  "GROUP BY START_DATE",
  "ORDER BY START_DATE",
].join("\n");

export const DEFAULT_GAME_NAME = "QA2";
export const DEFAULT_ENVIRONMENT_NAME = "live";
// eslint-disable-next-line no-control-regex
const NAME_PATTERN = /^[^\s\u0000-\u001F\u007F][^\u0000-\u001F\u007F]{0,199}$/;

/** A data condition that prevents a report; never a transport failure. */
export class DataAccessError extends Error {
  /**
   * @param {"game_not_found"|"ambiguous_game"|"environment_not_found"|"ambiguous_environment"|"invalid_row"|"unexpected_row"|"invalid_name"} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DataAccessError";
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
export function validateName(value, what) {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw new DataAccessError("invalid_name", `${what} must be 1..200 printable characters with no leading whitespace`);
  }
  return value;
}

/**
 * @typedef {object} GameEnvironment
 * @property {string|null} accountName
 * @property {string} gameName
 * @property {number} gameId
 * @property {string} environmentName
 * @property {number} environmentId
 * @property {string|null} unityProjectId
 * @property {string[]} environmentsSeen every environment name ACCOUNT_GAMES lists for the game
 */

/**
 * @param {string} gameName
 * @returns {Statement}
 */
export function accountGamesStatement(gameName) {
  return { name: "account_games", text: ACCOUNT_GAMES_STATEMENT, bindings: [{ type: "TEXT", value: gameName }] };
}

/**
 * @param {Record<string, string|number|null>} row
 * @param {string} column
 * @param {number} index
 */
function requireText(row, column, index) {
  const v = row[column];
  if (typeof v !== "string" || v.length === 0) {
    throw new DataAccessError("invalid_row", `ACCOUNT_GAMES row ${index} has no ${column}`, { column });
  }
  return v;
}

/**
 * @param {Record<string, string|number|null>} row
 * @param {string} column
 * @param {number} index
 * @param {string} view
 */
function requireInteger(row, column, index, view) {
  const v = row[column];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new DataAccessError("invalid_row", `${view} row ${index} has a non-integer ${column}`, { column });
  }
  return v;
}

/**
 * Resolve exactly one (game, environment) pair. Matching is exact on
 * GAME_NAME (the SQL filter is repeated in code) and case-insensitive on
 * ENVIRONMENT_NAME; anything other than exactly one row is an error.
 *
 * @param {SqlExecutor} executor
 * @param {{gameName?: string, environmentName?: string}} [options]
 * @returns {Promise<GameEnvironment>}
 */
export async function resolveGameEnvironment(executor, { gameName = DEFAULT_GAME_NAME, environmentName = DEFAULT_ENVIRONMENT_NAME } = {}) {
  validateName(gameName, "game name");
  validateName(environmentName, "environment name");
  const rows = decodeRows(await executor.execute(accountGamesStatement(gameName)));
  const games = rows
    .map((row, i) => ({
      accountName: typeof row.ACCOUNT_NAME === "string" ? row.ACCOUNT_NAME : null,
      gameName: requireText(row, "GAME_NAME", i),
      gameId: requireInteger(row, "GAME_ID", i, "ACCOUNT_GAMES"),
      environmentName: requireText(row, "ENVIRONMENT_NAME", i),
      environmentId: requireInteger(row, "ENVIRONMENT_ID", i, "ACCOUNT_GAMES"),
      unityProjectId: typeof row.UNITY_PROJECT_ID === "string" ? row.UNITY_PROJECT_ID : null,
    }))
    .filter((g) => g.gameName === gameName);
  if (games.length === 0) {
    throw new DataAccessError("game_not_found", `ACCOUNT_GAMES lists no game named "${gameName}"`, { gameName });
  }
  const gameIds = [...new Set(games.map((g) => g.gameId))];
  if (gameIds.length > 1) {
    throw new DataAccessError("ambiguous_game", `ACCOUNT_GAMES lists ${gameIds.length} distinct GAME_IDs named "${gameName}"`, {
      gameName,
      gameIds,
    });
  }
  const environmentsSeen = games.map((g) => g.environmentName);
  const wanted = environmentName.toLowerCase();
  const matches = games.filter((g) => g.environmentName.toLowerCase() === wanted);
  if (matches.length === 0) {
    throw new DataAccessError("environment_not_found", `game "${gameName}" has no environment named "${environmentName}"`, {
      gameName,
      environmentName,
      environmentsSeen,
    });
  }
  if (matches.length > 1) {
    throw new DataAccessError("ambiguous_environment", `game "${gameName}" lists ${matches.length} environments named "${environmentName}"`, {
      gameName,
      environmentName,
      environmentIds: matches.map((g) => g.environmentId),
    });
  }
  const match = /** @type {typeof games[number]} */ (matches[0]);
  return { ...match, environmentsSeen };
}

/**
 * @param {{gameId: number, environmentId: number, start: string, end: string}} input
 * @returns {Statement}
 */
export function newUsersByStartDateStatement({ gameId, environmentId, start, end }) {
  if (!Number.isInteger(gameId) || !Number.isInteger(environmentId)) throw new Error("gameId and environmentId must be integers");
  if (!isIsoDate(start) || !isIsoDate(end)) throw new Error("start and end must be YYYY-MM-DD");
  return {
    name: "new_users_by_start_date",
    text: NEW_USERS_BY_START_DATE_STATEMENT,
    bindings: [
      { type: "FIXED", value: String(gameId) },
      { type: "FIXED", value: String(environmentId) },
      { type: "TEXT", value: start },
      { type: "TEXT", value: end },
    ],
  };
}

/**
 * @typedef {object} DailyNewUsers
 * @property {string} date PLAYER_START_DATE as YYYY-MM-DD (UTC calendar day)
 * @property {number} newUsers COUNT(DISTINCT USER_ID)
 */

/**
 * New users per player start date inside [start, end). Rows are validated
 * (dates inside the window, unique, non-negative integer counts) and sorted;
 * days with no row are absent here and zero-filled by the report builder.
 *
 * @param {SqlExecutor} executor
 * @param {{gameId: number, environmentId: number, start: string, end: string}} input
 * @returns {Promise<DailyNewUsers[]>}
 */
export async function fetchNewUsersByStartDate(executor, input) {
  const rows = decodeRows(await executor.execute(newUsersByStartDateStatement(input)));
  /** @type {Map<string, number>} */
  const byDate = new Map();
  rows.forEach((row, i) => {
    const date = row.PLAYER_START_DATE;
    if (typeof date !== "string" || !isIsoDate(date)) {
      throw new DataAccessError("invalid_row", `new-users row ${i} has no PLAYER_START_DATE date`, { row: i });
    }
    const count = requireInteger(row, "NEW_USERS", i, "new-users");
    if (count < 0) throw new DataAccessError("invalid_row", `new-users row ${i} has a negative count`, { row: i });
    if (date < input.start || date >= input.end) {
      throw new DataAccessError("unexpected_row", `new-users row ${i} (${date}) is outside the window [${input.start}, ${input.end})`, {
        row: i,
        date,
      });
    }
    if (byDate.has(date)) throw new DataAccessError("invalid_row", `new-users rows repeat the date ${date}`, { date });
    byDate.set(date, count);
  });
  return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, newUsers]) => ({ date, newUsers }));
}
