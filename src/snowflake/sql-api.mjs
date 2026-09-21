/**
 * Snowflake SQL REST API executor (https://docs.snowflake.com/en/developer-guide/sql-api/index)
 * with key-pair JWT authentication, suitable for unattended read-only use.
 *
 * Connection facts come from the environment only (never from the command
 * line, never from repository files) and are never printed:
 *
 *   SNOWFLAKE_ACCOUNT               account identifier, e.g. ORGNAME-ACCOUNTNAME
 *   SNOWFLAKE_USER                  the service user that owns the public key
 *   SNOWFLAKE_PRIVATE_KEY_PATH      PEM (PKCS#8) private key file
 *   SNOWFLAKE_PRIVATE_KEY_PASSPHRASE optional passphrase of that file
 *   SNOWFLAKE_WAREHOUSE             warehouse to run on (expected X-Small, auto-suspend)
 *   SNOWFLAKE_DATABASE              database created from the Unity share
 *   SNOWFLAKE_SCHEMA                schema inside that database holding the views
 *   SNOWFLAKE_ROLE                  optional role
 *   SNOWFLAKE_HOST                  optional host override (default <account>.snowflakecomputing.com)
 *
 * Database, schema, warehouse, and role are passed as request context, so
 * statement text never interpolates an identifier. Every statement passes
 * the read-only guard in executor.mjs first. Transient failures (HTTP 429,
 * 5xx, network) are retried a bounded number of times with deterministic
 * backoff; an in-progress statement (HTTP 202) is polled a bounded number of
 * times. All timing goes through injectable now/sleep so tests are exact.
 */
import { randomUUID } from "node:crypto";
import { isPlainObject } from "../validate.mjs";
import { SnowflakeError, validateStatement } from "./executor.mjs";
import { buildKeyPairJwt, loadPrivateKey } from "./keypair-jwt.mjs";

/** @typedef {import("./executor.mjs").SqlExecutor} SqlExecutor */
/** @typedef {import("./executor.mjs").ResultSet} ResultSet */
/** @typedef {import("./executor.mjs").Statement} Statement */

export const USER_AGENT = "jev-cu-report/0.1.0";
export const DEFAULT_STATEMENT_TIMEOUT_SECONDS = 60;
export const DEFAULT_RETRY_ATTEMPTS = 3;
export const DEFAULT_RETRY_BACKOFF_MS = Object.freeze([1_000, 2_000, 4_000]);
export const DEFAULT_POLL_ATTEMPTS = 30;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

/** Thrown when a required SNOWFLAKE_* variable is absent or malformed. */
export class MissingSnowflakeConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MissingSnowflakeConfigError";
    this.code = "missing_snowflake_config";
  }
}

/**
 * @typedef {object} SnowflakeConfig
 * @property {string} account
 * @property {string} user
 * @property {string} privateKeyPath
 * @property {string|undefined} privateKeyPassphrase
 * @property {string} warehouse
 * @property {string} database
 * @property {string} schema
 * @property {string|null} role
 * @property {string} host
 */

/**
 * Read and validate the connection facts. Values are validated for shape
 * only and are never echoed back in error messages.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {SnowflakeConfig}
 * @throws {MissingSnowflakeConfigError}
 */
export function readSnowflakeConfig(env) {
  /**
   * @param {string} name
   * @param {RegExp} pattern
   * @param {boolean} [required]
   */
  const read = (name, pattern, required = true) => {
    const value = env[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      if (required) throw new MissingSnowflakeConfigError(`${name} is not set in the environment`);
      return null;
    }
    const trimmed = value.trim();
    if (!pattern.test(trimmed)) throw new MissingSnowflakeConfigError(`${name} has an unexpected shape (value not shown)`);
    return trimmed;
  };
  const account = /** @type {string} */ (read("SNOWFLAKE_ACCOUNT", ACCOUNT));
  const user = /** @type {string} */ (read("SNOWFLAKE_USER", /^[^\s]{1,255}$/));
  const privateKeyPath = /** @type {string} */ (read("SNOWFLAKE_PRIVATE_KEY_PATH", /^.{1,4096}$/));
  const passphrase = env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
  const warehouse = /** @type {string} */ (read("SNOWFLAKE_WAREHOUSE", IDENTIFIER));
  const database = /** @type {string} */ (read("SNOWFLAKE_DATABASE", IDENTIFIER));
  const schema = /** @type {string} */ (read("SNOWFLAKE_SCHEMA", IDENTIFIER));
  const role = read("SNOWFLAKE_ROLE", IDENTIFIER, false);
  const host = read("SNOWFLAKE_HOST", HOST, false) ?? `${account.toLowerCase()}.snowflakecomputing.com`;
  return {
    account,
    user,
    privateKeyPath,
    privateKeyPassphrase: typeof passphrase === "string" && passphrase.length > 0 ? passphrase : undefined,
    warehouse,
    database,
    schema,
    role,
    host,
  };
}

