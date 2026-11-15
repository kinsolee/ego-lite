import type { Profile, ProxyConfig } from "./profile-store.js";
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
  readonly #starting = new Map<string, Promise<Entry<S>>>();

  constructor(deps: NetworkDeps<S>) {
    this.#deps = deps;
  }

  live(): LiveProfile<S>[] {
    return [...this.#entries.values()];
  }

  /** Bring the profile's session up. Resolves only once the proxy is in force. */
  async start(profile: Profile): Promise<LiveProfile<S>> {
    const live = this.#entries.get(profile.id);
    if (live) return live;
    let starting = this.#starting.get(profile.id);
    if (!starting) {
      starting = this.#start(profile).finally(() =>
        this.#starting.delete(profile.id),
      );
      this.#starting.set(profile.id, starting);
    }
    return starting;
  }

  /** Re-apply an edited profile to its running session, if it has one. */
  async update(profile: Profile): Promise<LiveProfile<S> | undefined> {
    await this.#starting.get(profile.id)?.catch(() => {});
    const entry = this.#entries.get(profile.id);
    if (!entry) return undefined;
    const previous = entry.relay;
    await this.#applyNetwork(entry, profile);
    await previous?.close();
    return entry;
  }

  /** Stop the profile's relay; its session data stays on disk. */
  async release(profileId: string): Promise<void> {
    await this.#starting.get(profileId)?.catch(() => {});
    const entry = this.#entries.get(profileId);
    this.#entries.delete(profileId);
    await entry?.relay?.close();
  }

  /** Stop the profile and hand its session to `clear`. */
  async erase(
    profileId: string,
    clear: (session: S) => Promise<void>,
  ): Promise<void> {
    await this.#starting.get(profileId)?.catch(() => {});
    const entry = this.#entries.get(profileId);
    this.#entries.delete(profileId);
    await clear(entry?.session ?? this.#deps.session(profileId));
    await entry?.relay?.close();
  }

  async stop(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map((entry) => entry.relay?.close()));
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
