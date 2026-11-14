import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { connectThroughUpstream, startRelay } from "../dist/proxy-relay.js";
import {
  startFakeHttpProxy,
  startFakeSocks5,
} from "../test-support/fake-proxies.mjs";

async function startOrigin() {
  const server = http.createServer((request, response) => {
    response.end(`origin saw ${request.url}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Speak to the relay the way Chromium does: SOCKS5, no credentials, host name. */
async function getThroughRelay(relayPort, host, port, path) {
  const socket = await connectThroughUpstream(
    { scheme: "socks5", host: "127.0.0.1", port: relayPort },
    host,
    port,
    2000,
  );
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
  );
  let body = "";
  for await (const chunk of socket) body += chunk;
  return body;
}

const CREDENTIALS = { username: "shop-user", password: "s3cret-pass" };

for (const [scheme, startUpstream] of [
  ["socks5", startFakeSocks5],
  ["http", startFakeHttpProxy],
]) {
  test(`relay authenticates to a ${scheme} upstream and tunnels the request`, async (t) => {
    const origin = await startOrigin();
    const upstream = await startUpstream(CREDENTIALS);
    const relay = await startRelay({
      scheme,
      host: "127.0.0.1",
      port: upstream.port,
      ...CREDENTIALS,
    });
    t.after(() =>
      Promise.all([relay.close(), upstream.close(), origin.close()]),
    );

    const body = await getThroughRelay(
      relay.port,
      "localhost",
      origin.port,
      "/cart",
    );

    assert.match(body, /origin saw \/cart/);
    assert.equal(upstream.log.length, 1);
    assert.equal(upstream.log[0].user, CREDENTIALS.username);
    assert.equal(
      upstream.log[0].host,
      "localhost",
      "the upstream must receive the host name, not a locally resolved address",
    );
    assert.equal(upstream.log[0].port, origin.port);
  });

  test(`relay fails closed when the ${scheme} upstream rejects the credentials`, async (t) => {
    const origin = await startOrigin();
    const upstream = await startUpstream(CREDENTIALS);
    const relay = await startRelay({
      scheme,
      host: "127.0.0.1",
      port: upstream.port,
      username: CREDENTIALS.username,
      password: "wrong",
    });
    t.after(() =>
      Promise.all([relay.close(), upstream.close(), origin.close()]),
    );

    await assert.rejects(
      getThroughRelay(relay.port, "localhost", origin.port, "/cart"),
      /Proxy refused the connection/,
    );
    assert.deepEqual(
      upstream.log.map((entry) => entry.rejected),
      ["bad-credentials"],
    );
  });
}

test("relay fails closed when the upstream is unreachable", async (t) => {
  const origin = await startOrigin();
  const dead = await startFakeSocks5(CREDENTIALS);
  const deadPort = dead.port;
  await dead.close();
  const relay = await startRelay({
    scheme: "socks5",
    host: "127.0.0.1",
    port: deadPort,
    ...CREDENTIALS,
  });
  t.after(() => Promise.all([relay.close(), origin.close()]));

  await assert.rejects(
    getThroughRelay(relay.port, "localhost", origin.port, "/"),
    /Proxy refused the connection/,
  );
});

test("upstream errors never carry the password", async (t) => {
  const upstream = await startFakeSocks5(CREDENTIALS);
  t.after(() => upstream.close());
  const error = await connectThroughUpstream(
    {
      scheme: "socks5",
      host: "127.0.0.1",
      port: upstream.port,
      username: "shop-user",
      password: "leaky-password",
    },
    "localhost",
    80,
    2000,
  ).catch((caught) => caught);
  assert.match(error.message, /rejected the credentials/);
  assert.doesNotMatch(error.message, /leaky-password/);
});
