// Runs in the fixture page and its iframe. Records what a detector script can
// read, using only page APIs. The driver reads the result once, at the end.
(() => {
  const FRAME = window === top ? "main" : "iframe";
  const log = [];

  const EVENT_TYPES = [
    "pointerover", "pointerenter", "pointerdown", "pointermove", "pointerrawupdate", "pointerup",
    "pointercancel", "pointerout", "pointerleave", "gotpointercapture", "lostpointercapture",
    "mouseover", "mouseenter", "mousedown", "mousemove", "mouseup", "mouseout", "mouseleave",
    "click", "dblclick", "auxclick", "contextmenu", "wheel",
    "keydown", "keypress", "keyup", "beforeinput", "input", "change", "textInput",
    "focus", "blur", "focusin", "focusout",
    "compositionstart", "compositionupdate", "compositionend",
    "copy", "cut", "paste", "scroll", "scrollend", "select", "selectionchange",
  ];
  const FIELDS = [
    "clientX", "clientY", "screenX", "screenY", "movementX", "movementY", "pageX", "pageY",
    "offsetX", "offsetY", "x", "y", "layerX", "layerY", "buttons", "button", "detail",
    "pointerType", "pointerId", "width", "height", "pressure", "tangentialPressure",
    "tiltX", "tiltY", "twist", "altitudeAngle", "azimuthAngle", "isPrimary",
    "altKey", "ctrlKey", "metaKey", "shiftKey", "key", "code", "keyCode", "charCode", "which",
    "location", "repeat", "isComposing", "inputType", "data",
    "deltaX", "deltaY", "deltaZ", "deltaMode", "bubbles", "cancelable", "composed",
  ];

  const nameOf = (target) => {
    if (target === window) return "window";
    if (target === document) return "document";
    if (!target) return null;
    return target.id ? `#${target.id}` : target.nodeName;
  };
  const selectionOf = () => {
    const active = document.activeElement;
    if (active && typeof active.selectionStart === "number") {
      return { in: nameOf(active), start: active.selectionStart, end: active.selectionEnd };
    }
    return { in: nameOf(active), text: getSelection().toString() };
  };

  const record = (event) => {
    const entry = { type: event.type, isTrusted: event.isTrusted, target: nameOf(event.target), t: event.timeStamp };
    for (const field of FIELDS) if (field in event) entry[field] = event[field];
    if ("relatedTarget" in event) entry.relatedTarget = nameOf(event.relatedTarget);
    if ("sourceCapabilities" in event) entry.firesTouchEvents = event.sourceCapabilities?.firesTouchEvents ?? null;
    if (typeof event.getModifierState === "function") entry.capsLock = event.getModifierState("CapsLock");
    if (event.clipboardData) {
      entry.clipboardTypes = [...event.clipboardData.types];
      entry.clipboardText = event.clipboardData.getData("text/plain");
    }
    if (["input", "change", "select", "beforeinput", "keyup"].includes(event.type) && "value" in event.target) {
      entry.value = event.target.value;
    }
    if (event.type === "scroll" || event.type === "scrollend") {
      const scrolled = event.target === document ? document.scrollingElement : event.target;
      entry.scrollTop = scrolled.scrollTop;
      entry.scrollLeft = scrolled.scrollLeft;
    }
    if (event.type === "selectionchange" || event.type === "select") entry.selection = selectionOf();
    if (event.type.startsWith("focus") || event.type === "blur") entry.activeElement = nameOf(document.activeElement);
    log.push(entry);
  };
  // passive: false makes the compositor wait for the wheel listener before it
  // scrolls; with a passive one, whether a wheel event's offsetY already
  // includes its own scroll is a race in either mode.
  for (const type of EVENT_TYPES) {
    window.addEventListener(type, record, { capture: true, passive: false });
    if (type === "selectionchange") document.addEventListener(type, record, { capture: true });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frames = () =>
    new Promise((resolve) => {
      let count = 0;
      const start = performance.now();
      const tick = (now) => {
        if (now - start >= 1000) return resolve(count);
        count += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const nowResolution = () => {
    const seen = new Set();
    const start = performance.now();
    let now = start;
    while (now - start < 20) {
      now = performance.now();
      seen.add(now);
    }
    return (now - start) / seen.size;
  };
  const media = () => {
    const queries = {
      "prefers-color-scheme": ["light", "dark"],
      "prefers-reduced-motion": ["no-preference", "reduce"],
      "prefers-contrast": ["no-preference", "more", "less", "custom"],
      "prefers-reduced-transparency": ["no-preference", "reduce"],
      "forced-colors": ["none", "active"],
      "inverted-colors": ["none", "inverted"],
      pointer: ["none", "coarse", "fine"],
      "any-pointer": ["none", "coarse", "fine"],
      hover: ["none", "hover"],
      "any-hover": ["none", "hover"],
      "display-mode": ["browser", "minimal-ui", "standalone", "fullscreen", "window-controls-overlay", "picture-in-picture"],
      "color-gamut": ["srgb", "p3", "rec2020"],
      "dynamic-range": ["standard", "high"],
      "video-dynamic-range": ["standard", "high"],
      update: ["none", "slow", "fast"],
      scripting: ["none", "initial-only", "enabled"],
      orientation: ["portrait", "landscape"],
    };
    const result = {};
    for (const [feature, values] of Object.entries(queries)) {
      result[feature] = values.filter((value) => matchMedia(`(${feature}: ${value})`).matches);
    }
    for (const dppx of [1, 1.5, 2, 3]) result[`min-resolution:${dppx}dppx`] = matchMedia(`(min-resolution: ${dppx}dppx)`).matches;
    result["monochrome"] = matchMedia("(monochrome)").matches;
    result["device-size"] = matchMedia(`(device-width: ${screen.width}px) and (device-height: ${screen.height}px)`).matches;
    return result;
  };
  const permissions = async () => {
    const result = { "Notification.permission": typeof Notification === "undefined" ? null : Notification.permission };
    for (const name of ["notifications", "clipboard-read", "clipboard-write", "geolocation", "camera", "microphone", "persistent-storage", "midi"]) {
      try {
        result[name] = (await navigator.permissions.query({ name })).state;
      } catch (error) {
        result[name] = `error:${error.name}`;
      }
    }
    return result;
  };
  const fonts = () => {
    const families = ["Helvetica Neue", "Arial", "Times New Roman", "Menlo", "PingFang SC", "Segoe UI", "Roboto", "Comic Sans MS"];
    const context = document.createElement("canvas").getContext("2d");
    const result = {};
    for (const family of families) {
      context.font = `16px "${family}", monospace`;
      result[family] = { check: document.fonts.check(`12px "${family}"`), width: context.measureText("ação já é 你好 mmmWWWiii").width };
    }
    return result;
  };
  const webgl = () => {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
  };
  const voices = async () => {
    let list = speechSynthesis.getVoices();
    for (let i = 0; i < 20 && list.length === 0; i += 1) {
      await sleep(50);
      list = speechSynthesis.getVoices();
    }
    return { count: list.length, default: list.find((voice) => voice.default)?.name ?? null };
  };
  const devices = async () => {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).map((device) => device.kind).sort();
    } catch (error) {
      return `error:${error.name}`;
    }
  };

  const snapshot = async () => {
    const data = navigator.userAgentData;
    return {
      screen: {
        width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight,
        availTop: screen.availTop, availLeft: screen.availLeft, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
        isExtended: screen.isExtended, orientation: [screen.orientation?.type, screen.orientation?.angle],
      },
      window: {
        outerWidth, outerHeight, innerWidth, innerHeight, screenX, screenY, screenLeft, screenTop,
        devicePixelRatio,
        clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
        visualViewport: [visualViewport.width, visualViewport.height, visualViewport.scale, visualViewport.offsetLeft, visualViewport.offsetTop],
        bars: ["locationbar", "menubar", "personalbar", "scrollbars", "statusbar", "toolbar"].map((bar) => window[bar].visible),
        historyLength: history.length,
        chrome: typeof window.chrome === "object" ? Object.keys(window.chrome).sort() : null,
      },
      media: media(),
      document: { visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(), activeElement: nameOf(document.activeElement) },
      navigator: {
        webdriver: navigator.webdriver, userAgent: navigator.userAgent, platform: navigator.platform, vendor: navigator.vendor,
        language: navigator.language, languages: [...navigator.languages], hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory, maxTouchPoints: navigator.maxTouchPoints, pdfViewerEnabled: navigator.pdfViewerEnabled,
        cookieEnabled: navigator.cookieEnabled, doNotTrack: navigator.doNotTrack,
        plugins: [...navigator.plugins].map((plugin) => plugin.name), mimeTypes: navigator.mimeTypes.length,
        connection: navigator.connection
          ? { effectiveType: navigator.connection.effectiveType, rtt: navigator.connection.rtt, downlink: navigator.connection.downlink, saveData: navigator.connection.saveData }
          : null,
        userActivation: navigator.userActivation ? [navigator.userActivation.hasBeenActive, navigator.userActivation.isActive] : null,
        userAgentData: data ? {
          brands: data.brands, mobile: data.mobile, platform: data.platform,
          highEntropy: await data.getHighEntropyValues(["architecture", "bitness", "formFactors", "fullVersionList", "model", "platformVersion", "uaFullVersion", "wow64"]),
        } : null,
      },
      intl: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, offset: new Date(2026, 0, 1).getTimezoneOffset() },
      permissions: await permissions(),
      fonts: fonts(),
      webgl: webgl(),
      voices: await voices(),
      mediaDevices: await devices(),
      timing: { rafHz: await frames(), perfNowResolutionMs: nowResolution() },
    };
  };

  const fieldValues = () => {
    const result = {};
    for (const element of document.querySelectorAll("input,select,[contenteditable]")) {
      result[element.id] = "value" in element ? element.value : element.textContent;
    }
    return result;
  };

  const loaded = new Promise((resolve) => (document.readyState === "complete" ? resolve() : addEventListener("load", resolve, { once: true })));
  const atLoad = loaded.then(snapshot);
  const canvas = loaded.then(() => window.__canvasRoundTrip());
  const collect = async () => ({
    load: await atLoad,
    end: await snapshot(),
    canvas: await canvas,
    fields: fieldValues(),
    events: log.slice(),
  });

  if (FRAME === "iframe") {
    addEventListener("message", async (event) => {
      if (event.source !== parent) return;
      if (event.data === "parity-ready?") {
        await atLoad;
        await canvas;
        parent.postMessage("parity-ready", "*");
      }
      if (event.data === "parity-start") {
        log.length = 0;
        parent.postMessage("parity-started", "*");
      }
      if (event.data === "parity-collect") parent.postMessage({ parity: await collect() }, "*");
    });
    return;
  }

  const fromIframe = (ask, accept) =>
    new Promise((resolve) => {
      const listen = (event) => {
        const value = accept(event.data);
        if (value === undefined) return;
        removeEventListener("message", listen);
        resolve(value);
      };
      addEventListener("message", listen);
      document.getElementById("frame").contentWindow.postMessage(ask, "*");
    });
  window.__parity = {
    ready: async () => {
      await atLoad;
      await canvas;
      await fromIframe("parity-ready?", (data) => (data === "parity-ready" ? true : undefined));
      return true;
    },
    /** Drops events from before the session, which only reflect how the window came up. */
    start: async () => {
      log.length = 0;
      return fromIframe("parity-start", (data) => (data === "parity-started" ? true : undefined));
    },
    collect: async () => ({
      main: await collect(),
      iframe: await fromIframe("parity-collect", (data) => data?.parity),
    }),
  };
})();
