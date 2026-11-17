import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { ApostateBrowser } from "../dist/apostate-browser.js";
import { startFakeBrowser } from "../test-support/fake-cdp-browser.mjs";

const PROFILE = {
  id: "br",
  name: "Brazil",
  kernel: "apostate",
  proxy: { scheme: "none" },
  fingerprint: { seed: "seed", locale: "pt-BR", timezone: "America/Recife" },
};

function fakeHost() {
  const spaces = new Map();
  let nextId = 1;
  return {
    spaces,
    allocateId: () => nextId++,
    add: (space) => spaces.set(space.id, space),
    remove: (space) => spaces.delete(space.id),
    changed() {},
    stageFor: () => ({ place() {}, remove() {}, front() {}, onSelected() {} }),
  };
}

async function setup(t, { hang, commandTimeoutMs, screen } = {}) {
  const chromium = await startFakeBrowser({ hang });
  const host = fakeHost();
  const browser = await ApostateBrowser.connect(
    chromium.endpoint,
    PROFILE,
    host,
    { commandTimeoutMs, screen },
  );
  t.after(async () => {
    await browser.close();
    await chromium.close();
  });
  return { chromium, host, browser };
}

/** The session the mouse highlight opened for itself. */
function overlaySessionOf(chromium) {
  return chromium.calls.find((call) => call.method === "Overlay.enable").sessionId;
}

/** An agent connection to one space, speaking the dialect the harness expects. */
function connect(space) {
  const received = [];
  const client = space.connect((message) => received.push(JSON.parse(message)));
  let nextId = 1;
  return {
    client,
    received,
    events: (method) =>
      received.filter(
        (message) =>
          message.id === undefined && (!method || message.method === method),
      ),
    async call(method, params, sessionId) {
      const id = nextId++;
      await client.handle(JSON.stringify({ id, method, params, sessionId }));
      return received.find((message) => message.id === id);
    },
  };
}

async function until(condition, what) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a task space is a window of its own with one blank tab", async (t) => {
  const { chromium, host, browser } = await setup(t);

  const first = await browser.createSpace("orders", "agent");
  const second = await browser.createSpace("mail", "user");

  assert.deepEqual([...host.spaces.keys()], [first.id, second.id]);
  assert.equal(first.ownership, "agent");
  assert.equal(second.ownership, "user");
  assert.equal(first.profile, PROFILE);
  const [tab] = first.tabs();
  assert.equal(first.tabs().length, 1);
  assert.equal(tab.targetInfo().url, "about:blank");
  assert.equal(tab.targetInfo().type, "page");
  assert.equal(tab.targetInfo().browserContextId, "CTX");
  assert.notEqual(
    chromium.windowOf(tab.targetId),
    chromium.windowOf(second.tabs()[0].targetId),
  );
});

test("a new tab opens in its own space's window, whichever was used last", async (t) => {
  const { chromium, browser } = await setup(t);
  const first = await browser.createSpace("orders", "agent");
  await browser.createSpace("mail", "agent");

  const tab = await first.createTab("https://example.com/");

  assert.equal(
    chromium.windowOf(tab.targetId),
    chromium.windowOf(first.tabs()[0].targetId),
  );
  assert.deepEqual(
    first.tabs().map((each) => each.targetInfo().url),
    ["about:blank", "https://example.com/"],
  );
  assert.equal(first.activeTab(), tab);
});

test("an agent drives a tab through a session only it knows", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const [tab] = space.tabs();
  const [pageSession] = chromium.sessionsOf(tab.targetId);
  const agent = connect(space);

  await agent.call("Target.setDiscoverTargets", { discover: true });
  assert.deepEqual(
    agent
      .events("Target.targetCreated")
      .map((event) => event.params.targetInfo.targetId),
    [tab.targetId],
  );

  const attached = await agent.call("Target.attachToTarget", {
    targetId: tab.targetId,
    flatten: true,
  });
  const { sessionId } = attached.result;
  assert.match(sessionId, /^[0-9A-F]{32}$/);

  const navigated = await agent.call(
    "Page.navigate",
    { url: "https://example.com/" },
    sessionId,
  );
  assert.deepEqual(navigated.result, {});
  assert.deepEqual(chromium.sent(pageSession, "Page.navigate"), [
    {
      method: "Page.navigate",
      params: { url: "https://example.com/" },
      sessionId: pageSession,
    },
  ]);
  await until(
    () => agent.events("Target.targetInfoChanged").length > 0,
    "the new address",
  );
  assert.equal(tab.targetInfo().url, "https://example.com/");

  chromium.sessionEvent(pageSession, "Page.loadEventFired", { timestamp: 1 });
  await until(
    () => agent.events("Page.loadEventFired").length > 0,
    "the page event",
  );
  assert.equal(agent.events("Page.loadEventFired")[0].sessionId, sessionId);
});

