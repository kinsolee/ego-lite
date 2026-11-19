import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { parseDialogAnswer, parseViewSize, Screen } from "../dist/screen.js";

/** Records what the Screen asks of the link; frames are pushed by the test. */
class FakeLink {
  log = [];
  casts = [];
  dispatched = [];
  selects = new Set();
  selection = "";
  async cast(targetId, size, onFrame) {
    const cast = { targetId, size, onFrame, stopped: false, acks: 0 };
    this.casts.push(cast);
    this.log.push(`cast ${targetId} ${size.maxWidth}x${size.maxHeight}`);
    return async () => {
      if (!cast.stopped) this.log.push(`stop ${targetId}`);
      cast.stopped = true;
    };
  }
  frame(index = -1, viewport = { width: 1280, height: 800 }) {
    const cast = this.casts.at(index);
    cast.onFrame({ jpeg: new Uint8Array([cast.targetId.charCodeAt(0)]), viewport, pageScale: 1, ack: () => cast.acks++ });
    return cast;
  }
  async dispatch(targetId, calls, live = () => true, sending = () => {}) {
    if (this.lookup) await this.lookup();
    for (const [index, call] of calls.entries()) {
      if (!live()) throw new Error("The space changed hands");
      if (index === 0) sending();
      this.dispatched.push({ targetId, ...call });
      this.log.push(`${call.method} ${call.params.type ?? call.params.text ?? ""}`.trim());
    }
  }
  async focusSelectAt(targetId, x, y) {
    const hit = this.selects.has(`${x},${y}`);
    if (hit) this.log.push(`focus select ${x},${y}`);
    return hit;
  }
  async selectedText() {
    this.log.push("read selection");
    return this.selection;
  }
  async putClipboard(targetId, text) {
    this.log.push(`put clipboard ${text}`);
  }
}

class FakePort {
  frames = [];
  statuses = [];
  clipboard = "";
  chooser = [];
  frame(seq, jpeg, fit) {
    this.frames.push({ seq, jpeg, fit });
    this.shown.push(`frame ${String.fromCharCode(jpeg[0])}`);
  }
  shown = [];
  clear() {
    this.shown.push("clear");
  }
  status(status) {
    this.statuses.push(status);
  }
  async readClipboard() {
    return this.clipboard;
  }
  writeClipboard(text) {
    this.clipboard = text;
  }
  chooseFiles(multiple) {
    return new Promise((resolve) => this.chooser.push({ multiple, resolve }));
  }
  get lastStatus() {
    return this.statuses.at(-1);
  }
}

function source(id, targetId, ownership = "user") {
  const link = new FakeLink();
  return { id, ownership, link, target: targetId, shownTargetId() { return this.target; } };
}

const settle = () => delay(5);

function setup() {
  const port = new FakePort();
  const screen = new Screen(port);
  screen.resize({ width: 640, height: 600 }, 2);
  return { port, screen };
}

const mouse = (type, x = 320, y = 300, extra = {}) => ({
  kind: "mouse", type, at: { x, y }, button: "left", buttons: type === "up" ? 0 : 1, clickCount: 1, modifiers: 0, ...extra,
});
const key = (type, code, keyCode, modifiers = 0, keyName = code.at(-1).toLowerCase()) => ({
  kind: "key", type, key: keyName, code, keyCode, location: 0, repeat: false, modifiers,
});

test("showing a space casts its active tab at the view's device size", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  screen.show(a);
  await settle();
  assert.deepEqual(a.link.log, ["cast A1 1280x1200"]);
  assert.deepEqual(port.lastStatus, { spaceId: 1, holder: "user", prompt: null });
});

test("switching to a space with no frame yet blanks the view instead of keeping the old space's page", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  const b = source(2, "B1");
  screen.show(a);
  await settle();
  a.link.frame();
  screen.show(b);
  await settle();
  assert.deepEqual(port.shown, ["clear", "frame A", "clear"]);
  screen.hide(b);
  assert.deepEqual(port.shown, ["clear", "frame A", "clear", "clear"]);
});

test("a frame is acknowledged only after the view drew it", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  await settle();
  const cast = a.link.frame();
  assert.equal(port.frames.length, 1);
  assert.equal(cast.acks, 0);
  assert.equal(port.frames[0].fit.scale, 0.5);
  screen.drawn(port.frames[0].seq + 1);
  assert.equal(cast.acks, 0, "a stale seq acknowledges nothing");
  screen.drawn(port.frames[0].seq);
  screen.drawn(port.frames[0].seq);
  assert.equal(cast.acks, 1);
});

