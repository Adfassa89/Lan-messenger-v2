// Warlock 3D building blocks: procedural textures, shaders and the particle
// engine. Everything is generated in code; there are no image files.
import * as THREE from './vendor/three/three.module.min.js';

export const rand = (a, b) => a + Math.random() * (b - a);
export const col = (hex) => new THREE.Color(hex);

// ------------------------------------------------------------------ noise (CPU)
function hash(i, j, seed) {
  let n = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
// Value noise that repeats every `per` cells, so textures tile seamlessly.
export function vnoise(x, y, seed = 1, per = 1 << 20) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const m = (v) => ((v % per) + per) % per;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(m(xi), m(yi), seed);
  const b = hash(m(xi + 1), m(yi), seed);
  const c = hash(m(xi), m(yi + 1), seed);
  const d = hash(m(xi + 1), m(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, oct = 4, seed = 1, per = 1 << 20) {
  let s = 0;
  let a = 0.5;
  let p = per;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y, seed + i * 17, p);
    x *= 2; y *= 2; p *= 2; a *= 0.5;
  }
  return s / (1 - 0.5 ** oct);
}

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ------------------------------------------------------------------ particle atlas
// 2 x 2 tiles: 0 soft glow, 1 flame, 2 smoke puff, 3 spark streak.
export const TILE_GLOW = 0;
export const TILE_FLAME = 1;
export const TILE_SMOKE = 2;
export const TILE_SPARK = 3;
export function particleAtlas() {
  const S = 128;
  const c = canvas(S * 2);
  const g = c.getContext('2d');
  const tile = (t, fn) => {
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const [r, gg, b, a] = fn(x / S, y / S);
        const i = (y * S + x) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = a;
      }
    }
    // Tile t sits at uv offset (t % 2, floor(t / 2)) with uv (0,0) bottom-left.
    g.putImageData(img, (t % 2) * S, (1 - Math.floor(t / 2)) * S);
  };
  const clamp = (v) => Math.max(0, Math.min(1, v));
  tile(TILE_GLOW, (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const a = clamp(1 - d) ** 2.2;
    return [255, 255, 255, a * 255];
  });
  tile(TILE_FLAME, (u, v) => {
    const d = Math.hypot(u - 0.5, (v - 0.5) * 0.9) * 2;
    const n = fbm(u * 5, v * 5, 4, 3, 5);
    const a = clamp((1 - d * 1.15) + (n - 0.5) * 0.9) ** 1.4;
    const l = 0.55 + 0.45 * n;
    return [255 * l, 255 * l, 255 * l, a * 255];
  });
  tile(TILE_SMOKE, (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const n = fbm(u * 4, v * 4, 5, 9, 4);
    const a = clamp(clamp(1 - d) ** 1.1 * (0.35 + n * 1.1) - 0.08);
    const l = 0.75 + 0.25 * n;
    return [255 * l, 255 * l, 255 * l, a * 255];
  });
  tile(TILE_SPARK, (u, v) => {
    const a = Math.exp(-((v - 0.5) ** 2) * 160) * clamp(1 - Math.abs(u - 0.5) * 2) ** 0.7;
    return [255, 255, 255, a * 255];
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// ------------------------------------------------------------------ particle engine
// Camera-facing quads drawn in one call, with texture tile, rotation, colour
// over life, growth and velocity stretch (for sparks).
export class Particles {
  constructor(scene, max, additive, atlas) {
    this.max = max;
    this.n = 0;
    this.scale = 1; // lowered on slow PCs
    const F = (k) => new Float32Array(max * k);
    Object.assign(this, {
      pos: F(3), vel: F(3), c0: F(3), c1: F(3), a0: F(1), s0: F(1), s1: F(1), life: F(1), age: F(1),
      grav: F(1), drag: F(1), rot: F(1), spin: F(1), tile: F(1), str: F(1),
    });
    this.iPos = F(3);
    this.iVel = F(3);
    this.iCol = F(4);
    this.iMisc = F(4);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name, arr, k) => geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage));
    attr('iPos', this.iPos, 3);
    attr('iVel', this.iVel, 3);
    attr('iCol', this.iCol, 4);
    attr('iMisc', this.iMisc, 4);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: atlas } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `
        attribute vec3 iPos; attribute vec3 iVel; attribute vec4 iCol; attribute vec4 iMisc;
        varying vec2 vUv; varying vec4 vCol;
        void main() {
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          vec2 c = position.xy;
          float size = iMisc.x;
          vec2 off;
          if (iMisc.w > 0.0) {
            vec3 v = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
            float l = length(v.xy);
            vec2 dir = l > 0.001 ? v.xy / l : vec2(1.0, 0.0);
            float len = size + l * iMisc.w;
            off = dir * c.x * len + vec2(-dir.y, dir.x) * c.y * size;
          } else {
            float s = sin(iMisc.y), k = cos(iMisc.y);
            off = vec2(k * c.x - s * c.y, s * c.x + k * c.y) * size;
          }
          mv.xy += off;
          gl_Position = projectionMatrix * mv;
          vUv = (uv + vec2(mod(iMisc.z, 2.0), floor(iMisc.z / 2.0))) * 0.5;
          vCol = iCol;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying vec2 vUv; varying vec4 vCol;
        void main() {
          vec4 t = texture2D(map, vUv);
          gl_FragColor = vec4(vCol.rgb * t.rgb, vCol.a * t.a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 4 : 3;
    scene.add(this.mesh);
  }

  // o: { p:[x,y,z], v:[x,y,z], c0, c1 (THREE.Color), a, size, size1, life, tile, grav, drag, rot, spin, stretch }
  add(o) {
    if (this.n >= this.max) return;
    if (this.scale < 1 && Math.random() > this.scale) return;
    const i = this.n++;
    const i3 = i * 3;
    this.pos[i3] = o.p[0]; this.pos[i3 + 1] = o.p[1]; this.pos[i3 + 2] = o.p[2];
    const v = o.v || [0, 0, 0];
    this.vel[i3] = v[0]; this.vel[i3 + 1] = v[1]; this.vel[i3 + 2] = v[2];
    const c0 = o.c0;
    const c1 = o.c1 || c0;
    this.c0[i3] = c0.r; this.c0[i3 + 1] = c0.g; this.c0[i3 + 2] = c0.b;
    this.c1[i3] = c1.r; this.c1[i3 + 1] = c1.g; this.c1[i3 + 2] = c1.b;
    this.a0[i] = o.a ?? 1;
    this.s0[i] = o.size;
    this.s1[i] = o.size1 ?? o.size;
    this.life[i] = o.life;
    this.age[i] = 0;
    this.grav[i] = o.grav || 0;
    this.drag[i] = o.drag ?? 0.92;
    this.rot[i] = o.rot ?? Math.random() * 6.283;
    this.spin[i] = o.spin ?? 0;
    this.tile[i] = o.tile ?? TILE_GLOW;
    this.str[i] = o.stretch || 0;
  }

  update(dt) {
    let j = 0;
    const fields = ['pos', 'vel', 'c0', 'c1'];
    const singles = ['a0', 's0', 's1', 'life', 'grav', 'drag', 'rot', 'spin', 'tile', 'str'];
    for (let i = 0; i < this.n; i++) {
      const age = this.age[i] + dt;
      if (age >= this.life[i]) continue;
      if (j !== i) {
        for (const f of fields) this[f].copyWithin(j * 3, i * 3, i * 3 + 3);
        for (const f of singles) this[f][j] = this[f][i];
      }
      this.age[j] = age;
      const k = age / this.life[j];
      const d = this.drag[j] ** (dt * 60);
      const o = j * 3;
      this.vel[o] *= d;
      this.vel[o + 2] *= d;
      this.vel[o + 1] = this.vel[o + 1] * d - this.grav[j] * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      this.rot[j] += this.spin[j] * dt;
      this.iPos[o] = this.pos[o]; this.iPos[o + 1] = this.pos[o + 1]; this.iPos[o + 2] = this.pos[o + 2];
      this.iVel[o] = this.vel[o]; this.iVel[o + 1] = this.vel[o + 1]; this.iVel[o + 2] = this.vel[o + 2];
      const ck = Math.min(1, k * 1.4);
      const o4 = j * 4;
      this.iCol[o4] = this.c0[o] + (this.c1[o] - this.c0[o]) * ck;
      this.iCol[o4 + 1] = this.c0[o + 1] + (this.c1[o + 1] - this.c0[o + 1]) * ck;
      this.iCol[o4 + 2] = this.c0[o + 2] + (this.c1[o + 2] - this.c0[o + 2]) * ck;
      // Quick fade-in, long fade-out.
      this.iCol[o4 + 3] = this.a0[j] * Math.min(1, k * 12) * (1 - k) ** 1.3;
      this.iMisc[o4] = this.s0[j] + (this.s1[j] - this.s0[j]) * k;
      this.iMisc[o4 + 1] = this.rot[j];
      this.iMisc[o4 + 2] = this.tile[j];
      this.iMisc[o4 + 3] = this.str[j];
      j++;
    }
    this.n = j;
    this.geo.instanceCount = j;
    for (const a of ['iPos', 'iVel', 'iCol', 'iMisc']) {
      const at = this.geo.attributes[a];
      at.needsUpdate = true;
      at.clearUpdateRanges();
      at.addUpdateRange(0, j * at.itemSize);
    }
  }
}

// ------------------------------------------------------------------ GLSL helpers
export const GLSL_NOISE = `
  float hash1(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  vec2 hash2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash1(i), hash1(i + vec2(1, 0)), u.x), mix(hash1(i + vec2(0, 1)), hash1(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return v;
  }
  float fbm3(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return v;
  }`;

// ------------------------------------------------------------------ lava
// Cooled basalt crust plates drifting on molten rock: glowing cracks between
// the plates, finer cracks inside them, open molten pools, lit crust with
// bumps and a glossy sheen, hotter next to the platform.
export function lavaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uEdge: { value: 2000 },
      uSun: { value: new THREE.Vector3(-0.45, 0.8, -0.35).normalize() },
      uFog: { value: col('#1a0603') },
    },
    vertexShader: `
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime; uniform float uEdge; uniform vec3 uSun; uniform vec3 uFog; varying vec3 vW;
      ${GLSL_NOISE}
      // Distance to the nearest crack between Voronoi plates (Inigo Quilez's method).
      vec3 plates(vec2 x, float t) {
        vec2 n = floor(x), f = fract(x), mg, mr; vec2 mc; float md = 8.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(float(i), float(j));
          vec2 o = hash2(n + g); o = 0.5 + 0.38 * sin(t + 6.2831 * o);
          vec2 r = g + o - f; float d = dot(r, r);
          if (d < md) { md = d; mr = r; mg = g; mc = n + g; }
        }
        md = 8.0;
        for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
          vec2 g = mg + vec2(float(i), float(j));
          vec2 o = hash2(n + g); o = 0.5 + 0.38 * sin(t + 6.2831 * o);
          vec2 r = g + o - f;
          if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
        }
        return vec3(md, hash1(mc), length(mr));
      }
      vec3 heat(float x) {
        vec3 c = mix(vec3(0.18, 0.006, 0.0), vec3(1.25, 0.14, 0.008), smoothstep(0.0, 0.45, x));
        c = mix(c, vec3(2.6, 0.85, 0.1), smoothstep(0.4, 0.8, x));
        return mix(c, vec3(4.2, 2.7, 1.1), smoothstep(0.86, 1.0, x));
      }
      void main() {
        float t = uTime;
        float dist = length(vW.xz);
        vec2 q = vW.xz + vec2(t * 7.0, t * 4.0);
        vec2 warp = vec2(fbm3(q * 0.0009 + t * 0.016), fbm3(q * 0.0009 - t * 0.013 + 7.3)) * 380.0;
        vec2 uv = (q + warp) / 520.0;
        vec3 pl = plates(uv, t * 0.1);
        float edge = pl.x, cell = pl.y;
        // Cracks glow brighter in some places than others.
        float cv = smoothstep(0.3, 0.75, fbm3(q * 0.0035 + cell * 3.0 + t * 0.05));
        float w = 0.018 + 0.035 * cv;
        float crack = (1.0 - smoothstep(0.0, w, edge)) * (0.3 + 0.7 * cv);
        float fine = pow(1.0 - abs(2.0 * fbm3((q + warp) * 0.009 + cell * 13.0) - 1.0), 16.0) * 0.55 * cv;
        // Rivers and pools of open molten rock.
        float river = 1.0 - abs(2.0 * fbm3((q + warp * 1.6) * 0.00045 + vec2(t * 0.008, 0.0)) - 1.0);
        river = smoothstep(0.86, 0.97, river);
        float pool = max(river, smoothstep(0.68, 0.8, fbm3(q * 0.00035 + vec2(t * 0.004, -t * 0.003))));
        float near = smoothstep(220.0, 0.0, dist - uEdge) * 0.35;
        float T = max(max(crack, fine), pool * (0.62 + 0.18 * fbm3(uv * 2.0 - t * 0.1)));
        T = max(T, near * (0.6 + 0.4 * fbm3(uv * 4.0 + t * 0.3)));
        T *= 0.85 + 0.15 * sin(t * 1.5 + cell * 30.0 + edge * 9.0);
        // Crust: dark, gently lumpy basalt.
        float H = (0.65 * fbm3(uv * 6.0) + 0.35 * noise(uv * 34.0)) * (1.0 - pool) * smoothstep(0.0, 0.06, edge) * 12.0;
        vec3 sx = dFdx(vW), sy = dFdy(vW), up = vec3(0.0, 1.0, 0.0);
        vec3 r1 = cross(sy, up), r2 = cross(up, sx);
        float det = dot(sx, r1);
        vec3 grad = sign(det) * (dFdx(H) * r1 + dFdy(H) * r2);
        vec3 N = normalize(abs(det) * up - grad);
        vec3 V = normalize(cameraPosition - vW);
        float tone = fbm3(uv * 3.0 + cell * 2.0);
        vec3 albedo = mix(vec3(0.016, 0.013, 0.013), vec3(0.05, 0.04, 0.036), tone);
        float diff = max(dot(N, uSun), 0.0);
        vec3 lit = albedo * (diff * vec3(1.9, 1.7, 1.5) + vec3(0.16, 0.05, 0.03));
        lit += vec3(1.0, 0.85, 0.7) * pow(max(dot(N, normalize(uSun + V)), 0.0), 30.0) * 0.06;
        // Red glow on the crust around hot cracks.
        float halo = (1.0 - smoothstep(0.0, w * 7.0, edge)) * cv + pool * 0.3;
        lit += vec3(0.5, 0.06, 0.005) * halo * 0.6;
        vec3 c = mix(lit, heat(T), smoothstep(0.08, 0.6, T));
        float fog = smoothstep(4200.0, 12000.0, distance(cameraPosition, vW));
        gl_FragColor = vec4(mix(c, uFog, fog), 1.0);
      }`,
  });
}

// ------------------------------------------------------------------ fiery orb
// Animated noise ball with bright edges: fireballs, homing orbs, meteors' heat.
export function orbMaterial(hot, mid, cool, power = 2.6) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHot: { value: col(hot) }, uMid: { value: col(mid) }, uCool: { value: col(cool) }, uPow: { value: power } },
    vertexShader: `
      varying vec3 vP; varying vec3 vN; varying vec3 vV;
      void main() {
        vP = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uHot; uniform vec3 uMid; uniform vec3 uCool; uniform float uPow;
      varying vec3 vP; varying vec3 vN; varying vec3 vV;
      ${GLSL_NOISE}
      void main() {
        vec3 p = normalize(vP);
        float n = fbm3(p.xy * 2.5 + p.z * 1.7 + vec2(uTime * 2.2, -uTime * 1.6));
        n = mix(n, fbm3(p.zy * 3.1 - vec2(uTime * 1.3, uTime * 2.6)), 0.5);
        float fr = 1.0 - abs(dot(vN, vV));
        float k = clamp(n * 1.3 - 0.15 + (1.0 - fr) * 0.35, 0.0, 1.0);
        vec3 c = mix(uCool, uMid, smoothstep(0.15, 0.55, k));
        c = mix(c, uHot, smoothstep(0.55, 0.95, k));
        c += uMid * pow(fr, 2.5) * 0.8;
        gl_FragColor = vec4(c * uPow, 1.0);
      }`,
  });
}

// Fresnel bubble with a hexagon pattern: the Shield spell, spawn protection.
export function bubbleMaterial(color, hex = true) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: col(color) }, uAlpha: { value: 1 }, uTime: { value: 0 }, uHit: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uAlpha; uniform float uTime; uniform float uHit;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      float hexd(vec2 p) {
        p = abs(p);
        return max(dot(p, normalize(vec2(1.0, 1.732))), p.x);
      }
      void main() {
        float fr = pow(1.0 - abs(dot(vN, vV)), 2.4);
        float h = 0.0;
        ${hex ? `
        vec2 uv = vec2(atan(vP.z, vP.x) * 2.2, vP.y * 3.4);
        vec2 r = vec2(1.0, 1.732);
        vec2 a = mod(uv, r) - r * 0.5, b = mod(uv - r * 0.5, r) - r * 0.5;
        vec2 g = dot(a, a) < dot(b, b) ? a : b;
        h = smoothstep(0.42, 0.5, hexd(g));` : ''}
        float wave = 0.5 + 0.5 * sin(vP.y * 4.0 - uTime * 5.0);
        float glow = 0.06 + fr * 1.2 + h * (0.25 + 0.35 * wave) + uHit * 0.8;
        gl_FragColor = vec4(uColor * glow * uAlpha, 1.0);
      }`,
  });
}