test("a failed command reports Chromium's own message", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const agent = connect(space);
  const { result } = await agent.call("Target.attachToTarget", {
    targetId: space.tabs()[0].targetId,
  });
  chromium.failures.set(
    "DOM.describeNode",
    "Could not find node with given id",
  );

  const reply = await agent.call("DOM.describeNode", {}, result.sessionId);

  assert.equal(reply.error.message, "Could not find node with given id");
});

test("the session agents drive has no domain enabled by the shell", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const [pageSession] = chromium.sessionsOf(space.tabs()[0].targetId);

  assert.deepEqual(
    chromium.sent(pageSession).map((call) => call.method),
    ["Target.setAutoAttach"],
  );
});

test("nothing in a page is left waiting for the shell to resume it", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const [pageSession] = chromium.sessionsOf(space.tabs()[0].targetId);
  const frameSession = chromium.attachFrame(pageSession, "FRAME");
  await until(
    () => chromium.sent(frameSession, "Target.setAutoAttach").length > 0,
    "the frame to be watched",
  );

  // Chromium pauses a page's workers along with its frames and never announces
  // them under a frame filter, so a paused start would hang them for good.
  for (const sessionId of [pageSession, frameSession]) {
    const [watch] = chromium.sent(sessionId, "Target.setAutoAttach");
    assert.equal(watch.params.waitForDebuggerOnStart, false);
  }
});

test("an out-of-process frame is reachable by its session", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const [tab] = space.tabs();
  const [pageSession] = chromium.sessionsOf(tab.targetId);
  const agent = connect(space);
  const { result } = await agent.call("Target.attachToTarget", {
    targetId: tab.targetId,
  });

  const frameSession = chromium.attachFrame(pageSession, "FRAME");
  await until(
    () => agent.events("Target.attachedToTarget").length > 0,
    "the frame",
  );

  const [event] = agent.events("Target.attachedToTarget");
  assert.equal(event.sessionId, result.sessionId);
  assert.equal(event.params.sessionId, frameSession);
  assert.equal(event.params.waitingForDebugger, false);
  assert.deepEqual([...tab.childFrames()], [["FRAME", frameSession]]);

  await agent.call("DOM.getDocument", {}, frameSession);
  assert.equal(chromium.sent(frameSession, "DOM.getDocument").length, 1);

  const nested = chromium.attachFrame(frameSession, "NESTED");
  await until(() => tab.childFrames().size === 2, "the nested frame");
  assert.equal(
    tab.childTargets().find((child) => child.sessionId === nested)
      .parentSessionId,
    frameSession,
  );

  chromium.detachFrame(pageSession, frameSession);
  await until(() => tab.childFrames().size === 0, "the frames to go");
  const gone = await agent.call("DOM.getDocument", {}, frameSession);
  assert.equal(gone.error.message, "Session with given id not found.");
});

