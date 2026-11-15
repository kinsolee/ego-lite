/**
 * Page snapshot in the text format the ego-browser harness consumes: an
 * indented accessibility tree whose actionable lines carry `[ref=N, ...]`,
 * plus the ref table that maps each N back to a DOM node.
 */

export type SnapshotOptions = {
  scope?: "full_page" | "only_within_viewport" | "subtree";
  /** backendNodeId of the subtree root; only read when scope is `subtree`. */
  root?: number;
  includeActionMarks?: boolean;
  interactiveOnly?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
};

export type SnapshotRef = {
  /** Present only for nodes inside child frames, where backendNodeId may collide. */
  refId?: number;
  backendNodeId: number;
  role: string;
  name: string;
  loc?: string;
  frameId?: string;
};

export type SnapshotResult = { content: string; refs: SnapshotRef[] };

export type SnapshotSource = {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any>;
  /** Out-of-process iframes attached under the tab: frame id to CDP session id. */
  childFrames(): Map<string, string>;
};

type AxValue = { value?: unknown };
type AxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: { name: string; value?: AxValue }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  frameId?: string;
};

type Line = {
  role: string;
  /** Role as the harness's `role:` locator compares it. */
  locatorRole: string;
  name: string;
  backendNodeId?: number;
  /** Set for nodes of child frames; the top document's nodes leave it empty. */
  frameId?: string;
  actionable: boolean;
  details: string[];
  children: Line[];
  locatorUnique: boolean;
};

/** One frame's accessibility tree, read through the CDP session that hosts it. */
type FrameDocument = {
  frameId: string;
  sessionId: string | undefined;
  root?: Line;
  byBackendId: Map<number, Line>;
};

/** Lines by `role` + name across the whole snapshot, to tell unique locators apart. */
type LocatorIndex = Map<string, Line[]>;

const SKIPPED_ROLES = new Set(["inlinetextbox", "linebreak"]);
const CONTAINER_ROLES = new Set([
  "generic",
  "genericcontainer",
  "none",
  "presentation",
]);
const ACTIONABLE_ROLES = new Set([
  "button",
  "canvas",
  "checkbox",
  "colorwell",
  "combobox",
  "date",
  "datetime",
  "disclosuretriangle",
  "iframe",
  "image",
  "inputtime",
  "link",
  "listbox",
  "listboxoption",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "menulistoption",
  "menulistpopup",
  "option",
  "popupbutton",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "textfield",
  "togglebutton",
  "treeitem",
]);
const VALUE_ROLES = new Set([
  "combobox",
  "searchbox",
  "slider",
  "spinbutton",
  "textbox",
  "textfield",
]);
const MAX_DETAIL_LENGTH = 120;
const MAX_LOCATOR_NAME_LENGTH = 80;

export class SnapshotError extends Error {
  readonly error_code = "EGO_SNAPSHOT_FAILED";
}

function plain(value: AxValue | undefined): string {
  const raw = value?.value;
  return raw === undefined || raw === null
    ? ""
    : String(raw).replace(/\s+/g, " ").trim();
}

function displayRole(raw: string): string {
  const role = raw.toLowerCase();
  if (role === "rootwebarea") return "root";
  if (role === "statictext") return "text";
  if (role === "iframe" || role === "iframepresentational") return "iframe";
  if (CONTAINER_ROLES.has(role)) return "container";
  return role.replace(/[^a-z0-9_-]/g, "") || "container";
}

/** Mirrors the harness's role normalization so emitted locators resolve. */
function locatorRole(raw: string): string {
  const role = raw.toLowerCase();
  if (role === "listboxoption") return "option";
  if (role === "textfield") return "textbox";
  return role;
}

function property(node: AxNode, name: string): unknown {
  return node.properties?.find((entry) => entry.name === name)?.value?.value;
}

