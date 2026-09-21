/**
 * The narrow Snowflake boundary: one read-only statement in, one decoded
 * result set out. Everything above this module (query text, bindings, row
 * typing, report arithmetic) is deterministic code that never needs a
 * credential; everything below it (the SQL REST API client) is swappable for
 * the fixture executor in tests and dry-runs.
 *
 * Result sets keep the Snowflake SQL API encoding: every cell is a string
 * (or null), and `columns[i].type` says how to decode it. `decodeCell`
 * performs that decoding in one place so fixtures can stay authoritative
 * copies of what the API returns.
 */
import { readFile } from "node:fs/promises";
import { isPlainObject } from "../validate.mjs";

/**
 * A bind value in SQL API form. Only the three types this slice needs.
 * @typedef {{type: "TEXT", value: string} | {type: "FIXED", value: string}} Binding
 */

/**
 * @typedef {object} Statement
 * @property {string} name stable id of the query (fixtures are keyed by it)
 * @property {string} text a single SELECT statement with `?` placeholders
 * @property {Binding[]} bindings positional, one per `?`
 */

/**
 * @typedef {object} ResultColumn
 * @property {string} name
 * @property {string} type Snowflake SQL API logical type (TEXT, FIXED, DATE, ...)
 */

/**
 * @typedef {object} ResultSet
 * @property {ResultColumn[]} columns
 * @property {Array<Array<string|null>>} rows
 */

/**
 * @typedef {object} SqlExecutor
 * @property {string} kind "sql-api" or "fixture"
 * @property {(statement: Statement) => Promise<ResultSet>} execute
 */

/** Raised for any Snowflake-side failure. Never carries a credential. */
export class SnowflakeError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, phase?: string, details?: Record<string, unknown>, cause?: unknown}} [options]
   */
  constructor(message, { code = "snowflake", phase = "execute", details = {}, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SnowflakeError";
    this.code = code;
    this.phase = phase;
    this.details = details;
  }
}

/**
 * The executor only ever sends a single SELECT. Anything else (DDL, DML,
 * CALL, USE, multiple statements) is refused here before any transport sees
 * it, so the credential's own read-only grants are a second fence, not the
 * only one.
 *
 * @param {string} text
 * @returns {string}
 * @throws {SnowflakeError}
 */
export function assertReadOnlyStatement(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new SnowflakeError("statement must be a non-empty string", { code: "not_read_only", phase: "validate" });
  }
  if (text.includes(";")) {
    throw new SnowflakeError("statement may not contain ';' (single statement only)", { code: "not_read_only", phase: "validate" });
  }
  if (!/^\s*SELECT\b/i.test(text)) {
    throw new SnowflakeError("statement must be a single SELECT", { code: "not_read_only", phase: "validate" });
  }
  if (/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|USE|COPY|PUT|GET|EXECUTE)\b/i.test(text.replace(/'[^']*'/g, ""))) {
    throw new SnowflakeError("statement contains a keyword that is never read-only", { code: "not_read_only", phase: "validate" });
  }
  return text;
}

/**
 * @param {Statement} statement
 * @returns {Statement}
 */
export function validateStatement(statement) {
  if (!isPlainObject(statement) || typeof statement.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(statement.name)) {
    throw new SnowflakeError("statement.name must be a lowercase identifier", { code: "invalid_statement", phase: "validate" });
  }
  const text = assertReadOnlyStatement(statement.text);
  if (!Array.isArray(statement.bindings)) {
    throw new SnowflakeError("statement.bindings must be an array", { code: "invalid_statement", phase: "validate" });
  }
  const placeholders = (text.match(/\?/g) ?? []).length;
  if (placeholders !== statement.bindings.length) {
    throw new SnowflakeError(`statement has ${placeholders} placeholders but ${statement.bindings.length} bindings`, {
      code: "invalid_statement",
      phase: "validate",
    });
  }
  for (const b of statement.bindings) {
    if (!isPlainObject(b) || (b.type !== "TEXT" && b.type !== "FIXED") || typeof b.value !== "string") {
      throw new SnowflakeError("each binding must be {type: TEXT|FIXED, value: string}", { code: "invalid_statement", phase: "validate" });
    }
    if (b.type === "FIXED" && !/^-?\d+$/.test(b.value)) {
      throw new SnowflakeError("a FIXED binding value must be an integer string", { code: "invalid_statement", phase: "validate" });
    }
  }
  return { name: statement.name, text, bindings: statement.bindings.map((b) => ({ type: b.type, value: b.value })) };
}

const DAY_MS = 86_400_000;

/**
 * @param {number} epochDays
 * @returns {string} YYYY-MM-DD
 */