test("a closed tab ends its sessions, and a new attach recovers", async (t) => {
  const { browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const [first] = space.tabs();
  const second = await space.createTab("https://example.com/");
  const agent = connect(space);
  await agent.call("Target.setDiscoverTargets", { discover: true });
  const { result } = await agent.call("Target.attachToTarget", {
    targetId: second.targetId,
  });

  const closed = await agent.call("Target.closeTarget", {
    targetId: second.targetId,
  });

  assert.deepEqual(closed.result, { success: true });
  assert.deepEqual(agent.events("Target.detachedFromTarget")[0].params, {
    sessionId: result.sessionId,
    targetId: second.targetId,
  });
  assert.equal(agent.events("Target.targetDestroyed").length, 1);
  assert.deepEqual(space.tabs(), [first]);
  assert.equal(space.activeTab(), first);
  const stale = await agent.call("Page.reload", {}, result.sessionId);
  assert.equal(stale.error.message, "Session with given id not found.");
  const again = await agent.call("Target.attachToTarget", {
    targetId: first.targetId,
  });
  assert.match(again.result.sessionId, /^[0-9A-F]{32}$/);
});

test("a title set after the page loaded is reported when tabs are read", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const [tab] = space.tabs();
  const agent = connect(space);
  await agent.call("Target.setDiscoverTargets", { discover: true });

  chromium.retitle(tab.targetId, "Pedido de teste");
  assert.notEqual(tab.targetInfo().title, "Pedido de teste");
  const announcedBefore = agent.events("Target.targetInfoChanged").length;

  const listed = await agent.call("Target.getTargets");
  assert.deepEqual(
    listed.result.targetInfos.map((info) => info.title),
    ["Pedido de teste"],
  );
  assert.deepEqual(
    agent
      .events("Target.targetInfoChanged")
      .slice(announcedBefore)
      .map((event) => event.params.targetInfo.title),
    ["Pedido de teste"],
  );

  chromium.retitle(tab.targetId, "Pedido enviado");
  await space.refreshTabs();
  assert.equal(tab.targetInfo().title, "Pedido enviado");
});

test("the Browser commands the harness sends reach Apostate's browser session", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const agent = connect(space);

  const version = await agent.call("Browser.getVersion");
  assert.equal(version.result.product, "Chrome/155.0.8059.31");
  const cancelled = await agent.call("Browser.cancelDownload", {
    guid: "G-RUNNING",
    browserContextId: "CTX",
  });
  assert.deepEqual(cancelled.result, {});
  const unknown = await agent.call("Browser.cancelDownload", { guid: "G-0" });
  assert.equal(
    unknown.error.message,
    "No download item found for the given GUID",
  );
  assert.deepEqual(
    chromium.calls
      .filter((call) => call.method.startsWith("Browser.cancel"))
      .map((call) => [call.sessionId, call.params]),
    [
      [undefined, { guid: "G-RUNNING", browserContextId: "CTX" }],
      [undefined, { guid: "G-0" }],
    ],
  );
});

test("a popup joins the space of the page that opened it", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const [opener] = space.tabs();
  const agent = connect(space);
  await agent.call("Target.setDiscoverTargets", { discover: true });

  const inTabStrip = chromium.openPage({
    url: "https://popup.example/",
    windowId: chromium.windowOf(opener.targetId),
    openerId: opener.targetId,
  });
  const inOwnWindow = chromium.openPage({
    url: "https://login.example/",
    newWindow: true,
    openerId: opener.targetId,
  });
  await until(() => space.tabs().length === 3, "the popups");

  assert.deepEqual(
    space.tabs().map((tab) => tab.targetId),
    [opener.targetId, inTabStrip, inOwnWindow],
  );
  assert.equal(space.tabs()[1].targetInfo().openerId, opener.targetId);
  assert.deepEqual(
    agent
      .events("Target.targetCreated")
      .map((event) => event.params.targetInfo.targetId),
    [opener.targetId, inTabStrip, inOwnWindow],
  );
});

test("a window the user opens is a task space the user owns", async (t) => {
  const { chromium, host, browser } = await setup(t);
  const agentSpace = await browser.createSpace("orders", "agent");

  const page = chromium.openPage({ url: "chrome://newtab/", newWindow: true });
  await until(() => host.spaces.size === 2, "the user's window");

  const userSpace = [...host.spaces.values()].find(
    (space) => space !== agentSpace,
  );
  assert.equal(userSpace.ownership, "user");
  assert.equal(userSpace.createdBy, "user");
  assert.equal(userSpace.name, "Brazil");
  assert.deepEqual(
    userSpace.tabs().map((tab) => tab.targetId),
    [page],
  );
  assert.equal(agentSpace.tabs().length, 1);
});

