// Compares what the page observed in the two modes. Every value is compared
// as recorded except the ones NORMALISATIONS names; each of those is printed
// with the verdict so a reader can see what was not compared exactly.

const nearest = (choices, value, scale = (x) => x) =>
  choices.reduce((best, choice) => (Math.abs(scale(choice) - scale(value)) < Math.abs(scale(best) - scale(value)) ? choice : best));

/** Gap from the previous event in the same frame's log, in buckets far from the driver's pauses. */
const gapBucket = (ms) => (ms < 12 ? "same" : ms < 110 ? "short" : "long");

/** Dispatched on the next animation frame, so their delay is a fraction of the frame interval. */
const FRAME_ALIGNED = new Set(["scroll", "scrollend"]);

export const NORMALISATIONS = [
  {
    path: "env.<frame>.<load|end>.timing.rafHz",
    rule: "frames counted in 1 s, snapped to the nearest of 30/60/75/90/120/144 Hz (the raw count jitters by a frame or two)",
    applies: (path) => /^env\.[^.]+\.[^.]+\.timing\.rafHz$/.test(path),
    apply: (value) => nearest([30, 60, 75, 90, 120, 144], value),
  },
  {
    path: "env.<frame>.<load|end>.timing.perfNowResolutionMs",
    rule: "measured step of performance.now(), snapped on a log scale to the nearest of 0.005/0.1/1 ms",
    applies: (path) => /^env\.[^.]+\.[^.]+\.timing\.perfNowResolutionMs$/.test(path),
    apply: (value) => nearest([0.005, 0.1, 1], value, Math.log),
  },
  {
    path: "env.<frame>.<load|end>.navigator.connection.downlink",
    rule: "not compared: it moves between runs in either mode (3.8-4.55 headless, 3.8-4.45 headful over 7 runs); effectiveType, rtt and saveData are compared",
    applies: (path) => /^env\..*\.navigator\.connection\.downlink$/.test(path),
    apply: () => "noisy-by-design",
  },
  {
    path: "events.<frame>[] before the session",
    rule: "the logs are cleared once the window has held focus for 0.5 s, just before the first step; events from page load until then only show how the OS activated the window",
  },
  {
    path: "events.<frame>[].t",
    rule: "absolute event.timeStamp is dropped; each event carries `gap`, the time since the previous event in its frame bucketed as same (<12 ms), short (<110 ms) or long",
  },
  {
    path: "events.<frame>[scroll|scrollend].gap",
    rule: "not compared: these fire on the next animation frame, so their delay after the wheel is a fraction of the frame interval; the frame rate itself is compared as timing.rafHz",
  },
];

export const KNOWN_LIMITS = [
  {
    applies: (path) => /\.hasFocus$/.test(path),
    note: "document.hasFocus(): a headless window keeps focus while other windows are focused; the shell cannot change what the page reads (plan, revision 4)",
  },
];

function projectEvents(events) {
  let previous;
  return events.map(({ t, ...rest }) => {
    const gap = previous === undefined ? "first" : FRAME_ALIGNED.has(rest.type) ? "frame" : gapBucket(t - previous);
    previous = t;
    return { ...rest, gap };
  });
}

function flatten(value, path, out) {
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((item, i) => [`${path}[${i}]`, item]) : Object.entries(value).map(([key, item]) => [`${path}.${key}`, item]);
    if (entries.length === 0) out.set(path, Array.isArray(value) ? "[]" : "{}");
    for (const [childPath, item] of entries) flatten(item, childPath, out);
    return out;
  }
  out.set(path, value);
  return out;
}

const eventKey = (event) => `${event.type}|${event.target}`;

/** Longest common subsequence of event keys, so one missing event is one diff, not a cascade. */
function align(left, right) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        eventKey(left[i]) === eventKey(right[j])
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && eventKey(left[i]) === eventKey(right[j])) pairs.push([i++, j++]);
    else if (j >= right.length || (i < left.length && table[(i + 1) * cols + j] >= table[i * cols + j + 1])) pairs.push([i++, null]);
    else pairs.push([null, j++]);
  }
  return pairs;
}

/** The parts of one mode's observation that get compared, other than events. */
function comparable(observation) {
  const result = { env: {}, canvas: {}, fields: {}, requests: observation.requests };
  for (const [frame, data] of Object.entries(observation.page)) {
    result.env[frame] = { load: data.load, end: data.end };
    result.canvas[frame] = data.canvas;
    result.fields[frame] = data.fields;
  }
  return result;
}

export function compare(headless, headful) {
  const diffs = [];
  const knownLimits = [];
  const push = (entry) => (KNOWN_LIMITS.some((limit) => limit.applies(entry.path)) ? knownLimits : diffs).push(entry);
  const normalise = (path, value) => {
    const rule = NORMALISATIONS.find((candidate) => candidate.applies?.(path));
    return rule && typeof value === "number" ? rule.apply(value) : value;
  };

  const left = flatten(comparable(headless), "", new Map());
  const right = flatten(comparable(headful), "", new Map());
  for (const rawPath of new Set([...left.keys(), ...right.keys()])) {
    const path = rawPath.slice(1);
    const a = normalise(path, left.get(rawPath));
    const b = normalise(path, right.get(rawPath));
    if (!Object.is(a, b)) push({ path, headless: a ?? null, headful: b ?? null });
  }

  for (const frame of Object.keys(headful.page)) {
    const a = projectEvents(headless.page[frame]?.events ?? []);
    const b = projectEvents(headful.page[frame].events);
    for (const [i, j] of align(a, b)) {
      if (j === null) push({ path: `events.${frame}[${i}]`, headless: a[i], headful: null });
      else if (i === null) push({ path: `events.${frame}[~${j}]`, headless: null, headful: b[j] });
      else {
        const where = i === j ? `${i}` : `${i}~${j}`;
        for (const field of new Set([...Object.keys(a[i]), ...Object.keys(b[j])])) {
          const x = JSON.stringify(a[i][field]);
          const y = JSON.stringify(b[j][field]);
          if (x !== y) push({ path: `events.${frame}[${where}].${field}`, event: eventKey(a[i]), headless: a[i][field] ?? null, headful: b[j][field] ?? null });
        }
      }
    }
  }
  return { diffs, knownLimits };
}