// Expanding ring on the ground: blast waves.
export function shockMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: col(color) }, uProg: { value: 0 }, uWidth: { value: 0.1 }, uAlpha: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uColor; uniform float uProg; uniform float uWidth; uniform float uAlpha; varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float ring = exp(-pow((d - uProg) / uWidth, 2.0));
        float fill = smoothstep(uProg, 0.0, d) * 0.18;
        gl_FragColor = vec4(uColor * (ring * 2.2 + fill) * uAlpha, 1.0);
      }`,
  });
}

// Vertical beam (teleport, swap).
export function beamMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: col(color) }, uTime: { value: 0 }, uAlpha: { value: 1 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime; uniform float uAlpha; varying vec2 vUv;
      ${GLSL_NOISE}
      void main() {
        float n = fbm3(vec2(vUv.x * 6.0, vUv.y * 3.0 - uTime * 4.0));
        float a = (1.0 - vUv.y) * (0.4 + n) * uAlpha;
        gl_FragColor = vec4(uColor * a * 2.0, 1.0);
      }`,
  });
}

// Black hole: a spinning spiral disk.
export function swirlMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: col(color) }, uTime: { value: 0 }, uAlpha: { value: 1 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime; uniform float uAlpha; varying vec2 vUv;
      ${GLSL_NOISE}
      void main() {
        vec2 p = vUv - 0.5;
        float r = length(p) * 2.0;
        float a = atan(p.y, p.x);
        float s = sin(a * 3.0 + log(r + 0.02) * 7.0 + uTime * 5.0);
        float n = fbm3(vec2(a * 2.0 + uTime, r * 5.0 - uTime * 2.0));
        float arms = smoothstep(0.1, 1.0, s * 0.5 + 0.5 + n * 0.5);
        float fall = smoothstep(1.0, 0.25, r) * smoothstep(0.08, 0.2, r);
        float core = smoothstep(0.2, 0.1, r);
        vec3 c = uColor * arms * fall * 1.8 + vec3(1.4, 1.1, 2.0) * smoothstep(0.24, 0.17, r) * smoothstep(0.1, 0.17, r);
        gl_FragColor = vec4(c * (1.0 - core) * uAlpha, 1.0);
      }`,
  });
}

// Glowing ribbon (lightning, chains of light): brightest in the middle.
export function ribbonMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: col(color) }, uAlpha: { value: 1 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: 'attribute float side; varying float vS; void main() { vS = side; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uColor; uniform float uAlpha; varying float vS;
      void main() { float k = 1.0 - abs(vS); gl_FragColor = vec4(uColor * pow(k, 1.5) * uAlpha, 1.0); }`,
  });
}

