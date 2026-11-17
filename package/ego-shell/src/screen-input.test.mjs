import assert from "node:assert/strict";
import test from "node:test";

import { fit } from "../dist/screen-geometry.js";
import {
  editCommand,
  parseScreenInput,
  translate,
} from "../dist/screen-input.js";

const AT = fit({ width: 640, height: 600 }, { width: 1280, height: 800 }, 1);
const META = 4;
const SHIFT = 8;

const mouse = (type, extra = {}) => ({
  kind: "mouse",
  type,
  at: { x: 320, y: 300 },
  button: "left",
  buttons: 1,
  clickCount: 1,
  modifiers: 0,
  ...extra,
});
const key = (type, extra = {}) => ({
  kind: "key",
  type,
  key: "a",
  code: "KeyA",
  keyCode: 65,
  location: 0,
  repeat: false,
  modifiers: 0,
  ...extra,
});

test("a mouse press lands on the page point under it", () => {
  assert.deepEqual(translate(mouse("down", { clickCount: 2 }), AT), [
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 640, y: 400, button: "left", buttons: 1, clickCount: 2, modifiers: 0 },
    },
  ]);
  assert.equal(translate(mouse("move", { button: "none", buttons: 0, clickCount: 0 }), AT)[0].params.type, "mouseMoved");
});

test("input in the letterbox margin goes nowhere, but a release is kept on the page edge", () => {
  assert.deepEqual(translate(mouse("down", { at: { x: 320, y: 20 } }), AT), []);
  const [release] = translate(mouse("up", { at: { x: 700, y: 20 }, buttons: 0 }), AT);
  assert.deepEqual([release.params.type, release.params.x, release.params.y], ["mouseReleased", 1279, 0]);
});

test("a wheel turn keeps its deltas", () => {
  assert.deepEqual(translate({ kind: "wheel", at: { x: 320, y: 300 }, deltaX: 0, deltaY: 120, modifiers: 0 }, AT), [
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 120, modifiers: 0, button: "none", buttons: 0 },
    },
  ]);
});

test("a key that types text carries it; other keys go raw", () => {
  const [down] = translate(key("down", { key: "A", modifiers: SHIFT }), AT);
  assert.equal(down.params.type, "keyDown");
  assert.equal(down.params.text, "A");
  assert.equal(down.params.windowsVirtualKeyCode, 65);
  const [tab] = translate(key("down", { key: "Tab", code: "Tab", keyCode: 9 }), AT);
  assert.equal(tab.params.type, "rawKeyDown");
  assert.equal(tab.params.text, undefined);
  const [enter] = translate(key("down", { key: "Enter", code: "Enter", keyCode: 13 }), AT);
  assert.deepEqual([enter.params.type, enter.params.text], ["keyDown", "\r"]);
  const [up] = translate(key("up"), AT);
  assert.deepEqual([up.params.type, up.params.text], ["keyUp", undefined]);
});

test("a held Meta or Control key types no text", () => {
  const [ctrl] = translate(key("down", { modifiers: 2 }), AT);
  assert.deepEqual([ctrl.params.type, ctrl.params.text], ["rawKeyDown", undefined]);
});

test("Cmd+C, X, V, A, Z and Shift+Cmd+Z carry the editing command a headless kernel needs", () => {
  const cases = [
    ["KeyC", 67, 0, "copy", 8],
    ["KeyX", 88, 0, "cut", 7],
    ["KeyV", 86, 0, "paste", 9],
    ["KeyA", 65, 0, "selectAll", 0],
    ["KeyZ", 90, 0, "undo", 6],
    ["KeyZ", 90, SHIFT, "redo", 6],
  ];
  for (const [code, keyCode, extra, command, native] of cases) {
    const input = key("down", { key: code.at(-1).toLowerCase(), code, keyCode, modifiers: META | extra });
    assert.equal(editCommand(input), command);
    const [down] = translate(input, AT);
    assert.deepEqual(down.params.commands, [command], code);
    assert.equal(down.params.nativeVirtualKeyCode, native, code);
    assert.equal(down.params.type, "rawKeyDown");
  }
  assert.equal(editCommand(key("down", { code: "KeyC", modifiers: 2 })), undefined, "Ctrl+C is not copy on a Mac");
  assert.equal(translate(key("up", { code: "KeyC", modifiers: META }), AT)[0].params.commands, undefined);
});

test("a key the IME composes with goes as keyCode 229 with its real key, released with its real code", () => {
  const [down] = translate(key("down", { key: "n", code: "KeyN", keyCode: 229 }), AT);
  assert.deepEqual(
    [down.params.type, down.params.key, down.params.code, down.params.windowsVirtualKeyCode, down.params.text],
    ["rawKeyDown", "n", "KeyN", 229, undefined],
  );
  const [dead] = translate(key("down", { key: "Dead", code: "Quote", keyCode: 229 }), AT);
  assert.deepEqual([dead.params.key, dead.params.windowsVirtualKeyCode], ["Dead", 229]);
  const [up] = translate(key("up", { key: "n", code: "KeyN", keyCode: 78 }), AT);
  assert.deepEqual([up.params.type, up.params.windowsVirtualKeyCode], ["keyUp", 78]);
});

test("a composition updates through imeSetComposition and commits through insertText", () => {
  assert.deepEqual(
    translate({ kind: "composition", phase: "update", text: "nih", selectionStart: 3, selectionEnd: 3 }, AT),
    [{ method: "Input.imeSetComposition", params: { text: "nih", selectionStart: 3, selectionEnd: 3 } }],
  );
  assert.deepEqual(translate({ kind: "composition", phase: "commit", text: "你好" }, AT), [
    { method: "Input.insertText", params: { text: "你好" } },
  ]);
  assert.deepEqual(translate({ kind: "composition", phase: "commit", text: "" }, AT), [
    { method: "Input.imeSetComposition", params: { text: "", selectionStart: 0, selectionEnd: 0 } },
  ]);
});

test("the renderer's input is checked once at the boundary", () => {
  assert.deepEqual(parseScreenInput(mouse("down")), mouse("down"));
  assert.deepEqual(parseScreenInput(key("down", { repeat: true })), key("down", { repeat: true }));
  const bad = [
    null,
    "click",
    { kind: "mouse", type: "down" },
    mouse("down", { at: { x: Number.NaN, y: 1 } }),
    mouse("down", { button: "fourth" }),
    mouse("down", { modifiers: 16 }),
    key("down", { key: 7 }),
    key("sideways"),
    { kind: "composition", phase: "update", text: "a", selectionStart: -1, selectionEnd: 0 },
    { kind: "composition", phase: "commit" },
    { kind: "eval", code: "1" },
  ];
  for (const payload of bad) assert.throws(() => parseScreenInput(payload), /Invalid screen input/, JSON.stringify(payload));
});
