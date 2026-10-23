// Glyph fill coverage and a signed distance field are rasterised once and shared by the outline/fill passes.
// A separable squared-distance transform keeps atlas preparation linear in the number of pixels.
function distanceTransform(grid, width, height) {
  const max = Math.max(width, height);
  const f = new Float64Array(max), d = new Float64Array(max);
  const sites = new Int32Array(max), edges = new Float64Array(max + 1);
  const line = (length) => {
    let k = 0;
    sites[0] = 0; edges[0] = -Infinity; edges[1] = Infinity;
    for (let q = 1; q < length; q++) {
      let s;
      do {
        const p = sites[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * (q - p));
        if (s <= edges[k]) k--;
        else break;
      } while (k >= 0);
      sites[++k] = q; edges[k] = s; edges[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < length; q++) {
      while (edges[k + 1] < q) k++;
      const delta = q - sites[k];
      d[q] = delta * delta + f[sites[k]];
    }
  };
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    line(height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x];
    line(width);
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x];
  }
}

// The fill and the distance field are measured on a glyph drawn this many times larger, then box-filtered down: measured
// on the cell's own pixels, slanted and curved edges come out stair-stepped and the outline drawn from it looks pixelated.
const SDF_SUPERSAMPLE = 4;

export function glyphImage(ctx, char, width, height, fontPx, pad, ascent) {
  const s = SDF_SUPERSAMPLE, bigW = width * s, bigH = height * s;
  ctx.canvas.width = bigW; ctx.canvas.height = bigH;
  ctx.font = `${fontPx * s}px "Baloo Paaji", system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  ctx.fillText(char, pad * s, (pad + ascent) * s);
  const big = ctx.getImageData(0, 0, bigW, bigH).data;
  const outer = new Float64Array(bigW * bigH), inner = new Float64Array(bigW * bigH);
  for (let i = 0; i < outer.length; i++) {
    const alpha = big[i * 4 + 3] / 255;
    outer[i] = alpha === 0 ? 1e20 : Math.max(0, 0.5 - alpha) ** 2;
    inner[i] = alpha === 1 ? 1e20 : Math.max(0, alpha - 0.5) ** 2;
  }
  distanceTransform(outer, bigW, bigH);
  distanceTransform(inner, bigW, bigH);

  // The fill is box-filtered from the same big drawing: a separate small drawing snaps its baseline to a different pixel
  // than the big one, which slid the fill up to a pixel against its outline (thin on top, thick at the bottom).
  ctx.canvas.width = width; ctx.canvas.height = height;
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // the mean coverage and signed distance over the cell's block of big pixels, the distance in cell pixels
      let coverage = 0, sum = 0;
      for (let by = y * s; by < (y + 1) * s; by++) {
        for (let bx = x * s; bx < (x + 1) * s; bx++) {
          const i = by * bigW + bx;
          coverage += big[i * 4 + 3];
          sum += Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
        }
      }
      const distance = sum / (s * s * s);
      const at = (y * width + x) * 4;
      image.data[at] = Math.round(coverage / (s * s)); // antialiased fill
      image.data[at + 1] = Math.round(255 * Math.max(0, Math.min(1, 0.5 - distance / (2 * pad))));
      image.data[at + 2] = 0;
      image.data[at + 3] = 255; // mask channels must survive premultiplied texture uploads
    }
  }
  return image;
}
