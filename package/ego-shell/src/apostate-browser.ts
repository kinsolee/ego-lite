import { PERSONA } from "./apostate-launcher.js";
import { CdpConnection, type CdpEvent } from "./browser-cdp.js";
import { type ChildTarget, type TargetInfo } from "./cdp-router.js";
import { MouseHighlight } from "./mouse-highlight.js";
import type { Profile } from "./profile-store.js";
import { describeProxy } from "./proxy-config.js";
import type { Screen, ScreenSource } from "./screen.js";
import { windowPlacement } from "./screen-geometry.js";
import { ShellLink, type HumanPrompt } from "./shell-link.js";
import {
  TaskSpace,
  type Owner,
  type SpaceHost,
  type SpaceState,
  type TaskTab,
} from "./task-space.js";
import type { Stage } from "./workbench.js";

/**
 * Announces a tab's out-of-process frames. Nothing starts paused: the kernel
 * needs no setup in a frame, and Chromium would pause the page's workers too
 * without announcing them, leaving them stuck.
 */
const FRAME_AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "iframe" }],
};

const CLOSE_WAIT_MS = 3_000;
/** How long a tab the shell opened may take to be announced on the routing socket. */
const PLACE_WAIT_MS = 10_000;

/** The one view every Apostate space is drawn into, and its controller. */
export type ScreenHandle = { view: unknown; screen: Screen };

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
  readonly #highlight: MouseHighlight;

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
    this.#highlight = new MouseHighlight({
      attach: async () => {
        const { sessionId } = await this.#connection.send(
          "Target.attachToTarget",
          { targetId: this.targetId, flatten: true },
        );
        this.#sessions.set(sessionId, this);
        return sessionId;
      },
      send: (method, params, sessionId) =>
        this.#connection.send(method, params, sessionId),
    });
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
    // An agent's command may rightly take long; the agent decides how long to wait.
    return this.#connection.send(
      method,
      params,
      sessionId ?? this.#session,
      Infinity,
    );
  }

  /** A command the shell sends on its own behalf, bounded like its other bookkeeping. */
  sendOwn(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.#connection.send(method, params, this.#session);
  }

  /** Attach to the tab's out-of-process frames, as agents expect them announced. */
  async watchFrames(): Promise<void> {
    await this.#watchNested(this.#session);
  }

  update(info: ChromiumTarget): void {
    this.#info = info;
  }

  handleEvent(method: string, params: any, sessionId: string): void {
    if (this.#highlight.owns(sessionId)) return;
    const parent = sessionId === this.#session ? undefined : sessionId;
    if (method === "Target.attachedToTarget") {
      this.#children.set(params.sessionId, {
        sessionId: params.sessionId,
        parentSessionId: parent,
        targetInfo: params.targetInfo,
      });
      this.#sessions.set(params.sessionId, this);
      void this.#watchNested(params.sessionId);
      params = { ...params, waitingForDebugger: false };
    } else if (method === "Target.detachedFromTarget") {
      this.#forget(params.sessionId);
    }
    this.space.tabEvent(this, method, params, parent);
  }

  highlight(x: number, y: number): Promise<void> {
    return this.#highlight.show(x, y);
  }

  hideHighlight(): Promise<void> {
    return this.#highlight.hide();
  }

  /** The target is gone: stop routing its sessions. */
  dispose(): void {
    this.#highlight.reset();
    for (const [sessionId, tab] of this.#sessions) {
      if (tab === this) this.#sessions.delete(sessionId);
    }
    this.#children.clear();
  }

  async #watchNested(sessionId: string): Promise<void> {
    await this.#connection
      .send("Target.setAutoAttach", FRAME_AUTO_ATTACH, sessionId)
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

/**
 * A task space of an Apostate profile: the tabs of one headless window, shown
 * in the main window's screen view while it is selected.
 */
export class ApostateSpace extends TaskSpace implements ScreenSource {
  /** Which cascade position its window took among the process's windows. */
  readonly slot: number;
  readonly #browser: ApostateBrowser;
  readonly #tabs: ApostateTab[] = [];
  #active: ApostateTab | undefined;
  #history = { canGoBack: false, canGoForward: false };

  constructor(
    id: number,
    name: string,
    createdBy: Owner,
    browser: ApostateBrowser,
    stage: Stage,
    slot: number,
  ) {
    super(id, name, createdBy);
    this.#browser = browser;
    this.slot = slot;
    const shown = browser.screen;
    stage.onSelected((selected) => {
      if (!shown) return;
      if (selected) {
        stage.front(shown.view);
        shown.screen.show(this);
      } else {
        shown.screen.hide(this);
      }
    });
  }

  get profile(): Profile {
    return this.#browser.profile;
  }

  get link(): ShellLink {
    return this.#browser.link;
  }

