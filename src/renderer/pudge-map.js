// The Pudge Wars map, modelled on the original custom game's "pudgewars_new"
// overview: Radiant's lush field inside sandstone cliffs and hedges on the
// left, the dark jungle river with its glowing shrine and the purple barriers
// where it leaves the arena, Dire's grey flagstones inside dark teal walls with
// autumn plants on the right, and a shop camp behind each side.
// Game coordinates (x east, y north); in the scene north is -Z.
import * as THREE from './vendor/three/three.module.min.js';
import { mergeVertices } from './vendor/three/utils/BufferGeometryUtils.js';
import { rand, col, fbm, vnoise, TILE_FLAME, TILE_SMOKE, TILE_SPARK, GLSL_NOISE } from './warlock3d-lib.js';

const PW = window.PudgeWars;
const { WALL_X, WALL_Y, RIVER, CENTER } = PW;
export const WATER_Y = -16;
const TAU = Math.PI * 2;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const smooth = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
const SIZE = 9000; // ground plane
const FIELD_X = WALL_X + 40; // the walls stand just outside the hook lines
const FIELD_Y = WALL_Y + 40;
const BASE = { x0: 1620, x1: 2280, y: 600 }; // the shop camps behind the side walls

// Seeded random numbers, so every PC builds the same map.
let seed = 7;
const srand = (a = 0, b = 1) => { seed = (seed * 1664525 + 1013904223) >>> 0; return a + (seed / 4294967296) * (b - a); };

// Ground height: the river trench, the banks, the raised land outside the walls.
export function groundH(x, y) {
  const ax = Math.abs(x);
  let h = -48 * (1 - smooth(RIVER - 20, RIVER + 60, ax));
  const out = Math.max(ax - FIELD_X, Math.abs(y) - FIELD_Y);
  if (out > 0 && ax > RIVER + 80) h += Math.min(1, out / 160) * 34;
  h += (vnoise(x / 300, y / 300, 9) - 0.5) * 6 * smooth(RIVER, RIVER + 120, ax);
  return h;
}

// Which part of the map a point is in.
function zone(x, y) {
  const ax = Math.abs(x);
  if (ax < RIVER) return 'river';
  const side = x < 0 ? 'rad' : 'dire';
  if (ax < FIELD_X && Math.abs(y) < FIELD_Y) return `${side}Field`;
  if (ax >= BASE.x0 - 60 && ax < BASE.x1 && Math.abs(y) < BASE.y) return `${side}Base`;
  return `${side}Out`;
}

