import { castSize, fit, toPage, type Fit, type Size } from "./screen-geometry.js";
import { editCommand, parseScreenInput, translate, type InputCall, type ScreenInput } from "./screen-input.js";
import type { Frame, HumanPrompt, PromptAnswer, ShellLink } from "./shell-link.js";
import type { Owner } from "./task-space.js";

/** What the Screen needs from the one screen view; main.ts adapts Electron to it. */
export interface ScreenPort {
  frame(seq: number, jpeg: Uint8Array, at: Fit): void;
  /** Blank the view, after any frame sent before. */
  clear(): void;
  status(status: ScreenStatus): void;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): unknown;
  /** The native open panel; no paths when the user cancels. */
  chooseFiles(multiple: boolean): Promise<readonly string[]>;
}

/** Drives the view's overlay: the view-only card and the dialog card. */
export type ScreenStatus = {
  spaceId: number | null;
  holder: Owner | null;
  prompt: Extract<HumanPrompt, { kind: "dialog" }> | null;
};

export type ScreenLink = Pick<
  ShellLink,
  "cast" | "dispatch" | "focusSelectAt" | "selectedText" | "putClipboard"
>;

/** What a selected Apostate space gives the Screen. */
export interface ScreenSource {
  readonly id: number;
  readonly ownership: Owner;
  readonly link: ScreenLink;
  /** The tab on screen; the space calls `retarget` when it changes. */
  shownTargetId(): string | undefined;
}

type Pending = {
  source: ScreenSource;
  prompt: HumanPrompt;
  opened: boolean;
  resolve(answer: PromptAnswer): void;
  reject(error: Error): void;
};

type Cached = { jpeg: Uint8Array; viewport: Size; pageScale: number };

/** Check the view's size report; everything past here trusts it. */
export function parseViewSize(payload: unknown): { view: Size; dpr: number } {
  const { width, height, dpr } = (payload ?? {}) as Record<string, unknown>;
  const valid = (value: unknown, min: number): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= min;
  if (!valid(width, 0) || !valid(height, 0) || !valid(dpr, 0.1)) {
    throw new Error("Invalid view size");
  }
  return { view: { width, height }, dpr };
}

/** Check the human's answer to a dialog card. */
export function parseDialogAnswer(payload: unknown): PromptAnswer {
  const { accept, promptText } = (payload ?? {}) as Record<string, unknown>;
  if (typeof accept !== "boolean") throw new Error("Invalid dialog answer");
  if (promptText === undefined) return { kind: "dialog", accept };
  if (typeof promptText !== "string") throw new Error("Invalid dialog answer");
  return { kind: "dialog", accept, promptText };
}

/** Tabs whose last frame is kept to draw at once when they come back. */
const CACHED_TABS = 16;

/**
 * The controller of the one screen view. It shows at most one space and casts
 * only that space's active tab; every other Apostate space casts nothing and
 * keeps running for agents.
 *
 * Every show, retarget and resize recomputes the cast it wants. A monotonic
 * epoch makes the last call win: a frame of an older cast is dropped, and a
 * cast that started after it was superseded stops itself. At most one frame is
 * in flight; it is acknowledged once the view has drawn it.
 *
 * Input reaches a page only while the user holds its space. While an agent
 * holds it the view is view-only, so every page has one input source at a time
 * and the user's dialogs never race an agent's.
 */
export class Screen {
  readonly #port: ScreenPort;
  #view: Size = { width: 0, height: 0 };
  #dpr = 1;
  #source: ScreenSource | null = null;
  #castKey: string | null = null;
  #epoch = 0;
  #stop: (() => Promise<void>) | null = null;
  #transitions: Promise<void> = Promise.resolve();
  #seq = 0;
  #inFlight: { seq: number; ack(): void } | null = null;
  #fit: Fit | null = null;
  readonly #frames = new Map<string, Cached>();
  #inputs: Promise<void> = Promise.resolve();
  #swallowRelease = false;
  /** Keys and buttons the human holds down in one tab, to release when input leaves it. */
  #held: Held | null = null;
  readonly #prompts: Pending[] = [];
  /** The text each kernel's clipboard holds, as far as the shell knows. */
  readonly #kernelClipboard = new WeakMap<ScreenLink, string>();

  constructor(port: ScreenPort) {
    this.#port = port;
  }

