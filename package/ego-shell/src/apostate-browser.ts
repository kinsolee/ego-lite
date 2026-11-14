import { CdpConnection, type CdpEvent } from "./browser-cdp.js";
import {
  IFRAME_AUTO_ATTACH,
  type ChildTarget,
  type TargetInfo,
} from "./cdp-router.js";
import type { Profile } from "./profile-store.js";
import {
  TaskSpace,
  type Owner,
  type SpaceHost,
  type TaskTab,
} from "./task-space.js";

/** Side lengths, in CSS pixels, of the square drawn where the agent acts. */
const HIGHLIGHT_SIZES = [44, 30, 20];
const HIGHLIGHT_STEP_MS = 130;
const HIGHLIGHT_HOLD_MS = 450;
const HIGHLIGHT_FILL = { r: 255, g: 96, b: 48, a: 0.35 };
const HIGHLIGHT_OUTLINE = { r: 255, g: 96, b: 48, a: 0.9 };
const CLOSE_WAIT_MS = 3_000;

/** What Chromium reports for a target; only the fields the shell reads. */
type ChromiumTarget = TargetInfo & { subtype?: string };

/** A page of an Apostate window, driven through its own session on the browser socket. */
class ApostateTab implements TaskTab {
  readonly targetId: string;
  readonly space: ApostateSpace;
  readonly #connection: CdpConnection;
  readonly #session: string;
  /** Every session of the browser socket that belongs to a tab, shared with the browser. */
  readonly #sessions: Map<string, ApostateTab>;
  readonly #children = new Map<string, ChildTarget>();
  #info: ChromiumTarget;
  /**
   * The highlight needs the DOM and Overlay domains enabled. It gets a session
   * of its own so that neither shows up in, or is switched off by, the session
   * agents drive.
   */
  #overlay: Promise<string> | undefined;
  #overlaySession: string | undefined;
  #highlighted = false;
  #highlightTimer: NodeJS.Timeout | undefined;

  constructor(options: {
    connection: CdpConnection;
    info: ChromiumTarget;
    session: string;
    space: ApostateSpace;
    sessions: Map<string, ApostateTab>;
  }) {
    this.targetId = options.info.targetId;
    this.space = options.space;
    this.#connection = options.connection;
    this.#info = options.info;
    this.#session = options.session;
    this.#sessions = options.sessions;
    this.#sessions.set(this.#session, this);
  }

  targetInfo(): TargetInfo {
    const { targetId, title, url, openerId, browserContextId } = this.#info;
    return {
      targetId,
      type: "page",
      title,
      url,
      attached: true,
      openerId,
      browserContextId,
    };
  }

  childTargets(): ChildTarget[] {
    return [...this.#children.values()];
  }

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
  ): Promise<unknown> {
    // The highlight is drawn by the browser and would appear in the capture.
    if (method === "Page.captureScreenshot") await this.hideHighlight();
    return this.#connection.send(method, params, sessionId ?? this.#session);
  }

  /** Attach to the tab's out-of-process frames, as agents expect them announced. */
  async watchFrames(): Promise<void> {
    await this.send("Target.setAutoAttach", IFRAME_AUTO_ATTACH).catch(() => {});
  }

  update(info: ChromiumTarget): void {
    this.#info = info;
  }

