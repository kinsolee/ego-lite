# ego-shell

A browser shell that gives `ego-browser` isolated, proxied browser profiles.
Each profile has its own cookies, storage and cache, and can send all of its
traffic through its own SOCKS5 or HTTP proxy, with or without a username and
password. Agents drive it through the unchanged `ego-browser` harness.

A profile runs on one of two kernels:

- **Built in** is the shell's own Electron. Locale, timezone and user agent are
  overridden; canvas, WebGL, audio and fonts are the host's own.
- **Apostate** is a Chromium build with a seeded fingerprint. The shell starts
  one headless Apostate process per profile and drives it over CDP. The
  selected space is drawn in the shell's main window by screencast, and the
  person's input is sent back to the page.

## Run

```sh
cd package/ego-shell
npm install
npm start
```

Everything happens in one window. The sidebar lists the profiles: add or edit
one, pick its kernel, and press Start. Under each running profile are its task
spaces and who controls each one; pick one to show it on the right with its
tabs, address bar and Take control button. New space opens another space of
the profile, × closes one, and Stop closes all of them. A space an agent opens
does not take the window from the space you are looking at; the sidebar marks
it New, as it does a space an agent hands over to you.

On macOS the close button only hides the window, and agents keep working in
every space. Clicking the app in the Dock, or starting it again, shows the
window. Quit the app to stop it. On other systems closing the window quits.

