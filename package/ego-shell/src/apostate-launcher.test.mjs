import assert from "node:assert/strict";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  apostateArguments,
  launchApostate,
} from "../dist/apostate-launcher.js";

const FAKE = fileURLToPath(
  new URL("../test-support/fake-apostate.mjs", import.meta.url),
);

async function profileDir(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ego-shell-kernel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "profile");
}

function launchOptions(userDataDir, extra = {}) {
  return {
    executable: FAKE,
    userDataDir,
    seed: "seed-one",
    locale: "pt-BR",
    timezone: "America/Recife",
    ...extra,
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function recorded(userDataDir) {
  return JSON.parse(
    await readFile(path.join(userDataDir, "launch.json"), "utf8"),
  );
}

test("a profile's seed, locale and timezone reach the kernel", async (t) => {
  const userDataDir = await profileDir(t);
  const kernel = await launchApostate(launchOptions(userDataDir));
  t.after(() => kernel.stop());

  assert.equal(kernel.endpoint, "ws://127.0.0.1:9222/devtools/browser/fake-id");
  const launch = await recorded(userDataDir);
  assert.equal(launch.pid, kernel.pid);
  assert.equal(launch.tz, "America/Recife");
  assert.ok(launch.argv.includes(`--user-data-dir=${userDataDir}`));
  assert.ok(launch.argv.includes("--remote-debugging-port=0"));
  assert.ok(launch.argv.includes("--fingerprint=seed-one"));
  assert.ok(launch.argv.includes("--fingerprint-platform=macos"));
  assert.ok(launch.argv.includes("--fingerprint-locale=pt-BR"));
  assert.ok(launch.argv.includes("--fingerprint-timezone=America/Recife"));
  assert.ok(
    launch.argv.includes(
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ),
  );
  assert.ok(!launch.argv.some((arg) => arg.startsWith("--fingerprint-noise")));
  assert.ok(!launch.argv.some((arg) => arg.startsWith("--proxy-server")));
});

test("a proxied profile only ever names the loopback relay", () => {
  const args = apostateArguments(
    launchOptions("/data/profile", { proxyPort: 41234 }),
  );
  assert.ok(args.includes("--proxy-server=socks5://127.0.0.1:41234"));
  assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
  assert.ok(
    args.includes("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"),
  );
});

test("stopping ends the process, by force when it ignores the request", async (t) => {
  const polite = await launchApostate(launchOptions(await profileDir(t)));
  await polite.stop();
  assert.equal(alive(polite.pid), false);

  const stubborn = await launchApostate(
    launchOptions(await profileDir(t), {
      env: { ...process.env, FAKE_APOSTATE_MODE: "stubborn" },
      stopTimeoutMs: 200,
    }),
  );
  await stubborn.stop();
  assert.equal(alive(stubborn.pid), false);
});

test("a kernel that dies is reported through exited", async (t) => {
  const kernel = await launchApostate(launchOptions(await profileDir(t)));
  process.kill(kernel.pid, "SIGKILL");
  await kernel.exited;
  assert.equal(alive(kernel.pid), false);
  await kernel.stop();
});

test("a kernel that quits or stays silent fails the launch and leaves nothing running", async (t) => {
  const quits = await profileDir(t);
  await assert.rejects(
    launchApostate(
      launchOptions(quits, {
        env: { ...process.env, FAKE_APOSTATE_MODE: "exit" },
      }),
    ),
    /exited with code 3 before opening its debugging port/,
  );

  const silent = await profileDir(t);
  await assert.rejects(
    launchApostate(
      launchOptions(silent, {
        env: { ...process.env, FAKE_APOSTATE_MODE: "silent" },
        startTimeoutMs: 300,
      }),
    ),
    /did not open its debugging port in time/,
  );
  assert.equal(alive((await recorded(silent)).pid), false);
});

test("a missing binary fails the launch", async (t) => {
  await assert.rejects(
    launchApostate(
      launchOptions(await profileDir(t), {
        executable: "/nonexistent/apostate",
      }),
    ),
    /ENOENT.*before opening its debugging port/,
  );
});

test("a port announced by an earlier run is not mistaken for the new one", async (t) => {
  const userDataDir = await profileDir(t);
  const first = await launchApostate(launchOptions(userDataDir));
  await first.stop();
  await writeFile(
    path.join(userDataDir, "DevToolsActivePort"),
    "1\n/devtools/browser/stale",
  );

  const second = await launchApostate(launchOptions(userDataDir));
  t.after(() => second.stop());
  assert.equal(second.endpoint, "ws://127.0.0.1:9222/devtools/browser/fake-id");
});

test("a kernel left behind by a killed shell is ended before the profile starts again", async (t) => {
  const userDataDir = await profileDir(t);
  const orphan = await launchApostate(launchOptions(userDataDir));
  t.after(() => orphan.stop());

  const next = await launchApostate(launchOptions(userDataDir));
  t.after(() => next.stop());

  assert.equal(alive(orphan.pid), false);
  assert.notEqual(next.pid, orphan.pid);
  assert.match(
    await readlink(path.join(userDataDir, "SingletonLock")),
    new RegExp(`-${next.pid}$`),
  );
});

test("a lock naming an unrelated live process is left alone", async (t) => {
  const userDataDir = await profileDir(t);
  const other = await launchApostate(launchOptions(await profileDir(t)));
  t.after(() => other.stop());
  const first = await launchApostate(launchOptions(userDataDir));
  await first.stop();
  const { symlink } = await import("node:fs/promises");
  await symlink(`host-${other.pid}`, path.join(userDataDir, "SingletonLock"));

  const next = await launchApostate(launchOptions(userDataDir));
  t.after(() => next.stop());
  assert.equal(alive(other.pid), true);
});
