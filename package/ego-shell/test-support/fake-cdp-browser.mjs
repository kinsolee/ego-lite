// A stand-in for Chromium's browser-level debugging socket. It keeps windows of
// page targets, hands out flat sessions and records what each session was sent.
import { WebSocketServer } from "ws";

const SESSION_NOT_FOUND = "Session with given id not found.";

/** `hang` names methods the browser takes in and never answers. */
export async function startFakeBrowser({ hang = [] } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));

  /** targetId -> { info, windowId } */
  const targets = new Map();
  /** sessionId -> targetId, for page and child sessions alike */
  const sessions = new Map();
  /** Every command received, in order: { method, params, sessionId } */
  const calls = [];
  /** Replies for session commands, by method. */
  const replies = new Map();
  /** Methods that fail, by method: the error message. */
  const failures = new Map();
  let socket;
  let discovering = false;
  let counter = 0;
  let lastWindow = 0;
  let activeWindow = 0;
  /** windowId -> the targetId its tab strip shows */
  const shown = new Map();
  let minimised = false;

  const emit = (message) => socket?.send(JSON.stringify(message));
  const browserEvent = (method, params) => {
    if (discovering) emit({ method, params });
  };

  function addTarget({
    url = "about:blank",
    windowId,
    openerId,
    type,
    subtype,
  }) {
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
    targets.set(targetId, { info, windowId });
    if (!subtype && (type ?? "page") === "page") shown.set(windowId, targetId);
    browserEvent("Target.targetCreated", { targetInfo: info });
    return targetId;
  }

  function removeTarget(targetId) {
    if (!targets.delete(targetId)) return false;
    for (const [sessionId, owner] of sessions) {
      if (owner === targetId) sessions.delete(sessionId);
    }
    browserEvent("Target.targetDestroyed", { targetId });
    return true;
  }

  function browserCommand(method, params) {
    switch (method) {
      case "Target.setDiscoverTargets":
        discovering = Boolean(params.discover);
        for (const { info } of targets.values()) {
          browserEvent("Target.targetCreated", { targetInfo: info });
        }
        return {};
      case "Target.createTarget": {
        const windowId = params.newWindow ? ++lastWindow : activeWindow;
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
        const sessionId = `S${++counter}`;
        sessions.set(sessionId, params.targetId);
        return { sessionId };
      }
      case "Target.activateTarget": {
        const target = targets.get(params.targetId);
        if (!target) throw new Error("No target with given id found");
        activeWindow = target.windowId;
        shown.set(target.windowId, params.targetId);
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
        return { windowId: target.windowId };
      }
      case "Browser.getVersion":
        return { product: "Chrome/155.0.8059.31", protocolVersion: "1.3" };
      case "Browser.cancelDownload":
        if (params.guid !== "G-RUNNING") {
          throw new Error("No download item found for the given GUID");
        }
        return {};
      case "Browser.close":
        setImmediate(() => socket?.close());
        return {};
      default:
        throw new Error(`'${method}' wasn't found`);
    }
  }

  function sessionCommand(method, params, sessionId) {
    const targetId = sessions.get(sessionId);
    if (!targetId) throw new Error(SESSION_NOT_FOUND);
    if (failures.has(method)) throw new Error(failures.get(method));
    if (method === "Page.navigate") {
      const { info } = targets.get(targetId);
      info.url = params.url;
      info.title = params.url;
      browserEvent("Target.targetInfoChanged", { targetInfo: info });
    }
    if (
      method === "Runtime.evaluate" &&
      params.expression === "document.visibilityState"
    ) {
      const { windowId } = targets.get(targetId);
      const visible = !minimised && shown.get(windowId) === targetId;
      return {
        result: { type: "string", value: visible ? "visible" : "hidden" },
      };
    }
    return replies.get(method) ?? {};
  }

  server.on("connection", (connection) => {
    socket = connection;
    connection.on("message", (data) => {
      const { id, method, params = {}, sessionId } = JSON.parse(String(data));
      calls.push({ method, params, sessionId });
      if (hang.includes(method)) return;
      try {
        const result = sessionId
          ? sessionCommand(method, params, sessionId)
          : browserCommand(method, params);
        emit({ id, result, sessionId });
      } catch (error) {
        emit({
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
    /** Commands a session received, optionally only one method. */
    sent(sessionId, method) {
      return calls.filter(
        (call) =>
          call.sessionId === sessionId && (!method || call.method === method),
      );
    },
    /** The session ids attached to a target, in the order they were opened. */
    sessionsOf(targetId) {
      return [...sessions]
        .filter(([, owner]) => owner === targetId)
        .map(([sessionId]) => sessionId);
    },
    windowOf: (targetId) => targets.get(targetId)?.windowId,
    targetIds: () => [...targets.keys()],
    /** A page the browser opened on its own: a popup, or the user's doing. */
    openPage(options = {}) {
      const windowId =
        options.windowId ?? (options.newWindow ? ++lastWindow : activeWindow);
      return addTarget({ ...options, windowId });
    },
    closePage: removeTarget,
    /** The user picks a tab in the tab strip; Chromium announces nothing. */
    selectTab(targetId) {
      shown.set(targets.get(targetId).windowId, targetId);
    },
    /** Every window is minimised, so no tab is visible. */
    minimise(value = true) {
      minimised = value;
    },
    /** A prerendered page takes the place of the page on screen. */
    /** A page sets its title after loading; Chromium announces nothing. */
    retitle(targetId, title) {
      targets.get(targetId).info.title = title;
    },
    activatePrerender(targetId) {
      const { info } = targets.get(targetId);
      delete info.subtype;
      browserEvent("Target.targetInfoChanged", { targetInfo: info });
    },
    /** An event on a session, as a page or one of its frames would send it. */
    sessionEvent(sessionId, method, params) {
      emit({ method, params, sessionId });
    },
    /** Attach an out-of-process frame below a session; returns its session id. */
    attachFrame(parentSessionId, frameId, url = "https://frame.example/") {
      const sessionId = `S${++counter}`;
      sessions.set(sessionId, sessions.get(parentSessionId));
      emit({
        method: "Target.attachedToTarget",
        sessionId: parentSessionId,
        params: {
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
        },
      });
      return sessionId;
    },
    detachFrame(parentSessionId, sessionId) {
      sessions.delete(sessionId);
      emit({
        method: "Target.detachedFromTarget",
        sessionId: parentSessionId,
        params: { sessionId },
      });
    },
    /** The browser process died. */
    crash() {
      socket?.terminate();
    },
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
