import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { apostateArguments } from "../../dist/apostate-launcher.js";

export const DEFAULT_KERNEL =
  "/Users/kinso/.cache/ego-shell-probe/kdata/kernels/155.0.8059.31/Chromium.app/Contents/MacOS/Chromium";

const CALL_TIMEOUT_MS = 20_000;
const PROXY_VARIABLES = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"];

/**
 * Starts the kernel the way the shell does for a direct profile, in a fresh
 * user-data dir. `close()` ends the process tree and deletes the dir.
 */
export async function launchKernel({ executable, headless, windowSize }) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "ego-parity-"));
  const persona = { seed: "111", locale: "pt-BR", timezone: "America/Sao_Paulo" };
  const args = apostateArguments({ executable, userDataDir, ...persona });
  if (headless) args.push("--headless=new", `--window-size=${windowSize.width},${windowSize.height}`);
  const env = { ...process.env, TZ: persona.timezone };
  for (const name of Object.keys(env)) {
    if (PROXY_VARIABLES.includes(name.toLowerCase())) delete env[name];
  }
  const child = spawn(executable, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let stderr = "";
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
    await rm(userDataDir, { recursive: true, force: true });
  };
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no DevTools endpoint:\n${stderr.slice(-800)}`)), 30000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const found = stderr.match(/DevTools listening on (ws:\S+)/);
        if (found) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
      exited.then((code) => reject(new Error(`kernel exited ${code}:\n${stderr.slice(-800)}`)));
    });
    return { endpoint, userDataDir, args, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("CDP websocket failed")));
  });
  let lastId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id === undefined) {
      for (const listener of listeners) listener(message);
      return;
    }
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    message.error
      ? waiter.reject(new Error(`${waiter.method}: ${message.error.message}`))
      : waiter.resolve(message.result);
  });
  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++lastId;
        // A kernel that stops answering would otherwise hang the run with a window up.
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: no reply in ${CALL_TIMEOUT_MS} ms`));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve, reject, method, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => socket.close(),
  };
}
