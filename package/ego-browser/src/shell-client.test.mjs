import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  connectShellEgo,
  defaultShellEndpointFile,
} from "../dist/src/shell-client.js";

const TOKEN = "t".repeat(64);
const CLI = fileURLToPath(new URL("../dist/out/index.js", import.meta.url));

/**
 * Stands in for ego-shell: speaks its line protocol and answers binding calls
 * from `answer(method, args, spaceId)`, which returns a value or throws
 * `{ message, error_code }`.
 */
async function startFakeShell(t, answer = () => null) {
  const sockets = new Set();
  const cdp = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const reply = (message) => socket.write(`${JSON.stringify(message)}\n`);
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.t === "hello") {
          if (message.token === TOKEN) reply({ t: "ready" });
          else socket.destroy();
        } else if (message.t === "call") {
          const { id, method, args, spaceId } = message;
          try {
            const value = answer(method, args, spaceId);
            if (value === FLOOD) socket.write("x".repeat(64 * 1024 * 1024 + 1));
            else if (value !== HANG)
              reply({ t: "result", id, ok: true, value });
          } catch (error) {
            reply({ t: "result", id, ok: false, error });
          }
        } else if (message.t === "cdp") {
          cdp.push({ spaceId: message.spaceId, message: message.message });
          if (message.spaceId === undefined) {
            reply({
              t: "cdpError",
              message: "Task space not selected",
              error_code: "EGO_TASK_SPACE_NOT_SELECTED",
            });
          } else {
            const { id, method } = JSON.parse(message.message);
            const result =
              method === "Target.attachToTarget"
                ? { sessionId: `session-${message.spaceId}` }
                : {};
            reply({ t: "cdp", message: JSON.stringify({ id, result }) });
          }
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(path.join(tmpdir(), "ego-shell-client-"));
  const endpointFile = path.join(directory, "agent-endpoint.json");
  const writeEndpoint = (overrides = {}) =>
    writeFile(
      endpointFile,
      JSON.stringify({
        host: "127.0.0.1",
        port: server.address().port,
        token: TOKEN,
        pid: 4242,
        ...overrides,
      }),
    );
  await writeEndpoint();
  const drop = () => {
    for (const socket of sockets) socket.destroy();
  };
  t.after(async () => {
    drop();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { endpointFile, directory, writeEndpoint, cdp, drop };
}

const HANG = Symbol("never answer");
const FLOOD = Symbol("stream an endless line");

function runCli(script, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(script);
  });
}

async function connect(t, shell) {
  const connection = await connectShellEgo({
    EGO_SHELL_ENDPOINT: shell.endpointFile,
  });
  t.after(connection.close);
  return connection;
}

