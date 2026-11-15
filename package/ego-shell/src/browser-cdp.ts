export type CdpEvent = { method: string; params: any; sessionId?: string };

/** How long the shell waits for a reply to a command it sends for its own bookkeeping. */
export const COMMAND_TIMEOUT_MS = 15_000;

/** The browser kept its socket open but never answered a command. */
export class CdpTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`The browser did not answer ${method} within ${timeoutMs} ms`);
    this.name = "CdpTimeoutError";
  }
}

type Pending = {
  resolve(result: any): void;
  reject(error: Error): void;
};

/** One browser-level CDP websocket carrying every session of a kernel process. */
export class CdpConnection {
  /** Settles when the socket is gone, whichever side closed it. */
  readonly closed: Promise<void>;
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  readonly #timeoutMs: number;
  #nextId = 1;

  private constructor(
    socket: WebSocket,
    onEvent: (event: CdpEvent) => void,
    timeoutMs: number,
  ) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.id === undefined) {
        onEvent(payload);
        return;
      }
      const pending = this.#pending.get(payload.id);
      this.#pending.delete(payload.id);
      if (payload.error) pending?.reject(new Error(payload.error.message));
      else pending?.resolve(payload.result);
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", () => {
        for (const pending of this.#pending.values()) {
          pending.reject(new Error("Browser connection closed"));
        }
        this.#pending.clear();
        resolve();
      });
    });
  }

  static connect(
    endpoint: string,
    onEvent: (event: CdpEvent) => void,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const connection = new CdpConnection(socket, onEvent, timeoutMs);
      // A kernel can accept the connection and never finish the handshake.
      const timer = setTimeout(() => {
        // Closing fires the error listener synchronously, so reject first.
        reject(new CdpTimeoutError("the WebSocket handshake", timeoutMs));
        socket.close();
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(connection);
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to the browser's debugging port"));
      });
    });
  }

  /**
   * Fails with `CdpTimeoutError` when no reply comes within `timeoutMs`, the
   * connection's limit by default. `Infinity` waits for as long as it takes.
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = this.#timeoutMs,
  ): Promise<any> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Browser connection closed"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(new CdpTimeoutError(method, timeoutMs));
          }, timeoutMs)
        : undefined;
      const settle = () => clearTimeout(timer);
      this.#pending.set(id, {
        resolve: (result) => {
          settle();
          resolve(result);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close(): void {
    this.#socket.close();
  }
}
