import { CdpConnection, type CdpEvent } from "./browser-cdp.js";
import type { WindowBounds } from "./screen-geometry.js";
import type { InputCall } from "./screen-input.js";

/**
 * A session that exists only on a ShellLink socket. The brand keeps it out of
 * everything that routes agent traffic, which takes plain string ids.
 */
export type ShellSessionId = string & { readonly __shellSession: unique symbol };

/** One decoded screencast frame. */
export type Frame = {
  jpeg: Uint8Array;
  /** The page's viewport in CSS pixels. */
  viewport: { width: number; height: number };
  pageScale: number;
  /** Chromium sends the next frame only after this. */
  ack(): void;
};

/** A JS dialog or file chooser the human answers while holding the space. */
export type HumanPrompt =
  | {
      kind: "dialog";
      type: "alert" | "confirm" | "prompt" | "beforeunload";
      message: string;
      defaultPrompt: string;
    }
  | { kind: "files"; multiple: boolean };

export type PromptAnswer =
  | { kind: "dialog"; accept: boolean; promptText?: string }
  /** No paths cancels the chooser. */
  | { kind: "files"; paths: readonly string[] };

export type Asker = (prompt: HumanPrompt) => Promise<PromptAnswer>;

type Listener = (method: string, params: any) => void;

type PageSession = {
  id: ShellSessionId;
  /** Out-of-process frames below the page, in the order they attached. */
  frames: ShellSessionId[];
  answering: Listener | undefined;
};

const OPEN_POLL_MS = 40;
const SCREENCAST_QUALITY = 80;
const DIALOG_TYPES = new Set(["alert", "confirm", "prompt", "beforeunload"]);

/** In the frame's isolated world: the text a Cmd+C there would copy. */
const SELECTED_TEXT = `(() => {
  let doc = document;
  for (;;) {
    const active = doc.activeElement;
    let inner = null;
    try { inner = active && active.tagName === "IFRAME" ? active.contentDocument : null; } catch {}
    if (inner) { doc = inner; continue; }
    if (active && typeof active.value === "string" && typeof active.selectionStart === "number") {
      return active.value.slice(active.selectionStart, active.selectionEnd);
    }
    return String(doc.getSelection() ?? "");
  }
})()`;

const AVAIL_AREA =
  "({left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight})";

/**
 * The shell's own link to one Apostate process: a second browser-level
 * websocket beside the one agents are routed over. Chromium sends a flat
 * session's events only to the socket that attached it, so nothing done here
 * (screencast, the human's input, clipboard, the user's dialogs, window
 * placement, opening tabs) ever reaches an agent, and an agent stopping its
 * own screencast cannot stop the shell's.
 *
 * Every method takes a page's targetId; its session is opened on first use
 * and kept until `forget`. Calls for a target that just closed reject.
 */
export class ShellLink {
  readonly closed: Promise<void>;
  readonly #connection: CdpConnection;
  readonly #pages = new Map<string, Promise<PageSession>>();
  readonly #listeners = new Map<ShellSessionId, Set<Listener>>();

  private constructor(connection: CdpConnection) {
    this.#connection = connection;
    this.closed = connection.closed;
  }

  static async connect(endpoint: string, commandTimeoutMs?: number): Promise<ShellLink> {
    let link: ShellLink | undefined;
    const connection = await CdpConnection.connect(
      endpoint,
      (event) => {
        if (link) link.#handle(event);
      },
      commandTimeoutMs,
    );
    link = new ShellLink(connection);
    return link;
  }

