import { toPage, type Fit, type Point } from "./screen-geometry.js";

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

const BUTTONS = ["none", "left", "middle", "right", "back", "forward"] as const;
export type MouseButton = (typeof BUTTONS)[number];

/**
 * What the screen view reports, in view CSS pixels and DOM vocabulary. This is
 * the whole renderer-to-main input protocol, sent in order on one channel.
 */
export type ScreenInput =
  | {
      kind: "mouse";
      type: "move" | "down" | "up";
      at: Point;
      button: MouseButton;
      buttons: number;
      clickCount: number;
      modifiers: number;
    }
  | {
      kind: "wheel";
      at: Point;
      deltaX: number;
      deltaY: number;
      modifiers: number;
    }
  | {
      kind: "key";
      type: "down" | "up";
      key: string;
      code: string;
      /** DOM keyCode; 229 while the IME takes the key. */
      keyCode: number;
      location: number;
      repeat: boolean;
      modifiers: number;
    }
  | {
      kind: "composition";
      phase: "update";
      text: string;
      selectionStart: number;
      selectionEnd: number;
    }
  /** An empty commit is a composition the user cancelled. */
  | { kind: "composition"; phase: "commit"; text: string };

/** One call on the shell's session of the shown tab, in page CSS pixels. */
export type InputCall = { method: string; params: Record<string, unknown> };

export type EditCommand =
  | "selectAll"
  | "copy"
  | "cut"
  | "paste"
  | "undo"
  | "redo";

/**
 * A headless kernel has no menu bar to turn Cmd+letter into an editing
 * command, so the key carries it. macOS virtual key codes go with it.
 */
const EDIT_KEYS: Record<string, { command: EditCommand; shifted?: EditCommand; native: number }> = {
  KeyA: { command: "selectAll", native: 0 },
  KeyC: { command: "copy", native: 8 },
  KeyX: { command: "cut", native: 7 },
  KeyV: { command: "paste", native: 9 },
  KeyZ: { command: "undo", shifted: "redo", native: 6 },
};

const IME_KEY_CODE = 229;

function invalid(): never {
  throw new Error("Invalid screen input");
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid();
  return value;
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
    invalid();
  }
  return value as number;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) invalid();
  return value;
}

function point(value: unknown): Point {
  const { x, y } = (value ?? {}) as { x?: unknown; y?: unknown };
  return { x: finite(x), y: finite(y) };
}

/** Refuse anything that is not exactly a ScreenInput; everything past here trusts it. */
export function parseScreenInput(payload: unknown): ScreenInput {
  if (!payload || typeof payload !== "object") invalid();
  const raw = payload as Record<string, unknown>;
  switch (raw.kind) {
    case "mouse": {
      const type = raw.type;
      if (type !== "move" && type !== "down" && type !== "up") invalid();
      if (!BUTTONS.includes(raw.button as MouseButton)) invalid();
      return {
        kind: "mouse",
        type,
        at: point(raw.at),
        button: raw.button as MouseButton,
        buttons: count(raw.buttons, 31),
        clickCount: count(raw.clickCount, 3),
        modifiers: count(raw.modifiers, 15),
      };
    }
    case "wheel":
      return {
        kind: "wheel",
        at: point(raw.at),
        deltaX: finite(raw.deltaX),
        deltaY: finite(raw.deltaY),
        modifiers: count(raw.modifiers, 15),
      };
    case "key": {
      const type = raw.type;
      if (type !== "down" && type !== "up") invalid();
      if (typeof raw.repeat !== "boolean") invalid();
      return {
        kind: "key",
        type,
        key: string(raw.key),
        code: string(raw.code),
        keyCode: count(raw.keyCode, 255),
        location: count(raw.location, 3),
        repeat: raw.repeat,
        modifiers: count(raw.modifiers, 15),
      };
    }
    case "composition": {
      if (typeof raw.text !== "string") invalid();
      if (raw.phase === "commit") {
        return { kind: "composition", phase: "commit", text: raw.text };
      }
      if (raw.phase !== "update") invalid();
      return {
        kind: "composition",
        phase: "update",
        text: raw.text,
        selectionStart: count(raw.selectionStart),
        selectionEnd: count(raw.selectionEnd),
      };
    }
    default:
      invalid();
  }
}

