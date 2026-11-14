# ego-shell

An Electron browser shell that gives `ego-browser` isolated, proxied browser
profiles. Each profile has its own cookies, storage and cache, and can send all
of its traffic through its own SOCKS5 or HTTP proxy, with or without a username
and password. Agents drive it through the unchanged `ego-browser` harness.

It runs on stock Electron. Fingerprint patches belong to a custom Chromium
build that is not part of this package. The shell already hands every renderer
its profile's seed as `--ego-fp-seed=<seed>` so that build has something to
read.

## Run

```sh
cd package/ego-shell
npm install
npm start
```

The window that opens lists the profiles. Add one, then press Open to get a
browser window for it. The toolbar has back, forward, reload, an address bar,
tabs, and a button that takes control back from an agent.

Data lives in Electron's `userData` directory (`~/Library/Application
Support/ego-shell` on macOS). Set `EGO_SHELL_USER_DATA` to use another
directory. `profiles.json` there holds the profiles, including proxy passwords
in plain text, readable only by the owner.

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

A task space is one shell window bound to one profile.

## How a profile's traffic reaches its proxy

Chromium cannot authenticate to a SOCKS5 proxy. For each running profile the
shell starts a relay on `127.0.0.1` that accepts plain SOCKS5 and forwards to
the profile's real proxy with its credentials (`src/proxy-relay.ts`). The
profile's session is pointed at that relay with a fixed proxy configuration and
no bypass, so loopback addresses go through the proxy as well. Host names are
passed on unresolved, so the proxy does the DNS lookup. When the proxy cannot
be reached, requests fail. They do not fall back to a direct connection.

WebRTC is limited to proxied transports (`disable_non_proxied_udp`), so a page
cannot learn the machine's own addresses through ICE.

## Layout

- `src/profile-store.ts` holds the profiles on disk.
- `src/proxy-config.ts` and `src/proxy-relay.ts` turn a profile's proxy into a
  session proxy configuration and a local relay.
- `src/profile-runtime.ts` owns the Electron session of each running profile.
- `src/spaces.ts` and `src/tab.ts` own windows and tabs.
- `src/agent-server.ts` serves the agent socket. `src/agent-api.ts` implements
  the bindings of `docs/native-bindings-api.md` on top of it.
- `src/cdp-router.ts` gives each agent its own CDP sessions over the tabs'
  `webContents.debugger`.
- `src/snapshot.ts` renders the page snapshot the harness reads.
- `ui/` is the profile manager and the window toolbar.

## Test

```sh
npm test
```

The tests run against `dist/`. `test-support/fake-proxies.mjs` provides SOCKS5
and HTTP proxies that require credentials and log every connection.

## Known limits

- Proxy passwords are stored in plain text in `profiles.json`.
- The relay accepts any local process that finds its port.
- Downloads and permission prompts have no UI. Permissions other than
  fullscreen, pointer lock and clipboard write are denied.
- `animationHighlightMouseToPosition` succeeds without drawing anything, and
  the snapshot option `includeActionMarks` is ignored.
- Locale, timezone and user agent are overridden through the debugger. Canvas,
  WebGL, audio, fonts and ClientRects are the host's own until the patched
  kernel lands.
