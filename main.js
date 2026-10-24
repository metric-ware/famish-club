// Thin shell around the wasm client: owns the WebGL surface, atlas packing, the WebSocket, input
// listeners and the DOM main menu. All game logic and drawing decisions live in Rust.

import { glyphImage } from "./font.js";
import { serversForPage } from "./servers.js";
const ATLAS_SIZE = 4096;
const MAX_SPRITE_LOD = 3;
// Align cells and leave a transparent gutter at every generated mip level.
const SPRITE_PAD = 1 << MAX_SPRITE_LOD;

const SERVERS = serversForPage(location);

const $ = (id) => document.getElementById(id);
// Shown over the page only when the game cannot start.
function showError(text) {
  $("error").textContent = text;
  $("error").hidden = false;
}
const canvas = $("game");
const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, premultipliedAlpha: true });
if (!gl) {
  showError("WebGL2 is required to play.");
  throw new Error("WebGL2 unavailable");
}

let wasm;
let memory;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

// The screen's size in physical pixels: the HUD scales with it, so a 4K screen looks like a 1080p one.
const screenPixels = () => [screen.width * (window.devicePixelRatio || 1), screen.height * (window.devicePixelRatio || 1)];
// Glyphs are rasterised once, at the size the screen needs to keep text as sharp as at 1080p.
const FONT_PX = Math.round(40 * Math.min(3, Math.max(1, Math.min(screenPixels()[0] / 1920, screenPixels()[1] / 1080))));

const GLYPH_PAD = Math.ceil(FONT_PX / 8) + 2;

const readString = (ptr, len) => decoder.decode(new Uint8Array(memory.buffer, ptr, len));
function passBytes(bytes) {
  const ptr = wasm.alloc(bytes.length);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return [ptr, bytes.length];
}
const passString = (text) => passBytes(encoder.encode(text));

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

function showMenu(message) {
  $("chat").hidden = true;
  $("chat-input").value = "";
  $("status").textContent = message;
  $("menu").hidden = false;
  $("play").disabled = false;
  $("nickname").focus();
}

function hideMenu() {
  $("menu").hidden = true;
  canvas.focus();
}

$("join").addEventListener("submit", (e) => {
  e.preventDefault();
  // No connection is made until Play is pressed.
  $("status").textContent = "Connecting…";
  $("play").disabled = true;
  wasm.start(...passString($("nickname").value.trim()));
});

// ---- websocket (driven by the wasm client) -----------------------------------------------------

function connectSocket() {
  socket?.close();
  const ws = new WebSocket(SERVERS[selectedServer].url);
  ws.binaryType = "arraybuffer";
  socket = ws;
  ws.onopen = () => wasm.ws_open();
  ws.onmessage = (e) => {
    const [ptr, len] = passBytes(new Uint8Array(e.data));
    wasm.ws_message(ptr, len, performance.now());
  };
  ws.onclose = () => { if (socket === ws) { socket = null; wasm.ws_close(); } };
}

