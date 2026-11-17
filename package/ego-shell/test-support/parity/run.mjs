// Headless-vs-headful parity check (acceptance X1). Usage, from package/ego-shell
// after `npm run build`:
//   node test-support/parity/run.mjs [--kernel <Chromium>] [--raw <file>]
// Prints the JSON verdict on stdout and a summary on stderr.
// Exit 0: no diffs, canvas round trips clean, the session played in both
// modes. 1: one of those failed. 2: the harness failed, the host pasteboard
// did not restore, or the run was disturbed.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { compare, NORMALISATIONS } from "./diff.mjs";
import { drive } from "./driver.mjs";
import { startFixture } from "./fixture.mjs";
import { connect, DEFAULT_KERNEL, launchKernel } from "./kernel.mjs";
import { backUpPasteboard, changeCount } from "./pasteboard.mjs";
import { EXPECTED, SESSION } from "./session.mjs";

const { values: options } = parseArgs({
  options: { kernel: { type: "string" }, raw: { type: "string" } },
});
const executable = options.kernel ?? process.env.EGO_SHELL_APOSTATE_EXECUTABLE ?? DEFAULT_KERNEL;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanups = [];
const cleanUp = async () => {
  while (cleanups.length) await cleanups.pop()().catch((error) => console.error("cleanup:", error.message));
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await cleanUp();
    process.exit(2);
  });
}

async function evaluate(cdp, sessionId, expression) {
  const reply = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? expression);
  return reply.result.value;
}

/** One kernel, one window, one pass of the session. */
async function observe(mode, fixture, windowSize) {
  const kernel = await launchKernel({ executable, headless: mode === "headless", windowSize });
  cleanups.push(kernel.close);
  const cdp = await connect(kernel.endpoint);
  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const { windowId, bounds: opened } = await cdp.send("Browser.getWindowForTarget", { targetId });
    // Fix 4: put the window inside the persona's available screen area.
    const avail = await evaluate(cdp, sessionId, "({left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight})");
    const placed = {
      left: avail.left + 40,
      top: avail.top + 12,
      width: Math.min(1280, avail.width - 96),
      height: Math.min(800, avail.height - 76),
    };
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: placed });
    await cdp.send("Page.bringToFront", {}, sessionId);
    fixture.takeRequests();
    const pasteboardBefore = changeCount();
    await cdp.send("Page.navigate", { url: fixture.url }, sessionId);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const ready = await evaluate(cdp, sessionId, "window.__parity?.ready()").catch(() => false);
      if (ready) break;
      if (Date.now() > deadline) {
        // A covered headful window gets no animation frames, so the frame-rate probe never ends.
        const visibility = await evaluate(cdp, sessionId, "document.visibilityState").catch((error) => error.message);
        throw new Error(`${mode}: fixture never became ready (visibilityState ${visibility}); keep the window uncovered`);
      }
      await sleep(200);
    }
    // Another app can take focus while a headful window comes up. Start once
    // the page has held focus for half a second.
    await cdp.send("Page.bringToFront", {}, sessionId);
    for (let held = 0; held < 5; ) {
      held = (await evaluate(cdp, sessionId, "document.hasFocus()")) ? held + 1 : 0;
      if (Date.now() > deadline) throw new Error(`${mode}: the window never kept focus`);
      await sleep(100);
    }
    await evaluate(cdp, sessionId, "window.__parity.start()");
    await drive(cdp, sessionId, SESSION);
    await sleep(1000);
    const page = await evaluate(cdp, sessionId, "window.__parity.collect()");
    const { bounds: ended } = await cdp.send("Browser.getWindowBounds", { windowId });
    return {
      page,
      requests: fixture.takeRequests(),
      window: {
        opened: { width: opened.width, height: opened.height },
        placed,
        ended: { left: ended.left, top: ended.top, width: ended.width, height: ended.height },
      },
      kernelArgs: kernel.args,
      hostPasteboardWritten: changeCount() !== pasteboardBefore,
    };
  } finally {
    cdp.close();
    cleanups.splice(cleanups.indexOf(kernel.close), 1);
    await kernel.close();
  }
}

/**
 * Something outside the run changed the headful window: another app took
 * focus, or the window was moved. The diffs then say nothing about parity.
 */
function disturbances(observations) {
  const found = [];
  for (const [mode, observation] of Object.entries(observations)) {
    const { placed, ended } = observation.window;
    if (JSON.stringify(placed) !== JSON.stringify(ended)) {
      found.push(`${mode} window moved from ${JSON.stringify(placed)} to ${JSON.stringify(ended)}`);
    }
    // The top page loads focused and the session only ever moves focus into
    // the iframe, which blurs the top window for good. A top window that gets
    // focus back had lost it to another app.
    if (observation.page.main.events.some((event) => event.type === "focus" && event.target === "window")) {
      found.push(`${mode} window lost OS focus and got it back`);
    }
  }
  return found;
}

/** Expected outcomes the session did not reach, per mode and frame. */
function unplayed(observations) {
  const missing = [];
  for (const [mode, observation] of Object.entries(observations)) {
    for (const frame of ["main", "iframe"]) {
      const { fields, events } = observation.page[frame];
      for (const [id, value] of Object.entries(EXPECTED.fields)) {
        if (fields[id] !== value) missing.push(`${mode} ${frame} #${id} is ${JSON.stringify(fields[id])}, expected ${JSON.stringify(value)}`);
      }
      const seen = new Set(events.map((event) => `${event.type} ${event.target}`));
      for (const event of EXPECTED.events) if (!seen.has(event)) missing.push(`${mode} ${frame} never saw ${event}`);
    }
  }
  return missing;
}

