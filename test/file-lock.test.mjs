import assert from "node:assert/strict";
import test from "node:test";

import lockfile from "proper-lockfile";

import { acquireFileLock, runWithLockRelease } from "../src/file-lock.mjs";

const INITIAL_TIME = 1_700_000_000_000;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const fsError = (code) => Object.assign(new Error(`Synthetic filesystem ${code}`), { code });

// Use the actual, unmodified dependency with its public fs option and a fake
// clock. Callback completion order is controlled without host filesystem I/O,
// wall-clock sleeps, exception handlers, or dependency-source replacement.
function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: INITIAL_TIME });
  const directories = new Map();
  const pending = [];
  let removalError;
  const dispatch = (kind, file, complete) => pending.push({ kind, file, complete });
  const fs = {
    mkdir(file, callback) {
      dispatch("mkdir", file, () => {
        if (directories.has(file)) return callback(fsError("EEXIST"));
        directories.set(file, Date.now());
        callback(null);
      });
    },
    stat(file, callback) {
      dispatch("stat", file, () => {
        if (!directories.has(file)) return callback(fsError("ENOENT"));
        callback(null, { mtime: new Date(directories.get(file)) });
      });
    },
    utimes(file, _atime, mtime, callback) {
      dispatch("utimes", file, () => {
        if (!directories.has(file)) return callback(fsError("ENOENT"));
        directories.set(file, mtime.getTime());
        callback(null);
      });
    },
    rmdir(file, callback) {
      dispatch("rmdir", file, () => {
        if (removalError) return callback(removalError);
        if (!directories.delete(file)) return callback(fsError("ENOENT"));
        callback(null);
      });
    },
    rmdirSync(file) { directories.delete(file); },
    realpath(file, callback) { callback(null, file); },
  };
  const target = "/synthetic/router-operation";
  const lockPath = `${target}.lock`;
  const options = { fs, realpath: false, lockfilePath: lockPath, stale: 30_000, update: 1_000, retries: 0 };
  function complete(kind, { last = false } = {}) {
    const index = last
      ? pending.findLastIndex((item) => item.kind === kind)
      : pending.findIndex((item) => item.kind === kind);
    assert.ok(index >= 0, `No pending ${kind} callback`);
    const [operation] = pending.splice(index, 1);
    operation.complete();
  }
  function flush() {
    while (pending.length) complete(pending[0].kind);
  }
  async function acquire(api = acquireFileLock, override = {}) {
    const acquiring = api(target, { ...options, ...override });
    await nextTurn();
    flush();
    return acquiring;
  }
  return { fs, options, target, lockPath, directories, pending, complete, flush, acquire,
    failRemoval(error) { removalError = error; } };
}

test("the unmodified dependency reproduces a stat compromise after successful release", async (t) => {
  const env = fixture(t);
  const release = await env.acquire(lockfile.lock);
  t.mock.timers.tick(1_000);
  assert.deepEqual(env.pending.map(({ kind }) => kind), ["stat"]);
  const releasing = release();
  env.complete("rmdir");
  await releasing;
  assert.equal(env.directories.has(env.lockPath), false);
  assert.throws(() => env.complete("stat"), { code: "ECOMPROMISED" });
  await assert.rejects(release(), { code: "ERELEASED" });
});

test("release drains a pending stat and its nested utimes before removing the lease", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  const releasing = release();
  assert.deepEqual(env.pending.map(({ kind }) => kind), ["stat"]);
  assert.equal(env.directories.has(env.lockPath), true);

  env.complete("stat");
  assert.deepEqual(env.pending.map(({ kind }) => kind), ["utimes"]);
  env.complete("utimes");
  await nextTurn();
  assert.deepEqual(env.pending.map(({ kind }) => kind), ["rmdir"]);
  env.complete("rmdir");
  await releasing;
  assert.equal(env.directories.has(env.lockPath), false);
  t.mock.timers.tick(60_000);
  assert.equal(env.pending.length, 0, "released lease must dispatch no further heartbeat I/O");
  await assert.rejects(release(), { code: "ERELEASED" });
});

test("pending release excludes another acquisition and cannot update a reacquired lease", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  const releasing = release();

  const contender = acquireFileLock(env.target, env.options);
  const contention = assert.rejects(contender, { code: "ELOCKED" });
  await nextTurn();
  env.complete("mkdir");
  env.complete("stat", { last: true });
  await contention;
  assert.deepEqual(env.pending.map(({ kind }) => kind), ["stat"]);
  assert.equal(env.directories.has(env.lockPath), true);

  env.complete("stat");
  env.complete("utimes");
  await nextTurn();
  env.complete("rmdir");
  await releasing;
  const nextRelease = await env.acquire();
  const acquiredMtime = env.directories.get(env.lockPath);
  await assert.rejects(release(), { code: "ERELEASED" });
  assert.equal(env.directories.get(env.lockPath), acquiredMtime, "the old release cannot change the new lease");
  t.mock.timers.tick(1_000);
  env.complete("stat");
  env.complete("utimes");
  const nextReleasing = nextRelease();
  env.complete("rmdir");
  await nextReleasing;
  assert.equal(env.pending.length, 0);
});

