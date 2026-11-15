import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { kernelDirectory, locateApostate } from "../dist/kernel.js";
import { KernelInstaller, installApostate } from "../dist/kernel-install.js";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const ROOT = "browser-1.2.3-test";
const ARCHIVE_URL = "https://releases.test/browser-1.2.3.zip";
const MANIFEST_URL = `${ARCHIVE_URL}.manifest.json`;

/** A release archive like Apostate's: one top folder holding the browser files. */
async function fakeRelease() {
  const work = await mkdtemp(path.join(os.tmpdir(), "ego-shell-release-"));
  const files = { "bin/browser": "launcher", "lib/engine": "engine" };
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(work, ROOT, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const archive = path.join(work, "release.zip");
  execFileSync("/usr/bin/ditto", [
    "-c",
    "-k",
    "--keepParent",
    path.join(work, ROOT),
    archive,
  ]);
  const bytes = await readFile(archive);
  const release = {
    version: "1.2.3",
    executable: "bin/browser",
    sha256: Object.fromEntries(
      Object.entries(files).map(([file, content]) => [file, sha256(content)]),
    ),
    archive: {
      url: ARCHIVE_URL,
      manifestUrl: MANIFEST_URL,
      sha256: sha256(bytes),
      root: ROOT,
    },
  };
  return { release, bytes };
}

/** Serves the archive and its manifest; nothing goes to the network. */
function fakeFetch(responses) {
  const requested = [];
  const fetch = async (url) => {
    requested.push(url);
    const body = responses[url];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(body, {
      headers: { "content-length": String(body.length) },
    });
  };
  return { fetch, requested };
}

function serving(
  release,
  bytes,
  manifest = { sha256: release.archive.sha256 },
) {
  return fakeFetch({
    [ARCHIVE_URL]: bytes,
    [MANIFEST_URL]: Buffer.from(JSON.stringify(manifest)),
  });
}

const dataDir = () => mkdtemp(path.join(os.tmpdir(), "ego-shell-install-"));
const releases = (release) => ({ "test-os": release });
const locate = (dir, release) =>
  locateApostate({
    dataDir: dir,
    env: {},
    platform: "test-os",
    releases: releases(release),
  });

test("an installed release is the verified kernel the shell launches", async () => {
  const { release, bytes } = await fakeRelease();
  const dir = await dataDir();
  const { fetch, requested } = serving(release, bytes);
  const progress = [];

  await installApostate({
    dataDir: dir,
    release,
    fetch,
    onProgress: (step) => progress.push(step),
  });

  assert.deepEqual(requested, [MANIFEST_URL, ARCHIVE_URL]);
  assert.deepEqual(await locate(dir, release), {
    executable: path.join(kernelDirectory(dir, "1.2.3"), "bin/browser"),
    version: "1.2.3",
    verified: true,
  });
  assert.deepEqual(progress.at(-1), {
    received: bytes.length,
    total: bytes.length,
  });
  assert.deepEqual(await readdir(path.join(dir, "kernels")), ["1.2.3"]);
});

test("an archive that fails its checksum is deleted and reported", async () => {
  const { release, bytes } = await fakeRelease();
  const dir = await dataDir();
  const tampered = Buffer.concat([bytes, Buffer.from("extra")]);
  const { fetch } = serving(release, tampered);

  await assert.rejects(
    installApostate({ dataDir: dir, release, fetch }),
    /failed its checksum: expected [0-9a-f]{64}, got [0-9a-f]{64}/,
  );
  assert.deepEqual(await readdir(path.join(dir, "kernels")), []);
  await assert.rejects(locate(dir, release), /not installed/);
});

test("a manifest that names another archive stops the install before the download", async () => {
  const { release, bytes } = await fakeRelease();
  const dir = await dataDir();
  const { fetch, requested } = serving(release, bytes, {
    sha256: "0".repeat(64),
  });

  await assert.rejects(
    installApostate({ dataDir: dir, release, fetch }),
    /manifest .* gives the archive SHA-256 0{64}, not the [0-9a-f]{64} this shell pins/,
  );
  assert.deepEqual(requested, [MANIFEST_URL]);
  assert.deepEqual(await readdir(path.join(dir, "kernels")), []);
});

test("an archive whose browser files differ from the pinned ones is not installed", async () => {
  const { release, bytes } = await fakeRelease();
  const dir = await dataDir();
  const pinned = {
    ...release,
    sha256: { ...release.sha256, "lib/engine": sha256("another engine") },
  };
  const { fetch } = serving(pinned, bytes);

  await assert.rejects(
    installApostate({ dataDir: dir, release: pinned, fetch }),
    /failed its integrity check: lib\/engine/,
  );
  assert.deepEqual(await readdir(path.join(dir, "kernels")), []);
});

test("a download that fails says which URL and status", async () => {
  const { release } = await fakeRelease();
  const dir = await dataDir();
  const { fetch } = fakeFetch({});

  await assert.rejects(
    installApostate({ dataDir: dir, release, fetch }),
    new RegExp(`Could not download ${MANIFEST_URL}: HTTP 404`),
  );
});

test("the manager sees the kernel missing, installing once, then installed", async () => {
  const { release, bytes } = await fakeRelease();
  const dir = await dataDir();
  const { fetch, requested } = serving(release, bytes);
  const seen = [];
  const installer = new KernelInstaller({
    dataDir: dir,
    fetch,
    platform: "test-os",
    releases: releases(release),
    onChange: () => seen.push(installer.status()),
  });

  assert.deepEqual(await installer.status(), {
    state: "missing",
    version: "1.2.3",
  });
  await Promise.all([installer.install(), installer.install()]);
  assert.equal(requested.filter((url) => url === ARCHIVE_URL).length, 1);
  assert.equal((await seen[0]).state, "installing");
  assert.deepEqual(await installer.status(), {
    state: "installed",
    version: "1.2.3",
  });
});

test("a failed install is shown with its reason until it is tried again", async () => {
  const { release } = await fakeRelease();
  const dir = await dataDir();
  const installer = new KernelInstaller({
    dataDir: dir,
    fetch: fakeFetch({}).fetch,
    platform: "test-os",
    releases: releases(release),
    onChange() {},
  });

  await assert.rejects(installer.install(), /HTTP 404/);
  const status = await installer.status();
  assert.equal(status.state, "failed");
  assert.match(status.error, /HTTP 404/);
});
