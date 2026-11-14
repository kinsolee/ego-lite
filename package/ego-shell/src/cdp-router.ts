import { randomBytes } from "node:crypto";

export type TargetInfo = {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerId?: string;
  parentFrameId?: string;
  browserContextId?: string;
};

export type ChildTarget = {
  sessionId: string;
  /** Session that reported the child; empty for children of the tab itself. */
  parentSessionId?: string;
  targetInfo: TargetInfo;
};

/**
 * How a kernel attaches to a tab's out-of-process frames. They start paused so
 * the kernel can finish setting them up before any of their script runs.
 */
export const IFRAME_AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: "iframe" }],
};

export interface RoutedTab {
  readonly targetId: string;
  targetInfo(): TargetInfo;
  /** Send to the tab, or to one of its out-of-process iframes by session id. */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  childTargets(): ChildTarget[];
}

export interface RoutedSpace {
  tabs(): RoutedTab[];
  createTab(url: string): Promise<RoutedTab>;
  closeTab(targetId: string): Promise<void>;
  activateTab(targetId: string): Promise<void>;
}

type CdpRequest = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type Outcome = { result: unknown; afterReply?: () => void };

// The harness recognises these two messages to recover from a lost session or target.
const SESSION_NOT_FOUND = "Session with given id not found.";
const TARGET_NOT_FOUND = "No target with given id found";

/**
 * One agent connection's view of one task space, speaking the browser-level
 * CDP dialect the harness expects.
 *
 * Electron exposes one debugger session per tab and no browser endpoint, so
 * the `Target.*` commands are answered here: attaching hands out a session id
 * private to this client, and tab events are re-stamped with it. Iframe
 * auto-attach belongs to the shell (it applies the profile's overrides before
 * the frame runs), so a client's `Target.setAutoAttach` replays the children
 * that already exist instead of reaching Chromium.
 */
export class CdpClient {
  readonly #space: RoutedSpace;
  readonly #emit: (message: string) => void;
  readonly #sessions = new Map<string, RoutedTab>();
  #discovering = false;

  constructor(space: RoutedSpace, emit: (message: string) => void) {
    this.#space = space;
    this.#emit = emit;
  }

