// Tank game 3D view (three.js). It only draws: the rules are in
// shared/tanks.js and the window logic in tanks.js.
// Field blocks (gx, gy) map to the scene as x = gx - 13, z = gy - 13; one block is one unit.
// Three looks: classic (army tanks), mine (a coal mine site) and toy (toy tanks on a wooden floor).
import * as THREE from './vendor/three/three.module.min.js';
import { EffectComposer } from './vendor/three/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/postprocessing/OutputPass.js';
import { mergeGeometries } from './vendor/three/utils/BufferGeometryUtils.js';
import {
  rand, col, Particles, particleAtlas, TILE_FLAME, TILE_SMOKE, TILE_SPARK, TILE_GLOW,
  shockMaterial, bubbleMaterial, swirlMaterial, beamMaterial, addRim, fbm,
} from './warlock3d-lib.js';

const { TILE, SIZE } = window.Tanks;
const HALF = SIZE / 2;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const wx = (gx) => gx - HALF;
const angleLerp = (a, b, t) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; };

// ------------------------------------------------------------------ themes
export const THEMES = {
  classic: {
    sky: '#0b0f14', fog: '#0b0f14', hemi: [0xdfe8ff, 0x2a2c30, 1.0], sun: [0xfff2dc, 2.6], exposure: 1.0,
    players: ['#e9c23c', '#4fc25e'], enemy: { scout: '#c9cdd3', trooper: '#a3a9b0', heavy: '#6f767e', rocket: '#b8735e', drone: '#a070e0' },
    water: ['#0f3f7a', '#3e9cf0', '#bfe4ff'], bush: ['#2f7a26', '#4f9a34', '#6cb840'], ice: '#d8ecff', shot: ['#ffe28a', '#ff8a3a', '#c79aff'],
    debris: { brick: '#a5472c', steel: '#c8ccd2' }, dust: '#8a8070', pad: ['#4dd2ff', '#ff7ad8', '#9dff6a', '#ffd23a'],
  },
  mine: {
    sky: '#1a120c', fog: '#2a1d12', hemi: [0xffe6c4, 0x3a2a1a, 0.95], sun: [0xffd9a8, 2.5], exposure: 1.05,
    players: ['#f4b81a', '#ff6a1a'], enemy: { scout: '#9a8a76', trooper: '#7d6a55', heavy: '#5a4a3a', rocket: '#8a4a32', drone: '#7a7ad0' },
    water: ['#1f3a34', '#4f7a6a', '#b8d8c8'], bush: ['#6b6a2e', '#8a8040', '#a89a52'], ice: '#3a2a20', shot: ['#ffe8a0', '#ff9a3a', '#b8a0ff'],
    debris: { brick: '#1a1a1e', steel: '#e8b81a' }, dust: '#9a7a52', pad: ['#ffb000', '#4df0ff', '#ff5a3a', '#b8ff4a'],
  },
  toy: {
    sky: '#2a1e18', fog: '#3a2a20', hemi: [0xfff4e8, 0x5a4030, 1.1], sun: [0xfff0e0, 2.3], exposure: 1.05,
    players: ['#e8343a', '#2f7ae8'], enemy: { scout: '#7aa846', trooper: '#5f8a3a', heavy: '#46652c', rocket: '#8a5ac8', drone: '#e85ab8' },
    water: ['#1a7ac8', '#4ac0ff', '#e0f6ff'], bush: ['#3ab84a', '#5ad25a', '#86e86a'], ice: '#f4f8ff', shot: ['#fff27a', '#ff6a8a', '#7ae8ff'],
    debris: { brick: '#e8343a', steel: '#e8c890' }, dust: '#d8c0a0', pad: ['#ff5ad2', '#5ad2ff', '#ffe23a', '#7aff7a'],
  },
};