/**
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchLike
 */

/**
 * @param {unknown} raw SQL API ResultSet JSON
 * @returns {{columns: import("./executor.mjs").ResultColumn[], rows: Array<Array<string|null>>, partitions: number, statementHandle: string|null}}
 */
export function parseSqlApiResultSet(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.resultSetMetaData) || !Array.isArray(raw.resultSetMetaData.rowType)) {
    throw new SnowflakeError("SQL API response has no resultSetMetaData.rowType", { code: "protocol" });
  }
  const columns = raw.resultSetMetaData.rowType.map((c, i) => {
    if (!isPlainObject(c) || typeof c.name !== "string" || typeof c.type !== "string") {
      throw new SnowflakeError(`SQL API rowType[${i}] lacks name/type`, { code: "protocol" });
    }
    return { name: c.name, type: c.type };
  });
  const partitionInfo = raw.resultSetMetaData.partitionInfo;
  const partitions = Array.isArray(partitionInfo) ? Math.max(1, partitionInfo.length) : 1;
  const rows = parseData(raw.data);
  return { columns, rows, partitions, statementHandle: typeof raw.statementHandle === "string" ? raw.statementHandle : null };
}

/**
 * @param {unknown} data
 * @returns {Array<Array<string|null>>}
 */
function parseData(data) {
  if (!Array.isArray(data)) throw new SnowflakeError("SQL API response data is not an array", { code: "protocol" });
  return data.map((row, r) => {
    if (!Array.isArray(row)) throw new SnowflakeError(`SQL API data row ${r} is not an array`, { code: "protocol" });
    return row.map((cell) => {
      if (cell === null) return null;
      if (typeof cell === "string") return cell;
      // The API documents strings for every type; tolerate a bare JSON number.
      if (typeof cell === "number" && Number.isFinite(cell)) return String(cell);
      throw new SnowflakeError(`SQL API data row ${r} has a non-string cell`, { code: "protocol" });
    });
  });
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function describeFailure(body) {
  if (!isPlainObject(body)) return "no error body";
  const code = typeof body.code === "string" ? body.code : "?";
  const message = typeof body.message === "string" ? body.message.slice(0, 500) : "no message";
  return `code ${code}: ${message}`;
}

/**
 * @param {{env?: NodeJS.ProcessEnv, fetch?: FetchLike, now?: () => number, sleep?: (ms: number) => Promise<void>, retryBackoffMs?: readonly number[], pollAttempts?: number, pollIntervalMs?: number, statementTimeoutSeconds?: number, loadKey?: typeof loadPrivateKey}} [options]
 * @returns {SqlExecutor & {config: Omit<SnowflakeConfig, "privateKeyPath"|"privateKeyPassphrase">}}
 */
export function createSqlApiExecutor({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
  pollAttempts = DEFAULT_POLL_ATTEMPTS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  statementTimeoutSeconds = DEFAULT_STATEMENT_TIMEOUT_SECONDS,
  loadKey = loadPrivateKey,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("a fetch implementation is required (Node 20+ provides one)");
  const config = readSnowflakeConfig(env);
  const { privateKeyPath, privateKeyPassphrase, ...publicConfig } = config;
  const base = `https://${config.host}`;
  /** @type {import("node:crypto").KeyObject|null} */
  let privateKey = null;

  const token = async () => {
    if (privateKey === null) {
      try {
        privateKey = await loadKey({ path: privateKeyPath, passphrase: privateKeyPassphrase });
      } catch {
        // The underlying error can echo the path; the message stays generic.
        throw new SnowflakeError("cannot load the Snowflake private key (path and passphrase not shown)", {
          code: "private_key",
          phase: "auth",
        });
      }
    }
    return buildKeyPairJwt({ account: config.account, user: config.user, privateKey, nowSeconds: Math.floor(now() / 1000) }).token;
  };

  /**
   * One HTTP call with bounded retries on transient failures.
   * @param {string} url
   * @param {RequestInit} init
   * @param {string} phase
   * @returns {Promise<{status: number, body: unknown}>}
   */
  const call = async (url, init, phase) => {
    /** @type {unknown} */
    let lastError = null;
    for (let attempt = 0; attempt <= retryBackoffMs.length; attempt += 1) {
      if (attempt > 0) await sleep(retryBackoffMs[attempt - 1] ?? 0);
      const bearer = await token(); // key problems are not network failures: no retry
      let response;
      try {
        response = await fetchImpl(url, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${bearer}`,
            "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
        });
      } catch (err) {
        lastError = new SnowflakeError(`network failure during ${phase}: ${err instanceof Error ? err.message : String(err)}`, {
          code: "network",
          phase,
          cause: err,
        });
        continue;
      }
      /** @type {unknown} */
      let body = null;
      const text = await response.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new SnowflakeError(`SQL API ${phase} failed with HTTP ${response.status} (${describeFailure(body)})`, {
          code: "http",
          phase,
          details: { status: response.status },
        });
        continue;
      }
      return { status: response.status, body };
    }
    throw lastError instanceof Error ? lastError : new SnowflakeError(`SQL API ${phase} failed`, { code: "http", phase });
  };

  /**
   * @param {string} handle
   * @param {number} partition
   */
  const fetchPartition = async (handle, partition) => {
    const { status, body } = await call(`${base}/api/v2/statements/${encodeURIComponent(handle)}?partition=${partition}`, { method: "GET" }, "partition");
    if (status !== 200 || !isPlainObject(body)) {
      throw new SnowflakeError(`partition ${partition} fetch returned HTTP ${status} (${describeFailure(body)})`, { code: "http", phase: "partition" });
    }
    return parseData(body.data);
  };

  return {
    kind: "sql-api",
    config: publicConfig,
    async execute(statement) {
      const valid = validateStatement(statement);
      /** @type {Record<string, {type: string, value: string}>} */
      const bindings = {};
      valid.bindings.forEach((b, i) => {
        bindings[String(i + 1)] = { type: b.type, value: b.value };
      });
      const requestBody = {
        statement: valid.text,
        timeout: statementTimeoutSeconds,
        database: config.database,
        schema: config.schema,
        warehouse: config.warehouse,
        ...(config.role ? { role: config.role } : {}),
        bindings,
        parameters: { TIMEZONE: "UTC" },
      };
      const requestId = randomUUID();
      let { status, body } = await call(
        `${base}/api/v2/statements?requestId=${requestId}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) },
        "submit",
      );
      let polls = 0;
      while (status === 202) {
        if (!isPlainObject(body) || typeof body.statementHandle !== "string") {
          throw new SnowflakeError("SQL API accepted the statement without a handle", { code: "protocol", phase: "poll" });
        }
        if (polls >= pollAttempts) {
          throw new SnowflakeError(`statement ${valid.name} did not finish within ${pollAttempts} polls`, { code: "timeout", phase: "poll" });
        }
        polls += 1;
        await sleep(pollIntervalMs);
        ({ status, body } = await call(`${base}/api/v2/statements/${encodeURIComponent(body.statementHandle)}`, { method: "GET" }, "poll"));
      }
      if (status !== 200) {
        throw new SnowflakeError(`statement ${valid.name} failed with HTTP ${status} (${describeFailure(body)})`, {
          code: status === 401 || status === 403 ? "auth" : "http",
          phase: "submit",
          details: { status },
        });
      }
      const parsed = parseSqlApiResultSet(body);
      const rows = parsed.rows;
      for (let p = 1; p < parsed.partitions; p += 1) {
        if (parsed.statementHandle === null) throw new SnowflakeError("multi-partition result without a handle", { code: "protocol" });
        rows.push(...(await fetchPartition(parsed.statementHandle, p)));
      }
      return { columns: parsed.columns, rows };
    },
  };
}
