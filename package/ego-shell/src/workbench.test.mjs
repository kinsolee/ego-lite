import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCommandEnvelope,
  parseLayout,
  Workbench,
} from "../dist/workbench.js";

/** Records what the Workbench does to the window; the last child is on top. */
class FakeWindow {
  children = [];
  bounds = new Map();
  focused = [];
  reveals = 0;
  add(view) {
    this.raise(view);
  }
  raise(view) {
    this.children = this.children.filter((child) => child !== view);
    this.children.push(view);
  }
  remove(view) {
    this.children = this.children.filter((child) => child !== view);
  }
  setBounds(view, rect) {
    this.bounds.set(view, rect);
  }
  focus(view) {
    this.focused.push(view);
  }
  contentSize() {
    return { width: 1200, height: 800 };
  }
  reveal() {
    this.reveals++;
  }
  get top() {
    return this.children.at(-1);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const view = (name) => ({ name });
const RECT = { x: 260, y: 84, width: 940, height: 716 };

function setup() {
  const window = new FakeWindow();
  const ui = view("ui");
  const open = new Map();
  const pushed = [];
  const workbench = new Workbench({
    window,
    ui,
    spaces: {
      list: () => [...open.values()],
      get: (id) => open.get(id),
    },
    push: (state) => pushed.push(state),
  });
  window.add(ui);
  const openSpace = (id, createdBy = "user", profileId = "br") => {
    const space = {
      id,
      createdBy,
      ownership: createdBy,
      profile: { id: profileId },
      state: () => ({ spaceId: id }),
    };
    const stage = workbench.stageFor(id);
    open.set(id, space);
    workbench.changed();
    return { space, stage };
  };
  const close = (id) => {
    open.delete(id);
    workbench.changed();
  };
  return { window, ui, workbench, pushed, openSpace, close };
}

test("only the selected space's front view is on top; every view stays attached and sized", async () => {
  const { window, workbench, openSpace } = setup();
  workbench.layout({ rect: RECT, covered: false });
  const first = openSpace(1);
  const a = view("a");
  first.stage.place(a);
  first.stage.front(a);
  const second = openSpace(2);
  const b = view("b");
  second.stage.place(b);
  second.stage.front(b);
  await tick();

  assert.equal(window.top, b);
  assert.ok(window.children.includes(a));
  assert.deepEqual(window.bounds.get(a), RECT);
  assert.deepEqual(window.bounds.get(b), RECT);
});

test("picking a space raises its front view and focuses it", async () => {
  const { window, workbench, openSpace } = setup();
  const first = openSpace(1);
  const a = view("a");
  first.stage.place(a);
  first.stage.front(a);
  const second = openSpace(2);
  const b = view("b");
  second.stage.place(b);
  second.stage.front(b);
  await tick();

  workbench.select(1);
  assert.equal(window.top, a);
  assert.deepEqual(window.focused, [a]);
});

test("a view an unselected space places does not cover the selected one", async () => {
  const { window, openSpace } = setup();
  const mine = openSpace(1);
  const a = view("a");
  mine.stage.place(a);
  mine.stage.front(a);
  const agents = openSpace(2, "agent");
  await tick();

  const b = view("b");
  agents.stage.place(b);
  agents.stage.front(b);
  await tick();
  assert.equal(window.top, a);
  assert.ok(window.children.includes(b));
});

test("an agent switching tabs in the selected space changes what shows without moving focus", async () => {
  const { window, openSpace } = setup();
  const { stage } = openSpace(1, "agent");
  const a = view("a");
  const b = view("b");
  stage.place(a);
  stage.front(a);
  stage.place(b);
  stage.front(b);
  await tick();
  stage.front(a);

  assert.equal(window.top, a);
  assert.deepEqual(window.focused, []);
});

test("layout resizes every placed view, selected or not", async () => {
  const { window, workbench, openSpace } = setup();
  const first = openSpace(1);
  const a = view("a");
  first.stage.place(a);
  const second = openSpace(2);
  const b = view("b");
  second.stage.place(b);
  await tick();

  workbench.layout({ rect: RECT, covered: false });
  assert.deepEqual(window.bounds.get(a), RECT);
  assert.deepEqual(window.bounds.get(b), RECT);
});

test("views fill the window's content area before the page reports a layout", () => {
  const { window, openSpace } = setup();
  const { stage } = openSpace(1);
  const a = view("a");
  stage.place(a);
  assert.deepEqual(window.bounds.get(a), {
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
  });
});

test("a covering overlay puts the UI on top without resizing any view", async () => {
  const { window, ui, workbench, openSpace } = setup();
  workbench.layout({ rect: RECT, covered: false });
  const { stage } = openSpace(1);
  const a = view("a");
  stage.place(a);
  stage.front(a);
  await tick();

  workbench.layout({ rect: RECT, covered: true });
  assert.equal(window.top, ui);
  assert.deepEqual(window.bounds.get(a), RECT);
  workbench.layout({ rect: RECT, covered: false });
  assert.equal(window.top, a);
});

test("a selected space with no front view, or no selection, shows the UI", async () => {
  const { window, ui, openSpace, close } = setup();
  assert.equal(window.top, ui);
  const { stage } = openSpace(1);
  const a = view("a");
  stage.place(a);
  stage.front(a);
  await tick();
  stage.front(null);
  assert.equal(window.top, ui);
  close(1);
  await tick();
  assert.equal(window.top, ui);
});

test("a closed space's views are removed and its stage does nothing afterwards", async () => {
  const { window, ui, openSpace, close } = setup();
  const { stage } = openSpace(1);
  const a = view("a");
  stage.place(a);
  stage.front(a);
  await tick();

  close(1);
  await tick();
  assert.deepEqual(window.children, [ui]);
  stage.place(view("late"));
  stage.front(a);
  stage.remove(a);
  assert.deepEqual(window.children, [ui]);
});

test("closing the selected space shows the next one", async () => {
  const { window, openSpace, close } = setup();
  const first = openSpace(1);
  const a = view("a");
  first.stage.place(a);
  first.stage.front(a);
  const second = openSpace(2);
  const b = view("b");
  second.stage.place(b);
  second.stage.front(b);
  await tick();

  close(2);
  await tick();
  assert.equal(window.top, a);
});

test("a stage handed out before its space is listed survives until the space appears", async () => {
  const { window, workbench, openSpace } = setup();
  const early = workbench.stageFor(7);
  workbench.changed();
  await tick();
  const a = view("a");
  early.place(a);
  early.front(a);
  openSpace(7);
  await tick();
  assert.equal(window.top, a);
});

test("removing a view of a tab that closed detaches it", async () => {
  const { window, ui, openSpace } = setup();
  const { stage } = openSpace(1);
  const a = view("a");
  const b = view("b");
  stage.place(a);
  stage.place(b);
  stage.front(b);
  await tick();
  stage.remove(b);
  stage.front(a);
  assert.deepEqual(window.children, [ui, a]);
});

test("many changes in one tick push one state", async () => {
  const { workbench, pushed, openSpace } = setup();
  openSpace(1);
  openSpace(2, "agent");
  workbench.changed();
  await tick();
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0], {
    selected: 1,
    space: { spaceId: 1 },
    unseen: [2],
  });
});