/** Events a page sees as untrusted: a site can read these in either mode. */
function untrusted(observations) {
  const found = {};
  for (const [mode, observation] of Object.entries(observations)) {
    for (const frame of ["main", "iframe"]) {
      const list = observation.page[frame].events.filter((event) => !event.isTrusted).map((event) => `${event.type} ${event.target}`);
      if (list.length) found[`${mode}.${frame}`] = list;
    }
  }
  return found;
}

function summary(verdict) {
  const status = verdict.disturbed.length ? "DISTURBED, rerun" : verdict.pass ? "PASS" : "FAIL";
  const lines = [`parity: ${status} — ${verdict.diffs.length} diff(s), ${verdict.knownLimits.length} known-limit value(s)`];
  for (const reason of verdict.disturbed) lines.push(`  DISTURBED ${reason}`);
  const show = (value) =>
    value && typeof value === "object" && "type" in value
      ? `<${value.type} ${value.target}${value.key !== undefined ? ` key=${JSON.stringify(value.key)}` : ""}>`
      : JSON.stringify(value);
  for (const diff of verdict.diffs) {
    lines.push(`  DIFF ${diff.path}${diff.event ? ` (${diff.event})` : ""}: headless=${show(diff.headless)} headful=${show(diff.headful)}`);
  }
  for (const limit of verdict.knownLimits) {
    lines.push(`  KNOWN ${limit.path}: headless=${JSON.stringify(limit.headless)} headful=${JSON.stringify(limit.headful)}`);
  }
  const canvas = verdict.checks.canvas;
  lines.push(`  canvas round trips: ${canvas.pass ? "clean" : "CHANGED"} ${JSON.stringify(canvas.byMode)}`);
  lines.push(`  session played: ${verdict.checks.session.pass ? "yes" : "NO"}`);
  for (const reason of verdict.checks.session.missing) lines.push(`    ${reason}`);
  for (const [where, list] of Object.entries(verdict.findings.untrustedEvents)) {
    lines.push(`  untrusted events (${where}, a page sees these in either mode): ${list.join(", ")}`);
  }
  lines.push(`  normalised: ${verdict.normalisations.map((rule) => rule.path).join(", ")}`);
  lines.push(`  host pasteboard: restored ${verdict.harness.pasteboard.identical ? "identical" : "DIFFERENT"} (${verdict.harness.pasteboard.items} item(s), ${verdict.harness.pasteboard.types} type(s))`);
  return lines.join("\n");
}

let exitCode = 2;
try {
  const pasteboard = await backUpPasteboard();
  cleanups.push(async () => {
    const result = await pasteboard.restore();
    console.error(
      result.identical
        ? "host pasteboard restored: identical"
        : `host pasteboard restore differs; backup kept at ${result.backupKeptAt}`,
    );
  });
  const fixture = await startFixture();
  cleanups.push(fixture.close);

  // Headful first: the headless window is opened at the size a headful one opens at.
  const headful = await observe("headful", fixture);
  const headless = await observe("headless", fixture, headful.window.opened);
  if (options.raw) await writeFile(options.raw, JSON.stringify({ headless, headful }, null, 2));

  const { diffs, knownLimits } = compare(headless, headful);
  const byMode = {
    headless: { main: headless.page.main.canvas, iframe: headless.page.iframe.canvas },
    headful: { main: headful.page.main.canvas, iframe: headful.page.iframe.canvas },
  };
  const canvasClean = Object.values(byMode).every((frames) =>
    Object.values(frames).every((counts) => counts.putThenGet === 0 && counts.dataUrlThenGet === 0),
  );
  await cleanUp();
  const restored = await pasteboard.restore();
  const disturbed = disturbances({ headless, headful });
  const missing = unplayed({ headless, headful });
  const verdict = {
    pass: diffs.length === 0 && canvasClean && missing.length === 0 && disturbed.length === 0,
    disturbed,
    diffs,
    knownLimits,
    checks: { canvas: { pass: canvasClean, byMode }, session: { pass: missing.length === 0, missing } },
    findings: { untrustedEvents: untrusted({ headless, headful }) },
    normalisations: NORMALISATIONS.map(({ path, rule }) => ({ path, rule })),
    harness: {
      kernel: executable,
      kernelArgs: { headless: headless.kernelArgs, headful: headful.kernelArgs },
      window: { headful: headful.window, headless: headless.window },
      steps: SESSION.length,
      events: { headless: { main: headless.page.main.events.length, iframe: headless.page.iframe.events.length }, headful: { main: headful.page.main.events.length, iframe: headful.page.iframe.events.length } },
      hostPasteboardWrittenByKernel: { headless: headless.hostPasteboardWritten, headful: headful.hostPasteboardWritten },
      pasteboard: restored,
    },
  };
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  console.error(summary(verdict));
  exitCode = !restored.identical || disturbed.length ? 2 : verdict.pass ? 0 : 1;
} catch (error) {
  console.error(`parity harness failed: ${error.stack ?? error}`);
  exitCode = 2;
} finally {
  await cleanUp();
}
process.exit(exitCode);
