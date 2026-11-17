// The headless side played through ego-shell itself: a throwaway shell on one
// direct test profile, the space opened and selected from its UI, and every
// key and mouse event of the session sent into the shell's screen view, so it
// reaches the page through the shell's own input path. The page is read over
// the kernel's debugging port, as the headful side is.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "./kernel.mjs";
import { PAUSE } from "./session.mjs";

const APP = fileURLToPath(new URL("../..", import.meta.url));
const ELECTRON = path.join(APP, "node_modules", ".bin", "electron");
const PROFILE = {
  id: "parity",
  name: "Parity",
  kernel: "apostate",
  proxy: { scheme: "none" },
  fingerprint: { seed: "111", locale: "pt-BR", timezone: "America/Sao_Paulo" },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`shell: ${what} never happened`);
    await sleep(200);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function evaluate(cdp, expression, sessionId) {
  const reply = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? expression);
  return reply.result.value;
}

/** One of the shell's own pages, over its remote debugging port. */
async function shellPage(port, file) {
  const target = await until(`${file} to load`, async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find((each) => each.url.endsWith(`/ui/${file}`));
  });
  return connect(target.webSocketDebuggerUrl);
}

async function request(ui, channel, payload) {
  const reply = await evaluate(ui, `shell.request(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`);
  if (!reply?.ok) throw new Error(`shell: ${channel} failed: ${reply?.error}`);
  return reply.value;
}

/** Grow the shell's window to the display, so the screen view can show the page 1:1. */
function fillDisplay(pid) {
  execFileSync("osascript", [
    "-e", `tell application "System Events" to tell (first process whose unix id is ${pid})`,
    "-e", "set position of window 1 to {0, 0}",
    "-e", "set size of window 1 to {4000, 4000}",
    "-e", "end tell",
  ]);
}

/**
 * Where the screen view draws the page, read from its own last drawImage: the
 * session's page points are sent into the view at origin + point, which the
 * shell maps back exactly only when it draws the page 1:1.
 */
function watchDrawing(screen) {
  return evaluate(screen, `(() => {
    window.__parityDrawn = null;
    if (window.__parityWatching) return true;
    window.__parityWatching = true;
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, x, y, width, height) {
      window.__parityDrawn = { x, y, width, height, dpr: devicePixelRatio };
      return original.apply(this, arguments);
    };
    return true;
  })()`);
}

const drawnAt = (screen) =>
  until("a frame drawn in the screen view", () => evaluate(screen, "window.__parityDrawn ?? null"));

/** The shell's screen view as a place to play the session. */
function screenTarget(screen, origin) {
  const toView = ({ x, y }) => ({ x: origin.x + x, y: origin.y + y });
  const send = (method, params) => {
    if (method === "Input.dispatchMouseEvent") return screen.send(method, { ...params, ...toView(params) });
    if (method === "Input.dispatchKeyEvent") {
      // A keyboard carries neither: the shell adds the editing command itself.
      const { commands, nativeVirtualKeyCode, ...key } = params;
      return screen.send(method, key);
    }
    return screen.send(method, params);
  };
  return {
    send,
    // The human clicks the closed select; the shell focuses it instead of opening it.
    async focusSelect(_step, at) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
      await sleep(PAUSE.hold);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
    },
  };
}

/**
 * Starts a throwaway shell and opens one user-held, selected space on
 * about:blank. `navigate(url)` loads a page from the toolbar's address bar;
 * `screenTarget()` grows the window until the page is drawn 1:1 and returns
 * the screen view as a session target; `close()` quits the shell, ends its
 * kernel and deletes its data.
 */
export async function startShell({ executable }) {
  const userData = await mkdtemp(path.join(tmpdir(), "ego-parity-shell-"));
  await writeFile(path.join(userData, "profiles.json"), JSON.stringify({ profiles: [PROFILE] }));
  const port = await freePort();
  const child = spawn(ELECTRON, [APP, `--remote-debugging-port=${port}`], {
    cwd: APP,
    env: { ...process.env, EGO_SHELL_USER_DATA: userData, EGO_SHELL_APOSTATE_BIN: executable },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const opened = [];
  const mainPid = () => execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const close = async () => {
    for (const connection of opened) connection.close();
    for (const pid of mainPid()) process.kill(Number(pid), "SIGTERM");
    await Promise.race([exited, sleep(10_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try {
      execFileSync("pkill", ["-KILL", "-f", path.join(userData, "apostate-profiles")]);
    } catch {
      // Nothing left running.
    }
    await rm(userData, { recursive: true, force: true });
  };
  try {
    const ui = await shellPage(port, "workbench.html");
    opened.push(ui);
    await until("the UI to be ready", () => evaluate(ui, "typeof shell === 'object'"));
    const { id: spaceId } = await request(ui, "profiles:open", { id: PROFILE.id });
    await request(ui, "space:select", { spaceId });
    const portFile = path.join(userData, "apostate-profiles", PROFILE.id, "DevToolsActivePort");
    const [kernelPort, browserPath] = (await readFile(portFile, "utf8")).split("\n");
    const kernel = await connect(`ws://127.0.0.1:${kernelPort}${browserPath}`);
    opened.push(kernel);
    const page = await until("the space's tab", async () =>
      (await kernel.send("Target.getTargets")).targetInfos.find((info) => info.type === "page"),
    );
    const { sessionId } = await kernel.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const { windowId } = await kernel.send("Browser.getWindowForTarget", { targetId: page.targetId });
    const kernelArgs = execFileSync("ps", ["-ww", "-axo", "command="], { encoding: "utf8" })
      .split("\n")
      .find((line) => line.includes(path.join(userData, "apostate-profiles")) && !line.includes("--type="));
    return {
      kernel,
      sessionId,
      windowId,
      kernelArgs: kernelArgs?.trim().split(/\s+/).slice(1) ?? [],
      navigate: (url) => request(ui, "space:command", { spaceId, command: { type: "navigate", url } }),
      async screenTarget() {
        const screen = await shellPage(port, "screen.html");
        opened.push(screen);
        // Growing the view restarts the cast, which sends a first frame.
        await watchDrawing(screen);
        fillDisplay(mainPid()[0]);
        await sleep(1500);
        const viewport = await evaluate(kernel, "({ width: innerWidth, height: innerHeight })", sessionId);
        const drawn = await drawnAt(screen);
        const scale = drawn.width / drawn.dpr / viewport.width;
        if (Math.abs(scale - 1) > 1e-6) {
          throw new Error(`shell: the page is drawn at scale ${scale.toFixed(3)}, not 1:1; the display is too small for the persona window`);
        }
        return screenTarget(screen, { x: drawn.x / drawn.dpr, y: drawn.y / drawn.dpr });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
