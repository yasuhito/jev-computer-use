import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accountGamesStatement, newUsersByStartDateStatement } from "../src/unity/data-access.mjs";

/** @typedef {import("../src/snowflake/executor.mjs").Statement} Statement */
/** @typedef {import("../src/snowflake/executor.mjs").Binding} Binding */

/** @typedef {{name: string, type: string}} Column
 * @typedef {Record<string, Column[]>} Schema
 * @typedef {{schema: Schema, results: {account_games: {columns: Column[]}, new_users_by_start_date: {columns: Column[]}}}} Fixture
 */

/** @type {Fixture} */
const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/unity-data-access.json", import.meta.url)), "utf8"));
const SCHEMA = FIXTURE.schema;

/** A statement the real compiler would refuse before execution. */
class CompilationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "CompilationError";
  }
}

/**
 * Recreate, against the official schema, the compilation Snowflake runs
 * before any statement executes. This stand-in is specialised to the single-SELECT
 * shape this slice sends (one view, no joins or subqueries) and checks the
 * two things that stage checks first: every identifier must resolve to a
 * column of the queried view (or an alias the query itself defines), and
 * every binding must fit the column or date literal it feeds.
 *
 * @param {Statement} statement
 * @param {Schema} [schema]
 * @returns {{view: string, outputColumns: string[]}} the resolved view and
 *   the column names the result set would carry
 */
