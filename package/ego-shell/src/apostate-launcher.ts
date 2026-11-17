import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readlink, rm } from "node:fs/promises";
import path from "node:path";

export type KernelLaunch = {
  executable: string;
  /** Owned by one profile; the kernel keeps cookies and storage here. */
  userDataDir: string;
  seed: string;
  locale: string;
  timezone: string;
  /** Port of the profile's relay on 127.0.0.1; absent for a direct profile. */
  proxyPort?: number;
  /** No native windows: the shell shows the pages by screencast. */
  headless?: boolean;
  env?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
};

export type RunningKernel = {
  pid: number;
  /** Browser-level CDP websocket. */
  endpoint: string;
  /** Settles when the process is gone, however it ended. */
  exited: Promise<void>;
  stop(): Promise<void>;
};

export class KernelLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelLaunchError";
  }
}

/**
 * The machine every profile claims to be: one 60 Hz 1920x1080 display, which a
 * headless kernel can match. Without the screen flags a page reads the host's
 * own display, the same for every profile.
 */
export const PERSONA = {
  screen: { width: 1920, height: 1080 },
  window: { width: 1440, height: 900 },
} as const;

const PORT_FILE = "DevToolsActivePort";
const LOCK_FILE = "SingletonLock";
const POLL_MS = 50;

/**
 * The persona is fixed to macOS: a Windows persona on a Mac is flagged as
 * tampering. --fingerprint-noise is left off: with it, pixels a page writes to
 * a canvas read back changed, which a page can test for to spot an anti-detect
 * browser.
 */
export function apostateArguments(launch: KernelLaunch): string[] {
  const args = [
    `--user-data-dir=${launch.userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    `--fingerprint=${launch.seed}`,
    "--fingerprint-platform=macos",
    `--fingerprint-locale=${launch.locale}`,
    `--fingerprint-timezone=${launch.timezone}`,
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--fingerprint-screen-width=${PERSONA.screen.width}`,
    `--fingerprint-screen-height=${PERSONA.screen.height}`,
  ];
  if (launch.headless) {
    args.push(
      "--headless=new",
      `--window-size=${PERSONA.window.width},${PERSONA.window.height}`,
    );
  }
  if (launch.proxyPort !== undefined) {
    args.push(
      `--proxy-server=socks5://127.0.0.1:${launch.proxyPort}`,
      // Chromium sends loopback addresses direct unless told otherwise, which
      // would let a page reach services on this machine.
      "--proxy-bypass-list=<-loopback>",
      // Names are resolved by the proxy; this stops every other lookup on the host.
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    );
  }
  return args;
}

export async function launchApostate(
  launch: KernelLaunch,
): Promise<RunningKernel> {
  const { userDataDir } = launch;
  const stopTimeoutMs = launch.stopTimeoutMs ?? 5_000;
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  await reapOrphan(userDataDir, stopTimeoutMs);
  await rm(path.join(userDataDir, PORT_FILE), { force: true });

  const child = spawn(launch.executable, apostateArguments(launch), {
    env: kernelEnvironment(launch),
    stdio: "ignore",
  });
  let outcome: string | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      outcome = error.message;
      resolve();
    });
    child.once("exit", (code, signal) => {
      outcome = signal ? `was ended by ${signal}` : `exited with code ${code}`;
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    if (outcome === undefined) child.kill("SIGTERM");
    if (await settles(exited, stopTimeoutMs)) return;
    child.kill("SIGKILL");
    await exited;
  };

  const deadline = Date.now() + (launch.startTimeoutMs ?? 30_000);
  for (;;) {
    const endpoint = await readEndpoint(userDataDir);
    if (endpoint) return { pid: child.pid!, endpoint, exited, stop };
    if (outcome !== undefined) {
      throw new KernelLaunchError(
        `Apostate ${outcome} before opening its debugging port`,
      );
    }
    if (Date.now() > deadline) {
      await stop();
      throw new KernelLaunchError(
        "Apostate did not open its debugging port in time",
      );
    }
    await delay(POLL_MS);
  }
}

// The kernel's only route out is the profile's relay; anything in it that read
// the shell's proxy settings would leave by another exit.
const PROXY_VARIABLES = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"];

function kernelEnvironment(launch: KernelLaunch): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(launch.env ?? process.env),
    TZ: launch.timezone,
  };
  for (const name of Object.keys(env)) {
    if (PROXY_VARIABLES.includes(name.toLowerCase())) delete env[name];
  }
  return env;
}

async function readEndpoint(userDataDir: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(userDataDir, PORT_FILE), "utf8");
  } catch {
    return undefined;
  }
  const [port, browserPath] = text.split("\n");
  if (!/^\d+$/.test(port ?? "") || !browserPath?.startsWith("/"))
    return undefined;
  return `ws://127.0.0.1:${port}${browserPath}`;
}

/**
 * A kernel outlives a shell that was killed, and a second one started on the
 * same directory would hand over to it and exit. Chromium records its owner as
 * a SingletonLock link to "<host>-<pid>".
 */
async function reapOrphan(
  userDataDir: string,
  timeoutMs: number,
): Promise<void> {
  let owner: string;
  try {
    owner = await readlink(path.join(userDataDir, LOCK_FILE));
  } catch {
    return;
  }
  const pid = Number(owner.slice(owner.lastIndexOf("-") + 1));
  if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return;
  // The pid may have been reused by an unrelated process since the lock was written.
  if (!(await commandLine(pid)).includes(userDataDir)) return;
  process.kill(pid, "SIGTERM");
  if (await dies(pid, timeoutMs)) return;
  process.kill(pid, "SIGKILL");
  await dies(pid, timeoutMs);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandLine(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-ww", "-p", String(pid), "-o", "command="],
      (_error, stdout) => resolve(stdout),
    );
  });
}

async function dies(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await delay(POLL_MS);
  }
  return true;
}

function settles(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
