#!/usr/bin/env node
// Stands in for the Apostate binary: it records how it was started, takes the
// profile directory's lock and announces a debugging port the way Chromium does.
// FAKE_APOSTATE_MODE picks a failure: "exit" quits before announcing the port,
// "silent" never announces it, "stubborn" ignores SIGTERM.
import { hostname } from "node:os";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const FLAG = "--user-data-dir=";
const userDataDir = argv
  .find((arg) => arg.startsWith(FLAG))
  ?.slice(FLAG.length);
if (!userDataDir) process.exit(64);
const mode = process.env.FAKE_APOSTATE_MODE ?? "";

writeFileSync(
  path.join(userDataDir, "launch.json"),
  JSON.stringify({ argv, tz: process.env.TZ, pid: process.pid }),
);
if (mode === "exit") process.exit(3);

const lock = path.join(userDataDir, "SingletonLock");
rmSync(lock, { force: true });
symlinkSync(`${hostname()}-${process.pid}`, lock);

if (mode !== "silent") {
  writeFileSync(
    path.join(userDataDir, "DevToolsActivePort"),
    "9222\n/devtools/browser/fake-id",
  );
}

process.on("SIGTERM", () => {
  if (mode === "stubborn") return;
  rmSync(lock, { force: true });
  process.exit(0);
});
setInterval(() => {}, 1_000);
