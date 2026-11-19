import assert from "node:assert/strict";
import test from "node:test";

import {
  castSize,
  fit,
  toPage,
  windowPlacement,
} from "../dist/screen-geometry.js";

const PAGE = { width: 1280, height: 800 };

test("a page larger than the view is scaled down to fit and centered", () => {
  const at = fit({ width: 640, height: 600 }, PAGE, 1);
  assert.equal(at.scale, 0.5);
  assert.deepEqual(at.origin, { x: 0, y: 100 });
  assert.deepEqual(at.viewport, PAGE);
});

test("a view larger than the page shows it 1:1 in the middle, never enlarged", () => {
  const at = fit({ width: 1480, height: 1000 }, PAGE, 1);
  assert.equal(at.scale, 1);
  assert.deepEqual(at.origin, { x: 100, y: 100 });
});

test("the frame starts on a whole CSS pixel, so a 1:1 page maps whole pixels to whole pixels", () => {
  const at = fit({ width: 1481, height: 1001 }, PAGE, 1);
  assert.deepEqual(at.origin, { x: 100, y: 100 });
  assert.deepEqual(toPage({ x: 137, y: 288 }, at), { x: 37, y: 188 });
});

test("a view point maps to the page point under it", () => {
  const at = fit({ width: 640, height: 600 }, PAGE, 1);
  assert.deepEqual(toPage({ x: 0, y: 100 }, at), { x: 0, y: 0 });
  assert.deepEqual(toPage({ x: 320, y: 300 }, at), { x: 640, y: 400 });
});

test("a point in the letterbox margin hits no page", () => {
  const at = fit({ width: 640, height: 600 }, PAGE, 1);
  assert.equal(toPage({ x: 320, y: 50 }, at), null);
  assert.equal(toPage({ x: 320, y: 500 }, at), null);
  assert.equal(toPage({ x: -1, y: 300 }, at), null);
});

test("a pinch-zoomed page takes coordinates divided by its scale", () => {
  const at = fit({ width: 1280, height: 800 }, PAGE, 2);
  assert.deepEqual(toPage({ x: 200, y: 100 }, at), { x: 100, y: 50 });
});

test("frames are never asked larger than the view draws them", () => {
  assert.deepEqual(castSize({ width: 941, height: 716 }, 2), { maxWidth: 1882, maxHeight: 1432 });
  assert.deepEqual(castSize({ width: 941.4, height: 716 }, 1.5), { maxWidth: 1412, maxHeight: 1074 });
});

test("each window of a process sits inside the available area at its own spot", () => {
  const avail = { left: 0, top: 25, width: 1920, height: 1055 };
  const persona = { width: 1440, height: 900 };
  const placed = [0, 1, 2, 3].map((slot) => windowPlacement(avail, persona, slot));
  for (const bounds of placed) {
    assert.equal(bounds.width, 1440);
    assert.equal(bounds.height, 900);
    assert.ok(bounds.left >= avail.left && bounds.top >= avail.top);
    assert.ok(bounds.left + bounds.width <= avail.left + avail.width);
    assert.ok(bounds.top + bounds.height <= avail.top + avail.height);
  }
  assert.equal(new Set(placed.map((b) => `${b.left},${b.top}`)).size, 4);
  assert.deepEqual(placed[0], { left: 40, top: 37, width: 1440, height: 900 }, "the first window sits off the corner, as a person leaves it");
});

test("a window larger than the available area is shrunk to fit inside its margins", () => {
  const avail = { left: 0, top: 25, width: 1280, height: 775 };
  const bounds = windowPlacement(avail, { width: 1440, height: 900 }, 3);
  assert.deepEqual(bounds, { left: 40, top: 37, width: 1240, height: 763 });
});