function compile(statement, schema = SCHEMA) {
  const text = statement.text;
  // Blank string literals with spaces so identifiers, `?`s, and offsets in
  // the masked text stay aligned with the original.
  const masked = text.replace(/'(?:[^'\\]|\\[\s\S])*'/g, (lit) => lit.replace(/[^\n]/g, " "));
  const fromMatch = /\bFROM\s+([A-Za-z_][A-Za-z0-9_$]*)/i.exec(masked);
  if (!fromMatch) throw new CompilationError("SQL compilation error: statement has no FROM view");
  const view = (fromMatch[1] ?? "").toUpperCase();
  const columns = schema[view];
  if (!columns) throw new CompilationError(`SQL compilation error: unknown view '${view}'`);
  /** @type {Map<string, string>} */
  const columnTypes = new Map(columns.map((c) => [c.name.toUpperCase(), c.type.toUpperCase()]));

  const KEYWORDS = new Set([
    "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "AS", "GROUP", "BY", "ORDER",
    "ASC", "DESC", "DISTINCT", "JOIN", "ON", "IS", "NULL", "IN", "LIKE", "BETWEEN",
    "HAVING", "LIMIT", "OFFSET", "WITH", "UNION", "ALL", "CASE", "WHEN", "THEN",
    "ELSE", "END", "TRUE", "FALSE",
  ]);

  /** @type {{word: string, start: number, end: number}[]} */
  const words = [];
  for (const m of masked.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
    const index = m.index ?? 0;
    words.push({ word: m[0], start: index, end: index + m[0].length });
  }

  /**
   * @param {number} index
   * @param {string} detail
   */
  const compilationErrorAt = (index, detail) => {
    const before = text.slice(0, index);
    const line = before.split("\n").length;
    const position = index - before.lastIndexOf("\n");
    return new CompilationError(`SQL compilation error: error line ${line} at position ${position} ${detail}`);
  };

  /** @type {Set<string>} */
  const aliases = new Set();
  /** @type {string | null} */
  let tableAlias = null;
  for (let i = 0; i < words.length; ) {
    const word = words[i];
    if (!word) break;
    const upper = word.word.toUpperCase();
    const previous = words[i - 1];
    if (upper === "FROM") {
      const viewWord = words[i + 1];
      if (!viewWord) throw new CompilationError("SQL compilation error: FROM needs a view name");
      if (viewWord.word.toUpperCase() !== view) {
        throw new CompilationError(`SQL compilation error: this slice sends one view per statement, found '${viewWord.word}'`);
      }
      i += 2;
      const asWord = words[i];
      if (asWord && asWord.word.toUpperCase() === "AS") i += 1;
      const aliasWord = words[i];
      if (aliasWord && !KEYWORDS.has(aliasWord.word.toUpperCase())) {
        tableAlias = aliasWord.word.toUpperCase();
        i += 1;
      }
      continue;
    }
    if (KEYWORDS.has(upper)) {
      i += 1;
      continue;
    }
    if (previous && previous.word.toUpperCase() === "AS") {
      aliases.add(upper);
      i += 1;
      continue;
    }
    if (masked.charAt(word.end) === ".") {
      const columnWord = words[i + 1];
      if (!columnWord) throw new CompilationError("SQL compilation error: dangling '.'");
      if (upper !== view && upper !== tableAlias) {
        throw new CompilationError(`SQL compilation error: unknown table alias '${word.word}'`);
      }
      if (!columnTypes.has(columnWord.word.toUpperCase())) {
        throw compilationErrorAt(word.start, `invalid identifier '${upper}.${columnWord.word}'`);
      }
      i += 2;
      continue;
    }
    if (masked.charAt(word.end) === "(") {
      i += 1;
      continue;
    }
    if (!columnTypes.has(upper) && !aliases.has(upper)) {
      throw compilationErrorAt(word.start, `invalid identifier '${view}.${word.word}'`);
    }
    i += 1;
  }

  const selectMatch = /\bSELECT\b/i.exec(masked);
  if (!selectMatch) throw new CompilationError("SQL compilation error: statement has no SELECT list");
  const selectEnd = (selectMatch.index ?? 0) + selectMatch[0].length;
  const selectItems = [];
  {
    let depth = 0;
    let current = "";
    for (const ch of masked.slice(selectEnd, fromMatch.index ?? 0)) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        selectItems.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    selectItems.push(current);
  }
  const outputColumns = selectItems.map((raw) => {
    const item = raw.trim();
    if (item.length === 0) throw new CompilationError("SQL compilation error: empty SELECT item");
    const aliased = /^(.+)\s+AS\s+([A-Za-z_][A-Za-z0-9_$]*)$/is.exec(item);
    if (aliased) return (aliased[2] ?? "").toUpperCase();
    if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(item)) return item.toUpperCase();
    throw new CompilationError(`SQL compilation error: SELECT item needs an AS alias: ${item}`);
  });

  const placeholderPositions = [...text.matchAll(/\?/g)].map((m) => m.index ?? 0);
  const bindings = statement.bindings ?? [];
  if (placeholderPositions.length !== bindings.length) {
    throw new CompilationError(`statement has ${placeholderPositions.length} placeholders but ${bindings.length} bindings`);
  }
  placeholderPositions.forEach((q, i) => {
    const binding = bindings[i];
    if (!binding) throw new CompilationError(`binding ${i + 1} is missing`);
    const prefix = text.slice(0, q);
    const comparison = /([A-Za-z_][A-Za-z0-9_$]*)\s*(?:=|<>|!=|<=|>=|<|>)\s*$/.exec(prefix);
    const toDate = comparison ? null : /TO_DATE\s*\(\s*$/.test(prefix);
    if (comparison) {
      const column = (comparison[1] ?? "").toUpperCase();
      const type = columnTypes.get(column);
      if (!type) throw compilationErrorAt(q, `invalid identifier '${view}.${comparison[1]}'`);
      if (type === "NUMBER") {
        if (binding.type !== "FIXED" || !/^-?\d+$/.test(binding.value)) {
          throw new CompilationError(`binding ${i + 1} for NUMBER column ${column} must be a FIXED integer string`);
        }
      } else if (type === "TEXT") {
        if (binding.type !== "TEXT" || binding.value.length === 0) {
          throw new CompilationError(`binding ${i + 1} for TEXT column ${column} must be a non-empty TEXT value`);
        }
      } else if (type === "DATE") {
        if (binding.type !== "TEXT" || !/^\d{4}-\d{2}-\d{2}$/.test(binding.value)) {
          throw new CompilationError(`binding ${i + 1} for DATE column ${column} must be a TEXT YYYY-MM-DD value`);
        }
      }
      return;
    }
    if (toDate) {
      if (binding.type !== "TEXT" || !/^\d{4}-\d{2}-\d{2}$/.test(binding.value)) {
        throw new CompilationError(`binding ${i + 1} for TO_DATE must be a TEXT YYYY-MM-DD value`);
      }
      const compared = /([A-Za-z_][A-Za-z0-9_$]*)\s*(?:=|<>|!=|<=|>=|<|>)\s*TO_DATE\s*\(\s*$/.exec(prefix);
      const column = (compared?.[1] ?? "").toUpperCase();
      if (!column || columnTypes.get(column) !== "DATE") {
        throw new CompilationError(`TO_DATE(?) in binding ${i + 1} must be compared with a DATE column`);
      }
      return;
    }
    throw new CompilationError(`binding ${i + 1} is not a column comparison or a TO_DATE literal`);
  });

  return { view, outputColumns };
}

/* ----------------------------- the real statements ----------------------------- */

test("both generated statements compile against the official schema and answer the columns the fixture records", () => {
  const games = compile(accountGamesStatement("QA2"));
  assert.equal(games.view, "ACCOUNT_GAMES");
  assert.deepEqual(games.outputColumns, FIXTURE.results.account_games.columns.map((c) => c.name));

  const users = compile(newUsersByStartDateStatement({ gameId: 24601, environmentId: 31001, start: "2026-09-07", end: "2026-09-21" }));
  assert.equal(users.view, "ACCOUNT_USERS");
  assert.deepEqual(users.outputColumns, FIXTURE.results.new_users_by_start_date.columns.map((c) => c.name));
});

test("every binding fits the column or date literal it feeds", () => {
  /** @param {Binding[]} bindings @returns {Statement} */
  const withBindings = (bindings) => ({ name: "probe", text: newUsersByStartDateStatement({ gameId: 1, environmentId: 2, start: "2026-09-07", end: "2026-09-08" }).text, bindings });
  // NUMBER columns take FIXED integers, TEXT columns take TEXT.
  assert.throws(() => compile(withBindings([{ type: "TEXT", value: "24601" }, { type: "FIXED", value: "31001" }, { type: "TEXT", value: "2026-09-07" }, { type: "TEXT", value: "2026-09-21" }])), /GAME_ID/);
  assert.throws(() => compile(withBindings([{ type: "FIXED", value: "24601" }, { type: "FIXED", value: "31001" }, { type: "TEXT", value: "2026-9-7" }, { type: "TEXT", value: "2026-09-21" }])), /YYYY-MM-DD/);
  assert.throws(() => compile(withBindings([{ type: "FIXED", value: "24601" }])), /placeholders but 1 bindings/);
});
