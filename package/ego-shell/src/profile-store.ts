import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type UpstreamProxy = {
  scheme: "socks5" | "http";
  host: string;
  port: number;
  username?: string;
  password?: string;
};

export type ProxyConfig = { scheme: "none" } | UpstreamProxy;

export type Fingerprint = {
  /** Input for the patched kernel's per-profile noise; fixed for the profile's lifetime. */
  seed: string;
  locale: string;
  timezone: string;
  userAgent?: string;
};

/**
 * Which browser runs the profile. `electron` is the shell's own Chromium with
 * CDP overrides; `apostate` is a separate fingerprint-patched Chromium process.
 * The two keep separate storage, so switching starts from empty cookies.
 */
export type Kernel = "electron" | "apostate";

export type Profile = {
  id: string;
  name: string;
  kernel: Kernel;
  proxy: ProxyConfig;
  fingerprint: Fingerprint;
};

/** A profile as shown to the UI and logs: the proxy password never leaves the store. */
export type RedactedProfile = Omit<Profile, "proxy"> & {
  isDefault: boolean;
  proxy:
    | { scheme: "none" }
    | (Omit<UpstreamProxy, "password"> & { hasPassword: boolean });
};

export const DEFAULT_PROFILE_ID = "default";

export class ProfileInputError extends Error {}

type ProfileDraft = {
  name: string;
  kernel: Kernel;
  /** `password: undefined` on an upstream proxy means "keep the stored one". */
  proxy: ProxyConfig;
  locale: string;
  timezone: string;
  userAgent?: string;
};

export function partitionFor(profileId: string): string {
  return `persist:profile-${profileId}`;
}

export function redactProfile(profile: Profile): RedactedProfile {
  const { proxy } = profile;
  if (proxy.scheme === "none") {
    return { ...profile, proxy, isDefault: profile.id === DEFAULT_PROFILE_ID };
  }
  const { password, ...rest } = proxy;
  return {
    ...profile,
    isDefault: profile.id === DEFAULT_PROFILE_ID,
    proxy: { ...rest, hasPassword: Boolean(password) },
  };
}

function text(value: unknown, field: string, required = true): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ProfileInputError(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") {
    throw new ProfileInputError(`${field} must be a string`);
  }
  return value.trim();
}

function parseProxy(raw: unknown): ProxyConfig {
  const input = (raw ?? { scheme: "none" }) as Record<string, unknown>;
  const scheme = input.scheme ?? "none";
  if (scheme === "none") return { scheme: "none" };
  if (scheme !== "socks5" && scheme !== "http") {
    throw new ProfileInputError("proxy.scheme must be socks5, http, or none");
  }
  const host = text(input.host, "proxy.host");
  if (!host || /[\s/@]/.test(host)) {
    throw new ProfileInputError("proxy.host must be a bare host name or IP");
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProfileInputError("proxy.port must be an integer in 1-65535");
  }
  const username = text(input.username, "proxy.username", false);
  const proxy: UpstreamProxy = { scheme, host, port };
  if (username) proxy.username = username;
  if (typeof input.password === "string") proxy.password = input.password;
  else if (input.password !== undefined && input.password !== null) {
    throw new ProfileInputError("proxy.password must be a string");
  }
  // RFC 1929 carries each credential in a one-byte length field.
  for (const [field, value] of [
    ["proxy.username", proxy.username],
    ["proxy.password", proxy.password],
  ] as const) {
    if (value && Buffer.byteLength(value) > 255) {
      throw new ProfileInputError(`${field} must be at most 255 bytes`);
    }
  }
  return proxy;
}

function parseKernel(raw: unknown): Kernel {
  if (raw === undefined || raw === null || raw === "") return "electron";
  if (raw !== "electron" && raw !== "apostate") {
    throw new ProfileInputError("kernel must be electron or apostate");
  }
  return raw;
}

