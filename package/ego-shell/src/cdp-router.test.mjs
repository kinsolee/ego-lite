import assert from "node:assert/strict";
import test from "node:test";

import { CdpClient } from "../dist/cdp-router.js";

function fakeTab(targetId, url = "https://shop.test/") {
  const tab = {
    targetId,
    sent: [],
    children: [],
    targetInfo: () => ({
      targetId,
      type: "page",
      title: "Shop",
      url,
      attached: true,
    }),
    send: async (method, params, sessionId) => {
      tab.sent.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") return { result: { value: 2 } };
      if (method === "Bogus.fail") throw new Error("'Bogus.fail' wasn't found");
      return {};
    },
    childTargets: () => tab.children,
  };
  return tab;
}

function fakeSpace(...tabs) {
  const space = {
    list: [...tabs],
    closed: [],
    activated: [],
    tabs: () => space.list,
    createTab: async (url) => {
      const tab = fakeTab(`T${space.list.length + 1}`, url);
      space.list.push(tab);
      return tab;
    },
    closeTab: async (targetId) => void space.closed.push(targetId),
    activateTab: async (targetId) => void space.activated.push(targetId),
    browserCommands: [],
    browserCommand: async (method, params) => {
      space.browserCommands.push({ method, params });
      return method === "Browser.getVersion" ? { product: "Chrome/155" } : {};
    },
  };
  return space;
}