/** The editing command a key press stands for: Cmd with no Ctrl or Alt. */
export function editCommand(input: ScreenInput): EditCommand | undefined {
  if (input.kind !== "key" || input.type !== "down") return undefined;
  if ((input.modifiers & (META | CTRL | ALT)) !== META) return undefined;
  const entry = EDIT_KEYS[input.code];
  if (!entry) return undefined;
  return input.modifiers & SHIFT ? entry.shifted : entry.command;
}

/** The text a key types, as Chrome on a Mac sends it with the key. */
function typedText(input: Extract<ScreenInput, { kind: "key" }>): string | undefined {
  if (input.modifiers & (META | CTRL)) return undefined;
  if (input.key === "Enter") return "\r";
  return [...input.key].length === 1 ? input.key : undefined;
}

function clampToPage(point: Point, at: Fit): Point {
  const inside = (value: number, origin: number, size: number) =>
    Math.min(Math.max(value, origin), origin + (size - 1) * at.scale);
  const x = inside(point.x, at.origin.x, at.viewport.width);
  const y = inside(point.y, at.origin.y, at.viewport.height);
  return toPage({ x, y }, at) ?? { x: 0, y: 0 };
}

const MOUSE_TYPES = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;

/**
 * The calls one renderer event becomes on the page. IME follows the sequence
 * Chrome on a Mac produces: composing keys go down as keyCode 229 with their
 * real key ("Dead" for a dead key), the composition updates in between, the
 * commit is inserted between the selecting key's down and up, and every key
 * comes up with its real code.
 */
export function translate(input: ScreenInput, at: Fit): InputCall[] {
  switch (input.kind) {
    case "mouse": {
      const page = input.type === "up" ? clampToPage(input.at, at) : toPage(input.at, at);
      if (!page) return [];
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: MOUSE_TYPES[input.type],
            x: page.x,
            y: page.y,
            button: input.button,
            buttons: input.buttons,
            clickCount: input.clickCount,
            modifiers: input.modifiers,
          },
        },
      ];
    }
    case "wheel": {
      const page = toPage(input.at, at);
      if (!page) return [];
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseWheel",
            x: page.x,
            y: page.y,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
            modifiers: input.modifiers,
            button: "none",
            buttons: 0,
          },
        },
      ];
    }
    case "key": {
      const common = {
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: input.keyCode,
        modifiers: input.modifiers,
        ...(input.location ? { location: input.location } : {}),
        ...(input.repeat ? { autoRepeat: true } : {}),
      };
      if (input.type === "up") {
        return [{ method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...common } }];
      }
      if (input.keyCode === IME_KEY_CODE) {
        return [{ method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", ...common } }];
      }
      const command = editCommand(input);
      if (command) {
        return [
          {
            method: "Input.dispatchKeyEvent",
            params: {
              type: "rawKeyDown",
              ...common,
              nativeVirtualKeyCode: EDIT_KEYS[input.code]!.native,
              commands: [command],
            },
          },
        ];
      }
      const text = typedText(input);
      return [
        {
          method: "Input.dispatchKeyEvent",
          params: text === undefined
            ? { type: "rawKeyDown", ...common }
            : { type: "keyDown", ...common, text, unmodifiedText: text },
        },
      ];
    }
    case "composition":
      if (input.phase === "update") {
        return [
          {
            method: "Input.imeSetComposition",
            params: {
              text: input.text,
              selectionStart: input.selectionStart,
              selectionEnd: input.selectionEnd,
            },
          },
        ];
      }
      return input.text
        ? [{ method: "Input.insertText", params: { text: input.text } }]
        : [{ method: "Input.imeSetComposition", params: { text: "", selectionStart: 0, selectionEnd: 0 } }];
  }
}