test("a space hears when it is selected, once on subscribing and again when picked", async () => {
  const { workbench, openSpace } = setup();
  const first = openSpace(1);
  await tick();
  const heard = [];
  first.stage.onSelected((selected) => heard.push(selected));
  openSpace(2);
  await tick();
  workbench.select(1);
  workbench.select(1);
  assert.deepEqual(heard, [true, false, true, true]);
});

test("a selected space that closes hears that it is no longer selected", async () => {
  const { workbench, openSpace, close } = setup();
  const first = openSpace(1);
  await tick();
  workbench.select(1);
  const heard = [];
  first.stage.onSelected((selected) => heard.push(selected));
  close(1);
  await tick();
  assert.deepEqual(heard, [true, false]);
});

test("reveal shows the window", () => {
  const { window, workbench } = setup();
  workbench.reveal();
  assert.equal(window.reveals, 1);
});

test("layout reports are checked at the boundary", () => {
  assert.deepEqual(parseLayout({ rect: RECT, covered: true }), {
    rect: RECT,
    covered: true,
  });
  assert.deepEqual(
    parseLayout({ rect: { x: 1.4, y: 2.6, width: 10.5, height: 3 } }),
    { rect: { x: 1, y: 3, width: 11, height: 3 }, covered: false },
  );
  for (const bad of [
    null,
    {},
    { rect: { x: -1, y: 0, width: 1, height: 1 } },
    { rect: { x: 0, y: 0, width: Infinity, height: 1 } },
    { rect: { x: 0, y: 0, width: "1", height: 1 } },
  ]) {
    assert.throws(() => parseLayout(bad));
  }
});

test("toolbar commands are checked at the boundary", () => {
  assert.deepEqual(
    parseCommandEnvelope({ spaceId: 3, command: { type: "reload" } }),
    { spaceId: 3, command: { type: "reload" } },
  );
  assert.deepEqual(
    parseCommandEnvelope({
      spaceId: 3,
      command: { type: "navigate", url: "example.com", extra: 1 },
    }),
    { spaceId: 3, command: { type: "navigate", url: "example.com" } },
  );
  for (const bad of [
    null,
    { spaceId: "3", command: { type: "reload" } },
    { spaceId: 3, command: { type: "explode" } },
    { spaceId: 3, command: { type: "navigate" } },
    { spaceId: 3, command: { type: "closeTab", targetId: 4 } },
  ]) {
    assert.throws(() => parseCommandEnvelope(bad));
  }
});
