// Warlock 3D view (three.js): the lava, the stone platform, the warlocks,
// their spells and all visual effects. It only draws; the rules live in
// shared/warlock.js and the window logic in warlock.js.
import * as THREE from './vendor/three/three.module.min.js';
import { EffectComposer } from './vendor/three/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/postprocessing/OutputPass.js';

const { TILE, RADIUS, COLORS, SPELLS } = window.Warlock;
const MODEL_SCALE = 1.9;
const PITCH = 0.98; // camera angle above the ground (radians, ~56°)
const FOV = 40;
const FOLLOW_DIST = 2050;
const BALL_Y = 80; // height of flying spells
const rand = (a, b) => a + Math.random() * (b - a);
const col = (hex) => new THREE.Color(hex);

// -------------------------------------------------------------- textures
function stoneTexture(seed) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const base = ['#6e645b', '#675b52', '#73685d', '#5f574f'][seed % 4];
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  // Large soft stains so neighbouring tiles do not look identical.
  for (let i = 0; i < 9; i++) {
    const grd = g.createRadialGradient(rnd() * 256, rnd() * 256, 0, rnd() * 256, rnd() * 256, 60 + rnd() * 100);
    grd.addColorStop(0, `rgba(${rnd() < 0.5 ? '30,22,16' : '140,125,110'},${0.12 + rnd() * 0.12})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
  }
  for (let i = 0; i < 1400; i++) {
    const v = 70 + rnd() * 90;
    g.fillStyle = `rgba(${v},${v * 0.9},${v * 0.8},${0.08 + rnd() * 0.18})`;
    const r = 1 + rnd() * 9;
    g.beginPath(); g.arc(rnd() * 256, rnd() * 256, r, 0, 7); g.fill();
  }
  // Carved border and cracks.
  g.strokeStyle = 'rgba(25,18,14,.55)';
  g.lineWidth = 7;
  g.strokeRect(4, 4, 248, 248);
  g.strokeStyle = 'rgba(255,240,220,.12)';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(9, 247); g.lineTo(9, 9); g.lineTo(247, 9); g.stroke();
  g.strokeStyle = 'rgba(20,14,10,.6)';
  g.lineWidth = 2;
  for (let k = 0; k < 3; k++) {
    g.beginPath();
    let x = rnd() * 256;
    let y = rnd() * 256;
    g.moveTo(x, y);
    for (let j = 0; j < 5; j++) { x += (rnd() - 0.5) * 70; y += (rnd() - 0.5) * 70; g.lineTo(x, y); }
    g.stroke();
  }
  // Worn chips at the corners.
  g.fillStyle = 'rgba(20,14,10,.45)';
  for (let i = 0; i < 4; i++) {
    const cx = i % 2 ? 248 : 8;
    const cy = i < 2 ? 8 : 248;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + (i % 2 ? -1 : 1) * rnd() * 30, cy); g.lineTo(cx, cy + (i < 2 ? 1 : -1) * rnd() * 30); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function softDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,.8)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function spiralTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.translate(128, 128);
  for (let arm = 0; arm < 4; arm++) {
    for (let i = 0; i < 120; i++) {
      const f = i / 120;
      const a = arm * Math.PI / 2 + f * 5;
      const r = 20 + f * 108;
      g.fillStyle = `rgba(200,150,255,${0.5 * (1 - f)})`;
      g.beginPath(); g.arc(Math.cos(a) * r, Math.sin(a) * r, 10 * (1 - f) + 2, 0, 7); g.fill();
    }
  }
  return new THREE.CanvasTexture(c);
}

// -------------------------------------------------------------- lava shader
const NOISE = `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return v;
  }`;

function lavaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uEdge: { value: 2000 } },
    vertexShader: `
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime; uniform float uEdge; varying vec3 vW;
      ${NOISE}
      void main() {
        vec2 p = vW.xz * 0.0011;
        float t = uTime * 0.045;
        vec2 q = vec2(fbm(p + vec2(t, 0.3 * t)), fbm(p + vec2(5.2, 1.3) - t));
        float n = fbm(p + 2.2 * q + vec2(0.4 * t, -0.3 * t));
        float r = 1.0 - abs(fbm(p * 2.6 + 1.5 * q - t * 0.6) * 2.0 - 1.0);
        r = pow(r, 7.0);
        vec3 crust = vec3(0.025, 0.006, 0.004);
        vec3 red = vec3(0.32, 0.035, 0.006);
        vec3 orange = vec3(1.1, 0.26, 0.02);
        vec3 c = mix(crust, red, smoothstep(0.42, 0.66, n));
        c = mix(c, orange, smoothstep(0.64, 0.86, n));
        c += vec3(1.6, 0.7, 0.12) * r * smoothstep(0.45, 0.7, n);
        // Hotter right next to the stone.
        float d = length(vW.xz);
        c += vec3(0.9, 0.22, 0.03) * smoothstep(320.0, 0.0, abs(d - uEdge)) * 0.5;
        c *= 0.85 + 0.15 * sin(uTime * 1.3 + n * 6.0);
        // Darker far away.
        c *= mix(1.0, 0.35, smoothstep(2500.0, 9000.0, d));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

function bubbleMaterial(color, power = 2.2) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: col(color) }, uAlpha: { value: 1 }, uTime: { value: 0 } },
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
      uniform vec3 uColor; uniform float uAlpha; uniform float uTime;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        float f = pow(1.0 - abs(dot(vN, vV)), ${power.toFixed(1)});
        float bands = 0.75 + 0.25 * sin(vP.y * 0.12 + uTime * 6.0);
        gl_FragColor = vec4(uColor * (0.15 + 1.6 * f) * bands, uAlpha);
      }`,
  });
}

// -------------------------------------------------------------- particles
// One additive (fire, sparks, magic) and one normal (smoke, rock) system.
class Particles {
  constructor(scene, max, additive, tex) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.colr = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colr, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, uScale: { value: 800 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `
        attribute float size; attribute float alpha; varying vec3 vC; varying float vA; uniform float uScale;
        void main() {
          vC = color; vA = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTex; varying vec3 vC; varying float vA;
        void main() { vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vC, vA * t.a); }`,
      vertexColors: true,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }

  add(x, y, z, vx, vy, vz, color, size, life, { grav = 0, drag = 0.9, grow = 0, alpha = 1 } = {}) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.colr.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.size0[i] = size;
    this.alpha[i] = alpha;
    this.alpha0[i] = alpha;
    this.life[i] = life;
    this.age[i] = 0;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.grow[i] = grow;
  }

  update(dt) {
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const age = this.age[i] + dt;
      if (age >= this.life[i]) continue;
      if (j !== i) {
        this.pos.copyWithin(j * 3, i * 3, i * 3 + 3);
        this.vel.copyWithin(j * 3, i * 3, i * 3 + 3);
        this.colr.copyWithin(j * 3, i * 3, i * 3 + 3);
        this.size0[j] = this.size0[i];
        this.life[j] = this.life[i];
        this.grav[j] = this.grav[i];
        this.drag[j] = this.drag[i];
        this.grow[j] = this.grow[i];
        this.alpha0[j] = this.alpha0[i];
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
      this.size[j] = this.size0[j] * (1 + this.grow[j] * k) * (k > 0.7 ? 0.3 + (1 - k) / 0.3 * 0.7 : 1);
      this.alpha[j] = this.alpha0[j] * (1 - k * k);
      j++;
    }
    this.n = j;
    this.geo.setDrawRange(0, j);
    for (const a of ['position', 'color', 'size', 'alpha']) this.geo.attributes[a].needsUpdate = true;
  }
}

// -------------------------------------------------------------- the view
export class View {
  constructor(canvas, labels) {
    this.canvas = canvas;
    this.labels = labels;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer = r;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.scene.background = col('#140402');
    this.scene.fog = new THREE.Fog(0x1c0603, 4200, 11000);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 20, 30000);
    this.target = new THREE.Vector3();
    this.dist = FOLLOW_DIST;
    this.yaw = 0;
    this.time = 0;
    this.shakeAmp = 0;
    this.shakeT = 0;

    // Lights: warm sun, red glow from below, a few lights carried by spells.
    this.scene.add(new THREE.HemisphereLight(0xffd6b0, 0x7a1a04, 1.1));
    const sun = new THREE.DirectionalLight(0xffe0c0, 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 2;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    this.lights = [];
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xff8a30, 0, 800, 1.2);
      this.scene.add(l);
      this.lights.push(l);
    }

    // Lava.
    this.lavaMat = lavaMaterial();
    const lava = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000, 1, 1), this.lavaMat);
    lava.rotation.x = -Math.PI / 2;
    lava.position.y = -36;
    this.scene.add(lava);

    // Rocks sticking out of the lava far away.
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x2a1d17, roughness: 1, flatShading: true });
    for (let i = 0; i < 46; i++) {
      const a = rand(0, Math.PI * 2);
      const d = rand(3300, 8000);
      const g = new THREE.DodecahedronGeometry(rand(80, 340), 0);
      const m = new THREE.Mesh(g, rockMat);
      m.position.set(Math.cos(a) * d, rand(-80, 10), Math.sin(a) * d);
      m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
      m.scale.y = rand(0.5, 1.6);
      this.scene.add(m);
    }

    // Stone tiles (instanced). The outer ring that sinks next is separate so it can glow.
    this.tileGeo = new THREE.BoxGeometry(TILE - 7, 150, TILE - 7);
    this.tileGeo.translate(0, -75, 0);
    this.tileTex = [0, 1, 2, 3].map(stoneTexture);
    this.tileMats = this.tileTex.map((tex) => new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 2.5, roughness: 0.92, metalness: 0.02 }));
    this.edgeMats = this.tileTex.map((tex) => new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 2.5, roughness: 0.92, emissive: new THREE.Color(0xff3a08), emissiveIntensity: 0 }));
    this.tileMeshes = [];
    this.builtLayer = -1;
    this.sinking = [];

    // Shared bits.
    this.dot = softDot();
    this.fire = new Particles(this.scene, 5000, true, this.dot);
    this.smoke = new Particles(this.scene, 1800, false, this.dot);
    this.ringGeo = new THREE.RingGeometry(0.86, 1, 72);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.discGeo = new THREE.CircleGeometry(1, 64);
    this.discGeo.rotateX(-Math.PI / 2);
    this.sphereGeo = new THREE.SphereGeometry(1, 24, 16);
    this.rings = [];
    this.bolts = [];
    this.floaters = [];
    this.pawns = new Map();
    this.balls = new Map();
    this.spiral = spiralTexture();

    this.moveMark = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0x5dff7a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.moveMark.visible = false;
    this.scene.add(this.moveMark);
    this.moveAt = -1;

    // Bloom makes fire, lava and magic glow.
    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.5, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.quality = 2;
    this.perf = { t: 0, n: 0, wait: 3 };
    this.ray = new THREE.Raycaster();
    this.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.resize();
  }

  // Slow PC (no graphics card, old laptop)? Step down: first shadows and
  // glow go, then the resolution drops. Never steps back up mid-game.
  setQuality(q) {
    this.quality = q;
    this.sun.castShadow = q >= 2;
    this.renderer.setPixelRatio(q >= 2 ? Math.min(window.devicePixelRatio || 1, 1.5) : q === 1 ? 1 : 0.6);
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
    if (fps < 28 && this.quality > 0) { this.setQuality(this.quality - 1); pf.wait = 1.5; }
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fire.mat.uniforms.uScale.value = h * 0.9;
    this.smoke.mat.uniforms.uScale.value = h * 0.9;
  }

  // Screen point → arena coordinates.
  pick(cx, cy) {
    const v = new THREE.Vector2((cx / this.w) * 2 - 1, -(cy / this.h) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    const hit = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.ground, hit)) return { x: this.target.x, y: this.target.z };
    return { x: hit.x, y: hit.z };
  }

  toScreen(x, y) {
    const v = new THREE.Vector3(x, 0, y).project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.w, (-v.y * 0.5 + 0.5) * this.h];
  }

  showMove(x, y) {
    this.moveMark.position.set(x, 3, y);
    this.moveAt = this.time;
    this.moveMark.visible = true;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this.fire.add(x, 6, y, Math.cos(a) * 120, 40, Math.sin(a) * 120, col('#6dff86'), 22, 0.35);
    }
  }

  shake(amp, sec) { this.shakeAmp = Math.max(this.shakeAmp, amp); this.shakeT = Math.max(this.shakeT, sec); }

  // ------------------------------------------------------------ platform
  tilesFor(layer) {
    const out = [];
    const n = Math.ceil((layer * 100) / TILE) + 1;
    for (let gx = -n; gx <= n; gx++) {
      for (let gy = -n; gy <= n; gy++) {
        const d = Math.hypot(gx * TILE, gy * TILE);
        if (d <= layer * 100) out.push({ gx, gy, edge: d > (layer - 1) * 100, v: (((gx * 7 + gy * 13 + gx * gy) % 4) + 4) % 4 });
      }
    }
    return out;
  }

  buildTiles(layer) {
    for (const m of this.tileMeshes) { this.scene.remove(m); m.dispose(); }
    this.tileMeshes = [];
    const tiles = this.tilesFor(layer);
    const m4 = new THREE.Matrix4();
    const c = new THREE.Color();
    for (const edge of [false, true]) {
      for (let v = 0; v < 4; v++) {
        const list = tiles.filter((t) => t.edge === edge && t.v === v);
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(this.tileGeo, edge ? this.edgeMats[v] : this.tileMats[v], list.length);
        list.forEach((t, i) => {
          const h = ((t.gx * 31 + t.gy * 17) % 5) * 1.6;
          m4.makeRotationY(((t.gx * 3 + t.gy * 5) % 4) * (Math.PI / 2));
          m4.setPosition(t.gx * TILE, h - 4, t.gy * TILE);
          mesh.setMatrixAt(i, m4);
          const k = 0.72 + ((((t.gx * 13 + t.gy * 7 + t.gx * t.gy * 3) % 9) + 9) % 9) * 0.04;
          mesh.setColorAt(i, c.setRGB(k, k * 0.95, k * 0.9));
        });
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        this.scene.add(mesh);
        this.tileMeshes.push(mesh);
      }
    }
    this.builtLayer = layer;
    this.lavaMat.uniforms.uEdge.value = layer * 100 + TILE * 0.5;
  }

  // The ring that just sank: tiles glow, tilt and drop into the lava.
  sink(oldLayer, newLayer) {
    if (oldLayer <= newLayer) return;
    const now = this.tilesFor(newLayer);
    const keep = new Set(now.map((t) => `${t.gx},${t.gy}`));
    for (const t of this.tilesFor(oldLayer)) {
      if (keep.has(`${t.gx},${t.gy}`)) continue;
      const mat = this.edgeMats[t.v].clone();
      mat.emissiveIntensity = 1.4;
      const m = new THREE.Mesh(this.tileGeo, mat);
      m.position.set(t.gx * TILE, -4, t.gy * TILE);
      m.receiveShadow = true;
      this.scene.add(m);
      this.sinking.push({ m, t0: this.time, rx: rand(-0.25, 0.25), rz: rand(-0.25, 0.25), delay: rand(0, 0.35) });
      for (let i = 0; i < 6; i++) {
        this.fire.add(t.gx * TILE + rand(-90, 90), 10, t.gy * TILE + rand(-90, 90), rand(-40, 40), rand(120, 300), rand(-40, 40), col('#ff8a2a'), rand(30, 60), rand(0.6, 1.2), { grav: 200 });
        this.smoke.add(t.gx * TILE + rand(-80, 80), 20, t.gy * TILE + rand(-80, 80), rand(-20, 20), rand(60, 140), rand(-20, 20), col('#2a1610'), rand(80, 140), rand(1.2, 2), { grow: 1.5, alpha: 0.55 });
      }
    }
  }

  // ------------------------------------------------------------ warlocks
  makeWarlock(color) {
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);
    const main = col(color);
    const dark = main.clone().multiplyScalar(0.35);
    const robeMat = new THREE.MeshStandardMaterial({ color: main, roughness: 0.75, flatShading: true });
    const darkMat = new THREE.MeshStandardMaterial({ color: dark, roughness: 0.85, flatShading: true });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.4, metalness: 0.7, flatShading: true });
    const skin = new THREE.MeshStandardMaterial({ color: 0x0a0605, roughness: 1 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.5, 2.2, 0.7) });
    const pts = [[0, 0], [33, 0], [31, 8], [26, 30], [21, 52], [19, 64], [23, 70], [17, 78], [8, 82], [0, 83]].map(([x, y]) => new THREE.Vector2(x, y));
    const robe = new THREE.Mesh(new THREE.LatheGeometry(pts, 9), robeMat);
    robe.castShadow = true;
    body.add(robe);
    // Robe hem and belt.
    const hem = new THREE.Mesh(new THREE.TorusGeometry(31, 3, 5, 12), trimMat);
    hem.rotation.x = Math.PI / 2;
    hem.position.y = 6;
    body.add(hem);
    const belt = new THREE.Mesh(new THREE.TorusGeometry(22, 3.2, 5, 12), trimMat);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 50;
    body.add(belt);
    // Shoulder mantle.
    const mantle = new THREE.Mesh(new THREE.ConeGeometry(30, 22, 9, 1, true), darkMat);
    mantle.position.y = 74;
    mantle.castShadow = true;
    body.add(mantle);
    // Hood with a pointed tip falling back, a dark face and glowing eyes.
    const head = new THREE.Group();
    head.position.y = 90;
    body.add(head);
    const hood = new THREE.Mesh(new THREE.SphereGeometry(16, 10, 8), darkMat);
    hood.scale.set(1, 1.08, 1);
    hood.castShadow = true;
    head.add(hood);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(11, 34, 8), darkMat);
    tip.position.set(-12, 12, 0);
    tip.rotation.z = 1.05;
    head.add(tip);
    const face = new THREE.Mesh(new THREE.SphereGeometry(11.5, 10, 8), skin);
    face.position.set(7.5, -2, 0);
    head.add(face);
    for (const z of [-4.5, 4.5]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(2.3, 6, 6), eyeMat);
      eye.position.set(18, -1, z);
      head.add(eye);
    }
    // Sleeves.
    const sleeveGeo = new THREE.CylinderGeometry(6, 9, 34, 7);
    const armL = new THREE.Mesh(sleeveGeo, robeMat);
    armL.position.set(8, 62, -22);
    armL.rotation.set(-0.3, 0, -0.9);
    armL.castShadow = true;
    body.add(armL);
    const armR = new THREE.Mesh(sleeveGeo, robeMat);
    armR.position.set(10, 62, 22);
    armR.rotation.set(0.3, 0, -1.0);
    armR.castShadow = true;
    body.add(armR);
    // Staff with a glowing orb, held in the right hand.
    const staff = new THREE.Group();
    staff.position.set(24, 52, 26);
    body.add(staff);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.8, 150, 6), new THREE.MeshStandardMaterial({ color: 0x4a2c16, roughness: 0.8, flatShading: true }));
    pole.position.y = 20;
    pole.castShadow = true;
    staff.add(pole);
    const claw = new THREE.Mesh(new THREE.TorusGeometry(9, 1.8, 5, 10, Math.PI * 1.4), trimMat);
    claw.position.y = 96;
    claw.rotation.z = Math.PI * 1.3;
    staff.add(claw);
    const orbMat = new THREE.MeshBasicMaterial({ color: main.clone().lerp(new THREE.Color(1, 0.6, 0.2), 0.5).multiplyScalar(2.2) });
    const orb = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 10), orbMat);
    orb.position.y = 100;
    staff.add(orb);
    // Selection circle on the ground in the player's colour.
    const circle = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: main.clone().multiplyScalar(1.6), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
    circle.scale.setScalar(RADIUS * 1.35 / MODEL_SCALE);
    circle.position.y = 2;
    g.add(circle);
    g.scale.setScalar(MODEL_SCALE);
    this.scene.add(g);
    // Bubbles: spell shield (blue), spawn shield (gold), rush aura (red).
    const shield = new THREE.Mesh(this.sphereGeo, bubbleMaterial('#7fd2ff'));
    shield.visible = false;
    this.scene.add(shield);
    const spawn = new THREE.Mesh(this.sphereGeo, bubbleMaterial('#ffd77a', 3.0));
    spawn.visible = false;
    this.scene.add(spawn);
    const aura = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xff4a1a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    aura.visible = false;
    this.scene.add(aura);
    const mats = [robeMat, darkMat, trimMat, skin];
    for (const m of mats) m.userData.baseEmissive = m.emissive.clone();
    // HTML label: name, health, knockback.
    const label = document.createElement('div');
    label.className = 'lbl';
    label.innerHTML = '<b></b><div class="bar"><i></i></div><small></small>';
    this.labels.append(label);
    return { g, body, head, staff, orb, orbMat, circle, shield, spawn, aura, mats, label, x: 0, y: 0, f: 0, seen: false, hitT: -9, castT: -9, walk: 0 };
  }

  hit(id) { const w = this.pawns.get(id); if (w) w.hitT = this.time; }

  updatePawns(s, prev, k, me, names, dt) {
    const alive = new Set();
    s.p.forEach((p, idx) => {
      alive.add(p.id);
      let w = this.pawns.get(p.id);
      if (!w) { w = this.makeWarlock(COLORS[idx % 10]); this.pawns.set(p.id, w); }
      const invisible = p.m.includes('windwalk');
      const show = !p.d && !p.l && (!invisible || p.id === me);
      w.g.visible = show;
      w.label.style.display = show ? '' : 'none';
      w.shield.visible = show && p.sh > 0;
      w.spawn.visible = show && p.m.includes('spawnShield');
      w.aura.visible = show && p.m.includes('rush');
      if (!show) { w.seen = false; return; }
      const q = prev.p.find((o) => o.id === p.id) || p;
      const tx = q.d ? p.x : q.x + (p.x - q.x) * k;
      const ty = q.d ? p.y : q.y + (p.y - q.y) * k;
      if (!w.seen) { w.x = tx; w.y = ty; w.f = p.f; w.seen = true; }
      const speed = Math.hypot(tx - w.x, ty - w.y) / Math.max(dt, 0.001);
      w.x = tx;
      w.y = ty;
      // Turn smoothly to face.
      let da = p.f - w.f;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      w.f += da * Math.min(1, dt * 14);
      const moving = speed > 40;
      w.walk += dt * (moving ? 11 : 2.5);
      const onLava = this.onLava(tx, ty, s.layer);
      const sinkY = onLava ? -14 : 0;
      w.g.position.set(tx, sinkY + (moving ? Math.abs(Math.sin(w.walk)) * 5 : Math.sin(w.walk) * 1.5), ty);
      w.g.rotation.y = -w.f;
      w.body.rotation.z = moving ? -0.12 : 0; // lean forward (model faces +X)
      w.body.rotation.x = moving ? Math.sin(w.walk) * 0.05 : 0;
      // Casting: raise the staff, brighten the orb.
      if (p.cast) w.castT = this.time;
      const c = Math.max(0, 1 - (this.time - w.castT) / 0.35);
      w.staff.rotation.z = -0.9 * c;
      w.staff.position.y = 52 + 14 * c;
      w.orb.scale.setScalar(1 + c * 0.8 + Math.sin(this.time * 6) * 0.08);
      // Hit flash, lava burn glow, windwalk transparency.
      const hf = Math.max(0, 1 - (this.time - w.hitT) / 0.18);
      for (const m of w.mats) {
        m.emissive.setRGB(hf * 0.55 + (onLava ? 0.35 : 0), hf * 0.45 + (onLava ? 0.08 : 0), hf * 0.4);
        m.transparent = invisible;
        m.opacity = invisible ? 0.35 : 1;
      }
      w.circle.material.opacity = p.id === me ? 1 : 0.6;
      if (moving && Math.random() < dt * 20) this.smoke.add(tx + rand(-15, 15), 6, ty + rand(-15, 15), rand(-20, 20), rand(20, 50), rand(-20, 20), col('#3a2a22'), rand(18, 30), 0.6, { grow: 1, alpha: 0.4 });
      if (onLava && Math.random() < dt * 30) this.fire.add(tx + rand(-25, 25), 5, ty + rand(-25, 25), rand(-30, 30), rand(100, 220), rand(-30, 30), col(Math.random() < 0.5 ? '#ff7a1a' : '#ffcc55'), rand(18, 34), rand(0.4, 0.8));
      if (show && p.sh > 0) {
        w.shield.position.set(tx, 40, ty);
        w.shield.scale.set(p.sh, p.sh * 0.75, p.sh);
        w.shield.material.uniforms.uTime.value = this.time;
      }
      if (w.spawn.visible) {
        w.spawn.position.set(tx, 50, ty);
        w.spawn.scale.setScalar(80);
        w.spawn.material.uniforms.uTime.value = this.time;
        w.spawn.material.uniforms.uAlpha.value = 0.6;
      }
      if (w.aura.visible) {
        w.aura.position.set(tx, 4, ty);
        w.aura.scale.setScalar(70 + Math.sin(this.time * 12) * 8);
        if (Math.random() < dt * 40) this.fire.add(tx + rand(-30, 30), 10, ty + rand(-30, 30), 0, rand(80, 160), 0, col('#ff4a1a'), rand(14, 24), 0.5);
      }
      // Label.
      const v = new THREE.Vector3(tx, sinkY + 128 * MODEL_SCALE, ty).project(this.camera);
      const lx = (v.x * 0.5 + 0.5) * this.w;
      const ly = (-v.y * 0.5 + 0.5) * this.h;
      w.label.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px) translate(-50%, -100%)`;
      const f = Math.max(0, p.hp / p.mx);
      const key = `${names[p.id] || ''}|${p.hp}|${p.dp}|${p.id === me}`;
      if (w.label.dataset.k !== key) {
        w.label.dataset.k = key;
        w.label.firstChild.textContent = names[p.id] || '';
        w.label.classList.toggle('me', p.id === me);
        const bar = w.label.querySelector('i');
        bar.style.width = `${f * 100}%`;
        bar.style.background = f > 0.5 ? '#5fd46f' : f > 0.25 ? '#f2c230' : '#e8443a';
        w.label.lastChild.textContent = p.dp > 0 ? `+${Math.round(p.dp / 10)}%` : '';
      }
    });
    for (const [id, w] of this.pawns) {
      if (alive.has(id)) continue;
      for (const o of [w.g, w.shield, w.spawn, w.aura]) this.scene.remove(o);
      w.label.remove();
      this.pawns.delete(id);
    }
  }

  onLava(x, y, layer) {
    const gx = Math.floor(x / TILE + 0.5);
    const gy = Math.floor(y / TILE + 0.5);
    return Math.hypot(gx * TILE, gy * TILE) > layer * 100;
  }

  pawnPos(s, id) {
    const w = this.pawns.get(id);
    if (w && w.seen) return { x: w.x, y: w.y };
    const p = s.p.find((q) => q.id === id);
    return p ? { x: p.x, y: p.y } : null;
  }

  // ------------------------------------------------------------ spells in flight
  makeBall(kind) {
    const styles = {
      fireball: ['#ffe6a0', '#ff7a1a', '#ff3d0a'],
      cluster: ['#fff3b0', '#ffc23a', '#ff8a10'],
      homing: ['#f2d9ff', '#b066ff', '#6a1ad0'],
      bouncer: ['#e2ffd0', '#6cff5a', '#1da81a'],
      swap: ['#e0faff', '#5ad2ff', '#1a7cd8'],
      link: ['#e8f4ff', '#9ec9ff', '#3a6ab0'],
      boomerang: ['#ffffff', '#d8e2f0', '#8c9aac'],
    };
    const st = styles[kind] || styles.fireball;
    const g = new THREE.Group();
    const o = { kind, g, st: st.map(col) };
    if (kind === 'boomerang') {
      const m = new THREE.Mesh(new THREE.TorusGeometry(26, 6, 6, 16, Math.PI * 1.25), new THREE.MeshStandardMaterial({ color: 0xd8e2f0, metalness: 0.9, roughness: 0.25, emissive: 0x405060 }));
      m.rotation.x = Math.PI / 2;
      m.castShadow = true;
      g.add(m);
      o.spin = m;
    } else if (kind === 'meteor') {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(60, 1), new THREE.MeshStandardMaterial({ color: 0x3a2014, roughness: 1, flatShading: true, emissive: 0xff4a10, emissiveIntensity: 0.9 }));
      rock.castShadow = true;
      g.add(rock);
      o.rock = rock;
      const mark = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      const fill = new THREE.Mesh(this.discGeo, new THREE.MeshBasicMaterial({ color: 0xff3a0a, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending }));
      const inner = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      o.mark = mark; o.fill = fill; o.inner = inner;
      this.scene.add(mark, fill, inner);
    } else if (kind === 'gravity') {
      const core = new THREE.Mesh(new THREE.SphereGeometry(34, 20, 14), new THREE.MeshBasicMaterial({ color: 0x050008 }));
      g.add(core);
      const halo = new THREE.Mesh(this.sphereGeo, bubbleMaterial('#a060ff', 1.6));
      halo.scale.setScalar(48);
      g.add(halo);
      const disk = new THREE.Mesh(new THREE.CircleGeometry(300, 48), new THREE.MeshBasicMaterial({ map: this.spiral, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xb070ff }));
      disk.rotation.x = -Math.PI / 2;
      disk.position.y = -BALL_Y + 6;
      g.add(disk);
      o.disk = disk;
    } else {
      const core = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: o.st[0].clone().multiplyScalar(2.5) }));
      g.add(core);
      o.core = core;
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: o.st[1].clone().multiplyScalar(1.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      g.add(glow);
      o.glow = glow;
      if (kind === 'swap' || kind === 'link') {
        const rg = new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 6, 24), new THREE.MeshBasicMaterial({ color: o.st[1].clone().multiplyScalar(2) }));
        g.add(rg);
        o.spin = rg;
      }
    }
    this.scene.add(g);
    return o;
  }

  chain(o, x1, y1, x2, y2) {
    if (!o.chainMesh) {
      o.chainMesh = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 1, 6, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 1.1, 2.2), transparent: true, opacity: 0.9 }));
      this.scene.add(o.chainMesh);
    }
    const a = new THREE.Vector3(x1, 55, y1);
    const b = new THREE.Vector3(x2, 55, y2);
    const len = a.distanceTo(b);
    o.chainMesh.position.copy(a).add(b).multiplyScalar(0.5);
    o.chainMesh.scale.set(1 + 0.3 * Math.sin(this.time * 30), Math.max(1, len), 1);
    o.chainMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    if (Math.random() < 0.6) {
      const f = Math.random();
      this.fire.add(x1 + (x2 - x1) * f, 55, y1 + (y2 - y1) * f, rand(-30, 30), rand(-30, 30), rand(-30, 30), col('#9ec9ff'), 16, 0.3);
    }
  }

  removeBall(o) {
    const shared = new Set([this.ringGeo, this.discGeo, this.sphereGeo]);
    for (const x of [o.g, o.mark, o.fill, o.inner, o.chainMesh]) {
      if (!x) continue;
      this.scene.remove(x);
      x.traverse((m) => {
        if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose();
        if (m.material) m.material.dispose();
      });
    }
  }

  updateBalls(s, since, dt) {
    const live = new Set();
    let li = 0;
    for (const b of s.b) {
      const [kind, bx, by, vx, vy, r, owner, extra, id] = b;
      const key = id !== undefined ? id : `${kind}${bx}${by}`;
      live.add(key);
      let o = this.balls.get(key);
      if (!o) { o = this.makeBall(kind); this.balls.set(key, o); }
      const x = bx + vx * since;
      const y = by + vy * since;
      if (kind === 'linked') {
        o.g.visible = false;
        const a = this.pawnPos(s, owner);
        const t = this.pawnPos(s, extra);
        if (a && t) this.chain(o, a.x, a.y, t.x, t.y);
        continue;
      }
      if (kind === 'meteor') {
        const prog = Math.min(1, 1 - Math.max(0, extra - since) / SPELLS.meteor.delay);
        const h = (1 - prog) * 2200;
        o.g.position.set(x - h * 0.45, 40 + h, y - h * 0.3);
        o.rock.rotation.x += dt * 3;
        o.rock.rotation.y += dt * 2;
        o.mark.position.set(x, 3, y);
        o.mark.scale.setScalar(r);
        o.fill.position.set(x, 2, y);
        o.fill.scale.setScalar(r);
        o.fill.material.opacity = 0.12 + 0.3 * prog;
        o.inner.position.set(x, 4, y);
        o.inner.scale.setScalar(Math.max(1, r * prog));
        for (let i = 0; i < 4; i++) this.fire.add(o.g.position.x + rand(-30, 30), o.g.position.y + rand(-30, 30), o.g.position.z + rand(-30, 30), rand(-40, 40), rand(20, 80), rand(-40, 40), col(Math.random() < 0.5 ? '#ff7a1a' : '#ffd070'), rand(40, 80), rand(0.3, 0.6));
        if (Math.random() < 0.5) this.smoke.add(o.g.position.x, o.g.position.y, o.g.position.z, 0, 40, 0, col('#1a100c'), rand(70, 120), 1.0, { grow: 1.5, alpha: 0.5 });
        this.light(li++, o.g.position.x, o.g.position.y, o.g.position.z, '#ff7a2a', 4 * prog + 1);
        continue;
      }
      o.g.position.set(x, BALL_Y, y);
      if (kind === 'gravity') {
        o.disk.rotation.z += dt * 4;
        for (let i = 0; i < 3; i++) {
          const a = rand(0, Math.PI * 2);
          const d = rand(250, 520);
          this.fire.add(x + Math.cos(a) * d, rand(8, 90), y + Math.sin(a) * d, -Math.cos(a) * d * 1.6, 0, -Math.sin(a) * d * 1.6, col(Math.random() < 0.5 ? '#a060ff' : '#e0c0ff'), rand(12, 22), 0.5, { drag: 1 });
        }
        this.light(li++, x, 80, y, '#9a50ff', 3);
        continue;
      }
      if (kind === 'boomerang') {
        o.spin.rotation.z += dt * 22;
        if (Math.random() < 0.7) this.fire.add(x, BALL_Y, y, 0, 0, 0, col('#c8d8ff'), 22, 0.25);
        continue;
      }
      if (kind === 'link') {
        const a = this.pawnPos(s, owner);
        if (a) this.chain(o, a.x, a.y, x, y);
      }
      const rr = Math.max(14, r * 0.85);
      o.core.scale.setScalar(rr * 0.55);
      o.glow.scale.setScalar(rr * 5);
      if (o.spin) { o.spin.scale.setScalar(rr * 1.2); o.spin.rotation.x += dt * 9; o.spin.rotation.y += dt * 6; }
      // Trail: fire for fireballs, sparkles for magic.
      const fiery = kind === 'fireball' || kind === 'cluster';
      const n = fiery ? 5 : 3;
      for (let i = 0; i < n; i++) {
        const c = o.st[Math.floor(Math.random() * 3)];
        this.fire.add(x + rand(-rr, rr) * 0.5, BALL_Y + rand(-rr, rr) * 0.5, y + rand(-rr, rr) * 0.5, -vx * 0.08 + rand(-40, 40), rand(10, 70), -vy * 0.08 + rand(-40, 40), c, rand(rr * 1.4, rr * 2.4), rand(0.25, 0.5), { drag: 0.9 });
      }
      if (fiery && Math.random() < 0.4) this.smoke.add(x, BALL_Y, y, rand(-20, 20), rand(30, 70), rand(-20, 20), col('#24140e'), rr * 2.5, 0.8, { grow: 1.2, alpha: 0.35 });
      this.light(li++, x, BALL_Y + 20, y, o.st[1].getHexString(), fiery ? 3.2 : 2.2);
    }
    for (const [key, o] of this.balls) {
      if (live.has(key)) continue;
      this.removeBall(o);
      this.balls.delete(key);
    }
    for (; li < this.lights.length; li++) this.lights[li].intensity = 0;
  }

  light(i, x, y, z, color, intensity) {
    const l = this.lights[i];
    if (!l) return;
    l.position.set(x, y, z);
    l.color.set(typeof color === 'string' && color[0] !== '#' ? `#${color}` : color);
    l.intensity = intensity * 150;
  }

  // ------------------------------------------------------------ one-shot effects
  ring(x, y, r, color, life = 0.5, width = 1) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: col(color).multiplyScalar(2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.position.set(x, 5, y);
    this.scene.add(m);
    this.rings.push({ m, r, t0: this.time, life, width });
  }

  burst(x, y, z, n, colors, speed = 300, life = 0.6, size = 26, opts = {}) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = rand(-0.2, 1);
      const v = speed * rand(0.3, 1.2);
      this.fire.add(x, z, y, Math.cos(a) * v * (1 - Math.abs(e) * 0.5), e * v, Math.sin(a) * v * (1 - Math.abs(e) * 0.5), col(colors[i % colors.length]), size * rand(0.6, 1.3), life * rand(0.6, 1.3), opts);
    }
  }

  smokeBurst(x, y, n, size = 90) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.smoke.add(x + rand(-30, 30), 30, y + rand(-30, 30), Math.cos(a) * rand(40, 160), rand(40, 140), Math.sin(a) * rand(40, 160), col('#2a1a12'), size * rand(0.7, 1.3), rand(1, 1.8), { grow: 1.6, alpha: 0.6 });
    }
  }

  bolt(x1, y1, x2, y2) {
    this.bolts.push({ x1, y1, x2, y2, t0: this.time, mesh: null });
    this.burst(x2, y2, 60, 14, ['#ffffff', '#9fd6ff'], 260, 0.35, 18);
  }

  // Damage numbers: hits that follow quickly on the same warlock (burning,
  // a chain, a black hole) add up into one number instead of a stream.
  damage(id, x, y, n) {
    let f = this.floaters.find((o) => o.id === id && this.time - o.t0 < 0.45);
    if (f) {
      f.n += n;
      f.x = x;
      f.y = y;
      f.t0 = Math.max(f.t0, this.time - 0.15);
    } else {
      this.pending = this.pending || {};
      n += this.pending[id] || 0;
      this.pending[id] = n < 1 ? n : 0;
      if (n < 1) return;
      f = this.floater(x, y, '');
      Object.assign(f, { id, n });
    }
    f.el.textContent = `-${Math.round(f.n)}`;
  }

  floater(x, y, text, color = '#ff5a4a') {
    const el = document.createElement('div');
    el.className = 'floater';
    el.textContent = text;
    el.style.color = color;
    this.labels.append(el);
    const f = { el, x: x + rand(-20, 20), y, t0: this.time };
    this.floaters.push(f);
    return f;
  }

  fx(e, s) {
    switch (e.e) {
      case 'cast': {
        const p = s && s.p.find((q) => q.id === e.id);
        const w = p && this.pawns.get(p.id);
        if (w) w.castT = this.time;
        if (e.k === 'shield') this.ring(e.x, e.y, 220, '#a0e6ff', 0.4);
        if (e.k === 'windwalk') { this.smokeBurst(e.x, e.y, 10, 70); this.burst(e.x, e.y, 40, 16, ['#dfe9ff', '#a9b8d6'], 160, 0.6, 18); }
        if (e.k === 'rush') this.ring(e.x, e.y, 120, '#ff5a2a', 0.4);
        if (e.k === 'thrust') this.burst(e.x, e.y, 30, 16, ['#ffffff', '#cfe0ff'], 220, 0.4, 20);
        break;
      }
      case 'boom': {
        const c = e.k === 'homing' ? ['#f0d0ff', '#b066ff', '#6a1ad0'] : e.k === 'bouncer' ? ['#e2ffd0', '#6cff5a', '#1da81a'] : e.k === 'clash' ? ['#ffffff', '#ffe8a0', '#9fd6ff'] : ['#fff2b0', '#ff8a1c', '#ff3d0a'];
        this.burst(e.x, e.y, BALL_Y, 50, c, 420, 0.55, 30);
        this.smokeBurst(e.x, e.y, 5, 70);
        this.ring(e.x, e.y, 110, c[1], 0.35);
        this.flash(e.x, e.y, c[1], 4);
        break;
      }
      case 'bolt':
        this.bolt(e.x1, e.y1, e.x2, e.y2);
        this.flash(e.x2, e.y2, '#9fd6ff', 3);
        break;
      case 'blink':
        for (const [x, y] of [[e.x1, e.y1], [e.x2, e.y2]]) {
          this.burst(x, y, 50, 40, ['#ffffff', '#b7f0ff', '#5ad2ff'], 260, 0.5, 20);
          this.pillar(x, y, '#9ee8ff');
        }
        break;
      case 'swap':
        for (const [x, y] of [[e.x1, e.y1], [e.x2, e.y2]]) { this.ring(x, y, 90, '#5ad2ff', 0.45); this.pillar(x, y, '#5ad2ff'); }
        break;
      case 'scourge':
        this.ring(e.x, e.y, e.r, '#ff3030', 0.45);
        this.ring(e.x, e.y, e.r * 0.6, '#ff8080', 0.3);
        this.burst(e.x, e.y, 30, 60, ['#ff6a6a', '#c01010', '#ffd0d0'], 520, 0.45, 26);
        this.flash(e.x, e.y, '#ff3030', 5);
        this.shake(14, 0.2);
        break;
      case 'meteor':
        this.ring(e.x, e.y, e.r * 1.2, '#ffa040', 0.6);
        this.ring(e.x, e.y, e.r * 0.7, '#ffe0a0', 0.4);
        this.burst(e.x, e.y, 20, 120, ['#ffe08a', '#ff7a1a', '#ff3a0a'], 700, 0.9, 40, { grav: 600 });
        this.smokeBurst(e.x, e.y, 22, 150);
        this.flash(e.x, e.y, '#ff8a2a', 9);
        this.shake(34, 0.4);
        break;
      case 'reflect':
        this.ring(e.x, e.y, 50, '#c8f5ff', 0.25);
        this.burst(e.x, e.y, BALL_Y, 16, ['#ffffff', '#a0e6ff'], 240, 0.3, 16);
        break;
      case 'hit':
        this.hit(e.id);
        this.damage(e.id, e.x, e.y, e.n);
        break;
      case 'burn': {
        const p = s && s.p.find((q) => q.id === e.id);
        if (p) this.burst(p.x, p.y, 10, 8, ['#ffb35c', '#ff4a10'], 120, 0.6, 22, { grav: -80 });
        break;
      }
      case 'death':
        this.burst(e.x, e.y, 40, 90, ['#ff8a1c', '#ffd27a', '#ff3a0a'], 520, 1.0, 36, { grav: 300 });
        this.smokeBurst(e.x, e.y, 18, 130);
        this.ring(e.x, e.y, 200, '#ff7a2a', 0.6);
        this.flash(e.x, e.y, '#ff6a1a', 7);
        this.shake(22, 0.3);
        break;
      case 'shrink':
        this.sink(this.builtLayer, e.layer);
        this.buildTiles(e.layer);
        this.shake(8, 0.5);
        break;
      default:
        break;
    }
  }

  // A short light flash where something exploded.
  flash(x, y, color, power) {
    this.flashes = this.flashes || [];
    this.flashes.push({ x, y, color, power, t0: this.time });
  }

  pillar(x, y, color) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(45, 45, 300, 20, 1, true), new THREE.MeshBasicMaterial({ color: col(color).multiplyScalar(1.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.position.set(x, 150, y);
    this.scene.add(m);
    this.rings.push({ m, pillar: true, t0: this.time, life: 0.45 });
  }

  updateEffects(dt) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      const k = (this.time - r.t0) / r.life;
      if (k >= 1) { this.scene.remove(r.m); r.m.material.dispose(); if (r.pillar) r.m.geometry.dispose(); this.rings.splice(i, 1); continue; }
      r.m.material.opacity = 1 - k;
      if (r.pillar) r.m.scale.set(1 - k * 0.7, 1 + k, 1 - k * 0.7);
      else r.m.scale.setScalar(Math.max(1, r.r * (0.25 + 0.75 * Math.sqrt(k))));
    }
    for (let i = this.sinking.length - 1; i >= 0; i--) {
      const sk = this.sinking[i];
      const k = (this.time - sk.t0 - sk.delay) / 1.8;
      if (k >= 1) { this.scene.remove(sk.m); sk.m.material.dispose(); this.sinking.splice(i, 1); continue; }
      if (k < 0) continue;
      sk.m.position.y = -4 - k * k * 190;
      sk.m.rotation.x = sk.rx * k;
      sk.m.rotation.z = sk.rz * k;
      sk.m.material.emissiveIntensity = 1.4 + k * 2;
    }
    // Lightning: a jagged ribbon rebuilt each frame for a moment.
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const k = (this.time - b.t0) / 0.24;
      if (b.mesh) { this.scene.remove(b.mesh); b.mesh.geometry.dispose(); }
      if (k >= 1) { if (b.mesh) b.mesh.material.dispose(); this.bolts.splice(i, 1); continue; }
      const segs = 14;
      const pos = [];
      const dx = b.x2 - b.x1;
      const dy = b.y2 - b.y1;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      let prev = null;
      for (let j = 0; j <= segs; j++) {
        const f = j / segs;
        const jit = j === 0 || j === segs ? 0 : rand(-45, 45);
        const px = b.x1 + dx * f + nx * jit;
        const py = b.y1 + dy * f + ny * jit;
        const pz = 60 + rand(-15, 15) * (j && j < segs ? 1 : 0);
        const cur = [px, pz, py];
        if (prev) {
          const wdt = 7 * (1 - k * 0.6);
          pos.push(prev[0] + nx * wdt, prev[1], prev[2] + ny * wdt, prev[0] - nx * wdt, prev[1], prev[2] - ny * wdt, cur[0] + nx * wdt, cur[1], cur[2] + ny * wdt);
          pos.push(prev[0] - nx * wdt, prev[1], prev[2] - ny * wdt, cur[0] - nx * wdt, cur[1], cur[2] - ny * wdt, cur[0] + nx * wdt, cur[1], cur[2] + ny * wdt);
        }
        prev = cur;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      if (!b.mat) b.mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.8, 4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      b.mat.opacity = 1 - k;
      b.mesh = new THREE.Mesh(geo, b.mat);
      this.scene.add(b.mesh);
      this.light(this.lights.length - 1, (b.x1 + b.x2) / 2, 120, (b.y1 + b.y2) / 2, '#9fd6ff', 6 * (1 - k));
    }
    // Explosion flashes use the last light slots.
    if (this.flashes) {
      for (let i = this.flashes.length - 1; i >= 0; i--) {
        const f = this.flashes[i];
        const k = (this.time - f.t0) / 0.3;
        if (k >= 1) { this.flashes.splice(i, 1); continue; }
      }
      const f = this.flashes[this.flashes.length - 1];
      if (f) this.light(this.lights.length - 2, f.x, 120, f.y, f.color, f.power * (1 - (this.time - f.t0) / 0.3));
    }
    // Damage numbers float up.
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      const k = (this.time - f.t0) / 0.9;
      if (k >= 1) { f.el.remove(); this.floaters.splice(i, 1); continue; }
      const v = new THREE.Vector3(f.x, 150 + k * 90, f.y).project(this.camera);
      f.el.style.transform = `translate(${((v.x * 0.5 + 0.5) * this.w).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * this.h).toFixed(1)}px) translate(-50%, -50%) scale(${1.25 - k * 0.4})`;
      f.el.style.opacity = String(1 - k * k);
    }
    // The green "move here" marker.
    const mk = (this.time - this.moveAt) / 0.5;
    this.moveMark.visible = mk >= 0 && mk < 1;
    if (this.moveMark.visible) { this.moveMark.scale.setScalar(40 * (1 - mk * 0.6)); this.moveMark.material.opacity = 1 - mk; }
    // Embers drifting up from the lava around the camera.
    for (let i = 0; i < 3; i++) {
      const x = this.target.x + rand(-2400, 2400);
      const z = this.target.z + rand(-1800, 1400);
      if (!this.onLava(x, z, this.builtLayer)) continue;
      this.fire.add(x, -20, z, rand(-20, 20), rand(60, 160), rand(-20, 20), col(Math.random() < 0.7 ? '#ff6a1a' : '#ffc050'), rand(8, 16), rand(1.2, 2.5), { drag: 0.995, grav: -10 });
    }
    this.fire.update(dt);
    this.smoke.update(dt);
  }

  // ------------------------------------------------------------ frame
  frame({ s, prev, k, since, dt, me, names, follow }) {
    this.time += dt;
    if (s.layer !== this.builtLayer) this.buildTiles(s.layer);
    // The ring that sinks next glows red in its last seconds.
    const warn = s.ph === 'fight' && s.layer > 1 && s.shrink < 3 ? (0.5 + 0.5 * Math.sin(this.time * (8 + (3 - s.shrink) * 4))) * (1 - s.shrink / 3) : 0;
    for (const m of this.edgeMats) m.emissiveIntensity = warn * 0.9;
    this.lavaMat.uniforms.uTime.value = this.time;

    this.updatePawns(s, prev, k, me, names, dt);
    this.updateBalls(s, since, dt);

    // Camera: follow your warlock like Dota, or show the whole platform.
    const mine = this.pawns.get(me);
    let tx = 0;
    let tz = 0;
    let dist;
    if (follow && mine && mine.seen) {
      tx = mine.x;
      tz = mine.y;
      dist = FOLLOW_DIST;
    } else {
      const R = (s.layer * 100) + 300;
      const fovV = (FOV * Math.PI) / 180;
      const fovH = 2 * Math.atan(Math.tan(fovV / 2) * this.camera.aspect);
      dist = Math.max((R * 1.15) / Math.tan(fovV / 2) * Math.sin(PITCH) * 0.95, R / Math.tan(fovH / 2)) * 1.05;
    }
    const a = Math.min(1, dt * 5);
    this.target.x += (tx - this.target.x) * a;
    this.target.z += (tz - this.target.z) * a;
    this.dist += (dist - this.dist) * Math.min(1, dt * 3);
    // In the lobby the camera circles slowly; in a match it faces north like Dota.
    if (s.ph === 'lobby') this.yaw += dt * 0.08;
    else this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw)) * Math.max(0, 1 - dt * 3);
    const hd = Math.cos(PITCH) * this.dist;
    const cp = new THREE.Vector3(this.target.x + Math.sin(this.yaw) * hd, Math.sin(PITCH) * this.dist, this.target.z + Math.cos(this.yaw) * hd);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      cp.x += rand(-1, 1) * this.shakeAmp;
      cp.y += rand(-1, 1) * this.shakeAmp;
    } else this.shakeAmp = 0;
    this.camera.position.copy(cp);
    this.camera.lookAt(this.target.x, 0, this.target.z);
    this.camera.updateMatrixWorld();
    // Sun and its shadow follow the view.
    const sh = Math.max(1600, this.dist * 0.9);
    this.sun.position.set(this.target.x - 900, 2200, this.target.z - 700);
    this.sun.target.position.copy(this.target);
    const sc = this.sun.shadow.camera;
    if (sc.right !== sh) { sc.left = -sh; sc.right = sh; sc.top = sh; sc.bottom = -sh; sc.near = 100; sc.far = 6000; sc.updateProjectionMatrix(); }

    this.updateEffects(dt);
    this.measure(dt);
    if (this.quality >= 1) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