  handleEvent(method: string, params: any, sessionId: string): void {
    if (sessionId === this.#overlaySession) return;
    const parent = sessionId === this.#session ? undefined : sessionId;
    if (method === "Target.attachedToTarget") {
      this.#children.set(params.sessionId, {
        sessionId: params.sessionId,
        parentSessionId: parent,
        targetInfo: params.targetInfo,
      });
      this.#sessions.set(params.sessionId, this);
      void this.#resume(params.sessionId);
      params = { ...params, waitingForDebugger: false };
    } else if (method === "Target.detachedFromTarget") {
      this.#forget(params.sessionId);
    }
    this.space.tabEvent(this, method, params, parent);
  }

  async highlight(x: number, y: number): Promise<void> {
    this.#overlay ??= this.#openOverlay().catch((error) => {
      this.#overlay = undefined;
      throw error;
    });
    const session = await this.#overlay;
    const draw = (size: number) =>
      this.#connection.send(
        "Overlay.highlightRect",
        {
          x: Math.round(x - size / 2),
          y: Math.round(y - size / 2),
          width: size,
          height: size,
          color: HIGHLIGHT_FILL,
          outlineColor: HIGHLIGHT_OUTLINE,
        },
        session,
      );
    clearTimeout(this.#highlightTimer);
    await draw(HIGHLIGHT_SIZES[0]!);
    this.#highlighted = true;
    let step = 1;
    const next = () => {
      const size = HIGHLIGHT_SIZES[step++];
      if (size === undefined) {
        void this.hideHighlight();
        return;
      }
      draw(size).catch(() => {});
      const last = step === HIGHLIGHT_SIZES.length;
      this.#highlightTimer = setTimeout(
        next,
        last ? HIGHLIGHT_HOLD_MS : HIGHLIGHT_STEP_MS,
      );
    };
    this.#highlightTimer = setTimeout(next, HIGHLIGHT_STEP_MS);
  }

  async hideHighlight(): Promise<void> {
    clearTimeout(this.#highlightTimer);
    if (!this.#highlighted) return;
    this.#highlighted = false;
    await this.#connection
      .send("Overlay.hideHighlight", {}, this.#overlaySession)
      .catch(() => {});
  }

  /** The target is gone: stop routing its sessions. */
  dispose(): void {
    clearTimeout(this.#highlightTimer);
    this.#sessions.delete(this.#session);
    if (this.#overlaySession) this.#sessions.delete(this.#overlaySession);
    for (const sessionId of this.#children.keys()) {
      this.#sessions.delete(sessionId);
    }
    this.#children.clear();
  }

  async #openOverlay(): Promise<string> {
    const { sessionId } = await this.#connection.send("Target.attachToTarget", {
      targetId: this.targetId,
      flatten: true,
    });
    this.#overlaySession = sessionId;
    this.#sessions.set(sessionId, this);
    await this.#connection.send("DOM.enable", {}, sessionId);
    await this.#connection.send("Overlay.enable", {}, sessionId);
    return sessionId;
  }

  async #resume(sessionId: string): Promise<void> {
    await this.#connection
      .send("Target.setAutoAttach", IFRAME_AUTO_ATTACH, sessionId)
      .catch(() => {});
    await this.#connection
      .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
      .catch(() => {});
  }

  #forget(sessionId: string): void {
    this.#children.delete(sessionId);
    this.#sessions.delete(sessionId);
    for (const child of [...this.#children.values()]) {
      if (child.parentSessionId === sessionId) this.#forget(child.sessionId);
    }
  }
}

/** A task space of an Apostate profile: the tabs of one browser window. */
export class ApostateSpace extends TaskSpace {
  readonly #browser: ApostateBrowser;
  readonly #tabs: ApostateTab[] = [];
  #active: ApostateTab | undefined;

  constructor(
    id: number,
    name: string,
    createdBy: Owner,
    browser: ApostateBrowser,
  ) {
    super(id, name, createdBy);
    this.#browser = browser;
  }

  get profile(): Profile {
    return this.#browser.profile;
  }