  async handle(raw: string): Promise<void> {
    let request: CdpRequest;
    try {
      request = JSON.parse(raw);
    } catch {
      return;
    }
    const session = request.sessionId ? { sessionId: request.sessionId } : {};
    try {
      const outcome = await this.#dispatch(request);
      this.#send({ id: request.id, result: outcome.result ?? {}, ...session });
      outcome.afterReply?.();
    } catch (error) {
      this.#send({
        id: request.id,
        error: {
          code: -32000,
          message: (error as Error)?.message ?? String(error),
        },
        ...session,
      });
    }
  }

  /** Forward an event from a tab or, with `childSessionId`, from one of its iframes. */
  tabEvent(
    tab: RoutedTab,
    method: string,
    params: unknown,
    childSessionId?: string,
  ): void {
    for (const [sessionId, attached] of this.#sessions) {
      if (attached !== tab) continue;
      this.#send({ method, params, sessionId: childSessionId ?? sessionId });
      if (childSessionId) return;
    }
  }

  tabCreated(tab: RoutedTab): void {
    if (!this.#discovering) return;
    this.#send({
      method: "Target.targetCreated",
      params: { targetInfo: tab.targetInfo() },
    });
  }

  tabChanged(tab: RoutedTab): void {
    if (!this.#discovering) return;
    this.#send({
      method: "Target.targetInfoChanged",
      params: { targetInfo: tab.targetInfo() },
    });
  }

  tabDestroyed(tab: RoutedTab): void {
    for (const [sessionId, attached] of this.#sessions) {
      if (attached !== tab) continue;
      this.#sessions.delete(sessionId);
      this.#send({
        method: "Target.detachedFromTarget",
        params: { sessionId, targetId: tab.targetId },
      });
    }
    if (!this.#discovering) return;
    this.#send({
      method: "Target.targetDestroyed",
      params: { targetId: tab.targetId },
    });
  }

  /** Tabs this client still holds a session on. */
  attachedTabs(): RoutedTab[] {
    return [...new Set(this.#sessions.values())];
  }

  #send(message: unknown): void {
    this.#emit(JSON.stringify(message));
  }

  async #dispatch(request: CdpRequest): Promise<Outcome> {
    const method = String(request.method ?? "");
    const params = request.params ?? {};
    const sessionId = request.sessionId;
    if (!sessionId) return this.#browserLevel(method, params);

    const tab = this.#sessions.get(sessionId);
    const owner =
      tab ??
      this.#space
        .tabs()
        .find((candidate) =>
          candidate
            .childTargets()
            .some((child) => child.sessionId === sessionId),
        );
    if (!owner) throw new Error(SESSION_NOT_FOUND);

    if (method === "Target.setAutoAttach") {
      const parent = tab ? undefined : sessionId;
      return {
        result: {},
        afterReply: () => {
          for (const child of owner.childTargets()) {
            if (child.parentSessionId !== parent) continue;
            this.#send({
              method: "Target.attachedToTarget",
              params: {
                sessionId: child.sessionId,
                targetInfo: child.targetInfo,
                waitingForDebugger: false,
              },
              sessionId,
            });
          }
        },
      };
    }
    if (method.startsWith("Target.")) return this.#browserLevel(method, params);
    return {
      result: await owner.send(method, params, tab ? undefined : sessionId),
    };
  }

  async #browserLevel(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Outcome> {
    const tabs = this.#space.tabs();
    const targetId = String(params.targetId ?? "");
    const tab = tabs.find((candidate) => candidate.targetId === targetId);
    const children = () =>
      tabs.flatMap((candidate) => candidate.childTargets());

    switch (method) {
      case "Target.attachToTarget": {
        if (tab) {
          const sessionId = randomBytes(16).toString("hex").toUpperCase();
          this.#sessions.set(sessionId, tab);
          return { result: { sessionId } };
        }
        const child = children().find(
          (candidate) => candidate.targetInfo.targetId === targetId,
        );
        if (!child) throw new Error(TARGET_NOT_FOUND);
        return { result: { sessionId: child.sessionId } };
      }
      case "Target.detachFromTarget":
        this.#sessions.delete(String(params.sessionId ?? ""));
        return { result: {} };
      case "Target.getTargets":
        return {
          result: {
            targetInfos: [
              ...tabs.map((candidate) => candidate.targetInfo()),
              ...children().map((child) => child.targetInfo),
            ],
          },
        };
      case "Target.getTargetInfo": {
        const info =
          tab?.targetInfo() ??
          children().find(
            (candidate) => candidate.targetInfo.targetId === targetId,
          )?.targetInfo;
        if (!info) throw new Error(TARGET_NOT_FOUND);
        return { result: { targetInfo: info } };
      }
      case "Target.setDiscoverTargets":
        this.#discovering = params.discover !== false;
        return {
          result: {},
          afterReply: () => {
            if (!this.#discovering) return;
            for (const candidate of this.#space.tabs()) {
              this.tabCreated(candidate);
            }
          },
        };
      case "Target.setAutoAttach":
        return { result: {} };
      case "Target.createTarget": {
        const created = await this.#space.createTab(
          String(params.url ?? "about:blank"),
        );
        return { result: { targetId: created.targetId } };
      }
      case "Target.closeTarget":
        if (!tab) throw new Error(TARGET_NOT_FOUND);
        await this.#space.closeTab(targetId);
        return { result: { success: true } };
      case "Target.activateTarget":
        if (!tab) throw new Error(TARGET_NOT_FOUND);
        await this.#space.activateTab(targetId);
        return { result: {} };
      default:
        throw new Error(`'${method}' wasn't found`);
    }
  }
}
