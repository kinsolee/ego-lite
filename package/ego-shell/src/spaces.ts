import path from "node:path";

import { BrowserWindow, type WebContents } from "electron";

import { CdpClient, type RoutedSpace } from "./cdp-router.js";
import type { LiveProfile } from "./profile-runtime.js";
import { describeProxy } from "./proxy-config.js";
import { Tab, type TabEvents } from "./tab.js";

export type Owner = "agent" | "user";

export type SpaceState = {
  spaceId: number;
  name: string;
  profileName: string;
  proxy: string;
  ownership: Owner;
  agentState: string;
  tabs: {
    targetId: string;
    title: string;
    url: string;
    active: boolean;
    loading: boolean;
  }[];
  canGoBack: boolean;
  canGoForward: boolean;
};

export type ChromeCommand =
  | { type: "newTab" }
  | { type: "closeTab"; targetId: string }
  | { type: "activateTab"; targetId: string }
  | { type: "navigate"; url: string }
  | { type: "back" | "forward" | "reload" | "takeControl" };

export type UiFiles = { chromePage: string; preload: string };

// Must match the toolbar height in ui/style.css.
const TOOLBAR_HEIGHT = 84;

/** What a person typed into the address bar, as a loadable URL. */
function typedUrl(input: string): string {
  const text = input.trim();
  if (/^([a-z][a-z0-9+.-]*:\/\/|about:|data:|file:)/i.test(text)) return text;
  const local = /^(localhost|127\.|\[::1\])/i.test(text);
  return `${local ? "http" : "https"}://${text}`;
}

/** A task space: one window of tabs that all belong to one profile. */
export class Space implements RoutedSpace {
  readonly window: BrowserWindow;
  ownership: Owner;
  agentState = "";
  readonly #live: LiveProfile;
  readonly #tabs: Tab[] = [];
  readonly #clients = new Set<CdpClient>();
  readonly #onChange: () => void;
  #active?: Tab;

