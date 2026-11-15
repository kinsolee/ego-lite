import assert from "node:assert/strict";
import test from "node:test";

import { SnapshotError, captureSnapshot } from "../dist/snapshot.js";

let nextNodeId = 1;

/** Flatten a nested description into the node list `Accessibility.getFullAXTree` returns. */
function axNodes(tree) {
  const nodes = [];
  const add = (spec, parentId) => {
    const nodeId = String(nextNodeId++);
    const node = {
      nodeId,
      parentId,
      ignored: spec.ignored ?? false,
      role: { value: spec.role },
      name: { value: spec.name ?? "" },
      backendDOMNodeId: spec.id,
      properties: Object.entries(spec.props ?? {}).map(([name, value]) => ({
        name,
        value: { value },
      })),
      ...(spec.value === undefined ? {} : { value: { value: spec.value } }),
      childIds: [],
    };
    nodes.push(node);
    for (const child of spec.children ?? []) {
      node.childIds.push(add(child, nodeId));
    }
    return nodeId;
  };
  add(tree, undefined);
  return nodes;
}

/**
 * A page as the shell's debugger sees it. `frames` maps frame id to its AX
 * tree, `sessions` maps an out-of-process frame id to the session hosting it,
 * and `owners` maps a child frame id to the backend id of its iframe element.
 */
function fakePage({ frames, tree, sessions = {}, owners = {}, layout }) {
  const hostedBy = (frameId) => sessions[frameId];
  const subtree = (node) => ({
    frame: { id: node.id },
    childFrames: (node.children ?? [])
      .filter((child) => hostedBy(child.id) === hostedBy(node.id))
      .map(subtree),
  });
  const find = (node, id) =>
    node.id === id
      ? node
      : (node.children ?? []).map((child) => find(child, id)).find(Boolean);
  const calls = [];
  return {
    calls,
    childFrames: () => new Map(Object.entries(sessions)),
    send: async (method, params = {}, sessionId) => {
      calls.push(method);
      if (method === "Page.getFrameTree") {
        const rootId = sessionId
          ? Object.keys(sessions).find((id) => sessions[id] === sessionId)
          : tree.id;
        return { frameTree: subtree(find(tree, rootId)) };
      }
      if (method === "Accessibility.getFullAXTree") {
        if (hostedBy(params.frameId) !== sessionId || !frames[params.frameId]) {
          throw new Error("Frame with the given frameId is not found.");
        }
        return { nodes: axNodes(frames[params.frameId]) };
      }
      if (method === "DOM.getFrameOwner") {
        const parent = find(tree, params.frameId) && owners[params.frameId];
        if (!parent || parent.session !== sessionId) {
          throw new Error("Frame owner is not in this session");
        }
        return { backendNodeId: parent.backendNodeId };
      }
      if (method === "Page.getLayoutMetrics") return layout.metrics;
      if (method === "DOMSnapshot.captureSnapshot") return layout.snapshot;
      throw new Error(`unexpected ${method}`);
    },
  };
}

const shop = {
  role: "RootWebArea",
  name: "Shop",
  id: 1,
  children: [
    {
      role: "heading",
      name: "Shop",
      id: 2,
      children: [{ role: "StaticText", name: "Shop", id: 3 }],
    },
    {
      role: "generic",
      id: 4,
      children: [
        {
          role: "button",
          name: "Add to cart",
          id: 5,
          props: { focusable: true },
          children: [{ role: "StaticText", name: "Add to cart", id: 6 }],
        },
      ],
    },
    {
      role: "link",
      name: "Help",
      id: 7,
      props: { focusable: true, url: "https://shop.test/help" },
    },
    {
      role: "link",
      name: "Help",
      id: 8,
      props: { focusable: true, url: "https://shop.test/faq" },
    },
    {
      role: "textbox",
      name: "Search",
      id: 9,
      value: "shoes",
      props: { focusable: true, editable: "plaintext" },
      children: [{ role: "generic", id: 10, props: { editable: "plaintext" } }],
    },
    { role: "StaticText", name: "", id: 11 },
    {
      role: "checkbox",
      name: "Gift wrap",
      id: 12,
      props: { focusable: true, checked: "true" },
    },
  ],
};

