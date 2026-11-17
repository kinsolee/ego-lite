const { contextBridge, ipcRenderer } = require("electron");

/** The screen view's whole reach into the shell: its frames out, the human's input in. */
contextBridge.exposeInMainWorld("shellScreen", {
  input(payload: unknown): void {
    ipcRenderer.send("screen:input", payload);
  },
  drawn(seq: number): void {
    ipcRenderer.send("screen:drawn", seq);
  },
  resize(size: { width: number; height: number; dpr: number }): void {
    ipcRenderer.send("screen:resize", size);
  },
  answer(answer: { accept: boolean; promptText?: string }): void {
    ipcRenderer.send("screen:answer", answer);
  },
  takeControl(): void {
    ipcRenderer.send("screen:take-control");
  },
  onFrame(listener: (frame: unknown) => void): void {
    ipcRenderer.on("screen:frame", (_event: unknown, frame: unknown) => listener(frame));
  },
  onClear(listener: () => void): void {
    ipcRenderer.on("screen:clear", () => listener());
  },
  onStatus(listener: (status: unknown) => void): void {
    ipcRenderer.on("screen:status", (_event: unknown, status: unknown) => listener(status));
  },
});