Data lives in Electron's `userData` directory (`~/Library/Application
Support/ego-shell` on macOS). Set `EGO_SHELL_USER_DATA` to use another
directory. `profiles.json` there holds the profiles, including proxy passwords
in plain text, readable only by the owner.

## Install the Apostate kernel

The sidebar shows whether the kernel is installed. Install Apostate downloads
`apostate-155.0.8059.31-macos-arm64.zip` (Apostate 0.5.1, about 160 MB) from
the project's GitHub release; it is the only time the shell itself goes to
the network. The archive's manifest from the same release must give the
SHA-256 that `src/kernel.ts` pins, and the archive must hash to it. It is
extracted into `<userData>/kernels/155.0.8059.31/`, and its browser binary and
framework must match the SHA-256 values pinned for them, before it replaces
anything there. When a step fails, everything it wrote is deleted and the
sidebar shows why.

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

A task space is a set of tabs bound to one profile. On the built-in kernel its
tabs show in the main window, whether or not the space is selected there, so
an agent can screenshot and click a space the user is not looking at. On
Apostate a space is a window of the profile's Apostate process; selecting it
in the sidebar brings that window forward. On either kernel the spaces of one
profile share cookies.

## Who controls a task space

`task.handOff()` gives a space to the user and pauses the agent's commands on
it until `takeOverTaskSpace(id)`. A space the user opens from the sidebar is
the user's from the start. Take control, in the toolbar or on the card over an
Apostate space's screen, gives the user a space an agent holds.

On Apostate, the person's mouse, keyboard and clipboard reach a page only
while the user holds its space. While an agent holds it, the screen shows the
page and passes nothing on, so each page has one source of input at a time.
The same rule decides who answers a page's dialogs and file choosers: the
shell asks the person while the user holds the space (a card for alert,
confirm and prompt, the native open panel for files) and leaves them to the
agent otherwise.

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
browser. Every profile on one Mac therefore reports the same canvas hash, and
only a profile with its own proxy exit stands apart from the others; direct
profiles share the machine's address as well. The port is
`--remote-debugging-port=0`, read back from `DevToolsActivePort`. A kernel
left over from a crashed shell is stopped before the profile starts again.

Every profile also gets `--fingerprint-screen-width=1920` and
`--fingerprint-screen-height=1080`: one 60 Hz display, which a headless kernel
matches. Without them every profile reads the host's own display. The kernel
runs with `--headless=new --window-size=1440,900`, and each space's window is
placed inside the persona's available screen area at a spot no other live
window of the process holds.

The shell enables no CDP domain on the session an agent drives. Its own
traffic (screencast, the person's input, clipboard, dialogs, window placement,
opening tabs) goes over a second browser-level socket, `src/shell-link.ts`.
Chromium sends a session's events only to the socket that attached it, so an
agent never sees the screencast and its `Page.stopScreencast` cannot stop it.

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
  kernel: one Electron session per profile and its tabs.
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
- `src/workbench.ts` owns the main window. Each space places its views
  through a `Stage`; every view stays attached and sized to the content area,
  and z-order alone decides which one the user sees. `src/selection.ts` holds
  the rules for which space is selected. Neither imports Electron.
- `ui/workbench.html` and `ui/workbench.js` are the main window's page: the
  sidebar, the toolbar of the selected space and the profile editor. The page
  reports where its content area is, so the layout lives only in
  `ui/style.css`.
- `src/shell-link.ts` is the shell's own socket to an Apostate process.
  `src/screen.ts` controls the one screen view every Apostate space is drawn
  into; `src/screen-geometry.ts` and `src/screen-input.ts` are its pure parts
  (letterbox fit, window placement, and the mapping of the view's input to
  `Input.*`). `ui/screen.html` and `ui/screen.js` are the view's page.

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

### Headless parity

A shop profile runs its kernel with `--headless=new`, and the person sees it
through a screencast. `test-support/parity/run.mjs` checks that a page cannot
tell this from a kernel with a window. It plays one scripted human session
twice, once headful and once headless, and compares everything the page
recorded. The headful side gets CDP `Input.*` on a page session. With
`--via shell` the headless side is ego-shell itself: a throwaway shell opens a
direct test profile, the window is grown until the page is drawn 1:1, and
every key and mouse event goes into the shell's screen view, through the same
path a person's input takes. Without it the headless side is a bare kernel
driven like the headful one.

```sh
npm run build
node test-support/parity/run.mjs --via shell   # --kernel <Chromium> --raw <file>
```

The kernel defaults to `EGO_SHELL_APOSTATE_EXECUTABLE`, else the probe cache's
155.0.8059.31 build. The JSON verdict goes to stdout and a summary to stderr.
The exit code is 0 only when there are no diffs, both canvas round trips read
back unchanged, and the session reached its expected end in both modes. It is
1 for a failed check, and 2 when the run proves nothing. That covers a harness
error, a host pasteboard that did not restore, and a disturbed run: the
headful window lost focus or was moved while the run was going.

- The fixture is a page on `127.0.0.1` with a cross-origin iframe on a second
  port. `observer.js` records, with page APIs only, screen and window
  geometry, media queries, focus and visibility, navigator and Client Hints,
  permissions, fonts, frame rate and timer resolution, and every input event
  with its coordinates, buttons, keys, composition data and timing. The
  server also records request headers.
- `session.mjs` lists the steps: a mouse path and click, a double click, a
  right click, wheel, ASCII and Portuguese typing (ABNT2 dead keys as
  composition), Chinese IME composition, Cmd+A/C/V/X, Tab, and the `<select>`
  route (focus the closed select, then the first letter). Keys follow Chrome
  on a Mac: a key the IME or a dead key takes goes down as keyCode 229 with
  its real key, the text is committed between the selecting key's down and
  up, and every key comes up with its real code. It plays the steps in the
  top page and again in the iframe.
- `diff.mjs` compares every value as recorded, except the ones in its
  `NORMALISATIONS` list. The verdict prints that list.
  `document.hasFocus()` is reported under `knownLimits`, not `diffs`.
  `timing.rafHz` and `screen.isExtended` are compared with the persona (60 and
  false) under `persona`, not with the headful window, which reads the host's
  own displays. `compositionend` is untrusted in real Chrome too, and is
  listed apart from any other untrusted event.
- The clipboard steps write to the host pasteboard while a window is up. The
  run saves every item and type first, restores them at the end, and reads
  the pasteboard back to confirm it matches. A backup that does not match is
  kept, and its path is printed.

A window opens on screen for about a minute. Do not use the mouse or keyboard,
and do not switch apps, until the run ends.

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
- Built-in kernel: Chromium hit-tests input against the last frame a page
  drew, and a page in an unselected space or a hidden window may not draw
  after it navigates. A frame in another process, such as a payment iframe,
  has no size until its parent draws. When any frame of a tab finishes
  loading, and before the first click, wheel, touch or drag on a new
  document, the shell captures one pixel of the tab, which makes it draw.
- Apostate: the screen keeps the persona's viewport whatever size the main
  window is. A smaller window shows the page scaled down with margins, never
  enlarged.
- Apostate: the screen always shows an arrow pointer; CDP does not report the
  page's cursor.
- Apostate: a press on a `<select>` focuses it and does not open its list;
  type the first letter of an option to pick it. The shell's own list comes
  later.
- Apostate: `document.hasFocus()` is true in every headless window of a
  process at once, unlike windows on a desktop.
- Apostate: the IME's candidate window opens where the person last clicked,
  not at the page's caret.
- Apostate: downloads have no UI yet.
- An agent's browser-level commands are answered by the shell. Of the
  `Browser.*` commands it passes on only the two the harness sends,
  `Browser.getVersion` and `Browser.cancelDownload`. Any other, such as
  `Browser.close`, fails as not found.
- The snapshot option `includeActionMarks` is ignored.
