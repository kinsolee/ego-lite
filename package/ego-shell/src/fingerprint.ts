import type { Fingerprint } from "./profile-store.js";
import { acceptLanguages } from "./proxy-config.js";

export type HostInfo = {
  /** Full Chromium version of the running kernel, e.g. `146.0.7680.72`. */
  chromeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  /** OS version as the platform reports it, e.g. `15.5.0` on macOS. */
  systemVersion: string;
};

export type UserAgentOverride = {
  userAgent: string;
  acceptLanguage: string;
  userAgentMetadata?: Record<string, unknown>;
};

/**
 * Turn Electron's user agent into the one Chrome sends: no application or
 * Electron token, and the reduced `major.0.0.0` version.
 */
export function browserUserAgent(electronUserAgent: string): string {
  return electronUserAgent
    .replace(
      /\s(?!Chrome\/|Safari\/|Mozilla\/|AppleWebKit\/)[\w-]+\/\S+(?=\s)/g,
      "",
    )
    .replace(/Chrome\/(\d+)\.[\d.]+/, "Chrome/$1.0.0.0");
}

function clientHintPlatform(userAgent: string): string {
  if (userAgent.includes("Windows")) return "Windows";
  if (userAgent.includes("Macintosh")) return "macOS";
  if (userAgent.includes("Android")) return "Android";
  return "Linux";
}

const HOST_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/**
 * Parameters for `Emulation.setUserAgentOverride`. Overriding the user agent
 * without metadata makes Chromium drop the `Sec-CH-UA` headers, which no real
 * Chrome does, so the metadata is rebuilt to agree with the user agent string.
 */
export function userAgentOverride(
  fingerprint: Fingerprint,
  defaultUserAgent: string,
  host: HostInfo,
): UserAgentOverride {
  const userAgent = fingerprint.userAgent || defaultUserAgent;
  const override: UserAgentOverride = {
    userAgent,
    acceptLanguage: acceptLanguages(fingerprint.locale),
  };
  const major = /Chrome\/(\d+)/.exec(userAgent)?.[1];
  if (!major) return override;

  const platform = clientHintPlatform(userAgent);
  const matchesHost = HOST_PLATFORM[host.platform] === platform;
  const fullVersion = host.chromeVersion.startsWith(`${major}.`)
    ? host.chromeVersion
    : `${major}.0.0.0`;
  const brands = (version: string, grease: string) => [
    { brand: "Chromium", version },
    { brand: "Google Chrome", version },
    { brand: "Not_A Brand", version: grease },
  ];
  override.userAgentMetadata = {
    brands: brands(major, "99"),
    fullVersionList: brands(fullVersion, "99.0.0.0"),
    fullVersion,
    platform,
    platformVersion: matchesHost
      ? host.systemVersion
      : platform === "Windows"
        ? "10.0.0"
        : "",
    architecture: host.arch === "arm64" ? "arm" : "x86",
    bitness: "64",
    model: "",
    mobile: platform === "Android",
    wow64: false,
  };
  return override;
}
