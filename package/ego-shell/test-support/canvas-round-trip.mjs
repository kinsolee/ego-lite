/**
 * A page expression resolving to how many canvas bytes changed on two round
 * trips. Both are 0 unless the kernel adds noise a page can test for.
 */
export const CANVAS_ROUND_TRIPS = `(async () => {
  const differing = (a, b) => a.reduce((n, v, i) => n + (v !== b[i]), 0);
  const source = document.createElement("canvas");
  source.width = source.height = 64;
  const context = source.getContext("2d");
  const written = context.createImageData(64, 64);
  for (let i = 0; i < written.data.length; i += 4) {
    written.data.set([i % 251, (i * 7) % 253, (i * 13) % 255, 255], i);
  }
  context.putImageData(written, 0, 0);
  const image = new Image();
  image.src = source.toDataURL();
  await image.decode();
  const copy = document.createElement("canvas");
  copy.width = copy.height = 64;
  copy.getContext("2d").drawImage(image, 0, 0);
  return {
    putThenGet: differing(written.data, context.getImageData(0, 0, 64, 64).data),
    dataUrlThenGet: differing(
      written.data,
      copy.getContext("2d").getImageData(0, 0, 64, 64).data,
    ),
  };
})()`;
