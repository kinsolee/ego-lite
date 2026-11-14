import { CdpClient, type RoutedSpace, type RoutedTab } from "./cdp-router.js";
import type { Kernel, Profile } from "./profile-store.js";

export type Owner = "agent" | "user";

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
  /** Show the user where the agent is about to act, in viewport CSS pixels. */
  abstract highlightMouse(x: number, y: number): Promise<void>;
  abstract close(): Promise<void>;
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

  setOwnership(owner: Owner): void {
    this.ownership = owner;
    if (owner === "user") {
      this.agentState = "";
      this.releaseAgentState();
    }
    this.publish();
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
