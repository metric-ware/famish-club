// The page's glue around the wasm client: the WebGL surface, the sprite atlas, the WebSocket, input and the DOM menu.
// All game logic and drawing decisions live in Rust (client.wasm).

const $ = (id) => document.getElementById(id);

// Hosted pages play on Famish Europe; a page served from this machine (`./run.sh`) offers its own server first.
const SERVERS = (() => {
  const europe = { name: "Famish Europe", url: "wss://eu.famish.club/" };
  const host = location.hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host) && !host.endsWith(".localhost")) return [europe];
  return [{ name: "Local server", url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/` }, europe];
})();

// Shown over the page only when the game cannot start.
function showError(text) {
  $("error").textContent = text;
  $("error").hidden = false;
}
const canvas = $("game");
// Every shape and glyph is antialiased in the fragment shader and sprites fade out into transparent margins, so the
// framebuffer needs no multisampling.
const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
if (!gl) {
  showError("WebGL2 is required to play.");
  throw new Error("WebGL2 unavailable");
}

let wasm;
let memory;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const readString = (ptr, len) => decoder.decode(new Uint8Array(memory.buffer, ptr, len));
function passBytes(bytes) {
  const ptr = wasm.alloc(bytes.length);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return [ptr, bytes.length];
}
const passString = (text) => passBytes(encoder.encode(text));

// Glyphs are rasterised once, at the size the screen needs to keep text as sharp as at 1080p (the HUD scales with the
// screen's physical pixels, so a 4K screen looks like a 1080p one).
const SCREEN_SCALE = Math.min(screen.width / 1920, screen.height / 1080) * (window.devicePixelRatio || 1);
const FONT_PX = Math.round(40 * Math.min(3, Math.max(1, SCREEN_SCALE)));
const GLYPH_PAD = Math.ceil(FONT_PX / 8) + 2;
// Atlas cells sit on this grid with at least this much transparent gutter, so mip levels up to MAX_LOD never mix
// neighbouring sprites.
const MAX_LOD = 3;
const PAD = 1 << MAX_LOD;

// ---- menu --------------------------------------------------------------------------------------

let selectedServer = 0;
let socket = null;

function renderServers() {
  const list = $("servers");
  list.replaceChildren(...SERVERS.map((server, i) => {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = server.name;
    return option;
  }));
  list.value = String(selectedServer);
}

$("servers").addEventListener("change", (e) => { selectedServer = Number(e.target.value); });

// After a death (or a lost connection) the menu comes back while the player may still be pressing keys and clicking:
// for this long nothing in it but Play reacts to the mouse, and nothing in it takes focus, so keys meant for moving
// can't end up in the name field.
const MENU_GUARD_MS = 1000;
let menuGuardUntil = 0;
const menuGuarded = () => performance.now() < menuGuardUntil;

function showMenu(message, firstVisit = false) {
  $("chat").hidden = true;
  $("chat-input").value = "";
  $("status").textContent = message;
  $("menu").hidden = false;
  $("play").disabled = false;
  // the name field never takes focus by itself: the player clicks it to type
  if (!firstVisit) {
    menuGuardUntil = performance.now() + MENU_GUARD_MS;
    document.activeElement?.blur();
  }
}

// Capture phase, so the guard sees each event before the menu's own controls do.
for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "touchstart", "auxclick"]) {
  $("menu").addEventListener(type, (e) => {
    if (menuGuarded() && !$("play").contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true, passive: false });
}
$("menu").addEventListener("focusin", (e) => {
  if (menuGuarded() && !$("play").contains(e.target)) e.target.blur();
});

function hideMenu() {
  $("menu").hidden = true;
  canvas.focus();
}

$("join").addEventListener("submit", (e) => {
  e.preventDefault();
  // No connection is made until Play is pressed.
  $("status").textContent = "Connecting…";
  $("play").disabled = true;
  const passcode = typeof window.__famishAdminPasscode === "string" ? window.__famishAdminPasscode : "";
  wasm.start(...passString($("nickname").value.trim()), ...passString(passcode));
});

// ---- websocket (driven by the wasm client) -----------------------------------------------------

function connectSocket() {
  socket?.close();
  const ws = new WebSocket(SERVERS[selectedServer].url);
  ws.binaryType = "arraybuffer";
  socket = ws;
  ws.onopen = () => wasm.ws_open();
  ws.onmessage = (e) => wasm.ws_message(...passBytes(new Uint8Array(e.data)), performance.now());
  ws.onclose = () => { if (socket === ws) { socket = null; wasm.ws_close(); } };
}

// ---- WebGL -------------------------------------------------------------------------------------

// Each vertex: position, atlas uv (or local coordinates for shapes), multiply colour, mix colour, shape (see render.rs).
const VERTEX_BYTES = 40;
const MAX_QUADS = 8000;

const program = (() => {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, `#version 300 es
    in vec2 aPos; in vec2 aUv; in vec4 aMul; in vec4 aMix; in vec4 aShape;
    uniform vec2 uScreen;
    out vec2 vUv; out vec4 vMul; out vec4 vMix; flat out vec4 vShape;
    void main() {
      vUv = aUv; vMul = aMul; vMix = aMix; vShape = aShape;
      gl_Position = vec4(aPos.x / uScreen.x * 2.0 - 1.0, 1.0 - aPos.y / uScreen.y * 2.0, 0.0, 1.0);
    }`));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    in vec2 vUv; in vec4 vMul; in vec4 vMix; flat in vec4 vShape;
    uniform sampler2D uAtlas;
    uniform float uGlyphRange;
    out vec4 outColor;
    const float TAU = 6.2831853;
    float roundedDistance(vec2 at, vec2 halfSize, float radius) {
      vec2 q = abs(at) - (halfSize - radius);
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    }
    // premultiplied output of a shape whose edge is at signed distance 0 (in pixels, negative inside)
    vec4 shape(float coverage) {
      float alpha = clamp(coverage, 0.0, 1.0) * vMul.a;
      return vec4(vMul.rgb * alpha, alpha);
    }
    void main() {
      if (vShape.x > 0.0) {
        // a rounded box: filled, or a line vShape.w wide inside its edge
        float distance = roundedDistance(vUv, vShape.xy, vShape.z);
        if (vShape.w < 0.0) {
          outColor = shape(0.5 - distance);
        } else {
          float coverage = 1.0 - distance;
          vec2 inner = vShape.xy - vShape.w;
          if (min(inner.x, inner.y) > 0.0) coverage = min(coverage, 1.0 + roundedDistance(vUv, inner, max(0.0, vShape.z - vShape.w)));
          outColor = shape(coverage);
        }
      } else if (vShape.x < -1.5) {
        // a ring through radius vShape.y, vShape.z wide each side, from +x clockwise up to the angle vShape.w
        float radius = length(vUv);
        float band = abs(radius - vShape.y) - vShape.z;
        float cut = -1e4;
        if (vShape.w < TAU) {
          float a = atan(vUv.y, vUv.x);
          if (a < 0.0) a += TAU;
          cut = (a <= vShape.w ? -min(a, vShape.w - a) : min(a - vShape.w, TAU - a)) * radius;
        }
        outColor = shape(0.5 - max(band, cut));
      } else if (vShape.x < 0.0) {
        // a glyph: its antialiased fill (red channel), and an outline from its distance field (green channel)
        float fill = 0.0;
        if (vMul.a > 0.0) {
          // Four half-pixel footprints antialias small text without the broader blur of one full-pixel mip sample.
          vec2 dx = dFdx(vUv), dy = dFdy(vUv);
          float coverage = (
            textureGrad(uAtlas, vUv + (dx + dy) * 0.25, dx * 0.5, dy * 0.5).r +
            textureGrad(uAtlas, vUv + (dx - dy) * 0.25, dx * 0.5, dy * 0.5).r +
            textureGrad(uAtlas, vUv + (-dx + dy) * 0.25, dx * 0.5, dy * 0.5).r +
            textureGrad(uAtlas, vUv - (dx + dy) * 0.25, dx * 0.5, dy * 0.5).r) * 0.25;
          fill = coverage * vMul.a;
        }
        float outline = 0.0;
        if (vMix.a > 0.0) {
          float distance = (0.5 - textureLod(uAtlas, vUv, 0.0).g) * (2.0 * uGlyphRange);
          outline = clamp((vShape.y - distance) * vShape.z + 0.5, 0.0, 1.0) * vMix.a * (1.0 - fill);
        }
        outColor = vec4(vMul.rgb * fill + vMix.rgb * outline, fill + outline);
      } else {
        // a sprite (premultiplied): tinted by vMul, and mixed towards vMix (a hit flash) within its shape
        vec4 t = texture(uAtlas, vUv);
        vec3 rgb = mix(t.rgb, vMix.rgb * t.a, vMix.a);
        outColor = vec4(rgb, t.a) * vec4(vMul.rgb * vMul.a, vMul.a);
      }
    }`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
})();