  /** The space is selected. Idempotent. */
  show(source: ScreenSource): void {
    if (this.#source !== source) this.#releaseHeld();
    this.#source = source;
    this.#refresh();
  }

  /** The space stopped being selected; ignored unless it is the one shown. */
  hide(source: ScreenSource): void {
    if (this.#source !== source) return;
    this.#releaseHeld();
    this.#source = null;
    this.#refresh();
  }

  /** The source's active tab or holder changed. */
  retarget(source: ScreenSource): void {
    if (source.ownership !== "user") this.#drop(source);
    if (this.#source === source) {
      if (source.ownership !== "user" || source.shownTargetId() !== this.#held?.targetId) {
        this.#releaseHeld();
      }
      this.#refresh();
    }
  }

  /** The view's size in CSS pixels and its device scale. */
  resize(view: Size, dpr: number): void {
    this.#view = view;
    this.#dpr = dpr;
    this.#refresh();
  }

  /** The view drew frame `seq`; let Chromium send the next. */
  drawn(seq: number): void {
    if (this.#inFlight?.seq !== seq) return;
    this.#inFlight.ack();
    this.#inFlight = null;
  }

  /** One raw payload from the view, forwarded in arrival order. */
  receive(payload: unknown): void {
    let input: ScreenInput;
    try {
      input = parseScreenInput(payload);
    } catch {
      return;
    }
    const source = this.#source;
    const targetId = source?.shownTargetId();
    const at = this.#fit;
    if (!source || !targetId || !at || source.ownership !== "user") return;
    // Ownership and selection can change while earlier input is still on the wire.
    const live = () =>
      this.#source === source &&
      source.ownership === "user" &&
      source.shownTargetId() === targetId;
    this.#inputs = this.#inputs
      .then(() => (live() ? this.#forward(source.link, targetId, input, at, live) : undefined))
      .catch(() => {});
  }

  /** Put a dialog or file chooser of a user-held space to the human. */
  ask(source: ScreenSource, prompt: HumanPrompt): Promise<PromptAnswer> {
    return new Promise((resolve, reject) => {
      this.#prompts.push({ source, prompt, opened: false, resolve, reject });
      this.#nextPrompt();
    });
  }

  /** The human's answer to the dialog shown in the status. */
  answer(answer: PromptAnswer): void {
    const head = this.#shownPrompt();
    if (!head || head.prompt.kind !== "dialog" || answer.kind !== "dialog") return;
    this.#prompts.splice(this.#prompts.indexOf(head), 1);
    head.resolve(answer);
    this.#nextPrompt();
  }

  #refresh(): void {
    this.#sync();
    this.#nextPrompt();
  }

  /** Make the running cast the one the current state wants. */
  #sync(): void {
    const source = this.#source;
    const targetId = source?.shownTargetId();
    const size = castSize(this.#view, this.#dpr);
    const key =
      source && targetId && this.#view.width > 0 && this.#view.height > 0
        ? `${source.id} ${targetId} ${size.maxWidth}x${size.maxHeight}`
        : null;
    if (key === this.#castKey) return;
    this.#castKey = key;
    const epoch = ++this.#epoch;
    this.#inFlight = null;
    this.#fit = null;
    const cached = targetId === undefined ? undefined : this.#frames.get(targetId);
    // Nothing of the space shown before may stay up under another.
    if (key && cached) this.#paint(cached);
    else this.#port.clear();
    const previous = this.#stop;
    this.#stop = null;
    this.#transitions = this.#transitions.then(async () => {
      await previous?.();
      if (!key || !source || !targetId || epoch !== this.#epoch) return;
      const stop = await source.link
        .cast(targetId, size, (frame) => this.#onFrame(epoch, targetId, frame))
        .catch(() => null);
      if (epoch === this.#epoch) this.#stop = stop;
      else await stop?.();
    });
  }

  #onFrame(epoch: number, targetId: string, frame: Frame): void {
    if (epoch !== this.#epoch) return;
    const cached = { jpeg: frame.jpeg, viewport: frame.viewport, pageScale: frame.pageScale };
    this.#frames.delete(targetId);
    this.#frames.set(targetId, cached);
    if (this.#frames.size > CACHED_TABS) {
      this.#frames.delete(this.#frames.keys().next().value!);
    }
    const seq = this.#paint(cached);
    this.#inFlight = { seq, ack: frame.ack };
  }

  #paint(frame: Cached): number {
    const seq = ++this.#seq;
    this.#fit = fit(this.#view, frame.viewport, frame.pageScale);
    this.#port.frame(seq, frame.jpeg, this.#fit);
    return seq;
  }

  async #forward(
    link: ScreenLink,
    targetId: string,
    input: ScreenInput,
    at: Fit,
    live: () => boolean,
  ): Promise<void> {
    const press = pressOf(input);
    if (press && input.kind !== "wheel" && input.kind !== "composition" && input.type === "up") {
      // A release goes only where its press went.
      const held = this.#held;
      if (!held || held.link !== link || held.targetId !== targetId || !held.down.has(press)) {
        if (input.kind === "mouse") this.#swallowRelease = false;
        return;
      }
      held.down.delete(press);
    }
    if (input.kind === "mouse" && input.button === "left") {
      if (input.type === "down") {
        const page = toPage(input.at, at);
        if (page && (await link.focusSelectAt(targetId, page.x, page.y))) {
          this.#swallowRelease = true;
          return;
        }
      } else if (input.type === "up" && this.#swallowRelease) {
        this.#swallowRelease = false;
        return;
      }
    }
    const command = editCommand(input);
    if (command === "copy" || command === "cut") {
      const text = await link.selectedText(targetId).catch(() => "");
      if (!live()) return;
      this.#noteDown(link, targetId, input, press);
      await link.dispatch(targetId, translate(input, at));
      if (text) {
        this.#port.writeClipboard(text);
        this.#kernelClipboard.set(link, text);
      }
      return;
    }
    // A kernel's own copy also holds the HTML a page pastes; the host copy is
    // text only, so it replaces the kernel's only when the host has moved on.
    let calls = translate(input, at);
    if (command === "paste") {
      const text = await this.#port.readClipboard();
      if (!text) {
        // The host holds an image or files, which a text field does not take,
        // and Chromium cannot empty its clipboard: send the keys alone.
        calls = calls.map(({ method, params }) => {
          const { commands: _, ...rest } = params;
          return { method, params: rest };
        }) satisfies InputCall[];
      } else if (this.#kernelClipboard.get(link) !== text) {
        await link.putClipboard(targetId, text).catch(() => {});
        this.#kernelClipboard.set(link, text);
      }
    }
    if (!live()) return;
    this.#noteDown(link, targetId, input, press);
    await link.dispatch(targetId, calls);
  }

  #noteDown(link: ScreenLink, targetId: string, input: ScreenInput, press: string | null): void {
    if (!press || input.kind === "wheel" || input.kind === "composition" || input.type !== "down") return;
    if (this.#held?.link !== link || this.#held.targetId !== targetId) {
      this.#releaseHeld();
      this.#held = { link, targetId, at: this.#fit, down: new Map() };
    }
    this.#held.down.set(press, input);
  }

  /** Send the tab the human leaves a release for everything still held down in it. */
  #releaseHeld(): void {
    const held = this.#held;
    this.#held = null;
    this.#swallowRelease = false;
    if (!held || held.down.size === 0 || !held.at) return;
    const at = held.at;
    const releases = [...held.down.values()].reverse().map(release);
    this.#inputs = this.#inputs
      .then(async () => {
        for (const input of releases) await held.link.dispatch(held.targetId, translate(input, at));
      })
      .catch(() => {});
  }

  #shownPrompt(): Pending | undefined {
    return this.#prompts.find((pending) => pending.source === this.#source);
  }

  #nextPrompt(): void {
    const head = this.#shownPrompt();
    if (head?.prompt.kind === "files" && !head.opened) {
      head.opened = true;
      this.#port.chooseFiles(head.prompt.multiple).then(
        (paths) => this.#settle(head, { kind: "files", paths }),
        () => this.#settle(head, { kind: "files", paths: [] }),
      );
    }
    const source = this.#source;
    this.#port.status({
      spaceId: source?.id ?? null,
      holder: source?.ownership ?? null,
      prompt: head?.prompt.kind === "dialog" ? head.prompt : null,
    });
  }

  #settle(pending: Pending, answer: PromptAnswer): void {
    const index = this.#prompts.indexOf(pending);
    if (index < 0) return;
    this.#prompts.splice(index, 1);
    pending.resolve(answer);
    this.#nextPrompt();
  }

  /** The space left the user's hands: its prompts are the agent's now. */
  #drop(source: ScreenSource): void {
    for (const pending of [...this.#prompts]) {
      if (pending.source !== source) continue;
      this.#prompts.splice(this.#prompts.indexOf(pending), 1);
      pending.reject(new Error("The space is no longer held by the user"));
    }
  }
}

type Held = {
  link: ScreenLink;
  targetId: string;
  at: Fit | null;
  down: Map<string, ScreenInput>;
};

/** What a down and its up have in common; null for input that is never held. */
function pressOf(input: ScreenInput): string | null {
  if (input.kind === "mouse" && input.type !== "move") return `mouse ${input.button}`;
  if (input.kind === "key") return `key ${input.code || input.key}`;
  return null;
}

/** The release of a held key or button. */
function release(input: ScreenInput): ScreenInput {
  if (input.kind === "mouse") return { ...input, type: "up", buttons: 0 };
  if (input.kind === "key") return { ...input, type: "up", repeat: false, modifiers: 0 };
  return input;
}