function details(node: AxNode, role: string): string[] {
  const out: string[] = [];
  const clip = (text: string) =>
    text.length > MAX_DETAIL_LENGTH
      ? `${text.slice(0, MAX_DETAIL_LENGTH)}...`
      : text;
  const url = property(node, "url");
  // A comma or bracket would end the metadata list early for line parsers.
  if (role === "link" && typeof url === "string" && !/[\s,\]]/.test(url)) {
    out.push(`url=${url}`);
  }
  const checked = property(node, "checked");
  if (checked === "true" || checked === true) out.push("checked");
  else if (checked === "mixed") out.push("checked=mixed");
  if (property(node, "disabled") === true) out.push("disabled");
  if (property(node, "selected") === true) out.push("selected");
  if (property(node, "focused") === true) out.push("focused");
  const expanded = property(node, "expanded");
  if (expanded === true) out.push("expanded");
  else if (expanded === false) out.push("collapsed");
  const value = plain(node.value);
  if (value && VALUE_ROLES.has(role)) {
    out.push(`value=${JSON.stringify(clip(value))}`);
  }
  return out;
}

function buildLines(
  nodes: AxNode[],
  frameId: string | undefined,
  locators: LocatorIndex,
): Pick<FrameDocument, "root" | "byBackendId"> {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const byBackendId = new Map<number, Line>();

  const build = (node: AxNode): Line[] => {
    const rawRole = plain(node.role);
    if (SKIPPED_ROLES.has(rawRole.toLowerCase())) return [];
    const children = (node.childIds ?? []).flatMap((id) => {
      const child = byId.get(id);
      return child ? build(child) : [];
    });
    if (node.ignored) return children;

    const role = displayRole(rawRole);
    const name = plain(node.name);
    if (role === "text" && !name) return [];
    const line: Line = {
      role,
      locatorRole: locatorRole(rawRole),
      name,
      backendNodeId: node.backendDOMNodeId,
      frameId,
      actionable:
        node.backendDOMNodeId !== undefined &&
        role !== "root" &&
        role !== "text" &&
        (ACTIONABLE_ROLES.has(role) ||
          property(node, "focusable") === true ||
          // The editable box inside an <input> is not a second target.
          (role !== "container" && property(node, "editable") !== undefined)),
      details: details(node, role),
      // A label that only repeats its parent's name adds length, not meaning.
      children: children.filter(
        (child) => !(child.role === "text" && name && child.name === name),
      ),
      locatorUnique: false,
    };
    // A wrapper that says nothing and holds at most one thing is noise.
    if (
      role === "container" &&
      !name &&
      !line.actionable &&
      line.children.length <= 1
    ) {
      return line.children;
    }
    if (
      node.backendDOMNodeId !== undefined &&
      !byBackendId.has(node.backendDOMNodeId)
    ) {
      byBackendId.set(node.backendDOMNodeId, line);
    }
    const key = `${line.locatorRole}\u0000${String(node.name?.value ?? "")}`;
    locators.set(key, [...(locators.get(key) ?? []), line]);
    return [line];
  };

  const rootNode =
    nodes.find((node) => !node.parentId && plain(node.role)) ?? nodes[0];
  const [root] = rootNode ? build(rootNode) : [];
  return { root, byBackendId };
}

type FrameTree = { frame?: { id?: string }; childFrames?: FrameTree[] };

function frameIds(tree: FrameTree | undefined): string[] {
  if (!tree?.frame?.id) return [];
  return [tree.frame.id, ...(tree.childFrames ?? []).flatMap(frameIds)];
}

/** Every frame document one CDP session hosts: its main frame and same-process children. */
async function loadSession(
  source: SnapshotSource,
  sessionId: string | undefined,
  topFrameId: string,
  locators: LocatorIndex,
): Promise<FrameDocument[]> {
  const { frameTree } = await source.send("Page.getFrameTree", {}, sessionId);
  const documents = await Promise.all(
    frameIds(frameTree).map(async (frameId) => {
      try {
        const { nodes } = await source.send(
          "Accessibility.getFullAXTree",
          { frameId },
          sessionId,
        );
        return {
          frameId,
          sessionId,
          ...buildLines(
            nodes ?? [],
            frameId === topFrameId ? undefined : frameId,
            locators,
          ),
        };
      } catch (error) {
        if (frameId === topFrameId) throw error;
        // A child frame navigated or went away while the snapshot was running.
        return undefined;
      }
    }),
  );
  return documents.filter((document) => document !== undefined);
}

