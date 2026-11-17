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
  return {
    origin: {
      x: (view.width - viewport.width * scale) / 2,
      y: (view.height - viewport.height * scale) / 2,
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

/**
 * The n-th window of a process cascades from the corner of the available
 * area, wholly inside it. A page reads its window position as screenX/Y, and a
 * real desktop never stacks two windows at one spot.
 */
export function windowPlacement(
  avail: WindowBounds,
  persona: Size,
  slot: number,
): WindowBounds {
  const width = Math.min(persona.width, avail.width);
  const height = Math.min(persona.height, avail.height);
  const offset = slot * CASCADE_STEP;
  return {
    left: avail.left + (offset % (avail.width - width + 1)),
    top: avail.top + (offset % (avail.height - height + 1)),
    width,
    height,
  };
}
