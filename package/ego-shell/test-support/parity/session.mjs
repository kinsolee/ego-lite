// The scripted human session, as data. driver.mjs turns each step into the
// CDP Input calls the shell forwards from the screencast view.

const FRAME_STEPS = (frame) => [
  { do: "move", to: "btn", frame },
  { do: "click", button: "left" },
  { do: "move", to: "dbl", frame },
  { do: "click", button: "left", count: 2 },
  { do: "move", to: "ctx", frame },
  { do: "click", button: "right" },
  { do: "move", to: "scroller", frame },
  { do: "wheel", deltaY: 120 },
  { do: "wheel", deltaY: 120 },
  { do: "wheel", deltaY: -60 },
  { do: "move", to: "txt", frame },
  { do: "click", button: "left" },
  { do: "type", text: "Hello 42 ação já é" },
  { do: "move", to: "ime", frame },
  { do: "click", button: "left" },
  { do: "ime", keys: "nihao", commit: "你好" },
  { do: "move", to: "clipA", frame },
  { do: "click", button: "left" },
  { do: "shortcut", key: "a" },
  { do: "shortcut", key: "c" },
  { do: "move", to: "clipB", frame },
  { do: "click", button: "left" },
  { do: "shortcut", key: "v" },
  { do: "move", to: "ce", frame },
  { do: "click", button: "left" },
  { do: "shortcut", key: "a" },
  { do: "shortcut", key: "x" },
  { do: "move", to: "clipB", frame },
  { do: "click", button: "left" },
  { do: "shortcut", key: "v" },
  { do: "key", name: "Tab" },
  { do: "key", name: "Tab" },
  { do: "move", to: "sel", frame },
  { do: "focusSelect", id: "sel", frame },
  { do: "typeAhead", char: "b" },
];

export const SESSION = [...FRAME_STEPS("main"), ...FRAME_STEPS("iframe")];

/**
 * What every frame must end with when the session really played. Two empty
 * logs would otherwise compare equal.
 */
export const EXPECTED = {
  fields: { txt: "Hello 42 ação já é", ime: "你好", clipA: "Pedido número 42", clipB: "Pedido número 42Olá mundo", ce: "", sel: "b" },
  events: ["click #btn", "dblclick #dbl", "contextmenu #ctx", "wheel DIV", "compositionend #ime", "copy #clipA", "cut #ce", "paste #clipB", "change #sel"],
};

/**
 * Milliseconds the driver waits between mouse moves, while a key or button is
 * held, between keys, and between steps. A hand never releases a key in the
 * same millisecond it pressed it; without the hold, keyup races the
 * selectionchange the keydown queued. The timing buckets in diff.mjs sit well
 * between these.
 */
export const PAUSE = { move: 20, hold: 40, key: 50, step: 200 };
