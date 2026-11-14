import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APOSTATE_RELEASES,
  KernelError,
  kernelDirectory,
  locateApostate,
} from "../dist/kernel.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const RELEASES = {
  "test-os": {
    version: "1.2.3",
    executable: "bin/browser",
    sha256: {
      "bin/browser": sha256("launcher"),
      "lib/engine": sha256("engine"),
    },
  },
};

async function installed(files) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ego-shell-kernel-"));
  const directory = kernelDirectory(dataDir, "1.2.3");
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { dataDir, directory };
}

const locate = (dataDir, env = {}) =>
  locateApostate({ dataDir, env, platform: "test-os", releases: RELEASES });

test("an installed kernel that matches its pinned hashes is launched from the data directory", async () => {
  const { dataDir, directory } = await installed({
    "bin/browser": "launcher",
    "lib/engine": "engine",
  });
  assert.deepEqual(await locate(dataDir), {
    executable: path.join(directory, "bin/browser"),
    version: "1.2.3",
    verified: true,
  });
});

test("a kernel whose code was replaced is refused", async () => {
  const { dataDir } = await installed({
    "bin/browser": "launcher",
    "lib/engine": "something else",
  });
  await assert.rejects(locate(dataDir), (error) => {
    assert.ok(error instanceof KernelError);
    assert.match(error.message, /integrity check: lib\/engine/);
    return true;
  });
});

test("a missing kernel says where to install it", async () => {
  const { dataDir, directory } = await installed({ "bin/browser": "launcher" });
  await assert.rejects(locate(dataDir), (error) => {
    assert.ok(error instanceof KernelError);
    assert.ok(error.message.includes(directory));
    assert.match(error.message, /EGO_SHELL_APOSTATE_BIN/);
    return true;
  });
});

test("EGO_SHELL_APOSTATE_BIN runs the named binary without a hash check", async () => {
  const { dataDir } = await installed({});
  const binary = path.join(dataDir, "my-chromium");
  await writeFile(binary, "#!/bin/sh\n");
  await chmod(binary, 0o755);
  assert.deepEqual(await locate(dataDir, { EGO_SHELL_APOSTATE_BIN: binary }), {
    executable: binary,
    version: "custom",
    verified: false,
  });
  await assert.rejects(
    locate(dataDir, { EGO_SHELL_APOSTATE_BIN: path.join(dataDir, "absent") }),
    /not an executable file/,
  );
});

test("a platform without a pinned kernel is refused", async () => {
  const { dataDir } = await installed({});
  await assert.rejects(
    locateApostate({ dataDir, env: {}, platform: "win32-x64" }),
    /No Apostate kernel is available for win32-x64/,
  );
});

test("the pinned macOS release names its own binary among the checked files", () => {
  const release = APOSTATE_RELEASES["darwin-arm64"];
  assert.ok(release.sha256[release.executable]);
  for (const hash of Object.values(release.sha256)) {
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
});
