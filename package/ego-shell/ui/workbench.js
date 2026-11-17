const list = document.getElementById("profiles");
const sidebarError = document.getElementById("sidebar-error");
const editor = document.getElementById("editor");
const form = document.getElementById("profile-form");
const formTitle = document.getElementById("form-title");
const formError = document.getElementById("form-error");
const chrome = document.getElementById("chrome");
const tabs = document.getElementById("tabs");
const address = document.getElementById("address");
const spaceProfile = document.getElementById("space-profile");
const owner = document.getElementById("owner");
const takeControl = document.getElementById("take-control");
const back = document.getElementById("back");
const forward = document.getElementById("forward");
const stage = document.getElementById("stage");
const emptyText = document.getElementById("empty-text");
const emptyAction = document.getElementById("empty-action");
const proxyFields = ["host", "port", "username", "password"];
const kernelNames = { electron: "Built in", apostate: "Apostate" };

/** Id of the profile being edited, or null while creating one. */
let editingId = null;
let profiles = [];
let workbench = { selected: null, space: null, unseen: [] };

async function request(channel, payload) {
  const reply = await window.shell.request(channel, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, onclick, className = "") {
  return Object.assign(element("button", className, text), {
    type: "button",
    onclick,
  });
}

function describeProxy(proxy) {
  if (proxy.scheme === "none") return "No proxy";
  const user = proxy.username ? `${proxy.username}@` : "";
  return `${proxy.scheme}://${user}${proxy.host}:${proxy.port}`;
}

async function run(action, errorNode = sidebarError) {
  errorNode.textContent = "";
  try {
    await action();
  } catch (error) {
    errorNode.textContent = error.message;
  }
}

/** Tell the shell where web pages go, and whether an overlay covers them. */
function reportLayout() {
  const { x, y, width, height } = stage.getBoundingClientRect();
  request("workbench:layout", {
    rect: { x, y, width, height },
    covered: !editor.hidden,
  }).catch(() => {});
}

function command(spaceId, command) {
  return run(() => request("space:command", { spaceId, command }));
}

function kernelOf(spaceId) {
  return profiles.find((profile) =>
    profile.openSpaces.some((space) => space.id === spaceId),
  )?.kernel;
}

function renderProfiles() {
  const unseen = new Set(workbench.unseen);
  list.replaceChildren(
    ...profiles.map((profile) => {
      const row = element("div", "profile");
      row.dataset.profileId = profile.id;
      const head = element("div", "head");
      head.append(
        element("div", "name", profile.name),
        element("span", "badge", kernelNames[profile.kernel]),
        element(
          "span",
          profile.running ? "badge running" : "badge",
          profile.running ? "Running" : "Stopped",
        ),
      );
      const details = element(
        "div",
        "muted",
        `${describeProxy(profile.proxy)} · ${profile.fingerprint.locale} · ${profile.fingerprint.timezone}`,
      );
      const spaces = element("div", "spaces");
      for (const space of profile.openSpaces) {
        const classes = ["space"];
        if (space.id === workbench.selected) classes.push("selected");
        const line = element("div", classes.join(" "));
        line.dataset.spaceId = space.id;
        line.onclick = () =>
          run(() => request("space:select", { spaceId: space.id }));
        line.append(element("span", "title", `${space.id} · ${space.name}`));
        if (unseen.has(space.id)) line.append(element("span", "badge unseen", "New"));
        line.append(
          element(
            "span",
            space.ownership === "agent" ? "badge agent" : "badge",
            space.ownership === "agent" ? "Agent" : "You",
          ),
        );
        const close = button("×", (event) => {
          event.stopPropagation();
          run(() => request("space:close", { spaceId: space.id }));
        }, "close");
        close.dataset.action = "close";
        line.append(close);
        spaces.append(line);
      }
      const actions = element("div", "actions");
      const open = button(profile.running ? "New space" : "Start", () =>
        run(() => request("profiles:open", { id: profile.id })),
        "primary",
      );
      open.dataset.action = "open";
      actions.append(open);
      if (profile.running) {
        const stop = button("Stop", () =>
          run(() => request("profiles:stop", { id: profile.id })),
        );
        stop.dataset.action = "stop";
        actions.append(stop);
      }
      const change = button("Edit", () => edit(profile));
      change.dataset.action = "edit";
      actions.append(change);
      if (!profile.isDefault) {
        const remove = button("Delete", () => {
          if (!confirm(`Delete ${profile.name} and all its browsing data?`)) return;
          run(() => request("profiles:remove", { id: profile.id }));
        });
        remove.dataset.action = "delete";
        actions.append(remove);
      }
      row.append(head, details, spaces, actions);
      return row;
    }),
  );
}

function renderToolbar(state) {
  chrome.classList.toggle("idle", !state);
  if (!state) return;
  const send = (body) => command(state.spaceId, body);
  const active = state.tabs.find((tab) => tab.active);
  tabs.replaceChildren(
    ...state.tabs.map((tab) => {
      const node = element("div", tab.active ? "tab active" : "tab");
      node.onclick = () => send({ type: "activateTab", targetId: tab.targetId });
      const close = button("×", (event) => {
        event.stopPropagation();
        send({ type: "closeTab", targetId: tab.targetId });
      }, "close");
      const label = tab.loading ? "Loading…" : tab.title || tab.url || "New tab";
      node.append(element("span", "title", label), close);
      return node;
    }),
    button("+", () => send({ type: "newTab" }), "new"),
  );
  // Do not overwrite what the person is typing.
  if (document.activeElement !== address) address.value = active?.url ?? "";
  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
  spaceProfile.textContent = `${state.profileName} · ${state.proxy}`;
  const agent = state.ownership === "agent";
  owner.className = agent ? "badge agent" : "badge";
  owner.textContent = agent
    ? state.agentState || "Agent in control"
    : "You are in control";
  takeControl.hidden = !agent;
}

/** What the content area says when no web page covers it. */
function renderEmpty(state) {
  emptyAction.hidden = true;
  if (!state) {
    emptyText.textContent = profiles.some((profile) => profile.openSpaces.length)
      ? "Pick a task space on the left."
      : "Start a profile on the left to open a task space.";
    return;
  }
  if (kernelOf(state.spaceId) === "apostate") {
    emptyText.textContent = "This space runs in its own Apostate window.";
    emptyAction.textContent = "Show window";
    emptyAction.onclick = () =>
      run(() => request("space:select", { spaceId: state.spaceId }));
    emptyAction.hidden = false;
    return;
  }
  emptyText.textContent = "No tabs are open in this space.";
  emptyAction.textContent = "New tab";
  emptyAction.onclick = () => command(state.spaceId, { type: "newTab" });
  emptyAction.hidden = false;
}

function render() {
  renderProfiles();
  renderToolbar(workbench.space);
  renderEmpty(workbench.space);
}

async function refresh() {
  profiles = await request("profiles:list");
  render();
}

back.onclick = () => command(workbench.space.spaceId, { type: "back" });
forward.onclick = () => command(workbench.space.spaceId, { type: "forward" });
document.getElementById("reload").onclick = () =>
  command(workbench.space.spaceId, { type: "reload" });
takeControl.onclick = () =>
  command(workbench.space.spaceId, { type: "takeControl" });
document.getElementById("address-form").onsubmit = (event) => {
  event.preventDefault();
  address.blur();
  command(workbench.space.spaceId, { type: "navigate", url: address.value });
};

function syncProxyFields() {
  const disabled = form.elements.scheme.value === "none";
  for (const name of proxyFields) form.elements[name].disabled = disabled;
}

function syncKernelFields() {
  // An Apostate persona decides its own user agent; the store refuses one.
  const apostate = form.elements.kernel.value === "apostate";
  form.elements.userAgent.disabled = apostate;
  form.elements.userAgent.placeholder = apostate
    ? "Not supported by the Apostate kernel: its persona sets it"
    : "Default for this browser";
}

function showEditor(shown) {
  editor.hidden = !shown;
  reportLayout();
}

function edit(profile) {
  editingId = profile?.id ?? null;
  formTitle.textContent = profile ? `Edit ${profile.name}` : "New profile";
  formError.textContent = "";
  form.reset();
  if (profile) {
    const { proxy, fingerprint } = profile;
    form.elements.name.value = profile.name;
    form.elements.kernel.value = profile.kernel;
    form.elements.scheme.value = proxy.scheme;
    form.elements.host.value = proxy.host ?? "";
    form.elements.port.value = proxy.port ?? "";
    form.elements.username.value = proxy.username ?? "";
    form.elements.password.placeholder = proxy.hasPassword
      ? "Unchanged unless you type a new one"
      : "";
    form.elements.locale.value = fingerprint.locale;
    form.elements.timezone.value = fingerprint.timezone;
    form.elements.userAgent.value = fingerprint.userAgent ?? "";
  } else {
    form.elements.password.placeholder = "";
  }
  syncProxyFields();
  syncKernelFields();
  showEditor(true);
}

function draft() {
  const value = (name) => form.elements[name].value.trim();
  const scheme = value("scheme");
  const password = form.elements.password.value;
  return {
    name: value("name"),
    kernel: value("kernel"),
    proxy:
      scheme === "none"
        ? { scheme }
        : {
            scheme,
            host: value("host"),
            port: Number(value("port")),
            username: value("username") || undefined,
            // Left empty while editing, the stored password is kept.
            password: password || undefined,
          },
    fingerprint: {
      locale: value("locale") || undefined,
      timezone: value("timezone") || undefined,
      userAgent: form.elements.userAgent.disabled
        ? undefined
        : value("userAgent") || undefined,
    },
  };
}

const kernelStatus = document.getElementById("kernel-status");
const kernelInstall = document.getElementById("kernel-install");

function megabytes(bytes) {
  return `${Math.round(bytes / 1e6)} MB`;
}

async function refreshKernel() {
  const status = await request("kernel:status");
  const name = `Apostate ${status.version ?? ""}`.trim();
  const text = {
    missing: () => `${name} kernel is not installed.`,
    installing: () =>
      `Downloading ${name}: ${megabytes(status.received)}` +
      (status.total ? ` of ${megabytes(status.total)}` : ""),
    installed: () => `${name} kernel is installed.`,
    failed: () => `${name} kernel could not be installed: ${status.error}`,
    unavailable: () => status.error,
  }[status.state]();
  kernelStatus.textContent = text;
  kernelInstall.hidden = !["missing", "failed"].includes(status.state);
  kernelInstall.textContent =
    status.state === "failed" ? "Try again" : "Install Apostate";
}

// The download is about 160 MB from the Apostate release on GitHub.
kernelInstall.onclick = () => {
  kernelInstall.hidden = true;
  request("kernel:install").catch(() => {});
};

form.elements.scheme.onchange = syncProxyFields;
form.elements.kernel.onchange = syncKernelFields;
document.getElementById("new-profile").onclick = () => edit(null);
document.getElementById("form-cancel").onclick = () => showEditor(false);
form.onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    await request("profiles:save", { id: editingId, draft: draft() });
    showEditor(false);
  }, formError);
};

new ResizeObserver(reportLayout).observe(stage);
window.shell.on("profiles:changed", () => void refresh());
window.shell.on("kernel:changed", () => void refreshKernel());
window.shell.on("workbench:state", (state) => {
  workbench = state;
  render();
});
void refreshKernel();
void refresh();
