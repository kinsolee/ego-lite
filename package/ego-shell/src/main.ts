import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";

import { AgentApi } from "./agent-api.js";
import { ApostateBackend } from "./apostate-backend.js";
import { startAgentServer, type AgentServer } from "./agent-server.js";
import { ProfileRuntime } from "./profile-runtime.js";
import {
  ProfileInputError,
  ProfileStore,
  redactProfile,
} from "./profile-store.js";
import { KernelInstaller } from "./kernel-install.js";
import { ElectronBackend, type ChromeCommand } from "./spaces.js";
import { TaskSpaces } from "./task-space.js";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const UI_BASE = pathToFileURL(path.join(APP_ROOT, "ui")).href;
const PRELOAD = path.join(APP_ROOT, "dist", "preload.cjs");

if (process.env.EGO_SHELL_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.EGO_SHELL_USER_DATA));
}

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

async function main(): Promise<void> {
  // Two shells on one userData would fight over profiles and the endpoint file.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();

  const userData = app.getPath("userData");
  const profiles = await ProfileStore.open(
    path.join(userData, "profiles.json"),
  );
  const runtime = new ProfileRuntime();
  let manager: BrowserWindow | undefined;
  const notifyManager = () => {
    if (manager && !manager.isDestroyed()) {
      manager.webContents.send("profiles:changed");
    }
  };
  const spaces = new TaskSpaces(notifyManager);
  const kernel = new KernelInstaller({
    dataDir: userData,
    onChange: () => {
      if (manager && !manager.isDestroyed()) {
        manager.webContents.send("kernel:changed");
      }
    },
  });
  const electron = new ElectronBackend(runtime, spaces, APP_ROOT);
  spaces.register("electron", electron);
  spaces.register(
    "apostate",
    new ApostateBackend({ dataDir: userData, host: spaces }),
  );

  const openManager = () => {
    if (manager && !manager.isDestroyed()) {
      manager.focus();
      return;
    }
    manager = new BrowserWindow({
      width: 980,
      height: 720,
      title: "ego shell",
      webPreferences: {
        preload: PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void manager.loadFile(path.join(APP_ROOT, "ui", "manager.html"));
  };

  /** Run a UI request, refusing callers that are not the shell's own pages. */
  const serve = (
    channel: string,
    handler: (payload: any, event: IpcMainInvokeEvent) => unknown,
  ) => {
    ipcMain.handle(channel, async (event, payload): Promise<Reply> => {
      const frame = event.senderFrame;
      if (!frame || frame.parent || !frame.url.startsWith(UI_BASE)) {
        return { ok: false, error: "Request refused" };
      }
      try {
        return { ok: true, value: await handler(payload, event) };
      } catch (error) {
        if (!(error instanceof ProfileInputError)) console.error(error);
        return { ok: false, error: (error as Error).message };
      }
    });
  };

  serve("profiles:list", () =>
    profiles.list().map((profile) => ({
      ...redactProfile(profile),
      running: spaces.running(profile),
      openSpaces: spaces.ofProfile(profile.id).map((space) => ({
        id: space.id,
        name: space.name,
        ownership: space.ownership,
      })),
    })),
  );
  serve("profiles:save", async ({ id, draft }) => {
    const profile = id
      ? await profiles.update(id, draft)
      : await profiles.create(draft);
    await spaces.update(profile);
    notifyManager();
    return redactProfile(profile);
  });
  serve("profiles:remove", async ({ id }) => {
    if (spaces.ofProfile(id).length > 0) {
      throw new ProfileInputError("Close this profile's windows first");
    }
    await profiles.remove(id);
    await spaces.erase(id);
    notifyManager();
  });
  serve("profiles:stop", async ({ id }) => {
    await spaces.release(id);
  });
  serve("profiles:open", async ({ id }) => {
    const profile = profiles.get(id);
    if (!profile) throw new ProfileInputError(`Profile not found: ${id}`);
    const space = await spaces.open(profile.name, "user", profile);
    return { id: space.id };
  });
  serve("kernel:status", () => kernel.status());
  // The only place the shell reaches the network for itself.
  serve("kernel:install", () => kernel.install());
  serve("space:command", async (command: ChromeCommand, event) => {
    await electron.forChrome(event.sender)?.command(command);
  });

  const server: AgentServer = await startAgentServer({
    endpointFile: path.join(userData, "agent-endpoint.json"),
    handlers: new AgentApi({
      profiles,
      spaces,
      version: app.getVersion(),
    }),
  });
  console.log(`ego-shell ready, agent endpoint on 127.0.0.1:${server.port}`);

  app.on("second-instance", openManager);
  app.on("activate", openManager);
  app.on("window-all-closed", () => app.quit());
  let stopping = false;
  app.on("before-quit", (event) => {
    if (stopping) return;
    stopping = true;
    event.preventDefault();
    void Promise.allSettled([server.close(), spaces.stop()]).then(() =>
      app.quit(),
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => app.quit());
  }

  openManager();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