function parseDraft(raw: unknown): ProfileDraft {
  if (!raw || typeof raw !== "object") {
    throw new ProfileInputError("profile must be an object");
  }
  const input = raw as Record<string, unknown>;
  const fingerprint = (input.fingerprint ?? {}) as Record<string, unknown>;
  const name = text(input.name, "name");
  if (!name) throw new ProfileInputError("name is required");

  const localeText = text(fingerprint.locale, "locale", false) || "en-US";
  let locale: string;
  try {
    [locale] = Intl.getCanonicalLocales(localeText);
  } catch {
    throw new ProfileInputError(
      `locale is not a valid BCP 47 tag: ${localeText}`,
    );
  }

  const timezone = text(fingerprint.timezone, "timezone", false) || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new ProfileInputError(`timezone is not an IANA zone: ${timezone}`);
  }

  const userAgent = text(fingerprint.userAgent, "userAgent", false);
  return {
    name,
    kernel: parseKernel(input.kernel),
    proxy: parseProxy(input.proxy),
    locale,
    timezone,
    ...(userAgent ? { userAgent } : {}),
  };
}

function sameEndpoint(a: ProxyConfig, b: UpstreamProxy): a is UpstreamProxy {
  return (
    a.scheme === b.scheme &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username
  );
}

function defaultProfile(): Profile {
  return {
    id: DEFAULT_PROFILE_ID,
    name: "Default",
    kernel: "electron",
    proxy: { scheme: "none" },
    fingerprint: { seed: newSeed(), locale: "en-US", timezone: "UTC" },
  };
}

function newSeed(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Profiles persisted as one JSON file. The file holds proxy passwords in
 * plain text, so it is written owner-only.
 */
export class ProfileStore {
  readonly #file: string;
  #profiles: Profile[] = [];

  private constructor(file: string) {
    this.#file = file;
  }

  static async open(file: string): Promise<ProfileStore> {
    const store = new ProfileStore(file);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      const stored: Profile[] = Array.isArray(parsed?.profiles)
        ? parsed.profiles
        : [];
      // Files written before kernels existed have no `kernel` field.
      store.#profiles = stored.map((profile) => ({
        ...profile,
        kernel: profile.kernel ?? "electron",
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!store.get(DEFAULT_PROFILE_ID)) {
      store.#profiles.unshift(defaultProfile());
      await store.#save();
    }
    return store;
  }

  list(): Profile[] {
    return this.#profiles.map((profile) => structuredClone(profile));
  }

  get(id: string): Profile | undefined {
    const profile = this.#profiles.find((candidate) => candidate.id === id);
    return profile && structuredClone(profile);
  }

  async create(raw: unknown): Promise<Profile> {
    const draft = parseDraft(raw);
    const profile: Profile = {
      id: randomBytes(6).toString("hex"),
      name: draft.name,
      kernel: draft.kernel,
      proxy: draft.proxy,
      fingerprint: {
        seed: newSeed(),
        locale: draft.locale,
        timezone: draft.timezone,
        ...(draft.userAgent ? { userAgent: draft.userAgent } : {}),
      },
    };
    this.#profiles.push(profile);
    await this.#save();
    return structuredClone(profile);
  }

  async update(id: string, raw: unknown): Promise<Profile> {
    const index = this.#profiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new ProfileInputError(`Profile not found: ${id}`);
    const current = this.#profiles[index];
    const draft = parseDraft(raw);
    const proxy = draft.proxy;
    if (
      proxy.scheme !== "none" &&
      proxy.password === undefined &&
      sameEndpoint(current.proxy, proxy) &&
      current.proxy.password
    ) {
      proxy.password = current.proxy.password;
    }
    const updated: Profile = {
      id,
      name: draft.name,
      kernel: draft.kernel,
      proxy,
      fingerprint: {
        seed: current.fingerprint.seed,
        locale: draft.locale,
        timezone: draft.timezone,
        ...(draft.userAgent ? { userAgent: draft.userAgent } : {}),
      },
    };
    this.#profiles[index] = updated;
    await this.#save();
    return structuredClone(updated);
  }

  async remove(id: string): Promise<void> {
    if (id === DEFAULT_PROFILE_ID) {
      throw new ProfileInputError("The default profile cannot be removed");
    }
    const before = this.#profiles.length;
    this.#profiles = this.#profiles.filter((profile) => profile.id !== id);
    if (this.#profiles.length === before) {
      throw new ProfileInputError(`Profile not found: ${id}`);
    }
    await this.#save();
  }

  async #save(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ profiles: this.#profiles }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, this.#file);
  }
}
