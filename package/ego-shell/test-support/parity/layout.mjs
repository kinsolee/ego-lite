// One fixed layout, used by the page builder and by the driver, so the driver
// never asks the page where anything is.

export const ELEMENTS = [
  { id: "btn", tag: "button", box: [20, 20, 120, 36], text: "Comprar" },
  { id: "dbl", tag: "div", box: [160, 20, 120, 36], text: "dois cliques" },
  { id: "ctx", tag: "div", box: [300, 20, 120, 36], text: "menu", attrs: 'oncontextmenu="event.preventDefault()"' },
  { id: "scroller", tag: "div", box: [20, 76, 400, 80], html: '<div style="height:2000px">rolar</div>', style: "overflow:auto" },
  { id: "txt", tag: "input", box: [20, 176, 400, 30] },
  { id: "ime", tag: "input", box: [20, 226, 400, 30] },
  { id: "clipA", tag: "input", box: [20, 276, 400, 30], attrs: 'value="Pedido número 42"' },
  { id: "clipB", tag: "input", box: [20, 326, 400, 30] },
  { id: "ce", tag: "div", box: [20, 376, 400, 30], text: "Olá mundo", attrs: "contenteditable" },
  {
    id: "sel",
    tag: "select",
    box: [20, 426, 200, 30],
    html: '<option value="a">alpha</option><option value="b">beta</option><option value="c">gamma</option>',
  },
  { id: "after", tag: "button", box: [240, 426, 120, 30], text: "fim" },
];

/** Where the cross-origin iframe sits in the top page, in CSS pixels. */
export const IFRAME_BOX = [520, 10, 460, 480];

export function center(id, frame) {
  const element = ELEMENTS.find((candidate) => candidate.id === id);
  const [x, y, width, height] = element.box;
  const [dx, dy] = frame === "iframe" ? IFRAME_BOX : [0, 0];
  return { x: dx + x + Math.round(width / 2), y: dy + y + Math.round(height / 2) };
}

export function pageHtml({ frame, iframeSrc }) {
  const boxes = ELEMENTS.map(({ id, tag, box: [x, y, w, h], text = "", html, attrs = "", style = "" }) => {
    const css = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;${style}`;
    return `<${tag} id="${id}" class="box" style="${css}" ${attrs}>${html ?? text}</${tag}>`;
  }).join("\n");
  const [fx, fy, fw, fh] = IFRAME_BOX;
  const iframe =
    frame === "main"
      ? `<iframe id="frame" src="${iframeSrc}" style="position:absolute;left:${fx}px;top:${fy}px;width:${fw}px;height:${fh}px;border:0"></iframe>`
      : "";
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>parity ${frame}</title>
<style>html,body{margin:0;font:14px Helvetica,Arial,sans-serif}.box{position:absolute;box-sizing:border-box;margin:0}div.box{border:1px solid #888}</style>
<body>
${boxes}
${iframe}
<script src="/observer.js"></script>
</body></html>`;
}
