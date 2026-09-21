import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertReadOnlyStatement,
  validateStatement,
  decodeCell,
  decodeRows,
  epochDaysToIsoDate,
  createFixtureExecutor,
  loadFixtureExecutor,
} from "../src/snowflake/executor.mjs";
import { buildKeyPairJwt, jwtAccountIdentifier, publicKeyFingerprint, MAX_JWT_LIFETIME_SECONDS } from "../src/snowflake/keypair-jwt.mjs";
import { createSqlApiExecutor, readSnowflakeConfig, parseSqlApiResultSet } from "../src/snowflake/sql-api.mjs";

/** @typedef {import("../src/snowflake/executor.mjs").SnowflakeError} SnowflakeError */
/** @typedef {import("../src/snowflake/sql-api.mjs").MissingSnowflakeConfigError} MissingSnowflakeConfigError */
import { fakeClock } from "./helpers.mjs";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/unity-data-access.json", import.meta.url));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** @type {import("../src/snowflake/executor.mjs").Statement} */
const SELECT = { name: "probe", text: "SELECT GAME_ID FROM ACCOUNT_GAMES WHERE GAME_NAME = ?", bindings: [{ type: "TEXT", value: "QA2" }] };

/**
 * A complete, syntactically valid environment; no value is a real credential.
 * @type {Record<string, string>}
 */
const ENV = {
  SNOWFLAKE_ACCOUNT: "testorg-testaccount",
  SNOWFLAKE_USER: "report_reader",
  SNOWFLAKE_PRIVATE_KEY_PATH: "/nonexistent/key.p8",
  SNOWFLAKE_WAREHOUSE: "REPORT_XS",
  SNOWFLAKE_DATABASE: "UNITY_ANALYTICS",
  SNOWFLAKE_SCHEMA: "PUBLIC",
};

/* ----------------------------- read-only guard ----------------------------- */

test("assertReadOnlyStatement accepts one SELECT and refuses everything else", () => {
  assert.equal(assertReadOnlyStatement("SELECT 1"), "SELECT 1");
  assert.equal(assertReadOnlyStatement("  select COUNT(DISTINCT USER_ID) FROM ACCOUNT_USERS"), "  select COUNT(DISTINCT USER_ID) FROM ACCOUNT_USERS");
  for (const text of [
    "",
    "SELECT 1; DROP TABLE X",
    "DELETE FROM ACCOUNT_USERS",
    "INSERT INTO T SELECT 1",
    "SELECT * FROM T WHERE 1=1 UNION ALL CALL PROC()",
    "USE WAREHOUSE X",
    "CREATE TABLE T AS SELECT 1",
    "SELECT 1 FROM T; ",
    "WITH x AS (SELECT 1) SELECT * FROM x",
  ]) {
    assert.throws(() => assertReadOnlyStatement(text), (/** @type {SnowflakeError} */ err) => err.code === "not_read_only", text);
  }
});

test("validateStatement checks the name, the placeholder count, and binding shapes", () => {
  assert.deepEqual(validateStatement(SELECT), SELECT);
  assert.throws(() => validateStatement({ ...SELECT, name: "Bad Name" }), /lowercase identifier/);
  assert.throws(() => validateStatement({ ...SELECT, bindings: [] }), /1 placeholders but 0 bindings/);
  assert.throws(() => validateStatement({ ...SELECT, bindings: [/** @type {any} */ ({ type: "DATE", value: "2026-01-01" })] }), /TEXT\|FIXED/);
  assert.throws(() => validateStatement({ ...SELECT, bindings: [{ type: "FIXED", value: "12.5" }] }), /integer string/);
});

/* ----------------------------- decoding ----------------------------- */

test("decodeCell follows the SQL API encoding: DATE as epoch days, FIXED as integer strings", () => {
  assert.equal(epochDaysToIsoDate(20716), "2026-09-20");
  assert.equal(decodeCell({ name: "D", type: "DATE" }, "20716"), "2026-09-20");
  assert.equal(decodeCell({ name: "D", type: "date" }, "0"), "1970-01-01");
  assert.equal(decodeCell({ name: "N", type: "FIXED" }, "1234"), 1234);
  assert.equal(decodeCell({ name: "N", type: "FIXED" }, "1234.0"), 1234);
  assert.equal(decodeCell({ name: "N", type: "FIXED" }, "-7"), -7);
  assert.equal(decodeCell({ name: "T", type: "TEXT" }, "QA2"), "QA2");
  assert.equal(decodeCell({ name: "T", type: "TEXT" }, null), null);
  assert.equal(decodeCell({ name: "X", type: "TIMESTAMP_NTZ" }, "82919.000000000"), "82919.000000000");
  assert.throws(() => decodeCell({ name: "D", type: "DATE" }, "2026-09-20"), /epoch-day/);
  assert.throws(() => decodeCell({ name: "N", type: "FIXED" }, "12.5"), /not an integer/);
  assert.throws(() => decodeCell({ name: "N", type: "FIXED" }, "99999999999999999999"), /safe integer/);
});

