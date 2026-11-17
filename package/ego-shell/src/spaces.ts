import { ProfileUnusableError } from "./profile-network.js";
import type { LiveProfile, ProfileRuntime } from "./profile-runtime.js";
import type { Profile } from "./profile-store.js";
import { describeProxy } from "./proxy-config.js";
import { Tab, type TabEvents } from "./tab.js";
import {
  TaskSpace,
  type KernelBackend,
  type Owner,
  type SpaceHost,
  type SpaceState,
} from "./task-space.js";
import type { Stage } from "./workbench.js";

/** A task space on the Electron kernel: tabs shown in the main window. */
export class Space extends TaskSpace {
  readonly #live: LiveProfile;
  readonly #stage: Stage;
  readonly #host: SpaceHost;
  readonly #onClose: () => void;
  readonly #tabs: Tab[] = [];
  #active?: Tab;
  #closed = false;

  constructor(
    id: number,
    name: string,
    createdBy: Owner,
    live: LiveProfile,
    stage: Stage,
    host: SpaceHost,
    onClose: () => void,
  ) {
    super(id, name, createdBy);
    this.#live = live;
    this.#stage = stage;
    this.#host = host;
    this.#onClose = onClose;
  }

  get profile(): Profile {
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
    this.publish();
  }

  /**
   * Electron has no browser endpoint. A page's debugger session answers
   * `Browser.getVersion`, but its `Browser.cancelDownload` looks only in the
   * app's default session and refuses any other context id, so a download in
   * a profile's partition cannot be cancelled through it.
   */
  async browserCommand(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "Browser.cancelDownload") {
      throw new Error(
        "Browser.cancelDownload is not supported by the built-in kernel: Electron cannot reach a download in a profile's session",
      );
    }
    const tab = this.#active ?? this.#tabs[0];
    if (!tab) throw new Error("The task space has no open tab");
    return tab.send(method, params);
  }

  async highlightMouse(x: number, y: number): Promise<void> {
    await this.#active?.highlight(x, y);
  }

  /** Apply the profile's edited locale, timezone and user agent to open tabs. */
  async refreshOverrides(): Promise<void> {
    await Promise.all(
      this.#tabs.map((tab) => tab.applyOverrides(this.#live.overrides)),
    );
    this.publish();
  }

  protected async navigate(url: string): Promise<void> {
    this.#active?.webContents.loadURL(url).catch(() => {});
  }

  protected async back(): Promise<void> {
    this.#active?.webContents.navigationHistory.goBack();
  }

  protected async forward(): Promise<void> {
    this.#active?.webContents.navigationHistory.goForward();
  }

  protected async reload(): Promise<void> {
    this.#active?.webContents.reload();
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const tab of this.tabs()) tab.close();
    this.#onClose();
    this.#host.remove(this);
  }

  readonly #tabEvents: TabEvents = {
    cdpEvent: (tab, method, params, childSessionId) => {
      for (const client of this.clients) {
        client.tabEvent(tab, method, params, childSessionId);
      }
    },
    changed: (tab) => {
      for (const client of this.clients) client.tabChanged(tab);
      this.publish();
    },
    destroyed: (tab) => {
      const index = this.#tabs.indexOf(tab);
      if (index < 0) return;
      this.#tabs.splice(index, 1);
      for (const client of this.clients) client.tabDestroyed(tab);
      this.#stage.remove(tab.view);
      if (this.#active === tab) {
        this.#active = undefined;
        const next = this.#tabs[Math.min(index, this.#tabs.length - 1)];
        if (next) this.#activate(next);
        else this.#stage.front(null);
      }
      this.publish();
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
    if (this.#closed) {
      tab.close();
      return;
    }
    this.#tabs.push(tab);
    this.#stage.place(tab.view);
    this.#activate(tab);
    for (const client of this.clients) client.tabCreated(tab);
    this.publish();
  }

  #activate(tab: Tab): void {
    this.#active = tab;
    this.#stage.front(tab.view);
  }

  protected releaseAgentState(): void {
    for (const tab of this.#tabs) void tab.releaseAgentState();
  }

  protected publish(): void {
    if (!this.#closed) this.#host.changed();
  }
}

/** Runs profiles in Electron sessions and shows their tabs in the main window. */
export class ElectronBackend implements KernelBackend {
  readonly #runtime: ProfileRuntime;
  readonly #host: SpaceHost;
  readonly #spaces = new Set<Space>();

  constructor(runtime: ProfileRuntime, host: SpaceHost) {
    this.#runtime = runtime;
    this.#host = host;
  }

  async open(name: string, createdBy: Owner, profile: Profile): Promise<Space> {
    const live = await this.#runtime.start(profile);
    const id = this.#host.allocateId();
    const space: Space = new Space(
      id,
      name,
      createdBy,
      live,
      this.#host.stageFor(id),
      this.#host,
      () => this.#spaces.delete(space),
    );
    this.#spaces.add(space);
    this.#host.add(space);
    await space.createTab("about:blank");
    return space;
  }

  running(profileId: string): boolean {
    return this.#ofProfile(profileId).length > 0;
  }

  async update(profile: Profile): Promise<void> {
    let live: LiveProfile | undefined;
    try {
      live = await this.#runtime.update(profile);
    } catch (error) {
      // The runtime stopped the profile; its spaces would browse on a session nobody manages.
      if (error instanceof ProfileUnusableError) {
        await Promise.all(
          this.#ofProfile(profile.id).map((space) => space.close()),
        );
      }
      throw error;
    }
    if (!live) return;
    await Promise.all(
      this.#ofProfile(profile.id).map((space) => space.refreshOverrides()),
    );
  }

  async release(profileId: string): Promise<void> {
    await Promise.all(this.#ofProfile(profileId).map((space) => space.close()));
    await this.#runtime.release(profileId);
  }

  async erase(profileId: string): Promise<void> {
    await Promise.all(this.#ofProfile(profileId).map((space) => space.close()));
    await this.#runtime.erase(profileId);
  }

  stop(): Promise<void> {
    return this.#runtime.stop();
  }

  #ofProfile(profileId: string): Space[] {
    return [...this.#spaces].filter((space) => space.profile.id === profileId);
  }
}