// ---- WebGL -------------------------------------------------------------------------------------

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
    float roundedDistance(vec2 at, vec2 halfSize, float radius) {
      vec2 q = abs(at) - (halfSize - radius);
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    }
    void main() {
      if (vShape.x > 0.0) {
        float distance = roundedDistance(vUv, vShape.xy, vShape.z);
        float coverage;
        if (vShape.w < 0.0) {
          coverage = clamp(0.5 - distance, 0.0, 1.0);
        } else {
          coverage = clamp(1.0 - distance, 0.0, 1.0);
          vec2 inner = vShape.xy - vShape.w;
          if (min(inner.x, inner.y) > 0.0) {
            float hole = roundedDistance(vUv, inner, max(0.0, vShape.z - vShape.w));
            coverage = min(coverage, clamp(1.0 + hole, 0.0, 1.0));
          }
        }
        float alpha = coverage * vMul.a;
        outColor = vec4(vMul.rgb * alpha, alpha);
      } else if (vShape.x < 0.0) {
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
          // Distances keep their source scale; each outlined string paints this pass before its fills.
          float distance = (0.5 - textureLod(uAtlas, vUv, 0.0).g) * (2.0 * uGlyphRange);
          float edge = clamp((vShape.y - distance) * vShape.z + 0.5, 0.0, 1.0);
          outline = edge * vMix.a * (1.0 - fill);
        }
        outColor = vec4(vMul.rgb * fill + vMix.rgb * outline, fill + outline);
      } else {
        vec4 t = texture(uAtlas, vUv);                       // premultiplied
        vec3 rgb = mix(t.rgb, vMix.rgb * t.a, vMix.a);       // flash overlay keeps the sprite's shape
        outColor = vec4(rgb, t.a) * vec4(vMul.rgb * vMul.a, vMul.a);
      }
    }`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
})();

const vao = gl.createVertexArray();
const vertexBuffer = gl.createBuffer();
const indexBuffer = gl.createBuffer();
gl.bindVertexArray(vao);
gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
gl.bufferData(gl.ARRAY_BUFFER, MAX_QUADS * 4 * VERTEX_BYTES, gl.DYNAMIC_DRAW);
const attribute = (name, size, type, normalized, offset) => {
  const loc = gl.getAttribLocation(program, name);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, type, normalized, VERTEX_BYTES, offset);
};
attribute("aPos", 2, gl.FLOAT, false, 0);
attribute("aUv", 2, gl.FLOAT, false, 8);
attribute("aMul", 4, gl.UNSIGNED_BYTE, true, 16);
attribute("aMix", 4, gl.UNSIGNED_BYTE, true, 20);
attribute("aShape", 4, gl.FLOAT, false, 24);
{
  const indices = new Uint16Array(MAX_QUADS * 6);
  for (let q = 0; q < MAX_QUADS; q++) {
    const v = q * 4;
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
}
gl.enable(gl.BLEND);
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
gl.useProgram(program);
gl.uniform1f(gl.getUniformLocation(program, "uGlyphRange"), GLYPH_PAD);

let dpr = 1;
function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(gl.getUniformLocation(program, "uScreen"), canvas.width, canvas.height);
  wasm?.resize(canvas.width, canvas.height, ...screenPixels());
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

/** Icon-fit bounds use alpha > 8; draw bounds include every nonzero pixel plus a filtering gutter. */
function contentBounds(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const scan = (threshold) => {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > threshold) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    if (x1 < 0) return [0, 0, w, h];
    if (threshold === 0) { x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(w - 1, x1 + 1); y1 = Math.min(h - 1, y1 + 1); }
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  };
  return { content: scan(8), bounds: scan(0) };
}

async function buildAtlas(files) {
  const response = await fetch("generated/manifest.json");
  if (!response.ok) throw new Error("generated art is missing; rebuild the client");
  const baked = await response.json();
  const images = await Promise.all(files.map((file) => {
    const entry = baked[file];
    if (file.startsWith("gen:") && !entry) throw new Error(`no baked sprite called ${file}`);
    return loadImage(entry ? entry.file : `assets/${file}.png`);
  }));

  const atlas = document.createElement("canvas");
  atlas.width = atlas.height = ATLAS_SIZE;
  const ctx = atlas.getContext("2d", { willReadFrequently: true });

  // shelf packing, tallest first
  const order = images.map((img, i) => i).sort((a, b) => images[b].height - images[a].height);
  let x = SPRITE_PAD, y = SPRITE_PAD, shelf = 0;
  const align = (v) => Math.ceil(v / SPRITE_PAD) * SPRITE_PAD;
  const place = (w, h) => {
    x = align(x);
    if (x + w + SPRITE_PAD > ATLAS_SIZE) { x = SPRITE_PAD; y = align(y + shelf + SPRITE_PAD); shelf = 0; }
    if (y + h + SPRITE_PAD > ATLAS_SIZE) throw new Error("the sprite atlas is full");
    const at = [x, y];
    x += w + SPRITE_PAD;
    shelf = Math.max(shelf, h);
    return at;
  };

  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  for (const i of order) {
    const img = images[i];
    const w = img.width, h = img.height;
    const [px, py] = place(w, h);
    ctx.drawImage(img, px, py);
    let metadata = baked[files[i]];
    if (!metadata) {
      probe.canvas.width = w; probe.canvas.height = h;
      probe.drawImage(img, 0, 0);
      metadata = contentBounds(probe, w, h);
    }
    // Mip filtering reaches beyond the first transparent pixel. Keep that fringe in the quad,
    // within the original image rectangle, so cropped edges do not clip as the camera pans.
    const [bx, by, bw, bh] = metadata.bounds;
    const left = Math.max(0, bx - SPRITE_PAD + 1), top = Math.max(0, by - SPRITE_PAD + 1);
    const right = Math.min(w, bx + bw + SPRITE_PAD - 1), bottom = Math.min(h, by + bh + SPRITE_PAD - 1);
    wasm.set_sprite(i, px, py, w, h, ...metadata.content, left, top, right - left, bottom - top);
  }

  // Glyphs retain full-resolution fill/distance masks and their visible bounds for badge alignment.
  ctx.font = `${FONT_PX}px "Baloo Paaji", system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  const metrics = ctx.measureText("Hg");
  const ascent = metrics.fontBoundingBoxAscent ?? FONT_PX * 0.9;
  const descent = metrics.fontBoundingBoxDescent ?? FONT_PX * 0.3;
  const cellH = Math.ceil(ascent + descent + GLYPH_PAD * 2);
  for (let code = 33; code < 127; code++) {
    const ch = String.fromCharCode(code);
    const ink = ctx.measureText(ch);
    const advance = ink.width;
    const cellW = Math.ceil(advance + GLYPH_PAD * 2);
    const [gx, gy] = place(cellW, cellH);
    ctx.putImageData(glyphImage(probe, ch, cellW, cellH, FONT_PX, GLYPH_PAD, ascent), gx, gy);
    wasm.set_glyph(code, gx, gy, cellW, cellH, advance,
      GLYPH_PAD - ink.actualBoundingBoxLeft, GLYPH_PAD + ascent - ink.actualBoundingBoxAscent,
      ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight, ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent);
  }
  wasm.set_glyph(32, 0, 0, 0, 0, ctx.measureText(" ").width, 0, 0, 0, 0);
  wasm.set_atlas(ATLAS_SIZE, ATLAS_SIZE, FONT_PX, GLYPH_PAD, ascent);

  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, MAX_SPRITE_LOD);
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
  window.addEventListener("blur", () => wasm.blur());
  document.addEventListener("visibilitychange", () => { if (document.hidden) wasm.blur(); });
  canvas.addEventListener("mousemove", (e) => wasm.mouse_move(e.clientX * dpr, e.clientY * dpr));
  canvas.addEventListener("mousedown", (e) => {
    wasm.mouse_move(e.clientX * dpr, e.clientY * dpr);
    // Right click (or shift + click) drops the stack, or opens its menu when "Drop whole stack" is off.
    if (e.button === 2 || (e.button === 0 && e.shiftKey)) return wasm.drop_click(e.clientX * dpr, e.clientY * dpr);
    // ctrl + click recycles one item of the slot under the cursor (next to a workbench)
    if (e.button === 0 && (e.ctrlKey || e.metaKey)) return wasm.recycle_click(e.clientX * dpr, e.clientY * dpr);
    if (e.button === 0) wasm.mouse_button(true);
  });
  window.addEventListener("mouseup", (e) => { if (e.button === 0) wasm.mouse_button(false); });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? innerHeight : 1);
    wasm.wheel(e.clientX * dpr, e.clientY * dpr, delta * dpr);
  }, { passive: false });
  window.addEventListener("resize", resize);
}

// ---- boot --------------------------------------------------------------------------------------

const imports = {
  env: {
    js_begin_frame: () => {
      gl.clearColor(0.2157, 0.2627, 0.1647, 1); // #37432a, the ground (resource_art::GROUND)
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    js_draw: (ptr, byteLength) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(memory.buffer, ptr, byteLength));
      gl.drawElements(gl.TRIANGLES, (byteLength / VERTEX_BYTES / 4) * 6, gl.UNSIGNED_SHORT, 0);
    },
    js_ws_connect: connectSocket,
    js_ws_send: (ptr, len) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(new Uint8Array(memory.buffer, ptr, len).slice());
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

  const files = readString(wasm.manifest_ptr(), wasm.manifest_len()).split("\n");
  await buildAtlas(files);

  renderServers();
  bindInput();
  resize();
  showMenu("");

  let firstFrame = true;
  const loop = (now) => {
    if (!document.hidden) {
      wasm.frame(now);
      if (firstFrame) { document.body.classList.add("ready"); firstFrame = false; }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot().catch((err) => {
  showError(`Failed to start: ${err.message}`);
  console.error(err);
});
