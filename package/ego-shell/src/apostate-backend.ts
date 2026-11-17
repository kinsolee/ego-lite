import { rm } from "node:fs/promises";
import path from "node:path";

import { ApostateBrowser, type ScreenHandle } from "./apostate-browser.js";
import { CdpTimeoutError } from "./browser-cdp.js";
import { launchApostate, type RunningKernel } from "./apostate-launcher.js";
import { locateApostate, type KernelBinary } from "./kernel.js";
import { ProfileQueue } from "./profile-queue.js";
import type { Profile } from "./profile-store.js";
import { startRelay, type Relay } from "./proxy-relay.js";
import type {
  KernelBackend,
  Owner,
  SpaceHost,
  TaskSpace,
} from "./task-space.js";

type RunningProfile = {
  kernel: RunningKernel;
  browser: ApostateBrowser;
  relay: Relay | undefined;
  /** What the process was started with; a change means a restart. */
  identity: string;
};

/**
 * Everything a kernel process fixes at launch. The seed, locale and timezone are
 * arguments, and a process keeps connections to the proxy it started with.
 */
function launchIdentity(profile: Profile): string {
  const { seed, locale, timezone } = profile.fingerprint;
  return JSON.stringify([seed, locale, timezone, profile.proxy]);
}

/** Runs one Apostate process per profile and opens its windows as task spaces. */
export class ApostateBackend implements KernelBackend {
  readonly #dataDir: string;
  readonly #host: SpaceHost;
  readonly #locate: () => Promise<KernelBinary>;
  readonly #commandTimeoutMs: number | undefined;
  readonly #screen: ScreenHandle | undefined;
  readonly #running = new Map<string, RunningProfile>();
  /** Every open, update, release and erase of a profile runs in this queue, one at a time. */
  readonly #queue = new ProfileQueue();
  /** Processes asked to quit that have not exited yet; they still own the data directory. */
  readonly #stopping = new Map<string, Promise<void>>();
  #binary: Promise<KernelBinary> | undefined;

  constructor(options: {
    /** The shell's data directory; kernels and profile data live below it. */
    dataDir: string;
    host: SpaceHost;
    locate?: () => Promise<KernelBinary>;
    /** How long the shell waits for the kernel to answer one of its own commands. */
    commandTimeoutMs?: number;
    /** Where the selected space is drawn; absent when nothing shows the spaces. */
    screen?: ScreenHandle;
  }) {
    this.#dataDir = options.dataDir;
    this.#commandTimeoutMs = options.commandTimeoutMs;
    this.#screen = options.screen;
    this.#host = options.host;
    this.#locate =
      options.locate ?? (() => locateApostate({ dataDir: options.dataDir }));
  }

  /** Start the profile's kernel unless it runs, then open a window in it. */
  open(name: string, createdBy: Owner, profile: Profile): Promise<TaskSpace> {
    return this.#queue.run(profile.id, async () => {
      const running =
        this.#running.get(profile.id) ?? (await this.#launch(profile));
      try {
        return await running.browser.createSpace(name, createdBy);
      } catch (error) {
        // A kernel that holds its socket open but stops answering would keep
        // the profile's queue, and every release behind it, waiting for good.
        if (error instanceof CdpTimeoutError) await this.#stopNow(profile.id);
        throw error;
      }
    });
  }

  running(profileId: string): boolean {
    return this.#running.has(profileId) || this.#stopping.has(profileId);
  }

  update(profile: Profile): Promise<void> {
    return this.#queue.run(profile.id, async () => {
      const running = this.#running.get(profile.id);
      if (!running) return;
      if (running.identity === launchIdentity(profile)) {
        running.browser.profile = profile;
        this.#host.changed();
        return;
      }
      // A running process would keep its old exit address and persona.
      await this.#stopNow(profile.id);
    });
  }

  release(profileId: string): Promise<void> {
    return this.#queue.run(profileId, () => this.#stopNow(profileId));
  }

  erase(profileId: string): Promise<void> {
    return this.#queue.run(profileId, async () => {
      await this.#stopNow(profileId);
      await rm(this.#userDataDir(profileId), { recursive: true, force: true });
    });
  }

  async stop(): Promise<void> {
    const ids = new Set([
      ...this.#queue.busy(),
      ...this.#running.keys(),
      ...this.#stopping.keys(),
    ]);
    await Promise.allSettled([...ids].map((id) => this.release(id)));
  }

  async #stopNow(profileId: string): Promise<void> {
    const running = this.#running.get(profileId);
    if (running) this.#shutDown(profileId, running);
    await this.#stopping.get(profileId);
  }

  #userDataDir(profileId: string): string {
    return path.join(this.#dataDir, "apostate-profiles", profileId);
  }

  async #launch(profile: Profile): Promise<RunningProfile> {
    // A kernel that quit on its own may still hold the data directory.
    await this.#stopping.get(profile.id);
    // Hashing the kernel takes a moment, so one check serves the whole run.
    this.#binary ??= this.#locate();
    const binary = await this.#binary.catch((error) => {
      this.#binary = undefined;
      throw error;
    });
    const relay =
      profile.proxy.scheme === "none"
        ? undefined
        : await startRelay(profile.proxy);
    let kernel: RunningKernel | undefined;
    try {
      kernel = await launchApostate({
        executable: binary.executable,
        userDataDir: this.#userDataDir(profile.id),
        seed: profile.fingerprint.seed,
        locale: profile.fingerprint.locale,
        timezone: profile.fingerprint.timezone,
        proxyPort: relay?.port,
      });
      const browser = await ApostateBrowser.connect(
        kernel.endpoint,
        profile,
        this.#host,
        { commandTimeoutMs: this.#commandTimeoutMs, screen: this.#screen },
      );
      const running: RunningProfile = {
        kernel,
        browser,
        relay,
        identity: launchIdentity(profile),
      };
      this.#running.set(profile.id, running);
      // The user quitting the browser, or a crash, ends the profile's run.
      void Promise.race([kernel.exited, browser.closed]).then(() =>
        this.#shutDown(profile.id, running),
      );
      this.#host.changed();
      return running;
    } catch (error) {
      await kernel?.stop();
      await relay?.close();
      throw error;
    }
  }

  #shutDown(profileId: string, running: RunningProfile): void {
    if (this.#running.get(profileId) !== running) return;
    this.#running.delete(profileId);
    const stopped = (async () => {
      await running.browser.close();
      await running.kernel.stop();
      await running.relay?.close();
    })().finally(() => {
      this.#stopping.delete(profileId);
      this.#host.changed();
    });
    // A kernel that exits on its own has no caller waiting; release() reports failures.
    void stopped.catch(() => {});
    this.#stopping.set(profileId, stopped);
    this.#host.changed();
  }
}
