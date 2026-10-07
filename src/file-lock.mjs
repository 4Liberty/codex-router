import fs from "node:fs";

const HEARTBEAT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * proper-lockfile 4.1.2 does not check whether a lease was released before
 * handling a pending heartbeat stat. That callback can throw ECOMPROMISED
 * after a successful unlock, or update a new owner's directory. Drain both
 * heartbeat I/O steps before unlocking, using the public fs option; leave
 * acquisition, stale recovery, and the active onCompromised handler intact.
 * Load the dependency lazily so setup can still reach dependency repair.
 */
export async function acquireFileLock(file, options = {}) {
  const { default: lockfile } = await import("proper-lockfile");
  const sourceFs = options.fs || fs;
  let pending = 0;
  const waiters = new Set();

  function track(method) {
    return (...args) => {
      const callback = args.pop();
      pending += 1;
      let completed = false;
      function finish() {
        if (completed) return;
        completed = true;
        pending -= 1;
        if (pending === 0) {
          for (const waiter of waiters) waiter.finish();
        }
      }
      try {
        return sourceFs[method](...args, (...result) => {
          // The stat callback can synchronously start utimes. Count it until
          // that callback returns so release cannot cut between the two steps.
          try { callback(...result); } finally { finish(); }
        });
      } catch (error) {
        // Also settle a synchronous fs throw or a synchronous callback throw.
        finish();
        throw error;
      }
    };
  }

  const release = await lockfile.lock(file, {
    ...options,
    fs: { ...sourceFs, stat: track("stat"), utimes: track("utimes") },
  });

  function drain() {
    return new Promise((resolve, reject) => {
      const waiter = {
        finish() {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(Object.assign(new Error(
          "Lock heartbeat I/O did not finish before the release deadline; the lease was retained.",
        ), { code: "ELOCKDRAIN" }));
      }, HEARTBEAT_DRAIN_TIMEOUT_MS);
      waiters.add(waiter);
    });
  }

  return async () => {
    // With no pending I/O, enter unlock synchronously so it cancels the next
    // heartbeat timer before another callback can dispatch filesystem work.
    if (pending > 0) await drain();
    return release();
  };
}

// An unlock error must be visible without replacing the failure that caused
// cleanup. Keep the operation error's identity, including rollback markers.
export async function runWithLockRelease(operation, release) {
  let result;
  let operationError;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await release();
  } catch (error) {
    if (!operationFailed) throw error;
    if (operationError && typeof operationError === "object") {
      try { operationError.lockReleaseError = error; } catch {}
    }
  }
  if (operationFailed) throw operationError;
  return result;
}
