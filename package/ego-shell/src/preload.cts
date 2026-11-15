const { contextBridge, ipcRenderer } = require("electron");

const REQUESTS = new Set([
  "profiles:list",
  "profiles:save",
  "profiles:remove",
  "profiles:open",
  "profiles:stop",
  "kernel:status",
  "kernel:install",
  "space:command",
]);
const EVENTS = new Set(["profiles:changed", "kernel:changed", "space:state"]);

contextBridge.exposeInMainWorld("shell", {
  request(channel: string, payload?: unknown): Promise<unknown> {
    if (!REQUESTS.has(channel)) {
      return Promise.reject(new Error(`Unknown request: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel: string, listener: (payload: unknown) => void): void {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event: ${channel}`);
    ipcRenderer.on(channel, (_event: unknown, payload: unknown) =>
      listener(payload),
    );
  },
});