  tabs(): ApostateTab[] {
    return [...this.#tabs];
  }

  /** The tab on screen. Only the shell decides it: no user picks a tab in a native strip. */
  activeTab(): ApostateTab | undefined {
    return this.#active;
  }

  shownTargetId(): string | undefined {
    return this.#active?.targetId;
  }

  createTab(url: string): Promise<ApostateTab> {
    return this.#browser.createTab(this, url);
  }

  closeTab(targetId: string): Promise<void> {
    return this.#browser.closeTab(targetId);
  }

  async activateTab(targetId: string): Promise<void> {
    const tab = this.#tabs.find((candidate) => candidate.targetId === targetId);
    if (tab) this.#setActive(tab);
  }

  override refreshTabs(): Promise<void> {
    return this.#browser.refreshTabs();
  }

  /** Every window of the process is one browser, so the command goes to it. */
  browserCommand(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return this.#browser.send(method, params);
  }

  async highlightMouse(x: number, y: number): Promise<void> {
    await this.#active?.highlight(x, y);
  }

  close(): Promise<void> {
    return this.#browser.closeSpace(this);
  }

  state(): SpaceState {
    return {
      spaceId: this.id,
      name: this.name,
      profileName: this.profile.name,
      proxy: describeProxy(this.profile.proxy),
      ownership: this.ownership,
      agentState: this.agentState,
      tabs: this.#tabs.map((tab) => {
        const { targetId, title, url } = tab.targetInfo();
        return { targetId, title, url, active: tab === this.#active, loading: false };
      }),
      ...this.#history,
    };
  }

  protected async navigate(url: string): Promise<void> {
    await this.#active?.sendOwn("Page.navigate", { url, transitionType: "typed" });
  }

  protected back(): Promise<void> {
    return this.#step(-1);
  }

  protected forward(): Promise<void> {
    return this.#step(1);
  }

  protected async reload(): Promise<void> {
    await this.#active?.sendOwn("Page.reload");
  }

