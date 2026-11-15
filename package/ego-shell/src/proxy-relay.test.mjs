import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
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

test("a gateway that also trusts this machine still receives the credentials", async (t) => {
  const origin = await startOrigin();
  const upstream = await startFakeSocks5({ ...CREDENTIALS, allowListed: true });
  const relay = await startRelay({
    scheme: "socks5",
    host: "127.0.0.1",
    port: upstream.port,
    ...CREDENTIALS,
  });
  t.after(() => Promise.all([relay.close(), upstream.close(), origin.close()]));

  const body = await getThroughRelay(relay.port, "localhost", origin.port, "/");

  assert.match(body, /origin saw \//);
  assert.deepEqual(
    upstream.log.map((entry) => entry.user),
    [CREDENTIALS.username],
  );
});

test("a SOCKS5 upstream that skips authentication for configured credentials is refused", async (t) => {
  const server = net.createServer((client) => {
    client.on("error", () => {});
    client.once("data", () => client.write(Buffer.from([5, 0])));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await assert.rejects(
    connectThroughUpstream(
      {
        scheme: "socks5",
        host: "127.0.0.1",
        port: server.address().port,
        ...CREDENTIALS,
      },
      "localhost",
      80,
      2000,
    ),
    /no acceptable authentication method/,
  );
});

test("without credentials the relay offers a SOCKS5 upstream only no authentication", async (t) => {
  const offered = [];
  const server = net.createServer((client) => {
    client.on("error", () => {});
    client.once("data", (chunk) => {
      offered.push([...chunk.subarray(2, 2 + chunk[1])]);
      client.end(Buffer.from([5, 0xff]));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await connectThroughUpstream(
    { scheme: "socks5", host: "127.0.0.1", port: server.address().port },
    "localhost",
    80,
    2000,
  ).catch(() => {});

  assert.deepEqual(offered, [[0]]);
});