test("the default endpoint file sits in ego-shell's user data directory", () => {
  assert.equal(
    defaultShellEndpointFile({}, "darwin", "/Users/k"),
    "/Users/k/Library/Application Support/ego-shell/agent-endpoint.json",
  );
  assert.equal(
    defaultShellEndpointFile({}, "linux", "/home/k"),
    "/home/k/.config/ego-shell/agent-endpoint.json",
  );
  assert.equal(
    defaultShellEndpointFile({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/k"),
    "/cfg/ego-shell/agent-endpoint.json",
  );
});

test("without a running shell the harness is left as it was", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "ego-shell-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  assert.equal(await connectShellEgo({ HOME: home }), undefined);
});

test("a stale default endpoint file from a shell that quit is ignored", async (t) => {
  const shell = await startFakeShell(t);
  const home = await mkdtemp(path.join(tmpdir(), "ego-shell-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = defaultShellEndpointFile({ HOME: home });
  const { mkdir, copyFile } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true });
  await shell.writeEndpoint({ port: 1 });
  await copyFile(shell.endpointFile, file);

  assert.equal(await connectShellEgo({ HOME: home }), undefined);
});

test("an explicit endpoint that cannot be reached is an error, not a silent fallback", async (t) => {
  const shell = await startFakeShell(t);
  const missing = path.join(shell.directory, "nope.json");

  await assert.rejects(
    connectShellEgo({ EGO_SHELL_ENDPOINT: missing }),
    (error) =>
      error.message.startsWith(
        `Cannot reach ego-shell through EGO_SHELL_ENDPOINT=${missing}: `,
      ),
  );

  await shell.writeEndpoint({ token: "wrong" });
  await assert.rejects(
    connectShellEgo({ EGO_SHELL_ENDPOINT: shell.endpointFile }),
    /ego-shell refused the connection/,
  );

  await writeFile(shell.endpointFile, JSON.stringify({ host: "127.0.0.1" }));
  await assert.rejects(
    connectShellEgo({ EGO_SHELL_ENDPOINT: shell.endpointFile }),
    /is not an ego-shell endpoint file/,
  );
});

test("the bindings the harness calls are own enumerable functions", async (t) => {
  const { ego, hostPid } = await connect(t, await startFakeShell(t));

  // installEgoSdk exposes and wraps bindings by walking Object.keys(ego).
  assert.deepEqual(
    Object.keys(ego)
      .filter((key) => typeof ego[key] === "function")
      .sort(),
    [
      "animationHighlightMouseToPosition",
      "claimTaskSpace",
      "closeTaskSpace",
      "completeTaskSpace",
      "createTab",
      "createTaskSpace",
      "getBrowserVersion",
      "handOffTaskSpace",
      "listProfiles",
      "listTabs",
      "listTaskSpaces",
      "sendCDPMessage",
      "setAgentTaskState",
      "snapshot",
      "takeOverTaskSpace",
      "useTaskSpace",
    ],
  );
  assert.equal(hostPid, 4242);
});

test("a binding call carries its arguments and the selected task space", async (t) => {
  const seen = [];
  const shell = await startFakeShell(t, (method, args, spaceId) => {
    seen.push({ method, args, spaceId });
    return { taskId: "orders", id: 7, name: "orders" };
  });
  const { ego } = await connect(t, shell);

  assert.deepEqual(await ego.createTaskSpace("orders", "br"), {
    taskId: "orders",
    id: 7,
    name: "orders",
  });
  assert.equal(ego.useTaskSpace(7), 7);
  await ego.listTabs();

  assert.deepEqual(seen, [
    { method: "createTaskSpace", args: ["orders", "br"], spaceId: undefined },
    { method: "listTabs", args: [], spaceId: 7 },
  ]);
});

test("selecting a task space validates locally, as the native binding does", async (t) => {
  const { ego } = await connect(t, await startFakeShell(t));

  assert.throws(() => ego.useTaskSpace("7"), {
    name: "TypeError",
    error_code: "EGO_INVALID_ARGUMENT",
  });
  assert.throws(() => ego.sendCDPMessage({ id: 1 }), {
    name: "TypeError",
    error_code: "EGO_INVALID_ARGUMENT",
  });
});

test("a failed binding resolves an error object, and only snapshot rejects", async (t) => {
  const shell = await startFakeShell(t, () => {
    throw {
      message: "manual_takeover",
      error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
    };
  });
  const { ego } = await connect(t, shell);

  assert.deepEqual(await ego.listTabs(), {
    error: "manual_takeover",
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  await assert.rejects(ego.snapshot({ maxResultLength: 1 }), {
    name: "Error",
    message: "manual_takeover",
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
});

test("CDP messages go out with the selected space and answers come back on the callbacks", async (t) => {
  const shell = await startFakeShell(t);
  const { ego } = await connect(t, shell);
  const received = [];
  const next = () =>
    new Promise((resolve) => {
      ego.onCDPMessage = (message) => resolve(["cdp", message]);
      ego.onSendCDPMessageError = (message, code) =>
        resolve(["error", message, code]);
    });

  let arrival = next();
  assert.equal(
    ego.sendCDPMessage('{"id":1,"method":"Page.enable"}'),
    undefined,
  );
  received.push(await arrival);

  ego.useTaskSpace(3);
  arrival = next();
  ego.sendCDPMessage('{"id":2,"method":"Page.enable"}');
  received.push(await arrival);

  assert.deepEqual(received, [
    ["error", "Task space not selected", "EGO_TASK_SPACE_NOT_SELECTED"],
    ["cdp", '{"id":2,"result":{}}'],
  ]);
  assert.deepEqual(shell.cdp, [
    { spaceId: undefined, message: '{"id":1,"method":"Page.enable"}' },
    { spaceId: 3, message: '{"id":2,"method":"Page.enable"}' },
  ]);
});

test("when the shell goes away, waiting and later calls fail as browser unavailable", async (t) => {
  const shell = await startFakeShell(t, () => HANG);
  const { ego } = await connect(t, shell);

  const waiting = ego.listProfiles();
  const waitingSnapshot = ego.snapshot();
  shell.drop();

  const unavailable = {
    error: "ego-shell disconnected",
    error_code: "EGO_BROWSER_UNAVAILABLE",
  };
  assert.deepEqual(await waiting, unavailable);
  await assert.rejects(waitingSnapshot, {
    error_code: "EGO_BROWSER_UNAVAILABLE",
  });
  assert.deepEqual(await ego.listTabs(), unavailable);
  assert.throws(() => ego.sendCDPMessage("{}"), {
    error_code: "EGO_CDP_CHANNEL_UNAVAILABLE",
  });
});

test("the CLI drives the shell named by EGO_SHELL_ENDPOINT", async (t) => {
  const shell = await startFakeShell(t, (method) => {
    if (method === "listProfiles") {
      return {
        profiles: [
          { id: "default", name: "Default", isDefault: true },
          { id: "br", name: "BR shop", isDefault: false },
        ],
      };
    }
    if (method === "getBrowserVersion") {
      return { currentVersion: "0.1.0", updateAvailable: false };
    }
    throw {
      message: `unexpected ${method}`,
      error_code: "EGO_OPERATION_FAILED",
    };
  });

  const { code, stdout, stderr } = await runCli(
    "console.log(JSON.stringify(await profiles()))\n",
    {
      EGO_SHELL_ENDPOINT: shell.endpointFile,
      EGO_BROWSER_STATE_DIR: path.join(shell.directory, "state"),
    },
  );

  assert.equal(code, 0, stderr);
  assert.match(stdout, /"id":"br","name":"BR shop"/);
});

test("the CLI reports an unreachable explicit endpoint instead of running without a browser", async (t) => {
  const shell = await startFakeShell(t);
  const missing = path.join(shell.directory, "gone.json");

  const { code, stdout, stderr } = await runCli("console.log('ran')\n", {
    EGO_SHELL_ENDPOINT: missing,
    EGO_BROWSER_STATE_DIR: path.join(shell.directory, "state"),
  });

  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(
    stderr,
    new RegExp(
      `Cannot reach ego-shell through EGO_SHELL_ENDPOINT=${missing.replaceAll(".", "\\.")}`,
    ),
  );
});

test("switching task spaces within one CLI round attaches a fresh session in the new space", async (t) => {
  const shell = await startFakeShell(t, (method, _args, spaceId) => {
    if (method === "listTabs") {
      return { tabs: [{ targetId: `tab-${spaceId}`, active: true }] };
    }
    if (method === "getBrowserVersion") {
      return { currentVersion: "0.1.0", updateAvailable: false };
    }
    return null;
  });

  const { code, stderr } = await runCli(
    [
      "ego.useTaskSpace(1)",
      "await cdp('Runtime.evaluate', { expression: '1' })",
      "ego.useTaskSpace(2)",
      "await cdp('Runtime.evaluate', { expression: '2' })",
    ].join("\n"),
    {
      EGO_SHELL_ENDPOINT: shell.endpointFile,
      EGO_BROWSER_STATE_DIR: path.join(shell.directory, "state"),
    },
  );

  assert.equal(code, 0, stderr);
  const evaluations = shell.cdp
    .map(({ spaceId, message }) => ({ spaceId, ...JSON.parse(message) }))
    .filter(({ method }) => method === "Runtime.evaluate");
  assert.deepEqual(
    evaluations.map(({ spaceId, sessionId }) => ({ spaceId, sessionId })),
    [
      { spaceId: 1, sessionId: "session-1" },
      { spaceId: 2, sessionId: "session-2" },
    ],
  );
});

/** A service that took over a quit shell's port: it accepts and never speaks. */
async function startSilentService(t) {
  const sockets = new Set();
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.resume();
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(path.join(tmpdir(), "ego-shell-silent-"));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const endpoint = (pid) =>
    JSON.stringify({
      host: "127.0.0.1",
      port: server.address().port,
      token: TOKEN,
      pid,
    });
  const explicitFile = path.join(directory, "agent-endpoint.json");
  await writeFile(explicitFile, endpoint(process.pid));
  const home = path.join(directory, "home");
  const writeDefault = async (pid) => {
    const file = defaultShellEndpointFile({ HOME: home });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, endpoint(pid));
  };
  return {
    explicitFile,
    home,
    writeDefault,
    sockets,
    accepted: () => accepted,
  };
}

test(
  "an explicit endpoint whose port never answers the handshake times out",
  { timeout: 10_000 },
  async (t) => {
    const service = await startSilentService(t);

    await assert.rejects(
      connectShellEgo({ EGO_SHELL_ENDPOINT: service.explicitFile }),
      /Cannot reach ego-shell through EGO_SHELL_ENDPOINT=.*: Timed out waiting for ego-shell to answer/,
    );
    await until(() => service.sockets.size === 0, "the socket to close");
  },
);

test(
  "a default endpoint whose port never answers is skipped, and the CLI still runs",
  { timeout: 10_000 },
  async (t) => {
    const service = await startSilentService(t);
    await service.writeDefault(process.pid);

    assert.equal(await connectShellEgo({ HOME: service.home }), undefined);
    const { code, stdout } = await runCli("", { HOME: service.home }, [
      "--help",
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /^ego-browser/);
  },
);

test("a default endpoint left by a shell process that has exited is not dialed", async (t) => {
  const service = await startSilentService(t);
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => exited.once("exit", resolve));
  await service.writeDefault(exited.pid);

  assert.equal(await connectShellEgo({ HOME: service.home }), undefined);
  assert.equal(service.accepted(), 0);
});

async function until(condition, what) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test(
  "a shell that sends a line past 64 MiB is dropped instead of buffered",
  { timeout: 20_000 },
  async (t) => {
    const shell = await startFakeShell(t, () => FLOOD);
    const { ego } = await connect(t, shell);

    assert.deepEqual(await ego.listTabs(), {
      error: "ego-shell disconnected",
      error_code: "EGO_BROWSER_UNAVAILABLE",
    });
  },
);
