import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { ProfileNetworks } from "../dist/profile-network.js";

function profile(port, overrides = {}) {
  return {
    id: "br",
    name: "Brazil",
    kernel: "electron",
    proxy: port
      ? { scheme: "socks5", host: "upstream.test", port }
      : { scheme: "none" },
    fingerprint: { seed: "s", locale: "pt-BR", timezone: "America/Recife" },
    ...overrides,
  };
}

/** A session whose calls can be made to fail or stall, recording what is in force. */
function fakeSession() {
  return {
    proxy: undefined,
    userAgent: undefined,
    fail: {},
    stall: {},
    async setProxy(config) {
      await this.stall.setProxy;
      if (this.fail.setProxy?.(config)) throw new Error("setProxy failed");
      this.proxy = config;
    },
    async closeAllConnections() {
      if (this.fail.closeAllConnections?.()) {
        throw new Error("closeAllConnections failed");
      }
    },
    setUserAgent(userAgent, languages) {
      if (this.fail.setUserAgent?.(userAgent)) {
        throw new Error("setUserAgent failed");
      }
      this.userAgent = [userAgent, languages];
    },
  };
}

function setup(options = {}) {
  const session = fakeSession();
  const relays = [];
  let nextPort = 40_000;
  /** When set, the next relay fails to start with this error. */
  const relayStart = { error: undefined };
  const networks = new ProfileNetworks({
    ...options,
    session: () => session,
    async startRelay(proxy) {
      await delay(5);
      const { error } = relayStart;
      relayStart.error = undefined;
      if (error) throw error;
      const relay = {
        port: nextPort++,
        upstream: proxy.port,
        open: true,
        async close() {
          relay.open = false;
        },
      };
      relays.push(relay);
      return relay;
    },
    overrides: (p) => ({
      timezone: p.fingerprint.timezone,
      locale: p.fingerprint.locale,
      userAgent: {
        userAgent: p.fingerprint.userAgent ?? "UA",
        acceptLanguage: "pt-BR,pt",
      },
    }),
  });
  const openRelays = () => relays.filter((relay) => relay.open);
  const proxyPort = () =>
    Number(session.proxy?.proxyRules?.split(":").at(-1) ?? NaN);
  return { networks, session, relays, relayStart, openRelays, proxyPort };
}

test("a proxied profile runs through one relay, replaced on update and closed on release", async () => {
  const { networks, session, openRelays, proxyPort } = setup();

  const live = await networks.start(profile(1080));
  assert.equal(openRelays().length, 1);
  assert.equal(proxyPort(), openRelays()[0].port);

  const updated = await networks.update(profile(1081));
  assert.equal(updated, live, "spaces keep the same live object");
  assert.deepEqual(
    openRelays().map((relay) => relay.upstream),
    [1081],
  );
  assert.equal(proxyPort(), openRelays()[0].port);
  assert.equal(live.profile.proxy.port, 1081);

  await networks.release("br");
  assert.equal(openRelays().length, 0);
  assert.equal(networks.live().length, 0);
  assert.deepEqual(session.userAgent, ["UA", "pt-BR,pt"]);
});

test("two updates at once leave one relay open, the one in force", async () => {
  const { networks, openRelays, proxyPort } = setup();
  await networks.start(profile(1080));

  await Promise.all([
    networks.update(profile(1081)),
    networks.update(profile(1082)),
  ]);

  assert.deepEqual(
    openRelays().map((relay) => relay.upstream),
    [1082],
  );
  assert.equal(proxyPort(), openRelays()[0].port);
  assert.equal(networks.live()[0].profile.proxy.port, 1082);
});

test("a release during an update leaves no relay open and nothing live", async () => {
  const { networks, openRelays } = setup();
  await networks.start(profile(1080));

  const updating = networks.update(profile(1081));
  await networks.release("br");
  await updating;

  assert.equal(openRelays().length, 0);
  assert.equal(networks.live().length, 0);
});

