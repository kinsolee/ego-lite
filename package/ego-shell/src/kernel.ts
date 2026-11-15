import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants } from "node:fs/promises";
import path from "node:path";

/** One published Apostate build: where to get it and what it must contain. */
export type KernelRelease = {
  version: string;
  /** Path of the browser binary inside the extracted archive. */
  executable: string;
  /** SHA-256 of each file that carries browser code, by path inside the archive. */
  sha256: Record<string, string>;
  archive: {
    url: string;
    /** The release manifest published next to the archive. */
    manifestUrl: string;
    /** SHA-256 of the archive, as its manifest gives it. */
    sha256: string;
    /** The folder inside the archive that becomes the kernel directory. */
    root: string;
  };
};

export type KernelBinary = {
  executable: string;
  version: string;
  /** False when the path came from the environment and was not checked. */
  verified: boolean;
};

export class KernelError extends Error {}

/** The pinned release is not on disk yet; installing it fixes that. */
export class KernelNotInstalled extends KernelError {}

const FRAMEWORK =
  "Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions";

const RELEASE_URL =
  "https://github.com/heretic-tech/apostate/releases/download/v0.5.1";

/**
 * The builds this shell will run, by `<platform>-<arch>`. The hashes are of the
 * files in apostate-155.0.8059.31-macos-arm64.zip, Apostate 0.5.1. Only macOS
 * is listed: a Windows or Linux persona on a Mac is flagged as tampering by
 * fingerprint checkers.
 */
export const APOSTATE_RELEASES: Record<string, KernelRelease> = {
  "darwin-arm64": {
    version: "155.0.8059.31",
    executable: "Chromium.app/Contents/MacOS/Chromium",
    sha256: {
      "Chromium.app/Contents/MacOS/Chromium":
        "2dfa8b148e6d06598981c4a1e1bc0d7c2c7860d74401ad0d934d21a10c7916d7",
      [`${FRAMEWORK}/155.0.8059.31/Chromium Framework`]:
        "f2a43605e500acb24cb7384f2b85f276c5f055713f565ff11ee8fdf1f6e41dba",
    },
    archive: {
      url: `${RELEASE_URL}/apostate-155.0.8059.31-macos-arm64.zip`,
      manifestUrl: `${RELEASE_URL}/apostate-155.0.8059.31-macos-arm64.zip.manifest.json`,
      sha256:
        "58176ba9b3e9cfd74029165bdf716c636e618af17a48bd905fe6d5f1552d901a",
      root: "apostate-155.0.8059.31-macos-arm64",
    },
  },
};

/** The release this machine runs, or an error naming the platform. */
export function releaseFor(
  platform = `${process.platform}-${process.arch}`,
  releases: Record<string, KernelRelease> = APOSTATE_RELEASES,
): KernelRelease {
  const release = releases[platform];
  if (!release) {
    throw new KernelError(`No Apostate kernel is available for ${platform}`);
  }
  return release;
}

export function kernelDirectory(dataDir: string, version: string): string {
  return path.join(dataDir, "kernels", version);
}

export async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Find the Apostate binary to launch. `EGO_SHELL_APOSTATE_BIN` names a binary
 * to run as-is; otherwise the pinned release must sit extracted under
 * `<dataDir>/kernels/<version>/` and match its pinned hashes.
 */
export async function locateApostate(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  releases?: Record<string, KernelRelease>;
}): Promise<KernelBinary> {
  const override = (options.env ?? process.env).EGO_SHELL_APOSTATE_BIN;
  if (override) {
    const executable = path.resolve(override);
    try {
      await access(executable, constants.X_OK);
    } catch {
      throw new KernelError(
        `EGO_SHELL_APOSTATE_BIN is not an executable file: ${executable}`,
      );
    }
    return { executable, version: "custom", verified: false };
  }

  const release = releaseFor(options.platform, options.releases);
  const directory = kernelDirectory(options.dataDir, release.version);
  await verifyKernel(directory, release);
  return {
    executable: path.join(directory, release.executable),
    version: release.version,
    verified: true,
  };
}

/** Check that `directory` holds the release's browser files and nothing else in their place. */
export async function verifyKernel(
  directory: string,
  release: KernelRelease,
): Promise<void> {
  for (const [file, expected] of Object.entries(release.sha256)) {
    let actual: string;
    try {
      actual = await sha256(path.join(directory, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new KernelNotInstalled(
        `Apostate ${release.version} is not installed in ${directory}: install it from the profile manager, or set EGO_SHELL_APOSTATE_BIN`,
      );
    }
    if (actual !== expected) {
      throw new KernelError(
        `Apostate ${release.version} failed its integrity check: ${file} in ${directory} is not the published file`,
      );
    }
  }
}