const vertexBuffer = gl.createBuffer();
gl.bindVertexArray(gl.createVertexArray());
gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
gl.bufferData(gl.ARRAY_BUFFER, MAX_QUADS * 4 * VERTEX_BYTES, gl.DYNAMIC_DRAW);
for (const [name, size, type, normalized, offset] of [
  ["aPos", 2, gl.FLOAT, false, 0], ["aUv", 2, gl.FLOAT, false, 8], ["aMul", 4, gl.UNSIGNED_BYTE, true, 16],
  ["aMix", 4, gl.UNSIGNED_BYTE, true, 20], ["aShape", 4, gl.FLOAT, false, 24],
]) {
  const location = gl.getAttribLocation(program, name);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, type, normalized, VERTEX_BYTES, offset);
}
{
  const indices = new Uint16Array(MAX_QUADS * 6);
  for (let q = 0; q < MAX_QUADS; q++) indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
}
gl.enable(gl.BLEND);
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
gl.useProgram(program);
gl.uniform1f(gl.getUniformLocation(program, "uGlyphRange"), GLYPH_PAD);
const screenUniform = gl.getUniformLocation(program, "uScreen");

let dpr = 1;
function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(screenUniform, canvas.width, canvas.height);
  wasm.resize(canvas.width, canvas.height);
}