  tabs(): ApostateTab[] {
    return [...this.#tabs];
  }

  /**
   * The tab most recently opened or activated through the shell. Chromium does
   * not report which tab the user picked in the tab strip.
   */
  activeTab(): ApostateTab | undefined {
    return this.#active;
  }

  createTab(url: string): Promise<ApostateTab> {
    return this.#browser.createTab(this, url);
  }

  closeTab(targetId: string): Promise<void> {
    return this.#browser.closeTab(targetId);
  }

  async activateTab(targetId: string): Promise<void> {
    const tab = this.#tabs.find((candidate) => candidate.targetId === targetId);
    if (!tab) return;
    await this.#browser.activate(tab);
    this.#active = tab;
    this.publish();
  }

  override refreshTabs(): Promise<void> {
    return this.#browser.refreshTabs();
  }

  async highlightMouse(x: number, y: number): Promise<void> {
    await this.#active?.highlight(x, y);
  }

  close(): Promise<void> {
    return this.#browser.closeSpace(this);
  }

  override setOwnership(owner: Owner): void {
    super.setOwnership(owner);
    // The user takes over by working in the Apostate window itself.
    if (owner === "user" && this.#active) {
      this.#browser.activate(this.#active).catch(() => {});
    }
  }

  /** A tab of this space's window appeared, opened by the shell, a page or the user. */
  adopt(tab: ApostateTab): void {
    this.#tabs.push(tab);
    this.#active = tab;
    for (const client of this.clients) client.tabCreated(tab);
    this.publish();
  }

  forget(tab: ApostateTab): void {
    const index = this.#tabs.indexOf(tab);
    if (index < 0) return;
    this.#tabs.splice(index, 1);
    if (this.#active === tab) this.#active = this.#tabs.at(-1);
    for (const client of this.clients) client.tabDestroyed(tab);
    this.publish();
  }

  tabChanged(tab: ApostateTab): void {
    for (const client of this.clients) client.tabChanged(tab);
    this.publish();
  }

  tabEvent(
    tab: ApostateTab,
    method: string,
    params: unknown,
    childSessionId: string | undefined,
  ): void {
    for (const client of this.clients) {
      client.tabEvent(tab, method, params, childSessionId);
    }
  }

  protected releaseAgentState(): void {
    for (const tab of this.#tabs) {
      tab
        .send("Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => {});
      void tab.hideHighlight();
    }
  }

  protected publish(): void {
    this.#browser.changed();
  }
}

/**
 * One running Apostate process seen through its browser-level CDP socket. Each
 * of its windows is a task space; every window shares the profile's cookies.
 */
export class ApostateBrowser {
  profile: Profile;
  /** Settles when the browser socket is gone, which is when the process is. */
  readonly closed: Promise<void>;
  readonly #connection: CdpConnection;
  readonly #host: SpaceHost;
  readonly #tabs = new Map<string, ApostateTab>();
  readonly #sessions = new Map<string, ApostateTab>();
  readonly #windows = new Map<number, ApostateSpace>();
  /**
   * Targets are placed one at a time. A tab the shell opens is then registered
   * before Chromium's own announcement of it is looked at.
   */
  #queue: Promise<void> = Promise.resolve();

  private constructor(
    connection: CdpConnection,
    profile: Profile,
    host: SpaceHost,
  ) {
    this.#connection = connection;
    this.profile = profile;
    this.#host = host;
    this.closed = connection.closed.then(() => {
      for (const targetId of [...this.#tabs.keys()]) this.#drop(targetId);
    });
  }

  static async connect(
    endpoint: string,
    profile: Profile,
    host: SpaceHost,
  ): Promise<ApostateBrowser> {
    let browser: ApostateBrowser | undefined;
    const connection = await CdpConnection.connect(endpoint, (event) => {
      if (browser) browser.#handle(event);
    });
    browser = new ApostateBrowser(connection, profile, host);
    await connection.send("Target.setDiscoverTargets", { discover: true });
    return browser;
  }

  spaces(): ApostateSpace[] {
    return [...new Set(this.#windows.values())];
  }

  /** Open a new window and make it a task space. */
  createSpace(name: string, createdBy: Owner): Promise<ApostateSpace> {
    return this.#serial(async () => {
      const space = new ApostateSpace(
        this.#host.allocateId(),
        name,
        createdBy,
        this,
      );
      await this.#open({ url: "about:blank", newWindow: true }, () => space);
      this.#host.add(space);
      return space;
    });
  }

  createTab(space: ApostateSpace, url: string): Promise<ApostateTab> {
    return this.#serial(async () => {
      const anchor = space.activeTab();
      if (!anchor) throw new Error("The task space has no window");
      // Chromium opens a tab in the window that was used last.
      await this.activate(anchor);
      return this.#open({ url }, (windowId) => {
        if (this.#windows.get(windowId) !== space) {
          throw new Error("The new tab opened outside its task space");
        }
        return space;
      });
    });
  }

  closeTab(targetId: string): Promise<void> {
    return this.#serial(async () => {
      await this.#connection.send("Target.closeTarget", { targetId });
      this.#drop(targetId);
    });
  }

  closeSpace(space: ApostateSpace): Promise<void> {
    return this.#serial(async () => {
      for (const tab of space.tabs()) {
        await this.#connection
          .send("Target.closeTarget", { targetId: tab.targetId })
          .catch(() => {});
        this.#drop(tab.targetId);
      }
    });
  }

  async activate(tab: ApostateTab): Promise<void> {
    await this.#connection.send("Target.activateTarget", {
      targetId: tab.targetId,
    });
  }

  /**
   * Chromium announces a tab's title only when it navigates, so a title the
   * page sets afterwards has to be asked for.
   */
  async refreshTabs(): Promise<void> {
    const reply = await this.#connection
      .send("Target.getTargets")
      .catch(() => undefined);
    for (const info of (reply?.targetInfos ?? []) as ChromiumTarget[]) {
      const tab = this.#tabs.get(info.targetId);
      if (!tab) continue;
      const { title, url } = tab.targetInfo();
      if (title === info.title && url === info.url) continue;
      tab.update(info);
      tab.space.tabChanged(tab);
    }
  }

  changed(): void {
    this.#host.changed();
  }

  /** Ask the browser to quit, and give it a moment to do so on its own. */
  async close(): Promise<void> {
    this.#connection.send("Browser.close").catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.closed,
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    this.#connection.close();
  }

  #handle({ method, params, sessionId }: CdpEvent): void {
    if (sessionId) {
      this.#sessions.get(sessionId)?.handleEvent(method, params, sessionId);
      return;
    }
    if (
      method === "Target.targetCreated" ||
      method === "Target.targetInfoChanged"
    ) {
      // A target that vanishes while it is being placed is simply not a tab.
      this.#serial(() => this.#track(params.targetInfo)).catch(() => {});
    } else if (method === "Target.targetDestroyed") {
      void this.#serial(async () => this.#drop(params.targetId));
    }
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** A target Chromium announced: a page, a popup, or a window the user opened. */
  async #track(info: ChromiumTarget): Promise<void> {
    const known = this.#tabs.get(info.targetId);
    if (known) {
      known.update(info);
      known.space.tabChanged(known);
      return;
    }
    // A prerendered page becomes a tab only once it replaces the one on screen.
    if (info.type !== "page" || info.subtype) return;
    await this.#attach(
      info,
      (windowId) =>
        this.#windows.get(windowId) ??
        this.#tabs.get(info.openerId ?? "")?.space ??
        this.#adoptWindow(),
    );
  }

  /** A window nobody asked the shell for is the user's own task space. */
  #adoptWindow(): ApostateSpace {
    const space = new ApostateSpace(
      this.#host.allocateId(),
      this.profile.name,
      "user",
      this,
    );
    this.#host.add(space);
    return space;
  }

  async #open(
    params: { url: string; newWindow?: boolean },
    place: (windowId: number) => ApostateSpace,
  ): Promise<ApostateTab> {
    const { targetId } = await this.#connection.send(
      "Target.createTarget",
      params,
    );
    try {
      const { targetInfo } = await this.#connection.send(
        "Target.getTargetInfo",
        { targetId },
      );
      return await this.#attach(targetInfo, place);
    } catch (error) {
      this.#connection.send("Target.closeTarget", { targetId }).catch(() => {});
      throw error;
    }
  }

  async #attach(
    info: ChromiumTarget,
    place: (windowId: number) => ApostateSpace,
  ): Promise<ApostateTab> {
    const { targetId } = info;
    const { windowId } = await this.#connection.send(
      "Browser.getWindowForTarget",
      { targetId },
    );
    const { sessionId } = await this.#connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const space = place(windowId);
    const tab = new ApostateTab({
      connection: this.#connection,
      info,
      session: sessionId,
      space,
      sessions: this.#sessions,
    });
    this.#tabs.set(targetId, tab);
    this.#windows.set(windowId, space);
    space.adopt(tab);
    await tab.watchFrames();
    return tab;
  }

  #drop(targetId: string): void {
    const tab = this.#tabs.get(targetId);
    if (!tab) return;
    this.#tabs.delete(targetId);
    tab.dispose();
    const { space } = tab;
    space.forget(tab);
    if (space.tabs().length > 0) return;
    for (const [windowId, owner] of this.#windows) {
      if (owner === space) this.#windows.delete(windowId);
    }
    this.#host.remove(space);
  }
}
