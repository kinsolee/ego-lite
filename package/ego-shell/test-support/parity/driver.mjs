import { center } from "./layout.mjs";
import { PAUSE } from "./session.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const META = 4;
const SHIFT = 8;
const BUTTON_BITS = { left: 1, right: 2, middle: 4 };

// Cmd+letter as fix 5 sends it: the key plus the editing command, which a
// headless kernel needs to act on the shortcut.
const SHORTCUTS = { a: [65, 0, "selectAll"], c: [67, 8, "copy"], x: [88, 7, "cut"], v: [86, 9, "paste"] };

// A Brazilian ABNT2 keyboard: ç has its own key, accents are dead keys that
// compose with the next letter.
const DIRECT = { "ç": { key: "ç", code: "Semicolon", vk: 186 } };
const DEAD = {
  "~": { code: "Quote", vk: 222, modifiers: 0 },
  "´": { code: "BracketLeft", vk: 219, modifiers: 0 },
};
const COMPOSED = { "ã": ["~", "a"], "õ": ["~", "o"], "á": ["´", "a"], "é": ["´", "e"], "í": ["´", "i"], "ó": ["´", "o"], "ú": ["´", "u"] };

function asciiKey(char) {
  if (/[a-z]/i.test(char)) {
    const upper = char.toUpperCase();
    return { key: char, code: `Key${upper}`, vk: upper.charCodeAt(0), text: char, shift: char !== char.toLowerCase() };
  }
  if (/[0-9]/.test(char)) return { key: char, code: `Digit${char}`, vk: char.charCodeAt(0), text: char };
  if (char === " ") return { key: " ", code: "Space", vk: 32, text: " " };
  throw new Error(`no key for ${JSON.stringify(char)}`);
}

/**
 * Plays the session through Input.* (and DOM.focus for the select route) on
 * one page session, the shell's own, never the agent's.
 */