// ---- glyphs ------------------------------------------------------------------------------------

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

function glyphImage(ctx, char, width, height, ascent) {
  const s = SDF_SUPERSAMPLE, bigW = width * s, bigH = height * s;
  ctx.canvas.width = bigW; ctx.canvas.height = bigH;
  ctx.font = `${FONT_PX * s}px "Baloo Paaji", system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  ctx.fillText(char, GLYPH_PAD * s, (GLYPH_PAD + ascent) * s);
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
  const image = new ImageData(width, height);
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
      image.data[at + 1] = Math.round(255 * Math.max(0, Math.min(1, 0.5 - distance / (2 * GLYPH_PAD))));
      image.data[at + 3] = 255; // mask channels must survive premultiplied texture uploads
    }
  }
  return image;
}

// ---- atlas -------------------------------------------------------------------------------------

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

/** The visible pixels (alpha > 8: what icons are fitted to) and the quad to draw (every pixel that isn't fully
 *  transparent, plus the filtering fringe that reaches into the transparent gutter), relative to the image. */
function spriteBounds(data, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, vx0 = w, vy0 = h, vx1 = -1, vy1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const alpha = data[(y * w + x) * 4 + 3];
      if (alpha === 0) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      if (alpha > 8) { vx0 = Math.min(vx0, x); vy0 = Math.min(vy0, y); vx1 = Math.max(vx1, x); vy1 = Math.max(vy1, y); }
    }
  }
  const fringe = PAD - 1;
  return {
    content: vx1 < 0 ? [0, 0, w, h] : [vx0, vy0, vx1 - vx0 + 1, vy1 - vy0 + 1],
    bounds: x1 < 0 ? [0, 0, w, h] : [x0 - fringe, y0 - fringe, x1 - x0 + 1 + 2 * fringe, y1 - y0 + 1 + 2 * fringe],
  };
}

/** Packs the manifest's sprite paths and the font's glyphs into one mipmapped texture, and tells the wasm
 *  where each one is. */
async function buildAtlas(names) {
  const images = await Promise.all(names.map((name) => loadImage(name)));
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  probe.font = `${FONT_PX}px "Baloo Paaji", system-ui, sans-serif`;
  const metrics = probe.measureText("Hg");
  const ascent = metrics.fontBoundingBoxAscent ?? FONT_PX * 0.9;
  const descent = metrics.fontBoundingBoxDescent ?? FONT_PX * 0.3;
  const space = probe.measureText(" ").width;
  const glyphs = [];
  for (let code = 33; code < 127; code++) {
    const ink = probe.measureText(String.fromCharCode(code));
    glyphs.push({ code, ink, w: Math.ceil(ink.width + GLYPH_PAD * 2), h: Math.ceil(ascent + descent + GLYPH_PAD * 2) });
  }

  // shelf packing, tallest sprites first, then the glyphs
  const width = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const align = (v) => Math.ceil(v / PAD) * PAD;
  let x = PAD, y = PAD, shelf = 0;
  const place = (w, h) => {
    x = align(x);
    if (x + w + PAD > width) { x = PAD; y = align(y + shelf + PAD); shelf = 0; }
    const at = [x, y];
    x += w + PAD;
    shelf = Math.max(shelf, h);
    return at;
  };
  const order = images.map((_, i) => i).sort((a, b) => images[b].height - images[a].height);
  const spots = new Map(order.map((i) => [i, place(images[i].width, images[i].height)]));
  const glyphSpots = glyphs.map((g) => place(g.w, g.h));
  const height = align(y + shelf + PAD);
  if (height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error("the sprite atlas is too big for this GPU");

  const atlas = document.createElement("canvas");
  atlas.width = width;
  atlas.height = height;
  const ctx = atlas.getContext("2d", { willReadFrequently: true });
  images.forEach((img, i) => {
    const [px, py] = spots.get(i);
    ctx.drawImage(img, px, py);
    const { content, bounds } = spriteBounds(ctx.getImageData(px, py, img.width, img.height).data, img.width, img.height);
    wasm.set_sprite(i, px, py, img.width, img.height, ...content, ...bounds);
  });
  glyphs.forEach(({ code, ink, w, h }, i) => {
    const [gx, gy] = glyphSpots[i];
    ctx.putImageData(glyphImage(probe, String.fromCharCode(code), w, h, ascent), gx, gy);
    wasm.set_glyph(code, gx, gy, w, h, ink.width,
      GLYPH_PAD - ink.actualBoundingBoxLeft, GLYPH_PAD + ascent - ink.actualBoundingBoxAscent,
      ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight, ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent);
  });
  wasm.set_glyph(32, 0, 0, 0, 0, space, 0, 0, 0, 0);
  wasm.set_atlas(width, height, FONT_PX, GLYPH_PAD, ascent);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, MAX_LOD);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "uAtlas"), 0);
}

// ---- input -------------------------------------------------------------------------------------

function bindInput() {
  const typing = () => ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
  const closeChat = () => {
    $("chat").hidden = true;
    $("chat-input").value = "";
    wasm.chat_focus(false);
    canvas.focus();
  };
  $("chat").addEventListener("submit", (e) => {
    e.preventDefault();
    wasm.chat_submit(...passString($("chat-input").value));
    closeChat();
  });
  $("chat-input").addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); closeChat(); }
  });
  window.addEventListener("keydown", (e) => {
    if (e.repeat || typing()) return;
    // nothing in the menu has focus after a death, so Enter plays from anywhere on it, as it does from the name field
    if (e.code === "Enter" && !$("menu").hidden && !document.activeElement?.closest("a, button")) {
      e.preventDefault();
      if (!$("play").disabled) $("join").requestSubmit();
      return;
    }
    if (e.code === "Enter" && $("menu").hidden) {
      e.preventDefault();
      $("chat").hidden = false;
      wasm.chat_focus(true);
      $("chat-input").focus();
      return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    wasm.key(...passString(e.code), true);
  });
  window.addEventListener("keyup", (e) => wasm.key(...passString(e.code), false));
  const pressedMouseButtons = new Set();
  window.addEventListener("blur", () => { pressedMouseButtons.clear(); wasm.blur(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { pressedMouseButtons.clear(); wasm.blur(); } });
  canvas.addEventListener("mousemove", (e) => wasm.mouse_move(e.clientX * dpr, e.clientY * dpr));
  canvas.addEventListener("mousedown", (e) => {
    wasm.mouse_move(e.clientX * dpr, e.clientY * dpr);
    if (e.button !== 0 && e.button !== 2) { wasm.cancel_auto_hit(); return; }
    // Inventory right-click/shift-click drops only; a right click in the world attacks normally.
    if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
      if (wasm.drop_click(e.clientX * dpr, e.clientY * dpr) || e.shiftKey) return;
    }
    pressedMouseButtons.add(e.button);
    wasm.mouse_button(true);
  });
  window.addEventListener("mouseup", (e) => {
    if (pressedMouseButtons.delete(e.button) && pressedMouseButtons.size === 0) wasm.mouse_button(false);
  });
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? innerHeight : 1);
    wasm.wheel(e.clientX * dpr, e.clientY * dpr, delta * dpr);
  }, { passive: false });
  window.addEventListener("resize", resize);
  // Ask before the tab closes or reloads while in a game, so a slip of the hand doesn't throw the run away.
  window.addEventListener("beforeunload", (e) => {
    if ($("menu").hidden) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

// ---- boot --------------------------------------------------------------------------------------

const imports = {
  env: {
    js_begin_frame: () => {
      gl.clearColor(0.1020, 0.2392, 0.1843, 1); // #1a3d2f, the ground
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    js_draw: (ptr, byteLength) => {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(memory.buffer, ptr, byteLength));
      gl.drawElements(gl.TRIANGLES, (byteLength / VERTEX_BYTES / 4) * 6, gl.UNSIGNED_SHORT, 0);
    },
    js_ws_connect: connectSocket,
    js_ws_send: (ptr, len) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(new Uint8Array(memory.buffer, ptr, len).slice());
    },
    js_show_menu: (ptr, len) => showMenu(readString(ptr, len)),
    js_hide_menu: hideMenu,
    js_clip: (enabled, x, y, w, h) => {
      if (!enabled) { gl.disable(gl.SCISSOR_TEST); return; }
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.round(x), Math.round(canvas.height - y - h), Math.max(0, Math.round(w)), Math.max(0, Math.round(h)));
    },
  },
};

async function boot() {
  const [result] = await Promise.all([
    WebAssembly.instantiateStreaming(fetch("client.wasm"), imports),
    document.fonts.load(`${FONT_PX}px "Baloo Paaji"`),
  ]);
  wasm = result.instance.exports;
  memory = wasm.memory;
  await buildAtlas(readString(wasm.manifest_ptr(), wasm.manifest_len()).split("\n"));

  renderServers();
  bindInput();
  resize();
  showMenu("", true);

  let firstFrame = true;
  const loop = (now) => {
    wasm.frame(now);
    if (firstFrame) { document.body.classList.add("ready"); firstFrame = false; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot().catch((err) => {
  showError(`Failed to start: ${err.message}`);
  console.error(err);
});
