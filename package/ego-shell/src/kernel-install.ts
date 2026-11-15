import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  KernelError,
  KernelNotInstalled,
  kernelDirectory,
  locateApostate,
  releaseFor,
  verifyKernel,
  type KernelRelease,
} from "./kernel.js";

export type InstallProgress = { received: number; total?: number };

/** What the profile manager shows about the Apostate kernel. */
export type KernelStatus =
  | { state: "missing"; version: string }
  | { state: "installing"; version: string; received: number; total?: number }
  | { state: "installed"; version: string }
  | { state: "failed"; version: string; error: string }
  | { state: "unavailable"; error: string };

type Fetch = (url: string) => Promise<Response>;

/** Bytes between two progress reports to the profile manager. */
const PROGRESS_STEP = 1 << 20;

/**
 * Download the release's archive, check it against the SHA-256 its manifest
 * gives and this shell pins, and extract it into `kernels/<version>/`. Nothing
 * is left behind when a step fails, and an installed kernel is replaced only
 * by one that passed every check.
 */
export async function installApostate(options: {
  dataDir: string;
  release: KernelRelease;
  fetch?: Fetch;
  onProgress?: (progress: InstallProgress) => void;
}): Promise<void> {
  const { release } = options;
  const get = options.fetch ?? fetch;
  const kernels = path.dirname(kernelDirectory(options.dataDir, "_"));
  await mkdir(kernels, { recursive: true });
  const work = path.join(
    kernels,
    `.install-${release.version}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(work);
  try {
    await checkManifest(get, release);
    const archive = path.join(work, "archive.zip");
    const actual = await download(get, release.archive.url, archive, (p) =>
      options.onProgress?.(p),
    );
    if (actual !== release.archive.sha256) {
      throw new KernelError(
        `The downloaded Apostate ${release.version} archive failed its checksum: expected ${release.archive.sha256}, got ${actual}`,
      );
    }
    const extracted = path.join(work, "extracted");
    await unzip(archive, extracted);
    const root = path.join(extracted, release.archive.root);
    await verifyKernel(root, release);
    const target = kernelDirectory(options.dataDir, release.version);
    await rm(target, { recursive: true, force: true });
    await rename(root, target);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function checkManifest(get: Fetch, release: KernelRelease) {
  const manifest = (await (
    await ok(get, release.archive.manifestUrl)
  ).json()) as {
    sha256?: unknown;
  };
  if (manifest.sha256 !== release.archive.sha256) {
    throw new KernelError(
      `The published manifest of Apostate ${release.version} gives the archive SHA-256 ${String(manifest.sha256)}, not the ${release.archive.sha256} this shell pins`,
    );
  }
}

async function ok(get: Fetch, url: string): Promise<Response> {
  let response: Response;
  try {
    response = await get(url);
  } catch (error) {
    throw new KernelError(
      `Could not download ${url}: ${(error as Error).message}`,
    );
  }
  if (!response.ok || !response.body) {
    throw new KernelError(`Could not download ${url}: HTTP ${response.status}`);
  }
  return response;
}

/** Stream `url` into `file` and return the SHA-256 of what was written. */
async function download(
  get: Fetch,
  url: string,
  file: string,
  onProgress: (progress: InstallProgress) => void,
): Promise<string> {
  const response = await ok(get, url);
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  const hash = createHash("sha256");
  let received = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      received += chunk.length;
      onProgress({ received, total });
      done(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as never),
    count,
    createWriteStream(file, { mode: 0o600 }),
  );
  return hash.digest("hex");
}

/** `ditto` keeps the app bundle's symlinks, modes and extended attributes. */
function unzip(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/ditto",
      ["-x", "-k", archive, into],
      (error, _out, stderr) =>
        error
          ? reject(
              new KernelError(
                `Could not extract the archive: ${stderr || error.message}`,
              ),
            )
          : resolve(),
    );
  });
}

/**
 * The Apostate kernel as the profile manager sees it, installed at most once
 * at a time and only when someone asks.
 */
export class KernelInstaller {
  readonly #dataDir: string;
  readonly #onChange: () => void;
  readonly #fetch: Fetch | undefined;
  readonly #platform: string | undefined;
  readonly #releases: Record<string, KernelRelease> | undefined;
  #installing: Promise<void> | undefined;
  #status: KernelStatus | undefined;

  constructor(options: {
    dataDir: string;
    onChange: () => void;
    fetch?: Fetch;
    platform?: string;
    releases?: Record<string, KernelRelease>;
  }) {
    this.#dataDir = options.dataDir;
    this.#onChange = options.onChange;
    this.#fetch = options.fetch;
    this.#platform = options.platform;
    this.#releases = options.releases;
  }

  async status(): Promise<KernelStatus> {
    if (this.#status?.state === "installing") return this.#status;
    let release: KernelRelease;
    try {
      release = releaseFor(this.#platform, this.#releases);
    } catch (error) {
      return { state: "unavailable", error: (error as Error).message };
    }
    const { version } = release;
    try {
      await locateApostate({
        dataDir: this.#dataDir,
        platform: this.#platform,
        releases: this.#releases,
      });
      return { state: "installed", version };
    } catch (error) {
      if (this.#status?.state === "failed") return this.#status;
      if (error instanceof KernelNotInstalled)
        return { state: "missing", version };
      return { state: "failed", version, error: (error as Error).message };
    }
  }

  /** Download and install the pinned release; resolves when it is done. */
  install(): Promise<void> {
    this.#installing ??= this.#install().finally(() => {
      this.#installing = undefined;
    });
    return this.#installing;
  }

  async #install(): Promise<void> {
    const release = releaseFor(this.#platform, this.#releases);
    const { version } = release;
    this.#set({ state: "installing", version, received: 0 });
    let reported = 0;
    try {
      await installApostate({
        dataDir: this.#dataDir,
        release,
        fetch: this.#fetch,
        onProgress: ({ received, total }) => {
          if (received - reported < PROGRESS_STEP && received !== total) return;
          reported = received;
          this.#set({ state: "installing", version, received, total });
        },
      });
      this.#set(undefined);
    } catch (error) {
      this.#set({ state: "failed", version, error: (error as Error).message });
      throw error;
    }
  }

  #set(status: KernelStatus | undefined): void {
    this.#status = status;
    this.#onChange();
  }
}