export async function drive(cdp, sessionId, steps) {
  const send = (method, params) => cdp.send(method, params, sessionId);
  let at = { x: 500, y: 560 };

  const mouse = (type, extra = {}) =>
    send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, modifiers: 0, button: "none", buttons: 0, ...extra });
  const keyEvent = (type, { key, code, vk, text, modifiers = 0, location, native, commands }) =>
    send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: vk,
      ...(native !== undefined ? { nativeVirtualKeyCode: native } : {}),
      modifiers,
      ...(text !== undefined ? { text, unmodifiedText: text } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(commands ? { commands } : {}),
    });
  const tap = async (spec) => {
    await keyEvent(spec.text !== undefined ? "keyDown" : "rawKeyDown", spec);
    await sleep(PAUSE.hold);
    await keyEvent("keyUp", { ...spec, text: undefined, commands: undefined });
  };
  const shift = (type) =>
    keyEvent(type, { key: "Shift", code: "ShiftLeft", vk: 16, location: 1, modifiers: type === "keyUp" ? 0 : SHIFT });
  const meta = (type) =>
    keyEvent(type, { key: "Meta", code: "MetaLeft", vk: 91, location: 1, modifiers: type === "keyUp" ? 0 : META });

  const typeChar = async (char) => {
    if (DIRECT[char]) return tap({ ...DIRECT[char], text: char });
    if (COMPOSED[char]) {
      const [accent, base] = COMPOSED[char];
      const dead = { key: "Dead", ...DEAD[accent] };
      await keyEvent("rawKeyDown", dead);
      await send("Input.imeSetComposition", { text: accent, selectionStart: 1, selectionEnd: 1 });
      await sleep(PAUSE.hold);
      await keyEvent("keyUp", dead);
      await sleep(PAUSE.key);
      const letter = asciiKey(base);
      await keyEvent("rawKeyDown", { key: "Process", code: letter.code, vk: 229 });
      await send("Input.insertText", { text: char });
      await sleep(PAUSE.hold);
      return keyEvent("keyUp", { key: letter.key, code: letter.code, vk: letter.vk });
    }
    const spec = asciiKey(char);
    if (!spec.shift) return tap(spec);
    await shift("rawKeyDown");
    await sleep(PAUSE.key);
    await tap({ ...spec, modifiers: SHIFT });
    await sleep(PAUSE.key);
    await shift("keyUp");
  };

  const ACTIONS = {
    async move({ to, frame }) {
      const from = at;
      const goal = center(to, frame);
      for (let i = 1; i <= 10; i += 1) {
        at = { x: Math.round(from.x + ((goal.x - from.x) * i) / 10), y: Math.round(from.y + ((goal.y - from.y) * i) / 10) };
        await mouse("mouseMoved");
        await sleep(PAUSE.move);
      }
    },
    async click({ button, count = 1 }) {
      for (let clickCount = 1; clickCount <= count; clickCount += 1) {
        if (clickCount > 1) await sleep(PAUSE.key);
        await mouse("mousePressed", { button, buttons: BUTTON_BITS[button], clickCount });
        await sleep(PAUSE.hold);
        await mouse("mouseReleased", { button, buttons: 0, clickCount });
      }
    },
    async wheel({ deltaX = 0, deltaY }) {
      await mouse("mouseWheel", { deltaX, deltaY });
    },
    async type({ text }) {
      for (const char of text) {
        await typeChar(char);
        await sleep(PAUSE.key);
      }
    },
    async ime({ keys, commit }) {
      for (let i = 1; i <= keys.length; i += 1) {
        const letter = asciiKey(keys[i - 1]);
        await keyEvent("rawKeyDown", { key: "Process", code: letter.code, vk: 229 });
        await send("Input.imeSetComposition", { text: keys.slice(0, i), selectionStart: i, selectionEnd: i });
        await sleep(PAUSE.hold);
        await keyEvent("keyUp", { key: letter.key, code: letter.code, vk: letter.vk });
        await sleep(PAUSE.key);
      }
      await keyEvent("rawKeyDown", { key: "Process", code: "Space", vk: 229 });
      await send("Input.insertText", { text: commit });
      await sleep(PAUSE.hold);
      await keyEvent("keyUp", { key: " ", code: "Space", vk: 32 });
    },
    async shortcut({ key }) {
      const [vk, native, command] = SHORTCUTS[key];
      const spec = { key, code: `Key${key.toUpperCase()}`, vk, native, modifiers: META };
      await meta("rawKeyDown");
      await sleep(PAUSE.key);
      await keyEvent("rawKeyDown", { ...spec, commands: [command] });
      await sleep(PAUSE.hold);
      await keyEvent("keyUp", spec);
      await sleep(PAUSE.key);
      await meta("keyUp");
    },
    async key({ name }) {
      if (name !== "Tab") throw new Error(`unknown key ${name}`);
      await tap({ key: "Tab", code: "Tab", vk: 9, native: 48 });
    },
    // The shell's <select> route: focus the closed select, then send the
    // first letter of the option the human picked in the shell's list.
    async focusSelect({ id, frame }) {
      const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
      const scope = frame === "iframe" ? findNode(root, (node) => attribute(node, "id") === "frame")?.contentDocument : root;
      const node = scope && findNode(scope, (candidate) => attribute(candidate, "id") === id);
      if (!node) throw new Error(`#${id} not found in ${frame}`);
      await send("DOM.focus", { nodeId: node.nodeId });
    },
    async typeAhead({ char }) {
      await tap(asciiKey(char));
    },
  };

  for (const step of steps) {
    await ACTIONS[step.do](step);
    await sleep(PAUSE.step);
  }
}

function attribute(node, name) {
  const list = node.attributes ?? [];
  for (let i = 0; i < list.length; i += 2) if (list[i] === name) return list[i + 1];
  return undefined;
}

function findNode(node, matches) {
  if (matches(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, matches);
    if (found) return found;
  }
  return undefined;
}
