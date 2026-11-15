import net from "node:net";

import type { UpstreamProxy } from "./profile-store.js";

export type Relay = {
  port: number;
  close(): Promise<void>;
};

const SOCKS_VERSION = 5;
const AUTH_NONE = 0;
const AUTH_PASSWORD = 2;
const CMD_CONNECT = 1;
const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 3;
const ATYP_IPV6 = 4;
const REPLY_OK = 0;
const REPLY_GENERAL_FAILURE = 1;
const REPLY_COMMAND_UNSUPPORTED = 7;
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const MAX_HTTP_RESPONSE_HEAD = 16 * 1024;

/** Reads exact byte counts from a socket until the stream is handed to a pipe. */
class ByteReader {
  readonly #socket: net.Socket;
  #buffer = Buffer.alloc(0);
  #pending?: {
    ready: () => Buffer | undefined;
    resolve: (value: Buffer) => void;
    reject: (error: Error) => void;
  };
  #failure?: Error;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", this.#onData);
    socket.on("error", this.#onEnd);
    socket.on("close", this.#onEnd);
  }

  read(length: number): Promise<Buffer> {
    return this.#wait(() =>
      this.#buffer.length >= length ? this.#take(length) : undefined,
    );
  }

  readThrough(delimiter: string, limit: number): Promise<Buffer> {
    return this.#wait(() => {
      const index = this.#buffer.indexOf(delimiter);
      if (index >= 0) return this.#take(index + delimiter.length);
      if (this.#buffer.length > limit) {
        throw new Error("Proxy response header is too large");
      }
      return undefined;
    });
  }

  /** Stop reading and return bytes that arrived after the handshake. */
  release(): Buffer {
    this.#socket.off("data", this.#onData);
    this.#socket.off("error", this.#onEnd);
    this.#socket.off("close", this.#onEnd);
    return this.#take(this.#buffer.length);
  }

  #take(length: number): Buffer {
    const head = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return head;
  }

  #wait(ready: () => Buffer | undefined): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.#pending = { ready, resolve, reject };
      this.#settle();
    });
  }

  #settle(): void {
    const pending = this.#pending;
    if (!pending) return;
    try {
      const value = pending.ready();
      if (value) {
        this.#pending = undefined;
        pending.resolve(value);
      } else if (this.#failure) {
        this.#pending = undefined;
        pending.reject(this.#failure);
      }
    } catch (error) {
      this.#pending = undefined;
      pending.reject(error as Error);
    }
  }

  #onData = (chunk: Buffer) => {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.#settle();
  };

  #onEnd = (error?: Error | boolean) => {
    this.#failure =
      error instanceof Error ? error : new Error("Connection closed");
    this.#settle();
  };
}

function encodeAddress(host: string, port: number): Buffer {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  const family = net.isIP(host);
  if (family === 4) {
    return Buffer.concat([
      Buffer.from([ATYP_IPV4, ...host.split(".").map(Number)]),
      portBytes,
    ]);
  }
  if (family === 6) {
    return Buffer.concat([
      Buffer.from([ATYP_IPV6]),
      ipv6Bytes(host),
      portBytes,
    ]);
  }
  const name = Buffer.from(host);
  if (name.length > 255) throw new Error("Host name is too long for SOCKS5");
  return Buffer.concat([
    Buffer.from([ATYP_DOMAIN, name.length]),
    name,
    portBytes,
  ]);
}

function ipv6Bytes(host: string): Buffer {
  const [head, tail = ""] = host.split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = host.includes("::") ? groups(tail) : [];
  const zeros = new Array(8 - left.length - right.length).fill("0");
  const bytes = Buffer.alloc(16);
  [...left, ...zeros, ...right].forEach((group, index) => {
    bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2);
  });
  return bytes;
}

function ipv6Text(bytes: Buffer): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(bytes.readUInt16BE(index).toString(16));
  }
  return groups.join(":");
}

async function readAddress(
  reader: ByteReader,
  type: number,
): Promise<{ host: string; port: number }> {
  let host: string;
  if (type === ATYP_IPV4) {
    host = [...(await reader.read(4))].join(".");
  } else if (type === ATYP_DOMAIN) {
    const [length] = await reader.read(1);
    host = (await reader.read(length)).toString();
  } else if (type === ATYP_IPV6) {
    host = ipv6Text(await reader.read(16));
  } else {
    throw new Error(`Unsupported SOCKS5 address type ${type}`);
  }
  return { host, port: (await reader.read(2)).readUInt16BE() };
}