  constructor(
    readonly id: number,
    public name: string,
    readonly createdBy: Owner,
    live: LiveProfile,
    ui: UiFiles,
    onChange: () => void,
  ) {
    this.ownership = createdBy;
    this.#live = live;
    this.#onChange = onChange;
    this.window = new BrowserWindow({
      width: 1280,
      height: 860,
      title: `${live.profile.name} · ${name}`,
      webPreferences: {
        preload: ui.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window.on("resize", () => this.#layout());
    this.window.webContents.on("did-finish-load", () => this.#publish());
    void this.window.loadFile(ui.chromePage);
  }

  get profile() {
    return this.#live.profile;
  }

  tabs(): Tab[] {
    return [...this.#tabs];
  }

  activeTab(): Tab | undefined {
    return this.#active;
  }

  async createTab(url: string): Promise<Tab> {
    const { profile, session, overrides } = this.#live;
    const tab = await Tab.open({
      session,
      profileId: profile.id,
      seed: profile.fingerprint.seed,
      overrides,
      events: this.#tabEvents,
    });
    this.#adopt(tab);
    if (url && url !== "about:blank") {
      // Navigation errors surface in the page and over CDP; creation itself succeeded.
      tab.webContents.loadURL(url).catch(() => {});
    }
    return tab;
  }

  async closeTab(targetId: string): Promise<void> {
    this.#tab(targetId)?.close();
  }

  async activateTab(targetId: string): Promise<void> {
    const tab = this.#tab(targetId);
    if (!tab) return;
    this.#activate(tab);
    this.#publish();
  }

  /** Open a CDP view of this space for one agent connection. */
  connect(emit: (message: string) => void): CdpClient {
    const client = new CdpClient(this, emit);
    this.#clients.add(client);
    return client;
  }

  disconnect(client: CdpClient): void {
    this.#clients.delete(client);
    if (this.#clients.size === 0) this.#releaseAgentState();
  }

  setOwnership(owner: Owner): void {
    this.ownership = owner;
    if (owner === "user") {
      this.agentState = "";
      this.#releaseAgentState();
    }
    this.#publish();
  }

  setAgentState(state: string): void {
    this.agentState = state;
    this.#publish();
  }

  rename(name: string): void {
    this.name = name;
    this.#publish();
  }

  /** Apply the profile's edited locale, timezone and user agent to open tabs. */
  async refreshOverrides(): Promise<void> {
    await Promise.all(
      this.#tabs.map((tab) => tab.applyOverrides(this.#live.overrides)),
    );
    this.#publish();
  }

  async command(command: ChromeCommand): Promise<void> {
    const contents = this.#active?.webContents;
    switch (command.type) {
      case "newTab":
        await this.createTab("about:blank");
        return;
      case "closeTab":
        return this.closeTab(command.targetId);
      case "activateTab":
        return this.activateTab(command.targetId);
      case "navigate":
        if (!contents) await this.createTab(typedUrl(command.url));
        else contents.loadURL(typedUrl(command.url)).catch(() => {});
        return;
      case "back":
        contents?.navigationHistory.goBack();
        return;
      case "forward":
        contents?.navigationHistory.goForward();
        return;
      case "reload":
        contents?.reload();
        return;
      case "takeControl":
        this.setOwnership("user");
        return;
    }
  }

  state(): SpaceState {
    const contents = this.#active?.webContents;
    return {
      spaceId: this.id,
      name: this.name,
      profileName: this.profile.name,
      proxy: describeProxy(this.profile.proxy),
      ownership: this.ownership,
      agentState: this.agentState,
      tabs: this.#tabs.map((tab) => ({
        ...tab.targetInfo(),
        active: tab === this.#active,
        loading: !tab.webContents.isDestroyed() && tab.webContents.isLoading(),
      })),
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
    };
  }

  close(): void {
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  /** Called once the window is gone: nothing may touch it afterwards. */
  dispose(): void {
    for (const tab of this.tabs()) tab.close();
  }

  readonly #tabEvents: TabEvents = {
    cdpEvent: (tab, method, params, childSessionId) => {
      for (const client of this.#clients) {
        client.tabEvent(tab, method, params, childSessionId);
      }
    },
    changed: (tab) => {
      for (const client of this.#clients) client.tabChanged(tab);
      this.#publish();
    },
    destroyed: (tab) => {
      const index = this.#tabs.indexOf(tab);
      if (index < 0) return;
      this.#tabs.splice(index, 1);
      for (const client of this.#clients) client.tabDestroyed(tab);
      if (this.window.isDestroyed()) return;
      this.window.contentView.removeChildView(tab.view);
      if (this.#active === tab) {
        this.#active = undefined;
        const next = this.#tabs[Math.min(index, this.#tabs.length - 1)];
        if (next) this.#activate(next);
      }
      this.#publish();
    },
    popup: (opener, view) => {
      const { profile, overrides } = this.#live;
      void Tab.adopt({
        view,
        profileId: profile.id,
        overrides,
        events: this.#tabEvents,
        openerId: opener.targetId,
      }).then(
        (tab) => this.#adopt(tab),
        // The popup closed before it could be set up.
        () => view.webContents.close(),
      );
    },
  };

  #tab(targetId: string): Tab | undefined {
    return this.#tabs.find((tab) => tab.targetId === targetId);
  }

  #adopt(tab: Tab): void {
    if (this.window.isDestroyed()) {
      tab.close();
      return;
    }
    this.#tabs.push(tab);
    this.window.contentView.addChildView(tab.view);
    this.#activate(tab);
    for (const client of this.#clients) client.tabCreated(tab);
    this.#publish();
  }

  #activate(tab: Tab): void {
    this.#active = tab;
    for (const other of this.#tabs) other.view.setVisible(other === tab);
    this.#layout();
    tab.webContents.focus();
  }

  #layout(): void {
    if (this.window.isDestroyed() || !this.#active) return;
    const { width, height } = this.window.getContentBounds();
    this.#active.view.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT),
    });
  }

  #releaseAgentState(): void {
    for (const tab of this.#tabs) void tab.releaseAgentState();
  }

  #publish(): void {
    if (this.window.isDestroyed()) return;
    this.window.setTitle(`${this.profile.name} · ${this.name}`);
    this.window.webContents.send("space:state", this.state());
    this.#onChange();
  }
}

/** Every open task space, addressed by the numeric id agents use. */
export class SpaceRegistry {
  readonly #spaces = new Map<number, Space>();
  readonly #ui: UiFiles;
  readonly #onChange: () => void;
  #nextId = 1;

  constructor(appRoot: string, onChange: () => void) {
    this.#ui = {
      chromePage: path.join(appRoot, "ui", "chrome.html"),
      preload: path.join(appRoot, "dist", "preload.cjs"),
    };
    this.#onChange = onChange;
  }

  async open(
    name: string,
    createdBy: Owner,
    live: LiveProfile,
  ): Promise<Space> {
    const id = this.#nextId++;
    const space = new Space(
      id,
      name,
      createdBy,
      live,
      this.#ui,
      this.#onChange,
    );
    this.#spaces.set(id, space);
    space.window.once("closed", () => {
      this.#spaces.delete(id);
      space.dispose();
      this.#onChange();
    });
    await space.createTab("about:blank");
    return space;
  }

  get(id: number): Space | undefined {
    return this.#spaces.get(id);
  }

  list(): Space[] {
    return [...this.#spaces.values()];
  }

  forChrome(contents: WebContents): Space | undefined {
    return this.list().find(
      (space) =>
        !space.window.isDestroyed() && space.window.webContents === contents,
    );
  }

  ofProfile(profileId: string): Space[] {
    return this.list().filter((space) => space.profile.id === profileId);
  }
}
