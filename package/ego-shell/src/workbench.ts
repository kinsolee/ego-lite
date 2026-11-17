import {
  EMPTY_SELECTION,
  reconcile,
  select,
  type Selection,
  type SpaceId,
} from "./selection.js";
import type { ChromeCommand, Owner, SpaceState } from "./task-space.js";

/** Device-independent rectangle of the content area, measured by the UI page. */
export type ContentRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Where the UI page's content area is. `covered` is true while an overlay of
 * the page, such as the profile editor, must sit above the web content.
 */
export type LayoutReport = { rect: ContentRect; covered: boolean };

/**
 * A space's slot in the main window's content area, handed out once per space.
 * Every method is idempotent and does nothing once the space is gone.
 */
export interface Stage<V = unknown> {
  /** Attach a view the space owns, sized to the content area, under the shown one. */
  place(view: V): void;
  /** Detach a view whose tab closed. */
  remove(view: V): void;
  /** The view to show while this space is selected; null shows the UI page. */
  front(view: V | null): void;
  /** Told true when the space is selected or picked again, false when it stops being selected. */
  onSelected(listener: (selected: boolean) => void): void;
}

export interface Stages<V = unknown> {
  stageFor(spaceId: SpaceId): Stage<V>;
}

/** The window operations the Workbench needs; the last view added or raised is on top. */
export interface WindowPort<V> {
  add(view: V): void;
  raise(view: V): void;
  remove(view: V): void;
  setBounds(view: V, rect: ContentRect): void;
  focus(view: V): void;
  contentSize(): { width: number; height: number };
  /** Show and focus the window. */
  reveal(): void;
}

/** What the Workbench reads from an open space. A `TaskSpace` is one. */
export type WorkbenchSpace = {
  readonly id: SpaceId;
  readonly createdBy: Owner;
  readonly ownership: Owner;
  readonly profile: { readonly id: string };
  state(): SpaceState;
};

/** The open spaces, in sidebar order. `TaskSpaces` is one. */
export type SpaceList = {
  list(): readonly WorkbenchSpace[];
  get(id: SpaceId): WorkbenchSpace | undefined;
};

/** Pushed to the UI page, which renders the selection from it alone. */
export type WorkbenchState = {
  selected: SpaceId | null;
  /** Toolbar state of the selected space. */
  space: SpaceState | null;
  unseen: SpaceId[];
};

type Slot<V> = {
  views: Set<V>;
  front: V | null;
  listeners: Set<(selected: boolean) => void>;
  alive: boolean;
};

/**
 * Owns the main window, the selection, and every view in its content area.
 *
 * Every placed view stays attached, visible and sized to the content area, so
 * an unselected space keeps rendering for agents that screenshot and click it.
 * What the user sees is decided by z-order alone, in one place:
 *   on top = covered || no front view of the selected space ? UI page : that front view
 */
export class Workbench<V> implements Stages<V> {
  readonly #window: WindowPort<V>;
  readonly #ui: V;
  readonly #spaces: SpaceList;
  readonly #push: (state: WorkbenchState) => void;
  readonly #slots = new Map<SpaceId, Slot<V>>();
  #selection: Selection = EMPTY_SELECTION;
  #rect: ContentRect | null = null;
  #covered = false;
  #top: V | null = null;
  #flushing = false;

  constructor(options: {
    window: WindowPort<V>;
    /** The UI page's view, filling the whole window. */
    ui: V;
    spaces: SpaceList;
    push: (state: WorkbenchState) => void;
  }) {
    this.#window = options.window;
    this.#ui = options.ui;
    this.#spaces = options.spaces;
    this.#push = options.push;
  }