test("decodeRows keys cells by column and rejects ragged rows", () => {
  const rows = decodeRows({
    columns: [
      { name: "PLAYER_START_DATE", type: "DATE" },
      { name: "NEW_USERS", type: "FIXED" },
    ],
    rows: [
      ["20716", "1234"],
      ["20715", null],
    ],
  });
  assert.deepEqual(rows, [
    { PLAYER_START_DATE: "2026-09-20", NEW_USERS: 1234 },
    { PLAYER_START_DATE: "2026-09-19", NEW_USERS: null },
  ]);
  assert.throws(() => decodeRows({ columns: [{ name: "A", type: "TEXT" }], rows: [["1", "2"]] }), /cells for 1 columns/);
});

/* ----------------------------- fixture executor ----------------------------- */

test("the fixture executor answers by statement name, validates like the live client, and records calls", async () => {
  const executor = await loadFixtureExecutor(FIXTURE_PATH);
  assert.equal(executor.kind, "fixture");
  const result = await executor.execute({ name: "account_games", text: "SELECT 1 FROM ACCOUNT_GAMES WHERE GAME_NAME = ?", bindings: [{ type: "TEXT", value: "QA2" }] });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.columns.map((c) => c.name),
    ["ACCOUNT_NAME", "GAME_NAME", "GAME_ID", "ENVIRONMENT_NAME", "ENVIRONMENT_ID", "UNITY_PROJECT_ID"],
  );
  assert.equal(executor.calls.length, 1);
  await assert.rejects(executor.execute({ name: "unknown_query", text: "SELECT 1", bindings: [] }), /no result for statement "unknown_query"/);
  await assert.rejects(executor.execute({ name: "account_games", text: "DELETE FROM ACCOUNT_GAMES", bindings: [] }), /single SELECT/);
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert.throws(() => createFixtureExecutor({ results: { bad: { columns: [], rows: [[1]] } } }), /string or null/);
  assert.throws(() => createFixtureExecutor({ nope: raw.results }), /fixture must be/);
});

/* ----------------------------- key-pair JWT ----------------------------- */

test("the key-pair JWT follows the Snowflake SQL API rules and verifies with the public key", () => {
  const { token, claims } = buildKeyPairJwt({ account: "testorg-testaccount", user: "report_reader", privateKey, nowSeconds: 1_800_000_000, lifetimeSeconds: 600 });
  const fingerprint = publicKeyFingerprint(privateKey);
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+=*$/);
  assert.equal(claims.sub, "TESTORG-TESTACCOUNT.REPORT_READER");
  assert.equal(claims.iss, `TESTORG-TESTACCOUNT.REPORT_READER.${fingerprint}`);
  assert.equal(claims.exp - claims.iat, 600);
  const [header, payload, signature] = token.split(".");
  assert.ok(header && payload && signature);
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), claims);
  const ok = verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature, "base64url"));
  assert.equal(ok, true);
  assert.throws(() => buildKeyPairJwt({ account: "a", user: "u", privateKey, nowSeconds: 1, lifetimeSeconds: MAX_JWT_LIFETIME_SECONDS + 1 }));
});

test("jwtAccountIdentifier uppercases, drops region segments, and never keeps a period", () => {
  assert.equal(jwtAccountIdentifier("testorg-testaccount"), "TESTORG-TESTACCOUNT");
  assert.equal(jwtAccountIdentifier("xy12345.us-central1.gcp"), "XY12345");
  assert.equal(jwtAccountIdentifier("  ab123 "), "AB123");
  assert.throws(() => jwtAccountIdentifier("   "), /empty/);
});

/* ----------------------------- SQL API executor ----------------------------- */