/** Hang each child frame's document under the iframe element that owns it. */
async function attachChildFrames(
  source: SnapshotSource,
  documents: FrameDocument[],
  topFrameId: string,
): Promise<void> {
  const sessions = [
    ...new Set(documents.map((document) => document.sessionId)),
  ];
  for (const child of documents) {
    if (child.frameId === topFrameId || !child.root) continue;
    // The owner element lives in the parent frame's session, which is the
    // child's own session only when both frames share a process.
    for (const sessionId of sessions) {
      let backendNodeId: number;
      try {
        ({ backendNodeId } = await source.send(
          "DOM.getFrameOwner",
          { frameId: child.frameId },
          sessionId,
        ));
      } catch {
        continue;
      }
      const owner = documents
        .filter((document) => document.sessionId === sessionId)
        .map((document) => document.byBackendId.get(backendNodeId))
        .find((line) => line && line !== child.root);
      if (owner && owner.children.length === 0) {
        owner.children.push(child.root);
        break;
      }
    }
  }
}

type Rect = { left: number; top: number; right: number; bottom: number };

async function viewportFilter(
  source: SnapshotSource,
): Promise<(line: Line) => boolean> {
  const [metrics, snapshot] = await Promise.all([
    source.send("Page.getLayoutMetrics"),
    source.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }),
  ]);
  const view = metrics.cssLayoutViewport;
  const viewport: Rect = {
    left: view.pageX,
    top: view.pageY,
    right: view.pageX + view.clientWidth,
    bottom: view.pageY + view.clientHeight,
  };
  const document = snapshot.documents?.[0];
  const boxes = new Map<number, Rect>();
  const backendIds: number[] = document?.nodes?.backendNodeId ?? [];
  const indexes: number[] = document?.layout?.nodeIndex ?? [];
  const bounds: number[][] = document?.layout?.bounds ?? [];
  // DOMSnapshot reports device pixels; the layout viewport is in CSS pixels.
  const scale =
    metrics.cssVisualViewport && metrics.visualViewport
      ? metrics.visualViewport.clientWidth /
          metrics.cssVisualViewport.clientWidth || 1
      : 1;
  indexes.forEach((nodeIndex, layoutIndex) => {
    const [x, y, width, height] = bounds[layoutIndex] ?? [];
    if (!(width > 0 && height > 0)) return;
    boxes.set(backendIds[nodeIndex], {
      left: x / scale,
      top: y / scale,
      right: (x + width) / scale,
      bottom: (y + height) / scale,
    });
  });
  return (line) => {
    const box =
      line.backendNodeId === undefined
        ? undefined
        : boxes.get(line.backendNodeId);
    return Boolean(
      box &&
      box.left < viewport.right &&
      box.right > viewport.left &&
      box.top < viewport.bottom &&
      box.bottom > viewport.top,
    );
  };
}

function prune(line: Line, keep: (line: Line) => boolean): Line | undefined {
  // Child-frame nodes have no box in the top document: they follow their iframe.
  if (line.frameId) return line;
  const own = keep(line);
  if (line.role === "iframe") return own ? line : undefined;
  const children = line.children.flatMap((child) => prune(child, keep) ?? []);
  return own || children.length ? { ...line, children } : undefined;
}

function pruneToActionable(line: Line): Line | undefined {
  const children = line.children.flatMap(
    (child) => pruneToActionable(child) ?? [],
  );
  return line.actionable || children.length || line.role === "root"
    ? { ...line, children }
    : undefined;
}

