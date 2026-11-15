import assert from "node:assert/strict";
import test from "node:test";

import { browserUserAgent, userAgentOverride } from "../dist/fingerprint.js";

const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ego-shell/0.1.0 Chrome/146.0.7680.72 Electron/45.3.2 Safari/537.36";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const macHost = {
  chromeVersion: "146.0.7680.72",
  platform: "darwin",
  arch: "arm64",
  systemVersion: "15.5.0",
};
const fingerprint = {
  seed: "s",
  locale: "pt-BR",
  timezone: "America/Sao_Paulo",
};

test("the default user agent is Chrome's: no app or Electron token, reduced version", () => {
  assert.equal(browserUserAgent(ELECTRON_UA), CHROME_UA);
});

test("a user agent that is already Chrome's is left alone", () => {
  assert.equal(browserUserAgent(CHROME_UA), CHROME_UA);
});

test("a profile without its own user agent gets the default, with matching client hints", () => {
  const override = userAgentOverride(fingerprint, CHROME_UA, macHost);

  assert.equal(override.userAgent, CHROME_UA);
  assert.equal(override.acceptLanguage, "pt-BR,pt");
  assert.deepEqual(override.userAgentMetadata, {
    brands: [
      { brand: "Chromium", version: "146" },
      { brand: "Google Chrome", version: "146" },
      { brand: "Not_A Brand", version: "99" },
    ],
    fullVersionList: [
      { brand: "Chromium", version: "146.0.7680.72" },
      { brand: "Google Chrome", version: "146.0.7680.72" },
      { brand: "Not_A Brand", version: "99.0.0.0" },
    ],
    fullVersion: "146.0.7680.72",
    platform: "macOS",
    platformVersion: "15.5.0",
    architecture: "arm",
    bitness: "64",
    model: "",
    mobile: false,
    wow64: false,
  });
});

test("a Windows user agent on a Mac reports Windows hints, not the host's", () => {
  const windowsUa =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  const { userAgent, userAgentMetadata } = userAgentOverride(
    { ...fingerprint, userAgent: windowsUa },
    CHROME_UA,
    macHost,
  );

  assert.equal(userAgent, windowsUa);
  assert.equal(userAgentMetadata.platform, "Windows");
  assert.equal(userAgentMetadata.platformVersion, "10.0.0");
  assert.equal(userAgentMetadata.brands[1].version, "140");
  // The kernel is 146, so the profile's claimed 140 must not leak the real build.
  assert.equal(userAgentMetadata.fullVersion, "140.0.0.0");
  assert.doesNotMatch(JSON.stringify(userAgentMetadata), /7680|15\.5\.0/);
});

test("a user agent that is not Chrome's carries no Chrome client hints", () => {
  const firefox =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0";
  const override = userAgentOverride(
    { ...fingerprint, userAgent: firefox },
    CHROME_UA,
    macHost,
  );

  assert.equal(override.userAgent, firefox);
  assert.equal(override.userAgentMetadata, undefined);
});