  async #step(offset: number): Promise<void> {
    const tab = this.#active;
    if (!tab) return;
    const { currentIndex, entryIds } = await this.link.history(tab.targetId);
    const entryId = entryIds[currentIndex + offset];
    if (entryId !== undefined) {
      await tab.sendOwn("Page.navigateToHistoryEntry", { entryId });
    }
  }

  /** Chromium does not announce where a tab is in its history, so the toolbar asks. */
  async #refreshHistory(): Promise<void> {
    const tab = this.#active;
    const history = tab
      ? await this.link.history(tab.targetId).then(
          ({ currentIndex, entryIds }) => ({
            canGoBack: currentIndex > 0,
            canGoForward: currentIndex < entryIds.length - 1,
          }),
          () => undefined,
        )
      : { canGoBack: false, canGoForward: false };
    if (!history || tab !== this.#active) return;
    if (
      history.canGoBack === this.#history.canGoBack &&
      history.canGoForward === this.#history.canGoForward
    ) {
      return;
    }
    this.#history = history;
    this.publish();
  }

  override setOwnership(owner: Owner): void {
    super.setOwnership(owner);
    for (const tab of this.#tabs) this.#answerFor(tab);
    this.#browser.screen?.screen.retarget(this);
  }

  /** A tab of this space's window appeared, opened by the shell, an agent or a page. */
  adopt(tab: ApostateTab): void {
    this.#tabs.push(tab);
    for (const client of this.clients) client.tabCreated(tab);
    this.#answerFor(tab);
    this.#setActive(tab);
  }

  forget(tab: ApostateTab): void {
    const index = this.#tabs.indexOf(tab);
    if (index < 0) return;
    this.#tabs.splice(index, 1);
    for (const client of this.clients) client.tabDestroyed(tab);
    if (this.#active === tab) this.#setActive(this.#tabs.at(-1));
    else this.publish();
  }

  tabChanged(tab: ApostateTab): void {
    for (const client of this.clients) client.tabChanged(tab);
    this.publish();
    if (tab === this.#active) void this.#refreshHistory();
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
        .sendOwn("Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => {});
      void tab.hideHighlight();
    }
  }

  protected publish(): void {
    this.#browser.changed();
  }

  /**
   * The single writer of the active tab. Chromium is told too, so the tab is
   * the one visible page of its window, as in a window with a tab strip.
   */
  #setActive(tab: ApostateTab | undefined): void {
    this.#active = tab;
    if (tab) this.#browser.activate(tab).catch(() => {});
    this.#history = { canGoBack: false, canGoForward: false };
    this.publish();
    void this.#refreshHistory();
    this.#browser.screen?.screen.retarget(this);
  }

  /** While the user holds the space, the shell answers its dialogs and file choosers. */
  #answerFor(tab: ApostateTab): void {
    const shown = this.#browser.screen;
    if (!shown) return;
    const ask =
      this.ownership === "user"
        ? (prompt: HumanPrompt) => shown.screen.ask(this, prompt)
        : null;
    this.link.answerFor(tab.targetId, ask).catch(() => {});
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
  /** The shell's own socket: the screen, the human's input, window placement. */
  readonly link: ShellLink;
  readonly screen: ScreenHandle | undefined;
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
  /** Tabs the shell opened, waiting for the routing socket to place them. */
  readonly #awaited = new Map<string, () => void>();

  private constructor(
    connection: CdpConnection,
    link: ShellLink,
    profile: Profile,
    host: SpaceHost,
    screen: ScreenHandle | undefined,
  ) {
    this.#connection = connection;
    this.link = link;
    this.profile = profile;
    this.#host = host;
    this.screen = screen;
    this.closed = connection.closed.then(() => {
      for (const targetId of [...this.#tabs.keys()]) this.#drop(targetId);
    });
  }

  static async connect(
    endpoint: string,
    profile: Profile,
    host: SpaceHost,
    options: { commandTimeoutMs?: number; screen?: ScreenHandle } = {},
  ): Promise<ApostateBrowser> {
    let browser: ApostateBrowser | undefined;
    const connection = await CdpConnection.connect(
      endpoint,
      (event) => {
        if (browser) browser.#handle(event);
      },
      options.commandTimeoutMs,
    );
    let link: ShellLink;
    try {
      link = await ShellLink.connect(endpoint, options.commandTimeoutMs);
    } catch (error) {
      connection.close();
      throw error;
    }
    browser = new ApostateBrowser(connection, link, profile, host, options.screen);
    await connection.send("Target.setDiscoverTargets", { discover: true });
    return browser;
  }

  spaces(): ApostateSpace[] {
    return [...new Set(this.#windows.values())];
  }

  /**
   * Open a new window and make it a task space. A headless window is still a
   * window: its id decides which space a page's own popups join. It is placed
   * inside the persona's screen, at a spot no other live window of the
   * process holds, since a page reads where its window is.
   */
  createSpace(name: string, createdBy: Owner): Promise<ApostateSpace> {
    return this.#serial(async () => {
      const id = this.#host.allocateId();
      const space = new ApostateSpace(
        id,
        name,
        createdBy,
        this,
        this.#host.stageFor(id),
        this.#freeSlot(),
      );
      const tab = await this.#open({ url: "about:blank", newWindow: true }, () => space);
      const avail = await this.link.availArea(tab.targetId);
      await this.link.placeWindow(
        tab.targetId,
        windowPlacement(avail, PERSONA.window, space.slot),
      );
      this.#host.add(space);
      return space;
    });
  }

  /**
   * Open a tab in the space's own window through the shell's link, whichever
   * window was used last, then wait for the routing socket to place it.
   */
  async createTab(space: ApostateSpace, url: string): Promise<ApostateTab> {
    const anchor = space.activeTab();
    if (!anchor) throw new Error("The task space has no window");
    const targetId = await this.link.openIn(anchor.targetId, url);
    const tab = await this.#placed(targetId);
    if (tab.space !== space) {
      throw new Error("The new tab opened outside its task space");
    }
    return tab;
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

  /** An agent's command for the browser itself rather than one of its pages. */
  send(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.#connection.send(method, params, undefined, Infinity);
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
    this.link.close();
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

  /** A target Chromium announced: a tab the shell opened, a popup, or an unknown window. */
  async #track(info: ChromiumTarget): Promise<void> {
    const known = this.#tabs.get(info.targetId);
    if (known) {
      known.update(info);
      known.space.tabChanged(known);
      return;
    }
    // A prerendered page becomes a tab only once it replaces the one on screen.
    if (info.type !== "page" || info.subtype) return;
    // A page that asks for a sized popup gets a window of its own; the popup
    // still belongs with the page that opened it.
    await this.#attach(
      info,
      (windowId) =>
        this.#tabs.get(info.openerId ?? "")?.space ??
        this.#windows.get(windowId) ??
        this.#adoptWindow(),
    );
  }

  /** A window with no known opener and no space is a task space of its own for the user. */
  #adoptWindow(): ApostateSpace {
    const id = this.#host.allocateId();
    const space = new ApostateSpace(
      id,
      this.profile.name,
      "user",
      this,
      this.#host.stageFor(id),
      this.#freeSlot(),
    );
    this.#host.add(space);
    return space;
  }

  /** The lowest cascade position no live space of this process holds. */
  #freeSlot(): number {
    const taken = new Set(this.spaces().map((space) => space.slot));
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    return slot;
  }

  /** The tab the shell opened, once the routing socket has placed it. */
  #placed(targetId: string): Promise<ApostateTab> {
    const found = this.#tabs.get(targetId);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#awaited.delete(targetId);
        reject(new Error("The new tab was never announced"));
      }, PLACE_WAIT_MS);
      this.#awaited.set(targetId, () => {
        clearTimeout(timer);
        this.#awaited.delete(targetId);
        const tab = this.#tabs.get(targetId);
        if (tab) resolve(tab);
        else reject(new Error("The new tab closed before it was placed"));
      });
    });
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
    if (!this.#windows.has(windowId)) this.#windows.set(windowId, space);
    space.adopt(tab);
    await tab.watchFrames();
    this.#awaited.get(targetId)?.();
    return tab;
  }

  #drop(targetId: string): void {
    const tab = this.#tabs.get(targetId);
    if (!tab) return;
    this.#tabs.delete(targetId);
    tab.dispose();
    this.link.forget(targetId);
    const { space } = tab;
    space.forget(tab);
    if (space.tabs().length > 0) return;
    for (const [windowId, owner] of this.#windows) {
      if (owner === space) this.#windows.delete(windowId);
    }
    this.#host.remove(space);
  }
}
