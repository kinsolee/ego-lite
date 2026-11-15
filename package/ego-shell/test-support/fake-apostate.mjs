#!/usr/bin/env node
// Stands in for the Apostate binary: it records how it was started, takes the
// profile directory's lock and announces a debugging port the way Chromium does.
// FAKE_APOSTATE_MODE picks a failure: "exit" quits before announcing the port,
// "silent" never announces it, "stubborn" ignores SIGTERM. "cdp" serves a
// debugging socket that answers like a browser.
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

if (mode === "cdp") {
  const { startFakeBrowser } = await import("./fake-cdp-browser.mjs");
  const browser = await startFakeBrowser();
  writeFileSync(
    path.join(userDataDir, "DevToolsActivePort"),
    `${browser.port}\n/devtools/browser/fake`,
  );
} else if (mode !== "silent") {
  writeFileSync(
    path.join(userDataDir, "DevToolsActivePort"),
    "9222\n/devtools/browser/fake-id",
  );
}

// FAKE_APOSTATE_EXIT_DELAY_MS makes it take that long to quit, as Chromium does
// while it flushes the profile to disk.
const exitDelayMs = Number(process.env.FAKE_APOSTATE_EXIT_DELAY_MS ?? 0);
let quitting = false;
process.on("SIGTERM", () => {
  if (mode === "stubborn" || quitting) return;
  quitting = true;
  setTimeout(() => {
    writeFileSync(path.join(userDataDir, "Last Session"), "flushed");
    rmSync(lock, { force: true });
    process.exit(0);
  }, exitDelayMs);
});
setInterval(() => {}, 1_000);