test("readSnowflakeConfig requires every connection fact, validates shapes, and never echoes values", () => {
  const config = readSnowflakeConfig(ENV);
  assert.equal(config.host, "testorg-testaccount.snowflakecomputing.com");
  assert.equal(config.role, null);
  assert.equal(config.privateKeyPassphrase, undefined);
  assert.equal(readSnowflakeConfig({ ...ENV, SNOWFLAKE_HOST: "custom.example.com", SNOWFLAKE_ROLE: "READER" }).host, "custom.example.com");
  for (const key of Object.keys(ENV)) {
    const missing = { ...ENV };
    delete missing[key];
    assert.throws(() => readSnowflakeConfig(missing), (/** @type {MissingSnowflakeConfigError} */ err) => err.code === "missing_snowflake_config" && err.message.includes(key));
  }
  assert.throws(
    () => readSnowflakeConfig({ ...ENV, SNOWFLAKE_DATABASE: "secret-value; drop" }),
    (/** @type {Error} */ err) => err.message.includes("SNOWFLAKE_DATABASE") && !err.message.includes("secret-value"),
  );
});

/**
 * @param {Array<{status: number, body?: unknown, text?: string, throws?: Error}>} script
 */
function scriptedFetch(script) {
  /** @type {Array<{url: string, init: RequestInit}>} */
  const requests = [];
  const queue = [...script];
  /** @type {import("../src/snowflake/sql-api.mjs").FetchLike} */
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("scripted fetch exhausted");
    if (next.throws) throw next.throws;
    const text = next.text ?? (next.body === undefined ? "" : JSON.stringify(next.body));
    return /** @type {Response} */ ({ status: next.status, text: async () => text });
  };
  return { fetchImpl, requests };
}

const RESULT = {
  statementHandle: "handle-1",
  resultSetMetaData: {
    numRows: 1,
    rowType: [
      { name: "GAME_ID", type: "FIXED", nullable: false },
      { name: "GAME_NAME", type: "TEXT", nullable: true },
    ],
    partitionInfo: [{ rowCount: 1 }],
  },
  data: [["24601", "QA2"]],
};

/**
 * @param {ReturnType<typeof scriptedFetch>} fetch
 * @param {Partial<Parameters<typeof createSqlApiExecutor>[0]>} [overrides]
 */
function executorWith(fetch, overrides = {}) {
  const clock = fakeClock();
  /** @type {number[]} */
  const sleeps = [];
  const executor = createSqlApiExecutor({
    env: ENV,
    fetch: fetch.fetchImpl,
    now: clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
    loadKey: async () => privateKey,
    retryBackoffMs: [10, 20],
    pollAttempts: 2,
    pollIntervalMs: 5,
    ...overrides,
  });
  return { executor, sleeps };
}

