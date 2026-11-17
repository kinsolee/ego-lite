import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { apostateArguments } from "../dist/apostate-launcher.js";
import { CANVAS_ROUND_TRIPS as ROUND_TRIPS } from "../test-support/canvas-round-trip.mjs";

const KERNEL = process.env.EGO_SHELL_APOSTATE_EXECUTABLE;

async function evaluateOnBlankPage(endpoint, expression) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  let lastId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    reply.error
      ? waiter.reject(new Error(reply.error.message))
      : waiter.resolve(reply.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++lastId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  try {
    const { targetId } = await send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const { result } = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    return result.value;
  } finally {
    socket.close();
  }
}

test(
  "canvas pixels a page writes read back unchanged in a real kernel",
  { skip: KERNEL ? false : "set EGO_SHELL_APOSTATE_EXECUTABLE to run" },
  async (t) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "ego-shell-canvas-"));
    t.after(() => rm(userDataDir, { recursive: true, force: true }));
    const args = apostateArguments({
      executable: KERNEL,
      userDataDir,
      seed: "111",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
      headless: true,
    });
    const kernel = spawn(KERNEL, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = new Promise((resolve) => kernel.once("exit", resolve));
    t.after(async () => {
      kernel.kill();
      await exited;
    });
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = "";
      kernel.stderr.on("data", (chunk) => {
        stderr += chunk;
        const found = stderr.match(/DevTools listening on (ws:\S+)/);
        if (found) resolve(found[1]);
      });
      exited.then(() => reject(new Error(`kernel exited: ${stderr}`)));
    });

    assert.deepEqual(await evaluateOnBlankPage(endpoint, ROUND_TRIPS), {
      putThenGet: 0,
      dataUrlThenGet: 0,
    });
  },
);
