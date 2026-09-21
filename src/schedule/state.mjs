/**
 * Durable run state for the daily job: per-target-date records and an
 * exclusive run lock, both plain files inside one caller-owned state
 * directory (on a deployment, a systemd StateDirectory or similar).
 *
 * Idempotency contract: a record exists only after the Slack send was
 * verified (or the report's own duplicate marker was found in the channel,
 * which means a verified send happened in some earlier run). A record is
 * written atomically (temp file + rename in the same directory) so a crash
 * can leave either the old or the new state, never a torn one. A corrupt or
 * unreadable record is an error, never silently ignored: fail closed rather
 * than risk a second post for the same date.
 *
 * Lock contract: O_EXCL create of `<stateDir>/run.lock` holding the holder
 * pid, start instant, and the kernel boot id. A lock is stale - and may be
 * broken - when it names a boot other than the current one (left over from
 * before a reboot), when its pid no longer exists, or when it is older than
 * the staleness bound (covers pid reuse). Otherwise the lock is honored and
 * the caller skips: exactly one run executes.
 */
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** How long a lock from the same boot with a live pid may stay before it may be broken. */
export const LOCK_STALE_MS = 12 * 60 * 60 * 1000;
const LOCK_FILE = "run.lock";
const BREAKER_FILE = "run.lock.breaker";
const RECORDS_DIR = "records";

/**
 * The kernel boot id of the running system, or null when it cannot be read
 * (non-Linux). Used to recognize locks left over from before a reboot.
 * @returns {string|null}
 */
export function currentBootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * @param {number} pid
 * @returns {boolean} whether the process exists (signal 0 probe)
 */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/** @typedef {{date: string, status: "posted", postedAt: string, attempts: number, recordedAt: string}} PostedRecord */

/**
 * @param {unknown} value
 * @returns {PostedRecord|null} the parsed record, or null when the file holds another shape
 */
function parseRecord(value) {
  if (typeof value !== "object" || value === null) return null;
  const r = /** @type {Record<string, unknown>} */ (value);
  if (r.status !== "posted" || typeof r.date !== "string" || typeof r.postedAt !== "string") return null;
  return {
    date: r.date,
    status: "posted",
    postedAt: r.postedAt,
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    recordedAt: typeof r.recordedAt === "string" ? r.recordedAt : r.postedAt,
  };
}

/** @typedef {{read: (date: string) => Promise<PostedRecord|null>, write: (record: PostedRecord) => Promise<void>}} RecordStore */

/**
 * File-backed RecordStore: `<dir>/records/<date>.json`, written atomically.
 * @implements {RecordStore}
 */
export class FileRecordStore {
  /** @param {string} dir the state directory (records live in `records/` below it) */
  constructor(dir) {
    this.recordsDir = join(dir, RECORDS_DIR);
  }

  /**
   * @param {string} date
   * @returns {Promise<PostedRecord|null>}
   */
  async read(date) {
    let text;
    try {
      text = await readFile(join(this.recordsDir, `${date}.json`), "utf8");
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`state record for ${date} is not valid JSON; investigate before rerunning`);
    }
    const record = parseRecord(parsed);
    if (!record) throw new Error(`state record for ${date} has an unknown shape; investigate before rerunning`);
    return record;
  }

  /**
   * @param {PostedRecord} record
   * @returns {Promise<void>}
   */
  async write(record) {
    await mkdir(this.recordsDir, { recursive: true });
    const path = join(this.recordsDir, `${record.date}.json`);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFileExclusive(temp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temp, path);
  }
}

/**
 * Create a file exclusively and write text, failing if it exists.
 * @param {string} path
 * @param {string} text
 */
async function writeFileExclusive(path, text) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

/** @typedef {{pid: number, startedAt: string, bootId: string|null}} LockHolder */
/** @typedef {{ok: true, release: () => Promise<void>} | {ok: false, holder: LockHolder|null}} LockResult */