test("switching spaces stops the old cast, drops its late frames and shows the new tab's last frame at once", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  const b = source(2, "B1");
  screen.show(b);
  await settle();
  b.link.frame();
  screen.show(a);
  await settle();
  const before = port.frames.length;
  b.link.frame(0);
  assert.equal(port.frames.length, before, "a late frame from the previous space is dropped");
  assert.deepEqual(b.link.log, ["cast B1 1280x1200", "stop B1"]);
  screen.show(b);
  assert.equal(port.frames.length, before + 1, "the cached frame is drawn before the cast restarts");
  assert.deepEqual([...port.frames.at(-1).jpeg], [66]);
});

test("hiding stops the cast only for the space shown", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  const b = source(2, "B1");
  screen.show(a);
  await settle();
  screen.hide(b);
  await settle();
  assert.deepEqual(a.link.log, ["cast A1 1280x1200"]);
  screen.hide(a);
  await settle();
  assert.deepEqual(a.link.log, ["cast A1 1280x1200", "stop A1"]);
  assert.deepEqual(port.lastStatus, { spaceId: null, holder: null, prompt: null });
});

test("a new active tab or a new view size restarts the cast", async () => {
  const { screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  await settle();
  a.target = "A2";
  screen.retarget(a);
  await settle();
  screen.resize({ width: 800, height: 600 }, 2);
  await settle();
  assert.deepEqual(a.link.log, ["cast A1 1280x1200", "stop A1", "cast A2 1280x1200", "stop A2", "cast A2 1600x1200"]);
});

test("input reaches the page only while the user holds the space, mapped to page pixels", async () => {
  const { screen } = setup();
  const a = source(1, "A1", "agent");
  screen.show(a);
  await settle();
  a.link.frame();
  screen.receive(mouse("down"));
  await settle();
  assert.equal(a.link.dispatched.length, 0, "view-only while an agent holds the space");
  a.ownership = "user";
  screen.retarget(a);
  screen.receive(mouse("down"));
  screen.receive(mouse("up"));
  screen.receive({ kind: "eval", code: "1" });
  await settle();
  assert.deepEqual(
    a.link.dispatched.map((call) => [call.params.type, call.params.x, call.params.y]),
    [["mousePressed", 640, 400], ["mouseReleased", 640, 400]],
  );
});

test("a press the space is lost before sending gets no release either", async () => {
  const { screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  await settle();
  a.link.frame();
  let lookedUp;
  a.link.lookup = () => new Promise((resolve) => (lookedUp = resolve));
  screen.receive(mouse("down"));
  await settle();
  a.ownership = "agent";
  screen.retarget(a);
  a.link.lookup = undefined;
  lookedUp();
  await settle();
  assert.equal(a.link.dispatched.length, 0, "neither the press nor a release for it reach the page");
});

test("nothing is forwarded before the first frame says where the page is", async () => {
  const { screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  await settle();
  screen.receive(mouse("down"));
  await settle();
  assert.equal(a.link.dispatched.length, 0);
});

test("a press on a <select> focuses it and neither the press nor its release reach the page", async () => {
  const { screen } = setup();
  const a = source(1, "A1");
  a.link.selects.add("640,400");
  screen.show(a);
  await settle();
  a.link.frame();
  screen.receive(mouse("down"));
  screen.receive(mouse("up"));
  screen.receive(key("down", "KeyB", 66));
  await settle();
  assert.deepEqual(a.link.log.slice(1), ["focus select 640,400", "Input.dispatchKeyEvent keyDown"]);
});

test("Cmd+X reads the selection before the key removes it, then puts it on the host clipboard", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  await settle();
  a.link.frame();
  a.link.selection = "Pedido 42";
  screen.receive(key("down", "KeyX", 88, 4));
  await settle();
  assert.deepEqual(a.link.log.slice(1), ["read selection", "Input.dispatchKeyEvent rawKeyDown"]);
  assert.deepEqual(a.link.dispatched[0].params.commands, ["cut"]);
  assert.equal(port.clipboard, "Pedido 42");
});

test("Cmd+V puts the host clipboard into the kernel before the key", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  await settle();
  a.link.frame();
  port.clipboard = "Olá mundo";
  screen.receive(key("down", "KeyV", 86, 4));
  await settle();
  assert.deepEqual(a.link.log.slice(1), ["put clipboard Olá mundo", "Input.dispatchKeyEvent rawKeyDown"]);
});

test("a paste of what the same kernel copied keeps the kernel's own rich clipboard", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  const b = source(2, "B1");
  screen.show(a);
  await settle();
  a.link.frame();
  a.link.selection = "Olá mundo";
  screen.receive(key("down", "KeyX", 88, 4));
  screen.receive(key("down", "KeyV", 86, 4));
  await settle();
  assert.deepEqual(a.link.log.slice(1), ["read selection", "Input.dispatchKeyEvent rawKeyDown", "Input.dispatchKeyEvent rawKeyDown"]);
  assert.equal(port.clipboard, "Olá mundo");

  screen.show(b);
  await settle();
  b.link.frame();
  screen.receive(key("down", "KeyV", 86, 4));
  await settle();
  assert.deepEqual(b.link.log.slice(1), ["put clipboard Olá mundo", "Input.dispatchKeyEvent rawKeyDown"], "another kernel gets the host's text");

  screen.show(a);
  await settle();
  a.link.frame();
  port.clipboard = "copiado noutro app";
  screen.receive(key("down", "KeyV", 86, 4));
  await settle();
  assert.equal(a.link.log.at(-2), "put clipboard copiado noutro app", "a newer host copy replaces the kernel's");
});

