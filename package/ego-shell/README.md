# ego-shell

A browser shell that gives `ego-browser` isolated, proxied browser profiles.
Each profile has its own cookies, storage and cache, and can send all of its
traffic through its own SOCKS5 or HTTP proxy, with or without a username and
password. Agents drive it through the unchanged `ego-browser` harness.

A profile runs on one of two kernels:

- **Built in** is the shell's own Electron. Locale, timezone and user agent are
  overridden; canvas, WebGL, audio and fonts are the host's own.
- **Apostate** is a Chromium build with a seeded fingerprint. The shell starts
  one Apostate process per profile and drives it over CDP. Its windows are
  ordinary browser windows, separate from the shell.

## Run

```sh
cd package/ego-shell
npm install
npm start
```

The window that opens manages the profiles: add or edit one, pick its kernel,
and press Start. A running profile shows its task spaces and who controls each
one. New window opens another window of the profile, and Stop closes all of
them.

Data lives in Electron's `userData` directory (`~/Library/Application
Support/ego-shell` on macOS). Set `EGO_SHELL_USER_DATA` to use another
directory. `profiles.json` there holds the profiles, including proxy passwords
in plain text, readable only by the owner.

## Install the Apostate kernel

The manager shows whether the kernel is installed. Install Apostate downloads
`apostate-155.0.8059.31-macos-arm64.zip` (Apostate 0.5.1, about 160 MB) from
the project's GitHub release; it is the only time the shell itself goes to
the network. The archive's manifest from the same release must give the
SHA-256 that `src/kernel.ts` pins, and the archive must hash to it. It is
extracted into `<userData>/kernels/155.0.8059.31/`, and its browser binary and
framework must match the SHA-256 values pinned for them, before it replaces
anything there. When a step fails, everything it wrote is deleted and the
manager shows why.

Extracting the archive into that directory by hand works as well. Before the
first Apostate profile of a run starts, the shell checks the binary and its
framework against the pinned values and refuses a build that differs.

`EGO_SHELL_APOSTATE_BIN` names a binary to run instead. That binary is not
checked.

Only macOS on Apple silicon is listed, and the persona is always macOS: a
Windows persona on a Mac is flagged as tampering. Apostate is GPL-3.0. The
shell runs the published binary as a separate process and does not link or
modify it.

## Drive it from the harness

While the shell runs, the repo CLI finds it by itself:

```sh
cd package/ego-browser && npm run build
node dist/out/index.js <<'JS'
const all = await profiles()
const task = await taskSpace('orders', { profileId: all[1].id })
const page = task.page('p1')
await page.goto('https://example.com')
console.log(await page.snapshot())
JS
```

The CLI reads `agent-endpoint.json` from the shell's `userData` directory. Set
`EGO_SHELL_ENDPOINT` to the path of that file when the shell uses another
directory. When the variable is set, a shell that cannot be reached is an
error. A browser that provides its own `globalThis.ego` is never replaced.

A task space is one window bound to one profile. On the built-in kernel it is
a shell window with a toolbar. On Apostate it is a window of the profile's
Apostate process. On either kernel the spaces of one profile share cookies.

## Who controls a window

`task.handOff()` gives a space to the user and pauses the agent's commands on
it until `takeOverTaskSpace(id)`. On Apostate the user takes part by using the
window itself. A window the user opens, from the manager or from the browser's
own menu, becomes a task space the user owns, named after the profile. An
agent can take it over by id.

## How a profile's traffic reaches its proxy

Chromium cannot authenticate to a SOCKS5 proxy. For each running profile the
shell starts a relay on `127.0.0.1` that accepts plain SOCKS5 and forwards to
the profile's real proxy with its credentials (`src/proxy-relay.ts`). Host
names are passed on unresolved, so the proxy does the DNS lookup. When the
proxy cannot be reached, requests fail. They do not fall back to a direct
connection.

The built-in kernel points the profile's session at the relay with a fixed
proxy configuration and no bypass. Apostate is started with
`--proxy-server=socks5://127.0.0.1:<relay port>`, so the proxy's host, user
name and password never appear in its arguments or environment. Two more flags
close the gaps Chromium leaves: `--proxy-bypass-list=<-loopback>` sends
loopback addresses through the proxy as well, and `--host-resolver-rules`
fails every lookup the browser would do on the host.

WebRTC is limited to proxied transports (`disable_non_proxied_udp`), so a page
cannot learn the machine's own addresses through ICE.

## What an Apostate profile is started with