test("a page renders as the indented tree the harness parses, with refs on actionable nodes", async () => {
  const page = fakePage({ tree: { id: "top" }, frames: { top: shop } });
  const { content, refs } = await captureSnapshot(page);

  assert.equal(
    content,
    [
      'root "Shop"',
      '  heading "Shop"',
      '  button "Add to cart" [ref=5, loc=role:button[name=Add to cart]]',
      '  link "Help" [ref=7, url=https://shop.test/help]',
      '  link "Help" [ref=8, url=https://shop.test/faq]',
      '  textbox "Search" [ref=9, loc=role:textbox[name=Search], value="shoes"]',
      '  checkbox "Gift wrap" [ref=12, loc=role:checkbox[name=Gift wrap], checked]',
    ].join("\n"),
  );
  assert.deepEqual(refs[0], {
    backendNodeId: 5,
    role: "button",
    name: "Add to cart",
    loc: "role:button[name=Add to cart]",
  });
  assert.deepEqual(
    refs.map((ref) => ref.backendNodeId),
    [5, 7, 8, 9, 12],
  );
});

test("a locator is offered only when it names exactly one node", async () => {
  const page = fakePage({ tree: { id: "top" }, frames: { top: shop } });
  const { refs } = await captureSnapshot(page);
  const help = refs.filter((ref) => ref.name === "Help");

  assert.equal(help.length, 2);
  assert.ok(help.every((ref) => ref.loc === undefined));
});

test("locators can be left out", async () => {
  const page = fakePage({ tree: { id: "top" }, frames: { top: shop } });
  const { content, refs } = await captureSnapshot(page, {
    includeStableLocator: false,
  });

  assert.doesNotMatch(content, /loc=/);
  assert.ok(refs.every((ref) => ref.loc === undefined));
});

test("interactiveOnly keeps the actionable nodes and their ancestors", async () => {
  const page = fakePage({ tree: { id: "top" }, frames: { top: shop } });
  const { content } = await captureSnapshot(page, { interactiveOnly: true });

  assert.doesNotMatch(content, /heading/);
  assert.match(content, /^root "Shop"\n {2}button "Add to cart"/);
});

test("maxResultLength cuts the text and still reports the refs", async () => {
  const page = fakePage({ tree: { id: "top" }, frames: { top: shop } });
  const { content, refs } = await captureSnapshot(page, { maxResultLength: 1 });

  assert.equal(content, "r");
  assert.equal(refs.length, 5);
});

test("a subtree snapshot starts at the requested node", async () => {
  const page = fakePage({ tree: { id: "top" }, frames: { top: shop } });
  const { content } = await captureSnapshot(page, {
    scope: "subtree",
    root: 9,
  });

  assert.equal(
    content,
    'textbox "Search" [ref=9, loc=role:textbox[name=Search], value="shoes"]',
  );
  await assert.rejects(
    captureSnapshot(page, { scope: "subtree", root: 999 }),
    (error) =>
      error instanceof SnapshotError &&
      error.error_code === "EGO_SNAPSHOT_FAILED" &&
      /Snapshot root not found: 999/.test(error.message),
  );
});

const framed = {
  role: "RootWebArea",
  name: "Checkout",
  id: 1,
  children: [
    { role: "button", name: "Pay", id: 2, props: { focusable: true } },
    { role: "Iframe", name: "Card", id: 3 },
    { role: "Iframe", name: "Terms", id: 4 },
  ],
};
const cardFrame = {
  role: "RootWebArea",
  name: "Card form",
  id: 1,
  children: [
    { role: "textbox", name: "Card number", id: 2, props: { focusable: true } },
    { role: "button", name: "Pay", id: 3, props: { focusable: true } },
  ],
};
const termsFrame = {
  role: "RootWebArea",
  name: "Terms",
  id: 20,
  children: [
    { role: "link", name: "Read all", id: 21, props: { focusable: true } },
  ],
};

function checkoutPage() {
  return fakePage({
    tree: { id: "top", children: [{ id: "card" }, { id: "terms" }] },
    frames: { top: framed, card: cardFrame, terms: termsFrame },
    // The card frame is another site's process; the terms frame shares the page's.
    sessions: { card: "S-CARD" },
    owners: {
      card: { session: undefined, backendNodeId: 3 },
      terms: { session: undefined, backendNodeId: 4 },
    },
  });
}