test("input keeps its order even when a step waits on the page", async () => {
  const { screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  await settle();
  a.link.frame();
  const read = a.link.selectedText.bind(a.link);
  a.link.selectedText = async () => {
    await delay(20);
    return read();
  };
  screen.receive(key("down", "KeyC", 67, 4));
  screen.receive(key("up", "KeyC", 67, 4));
  screen.receive({ kind: "composition", phase: "commit", text: "você" });
  await delay(40);
  assert.deepEqual(a.link.log.slice(1), ["read selection", "Input.dispatchKeyEvent rawKeyDown", "Input.dispatchKeyEvent keyUp", "Input.insertText você"]);
});

test("a dialog of the shown space is put to the human, and the answer goes back", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  const prompt = { kind: "dialog", type: "confirm", message: "Confirmar?", defaultPrompt: "" };
  const answered = screen.ask(a, prompt);
  assert.deepEqual(port.lastStatus.prompt, prompt);
  screen.answer({ kind: "dialog", accept: true });
  assert.deepEqual(await answered, { kind: "dialog", accept: true });
  assert.equal(port.lastStatus.prompt, null);
});

test("a dialog of a space not shown waits until it is", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  const b = source(2, "B1");
  screen.show(a);
  const answered = screen.ask(b, { kind: "dialog", type: "alert", message: "Oi", defaultPrompt: "" });
  assert.equal(port.lastStatus.prompt, null);
  screen.answer({ kind: "dialog", accept: true });
  screen.show(b);
  assert.equal(port.lastStatus.prompt.message, "Oi");
  screen.answer({ kind: "dialog", accept: true });
  assert.deepEqual(await answered, { kind: "dialog", accept: true });
});

test("a file chooser opens the native picker and answers with what was picked", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  const answered = screen.ask(a, { kind: "files", multiple: true });
  assert.equal(port.chooser.length, 1);
  assert.equal(port.chooser[0].multiple, true);
  port.chooser[0].resolve(["/tmp/nota.txt"]);
  assert.deepEqual(await answered, { kind: "files", paths: ["/tmp/nota.txt"] });
});

test("the view's size and dialog answers are checked at the boundary", () => {
  assert.deepEqual(parseViewSize({ width: 940.5, height: 716, dpr: 2 }), { view: { width: 940.5, height: 716 }, dpr: 2 });
  for (const bad of [null, { width: -1, height: 1, dpr: 1 }, { width: 1, height: 1, dpr: 0 }, { width: "1", height: 1, dpr: 1 }]) {
    assert.throws(() => parseViewSize(bad), /Invalid view size/);
  }
  assert.deepEqual(parseDialogAnswer({ accept: true, promptText: "Maria" }), { kind: "dialog", accept: true, promptText: "Maria" });
  assert.deepEqual(parseDialogAnswer({ accept: false }), { kind: "dialog", accept: false });
  for (const bad of [null, { accept: "yes" }, { accept: true, promptText: 3 }]) {
    assert.throws(() => parseDialogAnswer(bad), /Invalid dialog answer/);
  }
});

test("an agent taking the space drops the human's pending prompts", async () => {
  const { port, screen } = setup();
  const a = source(1, "A1");
  screen.show(a);
  const answered = screen.ask(a, { kind: "dialog", type: "alert", message: "Oi", defaultPrompt: "" });
  a.ownership = "agent";
  screen.retarget(a);
  await assert.rejects(answered);
  assert.deepEqual(port.lastStatus, { spaceId: 1, holder: "agent", prompt: null });
});
