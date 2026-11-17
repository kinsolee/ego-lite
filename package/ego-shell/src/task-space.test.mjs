import assert from "node:assert/strict";
import test from "node:test";

import { TaskSpace } from "../dist/task-space.js";

/** A space whose kernel only records what the toolbar asked of it. */
class RecordingSpace extends TaskSpace {
  calls = [];
  #tabs = [];
  get profile() {
    return { id: "br", name: "Brazil", proxy: { scheme: "none" } };
  }
  tabs() {
    return [...this.#tabs];
  }
  activeTab() {
    return this.#tabs.at(-1);
  }
  async createTab(url) {
    this.calls.push(["createTab", url]);
    const tab = { targetId: `t${this.#tabs.length + 1}` };
    this.#tabs.push(tab);
    return tab;
  }
  async closeTab(targetId) {
    this.calls.push(["closeTab", targetId]);
  }
  async activateTab(targetId) {
    this.calls.push(["activateTab", targetId]);
  }
  async navigate(url) {
    this.calls.push(["navigate", url]);
  }
  async back() {
    this.calls.push(["back"]);
  }
  async forward() {
    this.calls.push(["forward"]);
  }
  async reload() {
    this.calls.push(["reload"]);
  }
  releaseAgentState() {}
  publish() {}
}

test("the address bar opens a tab when the space has none, then loads in the active tab", async () => {
  const space = new RecordingSpace(1, "orders", "user");
  await space.command({ type: "navigate", url: "127.0.0.1:8080/a" });
  await space.command({ type: "navigate", url: " example.com " });
  await space.command({ type: "navigate", url: "about:blank" });
  assert.deepEqual(space.calls, [
    ["createTab", "http://127.0.0.1:8080/a"],
    ["navigate", "https://example.com"],
    ["navigate", "about:blank"],
  ]);
});

test("toolbar buttons reach the space's tabs and history", async () => {
  const space = new RecordingSpace(1, "orders", "user");
  for (const command of [
    { type: "newTab" },
    { type: "activateTab", targetId: "t1" },
    { type: "back" },
    { type: "forward" },
    { type: "reload" },
    { type: "closeTab", targetId: "t1" },
  ]) {
    await space.command(command);
  }
  assert.deepEqual(space.calls, [
    ["createTab", "about:blank"],
    ["activateTab", "t1"],
    ["back"],
    ["forward"],
    ["reload"],
    ["closeTab", "t1"],
  ]);
});

test("take control gives an agent's space to the user", async () => {
  const space = new RecordingSpace(1, "orders", "agent");
  await space.command({ type: "takeControl" });
  assert.equal(space.ownership, "user");
  assert.equal(space.reportedOwnership, "agentDelegatedToUser");
});