test("windows chrome and prerendered pages are not tabs", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const windowId = chromium.windowOf(space.tabs()[0].targetId);

  chromium.openPage({ type: "browser_ui", windowId });
  const prerender = chromium.openPage({
    url: "https://next.example/",
    subtype: "prerender",
    windowId,
  });
  const marker = chromium.openPage({
    url: "https://marker.example/",
    windowId,
  });
  await until(() => space.tabs().length === 2, "the ordinary tab");
  assert.deepEqual(
    space.tabs().map((tab) => tab.targetId),
    [space.tabs()[0].targetId, marker],
  );

  chromium.activatePrerender(prerender);
  await until(() => space.tabs().length === 3, "the activated page");
  assert.equal(space.tabs()[2].targetId, prerender);
});

test("a space ends when its last tab is closed", async (t) => {
  const { chromium, host, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const other = await browser.createSpace("mail", "agent");

  chromium.closePage(space.tabs()[0].targetId);
  await until(() => host.spaces.size === 1, "the space to end");

  assert.deepEqual([...host.spaces.values()], [other]);
  assert.deepEqual(browser.spaces(), [other]);
});

test("closing a space closes its window's tabs", async (t) => {
  const { chromium, host, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  await space.createTab("https://example.com/");
  const other = await browser.createSpace("mail", "agent");

  await space.close();

  assert.deepEqual([...host.spaces.values()], [other]);
  assert.deepEqual(chromium.targetIds(), [other.tabs()[0].targetId]);
});

test("a browser that dies takes its spaces with it", async (t) => {
  const { chromium, host, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const agent = connect(space);
  await agent.call("Target.setDiscoverTargets", { discover: true });
  const { result } = await agent.call("Target.attachToTarget", {
    targetId: space.tabs()[0].targetId,
  });

  chromium.crash();
  await browser.closed;

  assert.equal(host.spaces.size, 0);
  assert.equal(
    agent.events("Target.detachedFromTarget")[0].params.sessionId,
    result.sessionId,
  );
  await assert.rejects(space.createTab("https://example.com/"), {
    message: "The task space has no window",
  });
});

test("the mouse highlight lands on the point asked for on a Retina screen", async (t) => {
  const { chromium, browser } = await setup(t);
  // Chromium draws a highlight twice as large and twice as far out there.
  chromium.replies.set("Page.getLayoutMetrics", {
    visualViewport: { clientWidth: 2400 },
    cssVisualViewport: { clientWidth: 1200 },
  });
  const space = await browser.createSpace("orders", "agent");
  const [tab] = space.tabs();

  await space.highlightMouse(200, 100);

  const overlaySession = overlaySessionOf(chromium);
  const [{ params }] = chromium.sent(overlaySession, "Overlay.highlightRect");
  assert.equal((params.x + params.width / 2) * 2, 200);
  assert.equal((params.y + params.height / 2) * 2, 100);
});

test("the mouse highlight is drawn by the browser on a session of its own", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const [tab] = space.tabs();
  const [pageSession] = chromium.sessionsOf(tab.targetId);

  await space.highlightMouse(200, 100);

  const overlaySession = overlaySessionOf(chromium);
  assert.deepEqual(
    chromium.sent(overlaySession).map((call) => call.method),
    [
      "DOM.enable",
      "Overlay.enable",
      "Page.getLayoutMetrics",
      "Overlay.highlightRect",
    ],
  );
  const [{ params }] = chromium.sent(overlaySession, "Overlay.highlightRect");
  assert.equal(params.x + params.width / 2, 200);
  assert.equal(params.y + params.height / 2, 100);
  assert.deepEqual(
    chromium.sent(pageSession).map((call) => call.method),
    ["Target.setAutoAttach"],
  );

  chromium.sessionEvent(overlaySession, "DOM.documentUpdated", {});
  const agent = connect(space);
  const { result } = await agent.call("Target.attachToTarget", {
    targetId: tab.targetId,
  });
  await agent.call("Page.captureScreenshot", {}, result.sessionId);

  const order = chromium.calls
    .map((call) => call.method)
    .filter((method) =>
      ["Overlay.hideHighlight", "Page.captureScreenshot"].includes(method),
    );
  assert.deepEqual(order, ["Overlay.hideHighlight", "Page.captureScreenshot"]);
  assert.deepEqual(agent.events("DOM.documentUpdated"), []);

  await space.highlightMouse(10, 10);
  await until(
    () => chromium.sent(overlaySession, "Overlay.hideHighlight").length === 2,
    "the highlight to fade",
  );
  assert.equal(
    chromium.calls.filter((call) => call.method === "Overlay.enable").length,
    1,
    "the highlight keeps its one session",
  );
});

test("the shell alone decides the active tab, and tells Chromium so the tab is its window's visible one", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const [first] = space.tabs();
  const second = await space.createTab("https://example.com/");
  assert.equal(space.activeTab(), second);

  await space.activateTab(first.targetId);
  assert.equal(space.activeTab(), first);
  await until(
    () => chromium.calls.filter((call) => call.method === "Target.activateTarget").at(-1)?.params.targetId === first.targetId,
    "Chromium to hear of it",
  );

  await space.closeTab(first.targetId);
  assert.equal(space.activeTab(), second);
});

test("each space's headless window sits at its own spot inside the persona's screen", async (t) => {
  const { chromium, browser } = await setup(t);
  const spaces = [];
  for (const name of ["a", "b", "c"]) spaces.push(await browser.createSpace(name, "agent"));
  const bounds = spaces.map((space) => chromium.boundsOf(chromium.windowOf(space.tabs()[0].targetId)));
  for (const each of bounds) {
    assert.ok(each.left >= 0 && each.top >= 25, JSON.stringify(each));
    assert.ok(each.left + each.width <= 1920 && each.top + each.height <= 1080, JSON.stringify(each));
    assert.deepEqual([each.width, each.height], [1440, 900]);
  }
  assert.equal(new Set(bounds.map((each) => `${each.left},${each.top}`)).size, 3);

  await spaces[0].close();
  const reused = await browser.createSpace("d", "agent");
  assert.equal(reused.slot, 0, "a closed space's spot is taken again");
});

test("an agent never hears the shell's screencast and cannot stop it", async (t) => {
  const { chromium, browser } = await setup(t);
  const space = await browser.createSpace("orders", "agent");
  const [tab] = space.tabs();
  const agent = connect(space);
  const { result } = await agent.call("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
  await agent.call("Page.enable", {}, result.sessionId);

  const frames = [];
  await browser.link.cast(tab.targetId, { maxWidth: 800, maxHeight: 600 }, (frame) => {
    frames.push(frame);
    frame.ack();
  });
  const shellSession = chromium.calls.find((call) => call.method === "Page.startScreencast").sessionId;
  for (let i = 0; i < 3; i++) {
    chromium.paint(tab.targetId);
    await until(() => frames.length === i + 1, `frame ${i + 1}`);
    await delay(5);
  }
  await agent.call("Page.stopScreencast", {}, result.sessionId);
  assert.ok(chromium.castOf(shellSession), "the shell's cast runs on");
  chromium.paint(tab.targetId);
  await until(() => frames.length === 4, "a frame after the agent's stop");

  assert.equal(agent.events("Page.screencastFrame").length, 0);
  const sessionsSeen = new Set(agent.received.map((message) => message.sessionId).filter(Boolean));
  assert.deepEqual([...sessionsSeen], [result.sessionId]);
});

test("a selected space is drawn into the shared screen view, and only while selected", async (t) => {
  const shown = [];
  const fronted = [];
  const screen = {
    show: (space) => shown.push(["show", space.id]),
    hide: (space) => shown.push(["hide", space.id]),
    retarget: (space) => shown.push(["retarget", space.id, space.shownTargetId()]),
    ask: () => new Promise(() => {}),
  };
  const view = { name: "screen" };
  const { browser, host } = await setup(t, { screen: { view, screen } });
  let notify;
  host.stageFor = () => ({
    place() {},
    remove() {},
    front: (each) => fronted.push(each),
    onSelected(listener) {
      notify = listener;
      listener(false);
    },
  });
  const space = await browser.createSpace("orders", "user");
  shown.length = 0;
  notify(true);
  notify(false);
  assert.deepEqual(fronted, [view]);
  assert.deepEqual(shown, [["show", space.id], ["hide", space.id]]);

  const tab = await space.createTab("https://example.com/");
  assert.deepEqual(shown.at(-1), ["retarget", space.id, tab.targetId]);
});

test("handing a space to the user frees its pages and lets the shell answer their dialogs", async (t) => {
  const asked = [];
  const screen = {
    show() {},
    hide() {},
    retarget() {},
    ask: async (space, prompt) => {
      asked.push([space.id, prompt.kind]);
      return { kind: "dialog", accept: true };
    },
  };
  const { chromium, browser } = await setup(t, { screen: { view: {}, screen } });
  const space = await browser.createSpace("orders", "agent");
  const [tab] = space.tabs();
  const [pageSession] = chromium.sessionsOf(tab.targetId);
  space.setAgentState("working");
  const activations = chromium.calls.filter((call) => call.method === "Target.activateTarget").length;

  chromium.dialog(tab.targetId, { type: "alert", message: "Oi" });
  await delay(20);
  assert.deepEqual(asked, [], "an agent's dialog is left to the agent");

  space.setOwnership("user");
  await until(
    () => chromium.sent(pageSession, "Page.setInterceptFileChooserDialog").length > 0,
    "the pages to be released",
  );
  const interceptions = () =>
    chromium.calls
      .filter((call) => call.method === "Page.setInterceptFileChooserDialog" && call.sessionId !== pageSession)
      .map((call) => call.params.enabled);
  await until(() => interceptions().at(-1) === true, "the shell to take the file chooser");
  assert.equal(space.ownership, "user");
  assert.equal(space.agentState, "");
  assert.equal(
    chromium.calls.filter((call) => call.method === "Target.activateTarget").length,
    activations,
    "no native window to bring forward",
  );

  chromium.dialog(tab.targetId, { type: "confirm", message: "Confirmar?" });
  await until(() => asked.length === 1, "the human to be asked");
  assert.deepEqual(asked, [[space.id, "dialog"]]);
  await until(
    () => chromium.calls.some((call) => call.method === "Page.handleJavaScriptDialog" && call.sessionId !== pageSession),
    "the shell's answer",
  );

  space.setOwnership("agent");
  await until(() => interceptions().at(-1) === false, "the shell to let go");
});

test("closing the browser asks Chromium to quit", async (t) => {
  const { chromium, host, browser } = await setup(t);
  await browser.createSpace("orders", "agent");

  await browser.close();

  assert.equal(
    chromium.calls.filter((call) => call.socket === 0).at(-1).method,
    "Browser.close",
  );
  assert.equal(host.spaces.size, 0);
});

test("an agent's command waits past the limit on the shell's own commands", async (t) => {
  const { browser } = await setup(t, {
    hang: ["Page.printToPDF", "Browser.cancelDownload"],
    commandTimeoutMs: 50,
  });
  const space = await browser.createSpace("orders", "agent");
  const agent = connect(space);
  const [tab] = space.tabs();
  const { result } = await agent.call("Target.attachToTarget", {
    targetId: tab.targetId,
    flatten: true,
  });

  const replies = [
    agent.call("Page.printToPDF", {}, result.sessionId),
    agent.call("Browser.cancelDownload", { guid: "G-RUNNING" }),
  ];
  const outcome = await Promise.race([
    Promise.race(replies).then((reply) => reply),
    delay(300).then(() => "still waiting"),
  ]);

  assert.equal(outcome, "still waiting");
});

test("a kernel that accepts the debugging socket but never finishes the handshake times out", async () => {
  const { createServer } = await import("node:net");
  const { CdpConnection, CdpTimeoutError } = await import("../dist/browser-cdp.js");
  const held = [];
  const server = createServer((socket) => held.push(socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await assert.rejects(
      CdpConnection.connect(`ws://127.0.0.1:${port}/devtools/browser/x`, () => {}, 200),
      CdpTimeoutError,
    );
  } finally {
    for (const socket of held) socket.destroy();
    server.close();
  }
});
