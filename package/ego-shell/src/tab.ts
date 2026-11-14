import { WebContentsView, type Session, type WebContents } from "electron";

import type { ChildTarget, RoutedTab, TargetInfo } from "./cdp-router.js";
import type { UserAgentOverride } from "./fingerprint.js";

export type TabOverrides = {
  timezone: string;
  locale: string;
  userAgent: UserAgentOverride;
};

export type TabEvents = {
  /** A CDP event from the tab, or from the iframe session `childSessionId`. */
  cdpEvent(
    tab: Tab,
    method: string,
    params: unknown,
    childSessionId?: string,
  ): void;
  changed(tab: Tab): void;
  destroyed(tab: Tab): void;
  /** A window the page opened; it must become a tab of the same space. */
  popup(opener: Tab, view: WebContentsView): void;
};

// Only iframes are attached: workers share the frame's process-wide overrides.
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: "iframe" }],
};

/** One browser tab of a profile: a web view plus the CDP session that drives it. */
export class Tab implements RoutedTab {
  readonly view: WebContentsView;
  targetId = "";
  readonly openerId?: string;
  readonly #profileId: string;
  readonly #events: TabEvents;
  readonly #children = new Map<string, ChildTarget>();
  #overrides: TabOverrides;

  private constructor(
    view: WebContentsView,
    profileId: string,
    overrides: TabOverrides,
    events: TabEvents,
    openerId?: string,
  ) {
    this.view = view;
    this.#profileId = profileId;
    this.#overrides = overrides;
    this.#events = events;
    this.openerId = openerId;
  }

  static async open(options: {
    session: Session;
    profileId: string;
    seed: string;
    overrides: TabOverrides;
    events: TabEvents;
  }): Promise<Tab> {
    const view = new WebContentsView({
      webPreferences: {
        session: options.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Read by the patched kernel to derive this profile's fingerprint noise.
        additionalArguments: [`--ego-fp-seed=${options.seed}`],
      },
    });
    // The debugger needs a document to attach to, and the overrides must be
    // in place before the first real page runs.
    await view.webContents.loadURL("about:blank");
    return Tab.adopt({ ...options, view });
  }

  /** Wrap a view that already exists, such as a popup Chromium created. */
  static async adopt(options: {
    view: WebContentsView;
    profileId: string;
    overrides: TabOverrides;
    events: TabEvents;
    openerId?: string;
  }): Promise<Tab> {
    const tab = new Tab(
      options.view,
      options.profileId,
      options.overrides,
      options.events,
      options.openerId,
    );
    await tab.#start();
    return tab;
  }

  get webContents(): WebContents {
    return this.view.webContents;
  }

  targetInfo(): TargetInfo {
    const contents = this.webContents;
    return {
      targetId: this.targetId,
      type: "page",
      title: contents.isDestroyed() ? "" : contents.getTitle(),
      url: contents.isDestroyed() ? "" : contents.getURL(),
      attached: true,
      browserContextId: this.#profileId,
      ...(this.openerId ? { openerId: this.openerId } : {}),
    };
  }

  childTargets(): ChildTarget[] {
    return [...this.#children.values()];
  }

  /** Frame id to session id for the iframes that live in another process. */
  childFrames(): Map<string, string> {
    return new Map(
      this.childTargets().map((child) => [
        child.targetInfo.targetId,
        child.sessionId,
      ]),
    );
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<any> {
    const contents = this.webContents;
    if (contents.isDestroyed()) throw new Error("Target closed");
    if (!contents.debugger.isAttached()) await this.#attach();
    return contents.debugger.sendCommand(method, params, sessionId);
  }

  async applyOverrides(overrides: TabOverrides): Promise<void> {
    this.#overrides = overrides;
    await Promise.all(
      [undefined, ...this.#children.keys()].map((sessionId) =>
        this.#emulate(sessionId),
      ),
    );
  }

  /** Undo page state an agent left behind so a person can use the tab normally. */
  async releaseAgentState(): Promise<void> {
    await this.send("Page.setInterceptFileChooserDialog", {
      enabled: false,
    }).catch(() => {});
  }

  close(): void {
    if (!this.webContents.isDestroyed()) this.webContents.close();
  }

  async #start(): Promise<void> {
    const contents = this.webContents;
    contents.setWindowOpenHandler(() => ({
      action: "allow",
      // Keeping Chromium's own WebContents preserves `window.opener`, which
      // login and payment popups rely on.
      createWindow: (options) => {
        const view = new WebContentsView(options);
        this.#events.popup(this, view);
        return view.webContents;
      },
    }));
    contents.debugger.on("message", (_event, method, params, sessionId) => {
      this.#onMessage(method, params, sessionId || undefined);
    });
    for (const event of [
      "page-title-updated",
      "did-navigate",
      "did-navigate-in-page",
      "did-start-loading",
      "did-stop-loading",
    ] as const) {
      contents.on(event as "did-stop-loading", () =>
        this.#events.changed(this),
      );
    }
    contents.once("destroyed", () => this.#events.destroyed(this));
    await this.#attach();
    const { targetInfo } = await this.send("Target.getTargetInfo");
    this.targetId = targetInfo.targetId;
  }

  async #attach(): Promise<void> {
    this.#children.clear();
    this.webContents.debugger.attach("1.3");
    await this.#emulate(undefined);
    await this.webContents.debugger.sendCommand(
      "Target.setAutoAttach",
      AUTO_ATTACH,
    );
  }

  async #emulate(sessionId: string | undefined): Promise<void> {
    const send = (method: string, params: Record<string, unknown>) =>
      this.webContents.debugger
        .sendCommand(method, params, sessionId)
        .catch(() => {});
    await Promise.all([
      send("Emulation.setTimezoneOverride", {
        timezoneId: this.#overrides.timezone,
      }),
      send("Emulation.setLocaleOverride", { locale: this.#overrides.locale }),
      send("Emulation.setUserAgentOverride", { ...this.#overrides.userAgent }),
    ]);
  }

  #onMessage(method: string, params: any, sessionId: string | undefined): void {
    if (method === "Target.attachedToTarget") {
      const child: ChildTarget = {
        sessionId: params.sessionId,
        parentSessionId: sessionId,
        targetInfo: params.targetInfo,
      };
      this.#children.set(child.sessionId, child);
      void this.#startChild(child.sessionId);
      // The shell resumes the frame itself, so clients must not wait on it.
      params = { ...params, waitingForDebugger: false };
    } else if (method === "Target.detachedFromTarget") {
      this.#forget(params.sessionId);
    }
    this.#events.cdpEvent(this, method, params, sessionId);
  }

  async #startChild(sessionId: string): Promise<void> {
    const dbg = this.webContents.debugger;
    await this.#emulate(sessionId);
    await dbg
      .sendCommand("Target.setAutoAttach", AUTO_ATTACH, sessionId)
      .catch(() => {});
    await dbg
      .sendCommand("Runtime.runIfWaitingForDebugger", {}, sessionId)
      .catch(() => {});
  }

  #forget(sessionId: string): void {
    this.#children.delete(sessionId);
    for (const child of this.#children.values()) {
      if (child.parentSessionId === sessionId) this.#forget(child.sessionId);
    }
  }
}
