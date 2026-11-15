import { app, session as electronSession, type Session } from "electron";

import {
  browserUserAgent,
  userAgentOverride,
  type HostInfo,
} from "./fingerprint.js";
import {
  ProfileNetworks,
  type LiveProfile as Live,
} from "./profile-network.js";
import { partitionFor, type Profile } from "./profile-store.js";
import { startRelay } from "./proxy-relay.js";

export type LiveProfile = Live<Session>;

// Everything else would either leak the real machine (location, devices) or
// stall an unattended agent on a prompt nobody answers.
const GRANTED_PERMISSIONS = new Set([
  "fullscreen",
  "pointerLock",
  "clipboard-sanitized-write",
]);

function profileSession(profileId: string): Session {
  const session = electronSession.fromPartition(partitionFor(profileId));
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(GRANTED_PERMISSIONS.has(permission));
  });
  session.setPermissionCheckHandler((_contents, permission) =>
    GRANTED_PERMISSIONS.has(permission),
  );
  return session;
}

/** Electron's side of each profile's network identity; the lifecycle lives in ProfileNetworks. */
export class ProfileRuntime {
  readonly #networks: ProfileNetworks<Session>;

  constructor() {
    const host: HostInfo = {
      chromeVersion: process.versions.chrome ?? "",
      platform: process.platform,
      arch: process.arch,
      systemVersion: process.getSystemVersion(),
    };
    const defaultUserAgent = browserUserAgent(app.userAgentFallback);
    this.#networks = new ProfileNetworks({
      session: profileSession,
      startRelay,
      overrides: (profile) => ({
        timezone: profile.fingerprint.timezone,
        locale: profile.fingerprint.locale,
        userAgent: userAgentOverride(
          profile.fingerprint,
          defaultUserAgent,
          host,
        ),
      }),
    });
    app.on("web-contents-created", (_event, contents) => {
      for (const live of this.#networks.live()) {
        if (live.session !== contents.session) continue;
        // Without this, WebRTC opens UDP sockets that bypass the proxy and expose the real IP.
        contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      }
    });
  }

  /** Bring the profile's session up. Resolves only once the proxy is in force. */
  start(profile: Profile): Promise<LiveProfile> {
    return this.#networks.start(profile);
  }

  /** Re-apply an edited profile to its running session, if it has one. */
  update(profile: Profile): Promise<LiveProfile | undefined> {
    return this.#networks.update(profile);
  }

  /** Stop the profile's relay; its session data stays on disk. */
  release(profileId: string): Promise<void> {
    return this.#networks.release(profileId);
  }

  /** Stop the profile and erase everything its session stored. */
  erase(profileId: string): Promise<void> {
    return this.#networks.erase(profileId, async (session) => {
      await session.clearStorageData();
      await session.clearCache();
      await session.clearAuthCache();
    });
  }

  stop(): Promise<void> {
    return this.#networks.stop();
  }
}
