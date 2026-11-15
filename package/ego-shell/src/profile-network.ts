import type { Profile, ProxyConfig } from "./profile-store.js";
import { ProfileQueue } from "./profile-queue.js";
import { sessionProxyConfig, type SessionProxyConfig } from "./proxy-config.js";
import type { Relay } from "./proxy-relay.js";
import type { TabOverrides } from "./tab.js";

/** The parts of an Electron session that carry a profile's network identity. */
export type NetworkSession = {
  setProxy(config: SessionProxyConfig): Promise<void>;
  closeAllConnections(): Promise<void>;
  setUserAgent(userAgent: string, acceptLanguages?: string): void;
};

export type LiveProfile<S> = {
  profile: Profile;
  session: S;
  overrides: TabOverrides;
};

type Entry<S> = LiveProfile<S> & { relay?: Relay };

export type NetworkDeps<S> = {
  /** The profile's session, ready to be pointed at a proxy. */
  session(profileId: string): S;
  startRelay(proxy: ProxyConfig): Promise<Relay>;
  overrides(profile: Profile): TabOverrides;
};

/** The running network identity of each profile: its session, proxy relay and overrides. */
export class ProfileNetworks<S extends NetworkSession> {
  readonly #deps: NetworkDeps<S>;
  readonly #entries = new Map<string, Entry<S>>();
  /** Every start, update, release and erase of a profile runs in this queue, one at a time. */
  readonly #queue = new ProfileQueue();

  constructor(deps: NetworkDeps<S>) {
    this.#deps = deps;
  }

  live(): LiveProfile<S>[] {
    return [...this.#entries.values()];
  }

  /** Bring the profile's session up. Resolves only once the proxy is in force. */
  start(profile: Profile): Promise<LiveProfile<S>> {
    return this.#queue.run(
      profile.id,
      async () => this.#entries.get(profile.id) ?? this.#start(profile),
    );
  }

  /** Re-apply an edited profile to its running session, if it has one. */
  update(profile: Profile): Promise<LiveProfile<S> | undefined> {
    return this.#queue.run(profile.id, async () => {
      const entry = this.#entries.get(profile.id);
      if (!entry) return undefined;
      const previous = entry.relay;
      await this.#applyNetwork(entry, profile);
      await previous?.close();
      return entry;
    });
  }

  /** Stop the profile's relay; its session data stays on disk. */
  release(profileId: string): Promise<void> {
    return this.#queue.run(profileId, () => this.#drop(profileId));
  }

  /** Stop the profile and hand its session to `clear`. */
  erase(
    profileId: string,
    clear: (session: S) => Promise<void>,
  ): Promise<void> {
    return this.#queue.run(profileId, async () => {
      const session =
        this.#entries.get(profileId)?.session ?? this.#deps.session(profileId);
      try {
        await clear(session);
      } finally {
        await this.#drop(profileId);
      }
    });
  }

  async stop(): Promise<void> {
    const ids = new Set([...this.#entries.keys(), ...this.#queue.busy()]);
    await Promise.allSettled([...ids].map((id) => this.release(id)));
  }

  async #drop(profileId: string): Promise<void> {
    const entry = this.#entries.get(profileId);
    this.#entries.delete(profileId);
    await entry?.relay?.close();
  }

  async #start(profile: Profile): Promise<Entry<S>> {
    const entry = { session: this.#deps.session(profile.id) } as Entry<S>;
    await this.#applyNetwork(entry, profile);
    this.#entries.set(profile.id, entry);
    return entry;
  }

  /**
   * Point the session at `profile`'s proxy and commit `profile` to the entry
   * only once that succeeded. On failure the new relay, which holds the
   * upstream credentials, is closed and the entry keeps its previous state.
   */
  async #applyNetwork(entry: Entry<S>, profile: Profile): Promise<void> {
    const { session } = entry;
    const relay =
      profile.proxy.scheme === "none"
        ? undefined
        : await this.#deps.startRelay(profile.proxy);
    try {
      await session.setProxy(sessionProxyConfig(profile.proxy, relay?.port));
      // Sockets opened under the previous proxy would keep using the old exit IP.
      await session.closeAllConnections();
    } catch (error) {
      await relay?.close();
      if (entry.profile) {
        await session
          .setProxy(sessionProxyConfig(entry.profile.proxy, entry.relay?.port))
          .catch(() => {});
      }
      throw error;
    }
    entry.profile = profile;
    entry.relay = relay;

    const overrides = this.#deps.overrides(profile);
    // The CDP override does not reach service workers or shell-made requests.
    session.setUserAgent(
      overrides.userAgent.userAgent,
      overrides.userAgent.acceptLanguage,
    );
    entry.overrides = overrides;
  }
}