test("a start after a release runs on a fresh entry", async () => {
  const { networks, openRelays } = setup();
  const first = await networks.start(profile(1080));

  const releasing = networks.release("br");
  const again = await networks.start(profile(1081));
  await releasing;

  assert.notEqual(again, first);
  assert.deepEqual(
    openRelays().map((relay) => relay.upstream),
    [1081],
  );
  assert.equal(networks.live()[0], again);
});

test("a proxy switch that cannot be undone takes the profile down, and the next start is clean", async () => {
  const { networks, session, openRelays, proxyPort } = setup();
  await networks.start(profile(1080));
  let calls = 0;
  session.fail.closeAllConnections = () => true;
  session.fail.setProxy = () => ++calls > 1;

  await assert.rejects(networks.update(profile(1081)), {
    name: "ProfileUnusableError",
  });

  assert.equal(networks.live().length, 0, "nothing claims the old state");
  assert.equal(openRelays().length, 0);

  session.fail = {};
  const again = await networks.start(profile(1082));
  assert.equal(again.profile.proxy.port, 1082);
  assert.deepEqual(
    openRelays().map((relay) => relay.upstream),
    [1082],
  );
  assert.equal(proxyPort(), openRelays()[0].port);
});

test("a user agent that fails to apply rolls the proxy switch back", async () => {
  const { networks, session, openRelays, proxyPort } = setup();
  const live = await networks.start(profile(1080));
  const before = { ...session.userAgent };
  session.fail.setUserAgent = (userAgent) => userAgent === "UA2";

  await assert.rejects(
    networks.update(
      profile(1081, {
        fingerprint: { ...profile().fingerprint, userAgent: "UA2" },
      }),
    ),
    { message: "setUserAgent failed" },
  );

  assert.equal(live.profile.proxy.port, 1080);
  assert.equal(live.overrides.userAgent.userAgent, "UA");
  assert.deepEqual(
    openRelays().map((relay) => relay.upstream),
    [1080],
  );
  assert.equal(proxyPort(), openRelays()[0].port);
  assert.deepEqual({ ...session.userAgent }, before);
  assert.equal(networks.live()[0], live);
});

/** Settles with the promise's rejection, or "still waiting" if it takes too long. */
async function rejection(promise) {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error) => error,
    ),
    delay(2_000).then(() => "still waiting"),
  ]);
}

test("a profile that cannot be restored is reported unusable even when its relay fails to close", async () => {
  const { networks, session } = setup();
  const live = await networks.start(profile(1080));
  const closeError = new Error("relay close failed");
  live.relay.close = () => Promise.reject(closeError);
  let calls = 0;
  session.fail.closeAllConnections = () => true;
  session.fail.setProxy = () => ++calls > 1;

  const error = await rejection(networks.update(profile(1081)));

  assert.equal(error.name, "ProfileUnusableError");
  assert.ok(error.cause.errors.includes(closeError), "the close error is kept");
  assert.equal(networks.live().length, 0);
});

test("a profile that cannot be restored is reported unusable even when its relay never closes", async () => {
  const { networks, session } = setup({ relayCloseTimeoutMs: 50 });
  const live = await networks.start(profile(1080));
  live.relay.close = () => new Promise(() => {});
  let calls = 0;
  session.fail.closeAllConnections = () => true;
  session.fail.setProxy = () => ++calls > 1;

  const error = await rejection(networks.update(profile(1081)));

  assert.equal(error.name, "ProfileUnusableError");
  assert.equal(networks.live().length, 0);
});

test("a relay that fails to start leaves the running profile as it was", async () => {
  const { networks, session, relayStart, openRelays, proxyPort } = setup();
  const live = await networks.start(profile(1080));
  const inUse = Object.assign(new Error("listen EADDRINUSE"), {
    code: "EADDRINUSE",
  });
  relayStart.error = inUse;
  let setProxyCalls = 0;
  session.fail.setProxy = () => (++setProxyCalls, true);

  await assert.rejects(networks.update(profile(1081)), inUse);

  assert.equal(setProxyCalls, 0, "the session was not touched");
  assert.equal(networks.live()[0], live);
  assert.equal(live.profile.proxy.port, 1080);
  assert.deepEqual(
    openRelays().map((relay) => relay.upstream),
    [1080],
  );
  assert.equal(proxyPort(), openRelays()[0].port);
});
