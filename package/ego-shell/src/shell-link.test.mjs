import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { ShellLink } from "../dist/shell-link.js";
import { startFakeBrowser } from "../test-support/fake-cdp-browser.mjs";

async function setup(t) {
  const chromium = await startFakeBrowser();
  const link = await ShellLink.connect(chromium.endpoint, 2_000);
  t.after(async () => {
    link.close();
    await chromium.close();
  });
  const page = chromium.openPage({ newWindow: true, url: "https://shop.example/" });
  return { chromium, link, page };
}

async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a new tab opens in the anchor's window with no opener and only its own history", async (t) => {
  const { chromium, link, page } = await setup(t);
  const other = chromium.openPage({ newWindow: true });
  const opened = await link.openIn(page, "https://shop.example/pedidos");
  assert.notEqual(opened, page);
  assert.equal(chromium.windowOf(opened), chromium.windowOf(page));
  assert.notEqual(chromium.windowOf(opened), chromium.windowOf(other));
  const [open] = chromium.calls.filter((call) => call.method === "Runtime.evaluate" && call.params.expression.includes("window.open("));
  assert.match(open.params.expression, /noopener/);
  assert.equal(open.params.userGesture, true);
  assert.ok(open.params.contextId, "evaluated in an isolated world, not the page's own");
  const navigate = chromium.calls.find((call) => call.method === "Page.navigate");
  assert.deepEqual(navigate.params, { url: "https://shop.example/pedidos", transitionType: "typed" });
  assert.ok(chromium.calls.some((call) => call.method === "Page.resetNavigationHistory" && call.sessionId === navigate.sessionId));
});

test("tabs opened at the same time are each their own", async (t) => {
  const { chromium, link, page } = await setup(t);
  const opened = await Promise.all([
    link.openIn(page, "https://shop.example/one"),
    link.openIn(page, "https://shop.example/two"),
  ]);
  assert.equal(new Set(opened).size, 2);
  const urls = chromium.calls
    .filter((call) => call.method === "Page.navigate")
    .map((call) => [call.sessionId, call.params.url]);
  assert.equal(new Set(urls.map(([session]) => session)).size, 2, "each tab navigated once, in its own session");
});

test("a page's own popup opening meanwhile is not taken for the shell's tab", async (t) => {
  const { chromium, link, page } = await setup(t);
  const other = chromium.openPage({ newWindow: true });
  chromium.beforeOpen.push(() => chromium.openPage({ windowId: chromium.windowOf(other), openerId: other }));
  const opened = await link.openIn(page, "https://shop.example/pedidos");
  assert.equal(chromium.windowOf(opened), chromium.windowOf(page));
});

test("a window is read and placed through the link", async (t) => {
  const { chromium, link, page } = await setup(t);
  chromium.evaluations.push((expression) =>
    expression.includes("screen.availLeft") ? { left: 0, top: 25, width: 1920, height: 1055 } : undefined,
  );
  assert.deepEqual(await link.availArea(page), { left: 0, top: 25, width: 1920, height: 1055 });
  await link.placeWindow(page, { left: 28, top: 53, width: 1440, height: 900 });
  assert.deepEqual(chromium.boundsOf(chromium.windowOf(page)), {
    left: 28,
    top: 53,
    width: 1440,
    height: 900,
    windowState: "normal",
  });
});

