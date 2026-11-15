// Authenticated upstream proxies for tests and the local end-to-end proof.
// Each records the destinations it was asked to reach, as the client named them.
// `hosts` maps names only the proxy can resolve to an address, which lets a
// test show that name resolution happened at the proxy and not at the client.
import http from "node:http";
import net from "node:net";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closer(server, sockets) {
  return () =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
}

function track(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

function reader(socket) {
  let buffer = Buffer.alloc(0);
  let wake;
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  });
  socket.on("error", () => {});
  return {
    async read(length) {
      while (buffer.length < length) {
        if (socket.destroyed) throw new Error("closed");
        await new Promise((resolve) => {
          wake = resolve;
          socket.once("close", resolve);
        });
      }
      const head = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      return head;
    },
    release() {
      socket.removeAllListeners("data");
      return buffer;
    },
  };
}

/**
 * `allowListed` makes it behave like a gateway that also trusts this machine's
 * address: offered both methods, it picks no authentication, so it never sees
 * the user name that carries the gateway's routing options.
 */
export async function startFakeSocks5({
  username,
  password,
  hosts = {},
  allowListed = false,
}) {
  const log = [];
  const server = net.createServer(async (client) => {
    const input = reader(client);
    try {
      const [, methodCount] = await input.read(2);
      const methods = [...(await input.read(methodCount))];
      let user;
      if (allowListed && methods.includes(0)) {
        client.write(Buffer.from([5, 0]));
      } else if (!methods.includes(2)) {
        log.push({ rejected: "no-credentials-offered" });
        client.end(Buffer.from([5, 0xff]));
        return;
      } else {
        client.write(Buffer.from([5, 2]));
        const [, userLength] = await input.read(2);
        user = (await input.read(userLength)).toString();
        const [passLength] = await input.read(1);
        const pass = (await input.read(passLength)).toString();
        if (user !== username || pass !== password) {
          log.push({ rejected: "bad-credentials", user });
          client.end(Buffer.from([1, 1]));
          return;
        }
        client.write(Buffer.from([1, 0]));
      }
      const [, , , type] = await input.read(4);
      let host;
      if (type === 1) host = [...(await input.read(4))].join(".");
      else if (type === 3) {
        const [length] = await input.read(1);
        host = (await input.read(length)).toString();
      } else {
        const bytes = await input.read(16);
        host = bytes.toString("hex").replace(/(.{4})(?=.)/g, "$1:");
      }
      const port = (await input.read(2)).readUInt16BE();
      log.push({ host, port, user, addressType: type });
      const remote = net.connect({ host: hosts[host] ?? host, port });
      remote.once("error", () =>
        client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])),
      );
      remote.once("connect", () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        const early = input.release();
        if (early.length) remote.write(early);
        client.pipe(remote);
        remote.pipe(client);
        client.on("close", () => remote.destroy());
        remote.on("close", () => client.destroy());
      });
    } catch {
      client.destroy();
    }
  });
  const sockets = track(server);
  return { port: await listen(server), log, close: closer(server, sockets) };
}

export async function startFakeHttpProxy({ username, password, hosts = {} }) {
  const log = [];
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const server = http.createServer((_request, response) => {
    response.writeHead(405).end();
  });
  server.on("connect", (request, client, head) => {
    client.on("error", () => {});
    if (request.headers["proxy-authorization"] !== expected) {
      log.push({ rejected: "bad-credentials" });
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const separator = request.url.lastIndexOf(":");
    const host = request.url.slice(0, separator).replace(/^\[|\]$/g, "");
    const port = Number(request.url.slice(separator + 1));
    log.push({ host, port, user: username });
    const remote = net.connect({ host: hosts[host] ?? host, port });
    remote.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    remote.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
      client.on("close", () => remote.destroy());
      remote.on("close", () => client.destroy());
    });
  });
  const sockets = track(server);
  return { port: await listen(server), log, close: closer(server, sockets) };
}