export function epochDaysToIsoDate(epochDays) {
  return new Date(epochDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Decode one SQL API cell into a JS value: DATE (days since epoch) to
 * `YYYY-MM-DD`, FIXED with scale 0 to a safe integer, TEXT to string.
 * Other types are returned as their raw string so callers see them
 * unchanged. NULL stays null.
 *
 * @param {ResultColumn} column
 * @param {string|null} raw
 * @returns {string|number|null}
 */
export function decodeCell(column, raw) {
  if (raw === null) return null;
  switch (column.type.toUpperCase()) {
    case "DATE": {
      if (!/^-?\d+$/.test(raw)) throw new SnowflakeError(`DATE cell "${raw}" is not an epoch-day integer`, { code: "decode" });
      return epochDaysToIsoDate(Number(raw));
    }
    case "FIXED": {
      const match = /^(-?\d+)(?:\.0*)?$/.exec(raw);
      if (!match || match[1] === undefined) throw new SnowflakeError(`FIXED cell "${raw}" is not an integer`, { code: "decode" });
      const n = Number(match[1]);
      if (!Number.isSafeInteger(n)) throw new SnowflakeError(`FIXED cell "${raw}" exceeds the safe integer range`, { code: "decode" });
      return n;
    }
    default:
      return raw;
  }
}

/**
 * Turn a result set into objects keyed by column name with decoded cells.
 *
 * @param {ResultSet} result
 * @returns {Array<Record<string, string|number|null>>}
 */
export function decodeRows(result) {
  return result.rows.map((row, r) => {
    if (row.length !== result.columns.length) {
      throw new SnowflakeError(`row ${r} has ${row.length} cells for ${result.columns.length} columns`, { code: "decode" });
    }
    /** @type {Record<string, string|number|null>} */
    const out = {};
    result.columns.forEach((column, i) => {
      out[column.name] = decodeCell(column, row[i] ?? null);
    });
    return out;
  });
}

/**
 * @param {unknown} raw
 * @param {string} where
 * @returns {ResultSet}
 */
export function parseResultSet(raw, where) {
  if (!isPlainObject(raw) || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) {
    throw new SnowflakeError(`${where}: expected {columns: [], rows: []}`, { code: "invalid_fixture", phase: "fixture" });
  }
  const columns = raw.columns.map((c, i) => {
    if (!isPlainObject(c) || typeof c.name !== "string" || typeof c.type !== "string") {
      throw new SnowflakeError(`${where}: column ${i} needs string name and type`, { code: "invalid_fixture", phase: "fixture" });
    }
    return { name: c.name, type: c.type };
  });
  const rows = raw.rows.map((row, r) => {
    if (!Array.isArray(row)) throw new SnowflakeError(`${where}: row ${r} must be an array`, { code: "invalid_fixture", phase: "fixture" });
    return row.map((cell, c) => {
      if (cell !== null && typeof cell !== "string") {
        throw new SnowflakeError(`${where}: row ${r} cell ${c} must be a string or null (SQL API encoding)`, {
          code: "invalid_fixture",
          phase: "fixture",
        });
      }
      return cell;
    });
  });
  return { columns, rows };
}

/**
 * @typedef {object} FixtureFile
 * @property {Record<string, ResultSet>} results result sets keyed by statement name
 */

/**
 * An executor that answers each statement from a recorded result set keyed
 * by statement name. It validates the statement exactly like the live client
 * (read-only, placeholder count) and records every call so tests can assert
 * the precise SQL and bindings that would have been sent.
 *
 * @param {unknown} fixture parsed fixture JSON
 * @returns {SqlExecutor & {calls: Statement[]}}
 */
export function createFixtureExecutor(fixture) {
  if (!isPlainObject(fixture) || !isPlainObject(fixture.results)) {
    throw new SnowflakeError("fixture must be {results: {<statement name>: {columns, rows}}}", { code: "invalid_fixture", phase: "fixture" });
  }
  /** @type {Map<string, ResultSet>} */
  const results = new Map();
  for (const [name, raw] of Object.entries(fixture.results)) {
    if (name.startsWith("_")) continue; // "_note" style annotations
    results.set(name, parseResultSet(raw, `fixture results.${name}`));
  }
  /** @type {Statement[]} */
  const calls = [];
  return {
    kind: "fixture",
    calls,
    async execute(statement) {
      const valid = validateStatement(statement);
      calls.push(valid);
      const result = results.get(valid.name);
      if (!result) {
        throw new SnowflakeError(`fixture has no result for statement "${valid.name}"`, { code: "missing_fixture", phase: "fixture" });
      }
      return { columns: result.columns.map((c) => ({ ...c })), rows: result.rows.map((r) => [...r]) };
    },
  };
}

/**
 * @param {string} path
 * @returns {Promise<SqlExecutor & {calls: Statement[]}>}
 */
export async function loadFixtureExecutor(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new SnowflakeError(`cannot read fixture ${path}: ${err instanceof Error ? err.message : String(err)}`, {
      code: "invalid_fixture",
      phase: "fixture",
      cause: err,
    });
  }
  return createFixtureExecutor(parsed);
}