// ------------------------------------------------------------------ textures
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (repeat) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(repeat, repeat); }
  return tex;
}
function speckle(g, w, h, n, colors, size = [1, 3]) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[i % colors.length];
    const s = rand(size[0], size[1]);
    g.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
}
function groundTex(theme) {
  return canvasTex(1024, 1024, (g, w, h) => {
    if (theme === 'toy') {
      // Wooden floor boards.
      const boards = 8;
      for (let i = 0; i < boards; i++) {
        const y = (i * h) / boards;
        const tone = 0.85 + Math.random() * 0.2;
        g.fillStyle = `rgb(${190 * tone},${140 * tone},${92 * tone})`;
        g.fillRect(0, y, w, h / boards);
        for (let k = 0; k < 40; k++) {
          g.strokeStyle = `rgba(110,70,40,${rand(0.05, 0.18)})`;
          g.lineWidth = rand(1, 3);
          g.beginPath();
          const yy = y + rand(4, h / boards - 4);
          g.moveTo(0, yy);
          g.bezierCurveTo(w * 0.3, yy + rand(-6, 6), w * 0.6, yy + rand(-6, 6), w, yy + rand(-4, 4));
          g.stroke();
        }
        g.fillStyle = 'rgba(60,35,18,.7)';
        g.fillRect(0, y, w, 3);
        const cut = rand(0.2, 0.8) * w;
        g.fillRect(cut, y, 3, h / boards);
      }
      return;
    }
    if (theme === 'mine') {
      // Dusty haul-road dirt with tyre ruts and gravel.
      for (let y = 0; y < h; y += 4) {
        for (let x = 0; x < w; x += 4) {
          const n = fbm(x / 160, y / 160, 4, 7);
          const r = 120 + n * 60;
          g.fillStyle = `rgb(${r},${r * 0.78},${r * 0.55})`;
          g.fillRect(x, y, 4, 4);
        }
      }
      speckle(g, w, h, 5000, ['rgba(60,45,30,.5)', 'rgba(200,170,130,.35)', 'rgba(30,30,32,.45)'], [1, 4]);
      g.strokeStyle = 'rgba(70,52,34,.35)';
      for (const x0 of [180, 230, 700, 750]) {
        g.lineWidth = 26;
        g.beginPath();
        g.moveTo(x0, 0);
        g.bezierCurveTo(x0 + 60, h * 0.3, x0 - 60, h * 0.7, x0 + 20, h);
        g.stroke();
      }
      return;
    }
    // Classic: dark worn ground.
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        const n = fbm(x / 120, y / 120, 4, 3);
        const v = 26 + n * 26;
        g.fillStyle = `rgb(${v},${v * 1.02},${v * 0.95})`;
        g.fillRect(x, y, 4, 4);
      }
    }
    speckle(g, w, h, 4000, ['rgba(255,255,255,.04)', 'rgba(0,0,0,.25)'], [1, 3]);
    g.strokeStyle = 'rgba(255,255,255,.035)';
    g.lineWidth = 2;
    for (let i = 0; i <= 13; i++) { const p = (i * w) / 13; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, h); g.moveTo(0, p); g.lineTo(w, p); g.stroke(); }
  });
}
function brickTex(theme) {
  return canvasTex(256, 256, (g, w, h) => {
    if (theme === 'mine') {
      // A heap of coal: black lumps with glints.
      g.fillStyle = '#121214';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 70; i++) {
        const x = Math.random() * w; const y = Math.random() * h; const r = rand(10, 30);
        const l = rand(14, 40);
        g.fillStyle = `rgb(${l},${l},${l + 4})`;
        g.beginPath();
        for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + rand(-0.3, 0.3); const rr = r * rand(0.6, 1); g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
        g.fill();
        g.fillStyle = 'rgba(160,180,220,.35)';
        g.fillRect(x - r * 0.3, y - r * 0.4, r * 0.4, 2);
      }
      return;
    }
    if (theme === 'toy') {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(0,0,0,.12)';
      g.fillRect(0, h - 10, w, 10);
      g.fillRect(w - 8, 0, 8, h);
      g.fillStyle = 'rgba(255,255,255,.7)';
      g.fillRect(0, 0, w, 6);
      return;
    }
    // Classic red bricks.
    g.fillStyle = '#5a2a1c';
    g.fillRect(0, 0, w, h);
    const rows = 4;
    const bh = h / rows;
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? w / 4 : 0;
      for (let c = -1; c < 2; c++) {
        const x = c * (w / 2) + off;
        const l = rand(0.85, 1.1);
        g.fillStyle = `rgb(${172 * l},${78 * l},${50 * l})`;
        g.fillRect(x + 4, r * bh + 4, w / 2 - 8, bh - 8);
        g.fillStyle = 'rgba(255,200,170,.15)';
        g.fillRect(x + 4, r * bh + 4, w / 2 - 8, 4);
      }
    }
    speckle(g, w, h, 600, ['rgba(0,0,0,.2)', 'rgba(255,220,200,.08)']);
  });
}
function steelTex(theme) {
  return canvasTex(256, 256, (g, w, h) => {
    if (theme === 'mine') {
      // Concrete barrier with yellow and black hazard stripes.
      g.fillStyle = '#8a8a86';
      g.fillRect(0, 0, w, h);
      speckle(g, w, h, 2500, ['rgba(0,0,0,.15)', 'rgba(255,255,255,.12)']);
      g.save();
      g.beginPath();
      g.rect(0, h * 0.55, w, h * 0.3);
      g.clip();
      for (let x = -h; x < w + h; x += 48) {
        g.fillStyle = '#f2c21a';
        g.beginPath(); g.moveTo(x, h); g.lineTo(x + 24, h); g.lineTo(x + 24 + h * 0.5, h * 0.5); g.lineTo(x + h * 0.5, h * 0.5); g.fill();
        g.fillStyle = '#1a1a1a';
        g.beginPath(); g.moveTo(x + 24, h); g.lineTo(x + 48, h); g.lineTo(x + 48 + h * 0.5, h * 0.5); g.lineTo(x + 24 + h * 0.5, h * 0.5); g.fill();
      }
      g.restore();
      return;
    }
    if (theme === 'toy') {
      // A wooden alphabet block.
      g.fillStyle = '#e8c890';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 30; i++) { g.strokeStyle = `rgba(150,100,50,${rand(0.08, 0.2)})`; g.beginPath(); const y = rand(0, h); g.moveTo(0, y); g.lineTo(w, y + rand(-10, 10)); g.stroke(); }
      g.strokeStyle = '#b8864a';
      g.lineWidth = 10;
      g.strokeRect(14, 14, w - 28, h - 28);
      const letters = 'ABCDEFGHKMNPRSTXYZ';
      g.fillStyle = ['#e8343a', '#2f7ae8', '#2fa84a', '#e88a1a'][Math.floor(Math.random() * 4)];
      g.font = 'bold 150px "Segoe UI", Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(letters[Math.floor(Math.random() * letters.length)], w / 2, h / 2 + 8);
      return;
    }
    // Classic riveted steel plate.
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#9aa2ab');
    grad.addColorStop(1, '#6a7179');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.fillRect(30, 30, w - 60, 10);
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.fillRect(30, h - 40, w - 60, 10);
    g.strokeStyle = 'rgba(0,0,0,.4)';
    g.lineWidth = 6;
    g.strokeRect(3, 3, w - 6, h - 6);
    for (const [x, y] of [[20, 20], [w - 20, 20], [20, h - 20], [w - 20, h - 20]]) {
      g.fillStyle = '#4a5058';
      g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.5)';
      g.beginPath(); g.arc(x - 2, y - 2, 4, 0, Math.PI * 2); g.fill();
    }
  });
}
function treadTex() {
  const t = canvasTex(64, 256, (g, w, h) => {
    g.fillStyle = '#1c1d1f';
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) {
      g.fillStyle = '#3a3c40';
      g.fillRect(2, y + 2, w - 4, 9);
      g.fillStyle = 'rgba(255,255,255,.12)';
      g.fillRect(2, y + 2, w - 4, 2);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function iconTex(emoji, ring) {
  return canvasTex(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, 62);
    grd.addColorStop(0, 'rgba(255,255,255,.95)');
    grd.addColorStop(1, ring);
    g.fillStyle = grd;
    g.beginPath();
    g.roundRect(8, 8, w - 16, h - 16, 26);
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(255,255,255,.9)';
    g.stroke();
    g.font = '64px "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(emoji, w / 2, h / 2 + 4);
  });
}
export const POWER_ICON = { shield: '🛡️', power: '⭐', rapid: '⚡', ricochet: '🔁', freeze: '❄️', fortify: '🧱', airstrike: '✈️', life: '❤️' };
const POWER_COL = { shield: '#3aa0ff', power: '#ffb000', rapid: '#ffe23a', ricochet: '#3ae0c0', freeze: '#9ad8ff', fortify: '#c88a5a', airstrike: '#ff4a3a', life: '#ff5a8a' };

// ------------------------------------------------------------------ geometry helpers
function bushGeo(seed) {
  const parts = [];
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 6; i++) {
    const g = new THREE.IcosahedronGeometry(0.32 + rnd() * 0.16, 1);
    g.translate((rnd() - 0.5) * 0.6, 0.7 + rnd() * 0.45, (rnd() - 0.5) * 0.6);
    parts.push(g);
  }
  return mergeGeometries(parts);
}
function toyBrickGeo() {
  const parts = [new THREE.BoxGeometry(0.98, 0.8, 0.98).translate(0, 0.4, 0)];
  for (const [x, z] of [[-0.24, -0.24], [0.24, -0.24], [-0.24, 0.24], [0.24, 0.24]]) parts.push(new THREE.CylinderGeometry(0.15, 0.15, 0.14, 16).translate(x, 0.87, z));
  return mergeGeometries(parts);
}
function coalGeo() {
  const g = new THREE.IcosahedronGeometry(0.62, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i); const y = p.getY(i); const z = p.getZ(i);
    const k = 0.85 + 0.3 * Math.abs(Math.sin(x * 9.1 + y * 7.3 + z * 5.7));
    p.setXYZ(i, x * k, Math.max(-0.1, y * k * 0.9), z * k);
  }
  g.computeVertexNormals();
  g.translate(0, 0.38, 0);
  return g;
}
// The hull's side profile (sloped front and back), extruded across its width.
function hullGeo(len, wid, hgt, slope = 0.22) {
  const s = new THREE.Shape();
  const L = len / 2;
  s.moveTo(-L, 0);
  s.lineTo(L, 0);
  s.lineTo(L - slope * 0.4, hgt * 0.55);
  s.lineTo(L - slope, hgt);
  s.lineTo(-L + slope * 0.7, hgt);
  s.lineTo(-L, hgt * 0.6);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: wid, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2 });
  g.translate(0, 0, -wid / 2);
  g.rotateY(Math.PI / 2); // length along Z, front towards -Z
  return g;
}

