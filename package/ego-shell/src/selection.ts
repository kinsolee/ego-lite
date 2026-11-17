import type { Owner } from "./task-space.js";

export type SpaceId = number;

/** What the selection needs to know about an open space, in sidebar order. */
export type SpaceRef = {
  readonly id: SpaceId;
  readonly profileId: string;
  readonly createdBy: Owner;
  readonly ownership: Owner;
};

/**
 * Which space the main window shows. `order` is the list of spaces this state
 * was last reconciled against: comparing it with the current list tells a new
 * space from an old one and finds a closed space's neighbours, so nobody has
 * to announce that a space opened or closed.
 */
export type Selection = {
  readonly selected: SpaceId | null;
  readonly order: readonly SpaceRef[];
  /** Spaces waiting for the user: opened or handed over by an agent, not yet looked at. */
  readonly unseen: ReadonlySet<SpaceId>;
};

export const EMPTY_SELECTION: Selection = {
  selected: null,
  order: [],
  unseen: new Set(),
};

/**
 * The space to show once `removed` is gone: the nearest space of the same
 * profile, after it first, else the next space, else the previous one.
 */
export function pickFallbackSelection(
  order: readonly SpaceRef[],
  removed: SpaceId,
  alive: readonly SpaceRef[],
): SpaceId | null {
  const index = order.findIndex((space) => space.id === removed);
  if (index < 0) return alive[0]?.id ?? null;
  const ids = new Set(alive.map((space) => space.id));
  const after = order.slice(index + 1).filter((space) => ids.has(space.id));
  const before = order
    .slice(0, index)
    .filter((space) => ids.has(space.id))
    .reverse();
  const { profileId } = order[index]!;
  const sameProfile = (space: SpaceRef) => space.profileId === profileId;
  return (
    after.find(sameProfile)?.id ??
    before.find(sameProfile)?.id ??
    after[0]?.id ??
    before[0]?.id ??
    null
  );
}

/**
 * Bring the selection in line with the spaces open now. Idempotent. A space
 * the user opened is selected; one an agent opened is selected only when
 * nothing is, and is otherwise flagged unseen, as is an unselected space an
 * agent hands to the user.
 */
export function reconcile(
  previous: Selection,
  spaces: readonly SpaceRef[],
): Selection {
  const before = new Map(previous.order.map((space) => [space.id, space]));
  const ids = new Set(spaces.map((space) => space.id));
  const appeared = spaces.filter((space) => !before.has(space.id));

  let selected = previous.selected;
  if (selected !== null && !ids.has(selected)) {
    selected = pickFallbackSelection(previous.order, selected, spaces);
  }
  const byUser = appeared.filter((space) => space.createdBy === "user");
  if (byUser.length > 0) selected = byUser.at(-1)!.id;
  else if (selected === null) selected = appeared[0]?.id ?? spaces[0]?.id ?? null;

  const unseen = new Set([...previous.unseen].filter((id) => ids.has(id)));
  for (const space of spaces) {
    const was = before.get(space.id);
    const handedOver =
      was?.ownership === "agent" && space.ownership === "user";
    if ((!was && space.createdBy === "agent") || handedOver) {
      unseen.add(space.id);
    }
  }
  if (selected !== null) unseen.delete(selected);
  return { selected, order: spaces, unseen };
}

/** The user picked a space in the sidebar. Unknown ids leave it unchanged. */
export function select(previous: Selection, id: SpaceId): Selection {
  if (!previous.order.some((space) => space.id === id)) return previous;
  const unseen = new Set(previous.unseen);
  unseen.delete(id);
  return { ...previous, selected: id, unseen };
}
