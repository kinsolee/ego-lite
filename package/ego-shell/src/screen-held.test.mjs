import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { Screen } from "../dist/screen.js";

class Link {
  constructor(name, log) { this.name = name; this.log = log; this.slow = 0; }
  async cast(targetId, size, onFrame) {
    this.onFrame = onFrame;
    return async () => {};
  }
  frame() {
    this.onFrame({ jpeg: new Uint8Array([1]), viewport: { width: 1280, height: 800 }, pageScale: 1, ack() {} });
  }
  async dispatch(targetId, calls) {
    if (this.slow) await delay(this.slow);
    for (const call of calls) this.log.push(`${this.name}:${call.params.type}${call.params.commands ? "+" + call.params.commands : ""}`);
  }
  async focusSelectAt() { return false; }
  async selectedText() { return ""; }
  async putClipboard(targetId, text) { this.log.push(`${this.name}:put ${text}`); }
}

class Port {
  clipboard = "";
  frame() {} status() {} clear() {}
  async readClipboard() { return this.clipboard; }
  writeClipboard(text) { this.clipboard = text; }
  chooseFiles() { return new Promise(() => {}); }
}

const src = (id, link) => ({ id, ownership: "user", link, shownTargetId: () => `t${id}` });
const mouse = (type) => ({ kind: "mouse", type, at: { x: 320, y: 300 }, button: "left", buttons: type === "up" ? 0 : 1, clickCount: 1, modifiers: 0 });
const key = (type, code, k, keyCode, modifiers = 0) => ({ kind: "key", type, key: k, code, keyCode, location: 0, repeat: false, modifiers });

async function shown(port, ...sources) {
  const screen = new Screen(port);
  screen.resize({ width: 640, height: 600 }, 1);
  for (const s of sources) { screen.show(s); await delay(5); s.link.frame(); }
  return screen;
}

test("input queued while the user held the space is dropped once an agent takes it", async () => {
  const log = [];
  const link = new Link("A", log);
  const a = src(1, link);
  const screen = await shown(new Port(), a);
  link.slow = 30;
  screen.receive(mouse("down"));
  screen.receive(mouse("move"));
  screen.receive(mouse("up"));
  a.ownership = "agent";
  screen.retarget(a);
  log.push("agent holds");
  await delay(200);
  assert.deepEqual(log.slice(log.indexOf("agent holds") + 1), []);
});

test("switching spaces mid-press releases the old space and sends the new one no stray release", async () => {
  const log = [];
  const a = src(1, new Link("A", log));
  const b = src(2, new Link("B", log));
  const port = new Port();
  const screen = await shown(port, a);
  screen.receive(mouse("down"));
  screen.receive(key("down", "ShiftLeft", "Shift", 16, 8));
  await delay(10);
  screen.show(b);
  await delay(5);
  b.link.frame();
  screen.receive(key("up", "ShiftLeft", "Shift", 16, 0));
  screen.receive(mouse("up"));
  await delay(20);
  assert.deepEqual(log.filter((e) => e.startsWith("A:")), ["A:mousePressed", "A:rawKeyDown", "A:keyUp", "A:mouseReleased"]);
  assert.deepEqual(log.filter((e) => e.startsWith("B:")), []);
});

test("Cmd+V with no text on the host pastes nothing from the kernel clipboard", async () => {
  const log = [];
  const link = new Link("A", log);
  link.selectedText = async () => "old secret text";
  const a = src(1, link);
  const port = new Port();
  const screen = await shown(port, a);
  screen.receive(key("down", "KeyC", "c", 67, 4));
  await delay(10);
  port.clipboard = ""; // host now holds an image or files: readText() is ""
  screen.receive(key("down", "KeyV", "v", 86, 4));
  await delay(10);
  assert.deepEqual(log.filter((e) => e.startsWith("A:put")), []);
  assert.ok(log.includes("A:rawKeyDown"), "the keys still reach the page");
  assert.ok(!log.some((e) => e.endsWith("+paste")), "without the paste command");
});
