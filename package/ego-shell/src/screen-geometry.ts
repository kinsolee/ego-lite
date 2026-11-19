export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** A window position in screen DIPs, as `Browser.setWindowBounds` takes it. */
export type WindowBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Where the page's viewport is drawn inside the screen view. */
export type Fit = {
  /** Top-left of the drawn frame in view CSS pixels. */
  origin: Point;
  /** View CSS pixels per page CSS pixel; never above 1, so text is never blurred by enlarging. */
  scale: number;
  /** The page's viewport in CSS pixels, from the frame. */
  viewport: Size;
  /** The page's pinch zoom; input coordinates are divided by it. */
  pageScale: number;
};

/**
 * The page keeps the persona's viewport whatever size the shell window is.
 * The frame is scaled down to fit and centered; a larger view shows it 1:1.
 */
export function fit(view: Size, viewport: Size, pageScale: number): Fit {
  const scale = Math.min(
    1,
    view.width / viewport.width,
    view.height / viewport.height,
  );
  // A whole-pixel origin keeps the frame sharp and a 1:1 page's points whole.
  return {
    origin: {
      x: Math.floor((view.width - viewport.width * scale) / 2),
      y: Math.floor((view.height - viewport.height * scale) / 2),
    },
    scale,
    viewport,
    pageScale,
  };
}

/** A view point in page CSS pixels, or null in the letterbox margin. */
export function toPage(point: Point, at: Fit): Point | null {
  const x = (point.x - at.origin.x) / at.scale;
  const y = (point.y - at.origin.y) / at.scale;
  if (x < 0 || y < 0 || x >= at.viewport.width || y >= at.viewport.height) {
    return null;
  }
  return { x: x / at.pageScale, y: y / at.pageScale };
}

/** Screencast size cap: the view in device pixels. */
export function castSize(
  view: Size,
  viewDpr: number,
): { maxWidth: number; maxHeight: number } {
  return {
    maxWidth: Math.round(view.width * viewDpr),
    maxHeight: Math.round(view.height * viewDpr),
  };
}

const CASCADE_STEP = 28;
/** Where the first window sits from the available area's corner. */
const MARGIN = { left: 40, top: 12 };

/**
 * The n-th window of a process cascades from near the corner of the
 * available area, wholly inside it. A page reads its window position as
 * screenX/Y, and a real desktop never stacks two windows at one spot.
 */
export function windowPlacement(
  avail: WindowBounds,
  persona: Size,
  slot: number,
): WindowBounds {
  const room = {
    left: avail.left + MARGIN.left,
    top: avail.top + MARGIN.top,
    width: avail.width - MARGIN.left,
    height: avail.height - MARGIN.top,
  };
  const width = Math.min(persona.width, room.width);
  const height = Math.min(persona.height, room.height);
  const offset = slot * CASCADE_STEP;
  return {
    left: room.left + (offset % (room.width - width + 1)),
    top: room.top + (offset % (room.height - height + 1)),
    width,
    height,
  };
}