// ------------------------------------------------------------------ ground texture
// The whole map painted on one canvas (north up), detail added in the shader.
function paintGround() {
  const N = 2048;
  const k = N / SIZE; // pixels per unit
  const P = (x, y) => [(x + SIZE / 2) * k, (SIZE / 2 - y) * k];
  // Base colours per pixel at a quarter of the size, then scaled up smoothly.
  const n0 = 512;
  const low = document.createElement('canvas');
  low.width = low.height = n0;
  const lg = low.getContext('2d');
  const img = lg.createImageData(n0, n0);
  const c = new THREE.Color();
  for (let py = 0; py < n0; py++) {
    for (let px = 0; px < n0; px++) {
      const x = (px / n0) * SIZE - SIZE / 2;
      const y = SIZE / 2 - (py / n0) * SIZE;
      const n = fbm(x / 420, y / 420, 3, 2);
      const m = vnoise(x / 130, y / 130, 5);
      const z = zone(x, y);
      if (z === 'radField' || z === 'radBase') c.setRGB(0.2 + 0.13 * n, 0.33 + 0.14 * n, 0.08 + 0.05 * m).multiplyScalar(0.78 + 0.34 * m); // lush grass
      else if (z === 'radOut') c.setRGB(0.3 + 0.14 * n, 0.38 + 0.12 * n, 0.12 + 0.05 * m).multiplyScalar(0.8 + 0.3 * m); // meadow
      else if (z === 'direField' || z === 'direBase') c.setRGB(0.36 + 0.08 * n, 0.38 + 0.07 * n, 0.35 + 0.06 * n); // flagstones
      else if (z === 'direOut') c.setRGB(0.42 + 0.12 * n, 0.26 + 0.08 * n, 0.12 + 0.04 * m); // autumn leaf litter
      else c.setRGB(0.1 + 0.04 * n, 0.14 + 0.05 * n, 0.08); // river bed
      // Mud banks along the river.
      const ax = Math.abs(x);
      const bank = 1 - smooth(RIVER + 5, RIVER + 70, ax);
      if (ax >= RIVER) c.lerp(x < 0 ? new THREE.Color(0.22, 0.24, 0.1) : new THREE.Color(0.2, 0.24, 0.18), bank * 0.85);
      // Worn dirt where the Pudges start.
      const spawn = Math.max(0, 1 - Math.hypot((ax - 1250) / 230, y / 700));
      if (x < 0) c.lerp(new THREE.Color(0.38, 0.3, 0.18), spawn * 0.5 * (0.5 + m));
      const i = (py * n0 + px) * 4;
      img.data[i] = Math.min(255, c.r * 255);
      img.data[i + 1] = Math.min(255, c.g * 255);
      img.data[i + 2] = Math.min(255, c.b * 255);
      img.data[i + 3] = 255;
    }
  }
  lg.putImageData(img, 0, 0);
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.drawImage(low, 0, 0, N, N);

  // Dire flagstones: rows of irregular slabs with dark joints and moss.
  const slabs = (x0, x1, y0, y1, size) => {
    g.save();
    for (let row = 0, y = y1; y > y0; row++, y -= size * srand(0.75, 1.05)) {
      const h = size * srand(0.75, 1.05);
      for (let x = x0 - (row % 2) * size * 0.5; x < x1; ) {
        const w = size * srand(0.8, 1.4);
        const j = () => srand(-0.08, 0.08) * size;
        const pts = [[x + j(), y + j()], [x + w + j(), y + j()], [x + w + j(), y - h + j()], [x + j(), y - h + j()]].map(([a, b]) => P(Math.max(x0, Math.min(x1, a)), Math.max(y0, Math.min(y1, b))));
        const v = srand(0.82, 1.12);
        const tint = srand(0, 1);
        g.fillStyle = `rgba(${Math.round(98 * v)},${Math.round((102 + tint * 8) * v)},${Math.round((96 + tint * 6) * v)},0.55)`;
        g.strokeStyle = 'rgba(24,32,26,0.6)';
        g.lineWidth = 1.4;
        g.beginPath();
        pts.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b)));
        g.closePath();
        g.fill();
        g.stroke();
        // A crack across some slabs.
        if (srand() < 0.35) {
          g.strokeStyle = 'rgba(20,26,22,0.55)';
          g.lineWidth = 1.2;
          g.beginPath();
          const [a0, b0] = pts[0];
          const [a2, b2] = pts[2];
          g.moveTo(a0 + (a2 - a0) * srand(0.1, 0.4), b0 + (b2 - b0) * srand(0.1, 0.4));
          g.lineTo(a0 + (a2 - a0) * 0.5 + srand(-4, 4), b0 + (b2 - b0) * 0.5 + srand(-4, 4));
          g.lineTo(a0 + (a2 - a0) * srand(0.6, 0.9), b0 + (b2 - b0) * srand(0.6, 0.9));
          g.stroke();
        }
        x += w;
      }
    }
    g.restore();
  };
  slabs(RIVER + 40, FIELD_X, -FIELD_Y, FIELD_Y, 150);
  slabs(BASE.x0 - 40, BASE.x1, -BASE.y, BASE.y, 130);
  // Moss in the Dire field's corners and along the river side.
  for (let i = 0; i < 260; i++) {
    const x = srand(RIVER + 40, FIELD_X);
    const y = srand(-FIELD_Y, FIELD_Y);
    const edge = Math.min(x - RIVER, FIELD_X - x, FIELD_Y - Math.abs(y));
    if (edge > 260 && srand() < 0.8) continue;
    const [px, py] = P(x, y);
    const r = srand(10, 40);
    const grd = g.createRadialGradient(px, py, 0, px, py, r);
    grd.addColorStop(0, 'rgba(52,74,38,0.55)');
    grd.addColorStop(1, 'rgba(52,74,38,0)');
    g.fillStyle = grd;
    g.fillRect(px - r, py - r, r * 2, r * 2);
  }
  // Fallen orange leaves on the Dire side.
  const leaf = (x, y, a) => {
    const [px, py] = P(x, y);
    g.fillStyle = `rgba(${Math.round(srand(170, 230))},${Math.round(srand(80, 130))},${Math.round(srand(20, 50))},${a})`;
    g.beginPath();
    g.ellipse(px, py, srand(1.5, 3.5), srand(1, 2), srand(0, TAU), 0, TAU);
    g.fill();
  };
  for (let i = 0; i < 9000; i++) {
    const x = srand(RIVER + 30, SIZE / 2);
    const y = srand(-SIZE / 2, SIZE / 2);
    const z = zone(x, y);
    if (z === 'direOut') leaf(x, y, 0.8);
    else if ((z === 'direField' || z === 'direBase') && srand() < 0.18) leaf(x, y, 0.6);
  }
  // Flowers and clover on the Radiant field and meadow.
  for (let i = 0; i < 7000; i++) {
    const x = srand(-SIZE / 2, -RIVER - 60);
    const y = srand(-SIZE / 2, SIZE / 2);
    const z = zone(x, y);
    const patch = vnoise(x / 260, y / 260, 3);
    if (patch < (z === 'radOut' ? 0.45 : 0.62)) continue;
    const [px, py] = P(x, y);
    g.fillStyle = ['rgba(250,250,240,0.9)', 'rgba(255,230,90,0.9)', 'rgba(240,150,200,0.85)', 'rgba(190,170,255,0.85)'][Math.floor(srand(0, 4))];
    g.beginPath();
    g.arc(px, py, srand(0.8, 1.8), 0, TAU);
    g.fill();
  }
  // Stone paths into the shop camps.
  g.fillStyle = 'rgba(120,110,95,0.55)';
  for (const s of [-1, 1]) {
    for (let i = 0; i < 26; i++) {
      const x = s * srand(BASE.x0 - 60, BASE.x0 + 260);
      const y = srand(-170, 170);
      const [px, py] = P(x, y);
      g.beginPath();
      g.ellipse(px, py, srand(5, 9), srand(4, 7), srand(0, TAU), 0, TAU);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Fine detail that tiles: grass blades and grain.
function detailTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = 128 + (fbm(x / 24, y / 24, 4, 3, 10.6667) - 0.5) * 90 + (Math.random() - 0.5) * 26;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  for (let k = 0; k < 2600; k++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const l = 3 + Math.random() * 6;
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
    const v = Math.random() < 0.5 ? 90 : 190;
    g.strokeStyle = `rgba(${v},${v},${v},0.5)`;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// A lumpy rock: a welded icosphere pushed in and out by noise.
function rockGeometry(detail = 1, flat = 0.75, sd = 1) {
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, detail).deleteAttribute('normal').deleteAttribute('uv'));
  const p = g.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k);
    const y = p.getY(k);
    const z = p.getZ(k);
    const n = 0.78 + 0.45 * vnoise(x * 2.1 + sd * 13, z * 2.1 + y * 1.9, 7);
    p.setXYZ(k, x * n, Math.max(-0.3, y * flat) * n, z * n);
    uv[k * 2] = x * 0.5 + 0.5 + y * 0.3;
    uv[k * 2 + 1] = z * 0.5 + 0.5 + y * 0.3;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function rockTexture(base) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const [r, gg, b] = base;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = fbm(x / 28, y / 28, 4, 11, 9.142857);
      const s = Math.abs(fbm(x / 14, y / 40, 3, 5, 18.285714) - 0.5) < 0.03 ? 0.6 : 1; // strata lines
      const v = (0.7 + n * 0.6) * s;
      const i = (y * S + x) * 4;
      img.data[i] = r * v;
      img.data[i + 1] = gg * v;
      img.data[i + 2] = b * v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function merge(list) {
  const pos = [];
  const nor = [];
  const colr = [];
  const idx = [];
  let off = 0;
  for (const [g, color] of list) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const c = col(color || '#ffffff');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      colr.push(c.r, c.g, c.b);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off);
    else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  out.setIndex(idx);
  return out;
}

