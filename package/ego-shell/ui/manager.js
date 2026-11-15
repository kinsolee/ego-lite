const list = document.getElementById("profiles");
const form = document.getElementById("profile-form");
const formTitle = document.getElementById("form-title");
const formError = document.getElementById("form-error");
const proxyFields = ["host", "port", "username", "password"];
const kernelNames = { electron: "Built in", apostate: "Apostate" };

/** Id of the profile being edited, or null while creating one. */
let editingId = null;

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

function describeProxy(proxy) {
  if (proxy.scheme === "none") return "No proxy";
  const user = proxy.username ? `${proxy.username}@` : "";
  return `${proxy.scheme}://${user}${proxy.host}:${proxy.port}`;
}

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

async function refresh() {
  const profiles = await request("profiles:list");
  list.replaceChildren(
    ...profiles.map((profile) => {
      const row = element("div", "profile");
      row.dataset.profileId = profile.id;
      const details = element("div", "details");
      details.append(
        element("div", "name", profile.name),
        element("div", "muted", describeProxy(profile.proxy)),
        element(
          "div",
          "muted",
          `${profile.fingerprint.locale} · ${profile.fingerprint.timezone}`,
        ),
      );
      const status = element("div", "status");
      status.append(
        element("span", "badge", kernelNames[profile.kernel]),
        element(
          "span",
          profile.running ? "badge running" : "badge",
          profile.running ? "Running" : "Stopped",
        ),
      );
      details.append(status);
      for (const space of profile.openSpaces) {
        const line = element("div", "space");
        line.dataset.spaceId = space.id;
        line.append(
          element("span", "", `${space.id} · ${space.name}`),
          element(
            "span",
            space.ownership === "agent" ? "badge agent" : "badge",
            space.ownership === "agent" ? "Agent in control" : "You control",
          ),
        );
        details.append(line);
      }
      const actions = element("div", "actions");
      const open = element(
        "button",
        "primary",
        profile.running ? "New window" : "Start",
      );
      open.dataset.action = "open";
      open.onclick = () =>
        run(() => request("profiles:open", { id: profile.id }));
      actions.append(open);
      if (profile.running) {
        const stop = element("button", "", "Stop");
        stop.dataset.action = "stop";
        stop.onclick = () =>
          run(() => request("profiles:stop", { id: profile.id }));
        actions.append(stop);
      }
      const change = element("button", "", "Edit");
      change.dataset.action = "edit";
      change.onclick = () => edit(profile);
      actions.append(change);
      if (!profile.isDefault) {
        const remove = element("button", "", "Delete");
        remove.dataset.action = "delete";
        remove.onclick = () => {
          if (!confirm(`Delete ${profile.name} and all its browsing data?`))
            return;
          run(() => request("profiles:remove", { id: profile.id }));
        };
        actions.append(remove);
      }
      row.append(details, actions);
      return row;
    }),
  );
}

async function run(action) {
  formError.textContent = "";
  try {
    await action();
  } catch (error) {
    formError.textContent = error.message;
  }
}

form.elements.scheme.onchange = syncProxyFields;
form.elements.kernel.onchange = syncKernelFields;
document.getElementById("form-reset").onclick = () => edit(null);
form.onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    await request("profiles:save", { id: editingId, draft: draft() });
    edit(null);
  });
};

window.shell.on("profiles:changed", () => void refresh());
edit(null);
void refresh();
