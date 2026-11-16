import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { apostateArguments } from "../dist/apostate-launcher.js";

const KERNEL = process.env.EGO_SHELL_APOSTATE_EXECUTABLE;

const ROUND_TRIPS = `(async () => {
  const differing = (a, b) => a.reduce((n, v, i) => n + (v !== b[i]), 0);
  const source = document.createElement("canvas");
  source.width = source.height = 64;
  const context = source.getContext("2d");
  const written = context.createImageData(64, 64);
  for (let i = 0; i < written.data.length; i += 4) {
    written.data.set([i % 251, (i * 7) % 253, (i * 13) % 255, 255], i);
  }
  context.putImageData(written, 0, 0);
  const image = new Image();
  image.src = source.toDataURL();
  await image.decode();
  const copy = document.createElement("canvas");
  copy.width = copy.height = 64;
  copy.getContext("2d").drawImage(image, 0, 0);
  return {
    putThenGet: differing(written.data, context.getImageData(0, 0, 64, 64).data),
    dataUrlThenGet: differing(
      written.data,
      copy.getContext("2d").getImageData(0, 0, 64, 64).data,
    ),
  };
})()`;

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
    });
    const kernel = spawn(KERNEL, [...args, "--headless=new"], {
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
