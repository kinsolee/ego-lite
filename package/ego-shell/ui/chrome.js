const tabs = document.getElementById("tabs");
const address = document.getElementById("address");
const profile = document.getElementById("profile");
const owner = document.getElementById("owner");
const takeControl = document.getElementById("take-control");
const back = document.getElementById("back");
const forward = document.getElementById("forward");

const send = (command) => window.shell.request("space:command", command);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(state) {
  const active = state.tabs.find((tab) => tab.active);
  tabs.replaceChildren(
    ...state.tabs.map((tab) => {
      const node = element("div", tab.active ? "tab active" : "tab");
      node.onclick = () =>
        send({ type: "activateTab", targetId: tab.targetId });
      const close = element("button", "close", "×");
      close.onclick = (event) => {
        event.stopPropagation();
        send({ type: "closeTab", targetId: tab.targetId });
      };
      const label = tab.loading
        ? "Loading…"
        : tab.title || tab.url || "New tab";
      node.append(element("span", "title", label), close);
      return node;
    }),
    Object.assign(element("button", "new", "+"), {
      onclick: () => send({ type: "newTab" }),
    }),
  );
  // Do not overwrite what the person is typing.
  if (document.activeElement !== address) address.value = active?.url ?? "";
  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
  profile.textContent = `${state.profileName} · ${state.proxy}`;
  const agent = state.ownership === "agent";
  owner.className = agent ? "badge agent" : "badge";
  owner.textContent = agent
    ? state.agentState || "Agent in control"
    : "You are in control";
  takeControl.hidden = !agent;
}

back.onclick = () => send({ type: "back" });
forward.onclick = () => send({ type: "forward" });
document.getElementById("reload").onclick = () => send({ type: "reload" });
takeControl.onclick = () => send({ type: "takeControl" });
document.getElementById("address-form").onsubmit = (event) => {
  event.preventDefault();
  address.blur();
  send({ type: "navigate", url: address.value });
};

window.shell.on("space:state", render);
