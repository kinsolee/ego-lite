import {
  EgoError,
  type AgentConnection,
  type AgentHandlers,
} from "./agent-server.js";
import type { CdpClient } from "./cdp-router.js";
import { DEFAULT_PROFILE_ID, type ProfileStore } from "./profile-store.js";
import { captureSnapshot, type SnapshotOptions } from "./snapshot.js";
import type { TaskSpace, TaskSpaces } from "./task-space.js";

// The only reason key this shell produces; the harness maps it to guidance.
const USER_CONTROL_REASON = "manual_takeover";

function invalid(message: string): EgoError {
  return new EgoError(message, "EGO_INVALID_ARGUMENT");
}

/**
 * The `globalThis.ego` contract of docs/native-bindings-api.md, served to
 * agents over the bridge. Return strings and error codes follow that document.
 */
export class AgentApi implements AgentHandlers {
  readonly #profiles: ProfileStore;
  readonly #spaces: TaskSpaces;
  readonly #version: string;
  readonly #clients = new Map<number, Map<number, CdpClient>>();

  constructor(options: {
    profiles: ProfileStore;
    spaces: TaskSpaces;
    version: string;
  }) {
    this.#profiles = options.profiles;
    this.#spaces = options.spaces;
    this.#version = options.version;
  }

  async call(
    _connection: AgentConnection,
    method: string,
    args: unknown[],
    spaceId: number | undefined,
  ): Promise<unknown> {
    switch (method) {
      case "getBrowserVersion":
        return { currentVersion: this.#version, updateAvailable: false };
      case "listProfiles":
        return {
          profiles: this.#profiles.list().map((profile) => ({
            id: profile.id,
            name: profile.name,
            isDefault: profile.id === DEFAULT_PROFILE_ID,
          })),
        };
      case "listTaskSpaces":
        await Promise.all(
          this.#spaces.list().map((space) => space.refreshTabs()),
        );
        return {
          taskSpaces: this.#spaces.list().map((space) => ({
            taskId: space.name,
            id: space.id,
            name: space.name,
            createdBy: space.createdBy,
            ownership: space.reportedOwnership,
            profileId: space.profile.id,
            profileName: space.profile.name,
            recentTabTitles: space
              .tabs()
              .map((tab) => tab.targetInfo().title)
              .filter(Boolean),
          })),
        };
      case "createTaskSpace":
        return this.#createTaskSpace(args[0], args[1]);
      case "claimTaskSpace":
        return this.#claimTaskSpace(args[0], args[1]);
      case "takeOverTaskSpace": {
        const space = this.#selected(spaceId);
        space.setOwnership("agent");
        return `${space.id} has been taken over by the agent.`;
      }
    }

    const space = this.#controlled(spaceId);
    switch (method) {
      case "createTab": {
        const url = args[0] === undefined ? "about:blank" : args[0];
        if (typeof url !== "string") throw invalid("createTab expects a URL");
        const tab = await space.createTab(url);
        return { ...tab.targetInfo(), url };
      }
      case "listTabs": {
        await space.refreshTabs();
        const active = space.activeTab();
        return {
          tabs: space.tabs().map((tab, index) => {
            const { targetId, url, title } = tab.targetInfo();
            return { index, targetId, url, title, active: tab === active };
          }),
        };
      }
      case "snapshot": {
        const tab = space.activeTab();
        if (!tab) {
          throw new EgoError(
            "The task space has no open tab",
            "EGO_WEB_CONTENTS_UNAVAILABLE",
          );
        }
        return captureSnapshot(
          {
            send: (name, params, sessionId) =>
              tab.send(name, params, sessionId),
            childFrames: () => tab.childFrames(),
          },
          (args[0] ?? {}) as SnapshotOptions,
        ).catch((error) => {
          if (error?.error_code) throw error;
          throw new EgoError(
            String(error?.message ?? error),
            "EGO_SNAPSHOT_FAILED",
          );
        });
      }
      case "closeTaskSpace":
        await space.close();
        return `${space.id} task space closed.`;
      case "completeTaskSpace":
        space.complete();
        return `${space.id} task space completed.`;
      case "handOffTaskSpace":
        space.setOwnership("user");
        return `${space.id} has been handed off to the user.`;
      case "setAgentTaskState":
        if (typeof args[0] !== "string") {
          throw invalid("setAgentTaskState expects a string");
        }
        space.setAgentState(args[0]);
        return `${space.id} state updated.`;
      case "animationHighlightMouseToPosition":
        if (typeof args[0] !== "number" || typeof args[1] !== "number") {
          throw invalid("animationHighlightMouseToPosition expects x and y");
        }
        await space.highlightMouse(args[0], args[1]);
        return `${space.id} mouse highlight shown.`;
      default:
        throw new EgoError(
          `Unknown ego method: ${method}`,
          "EGO_OPERATION_FAILED",
        );
    }
  }

  cdp(
    connection: AgentConnection,
    spaceId: number | undefined,
    message: string,
  ): void {
    let space: TaskSpace;
    try {
      space = this.#controlled(spaceId);
    } catch (error) {
      connection.sendCdpError(message, (error as EgoError).error_code);
      return;
    }
    let clients = this.#clients.get(connection.id);
    if (!clients) {
      clients = new Map();
      this.#clients.set(connection.id, clients);
    }
    let client = clients.get(space.id);
    if (!client) {
      client = space.connect((payload) => connection.sendCdp(payload));
      clients.set(space.id, client);
    }
    void client.handle(message);
  }

  closed(connection: AgentConnection): void {
    const clients = this.#clients.get(connection.id);
    this.#clients.delete(connection.id);
    for (const [spaceId, client] of clients ?? []) {
      this.#spaces.get(spaceId)?.disconnect(client);
    }
  }

  async #createTaskSpace(name: unknown, profileId: unknown): Promise<unknown> {
    if (typeof name !== "string" || !name.trim()) {
      throw invalid("createTaskSpace expects a name");
    }
    if (profileId !== undefined && typeof profileId !== "string") {
      throw invalid("createTaskSpace expects profileId to be a string");
    }
    const profile = this.#profiles.get(profileId || DEFAULT_PROFILE_ID);
    if (!profile) {
      throw new EgoError("Profile not found", "EGO_PROFILE_NOT_FOUND");
    }
    const space = await this.#spaces.open(name, "agent", profile);
    return { taskId: space.name, id: space.id, name: space.name };
  }

  #claimTaskSpace(id: unknown, name: unknown): unknown {
    if (typeof id !== "number") throw invalid("claimTaskSpace expects an id");
    if (name !== undefined && typeof name !== "string") {
      throw invalid("claimTaskSpace expects name to be a string");
    }
    const space = this.#spaces.get(id);
    if (!space) {
      throw new EgoError(
        `Task space not found: ${id}`,
        "EGO_TASK_SPACE_NOT_FOUND",
      );
    }
    if (name?.trim()) space.rename(name);
    space.setOwnership("agent");
    return { taskId: space.name, id: space.id, name: space.name };
  }

  #selected(spaceId: number | undefined): TaskSpace {
    if (spaceId === undefined || spaceId === null) {
      throw new EgoError(
        "Task space not selected",
        "EGO_TASK_SPACE_NOT_SELECTED",
      );
    }
    const space = this.#spaces.get(spaceId);
    if (!space) {
      throw new EgoError(
        `Task space not found: ${spaceId}`,
        "EGO_TASK_SPACE_NOT_FOUND",
      );
    }
    return space;
  }

  #controlled(spaceId: number | undefined): TaskSpace {
    const space = this.#selected(spaceId);
    if (space.ownership !== "agent") {
      throw new EgoError(USER_CONTROL_REASON, "EGO_TASK_SPACE_USER_IN_CONTROL");
    }
    return space;
  }
}
