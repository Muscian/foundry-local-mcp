import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_LOCK_DIR = path.join(os.homedir(), ".foundry-local-mcp");

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return defaultValue;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "EPERM" ? false : true;
  }
}

async function readLock(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeLock(lockPath, record) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`);
  await fs.rename(tempPath, lockPath);
}

async function tryCreateLock(lockPath, record) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await fs.writeFile(lockPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcess(pid, log) {
  if (pid === process.pid) return;
  try {
    if (process.platform === "win32") {
      const { spawn } = await import("node:child_process");
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
    log?.(`Terminated older instance pid ${pid}`);
  } catch (error) {
    if (error.code !== "ESRCH") {
      log?.(`Could not terminate pid ${pid}: ${error.message}`);
    }
  }
}

export function createInstanceCoordinator({
  log,
  enabled = parseBoolean(process.env.FOUNDRY_LOCAL_MCP_SINGLE_INSTANCE, true),
  lockPath = path.join(
    process.env.FOUNDRY_LOCAL_MCP_LOCK_DIR || DEFAULT_LOCK_DIR,
    "instance.json"
  ),
  host,
  ports
}) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const instanceId = randomUUID();
  let shuttingDown = false;
  let onShutdown = null;

  function myRecord(extra = {}) {
    return {
      instanceId,
      pid: process.pid,
      startedAt,
      startedAtMs,
      host,
      ports,
      argv: process.argv.slice(0, 4),
      heartbeatAt: new Date().toISOString(),
      ...extra
    };
  }

  async function releaseLock() {
    const lock = await readLock(lockPath);
    if (lock?.instanceId === instanceId && lock?.pid === process.pid) {
      await fs.unlink(lockPath).catch(() => {});
    }
  }

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log?.(`Shutting down: ${reason}`);
    try {
      if (onShutdown) await onShutdown();
    } finally {
      await releaseLock();
      process.exit(0);
    }
  }

  async function removeStaleLock(lock) {
    if (!lock) return false;
    if (lock.pid === process.pid) return false;
    if (isProcessAlive(lock.pid)) return false;
    await fs.unlink(lockPath).catch(() => {});
    log?.(`Removed stale lock for pid ${lock.pid}`);
    return true;
  }

  async function claimLeadership() {
    if (!enabled) {
      return { isLeader: true, instanceId, startedAt, startedAtMs, lockPath, singleInstance: false };
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await readLock(lockPath);

      if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
        if (existing.startedAtMs > startedAtMs) {
          return {
            isLeader: false,
            lockPath,
            pid: existing.pid,
            startedAt: existing.startedAt,
            startedAtMs: existing.startedAtMs,
            instanceId: existing.instanceId
          };
        }

        await terminateProcess(existing.pid, log);
        await sleep(300);
        continue;
      }

      if (await removeStaleLock(existing)) {
        continue;
      }

      if (!existing && await tryCreateLock(lockPath, myRecord())) {
        return { isLeader: true, instanceId, startedAt, startedAtMs, lockPath, singleInstance: true };
      }

      const current = await readLock(lockPath);
      if (!current) continue;

      if (current.pid === process.pid || current.instanceId === instanceId) {
        await writeLock(lockPath, myRecord());
        return { isLeader: true, instanceId, startedAt, startedAtMs, lockPath, singleInstance: true };
      }

      if (isProcessAlive(current.pid) && current.startedAtMs > startedAtMs) {
        return {
          isLeader: false,
          lockPath,
          pid: current.pid,
          startedAt: current.startedAt,
          startedAtMs: current.startedAtMs,
          instanceId: current.instanceId
        };
      }

      if (!isProcessAlive(current.pid)) {
        await fs.unlink(lockPath).catch(() => {});
        continue;
      }

      await terminateProcess(current.pid, log);
      await sleep(300);
    }

    throw new Error(`Could not claim instance lock at ${lockPath} after multiple attempts`);
  }

  async function assertLeadership() {
    if (!enabled || shuttingDown) return;

    const lock = await readLock(lockPath);
    if (!lock) {
      await writeLock(lockPath, myRecord());
      return;
    }

    if (lock.instanceId === instanceId && lock.pid === process.pid) {
      await writeLock(lockPath, myRecord());
      return;
    }

    if (lock.pid !== process.pid && isProcessAlive(lock.pid)) {
      if (lock.startedAtMs > startedAtMs) {
        await shutdown(`Superseded by newer instance pid ${lock.pid} (started ${lock.startedAt})`);
        return;
      }

      await terminateProcess(lock.pid, log);
      await sleep(150);
      await writeLock(lockPath, myRecord());
      return;
    }

    await writeLock(lockPath, myRecord());
  }

  function startHeartbeat(intervalMs = Number.parseInt(process.env.FOUNDRY_LOCAL_MCP_HEARTBEAT_MS || "5000", 10)) {
    if (!enabled) return;
    const timer = setInterval(() => {
      void assertLeadership().catch((error) => {
        log?.(`Instance heartbeat failed: ${error.message}`);
      });
    }, intervalMs);
    timer.unref?.();
  }

  function installSignalHandlers() {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => {
        void shutdown(signal);
      });
    }
  }

  return {
    claimLeadership,
    assertLeadership,
    startHeartbeat,
    installSignalHandlers,
    setShutdownHandler(handler) {
      onShutdown = handler;
    },
    getStatus() {
      return {
        singleInstance: enabled,
        instanceId,
        pid: process.pid,
        startedAt,
        startedAtMs,
        lockPath
      };
    },
    releaseLock,
    shutdown
  };
}
