/**
 * Key-pair JWT for the Snowflake SQL API (RS256), built with node:crypto
 * only. Follows https://docs.snowflake.com/en/developer-guide/sql-api/authenticating:
 *
 *   iss = <ACCOUNT>.<USER>.SHA256:<base64 sha256 of the DER public key>
 *   sub = <ACCOUNT>.<USER>
 *   iat / exp in seconds; Snowflake caps validity at one hour
 *
 * The account identifier and user are uppercased; a locator with region
 * segments ("xy12345.us-central1.gcp") keeps only its first segment because
 * region information must be excluded, and any remaining "." becomes "-".
 *
 * The private key never leaves this module: it is loaded from a file path,
 * used to sign, and neither logged nor returned.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Snowflake refuses tokens that claim more than one hour. */
export const MAX_JWT_LIFETIME_SECONDS = 3600;
export const DEFAULT_JWT_LIFETIME_SECONDS = 600;

/**
 * @param {string} account raw SNOWFLAKE_ACCOUNT value
 * @returns {string}
 */
export function jwtAccountIdentifier(account) {
  const trimmed = account.trim();
  if (trimmed.length === 0) throw new Error("account identifier is empty");
  const firstSegment = trimmed.split(".")[0] ?? trimmed;
  return firstSegment.toUpperCase().replace(/\./g, "-");
}

/**
 * @param {import("node:crypto").KeyObject} privateKey
 * @returns {string} "SHA256:<base64>"
 */
export function publicKeyFingerprint(privateKey) {
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}

/** @param {string|Buffer} input */
function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {{account: string, user: string, privateKey: import("node:crypto").KeyObject, nowSeconds: number, lifetimeSeconds?: number}} input
 * @returns {{token: string, claims: {iss: string, sub: string, iat: number, exp: number}}}
 */
export function buildKeyPairJwt({ account, user, privateKey, nowSeconds, lifetimeSeconds = DEFAULT_JWT_LIFETIME_SECONDS }) {
  if (typeof user !== "string" || user.trim().length === 0) throw new Error("user is empty");
  if (!Number.isInteger(nowSeconds)) throw new Error("nowSeconds must be an integer");
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > MAX_JWT_LIFETIME_SECONDS) {
    throw new Error(`lifetimeSeconds must be an integer in 1..${MAX_JWT_LIFETIME_SECONDS}`);
  }
  const qualifiedUser = `${jwtAccountIdentifier(account)}.${user.trim().toUpperCase()}`;
  const claims = {
    iss: `${qualifiedUser}.${publicKeyFingerprint(privateKey)}`,
    sub: qualifiedUser,
    iat: nowSeconds,
    exp: nowSeconds + lifetimeSeconds,
  };
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = base64url(sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey));
  return { token: `${header}.${payload}.${signature}`, claims };
}

/**
 * Load a PEM (PKCS#8, optionally encrypted) private key from disk.
 *
 * @param {{path: string, passphrase?: string|undefined}} input
 * @returns {Promise<import("node:crypto").KeyObject>}
 */
export async function loadPrivateKey({ path, passphrase }) {
  const pem = await readFile(path, "utf8");
  return createPrivateKey(passphrase ? { key: pem, passphrase } : { key: pem });
}