test("frames come one at a time, each only after the previous was acknowledged", async (t) => {
  const { chromium, link, page } = await setup(t);
  const frames = [];
  const stop = await link.cast(page, { maxWidth: 1880, maxHeight: 1430 }, (frame) => frames.push(frame));
  const [session] = chromium.sessionsOf(page);
  assert.deepEqual(chromium.castOf(session), { format: "jpeg", quality: 80, maxWidth: 1880, maxHeight: 1430, everyNthFrame: 1 });
  assert.equal(chromium.paint(page, { deviceWidth: 1440, deviceHeight: 900, pageScaleFactor: 1.5 }), 1);
  await until(() => frames.length === 1, "the first frame");
  assert.equal(chromium.paint(page), 0, "no second frame before the ack");
  assert.equal(Buffer.from(frames[0].jpeg).toString(), `frame 1 of ${page}`);
  assert.deepEqual(frames[0].viewport, { width: 1440, height: 900 });
  assert.equal(frames[0].pageScale, 1.5);
  frames[0].ack();
  await until(() => chromium.paint(page) === 1, "the ack");
  await stop();
  await stop();
  assert.equal(chromium.castOf(session), null);
});

test("input goes in order on the shell's session", async (t) => {
  const { chromium, link, page } = await setup(t);
  await link.dispatch(page, [
    { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 1, y: 2 } },
    { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 1, y: 2 } },
  ]);
  const [session] = chromium.sessionsOf(page);
  assert.deepEqual(
    chromium.sent(session, "Input.dispatchMouseEvent").map((call) => call.params.type),
    ["mousePressed", "mouseReleased"],
  );
});

test("a press on a closed <select> focuses it instead of opening it", async (t) => {
  const { chromium, link, page } = await setup(t);
  chromium.hits.set(page, (x) => (x < 100 ? "SELECT" : "INPUT"));
  assert.equal(await link.focusSelectAt(page, 50, 10), true);
  assert.equal(await link.focusSelectAt(page, 150, 10), false);
  const [session] = chromium.sessionsOf(page);
  const focused = chromium.sent(session, "DOM.focus");
  assert.equal(focused.length, 1);
  assert.equal(chromium.sent(session, "Input.dispatchMouseEvent").length, 0);
});

test("the copied text and the pasted text pass through the focused frame's isolated world", async (t) => {
  const { chromium, link, page } = await setup(t);
  const written = [];
  chromium.evaluations.push((expression) => {
    if (expression.includes("getSelection")) return "Pedido 42";
    if (expression.includes("clipboard.writeText")) {
      written.push(expression);
      return "ok";
    }
    return undefined;
  });
  assert.equal(await link.selectedText(page), "Pedido 42");
  await link.putClipboard(page, "Olá \"mundo\"");
  assert.equal(written.length, 1);
  assert.ok(written[0].includes(JSON.stringify("Olá \"mundo\"")));
  const grants = chromium.calls.filter((call) => call.method === "Browser.grantPermissions");
  assert.equal(grants.length, 0, "the page is never granted clipboard access");
});

test("copy and paste use the focused frame, even a cross-origin one in the page's own process", async (t) => {
  const { chromium, link, page } = await setup(t);
  chromium.childFrames.set(page, ["F-shop", "F-pay"]);
  const focused = new Set([`F-${page}`, "F-pay"]);
  const writtenIn = [];
  chromium.evaluations.push((expression, _target, frameId) => {
    if (expression === "document.hasFocus()") return focused.has(frameId);
    if (expression.includes("getSelection")) return `selection in ${frameId}`;
    if (expression.includes("clipboard.writeText")) {
      writtenIn.push(frameId);
      return "ok";
    }
    return undefined;
  });
  assert.equal(await link.selectedText(page), "selection in F-pay");
  await link.putClipboard(page, "Olá");
  assert.deepEqual(writtenIn, ["F-pay"]);
  focused.delete("F-pay");
  assert.equal(await link.selectedText(page), `selection in F-${page}`);
});

