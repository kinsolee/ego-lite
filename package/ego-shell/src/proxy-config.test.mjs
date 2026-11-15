import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptLanguages,
  describeProxy,
  sessionProxyConfig,
} from "../dist/proxy-config.js";

test("a profile without a proxy connects directly", () => {
  assert.deepEqual(sessionProxyConfig({ scheme: "none" }, undefined), {
    mode: "direct",
  });
});

for (const scheme of ["socks5", "http"]) {
  test(`a ${scheme} profile routes everything, loopback included, through its relay`, () => {
    const config = sessionProxyConfig(
      {
        scheme,
        host: "proxy.example",
        port: 1080,
        username: "u",
        password: "p",
      },
      51234,
    );
    assert.deepEqual(config, {
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:51234",
      proxyBypassRules: "<-loopback>",
    });
    assert.doesNotMatch(JSON.stringify(config), /proxy\.example|"p"/);
  });
}

test("a proxied profile without a relay is refused instead of going direct", () => {
  assert.throws(
    () =>
      sessionProxyConfig({ scheme: "socks5", host: "h", port: 1 }, undefined),
    /needs a running relay/,
  );
});

test("accept-language lists the region tag before its base language", () => {
  assert.equal(acceptLanguages("pt-BR"), "pt-BR,pt");
  assert.equal(acceptLanguages("ja"), "ja");
});

test("a printed proxy endpoint omits the password", () => {
  const printed = describeProxy({
    scheme: "socks5",
    host: "proxy.example",
    port: 1080,
    username: "shop-user",
    password: "s3cret-pass",
  });
  assert.equal(printed, "socks5://shop-user@proxy.example:1080");
  assert.equal(describeProxy({ scheme: "none" }), "direct");
});
