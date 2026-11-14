export type CdpEvent = { method: string; params: any; sessionId?: string };

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
  #nextId = 1;

  private constructor(socket: WebSocket, onEvent: (event: CdpEvent) => void) {
    this.#socket = socket;
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
  ): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const connection = new CdpConnection(socket, onEvent);
      socket.addEventListener("open", () => resolve(connection));
      socket.addEventListener("error", () =>
        reject(new Error("Could not connect to the browser's debugging port")),
      );
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<any> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Browser connection closed"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close(): void {
    this.#socket.close();
  }
}