test("iframe documents nest under their iframe, whichever process hosts them", async () => {
  const { content } = await captureSnapshot(checkoutPage());

  assert.equal(
    content,
    [
      'root "Checkout"',
      '  button "Pay" [ref=2]',
      '  iframe "Card" [ref=3, loc=role:iframe[name=Card]]',
      '    root "Card form"',
      '      textbox "Card number" [ref=22, loc=role:textbox[name=Card number]]',
      '      button "Pay" [ref=23]',
      '  iframe "Terms" [ref=4, loc=role:iframe[name=Terms]]',
      '    root "Terms"',
      '      link "Read all" [ref=24, loc=role:link[name=Read all]]',
    ].join("\n"),
  );
});

test("frame refs carry a frame id and a ref id that cannot collide with the page's", async () => {
  const { refs } = await captureSnapshot(checkoutPage());
  const inFrames = refs.filter((ref) => ref.frameId);

  assert.deepEqual(
    inFrames.map(({ refId, backendNodeId, frameId }) => [
      refId,
      backendNodeId,
      frameId,
    ]),
    [
      [22, 2, "card"],
      [23, 3, "card"],
      [24, 21, "terms"],
    ],
  );
  const printed = refs.map((ref) => ref.refId ?? ref.backendNodeId);
  assert.equal(new Set(printed).size, printed.length);
});

test("a name shared between the page and a frame gets no locator", async () => {
  const { refs } = await captureSnapshot(checkoutPage());

  assert.ok(refs.filter((ref) => ref.name === "Pay").every((ref) => !ref.loc));
});

test("a frame that disappears mid-snapshot is left out instead of failing the page", async () => {
  const page = checkoutPage();
  const send = page.send;
  page.send = async (method, params, sessionId) => {
    if (sessionId === "S-CARD")
      throw new Error("Session with given id not found.");
    return send(method, params, sessionId);
  };
  const { content } = await captureSnapshot(page);

  assert.match(content, /iframe "Card" \[ref=3/);
  assert.doesNotMatch(content, /Card form/);
  assert.match(content, /root "Terms"/);
});

test("a viewport snapshot keeps what intersects the viewport, in CSS pixels", async () => {
  const page = fakePage({
    tree: { id: "top" },
    frames: {
      top: {
        role: "RootWebArea",
        name: "Long page",
        id: 1,
        children: [
          { role: "button", name: "Top", id: 2, props: { focusable: true } },
          { role: "button", name: "Edge", id: 3, props: { focusable: true } },
          { role: "button", name: "Below", id: 4, props: { focusable: true } },
        ],
      },
    },
    layout: {
      metrics: {
        cssLayoutViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 1000,
          clientHeight: 700,
        },
        cssVisualViewport: { clientWidth: 1000 },
        visualViewport: { clientWidth: 2000 },
      },
      snapshot: {
        documents: [
          {
            nodes: { backendNodeId: [1, 2, 3, 4] },
            layout: {
              nodeIndex: [0, 1, 2, 3],
              // Device pixels at a scale factor of 2.
              bounds: [
                [0, 0, 2000, 6000],
                [40, 40, 200, 60],
                [40, 1380, 200, 60],
                [40, 1420, 200, 60],
              ],
            },
          },
        ],
      },
    },
  });
  const { content } = await captureSnapshot(page, {
    scope: "only_within_viewport",
  });

  assert.match(content, /button "Top"/);
  assert.match(content, /button "Edge"/);
  assert.doesNotMatch(content, /button "Below"/);
});

test("a page that cannot be read fails with the snapshot error code", async () => {
  const page = fakePage({ tree: { id: "top" }, frames: {} });

  await assert.rejects(
    captureSnapshot(page),
    (error) =>
      error.error_code === "EGO_SNAPSHOT_FAILED" &&
      /Snapshot failed: Frame with the given frameId is not found/.test(
        error.message,
      ),
  );
});

test("a subtree root whose backend id occurs in more than one frame is refused", async () => {
  // Backend ids are local to a frame's process: the card frame's textbox and
  // the page's Pay button are both 2.
  await assert.rejects(
    captureSnapshot(checkoutPage(), { scope: "subtree", root: 2 }),
    (error) =>
      error instanceof SnapshotError &&
      error.error_code === "EGO_SNAPSHOT_FAILED" &&
      /Snapshot root 2 is ambiguous/.test(error.message),
  );

  const { content } = await captureSnapshot(checkoutPage(), {
    scope: "subtree",
    root: 21,
  });
  assert.match(content, /^link "Read all"/);
});
