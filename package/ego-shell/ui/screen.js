// The screen view: draws the selected Apostate tab's screencast and reports the
// human's input in view pixels and DOM terms. Main maps it to the page.
const bridge = window.shellScreen;
const canvas = document.getElementById("frame");
const context = canvas.getContext("2d");
const ime = document.getElementById("ime");
const agentCard = document.getElementById("agent");
const dialog = document.getElementById("dialog");
const dialogMessage = document.getElementById("dialog-message");
const dialogInput = document.getElementById("dialog-input");
const dialogCancel = document.getElementById("dialog-cancel");

const BUTTONS = ["left", "middle", "right", "back", "forward"];
const LINE_PIXELS = 40;
let prompt = null;
let dragging = false;
let drawing = Promise.resolve();

const modifiers = (event) =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
const held = (buttons) => (buttons & 1 ? "left" : buttons & 4 ? "middle" : buttons & 2 ? "right" : "none");
const at = (event) => ({ x: event.clientX, y: event.clientY });
/** Every input but a composition update goes out here, after any held update. */
const send = (payload) => {
  releaseUpdate();
  bridge.input(payload);
};

function reportSize() {
  const dpr = window.devicePixelRatio;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  bridge.resize({ width: window.innerWidth, height: window.innerHeight, dpr });
}

bridge.onFrame(({ seq, jpeg, fit }) => {
  drawing = drawing
    .then(async () => {
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
      const dpr = window.devicePixelRatio;
      context.fillStyle = "#1d1d1f";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        bitmap,
        fit.origin.x * dpr,
        fit.origin.y * dpr,
        fit.viewport.width * fit.scale * dpr,
        fit.viewport.height * fit.scale * dpr,
      );
      bitmap.close();
    })
    .catch(() => {})
    .then(() => bridge.drawn(seq));
});

bridge.onStatus((status) => {
  agentCard.hidden = !(status.spaceId !== null && status.holder === "agent");
  prompt = status.prompt;
  dialog.hidden = !prompt;
  if (!prompt) {
    ime.focus();
    return;
  }
  dialogMessage.textContent = prompt.message;
  dialogInput.hidden = prompt.type !== "prompt";
  dialogInput.value = prompt.defaultPrompt;
  dialogCancel.hidden = prompt.type === "alert";
  (prompt.type === "prompt" ? dialogInput : document.getElementById("dialog-ok")).focus();
});

function mouse(type, event) {
  send({
    kind: "mouse",
    type,
    at: at(event),
    button: type === "move" ? held(event.buttons) : (BUTTONS[event.button] ?? "none"),
    buttons: event.buttons,
    clickCount: type === "move" ? 0 : Math.min(event.detail, 3),
    modifiers: modifiers(event),
  });
}

canvas.addEventListener("mousedown", (event) => {
  event.preventDefault();
  dragging = true;
  ime.style.left = `${event.clientX}px`;
  ime.style.top = `${event.clientY}px`;
  ime.focus();
  mouse("down", event);
});
window.addEventListener("mousemove", (event) => {
  if (event.target === canvas || dragging) mouse("move", event);
});
window.addEventListener("mouseup", (event) => {
  if (event.target !== canvas && !dragging) return;
  dragging = false;
  mouse("up", event);
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? LINE_PIXELS : 1;
    send({
      kind: "wheel",
      at: at(event),
      deltaX: event.deltaX * scale,
      deltaY: event.deltaY * scale,
      modifiers: modifiers(event),
    });
  },
  { passive: false },
);

function key(type, event) {
  send({
    kind: "key",
    type,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    location: event.location,
    repeat: event.repeat,
    modifiers: modifiers(event),
  });
}

// A key the IME takes (keyCode 229) must keep its default, or composition never starts.
ime.addEventListener("keydown", (event) => {
  key("down", event);
  if (event.keyCode !== 229) event.preventDefault();
});
ime.addEventListener("keyup", (event) => key("up", event));
// Committing fires one last compositionupdate in the same task as
// compositionend; the commit already carries that text, so an update is held
// until its task ends and dropped if the composition ended meanwhile.
let heldUpdate = null;
const releaseUpdate = () => {
  if (!heldUpdate) return;
  const update = heldUpdate;
  heldUpdate = null;
  bridge.input(update);
};
ime.addEventListener("compositionupdate", (event) => {
  releaseUpdate();
  heldUpdate = {
    kind: "composition",
    phase: "update",
    text: event.data,
    selectionStart: event.data.length,
    selectionEnd: event.data.length,
  };
  setTimeout(releaseUpdate, 0);
});
ime.addEventListener("compositionend", (event) => {
  heldUpdate = null;
  bridge.input({ kind: "composition", phase: "commit", text: event.data });
  ime.value = "";
});
// Some IME keys insert text with no composition, such as full-width punctuation.
ime.addEventListener("input", (event) => {
  if (event.isComposing) return;
  if (event.inputType === "insertText" && event.data) {
    send({ kind: "composition", phase: "commit", text: event.data });
  }
  ime.value = "";
});

function answer(accept) {
  if (!prompt) return;
  bridge.answer(prompt.type === "prompt" && accept ? { accept, promptText: dialogInput.value } : { accept });
}
dialog.addEventListener("submit", (event) => {
  event.preventDefault();
  answer(true);
});
dialogCancel.addEventListener("click", () => answer(false));
document.getElementById("take-control").addEventListener("click", () => bridge.takeControl());

window.addEventListener("focus", () => {
  if (!prompt) ime.focus();
});
window.addEventListener("resize", reportSize);
reportSize();
ime.focus();
