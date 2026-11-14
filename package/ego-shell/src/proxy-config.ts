import type { ProxyConfig } from "./profile-store.js";

export type SessionProxyConfig =
  | { mode: "direct" }
  | { mode: "fixed_servers"; proxyRules: string; proxyBypassRules: string };

/**
 * Translate a profile proxy into Chromium session proxy settings.
 *
 * Chromium cannot authenticate to a SOCKS5 proxy, so every upstream proxy is
 * reached through the profile's local relay. The relay is addressed as SOCKS5
 * because Chromium then sends host names instead of resolving them locally.
 */
export function sessionProxyConfig(
  proxy: ProxyConfig,
  relayPort: number | undefined,
): SessionProxyConfig {
  if (proxy.scheme === "none") return { mode: "direct" };
  if (!relayPort) {
    throw new Error("A proxied profile needs a running relay");
  }
  return {
    mode: "fixed_servers",
    proxyRules: `socks5://127.0.0.1:${relayPort}`,
    // Chromium bypasses the proxy for loopback hosts unless told otherwise;
    // a proxied profile must not have a direct path at all.
    proxyBypassRules: "<-loopback>",
  };
}

/** `pt-BR` becomes `pt-BR,pt`, the list a browser in that locale advertises. */
export function acceptLanguages(locale: string): string {
  const language = locale.split("-")[0];
  return language === locale ? locale : `${locale},${language}`;
}

/** A proxy endpoint that is safe to print: the password is never included. */
export function describeProxy(proxy: ProxyConfig): string {
  if (proxy.scheme === "none") return "direct";
  const user = proxy.username ? `${proxy.username}@` : "";
  return `${proxy.scheme}://${user}${proxy.host}:${proxy.port}`;
}
