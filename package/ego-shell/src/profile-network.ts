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

type Entry<S> = LiveProfile<S> & { relay: Relay | undefined };

/** A profile whose session was left in a state nobody can vouch for; it has been stopped. */
export class ProfileUnusableError extends Error {
  constructor(profileId: string, error: unknown, restoreError: unknown) {
    super(
      `Profile ${profileId} could not apply its new network settings or restore the old ones, so it was stopped`,
      { cause: new AggregateError([error, restoreError]) },
    );
    this.name = "ProfileUnusableError";
  }
}

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
      let next: Omit<Entry<S>, "session">;
      try {
        next = await this.#switch(entry.session, profile);
      } catch (error) {
        await this.#rollBack(entry, error);
        throw error;
      }
      const previous = entry.relay;
      // Spaces hold this object, so the new state is written into it.
      Object.assign(entry, next);
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
    const session = this.#deps.session(profile.id);
    const entry = { session, ...(await this.#switch(session, profile)) };
    this.#entries.set(profile.id, entry);
    return entry;
  }

  /**
   * Put `profile`'s proxy, user agent and languages in force on `session`.
   * On failure the new relay, which holds the upstream credentials, is closed
   * and nothing is returned to commit.
   */
  async #switch(
    session: S,
    profile: Profile,
  ): Promise<Omit<Entry<S>, "session">> {
    const overrides = this.#deps.overrides(profile);
    const relay =
      profile.proxy.scheme === "none"
        ? undefined
        : await this.#deps.startRelay(profile.proxy);
    try {
      await this.#apply(session, profile.proxy, relay?.port, overrides);
    } catch (error) {
      await relay?.close();
      throw error;
    }
    return { profile, relay, overrides };
  }

  /**
   * Put the entry's committed settings back after a failed switch. If even
   * that fails, nothing on the session can be trusted, so the profile stops.
   */
  async #rollBack(entry: Entry<S>, error: unknown): Promise<void> {
    try {
      await this.#apply(
        entry.session,
        entry.profile.proxy,
        entry.relay?.port,
        entry.overrides,
      );
    } catch (restoreError) {
      await this.#drop(entry.profile.id);
      throw new ProfileUnusableError(entry.profile.id, error, restoreError);
    }
  }

  async #apply(
    session: S,
    proxy: ProxyConfig,
    relayPort: number | undefined,
    overrides: TabOverrides,
  ): Promise<void> {
    await session.setProxy(sessionProxyConfig(proxy, relayPort));
    // Sockets opened under the previous proxy would keep using the old exit IP.
    await session.closeAllConnections();
    // The CDP override does not reach service workers or shell-made requests.
    session.setUserAgent(
      overrides.userAgent.userAgent,
      overrides.userAgent.acceptLanguage,
    );
  }
}
