import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EgoError, startAgentServer } from "../dist/agent-server.js";

async function startServer(t, handlers = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ego-shell-agent-"));
  const endpointFile = path.join(directory, "agent-endpoint.json");
  const closed = [];
  const server = await startAgentServer({
    endpointFile,
    handlers: {
      call: async () => "ok",
      cdp: () => {},
      closed: (connection) => closed.push(connection.id),
      ...handlers,
    },
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { server, endpointFile, closed };
}

/** A raw client: sends JSON lines, collects the JSON lines that come back. */
async function dial(port) {
  const socket = net.connect({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const messages = [];
  const waiters = [];
  let pending = "";
  socket.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  const ended = new Promise((resolve) => socket.once("close", resolve));
  return {
    send: (message) => socket.write(`${JSON.stringify(message)}\n`),
    write: (text) => socket.write(text),
    next: () =>
      messages.length
        ? Promise.resolve(messages.shift())
        : new Promise((resolve) => waiters.push(resolve)),
    ended,
    close: () => socket.destroy(),
  };
}

async function connected(server) {
  const client = await dial(server.port);
  client.send({ t: "hello", token: server.token });
  assert.deepEqual(await client.next(), { t: "ready" });
  return client;
}

test("the endpoint file names the loopback port and token and is owner-only", async (t) => {
  const { server, endpointFile } = await startServer(t);

  const endpoint = JSON.parse(await readFile(endpointFile, "utf8"));
  assert.deepEqual(endpoint, {
    host: "127.0.0.1",
    port: server.port,
    token: server.token,
    pid: process.pid,
  });
  assert.match(server.token, /^[0-9a-f]{64}$/);
  assert.equal((await stat(endpointFile)).mode & 0o777, 0o600);
});

test("an endpoint file left readable by an earlier run is tightened", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ego-shell-agent-"));
  const endpointFile = path.join(directory, "agent-endpoint.json");
  await writeFile(endpointFile, "{}", { mode: 0o644 });
  const server = await startAgentServer({
    endpointFile,
    handlers: { call: async () => null, cdp: () => {}, closed: () => {} },
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal((await stat(endpointFile)).mode & 0o777, 0o600);
});

for (const [label, hello] of [
  ["a wrong token", { t: "hello", token: "0".repeat(64) }],
  ["no token", { t: "hello" }],
  [
    "a call before the handshake",
    { t: "call", id: 1, method: "listProfiles", args: [] },
  ],
]) {
  test(`${label} is disconnected without reaching the handlers`, async (t) => {
    let reached = false;
    const { server, closed } = await startServer(t, {
      call: async () => {
        reached = true;
      },
    });
    const client = await dial(server.port);

    client.send(hello);
    await client.ended;
    assert.equal(reached, false);
    assert.deepEqual(closed, []);
  });
}

test("a call reaches the handler with its arguments and selected space", async (t) => {
  const seen = [];
  const { server } = await startServer(t, {
    call: async (_connection, method, args, spaceId) => {
      seen.push({ method, args, spaceId });
      return { profiles: [] };
    },
  });
  const client = await connected(server);
  t.after(client.close);

  client.send({
    t: "call",
    id: 7,
    method: "listProfiles",
    args: [],
    spaceId: 3,
  });
  assert.deepEqual(await client.next(), {
    t: "result",
    id: 7,
    ok: true,
    value: { profiles: [] },
  });
  assert.deepEqual(seen, [{ method: "listProfiles", args: [], spaceId: 3 }]);
});

test("a handler failure comes back with its ego error code", async (t) => {
  const { server } = await startServer(t, {
    call: async (_connection, method) => {
      if (method === "coded") {
        throw new EgoError("Profile not found", "EGO_PROFILE_NOT_FOUND");
      }
      throw new Error("boom");
    },
  });
  const client = await connected(server);
  t.after(client.close);

  client.send({ t: "call", id: 1, method: "coded", args: [] });
  assert.deepEqual(await client.next(), {
    t: "result",
    id: 1,
    ok: false,
    error: {
      message: "Profile not found",
      error_code: "EGO_PROFILE_NOT_FOUND",
    },
  });
  client.send({ t: "call", id: 2, method: "plain", args: [] });
  assert.deepEqual(await client.next(), {
    t: "result",
    id: 2,
    ok: false,
    error: { message: "boom", error_code: "EGO_OPERATION_FAILED" },
  });
});

test("CDP messages flow both ways on the connection that sent them", async (t) => {
  const { server } = await startServer(t, {
    cdp: (connection, spaceId, message) => {
      const { id } = JSON.parse(message);
      if (spaceId === undefined) {
        connection.sendCdpError(
          "Task space not selected",
          "EGO_TASK_SPACE_NOT_SELECTED",
        );
      } else {
        connection.sendCdp(JSON.stringify({ id, result: { spaceId } }));
      }
    },
  });
  const first = await connected(server);
  const second = await connected(server);
  t.after(first.close);
  t.after(second.close);

  first.send({
    t: "cdp",
    spaceId: 4,
    message: JSON.stringify({ id: 1, method: "Page.enable" }),
  });
  second.send({
    t: "cdp",
    message: JSON.stringify({ id: 1, method: "Page.enable" }),
  });

  assert.deepEqual(await first.next(), {
    t: "cdp",
    message: JSON.stringify({ id: 1, result: { spaceId: 4 } }),
  });
  assert.deepEqual(await second.next(), {
    t: "cdpError",
    message: "Task space not selected",
    error_code: "EGO_TASK_SPACE_NOT_SELECTED",
  });
});

test("a message split across packets, with multi-byte text, arrives whole", async (t) => {
  const seen = [];
  const { server } = await startServer(t, {
    call: async (_connection, _method, args) => {
      seen.push(args[0]);
      return args[0];
    },
  });
  const socket = net.connect({ host: "127.0.0.1", port: server.port });
  t.after(() => socket.destroy());
  await new Promise((resolve) => socket.once("connect", resolve));
  const replies = [];
  socket.on("data", (chunk) => replies.push(chunk));

  const bytes = Buffer.from(
    `${JSON.stringify({ t: "hello", token: server.token })}\n` +
      `${JSON.stringify({ t: "call", id: 1, method: "setAgentTaskState", args: ["結帳中 🛒"] })}\n`,
  );
  // Cut inside the emoji so a naive per-chunk decode would corrupt it.
  const cut = bytes.indexOf(Buffer.from("🛒")) + 2;
  socket.write(bytes.subarray(0, cut));
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.write(bytes.subarray(cut));

  while (seen.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seen, ["結帳中 🛒"]);
});

test("the handlers learn when an agent disconnects", async (t) => {
  const { server, closed } = await startServer(t);
  const client = await connected(server);

  client.close();
  await client.ended;
  while (closed.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(closed, [1]);
});

test("closing the server drops its agents and removes the endpoint file", async (t) => {
  const { server, endpointFile } = await startServer(t);
  const client = await connected(server);

  await server.close();
  await client.ended;
  await assert.rejects(stat(endpointFile), { code: "ENOENT" });
});

test(
  "a client that has not said hello is dropped once it sends 4 KiB without a newline",
  { timeout: 5_000 },
  async (t) => {
    const { server } = await startServer(t);
    const client = await dial(server.port);
    t.after(client.close);

    client.write("x".repeat(4 * 1024 + 1));

    await client.ended;
  },
);

test(
  "a client that never says hello is dropped after two seconds",
  { timeout: 5_000 },
  async (t) => {
    const { server } = await startServer(t);
    const client = await dial(server.port);
    t.after(client.close);
    const started = Date.now();

    await client.ended;

    assert.ok(
      Date.now() - started >= 1_500,
      "dropped before the hello timeout",
    );
  },
);

test(
  "after hello, a large message is accepted and one past 64 MiB without a newline is not",
  { timeout: 20_000 },
  async (t) => {
    const seen = [];
    const { server } = await startServer(t, {
      cdp: (_connection, _spaceId, message) => seen.push(message.length),
    });
    const client = await connected(server);
    t.after(client.close);

    const screenshot = "a".repeat(8 * 1024 * 1024);
    client.send({ t: "cdp", spaceId: 1, message: screenshot });
    while (seen.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(seen, [screenshot.length]);

    client.write("x".repeat(64 * 1024 * 1024 + 1));
    await client.ended;
  },
);
