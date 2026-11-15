/** How a highlight reaches the browser that draws it. */
export type OverlayChannel = {
  /** Open a CDP session on the tab that no agent sees, and return its id. */
  attach(): Promise<string>;
  send(
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ): Promise<any>;
};

/** Side lengths, in CSS pixels, of the square drawn where the agent acts. */
const SIZES = [44, 30, 20];
const STEP_MS = 130;
const HOLD_MS = 450;
const FILL = { r: 255, g: 96, b: 48, a: 0.35 };
const OUTLINE = { r: 255, g: 96, b: 48, a: 0.9 };

/**
 * A shrinking square drawn by the browser's overlay where the agent is about
 * to act, so the page's DOM is untouched. It needs the DOM and Overlay domains
 * enabled, so it uses a session of its own: neither then shows up in, or is
 * switched off by, the session agents drive.
 */
export class MouseHighlight {
  readonly #channel: OverlayChannel;
  #session: Promise<string> | undefined;
  #sessionId: string | undefined;
  #shown = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(channel: OverlayChannel) {
    this.#channel = channel;
  }

  /** Whether CDP traffic on this session belongs to the highlight. */
  owns(sessionId: string | undefined): boolean {
    return sessionId !== undefined && sessionId === this.#sessionId;
  }

  /** Show the highlight at a point in viewport CSS pixels. */
  async show(x: number, y: number): Promise<void> {
    this.#session ??= this.#open().catch((error) => {
      this.#session = undefined;
      throw error;
    });
    const session = await this.#session;
    const scale = await this.#scale(session);
    const draw = (size: number) =>
      this.#channel.send(
        "Overlay.highlightRect",
        {
          x: Math.round((x - size / 2) / scale),
          y: Math.round((y - size / 2) / scale),
          width: Math.round(size / scale),
          height: Math.round(size / scale),
          color: FILL,
          outlineColor: OUTLINE,
        },
        session,
      );
    clearTimeout(this.#timer);
    await draw(SIZES[0]!);
    this.#shown = true;
    let step = 1;
    const next = () => {
      const size = SIZES[step++];
      if (size === undefined) {
        void this.hide();
        return;
      }
      draw(size).catch(() => {});
      this.#timer = setTimeout(next, step === SIZES.length ? HOLD_MS : STEP_MS);
    };
    this.#timer = setTimeout(next, STEP_MS);
  }

  async hide(): Promise<void> {
    clearTimeout(this.#timer);
    if (!this.#shown || !this.#sessionId) return;
    this.#shown = false;
    await this.#channel
      .send("Overlay.hideHighlight", {}, this.#sessionId)
      .catch(() => {});
  }

  /** The session is gone; the next highlight opens a new one. */
  reset(): void {
    clearTimeout(this.#timer);
    this.#shown = false;
    this.#session = undefined;
    this.#sessionId = undefined;
  }

  async #open(): Promise<string> {
    const sessionId = await this.#channel.attach();
    this.#sessionId = sessionId;
    await this.#channel.send("DOM.enable", {}, sessionId);
    await this.#channel.send("Overlay.enable", {}, sessionId);
    return sessionId;
  }

  /**
   * How many times larger the browser draws a highlight than the page pixels
   * it is given: the display's scale, 2 on a Retina screen.
   */
  async #scale(session: string): Promise<number> {
    const metrics = await this.#channel
      .send("Page.getLayoutMetrics", {}, session)
      .catch(() => undefined);
    const scale =
      metrics?.visualViewport?.clientWidth /
      metrics?.cssVisualViewport?.clientWidth;
    return scale > 0 && Number.isFinite(scale) ? scale : 1;
  }
}
