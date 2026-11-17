// A stand-in for Chromium's browser-level debugging endpoint. It keeps windows
// of page targets and records what each session was sent. Like Chromium, every
// websocket has its own flat sessions: an event for a session goes only to the
// socket that attached it, and target announcements go to every socket that
// asked to discover targets.
import { WebSocketServer } from "ws";

const SESSION_NOT_FOUND = "Session with given id not found.";

/** `hang` names methods the browser takes in and never answers. */
export async function startFakeBrowser({ hang = [] } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));

  /** targetId -> { info, windowId } */
  const targets = new Map();
  /**
   * sessionId -> { targetId, socket, pageEnabled, interceptFiles,
   *   cast: null | { params, frame, waiting } }
   */
  const sessions = new Map();
  /** windowId -> bounds */
  const windows = new Map();
  /** Every command received, in order: { method, params, sessionId, socket } */
  const calls = [];
  /** Replies for session commands, by method. */
  const replies = new Map();
  /** Methods that fail, by method: the error message. */
  const failures = new Map();
  /** targetId -> (x, y) => nodeName at that page point */
  const hits = new Map();
  /** Answers isolated-world evaluations the fake does not model itself. */
  const evaluations = [];
  /** targetId -> ids of in-process child frames, under the main frame */
  const childFrames = new Map();
  /** isolated world's executionContextId -> the frame it was made in */
  const worlds = new Map();
  /** socket -> { index, discovering } */
  const sockets = new Map();
  let counter = 0;
  let lastWindow = 0;
  let activeWindow = 0;

  const send = (socket, message) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  };
  const browserEvent = (method, params) => {
    for (const [socket, state] of sockets) {
      if (state.discovering) send(socket, { method, params });
    }
  };
  const sessionEvent = (sessionId, method, params) => {
    const session = sessions.get(sessionId);
    if (session) send(session.socket, { method, params, sessionId });
  };

  function addWindow() {
    const windowId = ++lastWindow;
    windows.set(windowId, { left: 22, top: 47, width: 1200, height: 800, windowState: "normal" });
    return windowId;
  }

  function addTarget({ url = "about:blank", windowId, openerId, type, subtype }) {
    const targetId = `T${++counter}`;
    const info = {
      targetId,
      type: type ?? "page",
      title: url,
      url,
      attached: false,
      browserContextId: "CTX",
      ...(openerId ? { openerId } : {}),
      ...(subtype ? { subtype } : {}),
    };
    if (!windows.has(windowId)) windows.set(windowId, { left: 22, top: 47, width: 1200, height: 800, windowState: "normal" });
    targets.set(targetId, { info, windowId });
    browserEvent("Target.targetCreated", { targetInfo: info });
    return targetId;
  }

  function removeTarget(targetId) {
    if (!targets.delete(targetId)) return false;
    for (const [sessionId, session] of sessions) {
      if (session.targetId === targetId) sessions.delete(sessionId);
    }
    browserEvent("Target.targetDestroyed", { targetId });
    return true;
  }

  function attach(socket, targetId) {
    const sessionId = `S${++counter}`;
    sessions.set(sessionId, { targetId, socket, pageEnabled: false, interceptFiles: false, cast: null });
    return sessionId;
  }

  function browserCommand(socket, method, params) {
    switch (method) {
      case "Target.setDiscoverTargets":
        sockets.get(socket).discovering = Boolean(params.discover);
        if (params.discover) {
          for (const { info } of targets.values()) {
            send(socket, { method: "Target.targetCreated", params: { targetInfo: info } });
          }
        }
        return {};
      case "Target.createTarget": {
        const windowId = params.newWindow ? addWindow() : activeWindow;
        activeWindow = windowId;
        return { targetId: addTarget({ url: params.url, windowId }) };
      }
      case "Target.getTargets":
        return { targetInfos: [...targets.values()].map(({ info }) => info) };
      case "Target.getTargetInfo": {
        const target = targets.get(params.targetId);
        if (!target) throw new Error("No target with given id found");
        return { targetInfo: target.info };
      }
      case "Target.attachToTarget": {
        if (!targets.has(params.targetId)) {
          throw new Error("No target with given id found");
        }
        return { sessionId: attach(socket, params.targetId) };
      }
      case "Target.detachFromTarget":
        if (!sessions.delete(params.sessionId)) throw new Error(SESSION_NOT_FOUND);
        return {};
      case "Target.activateTarget": {
        const target = targets.get(params.targetId);
        if (!target) throw new Error("No target with given id found");
        activeWindow = target.windowId;
        return {};
      }
      case "Target.closeTarget":
        if (!removeTarget(params.targetId)) {
          throw new Error("No target with given id found");
        }
        return { success: true };
      case "Browser.getWindowForTarget": {
        const target = targets.get(params.targetId);
        if (!target) throw new Error("No target with given id found");
        return { windowId: target.windowId, bounds: { ...windows.get(target.windowId) } };
      }
      case "Browser.setWindowBounds": {
        const bounds = windows.get(params.windowId);
        if (!bounds) throw new Error("Browser window not found");
        Object.assign(bounds, params.bounds);
        return {};
      }
      case "Browser.getWindowBounds": {
        const bounds = windows.get(params.windowId);
        if (!bounds) throw new Error("Browser window not found");
        return { bounds: { ...bounds } };
      }
      case "Browser.getVersion":
        return { product: "Chrome/155.0.8059.31", protocolVersion: "1.3" };
      case "Browser.cancelDownload":
        if (params.guid !== "G-RUNNING") {
          throw new Error("No download item found for the given GUID");
        }
        return {};
      case "Browser.close":
        setImmediate(() => {
          for (const client of sockets.keys()) client.close();
        });
        return {};
      default:
        throw new Error(`'${method}' wasn't found`);
    }
  }

  /** What an isolated world the shell made reads, or opens. */
  function isolatedEvaluate(session, params) {
    const target = targets.get(session.targetId);
    if (params.expression.includes("window.open(")) {
      addTarget({ windowId: target.windowId, openerId: session.targetId });
      return { result: { type: "undefined" } };
    }
    for (const answer of evaluations) {
      const value = answer(params.expression, session.targetId, worlds.get(params.contextId));
      if (value !== undefined) return { result: { type: typeof value, value } };
    }
    if (params.expression.includes("screen.availLeft")) {
      return { result: { type: "object", value: { left: 0, top: 25, width: 1920, height: 1055 } } };
    }
    return { result: { type: "undefined" } };
  }

  function sessionCommand(sessionId, method, params) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(SESSION_NOT_FOUND);
    if (failures.has(method)) throw new Error(failures.get(method));
    const { targetId } = session;
    switch (method) {
      case "Page.navigate": {
        const { info } = targets.get(targetId);
        info.url = params.url;
        info.title = params.url;
        browserEvent("Target.targetInfoChanged", { targetInfo: info });
        setImmediate(() => {
          sessionEvent(sessionId, "Page.frameNavigated", { frame: { id: `F-${targetId}`, url: params.url } });
          sessionEvent(sessionId, "Page.loadEventFired", { timestamp: 1 });
        });
        return replies.get(method) ?? {};
      }
      case "Page.enable":
        session.pageEnabled = true;
        return {};
      case "Page.disable":
        session.pageEnabled = false;
        return {};
      case "Page.setInterceptFileChooserDialog":
        session.interceptFiles = Boolean(params.enabled);
        return {};
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: { id: `F-${targetId}`, url: targets.get(targetId).info.url },
            childFrames: (childFrames.get(targetId) ?? []).map((id) => ({ frame: { id, parentId: `F-${targetId}` } })),
          },
        };
      case "Page.createIsolatedWorld": {
        const executionContextId = ++counter;
        worlds.set(executionContextId, params.frameId);
        return { executionContextId };
      }
      case "Page.startScreencast":
        session.cast = { params, frame: 0, waiting: false };
        return {};
      case "Page.stopScreencast":
        session.cast = null;
        return {};
      case "Page.screencastFrameAck":
        if (session.cast && params.sessionId === session.cast.frame) session.cast.waiting = false;
        return {};
      case "DOM.getNodeForLocation": {
        const name = hits.get(targetId)?.(params.x, params.y) ?? "DIV";
        return { backendNodeId: hitNodes.push(name), frameId: `F-${targetId}` };
      }
      case "DOM.describeNode":
        return { node: { nodeName: hitNodes[params.backendNodeId - 1] ?? "DIV", backendNodeId: params.backendNodeId } };
      case "Runtime.evaluate":
        if (params.contextId !== undefined) return isolatedEvaluate(session, params);
        return replies.get(method) ?? {};
      default:
        return replies.get(method) ?? {};
    }
  }
  /** backendNodeId - 1 -> nodeName, for nodes the hit test handed out */
  const hitNodes = [];

  server.on("connection", (socket) => {
    sockets.set(socket, { index: sockets.size, discovering: false });
    socket.on("close", () => {
      sockets.delete(socket);
      for (const [sessionId, session] of sessions) {
        if (session.socket === socket) sessions.delete(sessionId);
      }
    });
    socket.on("message", (data) => {
      const { id, method, params = {}, sessionId } = JSON.parse(String(data));
      calls.push({ method, params, sessionId, socket: sockets.get(socket)?.index });
      if (hang.includes(method)) return;
      try {
        const result = sessionId
          ? sessionCommand(sessionId, method, params)
          : browserCommand(socket, method, params);
        send(socket, { id, result, sessionId });
      } catch (error) {
        send(socket, {
          id,
          error: { code: -32000, message: error.message },
          sessionId,
        });
      }
    });
  });

  return {
    endpoint: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
    port: server.address().port,
    calls,
    replies,
    failures,
    /** Answer isolated-world evaluations: `(expression, targetId, frameId) => value | undefined`. */
    evaluations,
    /** In-process child frames of a target's page, by frame id. */
    childFrames,
    /** Commands a session received, optionally only one method. */
    sent(sessionId, method) {
      return calls
        .filter(
          (call) =>
            call.sessionId === sessionId && (!method || call.method === method),
        )
        .map(({ socket, ...call }) => call);
    },
    /** The session ids attached to a target, in the order they were opened. */
    sessionsOf(targetId) {
      return [...sessions]
        .filter(([, session]) => session.targetId === targetId)
        .map(([sessionId]) => sessionId);
    },
    windowOf: (targetId) => targets.get(targetId)?.windowId,
    boundsOf: (windowId) => ({ ...windows.get(windowId) }),
    targetIds: () => [...targets.keys()],
    /** A page the browser opened on its own: a popup, or the user's doing. */
    openPage(options = {}) {
      const windowId =
        options.windowId ?? (options.newWindow ? addWindow() : activeWindow);
      return addTarget({ ...options, windowId });
    },
    closePage: removeTarget,
    /** A page sets its title after loading; Chromium announces nothing. */
    retitle(targetId, title) {
      targets.get(targetId).info.title = title;
    },
    /** A prerendered page takes the place of the page on screen. */
    activatePrerender(targetId) {
      const { info } = targets.get(targetId);
      delete info.subtype;
      browserEvent("Target.targetInfoChanged", { targetInfo: info });
    },
    /** An event on a session, as a page or one of its frames would send it. */
    sessionEvent,
    /**
     * The target paints: every session casting it that acked its last frame
     * gets one. Returns how many sessions got a frame.
     */
    paint(targetId, metadata = {}) {
      let painted = 0;
      for (const [sessionId, session] of sessions) {
        if (session.targetId !== targetId || !session.cast || session.cast.waiting) continue;
        session.cast.frame += 1;
        session.cast.waiting = true;
        painted += 1;
        sessionEvent(sessionId, "Page.screencastFrame", {
          data: Buffer.from(`frame ${session.cast.frame} of ${targetId}`).toString("base64"),
          sessionId: session.cast.frame,
          metadata: {
            offsetTop: 0,
            pageScaleFactor: 1,
            deviceWidth: 1280,
            deviceHeight: 800,
            scrollOffsetX: 0,
            scrollOffsetY: 0,
            ...metadata,
          },
        });
      }
      return painted;
    },
    /** The screencast parameters a session started with, or null. */
    castOf(sessionId) {
      return sessions.get(sessionId)?.cast?.params ?? null;
    },
    /** What lies under a page point of a target: `(x, y) => nodeName`. */
    hits,
    /** The page opens a JS dialog: every session with Page enabled hears it. */
    dialog(targetId, params) {
      for (const [sessionId, session] of sessions) {
        if (session.targetId === targetId && session.pageEnabled) {
          sessionEvent(sessionId, "Page.javascriptDialogOpening", {
            url: targets.get(targetId).info.url,
            hasBrowserHandler: false,
            defaultPrompt: "",
            ...params,
          });
        }
      }
    },
    /** The page opens a file chooser: sessions intercepting it hear it. */
    fileChooser(targetId, params = {}) {
      for (const [sessionId, session] of sessions) {
        if (session.targetId === targetId && session.interceptFiles) {
          sessionEvent(sessionId, "Page.fileChooserOpened", {
            frameId: `F-${targetId}`,
            mode: "selectSingle",
            backendNodeId: 77,
            ...params,
          });
        }
      }
    },
    /** Attach an out-of-process frame below a session; returns its session id. */
    attachFrame(parentSessionId, frameId, url = "https://frame.example/") {
      const parent = sessions.get(parentSessionId);
      const sessionId = `S${++counter}`;
      sessions.set(sessionId, { ...parent, pageEnabled: false, interceptFiles: false, cast: null });
      sessionEvent(parentSessionId, "Target.attachedToTarget", {
        sessionId,
        waitingForDebugger: true,
        targetInfo: {
          targetId: frameId,
          type: "iframe",
          title: url,
          url,
          attached: true,
          browserContextId: "CTX",
        },
      });
      return sessionId;
    },
    detachFrame(parentSessionId, sessionId) {
      sessions.delete(sessionId);
      sessionEvent(parentSessionId, "Target.detachedFromTarget", { sessionId });
    },
    /** How many sockets are connected. */
    connections: () => sockets.size,
    /** The browser process died. */
    crash() {
      for (const socket of sockets.keys()) socket.terminate();
    },
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