for (const mode of ["removed", "changed-mtime"]) {
  for (const releaseStarted of [false, true]) {
    test(`an active ${mode} lease still throws${releaseStarted ? " while release drains I/O" : ""}`, async (t) => {
      const env = fixture(t);
      const release = await env.acquire();
      t.mock.timers.tick(1_000);
      const releasing = releaseStarted ? assert.rejects(release(), { code: "ERELEASED" }) : undefined;
      if (mode === "removed") env.directories.delete(env.lockPath);
      else env.directories.set(env.lockPath, env.directories.get(env.lockPath) + 7);
      assert.throws(() => env.complete("stat"), { code: "ECOMPROMISED" });
      if (releasing) await releasing;
      else await assert.rejects(release(), { code: "ERELEASED" });
      assert.equal(env.pending.length, 0, "compromise must not turn into a successful removal");
    });
  }
}

test("a compromised utimes callback cannot become a successful pending release", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  env.complete("stat");
  const releasing = assert.rejects(release(), { code: "ERELEASED" });
  env.directories.delete(env.lockPath);
  assert.throws(() => env.complete("utimes"), { code: "ECOMPROMISED" });
  await releasing;
  assert.equal(env.pending.length, 0);
});

test("a caller's active compromise handler is preserved", async (t) => {
  const env = fixture(t);
  const errors = [];
  const release = await env.acquire(acquireFileLock, { onCompromised: (error) => errors.push(error) });
  t.mock.timers.tick(1_000);
  env.directories.delete(env.lockPath);
  env.complete("stat");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "ECOMPROMISED");
  await assert.rejects(release(), { code: "ERELEASED" });
});

test("a never-settled heartbeat bounds release, retains exclusion, and allows safe retry", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  const releasing = assert.rejects(release(), { code: "ELOCKDRAIN" });
  t.mock.timers.tick(10_000);
  await releasing;
  assert.equal(env.directories.has(env.lockPath), true);
  assert.deepEqual(env.pending.map(({ kind }) => kind), ["stat"]);

  const contender = acquireFileLock(env.target, env.options);
  const contention = assert.rejects(contender, { code: "ELOCKED" });
  await nextTurn();
  env.complete("mkdir");
  env.complete("stat", { last: true });
  await contention;
  env.complete("stat");
  env.complete("utimes");
  const retry = release();
  env.complete("rmdir");
  await retry;
  assert.equal(env.directories.has(env.lockPath), false);
  t.mock.timers.tick(60_000);
  assert.equal(env.pending.length, 0);
});

test("synchronous filesystem callbacks and throws do not leak the pending count", async (t) => {
  const env = fixture(t);
  for (const method of ["stat", "utimes"]) {
    const dispatch = env.fs[method];
    env.fs[method] = (...args) => {
      dispatch(...args);
      env.complete(method);
    };
  }
  const release = await env.acquire();
  t.mock.timers.tick(1_000);
  assert.equal(env.pending.length, 0);
  const dispatchError = fsError("EIO");
  env.fs.stat = () => { throw dispatchError; };
  assert.throws(() => t.mock.timers.tick(1_000), (error) => error === dispatchError);
  const releasing = release();
  assert.deepEqual(env.pending.map(({ kind }) => kind), ["rmdir"]);
  env.complete("rmdir");
  await releasing;
});

test("a synchronous compromised stat callback still throws without leaking the pending count", async (t) => {
  const env = fixture(t);
  const release = await env.acquire();
  const dispatch = env.fs.stat;
  env.fs.stat = (...args) => {
    dispatch(...args);
    env.complete("stat");
  };
  env.directories.delete(env.lockPath);
  assert.throws(() => t.mock.timers.tick(1_000), { code: "ECOMPROMISED" });
  await assert.rejects(release(), { code: "ERELEASED" });
  assert.equal(env.pending.length, 0);
});

test("real release failures remain visible and retain the original operation error", async (t) => {
  const env = fixture(t);
  const removalError = fsError("EACCES");
  for (const operationError of [undefined, new Error("operation failed"), Object.freeze(new Error("frozen operation failed")), null]) {
    const release = await env.acquire();
    env.failRemoval(removalError);
    const hasOperationError = operationError !== undefined;
    const operation = runWithLockRelease(async () => {
      if (hasOperationError) throw operationError;
      return "completed";
    }, release);
    const rejected = assert.rejects(operation, (error) => error === (hasOperationError ? operationError : removalError));
    await nextTurn();
    env.complete("rmdir");
    await rejected;
    assert.equal(env.directories.has(env.lockPath), true);
    if (operationError && !Object.isFrozen(operationError)) assert.equal(operationError.lockReleaseError, removalError);
    env.directories.delete(env.lockPath);
    env.failRemoval(undefined);
  }
});

test("acquisition filesystem errors retain their code and do not start a lease", async (t) => {
  const env = fixture(t);
  const acquisitionError = fsError("EACCES");
  env.fs.mkdir = (_file, callback) => callback(acquisitionError);
  await assert.rejects(acquireFileLock(env.target, env.options), (error) => error === acquisitionError);
  t.mock.timers.tick(60_000);
  assert.equal(env.pending.length, 0);
  assert.equal(env.directories.size, 0);
});