/**
 * Acquire the exclusive run lock, breaking a provably stale one (a lock from
 * a previous boot, a dead pid, or older than `staleMs`). Directory is
 * created if missing.
 *
 * @param {{dir: string, pid?: number, bootId?: string|null, now?: () => number, staleMs?: number}} input
 * @returns {Promise<LockResult>}
 */
export async function acquireRunLock({ dir, pid = process.pid, bootId = currentBootId(), now = Date.now, staleMs = LOCK_STALE_MS }) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  /** @type {LockHolder|null} */
  let holder = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      const startedAt = new Date(now()).toISOString();
      const mine = /** @type {LockHolder} */ ({ pid, startedAt, bootId: bootId ?? null });
      try {
        await handle.writeFile(`${JSON.stringify(mine)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return {
        ok: true,
        release: async () => {
          // Best-effort and idempotent; a broken stale lock by a later
          // supervisor must not turn into a crash of the current holder.
          try {
            const current = await readFile(path, "utf8");
            const parsed = JSON.parse(current);
            if (parsed?.pid !== pid) return; // our lock was replaced; leave it
          } catch {
            /* gone or unreadable: nothing to release */
          }
          await unlink(path).catch(() => {});
        },
      };
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      holder = await readHolder(path);
      const mtimeMs = await lockMtimeMs(path);
      if (!isStale(holder, mtimeMs, { now: now(), bootId, staleMs })) return { ok: false, holder };
      const breakerPath = join(dir, BREAKER_FILE);
      try {
        await writeFileExclusive(breakerPath, `${pid}\n`);
      } catch (breakerError) {
        if (/** @type {NodeJS.ErrnoException} */ (breakerError).code === "EEXIST") return { ok: false, holder };
        throw breakerError;
      }
      try {
        holder = await readHolder(path);
        const currentMtimeMs = await lockMtimeMs(path);
        if (!isStale(holder, currentMtimeMs, { now: now(), bootId, staleMs })) return { ok: false, holder };
        await unlink(path).catch(() => {});
      } finally {
        await unlink(breakerPath).catch(() => {});
      }
    }
  }
  return { ok: false, holder };
}

/**
 * @param {string} path
 * @returns {Promise<LockHolder|null>}
 */
async function readHolder(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed?.pid !== "number") return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      bootId: typeof parsed.bootId === "string" ? parsed.bootId : null,
    };
  } catch {
    return null; // unreadable or torn lock: treated as stale by the caller's age bound
  }
}

/**
 * @param {string} path
 * @returns {Promise<number>} the lock file's mtime in ms, or 0 when unreadable
 */
async function lockMtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * A lock is stale only when it can be proven stale: a different boot id, a
 * dead pid, an unparseable startedAt, or an age past the bound. An empty or
 * unreadable lock that is young is treated as live: its creator may still be
 * writing it (create and write are two steps), and breaking it would let two
 * runs proceed at once. The age bound is the only escape from a lock file
 * whose writer died between creating and writing.
 *
 * @param {LockHolder|null} holder
 * @param {number} mtimeMs
 * @param {{now: number, bootId: string|null, staleMs: number}} context
 * @returns {boolean}
 */
function isStale(holder, mtimeMs, { now, bootId, staleMs }) {
  if (now - mtimeMs > staleMs) return true;
  if (!holder) return false;
  if (holder.bootId !== null && bootId !== null && holder.bootId !== bootId) return true;
  const startedMs = Date.parse(holder.startedAt);
  if (!Number.isFinite(startedMs) || now - startedMs > staleMs) return true;
  return !pidAlive(holder.pid);
}

/**
 * Read the run lock's holder without acquiring, for reporting.
 * @param {string} dir
 * @returns {Promise<LockHolder|null>}
 */
export async function readLockHolder(dir) {
  return readHolder(join(dir, LOCK_FILE));
}
