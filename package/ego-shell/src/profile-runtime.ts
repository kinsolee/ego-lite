import { app, session as electronSession, type Session } from "electron";

import {
  browserUserAgent,
  userAgentOverride,
  type HostInfo,
} from "./fingerprint.js";
import { partitionFor, type Profile } from "./profile-store.js";
import { acceptLanguages, sessionProxyConfig } from "./proxy-config.js";
import { startRelay, type Relay } from "./proxy-relay.js";
import type { TabOverrides } from "./tab.js";

export type LiveProfile = {
  profile: Profile;
  session: Session;
  overrides: TabOverrides;
};

type Entry = LiveProfile & { relay?: Relay };

// Everything else would either leak the real machine (location, devices) or
// stall an unattended agent on a prompt nobody answers.
const GRANTED_PERMISSIONS = new Set([
  "fullscreen",
  "pointerLock",
  "clipboard-sanitized-write",
]);

/** The running network identity of each profile: its session, proxy relay and overrides. */
export class ProfileRuntime {
  readonly #entries = new Map<string, Entry>();
  readonly #starting = new Map<string, Promise<Entry>>();
  readonly #host: HostInfo = {
    chromeVersion: process.versions.chrome ?? "",
    platform: process.platform,
    arch: process.arch,
    systemVersion: process.getSystemVersion(),
  };
  readonly #defaultUserAgent = browserUserAgent(app.userAgentFallback);

  constructor() {
    app.on("web-contents-created", (_event, contents) => {
      for (const entry of this.#entries.values()) {
        if (entry.session !== contents.session) continue;
        // Without this, WebRTC opens UDP sockets that bypass the proxy and expose the real IP.
        contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      }
    });
  }

  /** Bring the profile's session up. Resolves only once the proxy is in force. */
  async start(profile: Profile): Promise<LiveProfile> {
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
  async update(profile: Profile): Promise<LiveProfile | undefined> {
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

  /** Stop the profile and erase everything its session stored. */
  async erase(profileId: string): Promise<void> {
    await this.#starting.get(profileId)?.catch(() => {});
    const entry = this.#entries.get(profileId);
    this.#entries.delete(profileId);
    const session =
      entry?.session ?? electronSession.fromPartition(partitionFor(profileId));
    await session.clearStorageData();
    await session.clearCache();
    await session.clearAuthCache();
    await entry?.relay?.close();
  }

  async stop(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map((entry) => entry.relay?.close()));
  }

  async #start(profile: Profile): Promise<Entry> {
    const session = electronSession.fromPartition(partitionFor(profile.id));
    session.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(GRANTED_PERMISSIONS.has(permission));
    });
    session.setPermissionCheckHandler((_contents, permission) =>
      GRANTED_PERMISSIONS.has(permission),
    );
    const entry = { session } as Entry;
    await this.#applyNetwork(entry, profile);
    this.#entries.set(profile.id, entry);
    return entry;
  }

  /**
   * Point the session at `profile`'s proxy and commit `profile` to the entry
   * only once that succeeded. On failure the new relay, which holds the
   * upstream credentials, is closed and the entry keeps its previous state.
   */
  async #applyNetwork(entry: Entry, profile: Profile): Promise<void> {
    const { session } = entry;
    const relay =
      profile.proxy.scheme === "none"
        ? undefined
        : await startRelay(profile.proxy);
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

    const override = userAgentOverride(
      profile.fingerprint,
      this.#defaultUserAgent,
      this.#host,
    );
    // The CDP override does not reach service workers or shell-made requests.
    session.setUserAgent(
      override.userAgent,
      acceptLanguages(profile.fingerprint.locale),
    );
    entry.overrides = {
      timezone: profile.fingerprint.timezone,
      locale: profile.fingerprint.locale,
      userAgent: override,
    };
  }
}