test("the SQL API executor submits one bound SELECT with context and key-pair headers and decodes the result", async () => {
  const fetch = scriptedFetch([{ status: 200, body: RESULT }]);
  const { executor } = executorWith(fetch);
  assert.equal(executor.kind, "sql-api");
  assert.ok(!("privateKeyPath" in executor.config));
  const result = await executor.execute(SELECT);
  assert.deepEqual(result, { columns: [{ name: "GAME_ID", type: "FIXED" }, { name: "GAME_NAME", type: "TEXT" }], rows: [["24601", "QA2"]] });
  assert.equal(fetch.requests.length, 1);
  const request = fetch.requests[0];
  assert.ok(request);
  assert.match(request.url, /^https:\/\/testorg-testaccount\.snowflakecomputing\.com\/api\/v2\/statements\?requestId=[0-9a-f-]{36}$/);
  assert.equal(request.init.method, "POST");
  const headers = /** @type {Record<string, string>} */ (request.init.headers);
  assert.equal(headers["X-Snowflake-Authorization-Token-Type"], "KEYPAIR_JWT");
  assert.match(headers.Authorization ?? "", /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(headers["Content-Type"], "application/json");
  const body = JSON.parse(String(request.init.body));
  assert.equal(body.statement, SELECT.text);
  assert.equal(body.database, "UNITY_ANALYTICS");
  assert.equal(body.schema, "PUBLIC");
  assert.equal(body.warehouse, "REPORT_XS");
  assert.equal(body.role, undefined);
  assert.deepEqual(body.bindings, { 1: { type: "TEXT", value: "QA2" } });
  assert.deepEqual(body.parameters, { TIMEZONE: "UTC" });
  assert.equal(body.timeout, 60);
});

test("the SQL API executor polls an accepted statement and fetches every partition", async () => {
  const twoPartitions = { ...RESULT, resultSetMetaData: { ...RESULT.resultSetMetaData, partitionInfo: [{ rowCount: 1 }, { rowCount: 1 }] } };
  const fetch = scriptedFetch([
    { status: 202, body: { statementHandle: "handle-1", statementStatusUrl: "/api/v2/statements/handle-1" } },
    { status: 202, body: { statementHandle: "handle-1" } },
    { status: 200, body: twoPartitions },
    { status: 200, body: { data: [["24602", "QA2"]] } },
  ]);
  const { executor, sleeps } = executorWith(fetch);
  const result = await executor.execute(SELECT);
  assert.deepEqual(result.rows, [["24601", "QA2"], ["24602", "QA2"]]);
  assert.deepEqual(sleeps, [5, 5]);
  assert.equal(fetch.requests[1]?.url, "https://testorg-testaccount.snowflakecomputing.com/api/v2/statements/handle-1");
  assert.equal(fetch.requests[3]?.url, "https://testorg-testaccount.snowflakecomputing.com/api/v2/statements/handle-1?partition=1");
  assert.equal(fetch.requests[3]?.init.method, "GET");
});

test("the SQL API executor gives up polling after the bound", async () => {
  const pending = { status: 202, body: { statementHandle: "handle-1" } };
  const fetch = scriptedFetch([pending, pending, pending, pending]);
  const { executor } = executorWith(fetch);
  await assert.rejects(executor.execute(SELECT), (/** @type {SnowflakeError} */ err) => err.code === "timeout" && err.phase === "poll");
});

test("the SQL API executor retries 429, 5xx, and network failures with deterministic backoff, then fails", async () => {
  const ok = scriptedFetch([{ status: 503, body: { code: "000", message: "busy" } }, { status: 429 }, { status: 200, body: RESULT }]);
  const first = executorWith(ok);
  assert.equal((await first.executor.execute(SELECT)).rows.length, 1);
  assert.deepEqual(first.sleeps, [10, 20]);

  const down = scriptedFetch([{ status: 500, throws: new Error("ECONNRESET") }, { status: 500 }, { status: 500 }]);
  const second = executorWith(down);
  await assert.rejects(second.executor.execute(SELECT), (/** @type {SnowflakeError} */ err) => err.code === "http" && /HTTP 500/.test(err.message));
  assert.equal(down.requests.length, 3);
});

test("the SQL API executor does not retry client errors, maps 401/403 to auth, and never retries a read-only violation", async () => {
  const denied = scriptedFetch([{ status: 401, body: { code: "390144", message: "JWT token is invalid" } }]);
  const { executor } = executorWith(denied);
  await assert.rejects(executor.execute(SELECT), (/** @type {SnowflakeError} */ err) => err.code === "auth" && denied.requests.length === 1);

  const failed = scriptedFetch([{ status: 422, body: { code: "002003", message: "SQL compilation error", sqlState: "42S02" } }]);
  const other = executorWith(failed);
  await assert.rejects(other.executor.execute(SELECT), (/** @type {SnowflakeError} */ err) => err.code === "http" && /002003/.test(err.message));
  assert.equal(failed.requests.length, 1);

  const untouched = scriptedFetch([]);
  const guard = executorWith(untouched);
  await assert.rejects(guard.executor.execute({ name: "x", text: "DROP TABLE ACCOUNT_USERS", bindings: [] }), /single SELECT/);
  assert.equal(untouched.requests.length, 0);
});

test("a private key that cannot be loaded fails before any request and without echoing its path", async () => {
  const fetch = scriptedFetch([{ status: 200, body: RESULT }]);
  const { executor } = executorWith(fetch, {
    loadKey: async () => {
      throw new Error("ENOENT: /nonexistent/key.p8");
    },
  });
  await assert.rejects(executor.execute(SELECT), (/** @type {SnowflakeError} */ err) => err.code === "private_key" && !err.message.includes("/nonexistent"));
  assert.equal(fetch.requests.length, 0);
});

test("parseSqlApiResultSet rejects malformed bodies", () => {
  assert.throws(() => parseSqlApiResultSet({}), /rowType/);
  assert.throws(() => parseSqlApiResultSet({ resultSetMetaData: { rowType: [{ name: "A" }] }, data: [] }), /lacks name\/type/);
  assert.throws(() => parseSqlApiResultSet({ resultSetMetaData: { rowType: [] }, data: [[{}]] }), /non-string cell/);
  assert.equal(parseSqlApiResultSet({ resultSetMetaData: { rowType: [{ name: "A", type: "FIXED" }] }, data: [[7]] }).rows[0]?.[0], "7");
});
