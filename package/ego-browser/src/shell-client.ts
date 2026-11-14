import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// ego-shell (package/ego-shell) serves the native bindings of
// docs/native-bindings-api.md over a local socket. This module turns that
// socket into the `globalThis.ego` object the rest of the harness expects, so
// nothing past the CLI entrypoint knows which browser it is driving.

const CONNECT_TIMEOUT_MS = 2000;
const ENDPOINT_FILE = "agent-endpoint.json";

const ASYNC_METHODS = [
  "getBrowserVersion",
  "listProfiles",
  "listTaskSpaces",
  "createTaskSpace",
  "claimTaskSpace",
  "createTab",
  "listTabs",
  "snapshot",
  "closeTaskSpace",
  "completeTaskSpace",
  "handOffTaskSpace",
  "takeOverTaskSpace",
  "setAgentTaskState",
  "animationHighlightMouseToPosition",
] as const;

// The native bindings resolve failures as `{ error, error_code }`; snapshot is
// the documented exception and rejects.
const REJECTING_METHODS = new Set<string>(["snapshot"]);

type Endpoint = { host: string; port: number; token: string; pid: number };
type BindingError = { message: string; error_code: string };
type Pending = { method: string; settle: (reply: Reply) => void };
type Reply = { ok: true; value: unknown } | { ok: false; error: BindingError };

export type ShellEgo = Record<string, unknown> & {
  onCDPMessage?: (message: string) => void;
  onSendCDPMessageError?: (message: string, errorCode: string) => void;
};
export type ShellConnection = {
  ego: ShellEgo;
  /** Process id of the shell, which outlives the CLI rounds that drive it. */
  hostPid: number;
  close: () => void;
};

function codedError<T extends Error>(error: T, code: string): T {
  return Object.assign(error, { error_code: code });
}

/** Where ego-shell writes its endpoint file when it runs with default settings. */
export function defaultShellEndpointFile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = env.HOME || env.USERPROFILE || os.homedir(),
): string {
  const appData =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA || path.join(home, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(appData, "ego-shell", ENDPOINT_FILE);
}

function readEndpoint(file: string): Endpoint {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (
    typeof parsed?.host !== "string" ||
    !Number.isInteger(parsed?.port) ||
    !Number.isInteger(parsed?.pid) ||
    typeof parsed?.token !== "string"
  ) {
    throw new Error(`${file} is not an ego-shell endpoint file`);
  }
  return parsed;
}

function openSocket(endpoint: Endpoint): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      fail(new Error("Timed out connecting to ego-shell")),
    );
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.off("error", fail);
      resolve(socket);
    });
  });
}

/**
 * Connect to a running ego-shell and build its `ego` bindings.
 *
 * `EGO_SHELL_ENDPOINT` names the endpoint file explicitly, and then any failure
 * is an error. Without it the default location is tried, and a missing file or
 * a shell that is no longer running means "no shell": the result is undefined.
 */
export async function connectShellEgo(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShellConnection | undefined> {
  const explicit = env.EGO_SHELL_ENDPOINT;
  const file = explicit || defaultShellEndpointFile(env);
  let socket: net.Socket;
  let endpoint: Endpoint;
  try {
    endpoint = readEndpoint(file);
    socket = await openSocket(endpoint);
  } catch (error) {
    if (!explicit) return undefined;
    throw new Error(
      `Cannot reach ego-shell through EGO_SHELL_ENDPOINT=${explicit}: ${(error as Error).message}`,
    );
  }

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let selectedSpace: number | undefined;
  let open = true;
  let ready: () => void;
  let refuse: (error: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => {
    ready = resolve;
    refuse = reject;
  });

  const send = (message: unknown) => {
    socket.write(`${JSON.stringify(message)}\n`);
  };

  const call = (method: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const settle = (reply: Reply) => {
        if (reply.ok === true) {
          resolve(reply.value);
          return;
        }
        const { message, error_code } = reply.error;
        if (REJECTING_METHODS.has(method)) {
          reject(codedError(new Error(message), error_code));
        } else {
          resolve({ error: message, error_code });
        }
      };
      if (!open) {
        settle(DISCONNECTED);
        return;
      }
      const id = nextId++;
      pending.set(id, { method, settle });
      send({ t: "call", id, method, args, spaceId: selectedSpace });
    });

  const ego: ShellEgo = {
    useTaskSpace(id: unknown) {
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw codedError(
          new TypeError("useTaskSpace expects a task space id"),
          "EGO_INVALID_ARGUMENT",
        );
      }
      selectedSpace = id;
      return id;
    },
    sendCDPMessage(message: unknown) {
      if (typeof message !== "string") {
        throw codedError(
          new TypeError("sendCDPMessage expects a JSON string"),
          "EGO_INVALID_ARGUMENT",
        );
      }
      if (!open) {
        throw codedError(
          new TypeError("ego-shell disconnected"),
          "EGO_CDP_CHANNEL_UNAVAILABLE",
        );
      }
      send({ t: "cdp", spaceId: selectedSpace, message });
    },
  };
  for (const method of ASYNC_METHODS) {
    ego[method] = (...args: unknown[]) => call(method, args);
  }

  const onMessage = (message: any) => {
    switch (message?.t) {
      case "ready":
        ready();
        break;
      case "result": {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        entry?.settle(
          message.ok
            ? { ok: true, value: message.value }
            : { ok: false, error: message.error },
        );
        break;
      }
      case "cdp":
        ego.onCDPMessage?.(message.message);
        break;
      case "cdpError":
        ego.onSendCDPMessageError?.(message.message, message.error_code);
        break;
    }
  };

  const decoder = new StringDecoder("utf8");
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += decoder.write(chunk);
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) onMessage(JSON.parse(line));
      newline = buffered.indexOf("\n");
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    open = false;
    refuse(new Error("ego-shell refused the connection"));
    for (const entry of pending.values()) entry.settle(DISCONNECTED);
    pending.clear();
  });

  send({ t: "hello", token: endpoint.token });
  try {
    await handshake;
  } catch (error) {
    if (!explicit) return undefined;
    throw new Error(
      `Cannot reach ego-shell through EGO_SHELL_ENDPOINT=${explicit}: ${(error as Error).message}`,
    );
  }
  return { ego, hostPid: endpoint.pid, close: () => socket.destroy() };
}

const DISCONNECTED: Reply = {
  ok: false,
  error: {
    message: "ego-shell disconnected",
    error_code: "EGO_BROWSER_UNAVAILABLE",
  },
};
