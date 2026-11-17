import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BaseWindow,
  clipboard,
  dialog,
  ipcMain,
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";

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
import {
  parseDialogAnswer,
  parseViewSize,
  Screen,
  type ScreenStatus,
} from "./screen.js";
import { ElectronBackend } from "./spaces.js";
import { TaskSpaces } from "./task-space.js";
import {
  parseCommandEnvelope,
  parseLayout,
  Workbench,
  type WindowPort,
} from "./workbench.js";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const UI_BASE = pathToFileURL(path.join(APP_ROOT, "ui")).href;
const PRELOAD = path.join(APP_ROOT, "dist", "preload.cjs");
const SCREEN_PRELOAD = path.join(APP_ROOT, "dist", "screen-preload.cjs");

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
  let stopping = false;

  const win = new BaseWindow({ width: 1440, height: 900, title: "ego shell" });
  const ui = new WebContentsView({
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(ui);
  const fitUi = () => {
    const { width, height } = win.getContentBounds();
    ui.setBounds({ x: 0, y: 0, width, height });
  };
  fitUi();
  win.on("resize", fitUi);
  // Agents keep working in the spaces while the window is away.
  win.on("close", (event) => {
    if (process.platform !== "darwin" || stopping) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => app.quit());

  const sendUi = (channel: string, payload?: unknown) => {
    if (!ui.webContents.isDestroyed()) ui.webContents.send(channel, payload);
  };

  // Every Apostate space is drawn here while selected. It never sleeps: a
  // throttled renderer would hold back the frame acks the screencast waits on.
  const screenView = new WebContentsView({
    webPreferences: {
      preload: SCREEN_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const sendScreen = (channel: string, payload: unknown) => {
    if (!screenView.webContents.isDestroyed()) {
      screenView.webContents.send(channel, payload);
    }
  };
  let screenStatus: ScreenStatus = { spaceId: null, holder: null, prompt: null };
  const screen = new Screen({
    frame: (seq, jpeg, fit) => sendScreen("screen:frame", { seq, jpeg, fit }),
    clear: () => sendScreen("screen:clear", null),
    status: (status) => {
      screenStatus = status;
      sendScreen("screen:status", status);
    },
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    chooseFiles: async (multiple) => {
      const picked = await dialog.showOpenDialog(win, {
        properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      });
      return picked.canceled ? [] : picked.filePaths;
    },
  });
  /** Messages from the screen view only; it reaches nothing else in the shell. */
  const fromScreen = (
    channel: string,
    handler: (payload: unknown) => void,
  ) => {
    ipcMain.on(channel, (event: IpcMainEvent, payload: unknown) => {
      if (event.sender !== screenView.webContents) return;
      try {
        handler(payload);
      } catch {
        // A malformed message from the view is dropped.
      }
    });
  };
  fromScreen("screen:input", (payload) => screen.receive(payload));
  fromScreen("screen:drawn", (seq) => {
    if (Number.isInteger(seq)) screen.drawn(seq as number);
  });
  fromScreen("screen:resize", (payload) => {
    const { view, dpr } = parseViewSize(payload);
    screen.resize(view, dpr);
  });
  fromScreen("screen:answer", (payload) => screen.answer(parseDialogAnswer(payload)));
  fromScreen("screen:take-control", () => {
    if (screenStatus.spaceId === null) return;
    void spaces.get(screenStatus.spaceId)?.command({ type: "takeControl" });
  });
  // Tabs keep reporting while the app quits, after the window is gone.
  const live = (action: () => void) => {
    if (!win.isDestroyed()) action();
  };
  const port: WindowPort<WebContentsView> = {
    add: (view) => live(() => win.contentView.addChildView(view)),
    raise: (view) => live(() => win.contentView.addChildView(view)),
    remove: (view) => live(() => win.contentView.removeChildView(view)),
    setBounds: (view, rect) => view.setBounds(rect),
    focus: (view) => {
      if (!view.webContents.isDestroyed()) view.webContents.focus();
    },
    contentSize: () => win.getContentBounds(),
    reveal: () =>
      live(() => {
        win.show();
        win.focus();
      }),
  };
  const spaces: TaskSpaces = new TaskSpaces(
    () => {
      workbench.changed();
      sendUi("profiles:changed");
    },
    { stageFor: (spaceId) => workbench.stageFor(spaceId) },
  );
  const workbench = new Workbench({
    window: port,
    ui,
    spaces,
    push: (state) => sendUi("workbench:state", state),
    shared: [screenView],
  });
  ui.webContents.on("did-finish-load", () => workbench.changed());

  const kernel = new KernelInstaller({
    dataDir: userData,
    onChange: () => sendUi("kernel:changed"),
  });
  spaces.register("electron", new ElectronBackend(runtime, spaces));
  spaces.register(
    "apostate",
    new ApostateBackend({
      dataDir: userData,
      host: spaces,
      screen: { view: screenView, screen },
    }),
  );

  /** Run a UI request, refusing callers that are not the shell's own pages. */
  const serve = (
    channel: string,
    handler: (payload: any, event: IpcMainInvokeEvent) => unknown,
  ) => {
    ipcMain.handle(channel, async (event, payload): Promise<Reply> => {
      const frame = event.senderFrame;
      if (
        event.sender !== ui.webContents ||
        !frame ||
        frame.parent ||
        !frame.url.startsWith(UI_BASE)
      ) {
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
    sendUi("profiles:changed");
    return redactProfile(profile);
  });
  serve("profiles:remove", async ({ id }) => {
    if (spaces.ofProfile(id).length > 0) {
      throw new ProfileInputError("Close this profile's task spaces first");
    }
    await profiles.remove(id);
    await spaces.erase(id);
    sendUi("profiles:changed");
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
  serve("space:select", ({ spaceId }) => workbench.select(spaceId));
  serve("space:close", ({ spaceId }) => spaces.get(spaceId)?.close());
  // A button of a space that closed meanwhile does nothing.
  serve("space:command", (payload) => {
    const { spaceId, command } = parseCommandEnvelope(payload);
    return spaces.get(spaceId)?.command(command);
  });
  serve("workbench:layout", (payload) => {
    // The page measures in its own CSS pixels, which a zoomed page scales.
    const { rect, covered } = parseLayout(payload);
    const zoom = ui.webContents.getZoomFactor();
    workbench.layout({
      covered,
      rect: {
        x: Math.round(rect.x * zoom),
        y: Math.round(rect.y * zoom),
        width: Math.round(rect.width * zoom),
        height: Math.round(rect.height * zoom),
      },
    });
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

  app.on("second-instance", () => workbench.reveal());
  app.on("activate", () => workbench.reveal());
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

  void ui.webContents.loadFile(path.join(APP_ROOT, "ui", "workbench.html"));
  void screenView.webContents.loadFile(path.join(APP_ROOT, "ui", "screen.html"));
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