function stableLocator(line: Line): string | undefined {
  if (!line.locatorUnique || !line.name) return undefined;
  if (line.name.length > MAX_LOCATOR_NAME_LENGTH) return undefined;
  // The locator sits inside `[...]` metadata, so it must not contain its delimiters.
  if (/[[\],"\\]/.test(line.name)) return undefined;
  if (!/^[a-z0-9_-]+$/.test(line.locatorRole)) return undefined;
  return `role:${line.locatorRole}[name=${line.name}]`;
}

function maxBackendId(line: Line): number {
  return line.children.reduce(
    (max, child) => Math.max(max, maxBackendId(child)),
    line.backendNodeId ?? 0,
  );
}

function render(root: Line, options: SnapshotOptions): SnapshotResult {
  const lines: string[] = [];
  const refs: SnapshotRef[] = [];
  const used = new Set<number>();
  let nextFrameRefId = maxBackendId(root) + 1;

  const visit = (line: Line, depth: number) => {
    let text = `${"  ".repeat(depth)}${line.role}`;
    if (line.name) text += ` ${JSON.stringify(line.name)}`;
    if (line.actionable && line.backendNodeId !== undefined) {
      const id = line.frameId ? nextFrameRefId++ : line.backendNodeId;
      if (!used.has(id)) {
        used.add(id);
        const loc =
          options.includeStableLocator === false
            ? undefined
            : stableLocator(line);
        const meta = [
          `ref=${id}`,
          ...(loc ? [`loc=${loc}`] : []),
          ...line.details,
        ];
        text += ` [${meta.join(", ")}]`;
        refs.push({
          ...(line.frameId ? { refId: id } : {}),
          backendNodeId: line.backendNodeId,
          role: line.role,
          name: line.name,
          ...(loc ? { loc } : {}),
          ...(line.frameId ? { frameId: line.frameId } : {}),
        });
      }
    }
    lines.push(text);
    for (const child of line.children) visit(child, depth + 1);
  };
  visit(root, 0);

  let content = lines.join("\n");
  const limit = options.maxResultLength ?? 0;
  if (limit > 0 && content.length > limit) content = content.slice(0, limit);
  return { content, refs };
}

export async function captureSnapshot(
  source: SnapshotSource,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const scope = options.scope ?? "full_page";
  try {
    const { frameTree } = await source.send("Page.getFrameTree");
    const topFrameId: string | undefined = frameTree?.frame?.id;
    if (!topFrameId) throw new SnapshotError("The page has no frame tree");

    const locators: LocatorIndex = new Map();
    const sessions = [undefined, ...new Set(source.childFrames().values())];
    const loaded = await Promise.all(
      sessions.map((sessionId) =>
        loadSession(source, sessionId, topFrameId, locators).catch((error) => {
          if (sessionId === undefined) throw error;
          return [];
        }),
      ),
    );
    const documents = loaded.flat();
    const top = documents.find((document) => document.frameId === topFrameId);
    if (!top?.root)
      throw new SnapshotError("The page has no accessibility tree");
    await attachChildFrames(source, documents, topFrameId);
    for (const lines of locators.values()) {
      if (lines.length === 1) lines[0].locatorUnique = true;
    }

    let root: Line | undefined = top.root;
    if (scope === "subtree") {
      const target = options.root;
      // A backend id is unique only within one frame's process, and the
      // binding is given no frame to tell matches apart.
      const matches =
        typeof target === "number"
          ? documents.flatMap(
              (document) => document.byBackendId.get(target) ?? [],
            )
          : [];
      if (matches.length > 1) {
        throw new SnapshotError(
          `Snapshot root ${target} is ambiguous: it names a node in ${matches.length} frames`,
        );
      }
      root = matches[0];
      if (!root) {
        throw new SnapshotError(`Snapshot root not found: ${options.root}`);
      }
    } else if (scope === "only_within_viewport") {
      const keep = await viewportFilter(source);
      root = prune(top.root, keep) ?? { ...top.root, children: [] };
    }
    if (options.interactiveOnly) {
      root = pruneToActionable(root) ?? { ...root, children: [] };
    }
    return render(root, options);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(
      `Snapshot failed: ${(error as Error)?.message ?? error}`,
    );
  }
}
