import assert from "node:assert/strict";
import test from "node:test";

import { AgentApi } from "../dist/agent-api.js";
import { TaskSpace, TaskSpaces } from "../dist/task-space.js";

const PROFILE = {
  id: "br",
  name: "Brazil",
  kernel: "apostate",
  proxy: { scheme: "none" },
  fingerprint: { seed: "seed", locale: "pt-BR", timezone: "America/Recife" },
};

class FakeSpace extends TaskSpace {
  get profile() {
    return PROFILE;
  }
  tabs() {
    return [];
  }
  activeTab() {
    return undefined;
  }
  releaseAgentState() {}
  publish() {}
}

function setup() {
  const spaces = new TaskSpaces(() => {});
  const api = new AgentApi({ profiles: {}, spaces, version: "test" });
  const open = (createdBy) => {
    const space = new FakeSpace(spaces.allocateId(), "orders", createdBy);
    spaces.add(space);
    return space;
  };
  const call = (method, spaceId) => api.call({ id: 1 }, method, [], spaceId);
  const ownership = async (space) =>
    (await call("listTaskSpaces")).taskSpaces.find(
      (listed) => listed.id === space.id,
    ).ownership;
  return { open, call, ownership };
}

test("an agent's space handed to the user is listed as delegated until it is taken back", async () => {
  const { open, call, ownership } = setup();
  const space = open("agent");

  await call("handOffTaskSpace", space.id);
  assert.equal(await ownership(space), "agentDelegatedToUser");
  space.setOwnership("user");
  assert.equal(await ownership(space), "agentDelegatedToUser");

  await call("takeOverTaskSpace", space.id);
  assert.equal(await ownership(space), "agent");
  await call("completeTaskSpace", space.id);
  assert.equal(await ownership(space), "user");
});

test("a space the user opened is the user's", async () => {
  const { open, ownership } = setup();
  assert.equal(await ownership(open("user")), "user");
});