// Heat shimmer over hot pixels, plus a soft vignette.
export const HazeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAmt: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uAmt; varying vec2 vUv;
    ${GLSL_NOISE}
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      float hot = clamp(base.r * 0.7 + base.g * 0.3 - 0.35, 0.0, 1.0);
      vec2 n = vec2(noise(vUv * vec2(46.0, 26.0) + vec2(0.0, uTime * 2.2)), noise(vUv * vec2(40.0, 30.0) + vec2(4.0, uTime * 2.6))) - 0.5;
      vec4 c = texture2D(tDiffuse, vUv + n * 0.006 * hot * uAmt);
      vec2 d = vUv - 0.5;
      c.rgb *= mix(0.6, 1.0, smoothstep(0.82, 0.3, length(d * vec2(1.0, 1.2))));
      gl_FragColor = c;
    }`,
};

// ------------------------------------------------------------------ textures
export function stoneTexture(seed) {
  const S = 256;
  const c = canvas(S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const base = [[112, 101, 91], [104, 92, 83], [118, 107, 95], [96, 88, 80]][seed % 4];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = fbm(x / 40, y / 40, 5, seed * 7 + 1, 256 / 40 | 0 || 1);
      const fine = vnoise(x / 3, y / 3, seed + 50);
      const k = 0.62 + n * 0.55 + (fine - 0.5) * 0.12;
      const i = (y * S + x) * 4;
      img.data[i] = base[0] * k; img.data[i + 1] = base[1] * k; img.data[i + 2] = base[2] * k; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  // Worn, darker edges and a lighter top-left bevel.
  const edge = g.createLinearGradient(0, 0, S, S);
  edge.addColorStop(0, 'rgba(255,240,220,.10)');
  edge.addColorStop(1, 'rgba(0,0,0,.18)');
  g.fillStyle = edge;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(18,12,9,.55)';
  g.lineWidth = 6;
  g.strokeRect(3, 3, S - 6, S - 6);
  // Cracks.
  g.lineCap = 'round';
  for (let k = 0; k < 2 + (seed % 3); k++) {
    let x = rnd() * S;
    let y = rnd() * S;
    g.strokeStyle = 'rgba(15,10,8,.38)';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(x, y);
    for (let j = 0; j < 6; j++) { x += (rnd() - 0.5) * 60; y += (rnd() - 0.5) * 60; g.lineTo(x, y); }
    g.stroke();
    g.strokeStyle = 'rgba(255,235,210,.08)';
    g.lineWidth = 1;
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Woven cloth (greyscale, tinted by the player's colour) with an embroidered hem.
export function clothTexture() {
  const S = 256;
  const c = canvas(S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const weave = 0.92 + 0.08 * Math.sin(x * 1.7) * Math.sin(y * 1.7);
      const n = fbm(x / 32, y / 32, 4, 21, 8);
      const v = y / S; // canvas top = top of the robe
      const dirt = 1 - Math.max(0, v - 0.75) * 1.2;
      const k = (0.72 + n * 0.4) * weave * dirt;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.min(255, 235 * k);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Darker band with runes near the hem.
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.fillRect(0, S - 34, S, 22);
  g.strokeStyle = 'rgba(255,255,255,.55)';
  g.lineWidth = 2;
  for (let x = 6; x < S; x += 21) {
    g.beginPath();
    g.moveTo(x, S - 16); g.lineTo(x + 6, S - 30); g.lineTo(x + 12, S - 16); g.moveTo(x + 3, S - 22); g.lineTo(x + 9, S - 22);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// Scorch mark left on the stone by explosions.
export function scorchTexture() {
  const S = 128;
  const c = canvas(S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x / S - 0.5, y / S - 0.5) * 2;
      const n = fbm(x / 16, y / 16, 4, 33);
      const a = Math.max(0, Math.min(1, (1 - d) * 1.6 + (n - 0.5) * 1.2 - 0.2));
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

// Rock with glowing cracks (meteor), as an emissive map.
export function magmaRockTexture() {
  const S = 128;
  const c = canvas(S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = 1 - Math.abs(2 * fbm(x / 20, y / 20, 4, 77, 6) - 1);
      const k = r ** 8;
      const i = (y * S + x) * 4;
      img.data[i] = 255 * Math.min(1, k * 1.3); img.data[i + 1] = 120 * k; img.data[i + 2] = 20 * k; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Adds a Dota-style rim light (and a hit flash) to a standard material.
export function addRim(mat, rimColor, strength = 0.9) {
  mat.userData.rim = { value: col(rimColor).multiplyScalar(strength) };
  mat.userData.flash = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = mat.userData.rim;
    shader.uniforms.uFlash = mat.userData.flash;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim; uniform float uFlash;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float rimK = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
        totalEmissiveRadiance += uRim * rimK + vec3(1.0, 0.85, 0.75) * uFlash * (0.35 + rimK);`);
  };
  return mat;
}

// Stone sides glow where they meet the lava.
export function addLavaHeat(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWarn = uniforms.warn;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWy;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wpH = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wpH = instanceMatrix * wpH;
        #endif
        vWy = (modelMatrix * wpH).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWy; uniform float uWarn;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(2.2, 0.5, 0.06) * smoothstep(-6.0, -40.0, vWy);
        totalEmissiveRadiance += vec3(1.6, 0.28, 0.04) * uWarn;`);
  };
  mat.customProgramCacheKey = () => 'lavaheat';
  return mat;
}