async function socks5Handshake(
  socket: net.Socket,
  reader: ByteReader,
  upstream: UpstreamProxy,
  host: string,
  port: number,
): Promise<void> {
  // Offering only the one method the profile is configured for matters: a
  // residential gateway that also allow-lists this machine picks no
  // authentication when it may, and then never sees the user name that carries
  // the country and sticky-session options, so shops would share one exit.
  const withAuth = Boolean(upstream.username || upstream.password);
  const offered = withAuth ? AUTH_PASSWORD : AUTH_NONE;
  socket.write(Buffer.from([SOCKS_VERSION, 1, offered]));
  const [, method] = await reader.read(2);
  if (method !== offered) {
    throw new Error("Proxy offered no acceptable authentication method");
  }
  if (withAuth) {
    const username = Buffer.from(upstream.username ?? "");
    const password = Buffer.from(upstream.password ?? "");
    socket.write(
      Buffer.concat([
        Buffer.from([1, username.length]),
        username,
        Buffer.from([password.length]),
        password,
      ]),
    );
    const [, status] = await reader.read(2);
    if (status !== 0) throw new Error("Proxy rejected the credentials");
  }
  socket.write(
    Buffer.concat([
      Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0]),
      encodeAddress(host, port),
    ]),
  );
  const [, reply, , boundType] = await reader.read(4);
  if (reply !== REPLY_OK) {
    throw new Error(`Proxy refused the connection (SOCKS5 reply ${reply})`);
  }
  await readAddress(reader, boundType);
}

async function httpConnectHandshake(
  socket: net.Socket,
  reader: ByteReader,
  upstream: UpstreamProxy,
  host: string,
  port: number,
): Promise<void> {
  const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (upstream.username || upstream.password) {
    const credentials = `${upstream.username ?? ""}:${upstream.password ?? ""}`;
    lines.push(
      `Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}`,
    );
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  const head = (
    await reader.readThrough("\r\n\r\n", MAX_HTTP_RESPONSE_HEAD)
  ).toString("latin1");
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
  if (status === "407") throw new Error("Proxy rejected the credentials");
  if (status !== "200") {
    throw new Error(`Proxy refused the connection (HTTP ${status ?? "?"})`);
  }
}

/**
 * Open a TCP tunnel to `host:port` through an upstream proxy. The host name is
 * handed to the proxy unresolved, so DNS happens at the proxy's exit.
 */
export function connectThroughUpstream(
  upstream: UpstreamProxy,
  host: string,
  port: number,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: upstream.host, port: upstream.port });
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error("Timed out connecting through the proxy")),
      timeoutMs,
    );
    socket.once("error", fail);
    socket.once("connect", () => {
      const reader = new ByteReader(socket);
      const handshake =
        upstream.scheme === "socks5" ? socks5Handshake : httpConnectHandshake;
      handshake(socket, reader, upstream, host, port).then(() => {
        clearTimeout(timer);
        socket.off("error", fail);
        const early = reader.release();
        if (early.length) socket.unshift(early);
        resolve(socket);
      }, fail);
    });
  });
}

async function serveClient(
  client: net.Socket,
  upstream: UpstreamProxy,
  timeoutMs: number,
): Promise<void> {
  const reader = new ByteReader(client);
  const [version, methodCount] = await reader.read(2);
  if (version !== SOCKS_VERSION) throw new Error("Not a SOCKS5 client");
  await reader.read(methodCount);
  client.write(Buffer.from([SOCKS_VERSION, AUTH_NONE]));

  const [, command, , addressType] = await reader.read(4);
  const { host, port } = await readAddress(reader, addressType);
  const reply = (code: number) =>
    Buffer.from([SOCKS_VERSION, code, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
  if (command !== CMD_CONNECT) {
    client.end(reply(REPLY_COMMAND_UNSUPPORTED));
    return;
  }

  let remote: net.Socket;
  try {
    remote = await connectThroughUpstream(upstream, host, port, timeoutMs);
  } catch {
    // Fail closed: the page load errors out instead of taking a direct path.
    client.end(reply(REPLY_GENERAL_FAILURE));
    return;
  }
  if (client.destroyed) {
    remote.destroy();
    return;
  }
  client.write(reply(REPLY_OK));
  const early = reader.release();
  if (early.length) remote.write(early);
  client.on("error", () => remote.destroy());
  remote.on("error", () => client.destroy());
  client.on("close", () => remote.destroy());
  remote.on("close", () => client.destroy());
  client.pipe(remote);
  remote.pipe(client);
}

/**
 * Start a loopback SOCKS5 listener that needs no credentials and forwards
 * every connection through the authenticated upstream proxy.
 */
export function startRelay(
  upstream: UpstreamProxy,
  options: { connectTimeoutMs?: number } = {},
): Promise<Relay> {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    serveClient(client, upstream, timeoutMs).catch(() => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