test("while the user holds a tab, its dialogs and file choosers are answered through the link", async (t) => {
  const { chromium, link, page } = await setup(t);
  const asked = [];
  await link.answerFor(page, async (prompt) => {
    asked.push(prompt);
    return prompt.kind === "dialog"
      ? { kind: "dialog", accept: true, promptText: "Maria" }
      : { kind: "files", paths: ["/tmp/nota.txt"] };
  });
  const [session] = chromium.sessionsOf(page);
  chromium.dialog(page, { type: "prompt", message: "Nome?", defaultPrompt: "x" });
  await until(() => chromium.sent(session, "Page.handleJavaScriptDialog").length === 1, "the dialog answer");
  assert.deepEqual(chromium.sent(session, "Page.handleJavaScriptDialog")[0].params, { accept: true, promptText: "Maria" });
  chromium.fileChooser(page, { mode: "selectMultiple", backendNodeId: 9 });
  await until(() => chromium.sent(session, "DOM.setFileInputFiles").length === 1, "the files");
  assert.deepEqual(chromium.sent(session, "DOM.setFileInputFiles")[0].params, { files: ["/tmp/nota.txt"], backendNodeId: 9 });
  assert.deepEqual(asked, [
    { kind: "dialog", type: "prompt", message: "Nome?", defaultPrompt: "x" },
    { kind: "files", multiple: true },
  ]);

  await link.answerFor(page, null);
  chromium.dialog(page, { type: "alert", message: "Oi" });
  chromium.fileChooser(page);
  await delay(30);
  assert.equal(asked.length, 2, "an agent-held tab's dialogs are left to the agent");
  assert.deepEqual(chromium.sent(session, "Page.setInterceptFileChooserDialog").map((call) => call.params.enabled), [true, false]);
});

test("a dialog already open when the user takes the tab is put to the user", async (t) => {
  const { chromium, link, page } = await setup(t);
  await link.answerFor(page, null);
  chromium.dialog(page, { type: "confirm", message: "Sair?" });
  await delay(10);
  const asked = [];
  await link.answerFor(page, async (prompt) => {
    asked.push(prompt);
    return { kind: "dialog", accept: true };
  });
  const [session] = chromium.sessionsOf(page);
  await until(() => chromium.sent(session, "Page.handleJavaScriptDialog").length === 1, "the answer");
  assert.deepEqual(asked, [{ kind: "dialog", type: "confirm", message: "Sair?", defaultPrompt: "" }]);
});

test("a dialog the user left unanswered when an agent took over is asked again when the user takes back", async (t) => {
  const { chromium, link, page } = await setup(t);
  const first = [];
  await link.answerFor(page, (prompt) => {
    first.push(prompt);
    return new Promise(() => {});
  });
  chromium.dialog(page, { type: "alert", message: "Olá do site" });
  await until(() => first.length === 1, "the first ask");
  await link.answerFor(page, null);
  const second = [];
  await link.answerFor(page, async (prompt) => {
    second.push(prompt);
    return { kind: "dialog", accept: true };
  });
  const [session] = chromium.sessionsOf(page);
  await until(() => chromium.sent(session, "Page.handleJavaScriptDialog").length === 1, "the answer");
  assert.equal(second.length, 1);
});

test("a dialog someone else answered is not asked again", async (t) => {
  const { chromium, link, page } = await setup(t);
  await link.answerFor(page, null);
  chromium.dialog(page, { type: "alert", message: "x" });
  chromium.dialogClosed(page);
  await delay(10);
  const asked = [];
  await link.answerFor(page, async (prompt) => {
    asked.push(prompt);
    return { kind: "dialog", accept: true };
  });
  await delay(20);
  assert.deepEqual(asked, []);
});

test("a cancelled file chooser sets no files", async (t) => {
  const { chromium, link, page } = await setup(t);
  await link.answerFor(page, async () => ({ kind: "files", paths: [] }));
  chromium.fileChooser(page);
  await delay(30);
  const [session] = chromium.sessionsOf(page);
  assert.equal(chromium.sent(session, "DOM.setFileInputFiles").length, 0);
});

test("a closed tab's session is dropped and calls on it reject", async (t) => {
  const { chromium, link, page } = await setup(t);
  await link.dispatch(page, []);
  chromium.closePage(page);
  link.forget(page);
  await assert.rejects(link.dispatch(page, [{ method: "Input.insertText", params: { text: "a" } }]));
});
