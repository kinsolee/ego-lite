import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ApostateBackend } from "../dist/apostate-backend.js";
import { KernelError } from "../dist/kernel.js";
import { startFakeSocks5 } from "../test-support/fake-proxies.mjs";

const FAKE = fileURLToPath(
  new URL("../test-support/fake-apostate.mjs", import.meta.url),
);
// The fake kernel answers on its debugging socket the way a browser does.
process.env.FAKE_APOSTATE_MODE = "cdp";

function profile(overrides = {}) {
  return {
    id: "br",
    name: "Brazil",
    kernel: "apostate",
    proxy: { scheme: "none" },
    fingerprint: {
      seed: "seed-one",
      locale: "pt-BR",
      timezone: "America/Recife",
    },
    ...overrides,
  };
}

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ego-shell-backend-"));
  const spaces = new Map();
  let nextId = 1;
  const host = {
    spaces,
    allocateId: () => nextId++,
    add: (space) => spaces.set(space.id, space),
    remove: (space) => spaces.delete(space.id),
    changed() {},
  };
  const backend = new ApostateBackend({
    dataDir,
    host,
    locate: async () => ({
      executable: FAKE,
      version: "test",
      verified: false,
    }),
    ...options,
  });
  t.after(async () => {
    await backend.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  const userDataDir = (id) => path.join(dataDir, "apostate-profiles", id);
  const launched = async (id) =>
    JSON.parse(
      await readFile(path.join(userDataDir(id), "launch.json"), "utf8"),
    );
  return { backend, host, dataDir, userDataDir, launched };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition, what) {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function relayPort(argv) {
  const PREFIX = "--proxy-server=socks5://127.0.0.1:";
  return Number(
    argv.find((arg) => arg.startsWith(PREFIX)).slice(PREFIX.length),
  );
}

test("spaces of one profile share one kernel process and its data directory", async (t) => {
  const { backend, host, userDataDir, launched } = await setup(t);
  assert.equal(backend.running("br"), false);

  const [first, second] = await Promise.all([
    backend.open("orders", "agent", profile()),
    backend.open("mail", "user", profile()),
  ]);

  assert.equal(backend.running("br"), true);
  assert.deepEqual([...host.spaces.values()], [first, second]);
  assert.equal(first.ownership, "agent");
  assert.equal(second.ownership, "user");
  const { argv, tz } = await launched("br");
  assert.ok(argv.includes(`--user-data-dir=${userDataDir("br")}`));
  assert.ok(argv.includes("--fingerprint=seed-one"));
  assert.ok(argv.includes("--fingerprint-locale=pt-BR"));
  assert.ok(argv.includes("--fingerprint-timezone=America/Recife"));
  assert.equal(tz, "America/Recife");
  assert.ok(!argv.some((arg) => arg.startsWith("--proxy-server")));
});

test("each profile gets a kernel process and data directory of its own", async (t) => {
  const { backend, launched } = await setup(t);

  await backend.open("orders", "agent", profile());
  await backend.open(
    "orders",
    "agent",
    profile({
      id: "us",
      fingerprint: { seed: "seed-two", locale: "en-US", timezone: "UTC" },
    }),
  );

  const [br, us] = [await launched("br"), await launched("us")];
  assert.notEqual(br.pid, us.pid);
  assert.ok(us.argv.includes("--fingerprint=seed-two"));
});

test("the kernel is told only about the local relay, never the upstream proxy", async (t) => {
  const upstream = await startFakeSocks5({
    username: "proxy-user",
    password: "proxy-secret",
  });
  t.after(() => upstream.close());
  const { backend, launched } = await setup(t);

  await backend.open(
    "orders",
    "agent",
    profile({
      proxy: {
        scheme: "socks5",
        host: "localhost",
        port: upstream.port,
        username: "proxy-user",
        password: "proxy-secret",
      },
    }),
  );

  const { argv } = await launched("br");
  const port = relayPort(argv);
  assert.equal(await listening(port), true);
  const everything = argv.join(" ");
  for (const secret of [
    "proxy-user",
    "proxy-secret",
    "localhost",
    upstream.port,
  ]) {
    assert.ok(
      !everything.includes(String(secret)),
      `${secret} reached the kernel`,
    );
  }

  await backend.release("br");
  assert.equal(await listening(port), false);
});

test("stopping a profile ends its process and spaces but keeps its data", async (t) => {
  const { backend, host, userDataDir, launched } = await setup(t);
  await backend.open("orders", "agent", profile());
  const { pid } = await launched("br");

  await backend.release("br");

  assert.equal(alive(pid), false);
  assert.equal(backend.running("br"), false);
  assert.equal(host.spaces.size, 0);
  await access(userDataDir("br"));

  const again = await backend.open("orders", "agent", profile());
  assert.notEqual((await launched("br")).pid, pid);
  assert.equal(again.tabs().length, 1);
});

test("a kernel that dies takes its spaces and its relay down", async (t) => {
  const upstream = await startFakeSocks5({ username: "u", password: "p" });
  t.after(() => upstream.close());
  const { backend, host, launched } = await setup(t);
  await backend.open(
    "orders",
    "agent",
    profile({
      proxy: {
        scheme: "socks5",
        host: "127.0.0.1",
        port: upstream.port,
        username: "u",
        password: "p",
      },
    }),
  );
  const { pid, argv } = await launched("br");

  process.kill(pid, "SIGKILL");
  await until(() => !backend.running("br"), "the backend to notice");

  assert.equal(host.spaces.size, 0);
  await until(
    async () => !(await listening(relayPort(argv))),
    "the relay to close",
  );
});

test("renaming a running profile keeps its kernel; a new identity restarts it", async (t) => {
  const { backend, host, launched } = await setup(t);
  const space = await backend.open("orders", "agent", profile());
  const { pid } = await launched("br");

  await backend.update(profile({ name: "Brasil" }));
  assert.equal(alive(pid), true);
  assert.equal(space.profile.name, "Brasil");

  await backend.update(
    profile({
      fingerprint: {
        seed: "seed-one",
        locale: "pt-BR",
        timezone: "America/Sao_Paulo",
      },
    }),
  );
  assert.equal(alive(pid), false);
  assert.equal(host.spaces.size, 0);
  assert.equal(backend.running("br"), false);
});

test("erasing a profile stops it and deletes its data", async (t) => {
  const { backend, userDataDir, launched } = await setup(t);
  await backend.open("orders", "agent", profile());
  const { pid } = await launched("br");

  await backend.erase("br");

  assert.equal(alive(pid), false);
  await assert.rejects(access(userDataDir("br")), { code: "ENOENT" });
});

test("a missing kernel is reported and nothing is left running", async (t) => {
  let attempts = 0;
  const { backend, host } = await setup(t, {
    locate: async () => {
      attempts += 1;
      throw new KernelError("Apostate is not installed");
    },
  });

  for (const _ of [1, 2]) {
    await assert.rejects(backend.open("orders", "agent", profile()), {
      message: "Apostate is not installed",
    });
  }

  assert.equal(attempts, 2);
  assert.equal(backend.running("br"), false);
  assert.equal(host.spaces.size, 0);
});

test("shutting the backend down stops every kernel", async (t) => {
  const { backend, launched } = await setup(t);
  await backend.open("orders", "agent", profile());
  await backend.open("orders", "agent", profile({ id: "us" }));
  const pids = [(await launched("br")).pid, (await launched("us")).pid];

  await backend.stop();

  assert.deepEqual(pids.map(alive), [false, false]);
});