  stageFor(spaceId: SpaceId): Stage<V> {
    let slot = this.#slots.get(spaceId);
    if (!slot) {
      slot = { views: new Set(), front: null, listeners: new Set(), alive: true };
      this.#slots.set(spaceId, slot);
    }
    const live = slot;
    return {
      place: (view) => {
        if (!live.alive || live.views.has(view)) return;
        live.views.add(view);
        this.#window.add(view);
        this.#window.setBounds(view, this.#contentRect());
        this.#top = view;
        this.#showTop();
      },
      remove: (view) => {
        if (!live.alive || !live.views.delete(view)) return;
        if (live.front === view) live.front = null;
        this.#window.remove(view);
        if (this.#top === view) this.#top = null;
        this.#showTop();
      },
      front: (view) => {
        if (!live.alive) return;
        if (view !== null && !live.views.has(view)) return;
        live.front = view;
        this.#showTop();
      },
      onSelected: (listener) => {
        if (!live.alive) return;
        live.listeners.add(listener);
        listener(this.#selection.selected === spaceId);
      },
    };
  }

  /** The spaces changed. Many calls in one tick are handled once. */
  changed(): void {
    if (this.#flushing) return;
    this.#flushing = true;
    queueMicrotask(() => {
      this.#flushing = false;
      this.#reconcile();
      this.#push(this.#state());
    });
  }

  /** The user picked a space: show it and give it the keyboard. */
  select(spaceId: SpaceId): void {
    this.#reconcile();
    const previous = this.#selection.selected;
    this.#selection = select(this.#selection, spaceId);
    const { selected } = this.#selection;
    if (selected !== spaceId) return;
    if (previous !== null && previous !== spaceId) this.#notify(previous, false);
    this.#notify(spaceId, true);
    this.#showTop();
    this.#window.focus(this.#wantedTop());
    this.#push(this.#state());
  }

  layout(report: LayoutReport): void {
    this.#rect = report.rect;
    this.#covered = report.covered;
    for (const slot of this.#slots.values()) {
      for (const view of slot.views) this.#window.setBounds(view, report.rect);
    }
    this.#showTop();
  }

  reveal(): void {
    this.#window.reveal();
  }

  #reconcile(): void {
    const previous = this.#selection;
    this.#selection = reconcile(previous, this.#refs());
    const { selected } = this.#selection;
    const moved = selected !== previous.selected;
    // A closed space still has its listeners until its slot goes below.
    if (moved && previous.selected !== null) this.#notify(previous.selected, false);
    const alive = new Set(this.#selection.order.map((space) => space.id));
    for (const { id } of previous.order) {
      const slot = this.#slots.get(id);
      if (!slot || alive.has(id)) continue;
      slot.alive = false;
      for (const view of slot.views) this.#window.remove(view);
      if (slot.views.has(this.#top as V)) this.#top = null;
      slot.views.clear();
      this.#slots.delete(id);
    }
    if (moved && selected !== null) this.#notify(selected, true);
    this.#showTop();
  }

  #refs() {
    return this.#spaces.list().map((space) => ({
      id: space.id,
      profileId: space.profile.id,
      createdBy: space.createdBy,
      ownership: space.ownership,
    }));
  }

  #notify(spaceId: SpaceId, selected: boolean): void {
    for (const listener of this.#slots.get(spaceId)?.listeners ?? []) {
      listener(selected);
    }
  }

  #wantedTop(): V {
    const { selected } = this.#selection;
    const front =
      selected === null ? null : (this.#slots.get(selected)?.front ?? null);
    return this.#covered || front === null ? this.#ui : front;
  }

  #showTop(): void {
    const top = this.#wantedTop();
    if (top === this.#top) return;
    this.#window.raise(top);
    this.#top = top;
  }

  #contentRect(): ContentRect {
    if (this.#rect) return this.#rect;
    const { width, height } = this.#window.contentSize();
    return { x: 0, y: 0, width, height };
  }

  #state(): WorkbenchState {
    const { selected, unseen } = this.#selection;
    return {
      selected,
      space:
        selected === null ? null : (this.#spaces.get(selected)?.state() ?? null),
      unseen: [...unseen],
    };
  }
}

function pixels(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid layout");
  }
  return Math.round(value);
}

/** Check the UI page's layout report; everything past here trusts it. */
export function parseLayout(payload: unknown): LayoutReport {
  const rect = (payload as { rect?: Record<string, unknown> } | null)?.rect;
  if (!rect || typeof rect !== "object") throw new Error("Invalid layout");
  return {
    rect: {
      x: pixels(rect.x),
      y: pixels(rect.y),
      width: pixels(rect.width),
      height: pixels(rect.height),
    },
    covered: (payload as { covered?: unknown }).covered === true,
  };
}

export type CommandEnvelope = { spaceId: SpaceId; command: ChromeCommand };

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid command");
  return value;
}

/** Check a toolbar command from the UI page and the space it was rendered for. */
export function parseCommandEnvelope(payload: unknown): CommandEnvelope {
  const { spaceId, command } = (payload ?? {}) as {
    spaceId?: unknown;
    command?: { type?: unknown; targetId?: unknown; url?: unknown };
  };
  if (!Number.isInteger(spaceId) || !command) throw new Error("Invalid command");
  const id = spaceId as number;
  switch (command.type) {
    case "newTab":
    case "back":
    case "forward":
    case "reload":
    case "takeControl":
      return { spaceId: id, command: { type: command.type } };
    case "closeTab":
    case "activateTab":
      return {
        spaceId: id,
        command: { type: command.type, targetId: text(command.targetId) },
      };
    case "navigate":
      return { spaceId: id, command: { type: "navigate", url: text(command.url) } };
    default:
      throw new Error("Invalid command");
  }
}
