import { rm } from "node:fs/promises";
import path from "node:path";

import { ApostateBrowser } from "./apostate-browser.js";
import { launchApostate, type RunningKernel } from "./apostate-launcher.js";
import { locateApostate, type KernelBinary } from "./kernel.js";
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
  readonly #running = new Map<string, RunningProfile>();
  readonly #starting = new Map<string, Promise<RunningProfile>>();
  /** Processes asked to quit that have not exited yet; they still own the data directory. */
  readonly #stopping = new Map<string, Promise<void>>();
  #binary: Promise<KernelBinary> | undefined;

  constructor(options: {
    /** The shell's data directory; kernels and profile data live below it. */
    dataDir: string;
    host: SpaceHost;
    locate?: () => Promise<KernelBinary>;
  }) {
    this.#dataDir = options.dataDir;
    this.#host = options.host;
    this.#locate =
      options.locate ?? (() => locateApostate({ dataDir: options.dataDir }));
  }

  async open(
    name: string,
    createdBy: Owner,
    profile: Profile,
  ): Promise<TaskSpace> {
    const { browser } = await this.#start(profile);
    return browser.createSpace(name, createdBy);
  }

  running(profileId: string): boolean {
    return this.#running.has(profileId) || this.#stopping.has(profileId);
  }

  async update(profile: Profile): Promise<void> {
    const running = this.#running.get(profile.id);
    if (!running) return;
    if (running.identity === launchIdentity(profile)) {
      running.browser.profile = profile;
      this.#host.changed();
      return;
    }
    // A running process would keep its old exit address and persona.
    await this.release(profile.id);
  }

  async release(profileId: string): Promise<void> {
    const starting = this.#starting.get(profileId);
    if (starting) await starting.catch(() => {});
    const running = this.#running.get(profileId);
    if (running) this.#shutDown(profileId, running);
    await this.#stopping.get(profileId);
  }

  async erase(profileId: string): Promise<void> {
    await this.release(profileId);
    await rm(this.#userDataDir(profileId), { recursive: true, force: true });
  }

  async stop(): Promise<void> {
    const ids = new Set([
      ...this.#starting.keys(),
      ...this.#running.keys(),
      ...this.#stopping.keys(),
    ]);
    await Promise.allSettled([...ids].map((id) => this.release(id)));
  }

  #userDataDir(profileId: string): string {
    return path.join(this.#dataDir, "apostate-profiles", profileId);
  }

  #start(profile: Profile): Promise<RunningProfile> {
    const running = this.#running.get(profile.id);
    if (running) return Promise.resolve(running);
    let starting = this.#starting.get(profile.id);
    if (!starting) {
      const stopping = this.#stopping.get(profile.id);
      starting = (
        stopping
          ? stopping.then(() => this.#launch(profile))
          : this.#launch(profile)
      ).finally(() => this.#starting.delete(profile.id));
      this.#starting.set(profile.id, starting);
    }
    return starting;
  }

  async #launch(profile: Profile): Promise<RunningProfile> {
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