  /**
   * Open a tab in the window of `anchorTargetId`: the anchor's isolated world
   * opens an empty noopener window, which Chromium puts beside the anchor,
   * then the tab is sent to `url` as if typed and its history cleared. The
   * page reads `opener === null` and `history.length === 1`. Resolves with
   * the new target once it has committed `url`.
   */
  async openIn(anchorTargetId: string, url: string): Promise<string> {
    const before = new Set(await this.#targetIds());
    const anchor = await this.#attach(anchorTargetId);
    try {
      const context = await this.#isolatedWorld(anchor);
      await this.#send("Runtime.evaluate", {
        contextId: context,
        userGesture: true,
        expression: "void window.open('', '_blank', 'noopener,noreferrer')",
      }, anchor);
    } finally {
      this.#detach(anchor);
    }
    const targetId = await this.#newPage(before);
    const session = await this.#attach(targetId);
    try {
      await this.#send("Page.enable", {}, session);
      const committed = this.#next(session, "Page.frameNavigated", (params) => !params.frame?.parentId);
      await this.#send("Page.navigate", { url, transitionType: "typed" }, session);
      await committed;
      await this.#send("Page.resetNavigationHistory", {}, session);
      await this.#send("Page.disable", {}, session);
    } finally {
      this.#detach(session);
    }
    return targetId;
  }

  /** Where the tab is in its history, which Chromium does not announce. */
  async history(targetId: string): Promise<{ currentIndex: number; entryIds: number[] }> {
    const { id } = await this.#page(targetId);
    const { currentIndex, entries } = await this.#send("Page.getNavigationHistory", {}, id);
    if (!Number.isInteger(currentIndex) || !Array.isArray(entries)) {
      throw new Error("The tab has no history to read");
    }
    return { currentIndex, entryIds: entries.map((entry: { id: number }) => entry.id) };
  }

  /** `screen.avail*` as the page reads it. */
  async availArea(targetId: string): Promise<WindowBounds> {
    const { id } = await this.#page(targetId);
    return this.#evaluate(id, AVAIL_AREA);
  }

  async placeWindow(targetId: string, bounds: WindowBounds): Promise<void> {
    const { windowId } = await this.#send("Browser.getWindowForTarget", { targetId });
    await this.#send("Browser.setWindowBounds", { windowId, bounds });
  }

  /**
   * Cast the tab. `onFrame` gets one frame at a time; Chromium holds the next
   * until that frame's `ack`. The returned stop is idempotent and never throws.
   */
  async cast(
    targetId: string,
    size: { maxWidth: number; maxHeight: number },
    onFrame: (frame: Frame) => void,
  ): Promise<() => Promise<void>> {
    const { id } = await this.#page(targetId);
    let stopped = false;
    const listener: Listener = (method, params) => {
      if (stopped || method !== "Page.screencastFrame") return;
      const { metadata } = params;
      onFrame({
        jpeg: Buffer.from(params.data, "base64"),
        viewport: { width: metadata.deviceWidth, height: metadata.deviceHeight },
        pageScale: metadata.pageScaleFactor || 1,
        ack: () => {
          if (stopped) return;
          this.#send("Page.screencastFrameAck", { sessionId: params.sessionId }, id).catch(() => {});
        },
      });
    };
    this.#listen(id, listener);
    try {
      await this.#send("Page.startScreencast", {
        format: "jpeg",
        quality: SCREENCAST_QUALITY,
        ...size,
        everyNthFrame: 1,
      }, id);
    } catch (error) {
      this.#unlisten(id, listener);
      throw error;
    }
    return async () => {
      if (stopped) return;
      stopped = true;
      this.#unlisten(id, listener);
      await this.#send("Page.stopScreencast", {}, id).catch(() => {});
    };
  }

  /** Send the calls in order; stops at the first failure. */
  async dispatch(targetId: string, calls: readonly InputCall[]): Promise<void> {
    const { id } = await this.#page(targetId);
    for (const call of calls) await this.#send(call.method, call.params, id);
  }

  /**
   * When a closed <select> is at the page point, focus it and say so. A
   * headless kernel opens its list where the screencast cannot show it, and
   * keys sent while it is open hang later mouse input; the focused select
   * still takes type-ahead keys.
   */
  async focusSelectAt(targetId: string, x: number, y: number): Promise<boolean> {
    const { id } = await this.#page(targetId);
    const { backendNodeId } = await this.#send("DOM.getNodeForLocation", {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: true,
    }, id);
    const { node } = await this.#send("DOM.describeNode", { backendNodeId }, id);
    if (node?.nodeName !== "SELECT") return false;
    await this.#send("DOM.focus", { backendNodeId }, id);
    return true;
  }

  /**
   * What Cmd+C or Cmd+X would copy, read before the key is sent (a cut
   * removes it). The kernel's clipboard is not the host's, so the shell
   * copies the text over itself; the page is never granted clipboard access.
   */
  async selectedText(targetId: string): Promise<string> {
    const session = await this.#focusedFrame(targetId);
    const text = await this.#evaluate(session, SELECTED_TEXT);
    return typeof text === "string" ? text : "";
  }

  /** Put host text on the kernel's clipboard, ahead of a Cmd+V. */
  async putClipboard(targetId: string, text: string): Promise<void> {
    const session = await this.#focusedFrame(targetId);
    await this.#evaluate(
      session,
      `navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => "ok")`,
      { userGesture: true, awaitPromise: true },
    );
  }

  /**
   * While `ask` is set, the tab's JS dialogs and file choosers go to it and
   * its answer goes back on the shell's session. Null releases both, so an
   * agent's own handling is the only one left.
   */
  async answerFor(targetId: string, ask: Asker | null): Promise<void> {
    const page = await this.#page(targetId);
    if (page.answering) this.#unlisten(page.id, page.answering);
    page.answering = undefined;
    if (!ask) {
      await this.#send("Page.setInterceptFileChooserDialog", { enabled: false }, page.id);
      await this.#send("Page.disable", {}, page.id);
      return;
    }
    const answering: Listener = (method, params) => {
      if (method === "Page.javascriptDialogOpening" && DIALOG_TYPES.has(params.type)) {
        void ask({
          kind: "dialog",
          type: params.type,
          message: String(params.message ?? ""),
          defaultPrompt: String(params.defaultPrompt ?? ""),
        })
          .then((answer) => {
            if (answer.kind !== "dialog" || page.answering !== answering) return;
            return this.#send("Page.handleJavaScriptDialog", {
              accept: answer.accept,
              ...(answer.promptText !== undefined ? { promptText: answer.promptText } : {}),
            }, page.id);
          })
          .catch(() => {});
      } else if (method === "Page.fileChooserOpened") {
        void ask({ kind: "files", multiple: params.mode === "selectMultiple" })
          .then((answer) => {
            if (answer.kind !== "files" || answer.paths.length === 0) return;
            if (page.answering !== answering) return;
            return this.#send("DOM.setFileInputFiles", {
              files: [...answer.paths],
              backendNodeId: params.backendNodeId,
            }, page.id);
          })
          .catch(() => {});
      }
    };
    page.answering = answering;
    this.#listen(page.id, answering);
    await this.#send("Page.enable", {}, page.id);
    await this.#send("Page.setInterceptFileChooserDialog", { enabled: true }, page.id);
  }

  /** The target closed: drop its session. */
  forget(targetId: string): void {
    const page = this.#pages.get(targetId);
    this.#pages.delete(targetId);
    void page?.then(
      (session) => {
        this.#listeners.delete(session.id);
        for (const frame of session.frames) this.#listeners.delete(frame);
      },
      () => {},
    );
  }

  close(): void {
    this.#connection.close();
  }

  #handle({ method, params, sessionId }: CdpEvent): void {
    if (!sessionId) return;
    for (const listener of this.#listeners.get(sessionId as ShellSessionId) ?? []) {
      listener(method, params);
    }
  }

  #send(method: string, params: Record<string, unknown>, sessionId?: ShellSessionId): Promise<any> {
    return this.#connection.send(method, params, sessionId);
  }

  #listen(sessionId: ShellSessionId, listener: Listener): void {
    let set = this.#listeners.get(sessionId);
    if (!set) this.#listeners.set(sessionId, (set = new Set()));
    set.add(listener);
  }

  #unlisten(sessionId: ShellSessionId, listener: Listener): void {
    this.#listeners.get(sessionId)?.delete(listener);
  }

  /** The next event of a kind on a session, bounded by the command timeout. */
  #next(sessionId: ShellSessionId, event: string, matches: (params: any) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#unlisten(sessionId, listener);
        reject(new Error(`The new tab did not load: no ${event}`));
      }, 30_000);
      const listener: Listener = (method, params) => {
        if (method !== event || !matches(params)) return;
        clearTimeout(timer);
        this.#unlisten(sessionId, listener);
        resolve();
      };
      this.#listen(sessionId, listener);
    });
  }

  async #attach(targetId: string): Promise<ShellSessionId> {
    const { sessionId } = await this.#send("Target.attachToTarget", { targetId, flatten: true });
    return sessionId as ShellSessionId;
  }

  #detach(sessionId: ShellSessionId): void {
    this.#listeners.delete(sessionId);
    this.#send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }

  async #targetIds(): Promise<string[]> {
    const { targetInfos } = await this.#send("Target.getTargets", {});
    return (targetInfos as { targetId: string; type: string }[])
      .filter((info) => info.type === "page")
      .map((info) => info.targetId);
  }

  async #newPage(before: Set<string>): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const created = (await this.#targetIds()).find((id) => !before.has(id));
      if (created) return created;
      await new Promise((resolve) => setTimeout(resolve, OPEN_POLL_MS));
    }
    throw new Error("The new tab did not open");
  }

  #page(targetId: string): Promise<PageSession> {
    let page = this.#pages.get(targetId);
    if (!page) {
      page = this.#openPage(targetId);
      this.#pages.set(targetId, page);
      page.catch(() => {
        if (this.#pages.get(targetId) === page) this.#pages.delete(targetId);
      });
    }
    return page;
  }

  async #openPage(targetId: string): Promise<PageSession> {
    const id = await this.#attach(targetId);
    const page: PageSession = { id, frames: [], answering: undefined };
    this.#watchFrames(page, id);
    return page;
  }

  /** Out-of-process frames get sessions of their own, for copy and paste in them. */
  #watchFrames(page: PageSession, sessionId: ShellSessionId): void {
    this.#listen(sessionId, (method, params) => {
      if (method === "Target.attachedToTarget") {
        const child = params.sessionId as ShellSessionId;
        page.frames.push(child);
        this.#watchFrames(page, child);
      } else if (method === "Target.detachedFromTarget") {
        page.frames = page.frames.filter((frame) => frame !== params.sessionId);
        this.#listeners.delete(params.sessionId);
      }
    });
    this.#send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe" }],
    }, sessionId).catch(() => {});
  }

  /** The deepest frame whose document has focus, the page itself otherwise. */
  async #focusedFrame(targetId: string): Promise<ShellSessionId> {
    const page = await this.#page(targetId);
    const focused = await Promise.all(
      page.frames.map((frame) =>
        this.#evaluate(frame, "document.hasFocus()").catch(() => false),
      ),
    );
    return page.frames.findLast((_, index) => focused[index] === true) ?? page.id;
  }

  async #isolatedWorld(sessionId: ShellSessionId): Promise<number> {
    const { frameTree } = await this.#send("Page.getFrameTree", {}, sessionId);
    const { executionContextId } = await this.#send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "ego-shell",
    }, sessionId);
    return executionContextId;
  }

  /** Evaluate in a world of the shell's own, so the page sees nothing run. */
  async #evaluate(
    sessionId: ShellSessionId,
    expression: string,
    options: { userGesture?: boolean; awaitPromise?: boolean } = {},
  ): Promise<any> {
    const contextId = await this.#isolatedWorld(sessionId);
    const reply = await this.#send("Runtime.evaluate", {
      contextId,
      expression,
      returnByValue: true,
      ...options,
    }, sessionId);
    if (reply.exceptionDetails) {
      throw new Error(reply.exceptionDetails.exception?.description ?? "Evaluation failed");
    }
    return reply.result?.value;
  }
}