Each profile has its own `--user-data-dir` under
`<userData>/apostate-profiles/<profile id>`. Its seed, locale and timezone
come from the profile: `--fingerprint=<seed>`, `--fingerprint-platform=macos`,
`--fingerprint-locale`, `--fingerprint-timezone`, and `TZ` in the process
environment. `--fingerprint-noise` is left off: with it, pixels a page writes
to a canvas read back changed, which a page can test for to spot an anti-detect
browser. Every profile on one Mac therefore reports the same canvas hash;
profiles are told apart by their exits. The port is
`--remote-debugging-port=0`, read back from `DevToolsActivePort`. A kernel
left over from a crashed shell is stopped before the profile starts again.

The shell enables no CDP domain on the session an agent drives.

## The mouse highlight

`animationHighlightMouseToPosition` draws a shrinking square with the
browser's own overlay (`Overlay.highlightRect`) on the active tab, so the
page's DOM is untouched. It runs on a second CDP session of the tab, on
either kernel, so that the DOM and Overlay domains it enables never reach the
session an agent drives (`src/mouse-highlight.ts`). It is hidden before a
screenshot.

## Layout

- `src/profile-store.ts` holds the profiles on disk.
- `src/proxy-config.ts` and `src/proxy-relay.ts` turn a profile's proxy into a
  session proxy configuration and a local relay.
- `src/task-space.ts` holds what both kernels share: ownership, agent
  connections and the list of spaces.
- `src/profile-queue.ts` runs each profile's start, update, release and erase
  one at a time, in call order. Both kernels use it.
- `src/profile-runtime.ts`, `src/spaces.ts` and `src/tab.ts` are the built-in
  kernel: one Electron session per profile, windows and tabs.
  `src/profile-network.ts` switches a session's proxy, user agent and
  languages as one step and puts the old ones back when a step fails; it has
  no Electron import, so its tests run under plain Node.
- `src/kernel.ts` finds and checks the Apostate binary.
  `src/apostate-launcher.ts` starts and stops one process.
  `src/browser-cdp.ts` and `src/apostate-browser.ts` drive its windows and tabs
  over one browser-level CDP socket. `src/apostate-backend.ts` keeps one
  process per running profile.
- `src/agent-server.ts` serves the agent socket. `src/agent-api.ts` implements
  the bindings of `docs/native-bindings-api.md` on top of it.
- `src/cdp-router.ts` gives each agent its own CDP sessions over a space's
  tabs, whichever kernel they belong to.
- `src/snapshot.ts` renders the page snapshot the harness reads.
- `ui/` is the profile manager and the toolbar of built-in windows.

## Test

```sh
npm test
```

The tests run against `dist/`. `test-support/fake-proxies.mjs` provides SOCKS5
and HTTP proxies that require credentials and log every connection.
`test-support/fake-apostate.mjs` and `test-support/fake-cdp-browser.mjs` stand
in for the kernel binary and its CDP endpoint.

`src/apostate-canvas.test.mjs` needs a real kernel and is skipped without one.
It starts the kernel with the shell's arguments and checks that canvas pixels a
page writes read back unchanged:

```sh
EGO_SHELL_APOSTATE_EXECUTABLE=<path to Chromium.app>/Contents/MacOS/Chromium npm test
```

## Known limits

- Proxy passwords are stored in plain text in `profiles.json`.
- The relay accepts any local process that finds its port.
- Built-in kernel: downloads and permission prompts have no UI, and
  permissions other than fullscreen, pointer lock and clipboard write are
  denied. Canvas, WebGL, audio, fonts and ClientRects are the host's own.
- Built-in kernel: `download.cancel()` does not work. A page's debugger
  answers `Browser.cancelDownload` only for Electron's default session, so
  the shell fails it with a message saying the kernel does not support it.
- Built-in kernel: a popup opened with `window.open` can read the host's
  timezone, language and User-Agent Client Hints before the shell's CDP
  overrides reach it. Use the Apostate kernel for shop profiles.
- Apostate: a profile cannot set a user agent. The persona sets the
  User-Agent, Client Hints and `navigator.platform` together, and Apostate
  has no switch for the string alone.
- Apostate: editing a running profile's proxy, seed, locale or timezone
  stops its process and closes its windows; it starts with the new settings
  the next time it is started or a task space is opened on it.
- Apostate: Chromium does not announce a tab the user picks in the tab
  strip, so the shell asks each tab of the window whether it is visible when
  an agent lists tabs or takes a snapshot. While the window is minimised, no
  tab is, and the tab last known to be active stays so.
- An agent's browser-level commands are answered by the shell. Of the
  `Browser.*` commands it passes on only the two the harness sends,
  `Browser.getVersion` and `Browser.cancelDownload`. Any other, such as
  `Browser.close`, fails as not found.
- The snapshot option `includeActionMarks` is ignored.