function connect(space) {
  const received = [];
  const client = new CdpClient(space, (message) =>
    received.push(JSON.parse(message)),
  );
  let nextId = 1;
  const call = async (method, params = {}, sessionId) => {
    const id = nextId++;
    await client.handle(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
    return received.find((message) => message.id === id);
  };
  const events = () => received.filter((message) => message.method);
  return { client, call, events, received };
}

test("attaching to a tab hands out a session that reaches that tab", async () => {
  const tab = fakeTab("T1");
  const { call } = connect(fakeSpace(tab));

  const attached = await call("Target.attachToTarget", {
    targetId: "T1",
    flatten: true,
  });
  const sessionId = attached.result.sessionId;
  assert.match(sessionId, /^[0-9A-F]{32}$/);

  const reply = await call(
    "Runtime.evaluate",
    { expression: "1+1" },
    sessionId,
  );
  assert.deepEqual(reply.result, { result: { value: 2 } });
  assert.equal(reply.sessionId, sessionId);
  assert.deepEqual(tab.sent, [
    {
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
      sessionId: undefined,
    },
  ]);
});

test("two agents attached to one tab get separate sessions and both see its events", async () => {
  const tab = fakeTab("T1");
  const space = fakeSpace(tab);
  const first = connect(space);
  const second = connect(space);
  const a = (await first.call("Target.attachToTarget", { targetId: "T1" }))
    .result.sessionId;
  const b = (await second.call("Target.attachToTarget", { targetId: "T1" }))
    .result.sessionId;
  assert.notEqual(a, b);

  for (const { client } of [first, second]) {
    client.tabEvent(tab, "Page.loadEventFired", { timestamp: 1 });
  }
  assert.deepEqual(first.events(), [
    { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: a },
  ]);
  assert.deepEqual(second.events(), [
    { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: b },
  ]);
});

test("events of a tab the client never attached to are not delivered", async () => {
  const tab = fakeTab("T1");
  const { client, events } = connect(fakeSpace(tab));

  client.tabEvent(tab, "Network.requestWillBeSent", { requestId: "1" });
  assert.deepEqual(events(), []);
});

test("an unknown session or target fails with the messages the harness recovers from", async () => {
  const { call } = connect(fakeSpace(fakeTab("T1")));

  const lost = await call("Runtime.evaluate", {}, "GONE");
  assert.equal(lost.error.message, "Session with given id not found.");
  assert.equal(lost.sessionId, "GONE");

  const missing = await call("Target.attachToTarget", { targetId: "nope" });
  assert.equal(missing.error.message, "No target with given id found");
});

test("a failing page command is answered as a CDP error, not dropped", async () => {
  const { call } = connect(fakeSpace(fakeTab("T1")));
  const { sessionId } = (
    await call("Target.attachToTarget", { targetId: "T1" })
  ).result;

  const reply = await call("Bogus.fail", {}, sessionId);
  assert.equal(reply.error.message, "'Bogus.fail' wasn't found");
});

test("detaching ends the session", async () => {
  const { call } = connect(fakeSpace(fakeTab("T1")));
  const { sessionId } = (
    await call("Target.attachToTarget", { targetId: "T1" })
  ).result;

  await call("Target.detachFromTarget", { sessionId });
  const reply = await call("Runtime.evaluate", {}, sessionId);
  assert.equal(reply.error.message, "Session with given id not found.");
});

test("target discovery replays open tabs, then reports new, changed and closed ones", async () => {
  const tab = fakeTab("T1");
  const space = fakeSpace(tab);
  const { client, call, events } = connect(space);

  client.tabCreated(tab);
  assert.deepEqual(events(), [], "nothing is reported before discovery is on");

  await call("Target.setDiscoverTargets", { discover: true });
  const popup = fakeTab("T2", "https://shop.test/popup");
  space.list.push(popup);
  client.tabCreated(popup);
  client.tabChanged(popup);
  client.tabDestroyed(popup);

  assert.deepEqual(
    events().map((event) => [
      event.method,
      event.params.targetInfo?.targetId ?? event.params.targetId,
    ]),
    [
      ["Target.targetCreated", "T1"],
      ["Target.targetCreated", "T2"],
      ["Target.targetInfoChanged", "T2"],
      ["Target.targetDestroyed", "T2"],
    ],
  );
});

test("a closed tab detaches its sessions", async () => {
  const tab = fakeTab("T1");
  const { client, call, events } = connect(fakeSpace(tab));
  const { sessionId } = (
    await call("Target.attachToTarget", { targetId: "T1" })
  ).result;

  client.tabDestroyed(tab);
  assert.deepEqual(events(), [
    {
      method: "Target.detachedFromTarget",
      params: { sessionId, targetId: "T1" },
    },
  ]);
  assert.deepEqual(client.attachedTabs(), []);
});

test("tabs are listed, created, activated and closed through the space", async () => {
  const space = fakeSpace(fakeTab("T1"));
  const { call } = connect(space);

  const created = await call("Target.createTarget", {
    url: "https://shop.test/new",
  });
  assert.equal(created.result.targetId, "T2");
  const listed = await call("Target.getTargets");
  assert.deepEqual(
    listed.result.targetInfos.map((info) => [info.targetId, info.url]),
    [
      ["T1", "https://shop.test/"],
      ["T2", "https://shop.test/new"],
    ],
  );
  const info = await call("Target.getTargetInfo", { targetId: "T2" });
  assert.equal(info.result.targetInfo.url, "https://shop.test/new");

  await call("Target.activateTarget", { targetId: "T2" });
  const closed = await call("Target.closeTarget", { targetId: "T1" });
  assert.deepEqual(closed.result, { success: true });
  assert.deepEqual(space.activated, ["T2"]);
  assert.deepEqual(space.closed, ["T1"]);

  const missing = await call("Target.closeTarget", { targetId: "nope" });
  assert.equal(missing.error.message, "No target with given id found");
});

function withIframe(tab) {
  const child = {
    sessionId: "CHILD-1",
    targetInfo: {
      targetId: "FRAME-1",
      type: "iframe",
      title: "",
      url: "https://pay.test/card",
      attached: true,
      parentFrameId: tab.targetId,
    },
  };
  tab.children.push(child);
  return child;
}

test("auto-attach replays the tab's out-of-process iframes after the reply", async () => {
  const tab = fakeTab("T1");
  const child = withIframe(tab);
  const { call, received } = connect(fakeSpace(tab));
  const { sessionId } = (
    await call("Target.attachToTarget", { targetId: "T1" })
  ).result;

  await call(
    "Target.setAutoAttach",
    { autoAttach: true, flatten: true },
    sessionId,
  );

  const [, reply, attached] = received;
  assert.deepEqual(reply.result, {});
  assert.deepEqual(attached, {
    method: "Target.attachedToTarget",
    params: {
      sessionId: "CHILD-1",
      targetInfo: child.targetInfo,
      // The shell already resumed the frame; the agent must not wait on it.
      waitingForDebugger: false,
    },
    sessionId,
  });
  assert.deepEqual(tab.sent, [], "auto-attach never reaches Chromium");
});

test("commands and events of an iframe travel on the iframe's own session", async () => {
  const tab = fakeTab("T1");
  withIframe(tab);
  const { client, call, events } = connect(fakeSpace(tab));
  await call("Target.attachToTarget", { targetId: "T1" });

  const attached = await call("Target.attachToTarget", { targetId: "FRAME-1" });
  assert.equal(attached.result.sessionId, "CHILD-1");

  await call("Runtime.evaluate", { expression: "1" }, "CHILD-1");
  assert.deepEqual(tab.sent.at(-1), {
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId: "CHILD-1",
  });

  client.tabEvent(
    tab,
    "Network.loadingFinished",
    { requestId: "9" },
    "CHILD-1",
  );
  assert.deepEqual(events(), [
    {
      method: "Network.loadingFinished",
      params: { requestId: "9" },
      sessionId: "CHILD-1",
    },
  ]);
});

test("a browser-level command the shell does not emulate is rejected by name", async () => {
  const space = fakeSpace(fakeTab("T1"));
  const { call } = connect(space);

  const reply = await call("Browser.close");
  assert.equal(reply.error.message, "'Browser.close' wasn't found");
  assert.deepEqual(space.browserCommands, []);
});

test("the Browser commands the harness sends reach the space's browser", async () => {
  const space = fakeSpace(fakeTab("T1"));
  const { call } = connect(space);

  const version = await call("Browser.getVersion");
  assert.deepEqual(version.result, { product: "Chrome/155" });
  const cancel = await call("Browser.cancelDownload", { guid: "G1" });
  assert.deepEqual(cancel.result, {});
  assert.deepEqual(space.browserCommands, [
    { method: "Browser.getVersion", params: {} },
    { method: "Browser.cancelDownload", params: { guid: "G1" } },
  ]);
});
