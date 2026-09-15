// Hero background: a WebGL2 "prismatic glass" field.
// A soft studio gradient with three drifting low-saturation pools of light, refracted
// through one superellipse glass slab. Chromatic dispersion and a partial spectral
// rim only appear on short arcs of the edge (never a full saturated ring), in the
// product's Cobalt / Iris / Champagne. No particles, no scanlines, no bloom.
// Falls back to the CSS gradient when WebGL2 is unavailable; renders a single still
// frame under prefers-reduced-motion; pauses when offscreen or the tab is hidden.
(() => {
const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform vec3 uBase;
uniform vec3 uBase2;
uniform vec3 uCobalt;
uniform vec3 uIris;
uniform vec3 uChampagne;
uniform float uDark;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

vec3 field(vec2 uv, float t) {
  vec3 col = mix(uBase, uBase2, smoothstep(0.0, 1.0, uv.x * 0.6 + (1.0 - uv.y) * 0.6));
  vec2 p1 = vec2(0.26 + 0.05 * sin(t * 0.11), 0.72 + 0.05 * cos(t * 0.09));
  vec2 p2 = vec2(0.70 + 0.05 * cos(t * 0.07), 0.58 + 0.06 * sin(t * 0.13));
  vec2 p3 = vec2(0.56 + 0.07 * sin(t * 0.05), 0.12 + 0.04 * cos(t * 0.08));
  float n = fbm(uv * 3.0 + t * 0.02);
  float pool = mix(0.14, 0.34, uDark);
  col = mix(col, uIris, (1.0 - smoothstep(0.0, 0.55, distance(uv, p1))) * (pool * 0.9 + 0.08 * n));
  col = mix(col, uCobalt, (1.0 - smoothstep(0.0, 0.50, distance(uv, p2))) * (pool * 0.75 + 0.08 * n));
  col = mix(col, uChampagne, (1.0 - smoothstep(0.0, 0.52, distance(uv, p3))) * (pool * 1.2 + 0.1 * n));
  return col;
}

float lens(vec2 p, vec2 c, vec2 r, float k) {
  vec2 q = abs(p - c) / r;
  return pow(pow(q.x, k) + pow(q.y, k), 1.0 / k) - 1.0;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float t = uTime;
  vec3 col = field(uv, t);

  vec2 m = uMouse - 0.5;
  vec2 c = vec2(0.66 * aspect + m.x * 0.05 + 0.01 * sin(t * 0.21), 0.56 + m.y * 0.04 + 0.01 * cos(t * 0.17));
  vec2 r = vec2(0.36, 0.31);
  float k = 4.2;
  float d = lens(p, c, r, k);
  float e = 0.003;
  vec2 g = vec2(
    lens(p + vec2(e, 0.0), c, r, k) - lens(p - vec2(e, 0.0), c, r, k),
    lens(p + vec2(0.0, e), c, r, k) - lens(p - vec2(0.0, e), c, r, k));
  vec2 nrm = normalize(g + 1e-6);

  float inside = 1.0 - smoothstep(0.0, 0.010, d);
  float edge = smoothstep(-0.22, 0.0, d) * inside;
  vec2 off = nrm * edge * edge * 0.055;

  vec3 refr;
  refr.r = field(uv - off * 1.10, t).r;
  refr.g = field(uv - off, t).g;
  refr.b = field(uv - off * 0.90, t).b;
  vec3 glass = mix(refr, vec3(1.0), mix(0.07, 0.02, uDark));

  // Thin top-left highlight and a soft inner dark edge, like the product's glass recipe.
  float top = smoothstep(0.1, 1.0, dot(nrm, vec2(-0.45, 0.89)));
  float rimIn = (1.0 - smoothstep(0.0, 0.028, abs(d + 0.012)));
  glass += rimIn * top * mix(0.22, 0.10, uDark);
  glass -= rimIn * (1.0 - top) * 0.05;

  // Partial chromatic arcs: upper-left (iris→cobalt) and lower-right (champagne).
  float ang = atan(p.y - c.y, p.x - c.x);
  float arcA = smoothstep(0.35, 1.0, cos(ang - 2.35));
  float arcB = smoothstep(0.55, 1.0, cos(ang + 0.75));
  float rim = (1.0 - smoothstep(0.0, 0.0045, abs(d)));
  vec3 rimCol = mix(uIris, uCobalt, smoothstep(-1.0, 1.0, sin(ang * 3.0 + t * 0.3)));
  col = mix(col, glass, inside);
  col += rimCol * rim * arcA * mix(0.55, 0.9, uDark);
  col += uChampagne * rim * arcB * mix(0.7, 1.0, uDark);

  // Contact shadow below the slab.
  float shadow = (1.0 - smoothstep(0.0, 0.16, lens(p + vec2(0.0, 0.05), c, r * 1.02, k))) * (1.0 - inside);
  col -= shadow * mix(0.045, 0.12, uDark);

  col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) * 0.012;
  outColor = vec4(col, 1.0);
}`

function hexToRgb(hex) {
  const value = hex.trim().replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const n = parseInt(full, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function readPalette() {
  const cs = getComputedStyle(document.documentElement)
  const get = (name, fallback) => { const v = cs.getPropertyValue(name).trim(); return v.startsWith('#') ? v : fallback }
  const dark = document.documentElement.dataset.theme === 'obsidian' || document.documentElement.dataset.theme === 'dusk'
  return {
    base: hexToRgb(get('--studio-a', '#f5f7fa')),
    base2: hexToRgb(get('--studio-c', '#eef2f7')),
    cobalt: hexToRgb(get('--cobalt', '#376bff')),
    iris: hexToRgb(get('--iris', '#9276ff')),
    champagne: hexToRgb(get('--champagne', '#ead9b8')),
    dark: dark ? 1 : 0
  }
}

function initHero() {
  const canvas = document.querySelector('[data-hero-gl]')
  const hero = canvas?.closest('.hero')
  if (!canvas || !hero) return null
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' })
  if (!gl) return null

  const compile = (type, src) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('[hero-gl]', gl.getShaderInfoLog(shader))
      return null
    }
    return shader
  }
  const vs = compile(gl.VERTEX_SHADER, VERT)
  const fs = compile(gl.FRAGMENT_SHADER, FRAG)
  if (!vs || !fs) return null
  const program = gl.createProgram()
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.warn('[hero-gl]', gl.getProgramInfoLog(program)); return null }
  gl.useProgram(program)

  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const u = (name) => gl.getUniformLocation(program, name)
  const uRes = u('uRes'), uTime = u('uTime'), uMouse = u('uMouse')
  const uBase = u('uBase'), uBase2 = u('uBase2'), uCobalt = u('uCobalt'), uIris = u('uIris'), uChampagne = u('uChampagne'), uDark = u('uDark')

  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  let palette = readPalette()
  let visible = true
  let hidden = document.hidden
  let raf = 0
  let start = performance.now()
  const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 }

  const applyPalette = () => {
    gl.uniform3fv(uBase, palette.base)
    gl.uniform3fv(uBase2, palette.base2)
    gl.uniform3fv(uCobalt, palette.cobalt)
    gl.uniform3fv(uIris, palette.iris)
    gl.uniform3fv(uChampagne, palette.champagne)
    gl.uniform1f(uDark, palette.dark)
  }

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr))
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      gl.viewport(0, 0, w, h)
    }
    gl.uniform2f(uRes, w, h)
  }

  const frame = (now) => {
    raf = 0
    resize()
    mouse.x += (mouse.tx - mouse.x) * 0.06
    mouse.y += (mouse.ty - mouse.y) * 0.06
    gl.uniform2f(uMouse, mouse.x, mouse.y)
    gl.uniform1f(uTime, reduce.matches ? 4.0 : (now - start) / 1000)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (!reduce.matches && visible && !hidden) raf = requestAnimationFrame(frame)
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame) }

  applyPalette()
  resize()
  hero.classList.add('has-gl')
  kick()

  new ResizeObserver(() => { resize(); kick() }).observe(canvas)
  new IntersectionObserver((entries) => { visible = entries.some((e) => e.isIntersecting); if (visible) kick() }, { threshold: 0 }).observe(canvas)
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; if (!hidden) kick() })
  reduce.addEventListener('change', kick)
  hero.addEventListener('pointermove', (event) => {
    const rect = hero.getBoundingClientRect()
    mouse.tx = (event.clientX - rect.left) / rect.width
    mouse.ty = 1 - (event.clientY - rect.top) / rect.height
    if (reduce.matches) kick()
  }, { passive: true })
  document.addEventListener('themechange', () => { palette = readPalette(); applyPalette(); kick() })

  return { refresh: kick }
}
window.AICanvasSite = Object.assign(window.AICanvasSite ?? {}, { initHero })
})()