// Places many copies of one mesh: [x, y, h, scaleXYZ, rotY, color].
function instances(scene, geo, mat, list, { shadow = true, receive = false } = {}) {
  if (!list.length) return null;
  const m = new THREE.InstancedMesh(geo, mat, list.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  list.forEach(([x, y, h, s, ry, c], i) => {
    q.setFromAxisAngle(V(0, 1, 0), ry || 0);
    m4.compose(V(x, h, -y), q, Array.isArray(s) ? V(...s) : V(s, s, s));
    m.setMatrixAt(i, m4);
    if (c) m.setColorAt(i, c instanceof THREE.Color ? c : col(c));
  });
  m.castShadow = shadow;
  m.receiveShadow = receive;
  scene.add(m);
  return m;
}

// ------------------------------------------------------------------ build
export function buildPudgeMap(scene, view) {
  seed = 7;
  const map = { fires: [], glows: [] };

  // Ground.
  const SEG = 200;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = -pos.getZ(i);
    pos.setY(i, groundH(x, y));
    uv.setXY(i, (x + SIZE / 2) / SIZE, (y + SIZE / 2) / SIZE);
  }
  geo.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({ map: paintGround(), roughness: 0.95, metalness: 0 });
  const detail = detailTexture();
  groundMat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float d1 = texture2D(uDetail, vMapUv * ${(SIZE / 230).toFixed(2)}).r;
          float d2 = texture2D(uDetail, vMapUv * ${(SIZE / 900).toFixed(2)} + 0.37).r;
          diffuseColor.rgb *= 0.4 + 1.2 * (d1 * 0.65 + d2 * 0.35);
        }`);
  };
  const ground = new THREE.Mesh(geo, groundMat);
  ground.receiveShadow = true;
  scene.add(ground);

  // The river: dark jungle water flowing north, foam on the banks.
  map.waterMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    vertexShader: 'varying vec2 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `
      uniform float uTime; varying vec2 vW;
      ${GLSL_NOISE}
      void main() {
        vec2 p = vW / 240.0;
        float n1 = fbm(p * vec2(1.0, 0.55) + vec2(0.0, uTime * 0.3));
        float n2 = fbm(p * 2.6 + vec2(3.1, uTime * 0.55));
        float waves = n1 * 0.6 + n2 * 0.4;
        vec3 deep = vec3(0.02, 0.09, 0.06);
        vec3 shallow = vec3(0.09, 0.2, 0.12);
        float ax = abs(vW.x);
        float edge = smoothstep(${(RIVER - 90).toFixed(1)}, ${(RIVER + 20).toFixed(1)}, ax);
        vec3 c = mix(deep, shallow, edge * 0.7 + waves * 0.45);
        float glint = pow(max(0.0, n2 - 0.56) * 2.3, 3.0);
        c += vec3(0.55, 0.75, 0.6) * glint * 0.5;
        float rock = length(vW - vec2(${CENTER.x.toFixed(1)}, ${(-CENTER.y).toFixed(1)}));
        float foam = smoothstep(${(RIVER - 5).toFixed(1)}, ${(RIVER + 35).toFixed(1)}, ax) + smoothstep(${(CENTER.r + 55).toFixed(1)}, ${(CENTER.r + 5).toFixed(1)}, rock);
        foam *= smoothstep(0.4, 0.75, fbm(p * 4.0 + vec2(0.0, uTime * 0.8)));
        c = mix(c, vec3(0.72, 0.82, 0.74), clamp(foam, 0.0, 1.0) * 0.6);
        gl_FragColor = vec4(c, 0.86 - edge * 0.2 + foam * 0.14);
      }`,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(RIVER * 2 + 120, SIZE, 1, 1), map.waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  water.renderOrder = 1;
  scene.add(water);

  // Lily pads and floating leaves.
  const padGeo = new THREE.CircleGeometry(1, 12, 0.3, TAU - 0.6);
  padGeo.rotateX(-Math.PI / 2);
  const pads = [];
  for (let i = 0; i < 70; i++) {
    const x = srand(-RIVER + 10, RIVER - 10) * (srand() < 0.7 ? 1 : 0.4);
    const y = srand(-3000, 3000);
    if (Math.hypot(x - CENTER.x, y - CENTER.y) < CENTER.r + 40) continue;
    pads.push([x, y, WATER_Y + 1.5, srand(10, 22), srand(0, TAU), new THREE.Color().setHSL(srand(0.25, 0.32), 0.5, srand(0.18, 0.28))]);
  }
  instances(scene, padGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, side: THREE.DoubleSide }), pads, { shadow: false });

  // The shrine in the middle of the river (hooks bounce off it).
  const stone = rockTexture([170, 160, 140]);
  const shrineMat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.85, color: 0xd8d0c0 });
  const shrine = new THREE.Group();
  shrine.position.set(CENTER.x, WATER_Y, -CENTER.y);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(CENTER.r, CENTER.r + 18, 34, 32), shrineMat);
  base.position.y = 10;
  const step = new THREE.Mesh(new THREE.CylinderGeometry(CENTER.r - 30, CENTER.r - 20, 18, 32), shrineMat);
  step.position.y = 36;
  shrine.add(base, step);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(9, 12, 95, 8), shrineMat);
    pillar.position.set(Math.cos(a) * (CENTER.r - 22), 80, Math.sin(a) * (CENTER.r - 22));
    const cap = new THREE.Mesh(new THREE.BoxGeometry(28, 10, 28), shrineMat);
    cap.position.set(pillar.position.x, 130, pillar.position.z);
    shrine.add(pillar, cap);
  }
  const statue = new THREE.Mesh(new THREE.CylinderGeometry(16, 30, 110, 10), shrineMat);
  statue.position.y = 100;
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(34, 16, 8, 0, TAU, 0, Math.PI / 2), shrineMat);
  bowl.rotation.x = Math.PI;
  bowl.position.y = 172;
  const orbMat = new THREE.MeshBasicMaterial({ color: col('#fff0c0').multiplyScalar(2.2) });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(18, 16, 12), orbMat);
  orb.position.y = 188;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: view.glow(), color: col('#ffe6a0').multiplyScalar(1.4), blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.scale.setScalar(260);
  halo.position.y = 188;
  for (const m of shrine.children) { m.castShadow = true; m.receiveShadow = true; }
  shrine.add(statue, bowl, orb, halo);
  statue.castShadow = bowl.castShadow = true;
  scene.add(shrine);
  map.shrine = { orb, halo };

  // Purple barriers where the river leaves the arena (hooks bounce there too).
  map.barriers = [];
  for (const s of [-1, 1]) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uTime; varying vec2 vUv;
        ${GLSL_NOISE}
        void main() {
          float n = fbm3(vec2(vUv.x * 8.0 + uTime * 0.6, vUv.y * 3.0 - uTime * 1.4));
          float a = (1.0 - vUv.y) * (0.35 + n) * smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
          float hex = step(0.92, fract(vUv.x * 18.0 + vUv.y * 4.0)) + step(0.92, fract(vUv.x * 18.0 - vUv.y * 4.0));
          gl_FragColor = vec4(vec3(0.62, 0.28, 1.0) * (a * 1.6 + hex * a * 0.8), 1.0);
        }`,
    });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(RIVER * 2 + 60, 170), mat);
    wall.position.set(0, WATER_Y + 85, -s * (WALL_Y + 20));
    scene.add(wall);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(RIVER * 2 + 60, 26), new THREE.MeshBasicMaterial({ color: col('#b060ff').multiplyScalar(1.6), transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, WATER_Y + 2, -s * (WALL_Y + 20));
    scene.add(line);
    map.barriers.push(mat);
  }

  // The rune marker where runes enter the river, at its south end.
  const mark = new THREE.Mesh(new THREE.CircleGeometry(60, 32), new THREE.MeshBasicMaterial({ color: col('#ff3020').multiplyScalar(1.3), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  mark.rotation.x = -Math.PI / 2;
  mark.position.set(0, WATER_Y + 2, -(-WALL_Y + 80));
  scene.add(mark);

  // ---------------------------------------------------------------- Radiant cliffs and hedges
  const sand = rockTexture([196, 178, 140]);
  const cliffMat = new THREE.MeshStandardMaterial({ map: sand, roughness: 0.95, flatShading: true });
  const cliffGeos = [0, 1, 2].map((i) => rockGeometry(1, 0.85, i));
  const cliffs = [[], [], []];
  const edge = (x1, y1, x2, y2, list, gap = 85) => {
    const L = Math.hypot(x2 - x1, y2 - y1);
    for (let d = 0; d <= L; d += gap * srand(0.75, 1.1)) {
      const k = d / L;
      list.push([x1 + (x2 - x1) * k, y1 + (y2 - y1) * k]);
    }
  };
  const radLine = [];
  edge(-FIELD_X - 40, -FIELD_Y - 40, -FIELD_X - 40, FIELD_Y + 40, radLine);
  edge(-FIELD_X - 40, FIELD_Y + 40, -RIVER - 70, FIELD_Y + 40, radLine);
  edge(-FIELD_X - 40, -FIELD_Y - 40, -RIVER - 70, -FIELD_Y - 40, radLine);
  for (const [x, y] of radLine) {
    const s = srand(70, 105);
    cliffs[Math.floor(srand(0, 3))].push([x + srand(-15, 15), y + srand(-15, 15), groundH(x, y) - 10, [s * srand(0.9, 1.3), s * srand(0.8, 1.25), s * srand(0.9, 1.3)], srand(0, TAU), new THREE.Color().setHSL(0.1, 0.25, srand(0.55, 0.72))]);
  }
  cliffGeos.forEach((g, i) => instances(scene, g, cliffMat, cliffs[i], { receive: true }));
  // Hedges on top of and outside the Radiant cliffs, as in the original.
  const bushGeo = merge([[rockGeometry(1, 0.9, 3).scale(1, 0.8, 1)], [rockGeometry(1, 0.9, 4).scale(0.7, 0.6, 0.7).translate(0.6, 0.1, 0.3)], [rockGeometry(1, 0.9, 5).scale(0.6, 0.55, 0.6).translate(-0.5, 0.05, -0.4)]]);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true });
  const hedges = [];
  for (const [x, y] of radLine) {
    if (srand() < 0.25) continue;
    const ox = x < -FIELD_X ? -srand(60, 120) : 0;
    const oy = Math.abs(y) > FIELD_Y ? Math.sign(y) * srand(60, 120) : 0;
    hedges.push([x + ox, y + oy, groundH(x + ox, y + oy) + srand(20, 50), srand(45, 70), srand(0, TAU), new THREE.Color().setHSL(srand(0.24, 0.31), 0.55, srand(0.17, 0.26))]);
  }
  // Vines and bushes on both river banks (outside where Pudges stand).
  const reeds = [];
  for (let i = 0; i < 160; i++) {
    const s = srand() < 0.5 ? -1 : 1;
    const x = s * srand(RIVER - 10, RIVER + 15);
    const y = srand(-FIELD_Y - 200, FIELD_Y + 200);
    reeds.push([x, y, WATER_Y + srand(-4, 6), [srand(18, 34), srand(10, 22), srand(18, 34)], srand(0, TAU), new THREE.Color().setHSL(srand(0.23, 0.33), 0.5, srand(0.13, 0.22))]);
  }
  instances(scene, bushGeo, leafMat, hedges.concat(reeds));
  // Grass tufts and ferns.
  const tuftGeo = merge([0, 1, 2, 3, 4].map((i) => {
    const g = new THREE.ConeGeometry(2.5, 26, 3);
    g.translate(0, 12, 0);
    g.rotateZ(srand(-0.5, 0.5));
    g.rotateY((i / 5) * TAU);
    g.translate(Math.cos(i) * 4, 0, Math.sin(i) * 4);
    return [g];
  }));
  const tufts = [];
  for (let i = 0; i < 1600; i++) {
    const x = srand(-3200, 3200);
    const y = srand(-3000, 3000);
    const z = zone(x, y);
    if (z === 'river' || z === 'direField' || z === 'direBase') continue;
    if (z === 'radField' && Math.abs(x) < RIVER + 60) continue;
    const hue = z.startsWith('rad') ? srand(0.2, 0.3) : srand(0.06, 0.12);
    tufts.push([x, y, groundH(x, y), srand(0.7, 1.5), srand(0, TAU), new THREE.Color().setHSL(hue, 0.6, srand(0.22, 0.34))]);
  }
  instances(scene, tuftGeo, leafMat, tufts, { shadow: false });

  // ---------------------------------------------------------------- Dire walls and autumn plants
  const teal = rockTexture([88, 108, 104]);
  const blockMat = new THREE.MeshStandardMaterial({ map: teal, roughness: 0.9, color: 0xb8c8c4 });
  const mossMat = new THREE.MeshStandardMaterial({ color: 0x3a5a2c, roughness: 1, flatShading: true });
  const blocks = [];
  const moss = [];
  const direLine = [];
  edge(FIELD_X + 40, -FIELD_Y - 40, FIELD_X + 40, FIELD_Y + 40, direLine, 105);
  edge(RIVER + 70, FIELD_Y + 40, FIELD_X + 40, FIELD_Y + 40, direLine, 105);
  edge(RIVER + 70, -FIELD_Y - 40, FIELD_X + 40, -FIELD_Y - 40, direLine, 105);
  for (const [x, y] of direLine) {
    const vert = x > FIELD_X;
    const h = srand(110, 150);
    const ry = (vert ? Math.PI / 2 : 0) + srand(-0.06, 0.06);
    blocks.push([x, y, groundH(x, y) - 10 + h / 2, [100, h, 78], ry, new THREE.Color().setHSL(0.45, 0.12, srand(0.32, 0.44))]);
    if (srand() < 0.6) moss.push([x + srand(-20, 20), y + srand(-20, 20), groundH(x, y) - 10 + h, [srand(30, 55), srand(10, 18), srand(25, 40)], srand(0, TAU)]);
  }
  // Big pillars at the corners.
  for (const [x, y] of [[FIELD_X + 40, FIELD_Y + 40], [FIELD_X + 40, -FIELD_Y - 40], [RIVER + 70, FIELD_Y + 40], [RIVER + 70, -FIELD_Y - 40]]) {
    blocks.push([x, y, groundH(x, y) + 80, [150, 200, 150], 0, new THREE.Color().setHSL(0.45, 0.1, 0.3)]);
  }
  const boxGeo = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
  instances(scene, boxGeo, blockMat, blocks, { receive: true });
  instances(scene, rockGeometry(1, 0.6, 9), mossMat, moss);
  // Orange autumn bushes along the Dire field's edges and outside.
  const autumn = [];
  for (let i = 0; i < 320; i++) {
    const x = srand(RIVER + 30, 3400);
    const y = srand(-3200, 3200);
    const z = zone(x, y);
    let ok = z === 'direOut';
    if (z === 'direField') ok = (x < RIVER + 90 || x > FIELD_X - 70 || Math.abs(y) > FIELD_Y - 70) && srand() < 0.6;
    if (!ok) continue;
    autumn.push([x, y, groundH(x, y) + srand(5, 20), srand(z === 'direField' ? 22 : 30, z === 'direField' ? 38 : 70), srand(0, TAU), new THREE.Color().setHSL(srand(0.04, 0.1), srand(0.65, 0.85), srand(0.32, 0.45))]);
  }
  instances(scene, bushGeo, leafMat, autumn);
  // A few dark rocks and rubble in the Dire field, as in the original.
  const rubble = [];
  for (const [x, y] of [[640, 1020], [690, -620], [820, -1420], [520, 1300], [1100, -1250], [330, -980]]) {
    for (let i = 0; i < 4; i++) rubble.push([x + srand(-60, 60), y + srand(-60, 60), groundH(x, y), [srand(14, 30), srand(8, 18), srand(14, 30)], srand(0, TAU), new THREE.Color().setHSL(0.45, 0.06, srand(0.18, 0.28))]);
  }
  instances(scene, rockGeometry(0, 0.7, 2), new THREE.MeshStandardMaterial({ map: teal, roughness: 0.95, flatShading: true }), rubble);

  // ---------------------------------------------------------------- spawn emblems
  // Radiant: a blue glyph pad with a golden sun; Dire: a dark slab with a red sigil.
  const emblem = (color, ring, sigil, bg) => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = bg;
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = ring;
    g.lineWidth = 10;
    g.strokeRect(12, 12, 232, 232);
    g.lineWidth = 3;
    g.strokeRect(28, 28, 200, 200);
    g.fillStyle = color;
    g.strokeStyle = color;
    g.translate(128, 128);
    if (sigil === 'sun') {
      g.beginPath();
      g.arc(0, 18, 46, Math.PI, 0);
      g.fill();
      for (let i = 0; i < 9; i++) {
        const a = Math.PI + (i / 8) * Math.PI;
        g.beginPath();
        g.moveTo(Math.cos(a) * 52, 18 + Math.sin(a) * 52);
        g.lineTo(Math.cos(a - 0.08) * 92, 18 + Math.sin(a - 0.08) * 92);
        g.lineTo(Math.cos(a + 0.08) * 92, 18 + Math.sin(a + 0.08) * 92);
        g.fill();
      }
      g.fillRect(-80, 26, 160, 10);
    } else {
      g.lineWidth = 9;
      g.beginPath();
      g.moveTo(0, -80); g.lineTo(0, 80);
      g.moveTo(-56, -40); g.lineTo(0, 10); g.lineTo(56, -40);
      g.moveTo(-40, 50); g.lineTo(0, 22); g.lineTo(40, 50);
      g.stroke();
      g.beginPath();
      g.arc(0, -60, 16, 0, TAU);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const pad = (x, tex, w, h, glow) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 8, h), [
      new THREE.MeshStandardMaterial({ color: 0x6a6a64 }), new THREE.MeshStandardMaterial({ color: 0x6a6a64 }),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: col(glow), emissiveIntensity: 0.25, emissiveMap: tex }),
      new THREE.MeshStandardMaterial({ color: 0x6a6a64 }), new THREE.MeshStandardMaterial({ color: 0x6a6a64 }), new THREE.MeshStandardMaterial({ color: 0x6a6a64 }),
    ]);
    m.position.set(x, groundH(x, 0) + 2, 0);
    m.receiveShadow = true;
    scene.add(m);
  };
  pad(-1235, emblem('#f0c24a', '#c89a3a', 'sun', '#1e5a7a'), 190, 190, '#3aa0ff');
  pad(1235, emblem('#d03a2a', '#3a4a44', 'sigil', '#14201c'), 200, 260, '#ff3020');

  // ---------------------------------------------------------------- shop camps
  const camp = (s) => {
    const cx = s * ((BASE.x0 + BASE.x1) / 2 + 20);
    const radiant = s < 0;
    const cloth = new THREE.MeshStandardMaterial({ color: radiant ? 0xd8c8a0 : 0x6a7070, roughness: 0.9, side: THREE.DoubleSide });
    const trim = new THREE.MeshStandardMaterial({ color: radiant ? 0xa03020 : 0x3a1a1a, roughness: 0.9 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x6a4424, roughness: 0.95 });
    const g = new THREE.Group();
    g.position.set(cx, groundH(cx, 0), 0);
    const tent = (x, z, r, h) => {
      const t = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6, 1, true), cloth);
      t.position.set(x, h / 2, z);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.32, r * 0.42, h * 0.18, 6, 1, true), trim);
      band.position.set(x, h * 0.62, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 40, 5), wood);
      pole.position.set(x, h + 10, z);
      g.add(t, band, pole);
    };
    tent(-30, -90, 120, 170);
    tent(110, 120, 80, 120);
    tent(-120, 160, 70, 105);
    // Counter, crates and barrels.
    const counter = new THREE.Mesh(new THREE.BoxGeometry(170, 50, 50), wood);
    counter.position.set(40, 25, 30);
    g.add(counter);
    for (let i = 0; i < 7; i++) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(36, 36, 36), wood);
      crate.position.set(srand(-200, 200), 18 + (i > 4 ? 36 : 0), srand(-220, 230));
      crate.rotation.y = srand(0, TAU);
      g.add(crate);
    }
    for (let i = 0; i < 4; i++) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 40, 10), wood);
      barrel.position.set(srand(-180, 180), 20, srand(-200, 200));
      g.add(barrel);
    }
    // A lamp post with a warm light.
    const post = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 150, 6), wood);
    post.position.set(-150, 75, -10);
    const lamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: view.glow(), color: col('#ffb060').multiplyScalar(1.4), blending: THREE.AdditiveBlending, depthWrite: false }));
    lamp.position.set(-150, 155, -10);
    lamp.scale.setScalar(110);
    g.add(post, lamp);
    // Low stone wall around the camp.
    for (let a = 0; a < TAU; a += 0.17) {
      const r = 300;
      if (Math.abs(Math.cos(a) * s - -1) < 0.25) continue; // opening towards the field
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(srand(18, 30), 0), radiant ? cliffMat : blockMat);
      st.position.set(Math.cos(a) * r * 1.1, 10, Math.sin(a) * r * 1.9);
      st.rotation.set(srand(0, 3), srand(0, 3), 0);
      g.add(st);
    }
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(g);
    map.glows.push({ x: cx - 150 * 1, y: 10, team: radiant ? 0 : 1 });
  };
  camp(-1);
  camp(1);

  // ---------------------------------------------------------------- forests
  // Radiant: green pines and round broadleaf trees; Dire: autumn trees and dark pines.
  const pine = merge([0, 1, 2].map((k) => {
    const g = new THREE.ConeGeometry(95 - k * 22, 150 - k * 20, 8);
    g.translate(0, 120 + k * 72, 0);
    return [g];
  }));
  const broad = merge([[0, 150, 0, 75], [50, 125, 30, 55], [-45, 130, -25, 58], [10, 195, -10, 50]].map(([x, y, z, r]) => [rockGeometry(1, 0.95, x + z).scale(r, r * 0.9, r).translate(x, y, z)]));
  const trunk = new THREE.CylinderGeometry(9, 15, 110, 6);
  trunk.translate(0, 55, 0);
  const trees = { pine: [], broad: [], trunk: [] };
  const spots = [];
  for (let i = 0; i < 2200 && spots.length < 520; i++) {
    const x = srand(-4200, 4200);
    const y = srand(-4000, 4000);
    const ax = Math.abs(x);
    if (ax < RIVER + 160) continue;
    const z = zone(x, y);
    if (z.endsWith('Field') || z.endsWith('Base')) continue;
    if (Math.max(ax - FIELD_X, Math.abs(y) - FIELD_Y) < 200) continue;
    if (ax > BASE.x0 - 100 && ax < BASE.x1 + 120 && Math.abs(y) < BASE.y + 120) continue;
    if (spots.some(([a, b]) => Math.hypot(a - x, b - y) < 125)) continue;
    spots.push([x, y]);
  }
  for (const [x, y] of spots) {
    const s = srand(0.85, 1.4);
    const h = groundH(x, y) - 5;
    const radiant = x < 0;
    const isPine = radiant ? srand() < 0.45 : (y > 900 && x > 1200) || srand() < 0.3;
    const color = isPine
      ? new THREE.Color().setHSL(radiant ? srand(0.28, 0.33) : srand(0.36, 0.42), radiant ? 0.5 : 0.3, srand(0.15, 0.22))
      : radiant ? new THREE.Color().setHSL(srand(0.2, 0.28), 0.6, srand(0.24, 0.32)) : new THREE.Color().setHSL(srand(0.03, 0.1), srand(0.7, 0.85), srand(0.34, 0.46));
    (isPine ? trees.pine : trees.broad).push([x, y, h, [s, s * srand(0.9, 1.2), s], srand(0, TAU), color]);
    trees.trunk.push([x, y, h, s, 0]);
  }
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3420, roughness: 1 });
  instances(scene, trunk, trunkMat, trees.trunk);
  instances(scene, pine, leafMat, trees.pine, { receive: true });
  instances(scene, broad, leafMat, trees.broad, { receive: true });

  // ---------------------------------------------------------------- campfires
  const logMat = new THREE.MeshStandardMaterial({ color: 0x3a2414, roughness: 1 });
  const emberMat = new THREE.MeshBasicMaterial({ color: col('#ff7a2a').multiplyScalar(2) });
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x6a6660, roughness: 1, flatShading: true });
  for (const sx of [-750, 750]) {
    for (const y of [-1000, 0, 1000]) {
      const g = new THREE.Group();
      g.position.set(sx, groundH(sx, y), -y);
      for (let i = 0; i < 4; i++) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(6, 7, 70, 6), logMat);
        log.rotation.z = Math.PI / 2 - 0.35;
        log.rotation.y = (i / 4) * TAU;
        log.position.set(Math.cos((i / 4) * TAU) * 12, 14, -Math.sin((i / 4) * TAU) * 12);
        log.castShadow = true;
        g.add(log);
      }
      for (let i = 0; i < 9; i++) {
        const s = new THREE.Mesh(new THREE.DodecahedronGeometry(10, 0), ringMat);
        s.position.set(Math.cos((i / 9) * TAU) * 40, 4, Math.sin((i / 9) * TAU) * 40);
        g.add(s);
      }
      const ember = new THREE.Mesh(new THREE.SphereGeometry(16, 10, 6), emberMat);
      ember.scale.y = 0.35;
      ember.position.y = 4;
      g.add(ember);
      scene.add(g);
      map.fires.push({ x: sx, y });
    }
  }

  // ---------------------------------------------------------------- animation
  map.update = (dt, time, target) => {
    map.waterMat.uniforms.uTime.value = time;
    for (const m of map.barriers) m.uniforms.uTime.value = time;
    const sh = map.shrine;
    sh.halo.material.opacity = 0.8 + 0.2 * Math.sin(time * 2.2);
    const near = (x, y, r) => Math.hypot(x - target.x, -y - target.z) < r;
    if (near(CENTER.x, CENTER.y, 2600)) {
      view.light(CENTER.x, WATER_Y + 200, -CENTER.y, '#ffe0a0', 3.2);
      if (Math.random() < dt * 14) {
        const a = rand(0, TAU);
        view.fire.add({ p: [CENTER.x + Math.cos(a) * rand(20, 120), WATER_Y + rand(40, 120), -CENTER.y + Math.sin(a) * rand(20, 120)], v: [0, rand(40, 90), 0], c0: col('#fff4c0').multiplyScalar(1.6), c1: col('#c08a20'), size: rand(4, 8), life: rand(1, 2), tile: TILE_SPARK, stretch: 0.02, drag: 0.99 });
      }
    }
    for (const s of [-1, 1]) {
      if (Math.random() < dt * 10 && near(0, s * WALL_Y, 2600)) {
        view.fire.add({ p: [rand(-RIVER, RIVER), WATER_Y + rand(0, 40), -s * (WALL_Y + 20)], v: [0, rand(60, 140), 0], c0: col('#d8a0ff').multiplyScalar(1.5), c1: col('#5010a0'), size: rand(5, 9), life: rand(0.6, 1.2), tile: TILE_SPARK, stretch: 0.03 });
      }
    }
    let lit = 0;
    for (const f of map.fires) {
      if (!near(f.x, f.y, 2600)) continue;
      const h = groundH(f.x, f.y);
      if (Math.random() < dt * 30) view.fire.add({ p: [f.x + rand(-12, 12), h + 10, -f.y + rand(-12, 12)], v: [rand(-15, 15), rand(90, 170), rand(-15, 15)], c0: col('#ffe090'), c1: col('#c02800'), size: rand(28, 44), size1: 6, life: rand(0.5, 0.8), tile: TILE_FLAME, drag: 0.97 });
      if (Math.random() < dt * 4) view.smoke.add({ p: [f.x, h + 90, -f.y], v: [rand(-10, 10), rand(50, 80), rand(-10, 10)], c0: col('#3a3430'), size: 40, size1: 140, life: 2.5, a: 0.25, tile: TILE_SMOKE, spin: rand(-0.5, 0.5) });
      if (Math.random() < dt * 6) view.fire.add({ p: [f.x, h + 40, -f.y], v: [rand(-30, 30), rand(150, 260), rand(-30, 30)], c0: col('#ffd080'), c1: col('#ff4000'), size: 3, life: 1.2, tile: TILE_SPARK, stretch: 0.03, drag: 0.98 });
      if (lit++ < 2) view.light(f.x, h + 60, -f.y, '#ff9a40', 2.2 + 0.4 * Math.sin(time * 13 + f.x) + 0.3 * Math.sin(time * 7.3 + f.y));
    }
    // Leaves drifting on the Dire side, pollen over the Radiant meadow.
    if (Math.random() < dt * 6) {
      const x = target.x + rand(-1500, 1500);
      const y = -target.z + rand(-1200, 1200);
      if (x > RIVER) view.smoke.add({ p: [x, rand(150, 300), -y], v: [rand(20, 60), rand(-40, -20), rand(-20, 20)], c0: col('#d07a2a'), size: 7, size1: 7, life: 4, a: 0.9, tile: TILE_SMOKE, spin: rand(-3, 3), drag: 1 });
      else if (x < -RIVER) view.fire.add({ p: [x, rand(40, 160), -y], v: [rand(-10, 10), rand(5, 20), rand(-10, 10)], c0: col('#fff8c0'), c1: col('#a0a040'), size: 3, life: 3, drag: 1 });
    }
  };
  return map;
}
