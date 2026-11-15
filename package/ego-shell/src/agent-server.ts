import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

/** An error the agent sees as `{ error, error_code }`, per the native bindings contract. */
export class EgoError extends Error {
  constructor(
    message: string,
    readonly error_code: string,
  ) {
    super(message);
  }
}

export type AgentConnection = {
  readonly id: number;
  sendCdp(message: string): void;
  sendCdpError(message: string, errorCode: string): void;
};

export type AgentHandlers = {
  call(
    connection: AgentConnection,
    method: string,
    args: unknown[],
    spaceId: number | undefined,
  ): Promise<unknown>;
  cdp(
    connection: AgentConnection,
    spaceId: number | undefined,
    message: string,
  ): void;
  closed(connection: AgentConnection): void;
};

export type AgentServer = {
  port: number;
  token: string;
  close(): Promise<void>;
};

/** Until hello, in bytes: room for the hello line and little else. */
const UNAUTHENTICATED_LINE_LIMIT = 4 * 1024;
/** After hello, in bytes: a full-page screenshot as base64 fits in one CDP message. */
const AUTHENTICATED_LINE_LIMIT = 64 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 2_000;
const NEWLINE = 0x0a;

/**
 * Split a byte stream into newline-delimited JSON messages. A line longer than
 * `limit()` bytes destroys the socket instead of buffering without end.
 */
export function readLines(
  socket: net.Socket,
  onLine: (line: string) => void,
  limit: () => number,
): void {
  // A newline byte never occurs inside a multi-byte UTF-8 sequence, so lines
  // split on raw bytes and are decoded whole.
  const parts: Buffer[] = [];
  let size = 0;
  socket.on("data", (chunk: Buffer) => {
    let start = 0;
    let end = chunk.indexOf(NEWLINE);
    while (end >= 0 && !socket.destroyed) {
      size += end - start;
      if (size > limit()) break;
      parts.push(chunk.subarray(start, end));
      const line = Buffer.concat(parts).toString("utf8");
      parts.length = 0;
      size = 0;
      if (line) onLine(line);
      start = end + 1;
      end = chunk.indexOf(NEWLINE, start);
    }
    if (end >= 0) return void socket.destroy();
    parts.push(chunk.subarray(start));
    size += chunk.length - start;
    if (size > limit()) socket.destroy();
  });
}

function sameToken(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Serve the agent bridge on loopback. The endpoint file carries the port and
 * a random token and is readable by the owner only, so other local users
 * cannot drive the browser.
 */
export async function startAgentServer(options: {
  endpointFile: string;
  handlers: AgentHandlers;
}): Promise<AgentServer> {
  const { endpointFile, handlers } = options;
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<net.Socket>();
  let nextConnectionId = 1;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    const send = (message: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    let connection: AgentConnection | undefined;
    const silence = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);

    const onMessage = async (message: any) => {
      if (!connection) {
        if (message?.t !== "hello" || !sameToken(token, message.token)) {
          socket.destroy();
          return;
        }
        clearTimeout(silence);
        connection = {
          id: nextConnectionId++,
          sendCdp: (payload) => send({ t: "cdp", message: payload }),
          sendCdpError: (payload, errorCode) =>
            send({ t: "cdpError", message: payload, error_code: errorCode }),
        };
        send({ t: "ready" });
        return;
      }
      if (message?.t === "cdp") {
        handlers.cdp(connection, message.spaceId, String(message.message));
        return;
      }
      if (message?.t !== "call") return;
      try {
        const value = await handlers.call(
          connection,
          String(message.method),
          Array.isArray(message.args) ? message.args : [],
          message.spaceId,
        );
        send({ t: "result", id: message.id, ok: true, value });
      } catch (error) {
        send({
          t: "result",
          id: message.id,
          ok: false,
          error: {
            message: (error as Error)?.message ?? String(error),
            error_code:
              (error as EgoError)?.error_code ?? "EGO_OPERATION_FAILED",
          },
        });
      }
    };

    readLines(
      socket,
      (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        void onMessage(message);
      },
      () =>
        connection ? AUTHENTICATED_LINE_LIMIT : UNAUTHENTICATED_LINE_LIMIT,
    );
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(silence);
      sockets.delete(socket);
      if (connection) handlers.closed(connection);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  await mkdir(path.dirname(endpointFile), { recursive: true });
  await writeFile(
    endpointFile,
    `${JSON.stringify({ host: "127.0.0.1", port, token, pid: process.pid })}\n`,
    { mode: 0o600 },
  );
  // `mode` is ignored when the file already exists from an earlier run.
  await chmod(endpointFile, 0o600);

  return {
    port,
    token,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(endpointFile, { force: true });
    },
  };
}
