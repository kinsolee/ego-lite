import { CdpClient, type RoutedSpace, type RoutedTab } from "./cdp-router.js";
import type { Kernel, Profile } from "./profile-store.js";

export type Owner = "agent" | "user";

/**
 * Ownership as agents read it. An agent's space the user holds after a handoff
 * or by taking control is still the agent's: the harness then records the tab
 * the user left active, and does not treat the space as someone else's.
 */
export type ReportedOwnership = Owner | "agentDelegatedToUser";

/** What the toolbar shows for a space. */
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

/** A toolbar button or the address bar, acting on one space. */
export type ChromeCommand =
  | { type: "newTab" }
  | { type: "closeTab"; targetId: string }
  | { type: "activateTab"; targetId: string }
  | { type: "navigate"; url: string }
  | { type: "back" | "forward" | "reload" | "takeControl" };

/** What a person typed into the address bar, as a loadable URL. */
export function typedUrl(input: string): string {
  const text = input.trim();
  if (/^([a-z][a-z0-9+.-]*:\/\/|about:|data:|file:)/i.test(text)) return text;
  const local = /^(localhost|127\.|\[::1\])/i.test(text);
  return `${local ? "http" : "https"}://${text}`;
}

export interface TaskTab extends RoutedTab {
  /** Out-of-process frames of this tab: frame id to CDP session id. */
  childFrames(): Map<string, string>;
}

/**
 * A task space: one window of tabs that all belong to one profile. Each kernel
 * supplies the window and the tabs; ownership and agent connections are the
 * same for all of them.
 */
export abstract class TaskSpace implements RoutedSpace {
  ownership: Owner;
  agentState = "";
  readonly #clients = new Set<CdpClient>();
  /** The user holds the space only until the agent takes it back. */
  #delegated = false;

  constructor(
    readonly id: number,
    public name: string,
    readonly createdBy: Owner,
  ) {
    this.ownership = createdBy;
  }

  abstract get profile(): Profile;
  abstract tabs(): TaskTab[];
  abstract activeTab(): TaskTab | undefined;
  abstract createTab(url: string): Promise<TaskTab>;
  abstract closeTab(targetId: string): Promise<void>;
  abstract activateTab(targetId: string): Promise<void>;
  abstract browserCommand(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  /** Show the user where the agent is about to act, in viewport CSS pixels. */
  abstract highlightMouse(x: number, y: number): Promise<void>;
  abstract close(): Promise<void>;
  /** Bring titles and URLs up to date when the kernel does not announce them. */
  async refreshTabs(): Promise<void> {}
  /** Follow a tab the user switched to when the kernel does not announce it. */
  async syncActiveTab(): Promise<void> {}
  /** Undo what an agent left switched on in the pages, such as dialog interception. */
  protected abstract releaseAgentState(): void;
  /** The space's name, owner, agent state or tabs changed. */
  protected abstract publish(): void;

  /** Open a CDP view of this space for one agent connection. */
  connect(emit: (message: string) => void): CdpClient {
    const client = new CdpClient(this, emit);
    this.#clients.add(client);
    return client;
  }

  disconnect(client: CdpClient): void {
    this.#clients.delete(client);
    if (this.#clients.size === 0) this.releaseAgentState();
  }

  get reportedOwnership(): ReportedOwnership {
    return this.#delegated ? "agentDelegatedToUser" : this.ownership;
  }

  setOwnership(owner: Owner): void {
    this.#delegated =
      owner === "user" && (this.ownership === "agent" || this.#delegated);
    this.ownership = owner;
    if (owner === "user") {
      this.agentState = "";
      this.releaseAgentState();
    }
    this.publish();
  }

  /** The agent is done with the space and leaves it to the user for good. */
  complete(): void {
    this.setOwnership("user");
    this.#delegated = false;
  }

  setAgentState(state: string): void {
    this.agentState = state;
    this.publish();
  }

  rename(name: string): void {
    this.name = name;
    this.publish();
  }

  protected get clients(): ReadonlySet<CdpClient> {
    return this.#clients;
  }
}

/** Where a kernel registers the spaces it opens, whoever asked for them. */
export interface SpaceHost {
  allocateId(): number;
  add(space: TaskSpace): void;
  remove(space: TaskSpace): void;
  changed(): void;
}

/** One browser engine that can run profiles. */
export interface KernelBackend {
  open(name: string, createdBy: Owner, profile: Profile): Promise<TaskSpace>;
  /** Whether the profile holds a process or windows right now. */
  running(profileId: string): boolean;
  /** Apply an edited profile to whatever the kernel has running for it. */
  update(profile: Profile): Promise<void>;
  /** Close the profile's windows and stop its kernel, keeping its data. */
  release(profileId: string): Promise<void>;
  /** Release the profile and delete everything it stored. */
  erase(profileId: string): Promise<void>;
  stop(): Promise<void>;
}

/** Every open task space, addressed by the numeric id agents use. */
export class TaskSpaces implements SpaceHost {
  readonly #spaces = new Map<number, TaskSpace>();
  readonly #backends = new Map<Kernel, KernelBackend>();
  readonly #onChange: () => void;
  #nextId = 1;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  register(kernel: Kernel, backend: KernelBackend): void {
    this.#backends.set(kernel, backend);
  }

  backend(kernel: Kernel): KernelBackend {
    const backend = this.#backends.get(kernel);
    if (!backend) throw new Error(`The ${kernel} kernel is not available`);
    return backend;
  }

  open(name: string, createdBy: Owner, profile: Profile): Promise<TaskSpace> {
    return this.backend(profile.kernel).open(name, createdBy, profile);
  }

  get(id: number): TaskSpace | undefined {
    return this.#spaces.get(id);
  }

  list(): TaskSpace[] {
    return [...this.#spaces.values()];
  }

  ofProfile(profileId: string): TaskSpace[] {
    return this.list().filter((space) => space.profile.id === profileId);
  }

  running(profile: Profile): boolean {
    return this.backend(profile.kernel).running(profile.id);
  }

  /** Apply an edited profile; a kernel it no longer uses lets go of it. */
  async update(profile: Profile): Promise<void> {
    for (const [kernel, backend] of this.#backends) {
      if (kernel === profile.kernel) await backend.update(profile);
      else await backend.release(profile.id);
    }
  }

  /** Close a profile's windows and stop its kernel, keeping its data. */
  async release(profileId: string): Promise<void> {
    for (const backend of this.#backends.values()) {
      await backend.release(profileId);
    }
  }

  /** Forget everything any kernel stored for a profile. */
  async erase(profileId: string): Promise<void> {
    for (const backend of this.#backends.values()) {
      await backend.erase(profileId);
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(
      [...this.#backends.values()].map((backend) => backend.stop()),
    );
  }

  allocateId(): number {
    return this.#nextId++;
  }

  add(space: TaskSpace): void {
    this.#spaces.set(space.id, space);
    this.#onChange();
  }

  remove(space: TaskSpace): void {
    if (this.#spaces.delete(space.id)) this.#onChange();
  }

  changed(): void {
    this.#onChange();
  }
}