// ------------------------------------------------------------------ debris chunks
class Debris {
  constructor(scene, max = 500) {
    this.max = max;
    this.list = [];
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.8 }), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, col('#fff'));
    scene.add(this.mesh);
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
  }
  burst(x, y, z, color, n, power = 4, size = 0.14) {
    const c = col(color);
    for (let i = 0; i < n && this.list.length < this.max; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(0.3, 1) * power;
      this.list.push({
        p: V(x, y, z), v: V(Math.cos(a) * sp, rand(2, 6) * power * 0.35, Math.sin(a) * sp), r: V(rand(0, 6), rand(0, 6), rand(0, 6)), w: V(rand(-9, 9), rand(-9, 9), rand(-9, 9)),
        s: size * rand(0.6, 1.4), life: rand(1.2, 2.2), c: c.clone().multiplyScalar(rand(0.7, 1.15)),
      });
    }
  }
  update(dt) {
    let j = 0;
    for (const d of this.list) {
      d.life -= dt;
      if (d.life <= 0) continue;
      d.v.y -= 18 * dt;
      d.p.addScaledVector(d.v, dt);
      if (d.p.y < d.s / 2) { d.p.y = d.s / 2; d.v.y *= -0.35; d.v.x *= 0.6; d.v.z *= 0.6; d.w.multiplyScalar(0.6); }
      d.r.addScaledVector(d.w, dt);
      const k = Math.min(1, d.life * 2);
      this.q.setFromEuler(this.e.set(d.r.x, d.r.y, d.r.z));
      this.m.compose(d.p, this.q, V(d.s * k, d.s * k, d.s * k));
      this.mesh.setMatrixAt(j, this.m);
      this.mesh.setColorAt(j, d.c);
      this.list[j++] = d;
    }
    this.list.length = j;
    this.mesh.count = j;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ the view
export class View {
  constructor(canvas, labels, themeName = 'classic') {
    this.canvas = canvas;
    this.labels = labels;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer = r;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.5, 400);
    this.time = 0;
    this.shakeAmp = 0;
    this.atlas = particleAtlas();
    this.fire = new Particles(this.scene, 3000, true, this.atlas);
    this.smoke = new Particles(this.scene, 2000, false, this.atlas);
    this.debris = new Debris(this.scene);
    this.lights = [];
    for (let i = 0; i < 6; i++) { const l = new THREE.PointLight(0xffa040, 0, 9, 1.6); this.scene.add(l); this.lights.push(l); }
    this.lightN = 0;
    this.flashes = [];
    this.tanks = new Map();
    this.shells = new Map();
    this.pups = new Map();
    this.waves = [];
    this.floaters = [];
    this.nameTags = new Map();
    this.discGeo = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.5, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.quality = 2;
    this.perf = { t: 0, n: 0, wait: 3 };
    this.setTheme(themeName);
    this.resize();
  }

  // ------------------------------------------------------------ setup
  setTheme(name) {
    this.themeName = THEMES[name] ? name : 'classic';
    const th = THEMES[this.themeName];
    this.theme = th;
    if (this.world) { this.scene.remove(this.world); }
    for (const t of this.tanks.values()) this.scene.remove(t.group);
    this.tanks.clear();
    const world = new THREE.Group();
    this.world = world;
    this.scene.add(world);
    this.scene.background = col(th.sky);
    this.scene.fog = new THREE.Fog(col(th.fog), 45, 90);
    this.renderer.toneMappingExposure = th.exposure;
    world.add(new THREE.HemisphereLight(th.hemi[0], th.hemi[1], th.hemi[2]));
    const sun = new THREE.DirectionalLight(th.sun[0], th.sun[1]);
    sun.position.set(-9, 22, 12);
    sun.castShadow = this.quality >= 2;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 17, bottom: -17, near: 1, far: 60 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    this.sun = sun;
    world.add(sun, sun.target);

    // The field and the ground around it.
    const gtex = groundTex(this.themeName);
    gtex.wrapS = gtex.wrapT = THREE.RepeatWrapping;
    const field = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: gtex, roughness: this.themeName === 'toy' ? 0.55 : 0.95 }));
    field.receiveShadow = true;
    world.add(field);
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(140, 140).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: col(th.sky).lerp(col('#888'), 0.18), roughness: 1 }));
    outer.position.y = -0.6;
    outer.receiveShadow = true;
    world.add(outer);
    this.buildFrame(world);

    // Block meshes (filled in setGrid).
    const N = SIZE * SIZE;
    const inst = (geo, mat, shadow = true) => {
      const m = new THREE.InstancedMesh(geo, mat, N);
      m.count = 0;
      m.castShadow = shadow;
      m.receiveShadow = true;
      world.add(m);
      return m;
    };
    const t = this.themeName;
    const brickGeo = t === 'toy' ? toyBrickGeo() : t === 'mine' ? coalGeo() : new THREE.BoxGeometry(1, 0.9, 1).translate(0, 0.45, 0);
    const brickMat = new THREE.MeshStandardMaterial({ map: brickTex(t), roughness: t === 'toy' ? 0.3 : t === 'mine' ? 0.55 : 0.85, metalness: t === 'mine' ? 0.25 : 0 });
    this.mBrick = inst(brickGeo, brickMat);
    const steelMats = [];
    for (let i = 0; i < (t === 'toy' ? 6 : 1); i++) steelMats.push(new THREE.MeshStandardMaterial({ map: steelTex(t), roughness: t === 'toy' ? 0.6 : 0.35, metalness: t === 'classic' ? 0.75 : 0.05 }));
    const steelGeo = t === 'toy' ? new THREE.BoxGeometry(0.96, 0.96, 0.96).translate(0, 0.48, 0) : new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.mSteel = steelMats.map((m) => inst(steelGeo, m));
    this.mBush = [0, 1, 2].map((i) => inst(bushGeo(11 + i * 7), new THREE.MeshStandardMaterial({ color: col(th.bush[i]), roughness: t === 'toy' ? 1 : 0.85, flatShading: t !== 'toy' })));
    this.mIce = inst(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.012, 0), new THREE.MeshStandardMaterial({ color: col(th.ice), roughness: 0.06, metalness: 0.2, transparent: true, opacity: t === 'mine' ? 0.95 : 0.85 }), false);
    this.waterMat = waterMaterial(th.water);
    this.mWater = inst(new THREE.BoxGeometry(1, 0.1, 1).translate(0, -0.03, 0), this.waterMat, false);
    this.mWaterBed = inst(new THREE.BoxGeometry(1, 0.05, 1).translate(0, -0.2, 0), new THREE.MeshStandardMaterial({ color: col(th.water[0]).multiplyScalar(0.5) }), false);
    this.padGroup = new THREE.Group();
    world.add(this.padGroup);
    this.baseGroup = new THREE.Group();
    world.add(this.baseGroup);
    this.baseModels = [];
    this.gridKey = '';
    if (this.lastGrid) this.setGrid(this.lastGrid.grid, this.lastGrid.pads, this.lastGrid.bases, true);
  }

  buildFrame(world) {
    const t = this.themeName;
    const mat = t === 'toy' ? new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.35 })
      : t === 'mine' ? new THREE.MeshStandardMaterial({ color: '#6a5038', roughness: 1 })
        : new THREE.MeshStandardMaterial({ color: '#3a4048', roughness: 0.6, metalness: 0.5 });
    const h = t === 'mine' ? 1.6 : 0.7;
    for (const [x, z, w, d] of [[0, -HALF - 0.5, SIZE + 2, 1], [0, HALF + 0.5, SIZE + 2, 1], [-HALF - 0.5, 0, 1, SIZE], [HALF + 0.5, 0, 1, SIZE]]) {
      const m = new THREE.Mesh(t === 'mine' ? new THREE.BoxGeometry(w, h, d) : new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, h / 2 - 0.05, z);
      m.receiveShadow = true;
      m.castShadow = true;
      world.add(m);
    }
    if (t === 'mine') {
      // Bench walls of the pit rising behind the field, and a few lamp posts.
      const benchMat = new THREE.MeshStandardMaterial({ color: '#5a4430', roughness: 1, flatShading: true });
      for (let k = 1; k <= 3; k++) {
        const g = new THREE.BoxGeometry(SIZE + 4 + k * 8, 1.4, 3);
        const m = new THREE.Mesh(g, benchMat);
        m.position.set(0, k * 1.4 - 0.2, -HALF - 1.5 - k * 3);
        m.receiveShadow = true;
        world.add(m);
        for (const s of [-1, 1]) {
          const side = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, SIZE + 4 + k * 6), benchMat);
          side.position.set(s * (HALF + 1.5 + k * 3), k * 1.4 - 0.2, 0);
          side.receiveShadow = true;
          world.add(side);
        }
      }
      for (const [x, z] of [[-HALF - 1.6, -HALF - 1.6], [HALF + 1.6, -HALF - 1.6], [-HALF - 1.6, HALF + 1.6], [HALF + 1.6, HALF + 1.6]]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5, 8), new THREE.MeshStandardMaterial({ color: '#888' }));
        pole.position.set(x, 2.5, z);
        world.add(pole);
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.4), new THREE.MeshStandardMaterial({ color: '#222', emissive: '#ffe8b0', emissiveIntensity: 2.5 }));
        lamp.position.set(x, 5, z);
        lamp.lookAt(0, 0, 0);
        world.add(lamp);
        const l = new THREE.PointLight(0xffe0a0, 6, 22, 1.4);
        l.position.set(x * 0.92, 4.6, z * 0.92);
        world.add(l);
      }
    }
    if (t === 'toy') {
      // A rug edge and a few big toys around the play area.
      const rug = new THREE.Mesh(new THREE.PlaneGeometry(SIZE + 8, SIZE + 8).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#3a6ab8', roughness: 1 }));
      rug.position.y = -0.04;
      world.add(rug);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(2.2, 32, 20), new THREE.MeshStandardMaterial({ color: '#ff4a5a', roughness: 0.35 }));
      ball.position.set(-HALF - 5, 2.2, -HALF + 3);
      ball.castShadow = true;
      world.add(ball);
      const stripe = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.25, 12, 48), new THREE.MeshStandardMaterial({ color: '#fff', roughness: 0.35 }));
      stripe.position.copy(ball.position);
      stripe.rotation.x = 1.1;
      world.add(stripe);
      for (let i = 0; i < 4; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ map: steelTex('toy'), roughness: 0.6 }));
        b.position.set(HALF + 4 + (i % 2) * 2.2, 1 + Math.floor(i / 2) * 2, -4 + (i % 2));
        b.rotation.y = rand(-0.4, 0.4);
        b.castShadow = true;
        world.add(b);
      }
    }
    if (t === 'classic') {
      // Sandbags along the outside.
      const bag = new THREE.MeshStandardMaterial({ color: '#7a6a4a', roughness: 1 });
      const geo = new THREE.CapsuleGeometry(0.28, 0.6, 4, 8).rotateZ(Math.PI / 2);
      for (let i = -HALF; i < HALF; i += 1.1) {
        for (const z of [-HALF - 1.7, HALF + 1.7]) { const m = new THREE.Mesh(geo, bag); m.position.set(i + 0.5, 0.25, z); m.castShadow = true; world.add(m); }
      }
    }
  }

  setQuality(q) {
    this.quality = q;
    this.sun.castShadow = q >= 2;
    this.fire.scale = this.smoke.scale = q >= 2 ? 1 : q === 1 ? 0.7 : 0.45;
    this.bloom.enabled = q >= 1;
    this.renderer.setPixelRatio(q >= 2 ? Math.min(window.devicePixelRatio || 1, 1.5) : q === 1 ? 1 : 0.7);
    this.resize();
  }

  measure(dt) {
    const pf = this.perf;
    if (pf.wait > 0) { pf.wait -= dt; return; }
    pf.t += dt;
    pf.n++;
    if (pf.t < 2) return;
    const fps = pf.n / pf.t;
    pf.t = 0;
    pf.n = 0;
    if (fps < 30 && this.quality > 0) { this.setQuality(this.quality - 1); pf.wait = 1.5; }
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // Fit the whole field: further away on narrow windows.
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const needH = SIZE * 1.0 + 2;
    const needW = (SIZE + 4) / this.camera.aspect;
    const dist = Math.max(needH, needW) / (2 * Math.tan(fov / 2)) * 1.0;
    this.camDist = dist;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ the field
  setGrid(grid, pads, bases, force) {
    this.lastGrid = { grid, pads, bases };
    if (!force && grid === this.gridKey) return;
    this.gridKey = grid;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const n = { brick: 0, steel: 0, bush: [0, 0, 0], ice: 0, water: 0 };
    const steelN = this.mSteel.map(() => 0);
    const palette = ['#e8343a', '#2f7ae8', '#f2c21a', '#2fa84a', '#ff8a1a', '#f2f2f2'];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const v = Number(grid[y * SIZE + x]);
        const h = (x * 73856093) ^ (y * 19349663);
        const px = wx(x + 0.5);
        const pz = wx(y + 0.5);
        if (v === TILE.BRICK) {
          const rot = this.themeName === 'mine' ? ((h >>> 3) % 6) : 0;
          m.makeRotationY(rot);
          m.setPosition(px, 0, pz);
          this.mBrick.setMatrixAt(n.brick, m);
          if (this.themeName === 'toy') c.set(palette[(Math.floor(x / 2) + Math.floor(y / 2) * 3) % palette.length]);
          else if (this.themeName === 'mine') c.setScalar(0.8 + ((h >>> 5) % 10) / 25);
          else c.setScalar(0.88 + ((h >>> 5) % 10) / 40);
          this.mBrick.setColorAt(n.brick, c);
          n.brick++;
        } else if (v === TILE.STEEL) {
          const k = (h >>> 4) % this.mSteel.length;
          m.makeRotationY(this.themeName === 'toy' ? ((h >>> 7) % 4) * (Math.PI / 2) + (((h >>> 9) % 10) - 5) * 0.012 : 0);
          m.setPosition(px, 0, pz);
          this.mSteel[k].setMatrixAt(steelN[k]++, m);
        } else if (v === TILE.BUSH) {
          const k = (h >>> 6) % 3;
          m.makeRotationY(((h >>> 2) % 8) * 0.8);
          m.setPosition(px, 0, pz);
          this.mBush[k].setMatrixAt(n.bush[k]++, m);
        } else if (v === TILE.ICE) {
          m.makeTranslation(px, 0, pz);
          this.mIce.setMatrixAt(n.ice++, m);
        } else if (v === TILE.WATER) {
          m.makeTranslation(px, 0, pz);
          this.mWater.setMatrixAt(n.water, m);
          this.mWaterBed.setMatrixAt(n.water++, m);
        }
      }
    }
    const done = (mesh, count) => { mesh.count = count; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; mesh.computeBoundingSphere(); };
    done(this.mBrick, n.brick);
    this.mSteel.forEach((ms, i) => done(ms, steelN[i]));
    this.mBush.forEach((mb, i) => done(mb, n.bush[i]));
    done(this.mIce, n.ice);
    done(this.mWater, n.water);
    done(this.mWaterBed, n.water);
    this.setPads(pads || []);
    this.setBases(bases || []);
  }

  setPads(pads) {
    const key = JSON.stringify(pads);
    if (key === this.padKey) return;
    this.padKey = key;
    this.padGroup.clear();
    this.padMats = [];
    pads.forEach((pad, i) => {
      const color = this.theme.pad[i % this.theme.pad.length];
      for (const [x, y] of [pad.a, pad.b]) {
        const mat = swirlMaterial(color);
        this.padMats.push(mat);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.3).rotateX(-Math.PI / 2), mat);
        m.position.set(wx(x + 1), 0.03, wx(y + 1));
        this.padGroup.add(m);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.08, 8, 40).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#333', emissive: color, emissiveIntensity: 1.6 }));
        ring.position.set(wx(x + 1), 0.06, wx(y + 1));
        this.padGroup.add(ring);
      }
    });
  }

  setBases(bases) {
    const key = JSON.stringify(bases.map((b) => [b[0], b[1], b[3]]));
    if (key === this.baseKey) { this.baseHp = bases; return; }
    this.baseKey = key;
    this.baseGroup.clear();
    this.baseModels = bases.map((b) => {
      const g = b[3] ? this.buildBase(b[2]) : this.buildRubble();
      g.position.set(wx(b[0] + 1), 0, wx(b[1] + 1));
      this.baseGroup.add(g);
      return { g, alive: !!b[3], x: b[0], y: b[1], team: b[2] };
    });
    this.baseHp = bases;
  }

  buildBase(team) {
    const g = new THREE.Group();
    const t = this.themeName;
    const teamCol = this.mode === 'versus' ? this.theme.players[team] : this.theme.players[0];
    const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...o });
    const add = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
    if (t === 'toy') {
      // A teddy bear guarding the toy box.
      const fur = std('#b87a42', { roughness: 0.95 });
      const light = std('#e8c49a', { roughness: 0.95 });
      add(new THREE.SphereGeometry(0.62, 24, 16), fur, 0, 0.6, 0.05).scale.set(1, 1.05, 0.9);
      add(new THREE.SphereGeometry(0.4, 20, 14), light, 0, 0.6, -0.42).scale.set(1, 1.1, 0.4);
      add(new THREE.SphereGeometry(0.45, 24, 16), fur, 0, 1.45, 0);
      add(new THREE.SphereGeometry(0.18, 12, 10), fur, -0.36, 1.82, 0);
      add(new THREE.SphereGeometry(0.18, 12, 10), fur, 0.36, 1.82, 0);
      add(new THREE.SphereGeometry(0.18, 12, 10), light, 0, 1.36, -0.38).scale.set(1, 0.8, 0.8);
      add(new THREE.SphereGeometry(0.06, 8, 8), std('#111', { roughness: 0.2 }), 0, 1.42, -0.53);
      for (const s of [-1, 1]) {
        add(new THREE.SphereGeometry(0.06, 8, 8), std('#111', { roughness: 0.2 }), s * 0.16, 1.58, -0.38);
        add(new THREE.SphereGeometry(0.2, 12, 10), fur, s * 0.62, 0.75, -0.15);
        add(new THREE.SphereGeometry(0.24, 12, 10), fur, s * 0.32, 0.18, -0.25);
      }
      const bow = add(new THREE.TorusGeometry(0.16, 0.06, 8, 16), std(teamCol, { roughness: 0.4 }), 0, 1.06, -0.36);
      bow.rotation.y = Math.PI / 2;
      this.flag = null;
      return g;
    }
    if (t === 'mine') {
      // The site office: a container with a beacon and a radio mast.
      add(new THREE.BoxGeometry(1.8, 0.9, 1.2), std('#e8e2d0', { roughness: 0.7 }), 0, 0.45, 0);
      add(new THREE.BoxGeometry(1.84, 0.12, 1.24), std('#4a5a6a'), 0, 0.95, 0);
      add(new THREE.BoxGeometry(0.5, 0.32, 0.02), std('#6ac0ff', { emissive: '#2a6aa0', emissiveIntensity: 0.6, roughness: 0.1 }), -0.4, 0.55, -0.61);
      add(new THREE.BoxGeometry(0.34, 0.66, 0.02), std('#8a6a4a'), 0.5, 0.36, -0.61);
      add(new THREE.CylinderGeometry(0.03, 0.04, 1.4, 6), std('#999', { metalness: 0.7 }), 0.7, 1.7, 0.4);
      const beacon = add(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 12), std('#552200', { emissive: teamCol, emissiveIntensity: 3 }), -0.6, 1.12, 0.3);
      this.beacon = beacon;
      return g;
    }
    // Classic: a concrete command bunker with a radar and a flag.
    const conc = std('#8a8e86', { roughness: 0.95 });
    add(new THREE.CylinderGeometry(0.95, 1.05, 0.7, 8), conc, 0, 0.35, 0);
    add(new THREE.CylinderGeometry(0.62, 0.8, 0.35, 8), conc, 0, 0.87, 0);
    add(new THREE.BoxGeometry(0.9, 0.12, 0.05), std('#111'), 0, 0.5, -0.98);
    add(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 6), std('#ccc', { metalness: 0.8 }), 0.35, 1.7, 0.2);
    const flag = add(new THREE.PlaneGeometry(0.6, 0.38, 6, 1), std(teamCol, { side: THREE.DoubleSide, emissive: teamCol, emissiveIntensity: 0.2 }), 0.66, 2.25, 0.2);
    flag.userData.base = flag.geometry.attributes.position.array.slice();
    this.flag = flag;
    const dish = add(new THREE.SphereGeometry(0.32, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), std('#b8bcc0', { metalness: 0.6, side: THREE.DoubleSide }), -0.25, 1.2, 0);
    dish.rotation.x = -1.2;
    this.dish = dish;
    return g;
  }

  buildRubble() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 1, flatShading: true });
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(0.2, 0.42), 0), mat);
      m.position.set(rand(-0.7, 0.7), rand(0.1, 0.3), rand(-0.7, 0.7));
      m.rotation.set(rand(0, 3), rand(0, 3), 0);
      m.castShadow = true;
      g.add(m);
    }
    g.userData.smoke = true;
    return g;
  }

  // ------------------------------------------------------------ tanks
  buildTank(kind, color, slot) {
    const t = this.themeName;
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const dims = { scout: [1.5, 1.42, 0.3], trooper: [1.72, 1.58, 0.34], heavy: [1.86, 1.78, 0.42], rocket: [1.72, 1.6, 0.36], drone: [1.6, 1.6, 0.3], player: [1.74, 1.62, 0.36] }[kind];
    const [len, wid, hgt] = dims;
    const glossy = t === 'toy';
    const paint = addRim(new THREE.MeshStandardMaterial({ color, roughness: glossy ? 0.22 : t === 'mine' ? 0.55 : 0.62, metalness: glossy ? 0.05 : 0.25 }), '#ffffff', 0.12);
    const dark = new THREE.MeshStandardMaterial({ color: col(color).multiplyScalar(0.55), roughness: glossy ? 0.3 : 0.7, metalness: 0.2 });
    const metal = new THREE.MeshStandardMaterial({ color: t === 'toy' ? '#d8d8d8' : '#3a3c40', roughness: 0.35, metalness: 0.8 });
    const add = (parent, geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
    const parts = { paint, treads: [], plates: [] };
    const trackW = wid * 0.24;
    const lift = kind === 'drone' ? 0.35 : 0;
    if (kind !== 'drone') {
      for (const s of [-1, 1]) {
        const tm = new THREE.MeshStandardMaterial({ map: treadTex(), roughness: 0.9, color: t === 'toy' ? '#555' : '#fff' });
        tm.map.repeat.set(1, len * 1.6);
        parts.treads.push(tm);
        const tr = add(body, new THREE.BoxGeometry(trackW, 0.36, len), tm, s * (wid / 2 - trackW / 2), 0.2, 0);
        tr.userData.tread = true;
        // Wheels showing on the outside.
        for (let i = 0; i < 4; i++) add(body, new THREE.CylinderGeometry(0.13, 0.13, 0.04, 14).rotateZ(Math.PI / 2), metal, s * (wid / 2 + 0.005), 0.18, -len / 2 + 0.25 + i * ((len - 0.5) / 3));
        // Fenders.
        add(body, new THREE.BoxGeometry(trackW + 0.06, 0.05, len + 0.08), dark, s * (wid / 2 - trackW / 2), 0.4, 0);
      }
    } else {
      // A hover drone: a glowing ring underneath.
      const ring = add(body, new THREE.TorusGeometry(0.62, 0.08, 8, 32).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#222', emissive: color, emissiveIntensity: 2.4 }), 0, 0.25, 0);
      parts.ring = ring;
    }
    const hull = add(body, hullGeo(len - 0.08, wid - trackW * 2 + 0.06, hgt), paint, 0, 0.26 + lift, 0);
    hull.receiveShadow = true;
    if (kind === 'heavy') {
      // Armour plates fall off as it takes hits.
      parts.plates.push(add(body, new THREE.BoxGeometry(0.06, 0.32, len * 0.9), dark, -wid / 2 - 0.04, 0.3, 0));
      parts.plates.push(add(body, new THREE.BoxGeometry(0.06, 0.32, len * 0.9), dark, wid / 2 + 0.04, 0.3, 0));
      parts.plates.push(add(body, new THREE.BoxGeometry(wid * 0.7, 0.26, 0.08), dark, 0, 0.42, -len / 2 + 0.04));
    }
    // Turret and gun.
    const turret = new THREE.Group();
    turret.position.set(0, 0.26 + lift + hgt, kind === 'rocket' ? 0.12 : 0.06);
    body.add(turret);
    parts.turret = turret;
    const tr = { scout: 0.36, trooper: 0.44, heavy: 0.52, rocket: 0.42, drone: 0.38, player: 0.46 }[kind];
    if (t === 'toy') add(turret, new THREE.SphereGeometry(tr, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), paint, 0, 0, 0).scale.set(1, 0.9, 1);
    else add(turret, new THREE.CylinderGeometry(tr * 0.82, tr, 0.26, t === 'classic' ? 8 : 16), paint, 0, 0.13, 0);
    const gun = new THREE.Group();
    gun.position.set(0, t === 'toy' ? 0.14 : 0.14, -tr * 0.6);
    turret.add(gun);
    parts.gun = gun;
    parts.gunZ = gun.position.z;
    const bl = { scout: 0.7, trooper: 1.0, heavy: 0.85, rocket: 0.5, drone: 0.6, player: 0.92 }[kind];
    const br = kind === 'heavy' ? 0.085 : 0.065;
    const barrels = kind === 'heavy' ? [-0.1, 0.1] : [0];
    for (const bx of barrels) {
      add(gun, new THREE.CylinderGeometry(br, br * 1.1, bl, 12).rotateX(Math.PI / 2), t === 'toy' ? paint : metal, bx, 0, -bl / 2);
      add(gun, new THREE.CylinderGeometry(br * 1.45, br * 1.45, 0.12, 12).rotateX(Math.PI / 2), t === 'toy' ? dark : metal, bx, 0, -bl + 0.04);
    }
    parts.muzzle = -bl - tr * 0.6;
    if (kind === 'rocket') {
      const pod = add(turret, new THREE.BoxGeometry(0.62, 0.3, 0.55), dark, 0, 0.42, 0.05);
      for (const [x, y] of [[-0.15, -0.06], [0.15, -0.06], [-0.15, 0.08], [0.15, 0.08]]) add(pod, new THREE.CylinderGeometry(0.07, 0.07, 0.04, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#111', emissive: '#ff4a1a', emissiveIntensity: 1 }), x, y, -0.28);
    }
    if (kind === 'drone') {
      const dish = add(turret, new THREE.SphereGeometry(0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.5), metal, 0, 0.38, 0.1);
      dish.rotation.x = -0.8;
      parts.dish = dish;
    }
    // Theme details.
    if (t === 'classic') {
      add(turret, new THREE.CylinderGeometry(0.12, 0.12, 0.06, 12), dark, 0.12, 0.29, 0.1);
      add(turret, new THREE.CylinderGeometry(0.008, 0.008, 0.9, 4), metal, -0.22, 0.6, 0.2);
      add(body, new THREE.BoxGeometry(0.4, 0.14, 0.22), dark, 0, 0.36 + hgt, len / 2 - 0.2);
    } else if (t === 'mine') {
      // A roll bar with an amber beacon and hazard stripes along the hull.
      const bar = new THREE.MeshStandardMaterial({ color: '#222', roughness: 0.5, metalness: 0.6 });
      add(body, new THREE.BoxGeometry(0.05, 0.4, 0.05), bar, -0.3, 0.46 + hgt, len / 2 - 0.3);
      add(body, new THREE.BoxGeometry(0.05, 0.4, 0.05), bar, 0.3, 0.46 + hgt, len / 2 - 0.3);
      add(body, new THREE.BoxGeometry(0.66, 0.05, 0.05), bar, 0, 0.66 + hgt, len / 2 - 0.3);
      parts.beacon = add(body, new THREE.CylinderGeometry(0.07, 0.07, 0.11, 10), new THREE.MeshStandardMaterial({ color: '#552200', emissive: '#ff9a00', emissiveIntensity: 2 }), 0, 0.74 + hgt, len / 2 - 0.3);
      const stripe = steelTex('mine');
      stripe.repeat.set(2, 1);
      stripe.wrapS = THREE.RepeatWrapping;
      for (const s of [-1, 1]) {
        const p = add(body, new THREE.PlaneGeometry(len * 0.8, 0.14), new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.6 }), s * (wid / 2 - trackW - 0.02), 0.4 + hgt * 0.4, 0);
        p.rotation.y = s * Math.PI / 2;
      }
    } else {
      // Toy: a big wind-up key on the back.
      const key = new THREE.Group();
      key.position.set(0, 0.35 + hgt, len / 2 - 0.05);
      body.add(key);
      const km = new THREE.MeshStandardMaterial({ color: '#e8c040', roughness: 0.25, metalness: 0.8 });
      add(key, new THREE.CylinderGeometry(0.04, 0.04, 0.3, 8).rotateX(Math.PI / 2), km, 0, 0, 0.15);
      for (const s of [-1, 1]) add(key, new THREE.TorusGeometry(0.12, 0.035, 8, 16), km, s * 0.13, 0, 0.3).rotation.y = Math.PI / 2;
      parts.key = key;
    }
    if (slot >= 0) {
      // Players: a coloured stripe ring on the turret so they stand out.
      add(turret, new THREE.TorusGeometry(tr * 0.95, 0.035, 6, 28).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#111', emissive: color, emissiveIntensity: 1.6 }), 0, 0.03, 0);
    }
    const shield = new THREE.Mesh(new THREE.SphereGeometry(1.32, 32, 18), bubbleMaterial('#5ab8ff'));
    shield.position.y = 0.55;
    shield.visible = false;
    g.add(shield);
    parts.shield = shield;
    // The spawn portal: a swirling disc and a beam of light.
    const spawn = new THREE.Group();
    const swirl = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2), swirlMaterial(slot >= 0 ? color : '#ff5a3a'));
    swirl.position.y = 0.05;
    spawn.add(swirl);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 3, 24, 1, true).translate(0, 1.5, 0), beamMaterial(slot >= 0 ? color : '#ff7a4a'));
    spawn.add(beam);
    spawn.visible = false;
    g.add(spawn);
    parts.spawn = spawn;
    parts.spawnMats = [swirl.material, beam.material];
    parts.body = body;
    return { group: g, parts };
  }

  tankColor(kind, slot) {
    if (slot >= 0) return this.theme.players[slot];
    return this.theme.enemy[kind] || '#999';
  }

  // ------------------------------------------------------------ effects
  flash(x, y, z, color, power = 6, len = 0.15) {
    const l = this.lights[this.lightN++ % this.lights.length];
    l.color.set(color);
    l.position.set(x, y, z);
    l.intensity = power;
    this.flashes.push({ l, t: len, len, power });
  }
  shake(a) { this.shakeAmp = Math.min(0.6, this.shakeAmp + a); }

  explosion(x, z, big) {
    const s = big ? 1.4 : 0.8;
    const hot = col('#fff2b0');
    const mid = col('#ff7a1a');
    for (let i = 0; i < (big ? 70 : 32); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(1, 5) * s;
      this.fire.add({ p: [x, rand(0.3, 0.9), z], v: [Math.cos(a) * sp, rand(1, 5) * s, Math.sin(a) * sp], c0: hot, c1: mid, size: rand(0.5, 1.1) * s, size1: rand(1.2, 2.2) * s, life: rand(0.3, 0.7), tile: TILE_FLAME, drag: 0.9, spin: rand(-3, 3) });
    }
    for (let i = 0; i < (big ? 30 : 14); i++) {
      const a = Math.random() * Math.PI * 2;
      this.fire.add({ p: [x, 0.6, z], v: [Math.cos(a) * rand(6, 12), rand(3, 9), Math.sin(a) * rand(6, 12)], c0: col('#ffe8a0'), c1: col('#ff5a1a'), size: 0.08, life: rand(0.3, 0.7), tile: TILE_SPARK, stretch: 0.06, grav: 14, drag: 0.97 });
    }
    for (let i = 0; i < (big ? 26 : 12); i++) {
      this.smoke.add({ p: [x + rand(-0.5, 0.5), rand(0.4, 1), z + rand(-0.5, 0.5)], v: [rand(-1, 1), rand(1, 2.4), rand(-1, 1)], c0: col('#3a3430'), c1: col('#1a1816'), a: 0.75, size: rand(0.8, 1.4) * s, size1: rand(2.4, 3.6) * s, life: rand(1.2, 2.2), tile: TILE_SMOKE, drag: 0.94, spin: rand(-1, 1) });
    }
    const ring = new THREE.Mesh(this.discGeo, shockMaterial('#ffb060'));
    ring.position.set(x, 0.06, z);
    this.scene.add(ring);
    this.waves.push({ m: ring, t: 0, len: 0.45, size: big ? 4.5 : 2.6 });
    this.flash(x, 1.2, z, '#ff9a40', big ? 30 : 14, big ? 0.4 : 0.25);
    this.shake(big ? 0.45 : 0.18);
  }

  fx(e, state) {
    const X = (v) => wx(v);
    switch (e.e) {
      case 'fire': {
        const tk = this.tanks.get(e.id);
        if (tk) tk.recoil = 1;
        const [dx, dz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][e.dir];
        const x = X(e.x); const z = X(e.y);
        for (let i = 0; i < 10; i++) this.fire.add({ p: [x, 0.75, z], v: [dx * rand(2, 6) + rand(-1, 1), rand(0, 1), dz * rand(2, 6) + rand(-1, 1)], c0: col('#fff4c0'), c1: col('#ff8a2a'), size: rand(0.25, 0.5), size1: 0.05, life: rand(0.08, 0.18), tile: TILE_FLAME });
        for (let i = 0; i < 5; i++) this.smoke.add({ p: [x, 0.75, z], v: [dx * rand(0.5, 2), rand(0.3, 1), dz * rand(0.5, 2)], c0: col('#9a9690'), a: 0.4, size: 0.3, size1: 1, life: rand(0.5, 0.9), tile: TILE_SMOKE });
        this.flash(x, 0.9, z, '#ffc070', 5, 0.08);
        break;
      }
      case 'wall': {
        const x = X(e.x); const z = X(e.y);
        if (e.steel) {
          for (let i = 0; i < 14; i++) { const a = Math.random() * Math.PI * 2; this.fire.add({ p: [x, 0.6, z], v: [Math.cos(a) * rand(2, 6), rand(1, 5), Math.sin(a) * rand(2, 6)], c0: col('#ffffff'), c1: col('#ffb040'), size: 0.06, life: rand(0.15, 0.35), tile: TILE_SPARK, stretch: 0.05, grav: 10 }); }
          this.flash(x, 0.8, z, '#ffe0b0', 4, 0.08);
        } else {
          this.debris.burst(x, 0.5, z, this.theme.debris.brick, 9, 3, this.themeName === 'toy' ? 0.2 : 0.14);
          for (let i = 0; i < 6; i++) this.smoke.add({ p: [x + rand(-0.4, 0.4), 0.4, z + rand(-0.4, 0.4)], v: [rand(-0.6, 0.6), rand(0.4, 1.2), rand(-0.6, 0.6)], c0: col(this.theme.dust), a: 0.6, size: 0.5, size1: 1.4, life: rand(0.6, 1.1), tile: TILE_SMOKE });
          this.flash(x, 0.8, z, '#ffb070', 4, 0.1);
        }
        break;
      }
      case 'boom': {
        this.explosion(X(e.x), X(e.y), !!(e.big || e.id));
        if (e.id) this.debris.burst(X(e.x), 0.7, X(e.y), '#333', 14, 5, 0.18);
        break;
      }
      case 'clash': {
        const x = X(e.x); const z = X(e.y);
        for (let i = 0; i < 16; i++) { const a = Math.random() * Math.PI * 2; this.fire.add({ p: [x, 0.7, z], v: [Math.cos(a) * rand(3, 8), rand(-1, 3), Math.sin(a) * rand(3, 8)], c0: col('#fff'), c1: col('#6ad0ff'), size: 0.07, life: rand(0.15, 0.35), tile: TILE_SPARK, stretch: 0.05 }); }
        this.flash(x, 0.9, z, '#bfe6ff', 6, 0.1);
        break;
      }
      case 'bounce': {
        const x = X(e.x); const z = X(e.y);
        for (let i = 0; i < 8; i++) { const a = Math.random() * Math.PI * 2; this.fire.add({ p: [x, 0.7, z], v: [Math.cos(a) * 4, rand(0, 3), Math.sin(a) * 4], c0: col('#fff'), c1: col('#3ae0c0'), size: 0.06, life: 0.25, tile: TILE_SPARK, stretch: 0.05 }); }
        break;
      }
      case 'armor': case 'shieldHit': {
        const tk = this.tanks.get(e.id);
        if (tk) tk.hitFlash = 1;
        const x = X(e.x); const z = X(e.y);
        for (let i = 0; i < 12; i++) { const a = Math.random() * Math.PI * 2; this.fire.add({ p: [x, 0.7, z], v: [Math.cos(a) * rand(2, 6), rand(1, 4), Math.sin(a) * rand(2, 6)], c0: col('#fff'), c1: col(e.e === 'armor' ? '#ffa040' : '#5ab8ff'), size: 0.07, life: rand(0.2, 0.4), tile: TILE_SPARK, stretch: 0.05, grav: 8 }); }
        break;
      }
      case 'tele': {
        for (const [x, y] of [[e.x, e.y], [e.x2, e.y2]]) {
          for (let i = 0; i < 24; i++) { const a = Math.random() * Math.PI * 2; this.fire.add({ p: [X(x + 1) + Math.cos(a) * 1.1, 0.2, X(y + 1) + Math.sin(a) * 1.1], v: [0, rand(2, 6), 0], c0: col('#ffffff'), c1: col('#5ad2ff'), size: 0.12, size1: 0.02, life: rand(0.4, 0.8), tile: TILE_GLOW }); }
          this.flash(X(x + 1), 1, X(y + 1), '#7ad8ff', 8, 0.3);
        }
        break;
      }
      case 'spawn': {
        const x = X(e.x + 1); const z = X(e.y + 1);
        for (let i = 0; i < 20; i++) { const a = Math.random() * Math.PI * 2; this.fire.add({ p: [x, 0.2, z], v: [Math.cos(a) * 2, rand(1, 5), Math.sin(a) * 2], c0: col('#fff'), c1: col('#ff7a4a'), size: 0.12, size1: 0.02, life: rand(0.5, 1), tile: TILE_GLOW }); }
        break;
      }
      case 'powerup': {
        const x = X(e.x + 1); const z = X(e.y + 1);
        for (let i = 0; i < 24; i++) { const a = Math.random() * Math.PI * 2; this.fire.add({ p: [x, 1, z], v: [Math.cos(a) * 3, rand(-1, 3), Math.sin(a) * 3], c0: col('#fff'), c1: col(POWER_COL[e.type] || '#fff'), size: 0.15, size1: 0.02, life: rand(0.5, 0.9), tile: TILE_GLOW }); }
        break;
      }
      case 'got': {
        const tk = this.tanks.get(e.id);
        if (!tk) break;
        const x = tk.group.position.x; const z = tk.group.position.z;
        for (let i = 0; i < 30; i++) { const a = Math.random() * Math.PI * 2; this.fire.add({ p: [x + Math.cos(a), 0.3, z + Math.sin(a)], v: [0, rand(2, 6), 0], c0: col('#fff'), c1: col(POWER_COL[e.type] || '#fff'), size: 0.14, size1: 0.02, life: rand(0.5, 1), tile: TILE_GLOW }); }
        this.flash(x, 1.2, z, POWER_COL[e.type] || '#fff', 8, 0.35);
        break;
      }
      case 'build': {
        const x = X(e.x + 1); const z = X(e.y + 1);
        for (let i = 0; i < 12; i++) this.smoke.add({ p: [x + rand(-1, 1), 0.2, z + rand(-1, 1)], v: [rand(-1, 1), rand(0.5, 1.5), rand(-1, 1)], c0: col(this.theme.dust), a: 0.6, size: 0.5, size1: 1.6, life: rand(0.6, 1), tile: TILE_SMOKE });
        break;
      }
      case 'baseHit': {
        const x = X(e.x); const z = X(e.y);
        for (let i = 0; i < 20; i++) { const a = Math.random() * Math.PI * 2; this.fire.add({ p: [x, 1, z], v: [Math.cos(a) * rand(2, 6), rand(2, 6), Math.sin(a) * rand(2, 6)], c0: col('#fff'), c1: col('#ff4a3a'), size: 0.08, life: rand(0.3, 0.6), tile: TILE_SPARK, stretch: 0.05, grav: 10 }); }
        this.flash(x, 1.5, z, '#ff4a3a', 10, 0.3);
        this.shake(0.15);
        break;
      }
      case 'baseDown': {
        this.explosion(X(e.x), X(e.y), true);
        setTimeout(() => this.explosion(X(e.x) + 0.6, X(e.y) - 0.4, true), 180);
        this.debris.burst(X(e.x), 1, X(e.y), '#8a8a86', 30, 6, 0.2);
        this.shake(0.6);
        break;
      }
      case 'airstrike': this.shake(0.5); break;
      default: break;
    }
    void state;
  }

  floater(x, y, text, color) {
    const el = document.createElement('div');
    el.className = 'floater';
    el.textContent = text;
    el.style.color = color;
    this.labels.appendChild(el);
    this.floaters.push({ el, x: wx(x), z: wx(y), t: 0 });
  }

  // ------------------------------------------------------------ frame
  // s: the interpolated state from tanks.js: { tanks, bullets, powerups, bases, players, freeze, mode }
  frame(dt, s) {
    this.time += dt;
    this.measure(dt);
    const now = this.time;
    if (s) {
      this.mode = s.mode;
      this.syncTanks(s, dt);
      this.syncShells(s, dt);
      this.syncPowerups(s, dt);
    }
    // Water ripples, pads, the base.
    this.waterMat.uniforms.uTime.value = now;
    for (const m of this.padMats || []) m.uniforms.uTime.value = now;
    for (const b of this.baseModels) {
      if (!b.alive) {
        if (Math.random() < dt * 8) this.smoke.add({ p: [b.g.position.x + rand(-0.5, 0.5), 0.5, b.g.position.z + rand(-0.5, 0.5)], v: [rand(-0.2, 0.2), rand(1, 2), rand(-0.2, 0.2)], c0: col('#2a2624'), a: 0.6, size: 0.6, size1: 2.2, life: 2.4, tile: TILE_SMOKE });
        if (Math.random() < dt * 5) this.fire.add({ p: [b.g.position.x + rand(-0.4, 0.4), 0.3, b.g.position.z + rand(-0.4, 0.4)], v: [0, rand(0.5, 1.5), 0], c0: col('#ffd080'), c1: col('#ff4a1a'), size: 0.4, size1: 0.1, life: 0.5, tile: TILE_FLAME });
      }
      const hp = (this.baseHp || []).find((x) => x[0] === b.x && x[1] === b.y);
      b.g.position.y = 0;
      if (hp && hp[3] && hp[4] < hp[5] && Math.random() < dt * (hp[5] - hp[4]) * 2) {
        this.smoke.add({ p: [b.g.position.x + rand(-0.4, 0.4), 1.1, b.g.position.z + rand(-0.4, 0.4)], v: [rand(-0.2, 0.2), rand(0.6, 1.2), 0], c0: col('#444'), a: 0.5, size: 0.4, size1: 1.4, life: 1.8, tile: TILE_SMOKE });
      }
    }
    if (this.flag) {
      const p = this.flag.geometry.attributes.position;
      const base = this.flag.userData.base;
      for (let i = 0; i < p.count; i++) { const x = base[i * 3]; p.setZ(i, Math.sin(x * 9 - now * 6) * 0.06 * (x + 0.3)); }
      p.needsUpdate = true;
    }
    if (this.dish) this.dish.rotation.y = now * 1.4;
    if (this.beacon) this.beacon.material.emissiveIntensity = 1 + 3 * (0.5 + 0.5 * Math.sin(now * 8));

    this.fire.update(dt);
    this.smoke.update(dt);
    this.debris.update(dt);
    for (const f of this.flashes) { f.t -= dt; f.l.intensity = Math.max(0, f.t / f.len) * f.power; }
    this.flashes = this.flashes.filter((f) => f.t > 0);
    for (const w of this.waves) {
      w.t += dt;
      const k = w.t / w.len;
      w.m.scale.setScalar(w.size * (0.3 + k));
      w.m.material.uniforms.uProg.value = Math.min(1, k * 1.2);
      w.m.material.uniforms.uAlpha.value = 1 - k;
      if (k >= 1) { this.scene.remove(w.m); w.m.material.dispose(); }
    }
    this.waves = this.waves.filter((w) => w.t < w.len);

    // Camera: the whole field, tilted, with a little shake.
    this.shakeAmp = Math.max(0, this.shakeAmp - dt * 1.4);
    const sx = (Math.random() - 0.5) * this.shakeAmp;
    const sz = (Math.random() - 0.5) * this.shakeAmp;
    const pitch = 0.9;
    this.camera.position.set(sx, Math.sin(pitch) * this.camDist, Math.cos(pitch) * this.camDist + 0.6 + sz);
    this.camera.lookAt(sx * 0.5, 0, 0.6 + sz * 0.5);
    this.updateLabels(s, dt);
    this.composer.render();
  }

  syncTanks(s, dt) {
    const seen = new Set();
    for (const t of s.tanks) {
      const [id, kind, team, x, y, dir, moving, hp, shield, spawning, carrier, slot, ricochet] = t;
      seen.add(id);
      let tk = this.tanks.get(id);
      if (!tk) {
        const built = this.buildTank(kind, this.tankColor(kind, slot), slot);
        tk = { ...built, id, kind, slot, team, rot: -dir * Math.PI / 2, recoil: 0, hitFlash: 0, dust: 0, tread: 0 };
        tk.group.rotation.y = tk.rot;
        this.scene.add(tk.group);
        this.tanks.set(id, tk);
      }
      tk.group.traverse((o) => { if (o.isMesh && o.castShadow !== undefined) o.castShadow = true; });
      const px = wx(x + 1);
      const pz = wx(y + 1);
      const moved = Math.hypot(px - tk.group.position.x, pz - tk.group.position.z);
      tk.group.position.set(px, 0, pz);
      tk.rot = angleLerp(tk.rot, -dir * Math.PI / 2, Math.min(1, dt * 18));
      tk.group.rotation.y = tk.rot;
      const p = tk.parts;
      p.body.visible = !spawning;
      p.spawn.visible = !!spawning;
      if (spawning) {
        for (const m of p.spawnMats) m.uniforms.uTime.value = this.time;
        p.spawn.rotation.y = this.time * 2;
      }
      p.shield.visible = !!shield && !spawning;
      if (shield) { p.shield.material.uniforms.uTime.value = this.time; p.shield.material.uniforms.uAlpha.value = 0.55 + 0.25 * Math.sin(this.time * 9); }
      // Treads roll with the distance moved.
      if (moving || moved > 0.001) {
        tk.tread += moved * 1.6;
        for (const m of p.treads) m.map.offset.y = -tk.tread;
        tk.dust += dt;
        if (tk.dust > 0.09 && kind !== 'drone') {
          tk.dust = 0;
          const back = V(0, 0, 0.9).applyAxisAngle(V(0, 1, 0), tk.rot);
          this.smoke.add({ p: [px + back.x + rand(-0.4, 0.4), 0.15, pz + back.z + rand(-0.4, 0.4)], v: [rand(-0.3, 0.3), rand(0.2, 0.6), rand(-0.3, 0.3)], c0: col(this.theme.dust), a: this.themeName === 'mine' ? 0.5 : 0.28, size: 0.35, size1: 1.1, life: rand(0.6, 1.0), tile: TILE_SMOKE });
        }
      }
      // Body bobs a little while driving; the drone hovers.
      p.body.position.y = kind === 'drone' ? 0.12 + Math.sin(this.time * 3 + id) * 0.08 : moving ? Math.abs(Math.sin(this.time * 22 + id)) * 0.025 : 0;
      tk.recoil = Math.max(0, tk.recoil - dt * 6);
      p.gun.position.z = p.gunZ + tk.recoil * 0.18;
      p.body.rotation.x = -tk.recoil * 0.04;
      tk.hitFlash = Math.max(0, tk.hitFlash - dt * 5);
      // Tanks carrying a power-up blink red; the heavy one loses plates.
      const blink = carrier && Math.sin(this.time * 12) > 0 ? 0.7 : 0;
      p.paint.userData.flash.value = Math.max(tk.hitFlash, 0) * 1.2;
      p.paint.emissive.set(blink ? '#ff2010' : '#000000');
      p.paint.emissiveIntensity = blink;
      if (p.plates.length) p.plates.forEach((pl, i) => { pl.visible = hp > i + 1; });
      if (p.key) p.key.rotation.z = this.time * (moving ? 8 : 1.5);
      if (p.beacon) p.beacon.material.emissiveIntensity = 0.6 + 2.6 * (0.5 + 0.5 * Math.sin(this.time * 10 + id));
      if (p.dish) p.dish.rotation.y = this.time * 3;
      if (p.ring) p.ring.material.emissiveIntensity = 1.6 + Math.sin(this.time * 6) * 0.8;
      tk.ricochet = ricochet;
      tk.x = x; tk.y = y; tk.slot = slot; tk.team = team;
      // Frozen enemies are tinted icy blue.
      if (s.freeze > 0 && team === 9) { p.paint.emissive.set('#4aa8ff'); p.paint.emissiveIntensity = 0.35 + 0.15 * Math.sin(this.time * 4); }
    }
    for (const [id, tk] of this.tanks) {
      if (seen.has(id)) continue;
      this.scene.remove(tk.group);
      tk.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); } });
      this.tanks.delete(id);
    }
  }

  syncShells(s, dt) {
    const seen = new Set();
    for (const b of s.bullets) {
      const [id, x, y, dir, rocket, team] = b;
      seen.add(id);
      let m = this.shells.get(id);
      const color = team === 8 ? this.theme.shot[2] : team === 9 ? this.theme.shot[1] : rocket ? this.theme.shot[1] : this.theme.shot[0];
      if (!m) {
        const g = new THREE.Group();
        const core = new THREE.Mesh(new THREE.CapsuleGeometry(rocket ? 0.12 : 0.09, rocket ? 0.36 : 0.22, 4, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#333', emissive: color, emissiveIntensity: 3.2 }));
        g.add(core);
        g.position.y = 0.75;
        this.scene.add(g);
        m = { g, rocket, color: col(color) };
        this.shells.set(id, m);
      }
      m.g.position.set(wx(x), 0.75, wx(y));
      m.g.rotation.y = -dir * Math.PI / 2;
      // A short glowing trail; rockets leave smoke.
      this.fire.add({ p: [m.g.position.x, 0.75, m.g.position.z], v: [0, 0, 0], c0: m.color, a: 0.8, size: rocket ? 0.4 : 0.26, size1: 0.02, life: 0.16, tile: TILE_GLOW });
      if (rocket) this.smoke.add({ p: [m.g.position.x, 0.75, m.g.position.z], v: [rand(-0.2, 0.2), 0.3, rand(-0.2, 0.2)], c0: col('#8a8480'), a: 0.4, size: 0.25, size1: 0.9, life: 0.7, tile: TILE_SMOKE });
    }
    for (const [id, m] of this.shells) {
      if (seen.has(id)) continue;
      this.scene.remove(m.g);
      this.shells.delete(id);
    }
    void dt;
  }

  syncPowerups(s) {
    const seen = new Set();
    for (const p of s.powerups) {
      const [id, type, x, y, left] = p;
      seen.add(id);
      let m = this.pups.get(id);
      if (!m) {
        const g = new THREE.Group();
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTex(POWER_ICON[type] || '?', POWER_COL[type] || '#fff'), depthWrite: false }));
        sprite.scale.set(1.5, 1.5, 1);
        g.add(sprite);
        const glow = new THREE.Mesh(this.discGeo, shockMaterial(POWER_COL[type] || '#fff'));
        glow.scale.setScalar(1.1);
        glow.material.uniforms.uProg.value = 0.85;
        glow.position.y = -0.9;
        g.add(glow);
        this.scene.add(g);
        m = { g, sprite, glow };
        this.pups.set(id, m);
      }
      m.g.position.set(wx(x + 1), 1.2 + Math.sin(this.time * 3 + id) * 0.18, wx(y + 1));
      m.glow.position.y = -m.g.position.y + 0.05;
      m.glow.material.uniforms.uAlpha.value = 0.6 + 0.4 * Math.sin(this.time * 5);
      m.g.visible = left > 4 || Math.sin(this.time * 14) > -0.2;
    }
    for (const [id, m] of this.pups) {
      if (seen.has(id)) continue;
      this.scene.remove(m.g);
      this.pups.delete(id);
    }
  }

  toScreen(x, y, h = 0) {
    const v = V(x, h, y).project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.canvas.clientWidth, (-v.y * 0.5 + 0.5) * this.canvas.clientHeight];
  }

  updateLabels(s, dt) {
    const want = new Set();
    if (s) {
      for (const t of s.tanks) {
        const slot = t[11];
        if (slot < 0 || t[9]) continue;
        const id = t[0];
        want.add(id);
        let el = this.nameTags.get(id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'tag-name';
          this.labels.appendChild(el);
          this.nameTags.set(id, el);
        }
        const name = (s.names && s.names[slot]) || `P${slot + 1}`;
        if (el.textContent !== name) el.textContent = name;
        el.style.borderColor = this.theme.players[slot];
        const tk = this.tanks.get(id);
        if (!tk) continue;
        const [sx, sy] = this.toScreen(tk.group.position.x, tk.group.position.z - 0.9, 1.6);
        el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      }
    }
    for (const [id, el] of this.nameTags) if (!want.has(id)) { el.remove(); this.nameTags.delete(id); }
    for (const f of this.floaters) {
      f.t += dt;
      const [sx, sy] = this.toScreen(f.x, f.z, 1.5 + f.t * 1.4);
      f.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
      f.el.style.opacity = String(Math.max(0, 1 - f.t / 1.3));
      if (f.t > 1.3) f.el.remove();
    }
    this.floaters = this.floaters.filter((f) => f.t <= 1.3);
  }
}

// Water: deep colour with moving ripples and glints, using the block's world position.
function waterMaterial([deep, mid, glint]) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uDeep: { value: col(deep) }, uMid: { value: col(mid) }, uGlint: { value: col(glint) } },
    vertexShader: `
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uDeep; uniform vec3 uMid; uniform vec3 uGlint; varying vec3 vW;
      void main() {
        vec2 p = vW.xz;
        float a = sin(p.x * 2.1 + uTime * 1.3) + sin(p.y * 2.7 - uTime * 1.1) + sin((p.x + p.y) * 1.5 + uTime * 0.7);
        float b = sin(p.x * 5.3 - uTime * 2.2 + sin(p.y * 3.0)) * sin(p.y * 4.7 + uTime * 1.7);
        vec3 c = mix(uDeep, uMid, 0.45 + 0.18 * a);
        c += uGlint * smoothstep(0.72, 0.98, b) * 0.6;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}
void TILE_GLOW;
