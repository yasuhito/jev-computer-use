import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRecordStore, acquireRunLock, readLockHolder, LOCK_STALE_MS } from "../src/schedule/state.mjs";

const BOOT = "11111111-2222-3333-4444-555555555555";
/** Near the real clock so lock-file mtimes compare sanely against it. */
const NOW = Date.now();

/** @returns {Promise<string>} */
async function tempState() {
  return mkdtemp(join(tmpdir(), "jev-cu-state-"));
}

/** A pid that no longer exists: spawn a child, let it exit, keep its pid. */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""]);
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  assert.equal(code, 0);
  return child.pid;
}

test("FileRecordStore round-trips one record per date and reads nothing for an unrecorded date", async () => {
  const dir = await tempState();
  try {
    const store = new FileRecordStore(dir);
    const record = { date: "2026-09-20", status: /** @type {const} */ ("posted"), postedAt: "2026-09-21T01:00:00Z", attempts: 2, recordedAt: "2026-09-21T01:00:01Z" };
    await store.write(record);
    assert.deepEqual(await store.read("2026-09-20"), record);
    assert.equal(await store.read("2026-09-21"), null);
    // Atomic write: only the record file exists, no temp leftovers.
    assert.deepEqual(await readdir(join(dir, "records")), ["2026-09-20.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt or unknown-shape record is an error, never silently ignored", async () => {
  const dir = await tempState();
  try {
    const store = new FileRecordStore(dir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "records"), { recursive: true });
    for (const text of ["{not json", '{"status":"posted"}', '{"status":"failed","date":"2026-09-20"}']) {
      await writeFile(join(dir, "records", "2026-09-20.json"), text);
      await assert.rejects(store.read("2026-09-20"), /investigate/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the run lock is exclusive until released", async () => {
  const dir = await tempState();
  try {
    const first = await acquireRunLock({ dir, bootId: BOOT, now: () => NOW });
    assert.equal(first.ok, true);
    const second = await acquireRunLock({ dir, bootId: BOOT, now: () => NOW + 1000 });
    assert.equal(second.ok, false);
    assert.equal(second.ok ? null : second.holder?.pid, process.pid);
    await first.release();
    const third = await acquireRunLock({ dir, bootId: BOOT, now: () => NOW + 2000 });
    assert.equal(third.ok, true);
    await third.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock from a previous boot is broken even while its pid is alive", async () => {
  const dir = await tempState();
  try {
    const holder = { pid: process.pid, startedAt: new Date(NOW).toISOString(), bootId: "previous-boot" };
    await writeFile(join(dir, "run.lock"), `${JSON.stringify(holder)}\n`);
    const acquired = await acquireRunLock({ dir, bootId: BOOT, now: () => NOW + 1000 });
    assert.equal(acquired.ok, true);
    await acquired.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock whose pid is dead is broken", async () => {
  const dir = await tempState();
  const pid = await deadPid();
  try {
    const holder = { pid, startedAt: new Date(NOW).toISOString(), bootId: BOOT };
    await writeFile(join(dir, "run.lock"), `${JSON.stringify(holder)}\n`);
    const acquired = await acquireRunLock({ dir, bootId: BOOT, now: () => NOW + 1000 });
    assert.equal(acquired.ok, true);
    await acquired.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock older than the staleness bound is broken even if its pid is alive (pid reuse)", async () => {
  const dir = await tempState();
  try {
    const holder = { pid: process.pid, startedAt: new Date(NOW - LOCK_STALE_MS - 1).toISOString(), bootId: BOOT };
    await writeFile(join(dir, "run.lock"), `${JSON.stringify(holder)}\n`);
    const acquired = await acquireRunLock({ dir, bootId: BOOT, now: () => NOW });
    assert.equal(acquired.ok, true);
    await acquired.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent stale-lock breakers allow exactly one replacement holder", async () => {
  const dir = await tempState();
  try {
    const holder = { pid: process.pid, startedAt: new Date(NOW - LOCK_STALE_MS - 1).toISOString(), bootId: BOOT };
    await writeFile(join(dir, "run.lock"), `${JSON.stringify(holder)}\n`);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => acquireRunLock({ dir, pid: process.pid, bootId: BOOT, now: () => NOW })),
    );
    const acquired = results.filter((result) => result.ok);
    assert.equal(acquired.length, 1);
    const [lock] = acquired;
    assert.ok(lock);
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a young lock with no readable holder is treated as live, not broken", async () => {
  const dir = await tempState();
  try {
    // Simulates the window between lock creation and its content write.
    await writeFile(join(dir, "run.lock"), "");
    const acquired = await acquireRunLock({ dir, bootId: BOOT, now: () => NOW + 1000 });
    assert.equal(acquired.ok, false);
    // The same unreadable lock past the bound is broken.
    await writeFile(join(dir, "run.lock"), "");
    const utimes = await import("node:fs/promises").then((m) => m.utimes);
    const old = new Date(NOW - LOCK_STALE_MS - 1);
    await utimes(join(dir, "run.lock"), old, old);
    const second = await acquireRunLock({ dir, bootId: BOOT, now: () => NOW });
    assert.equal(second.ok, true);
    await second.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLockHolder reports the current holder", async () => {
  const dir = await tempState();
  try {
    assert.equal(await readLockHolder(dir), null);
    const acquired = await acquireRunLock({ dir, bootId: BOOT, now: () => NOW });
    assert.equal(acquired.ok, true);
    const holder = await readLockHolder(dir);
    assert.equal(holder?.pid, process.pid);
    assert.equal(holder?.bootId, BOOT);
    await acquired.release();
    assert.equal(await readLockHolder(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the lock file is readable JSON with pid, start instant, and boot id", async () => {
  const dir = await tempState();
  try {
    const acquired = await acquireRunLock({ dir, bootId: BOOT, now: () => NOW });
    assert.equal(acquired.ok, true);
    const parsed = JSON.parse(await readFile(join(dir, "run.lock"), "utf8"));
    assert.equal(parsed.pid, process.pid);
    assert.equal(parsed.bootId, BOOT);
    assert.equal(Date.parse(parsed.startedAt), NOW);
    await acquired.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
