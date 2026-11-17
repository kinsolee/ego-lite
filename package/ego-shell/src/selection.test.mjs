import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_SELECTION,
  pickFallbackSelection,
  reconcile,
  select,
} from "../dist/selection.js";

const space = (id, profileId, createdBy = "user", ownership = createdBy) => ({
  id,
  profileId,
  createdBy,
  ownership,
});

/** Feed the spaces in one at a time, as the shell opens them. */
function opened(...spaces) {
  let selection = EMPTY_SELECTION;
  for (let count = 1; count <= spaces.length; count++) {
    selection = reconcile(selection, spaces.slice(0, count));
  }
  return selection;
}

test("a space the user opens becomes selected", () => {
  const a = space(1, "br");
  const b = space(2, "mx");
  assert.equal(opened(a).selected, 1);
  assert.equal(opened(a, b).selected, 2);
});

test("a space an agent opens does not take the selection and is flagged unseen", () => {
  const mine = space(1, "br");
  const agents = space(2, "br", "agent");
  const selection = opened(mine, agents);
  assert.equal(selection.selected, 1);
  assert.deepEqual([...selection.unseen], [2]);
});

test("a space an agent opens is selected when nothing else is", () => {
  const selection = opened(space(1, "br", "agent"));
  assert.equal(selection.selected, 1);
  assert.deepEqual([...selection.unseen], []);
});

test("when several spaces appear at once the last one the user opened wins", () => {
  const selection = reconcile(EMPTY_SELECTION, [
    space(1, "br"),
    space(2, "br"),
    space(3, "br", "agent"),
  ]);
  assert.equal(selection.selected, 2);
  assert.deepEqual([...selection.unseen], [3]);
});

test("reconcile is idempotent", () => {
  const spaces = [space(1, "br"), space(2, "mx", "agent"), space(3, "br")];
  const once = reconcile(opened(spaces[0]), spaces);
  const twice = reconcile(once, spaces);
  assert.deepEqual(twice.selected, once.selected);
  assert.deepEqual([...twice.unseen], [...once.unseen]);
  assert.deepEqual(twice.order, once.order);
});

test("closing the selected space selects the next space of the same profile", () => {
  const spaces = [space(1, "br"), space(2, "mx"), space(3, "br"), space(4, "br")];
  const before = select(opened(...spaces), 1);
  const after = reconcile(before, spaces.filter((s) => s.id !== 1));
  assert.equal(after.selected, 3);
});

test("closing the selected space falls back to the next space, then the previous one, then nothing", () => {
  const a = space(1, "br");
  const b = space(2, "mx");
  const c = space(3, "ar");
  const middle = select(opened(a, b, c), 2);
  assert.equal(reconcile(middle, [a, c]).selected, 3);
  const last = select(opened(a, b, c), 3);
  assert.equal(reconcile(last, [a, b]).selected, 2);
  assert.equal(reconcile(opened(a), []).selected, null);
});

test("closing a space that is not selected keeps the selection", () => {
  const a = space(1, "br");
  const b = space(2, "mx");
  const c = space(3, "ar");
  const selection = select(opened(a, b, c), 1);
  assert.equal(reconcile(selection, [a, c]).selected, 1);
});

test("removing a profile moves the selection to another profile's space", () => {
  const spaces = [space(1, "br"), space(2, "br"), space(3, "mx")];
  const selection = select(opened(...spaces), 2);
  const after = reconcile(selection, [spaces[2]]);
  assert.equal(after.selected, 3);
  assert.deepEqual(after.order.map((s) => s.id), [3]);
});

test("the user picking a space selects it and clears its unseen flag", () => {
  const selection = opened(space(1, "br"), space(2, "br", "agent"));
  const picked = select(selection, 2);
  assert.equal(picked.selected, 2);
  assert.deepEqual([...picked.unseen], []);
});

test("picking a space that does not exist leaves the selection alone", () => {
  const selection = opened(space(1, "br"));
  assert.equal(select(selection, 99), selection);
});

test("an agent handing an unselected space to the user flags it unseen", () => {
  const mine = space(1, "br");
  const agents = space(2, "br", "agent");
  const selection = opened(mine, agents);
  const seen = select(select(selection, 2), 1);
  assert.deepEqual([...seen.unseen], []);
  const handed = reconcile(seen, [mine, space(2, "br", "agent", "user")]);
  assert.equal(handed.selected, 1);
  assert.deepEqual([...handed.unseen], [2]);
});

test("the fallback prefers the same profile, then the next space, then the previous one", () => {
  const order = [space(1, "br"), space(2, "mx"), space(3, "br"), space(4, "ar")];
  const alive = (ids) => order.filter((s) => ids.includes(s.id));
  assert.equal(pickFallbackSelection(order, 3, alive([1, 2, 4])), 1);
  assert.equal(pickFallbackSelection(order, 2, alive([1, 3, 4])), 3);
  assert.equal(pickFallbackSelection(order, 4, alive([1, 2])), 2);
  assert.equal(pickFallbackSelection(order, 1, []), null);
});
