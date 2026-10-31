// Warlock 3D view (three.js): lava, the stone platform, animated warlocks,
// spells and effects. It only draws; the rules live in shared/warlock.js and
// the window logic in warlock.js.
import * as THREE from './vendor/three/three.module.min.js';
import { EffectComposer } from './vendor/three/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from './vendor/three/postprocessing/ShaderPass.js';
import { OutputPass } from './vendor/three/postprocessing/OutputPass.js';
import { GLTFLoader } from './vendor/three/loaders/GLTFLoader.js';
import * as SkeletonUtils from './vendor/three/utils/SkeletonUtils.js';
import {
  rand, col, Particles, particleAtlas, TILE_GLOW, TILE_FLAME, TILE_SMOKE, TILE_SPARK,
  lavaMaterial, orbMaterial, bubbleMaterial, shockMaterial, beamMaterial, swirlMaterial, ribbonMaterial, HazeShader,
  stoneTexture, clothTexture, scorchTexture, magmaRockTexture, addRim, addLavaHeat,
} from './warlock3d-lib.js';

const { TILE, RADIUS, COLORS, SPELLS } = window.Warlock;
const MODEL_SCALE = 1.6;
const MODEL_HEIGHT = 200; // the animated model, in arena units (it is 1.84 m tall)
// Parts of the animated model dyed in the player's colour.
const DYED = { LightBrown: 1, Brown2: 0.55, DarkBrown: 0.35 };
const PITCH = 0.98; // camera angle above the ground (~56°)
const FOV = 40;
const FOLLOW_DIST = 2050;
const BALL_Y = 78; // height of flying spells
const LAVA_Y = -36;
const TAU = Math.PI * 2;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const angleLerp = (a, b, t) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; };
const approach = (cur, target, dt, speed) => cur + (target - cur) * Math.min(1, dt * speed);
const ease = (k) => k * k * (3 - 2 * k);

// Colour of each spell's magic (cast glow, hand light).
const SPELL_COLOR = {
  fireball: '#ff7a1a', cluster: '#ffb02a', homing: '#b066ff', bouncer: '#6cff5a', swap: '#5ad2ff', link: '#9ec9ff',
  boomerang: '#e8eef8', lightning: '#9fd6ff', teleport: '#7fe8ff', thrust: '#dfe9ff', meteor: '#ff5a1a', windwalk: '#cfd8e8',
  shield: '#7fd2ff', rush: '#ff4a1a', gravity: '#a060ff', scourge: '#ff2a2a',
};
const NO_AIM = ['shield', 'windwalk', 'rush', 'scourge'];
const BALL_STYLE = {
  fireball: ['#fff2c0', '#ff8a1c', '#c42a06'],
  cluster: ['#fff6c8', '#ffb83a', '#d0600a'],
  homing: ['#f6e6ff', '#b56cff', '#4a0ea8'],
  bouncer: ['#effff0', '#7cff5a', '#138a14'],
  swap: ['#f0fdff', '#5ad2ff', '#0e5aa8'],
  link: ['#f0f6ff', '#9ec9ff', '#2a4a8a'],
};

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
    this.scene.fog = new THREE.Fog(0x1a0603, 4200, 12000);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 20, 30000);
    this.target = V();
    this.dist = FOLLOW_DIST;
    this.zoom = 1; // mouse wheel, 0.55 – 1.35
    this.yaw = 0;
    this.time = 0;
    this.shakeAmp = 0;
    this.shakeT = 0;

    // Lights: warm sun with shadows, red light rising from the lava, spell lights.
    this.scene.add(new THREE.HemisphereLight(0xffd9b8, 0x6a1604, 0.9));
    const sun = new THREE.DirectionalLight(0xffe2c6, 2.7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 2;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    const under = new THREE.DirectionalLight(0xff5a1a, 1.3);
    under.position.set(0.2, -1, 0.3);
    this.scene.add(under);
    this.lights = [];
    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xff8a30, 0, 900, 1.2);
      this.scene.add(l);
      this.lights.push(l);
    }
    this.lightN = 0;

    // Lava.
    this.lavaMat = lavaMaterial();
    const lava = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000, 1, 1), this.lavaMat);
    lava.rotation.x = -Math.PI / 2;
    lava.position.y = LAVA_Y;
    this.scene.add(lava);

    // Rocks standing in the lava far away.
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x2b2019, roughness: 0.95, flatShading: true });
    for (let i = 0; i < 50; i++) {
      const a = rand(0, TAU);
      const d = rand(3200, 8500);
      const g = new THREE.DodecahedronGeometry(rand(90, 380), 1);
      const pos = g.attributes.position;
      for (let k = 0; k < pos.count; k++) pos.setXYZ(k, pos.getX(k) * rand(0.85, 1.15), pos.getY(k) * rand(0.85, 1.15), pos.getZ(k) * rand(0.85, 1.15));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, rockMat);
      m.position.set(Math.cos(a) * d, rand(-90, 0), Math.sin(a) * d);
      m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
      m.scale.y = rand(0.5, 1.7);
      this.scene.add(m);
    }

    // Stone tiles with bevelled edges (instanced); the next ring to sink is separate so it can glow.
    this.tileGeo = this.makeTileGeometry();
    this.tileTex = [0, 1, 2, 3].map(stoneTexture);
    this.warn = { value: 0 };
    const noWarn = { warn: { value: 0 } };
    const stone = (tex, warn) => addLavaHeat(new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 3, roughness: 0.9, metalness: 0.02 }), warn);
    this.tileMats = this.tileTex.map((tex) => stone(tex, noWarn));
    this.edgeMats = this.tileTex.map((tex) => stone(tex, { warn: this.warn }));
    this.tileMeshes = [];
    this.builtLayer = -1;
    this.sinking = [];

    // Shared bits.
    this.atlas = particleAtlas();
    this.fire = new Particles(this.scene, 7000, true, this.atlas);
    this.smoke = new Particles(this.scene, 2600, false, this.atlas);
    this.discGeo = new THREE.CircleGeometry(1, 64);
    this.discGeo.rotateX(-Math.PI / 2);
    this.sphereGeo = new THREE.SphereGeometry(1, 32, 20);
    this.ringGeo = new THREE.RingGeometry(0.88, 1, 72);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.cloth = clothTexture();
    this.scorchTex = scorchTexture();
    this.rockGlow = magmaRockTexture();
    this.decals = [];
    this.waves = [];
    this.beams = [];
    this.bolts = [];
    this.floaters = [];
    this.flashes = [];
    this.pawns = new Map();
    this.balls = new Map();
    this.debris = this.makeDebris();
    this.selected = null;
    // The animated hero model (Quaternius, CC0). Until it loads, or if it
    // cannot, the built-in procedural warlock is used.
    new GLTFLoader().load('models/warlock.glb', (g) => { this.gltf = g; }, undefined, (err) => console.warn('warlock model', err));

    this.moveMark = new THREE.Mesh(this.discGeo, shockMaterial('#4dff6a'));
    this.moveMark.visible = false;
    this.moveMark.renderOrder = 5;
    this.scene.add(this.moveMark);
    this.moveAt = -9;

    // Post-processing: bloom, heat shimmer and vignette.
    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.65, 0.5, 0.88);
    this.composer.addPass(this.bloom);
    this.haze = new ShaderPass(HazeShader);
    this.composer.addPass(this.haze);
    this.composer.addPass(new OutputPass());
    this.quality = 2;
    this.perf = { t: 0, n: 0, wait: 3 };
    this.ray = new THREE.Raycaster();
    this.ground = new THREE.Plane(V(0, 1, 0), 0);
    this.resize();
  }

  // ------------------------------------------------------------ quality
  // Slow PC? First shadows and glow go, then the resolution drops.
  setQuality(q) {
    this.quality = q;
    this.sun.castShadow = q >= 2;
    this.fire.scale = this.smoke.scale = q >= 2 ? 1 : q === 1 ? 0.7 : 0.45;
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
  }

  pick(cx, cy) {
    const v = new THREE.Vector2((cx / this.w) * 2 - 1, -(cy / this.h) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    const hit = V();
    if (!this.ray.ray.intersectPlane(this.ground, hit)) return { x: this.target.x, y: this.target.z };
    return { x: hit.x, y: hit.z };
  }

  toScreen(x, y, h = 0) {
    const v = V(x, h, y).project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.w, (-v.y * 0.5 + 0.5) * this.h];
  }

  showMove(x, y) {
    this.moveMark.position.set(x, 3, y);
    this.moveAt = this.time;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      this.fire.add({ p: [x, 6, y], v: [Math.cos(a) * 160, 30, Math.sin(a) * 160], c0: col('#9dffb0'), c1: col('#1a8a2a'), size: 10, life: 0.3, tile: TILE_SPARK, stretch: 0.05, drag: 0.85 });
    }
  }

  shake(amp, sec) { this.shakeAmp = Math.max(this.shakeAmp, amp); this.shakeT = Math.max(this.shakeT, sec); }

  light(x, y, z, color, power) {
    const l = this.lights[this.lightN++];
    if (!l) return;
    l.position.set(x, y, z);
    l.color.set(color);
    l.intensity = power * 150;
  }

  // ------------------------------------------------------------ platform
  makeTileGeometry() {
    const s = TILE / 2 - 5;
    const shape = new THREE.Shape();
    const r = 10;
    shape.moveTo(-s + r, -s);
    shape.lineTo(s - r, -s); shape.quadraticCurveTo(s, -s, s, -s + r);
    shape.lineTo(s, s - r); shape.quadraticCurveTo(s, s, s - r, s);
    shape.lineTo(-s + r, s); shape.quadraticCurveTo(-s, s, -s, s - r);
    shape.lineTo(-s, -s + r); shape.quadraticCurveTo(-s, -s, -s + r, -s);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 150, bevelEnabled: true, bevelThickness: 7, bevelSize: 7, bevelSegments: 2, curveSegments: 3 });
    g.rotateX(Math.PI / 2); // extrude downwards; top face at y = 0 (plus bevel)
    g.translate(0, -7, 0);
    // Project the texture from above so the top shows the whole stone.
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / TILE + 0.5, pos.getZ(i) / TILE + 0.5);
    g.computeVertexNormals();
    return g;
  }

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
          const h = ((((t.gx * 31 + t.gy * 17) % 5) + 5) % 5) * 1.4;
          m4.makeRotationY(((((t.gx * 3 + t.gy * 5) % 4) + 4) % 4) * (Math.PI / 2));
          m4.setPosition(t.gx * TILE, h - 3, t.gy * TILE);
          mesh.setMatrixAt(i, m4);
          const k = 0.74 + ((((t.gx * 13 + t.gy * 7 + t.gx * t.gy * 3) % 9) + 9) % 9) * 0.035;
          mesh.setColorAt(i, c.setRGB(k, k * 0.95, k * 0.9));
        });
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.tileMeshes.push(mesh);
      }
    }
    this.builtLayer = layer;
    this.lavaMat.uniforms.uEdge.value = layer * 100 + TILE * 0.5;
  }

  // The ring that just sank: tiles crack, glow, tilt and drop into the lava.
  sink(oldLayer, newLayer) {
    if (oldLayer <= newLayer) return;
    const keep = new Set(this.tilesFor(newLayer).map((t) => `${t.gx},${t.gy}`));
    for (const t of this.tilesFor(oldLayer)) {
      if (keep.has(`${t.gx},${t.gy}`)) continue;
      const warn = { value: 1.2 };
      const mat = addLavaHeat(new THREE.MeshStandardMaterial({ map: this.tileTex[t.v], bumpMap: this.tileTex[t.v], bumpScale: 3, roughness: 0.9 }), { warn });
      const m = new THREE.Mesh(this.tileGeo, mat);
      m.position.set(t.gx * TILE, -3, t.gy * TILE);
      m.receiveShadow = true;
      this.scene.add(m);
      this.sinking.push({ m, warn, x: t.gx * TILE, y: t.gy * TILE, t0: this.time, rx: rand(-0.3, 0.3), rz: rand(-0.3, 0.3), delay: rand(0, 0.4), splashed: false });
    }
  }

  // ------------------------------------------------------------ warlocks
  makeWarlock(color) {
    const main = col(color);
    const dark = main.clone().multiplyScalar(0.32);
    const rimCol = new THREE.Color(1.0, 0.45, 0.15).lerp(main, 0.25);
    const std = (o) => addRim(new THREE.MeshStandardMaterial(o), rimCol, 0.75);
    const robeMat = std({ color: main, map: this.cloth, roughness: 0.82 });
    const darkMat = std({ color: dark, map: this.cloth, roughness: 0.88, side: THREE.DoubleSide });
    const goldMat = std({ color: 0xc9a14a, roughness: 0.35, metalness: 0.85 });
    const ironMat = std({ color: 0x7a6a58, roughness: 0.4, metalness: 0.75 });
    const skinMat = std({ color: 0x5a4a44, roughness: 0.8 });
    const beardMat = std({ color: 0xc8c2b8, roughness: 0.95, flatShading: true });
    const woodMat = std({ color: 0x4a2c16, roughness: 0.75 });
    const leatherMat = std({ color: 0x3a2214, roughness: 0.8 });
    const pageMat = std({ color: 0xd8ccb0, roughness: 1 });
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x050302 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.6, 0.8) });
    const crystalMat = new THREE.MeshBasicMaterial({ color: main.clone().lerp(new THREE.Color(1, 0.75, 0.4), 0.45).multiplyScalar(1.7) });
    const handGlowMat = new THREE.MeshBasicMaterial({ color: col('#ff7a1a').multiplyScalar(3), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.position.set(x, y, z); parent.add(m); return m; };
    const group = (parent, x = 0, y = 0, z = 0) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };
    // Robe with folds: a lathe whose radius ripples around the body.
    const lathe = (pts, folds, depth, segs = 28) => {
      const g = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), segs);
      const p = g.attributes.position;
      const top = pts[pts.length - 1][1];
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        const a = Math.atan2(z, x);
        const k = 1 + Math.sin(a * folds + y * 0.04) * depth * (1 - y / top);
        p.setXYZ(i, x * k, y, z * k);
      }
      g.computeVertexNormals();
      return g;
    };

    const root = new THREE.Group();
    const hips = group(root, 0, 0, 0);
    const skirt = group(hips, 0, 0, 0);
    mesh(lathe([[0, 0], [29, 0], [31, 2], [29, 12], [25, 28], [20.5, 42], [17.5, 52]], 9, 0.09), robeMat, skirt);
    mesh(new THREE.TorusGeometry(30, 2.2, 6, 28), goldMat, skirt, 0, 3.5, 0).rotation.x = Math.PI / 2;
    // Front opening of the robe: a darker inner panel.
    mesh(new THREE.CylinderGeometry(6, 13, 46, 8, 1, false, -0.6, 1.2), darkMat, skirt, 15, 24, 0);
    const spine = group(hips, 0, 50, 0);
    mesh(lathe([[17.5, 0], [19, 7], [21.5, 17], [23.5, 25], [21, 31], [12, 36], [6, 37.5], [0, 38]], 5, 0.04), robeMat, spine);
    mesh(new THREE.TorusGeometry(18.5, 2.6, 6, 24), leatherMat, spine, 0, 1, 0).rotation.x = Math.PI / 2;
    mesh(new THREE.OctahedronGeometry(4.2, 0), crystalMat, spine, 19.5, 1, 0).scale.set(0.6, 1, 1);
    // Tome hanging from the belt (Dota's Warlock carries his book).
    const tomePivot = group(spine, -4, -2, -19);
    const tome = mesh(new THREE.BoxGeometry(15, 19, 5), leatherMat, tomePivot, 0, -12, -2);
    mesh(new THREE.BoxGeometry(13, 17, 5.4), pageMat, tome, 0.8, 0, 0);
    mesh(new THREE.BoxGeometry(3, 6, 6), goldMat, tome, 7, 0, 0);
    // Shoulder mantle and spiked iron pauldrons.
    mesh(new THREE.ConeGeometry(27, 18, 20, 1, true), darkMat, spine, 0, 34, 0);
    for (const sz of [-1, 1]) {
      const pad = mesh(new THREE.SphereGeometry(10, 16, 8, 0, TAU, 0, Math.PI / 2), ironMat, spine, 0, 30, sz * 19);
      pad.scale.set(1.25, 0.5, 1.05);
      pad.rotation.x = sz * 0.45;
      mesh(new THREE.TorusGeometry(10, 1, 5, 20), goldMat, pad, 0, 0.5, 0).rotation.x = Math.PI / 2;
      for (let k = 0; k < 3; k++) mesh(new THREE.ConeGeometry(1.4, 8, 5), ironMat, pad, (k - 1) * 6, 9, 0);
    }
    // Head: deep hood, shadowed face, glowing eyes, long white beard.
    const head = group(spine, 2, 41, 0);
    const hood = mesh(new THREE.SphereGeometry(15.5, 24, 16, Math.PI + 0.95, TAU - 1.9, 0, Math.PI * 0.82), darkMat, head);
    hood.scale.set(1.05, 1.15, 1.05);
    mesh(new THREE.ConeGeometry(9, 30, 12), darkMat, head, -14, 10, 0).rotation.z = 1.15;
    mesh(new THREE.SphereGeometry(11, 16, 12), shadowMat, head, 4, -1, 0);
    mesh(new THREE.SphereGeometry(9, 14, 10), skinMat, head, 7, -2, 0).scale.set(0.9, 1.1, 0.95);
    for (const z of [-4, 4]) mesh(new THREE.SphereGeometry(1.9, 8, 6), eyeMat, head, 15, 1, z).castShadow = false;
    mesh(new THREE.ConeGeometry(8, 30, 10), beardMat, head, 12, -19, 0).rotation.z = Math.PI - 0.25;
    mesh(new THREE.TorusGeometry(5, 1.8, 6, 10, Math.PI), beardMat, head, 14.5, -6, 0).rotation.set(0, Math.PI / 2, Math.PI);
    // Arms: shoulder → elbow → hand, in wide sleeves.
    const arm = (sz) => {
      const shoulder = group(spine, 0, 29, sz * 21);
      mesh(new THREE.CylinderGeometry(6, 8, 24, 10), robeMat, shoulder, 0, -12, 0);
      const elbow = group(shoulder, 0, -23, 0);
      mesh(new THREE.CylinderGeometry(7, 11.5, 22, 12, 1, true), darkMat, elbow, 0, -11, 0);
      mesh(new THREE.TorusGeometry(11, 1.4, 5, 16), goldMat, elbow, 0, -21.5, 0).rotation.x = Math.PI / 2;
      const hand = group(elbow, 0, -24, 0);
      mesh(new THREE.SphereGeometry(4.6, 10, 8), skinMat, hand);
      return { shoulder, elbow, hand };
    };
    const L = arm(-1);
    const R = arm(1);
    // Magic gathering in the free hand.
    const handGlow = new THREE.Mesh(this.sphereGeo, handGlowMat);
    handGlow.scale.setScalar(9);
    L.hand.add(handGlow);
    // Staff: twisted wood, iron claws holding a glowing crystal.
    const staff = group(R.hand, 0, 0, 0);
    const curve = new THREE.CatmullRomCurve3([V(0, -62, 0), V(1.5, -30, 1), V(-1, 0, -1), V(1.5, 30, 0.5), V(0, 58, 0), V(-2, 66, 0)]);
    mesh(new THREE.TubeGeometry(curve, 24, 2.4, 8), woodMat, staff);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU;
      mesh(new THREE.ConeGeometry(1.6, 15, 6), ironMat, staff, Math.cos(a) * 5, 71, Math.sin(a) * 5).rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
    }
    const crystal = mesh(new THREE.OctahedronGeometry(6, 0), crystalMat, staff, 0, 76, 0);
    crystal.scale.set(0.8, 1.5, 0.8);
    crystal.castShadow = false;
    const crystalHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow(), color: crystalMat.color.clone().multiplyScalar(0.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    crystalHalo.scale.setScalar(26);
    crystal.add(crystalHalo);
    // Cape in three hinged pieces behind the shoulders.
    const cape = [];
    let parent = group(spine, -14, 33, 0);
    for (let k = 0; k < 3; k++) {
      const seg = group(parent, 0, k ? -21 : 0, 0);
      mesh(new THREE.BoxGeometry(1.5, 22, 28 + k * 4), darkMat, seg, 0, -11, 0);
      cape.push(seg);
      parent = seg;
    }
    root.scale.setScalar(MODEL_SCALE);
    this.scene.add(root);
    const extras = this.pawnExtras(root, main);
    const mats = [robeMat, darkMat, goldMat, ironMat, skinMat, beardMat, woodMat, leatherMat, pageMat];
    return {
      ...extras, root, hips, skirt, spine, head, L, R, staff, crystal, crystalMat, crystalBase: crystalMat.color.clone(), handGlow, handGlowMat, tomePivot, cape, mats,
      x: 0, y: 0, f: 0, seen: false, run: 0, slide: 0, speed: 0, phase: 0, hitT: -9, rel: null, wind: 0, windKey: '', death: null, invis: false, pose: {},
    };
  }

  // The animated model: skinned mesh with Idle, Run, cast, hit and death clips.
  makeModelWarlock(color) {
    const main = col(color);
    const rimCol = new THREE.Color(1.0, 0.45, 0.15).lerp(main, 0.25);
    const root = new THREE.Group();
    const model = SkeletonUtils.clone(this.gltf.scene);
    model.scale.setScalar(MODEL_HEIGHT / 1.84);
    model.rotation.y = Math.PI / 2; // the model faces +Z; the game's facing 0 is +X
    root.add(model);
    const mats = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false;
      const m = o.material.clone();
      if (DYED[m.name] !== undefined) m.color.copy(main).multiplyScalar(DYED[m.name]);
      if (m.name === 'Black') m.color.copy(main).multiplyScalar(0.12);
      addRim(m, rimCol, 0.7);
      mats.push(m);
      o.material = m;
    });
    // Swap the sword for a staff: same bone, centred on the grip, crystal on top.
    const sword = model.getObjectByName('Sword');
    const crystalMat = new THREE.MeshBasicMaterial({ color: main.clone().lerp(new THREE.Color(1, 0.75, 0.4), 0.45).multiplyScalar(1.7) });
    const staff = new THREE.Group();
    const woodMat = addRim(new THREE.MeshStandardMaterial({ color: 0x4a2c16, roughness: 0.75 }), rimCol, 0.7);
    const ironMat = addRim(new THREE.MeshStandardMaterial({ color: 0x7a6a58, roughness: 0.4, metalness: 0.75 }), rimCol, 0.7);
    mats.push(woodMat, ironMat);
    const curve = new THREE.CatmullRomCurve3([V(0, -95, 0), V(2, -50, 1.5), V(-1.5, 0, -1), V(2, 45, 1), V(0, 88, 0), V(-3, 98, 0)]);
    const pole = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 3.4, 8), woodMat);
    pole.castShadow = true;
    staff.add(pole);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU;
      const claw = new THREE.Mesh(new THREE.ConeGeometry(2.2, 20, 6), ironMat);
      claw.position.set(Math.cos(a) * 7, 106, Math.sin(a) * 7);
      claw.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
      staff.add(claw);
    }
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(8.5, 0), crystalMat);
    crystal.position.y = 112;
    crystal.scale.set(0.8, 1.5, 0.8);
    staff.add(crystal);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow(), color: crystalMat.color.clone().multiplyScalar(0.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    halo.scale.setScalar(40);
    crystal.add(halo);
    if (sword) {
      sword.visible = false;
      sword.parent.add(staff);
      staff.position.copy(sword.position);
      staff.quaternion.copy(sword.quaternion);
      model.updateMatrixWorld(true);
      const ws = V();
      sword.getWorldScale(ws);
      staff.scale.setScalar(sword.scale.x / ws.x);
    } else model.add(staff);
    // Magic gathering in the free (left) hand.
    const handGlowMat = new THREE.MeshBasicMaterial({ color: col('#ff7a1a').multiplyScalar(3), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const handGlow = new THREE.Mesh(this.sphereGeo, handGlowMat);
    const wristL = model.getObjectByName('Wrist.L') || model;
    wristL.add(handGlow);
    model.updateMatrixWorld(true);
    const wsl = V();
    wristL.getWorldScale(wsl);
    handGlow.scale.setScalar(10 / wsl.x);
    // Animations.
    const mixer = new THREE.AnimationMixer(model);
    const clip = (n) => this.gltf.animations.find((a) => a.name.endsWith(`|${n}`));
    const actions = {};
    for (const n of ['Idle', 'Run', 'Walk', 'Sword_Slash', 'Punch_Left', 'HitRecieve', 'Death', 'Wave']) {
      const c = clip(n);
      if (c) actions[n] = mixer.clipAction(c);
    }
    for (const n of ['Sword_Slash', 'Punch_Left', 'HitRecieve', 'Death']) {
      if (!actions[n]) continue;
      actions[n].setLoop(THREE.LoopOnce, 1);
      actions[n].clampWhenFinished = true;
    }
    if (actions.Idle) actions.Idle.play();
    const extras = this.pawnExtras(root, main);
    this.scene.add(root);
    return {
      ...extras, root, model, mixer, actions, cur: 'Idle', staff, crystal, crystalMat, crystalBase: crystalMat.color.clone(), handGlow, handGlowMat, mats,
      x: 0, y: 0, f: 0, seen: false, run: 0, slide: 0, speed: 0, hitT: -9, rel: null, wind: 0, windKey: '', death: null, invis: false,
    };
  }

  // Selection circle, shadow blob, bubbles and the name label (both kinds of model).
  pawnExtras(root, main) {
    const k = 1 / root.scale.x; // sizes below are in arena units
    const blob = new THREE.Mesh(this.discGeo, new THREE.MeshBasicMaterial({ map: this.glow(), color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }));
    blob.scale.setScalar(55 * k);
    blob.position.y = 1.5;
    root.add(blob);
    const circle = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: main.clone().multiplyScalar(1.8), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
    circle.scale.setScalar(RADIUS * 1.25 * k);
    circle.position.y = 2;
    root.add(circle);
    // Dota-style selection ring: green on your hero, red on an enemy.
    const sel = new THREE.Mesh(this.discGeo, shockMaterial('#40ff60'));
    sel.position.y = 3;
    sel.scale.setScalar(70 * k);
    sel.visible = false;
    sel.material.uniforms.uProg.value = 0.82;
    sel.material.uniforms.uWidth.value = 0.07;
    root.add(sel);
    const shield = new THREE.Mesh(this.sphereGeo, bubbleMaterial('#7fd2ff'));
    shield.visible = false;
    this.scene.add(shield);
    const spawn = new THREE.Mesh(this.sphereGeo, bubbleMaterial('#ffd77a', false));
    spawn.visible = false;
    this.scene.add(spawn);
    const label = document.createElement('div');
    label.className = 'lbl';
    label.innerHTML = '<b></b><div class="bar"><i></i></div><small></small>';
    this.labels.append(label);
    return { circle, sel, shield, spawn, label };
  }

  // Which warlock is under the mouse (for selecting it), or null.
  pawnAt(cx, cy, me) {
    let best = null;
    let bd = 60;
    for (const [id, w] of this.pawns) {
      if (!w.root.visible || w.death || (w.invis && id !== me)) continue;
      const [sx, sy] = this.toScreen(w.x, w.y, 90);
      const d = Math.hypot(sx - cx, sy - cy);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  // Plays a clip on the animated model with a short cross-fade.
  play(w, name, fade = 0.15, restart = false) {
    const next = w.actions[name];
    if (!next) return;
    if (w.cur === name && !restart) return;
    const prev = w.actions[w.cur];
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    w.cur = name;
  }

  // Dota-like animation for the model: idle, run at the speed it moves, the
  // cast animation timed so the swing lands when the spell leaves (after the
  // cast point), a backswing that walking cancels, hit flinches, death.
  animateModel(w, p, dt, speed, onLava) {
    const t = this.time;
    const walking = p.mv && speed > 40 && !p.cast;
    w.run = approach(w.run, walking ? 1 : 0, dt, 10);
    const relAge = w.rel ? t - w.rel.t : 9;
    const castKey = p.cast ? p.cs : relAge < 0.6 ? w.rel.k : '';
    const sym = NO_AIM.includes(castKey);
    if (p.cast && w.castStart === undefined) w.castStart = t;
    if (!p.cast && relAge > 0.05) w.castStart = undefined;
    if (p.cast || (relAge < 0.6 && !walking)) {
      // The swing's hit frame (~40% in) lines up with the end of the cast point.
      const name = sym ? (castKey === 'scourge' ? 'Sword_Slash' : 'Wave') : 'Sword_Slash';
      const clip = w.actions[name];
      if (clip) {
        const castPoint = castKey && SPELLS[castKey] ? SPELLS[castKey].cast : 0.2;
        const hit = clip.getClip().duration * 0.4;
        clip.timeScale = castPoint > 0.05 ? hit / castPoint : 2.2;
        if (w.cur !== name || (p.cast && w.castStart === t)) this.play(w, name, 0.08, true);
      }
    } else if (walking) {
      this.play(w, 'Run', 0.15);
      if (w.actions.Run) w.actions.Run.timeScale = Math.max(0.6, speed / 260);
    } else if (t - w.hitT < 0.35 && w.actions.HitRecieve) {
      if (w.cur !== 'HitRecieve') this.play(w, 'HitRecieve', 0.06, true);
    } else {
      this.play(w, 'Idle', 0.2);
    }
    w.mixer.update(dt);
    // Glows.
    const magic = p.cast ? Math.max(0.3, p.cp) : relAge < 0.3 ? 1 - relAge / 0.3 : 0;
    // Keep the staff upright like a wizard's, leaning it forward at the target
    // through the cast and swinging back after.
    const swing = p.cast ? -0.5 * Math.max(0.3, p.cp) : relAge < 0.6 ? (relAge < 0.1 ? relAge / 0.1 : 1 - (relAge - 0.1) / 0.5) * 1.3 : 0;
    w.tilt = approach(w.tilt || 0, 0.12 + swing + 0.15 * w.run, dt, 18);
    const parent = w.staff.parent;
    w.root.updateMatrixWorld(true);
    const pq = parent.getWorldQuaternion(new THREE.Quaternion());
    const want = w.root.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -w.tilt)));
    w.staff.quaternion.copy(pq.invert().multiply(want));
    w.crystal.rotation.y += dt * 1.5;
    w.crystalMat.color.copy(w.crystalBase).multiplyScalar(1 + magic * 1.5 + 0.15 * Math.sin(t * 4));
    w.handGlowMat.opacity = Math.min(1, magic * 1.2);
    if (castKey && SPELL_COLOR[castKey]) w.handGlowMat.color.set(SPELL_COLOR[castKey]).multiplyScalar(3);
    const hit = Math.max(0, 1 - (t - w.hitT) / 0.3);
    const burn = onLava ? 0.35 + 0.15 * Math.sin(t * 20) : 0;
    for (const m of w.mats) {
      if (m.userData.flash) m.userData.flash.value = hit * 1.4;
      m.emissive.setRGB(burn, burn * 0.25, burn * 0.03);
    }
  }

  glow() {
    if (!this.glowTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.3, 'rgba(255,255,255,.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
      this.glowTex = new THREE.CanvasTexture(c);
    }
    return this.glowTex;
  }

  // Procedural animation: idle breathing, running, Dota-style cast (wind-up
  // through the cast point, release, backswing), knockback, hit and death.
  animate(w, p, dt, speed, onLava) {
    const t = this.time;
    const walking = p.mv && speed > 40 && !p.cast;
    w.run = approach(w.run, walking ? 1 : 0, dt, 10);
    w.phase += dt * (walking ? speed / 26 : 1.6);
    const run = w.run;
    const ph = w.phase;
    const sliding = !p.mv && !p.cast && speed > 140; // knocked back
    w.slide = approach(w.slide, sliding ? 1 : 0, dt, 8);
    const sl = w.slide;
    // Wind-up through the cast point, then the release and a short backswing.
    w.wind = approach(w.wind, p.cast ? Math.max(0.15, p.cp) : 0, dt, p.cast ? 30 : 12);
    if (p.cast) w.windKey = p.cs;
    const relAge = w.rel ? t - w.rel.t : 9;
    const rel = relAge < 0.45 ? (relAge < 0.08 ? relAge / 0.08 : 1 - ease((relAge - 0.08) / 0.37)) : 0;
    const key = relAge < 0.45 ? w.rel.k : w.windKey;
    const wind = w.wind;
    const hit = Math.max(0, 1 - (t - w.hitT) / 0.3);
    const sym = NO_AIM.includes(key);
    const slam = key === 'scourge';
    const breathe = Math.sin(t * 2.2 + w.x * 0.01);

    const P = {};
    P.hipsY = Math.abs(Math.sin(ph)) * 4.5 * run + breathe * 0.6 * (1 - run) - (slam ? rel * 6 : 0);
    P.lean = -0.2 * run - 0.12 * rel + 0.06 * wind + 0.28 * sl + 0.35 * hit - (slam ? 0.3 * rel : 0);
    P.twist = 0.14 * Math.sin(ph) * run + (sym ? 0 : 0.35 * wind - 0.3 * rel);
    P.skirtZ = 0.07 * Math.sin(ph) * run - 0.1 * sl;
    P.skirtX = 0.05 * Math.cos(ph) * run;
    P.headZ = 0.06 * breathe * (1 - run) + 0.1 * run - 0.2 * hit;
    // Free (left) arm: swings when running, reaches forward to cast.
    P.lSz = 0.15 + 0.55 * Math.sin(ph) * run + (sym ? 2.3 * wind : 1.1 * wind) + (sym ? 0 : 1.5 * rel) + 0.3 * sl;
    P.lSx = 0.12 + (sym ? 0.9 * wind + 1.2 * rel : 0) + 0.9 * sl;
    P.lE = 0.55 + 0.3 * run - 0.4 * Math.max(wind, rel);
    // Staff arm: carries the staff, raises it in the wind-up, thrusts it forward.
    P.rSz = 0.35 - 0.25 * Math.sin(ph) * run + (sym ? 2.4 * wind : 2.0 * wind) + (slam ? -1.2 * rel : sym ? 0.2 * rel : 1.0 * rel) + 0.4 * sl;
    P.rSx = -0.12 - (sym ? 0.9 * wind + 1.2 * rel : 0) - 0.8 * sl;
    P.rE = 1.05 - 0.6 * Math.max(wind, rel);
    // Staff tilt (positive = top forward): upright, back over the shoulder, then pointing at the target.
    P.staff = 0.08 * Math.sin(ph) * run - (sym ? 0 : 0.8 * wind) + (sym ? 0 : 1.5 * rel) + (slam ? 0.4 * rel : 0);
    for (const k in P) w.pose[k] = w.pose[k] === undefined ? P[k] : approach(w.pose[k], P[k], dt, 22);
    const q = w.pose;
    w.hips.position.y = q.hipsY;
    w.spine.rotation.z = q.lean;
    w.spine.rotation.y = q.twist;
    w.skirt.rotation.z = q.skirtZ;
    w.skirt.rotation.x = q.skirtX;
    w.head.rotation.z = q.headZ;
    w.L.shoulder.rotation.set(q.lSx, 0, q.lSz);
    w.L.elbow.rotation.z = q.lE;
    w.R.shoulder.rotation.set(q.rSx, 0, q.rSz);
    w.R.elbow.rotation.z = q.rE;
    w.staff.rotation.set(-q.rSx, 0, -(q.rSz + q.rE + q.lean) - q.staff);
    // Cape: lifts behind when running, flutters, blown when knocked back.
    const flutter = Math.sin(t * 9 + ph) * 0.08 * (run + sl) + Math.sin(t * 1.7) * 0.03;
    w.cape[0].rotation.z = approach(w.cape[0].rotation.z, -(0.06 + 0.3 * run + 0.35 * sl) + flutter * 0.6 - q.lean * 0.5, dt, 10);
    w.cape[1].rotation.z = approach(w.cape[1].rotation.z, -(0.1 * run + 0.15 * sl) + flutter, dt, 10);
    w.cape[2].rotation.z = approach(w.cape[2].rotation.z, -(0.08 * run + 0.12 * sl) + flutter * 1.3, dt, 10);
    w.tomePivot.rotation.z = approach(w.tomePivot.rotation.z, 0.35 * run + Math.sin(ph * 2) * 0.12 * run, dt, 8);
    // Glows: the crystal brightens with magic; the free hand holds the spell's colour.
    const magic = Math.max(wind, rel);
    w.crystal.rotation.y += dt * 1.5;
    w.crystal.scale.set(0.8 + magic * 0.3, 1.5 + magic * 0.4, 0.8 + magic * 0.3);
    w.crystalMat.color.copy(w.crystalBase).multiplyScalar(1 + magic * 1.5 + 0.15 * Math.sin(t * 4));
    w.handGlowMat.opacity = Math.min(1, magic * 1.2);
    if (key && SPELL_COLOR[key]) w.handGlowMat.color.set(SPELL_COLOR[key]).multiplyScalar(3);
    w.handGlow.scale.setScalar(6 + 6 * magic + Math.sin(t * 20) * 0.8);
    if (wind > 0.2 && key && Math.random() < dt * 40) {
      const hp = V();
      w.L.hand.getWorldPosition(hp);
      const c = col(SPELL_COLOR[key] || '#ffffff');
      const a = rand(0, TAU);
      this.fire.add({ p: [hp.x + Math.cos(a) * 40, hp.y + rand(-20, 20), hp.z + Math.sin(a) * 40], v: [-Math.cos(a) * 160, 0, -Math.sin(a) * 160], c0: c.clone().multiplyScalar(2), c1: c, size: 8, size1: 2, life: 0.25, drag: 1 });
    }
    // Hit flash and lava burn on every material.
    const burn = onLava ? 0.35 + 0.15 * Math.sin(t * 20) : 0;
    for (const m of w.mats) {
      if (m.userData.flash) m.userData.flash.value = hit * 1.4;
      m.emissive.setRGB(burn, burn * 0.25, burn * 0.03);
    }
  }

  setInvisible(w, on) {
    if (w.invis === on) return;
    w.invis = on;
    for (const m of w.mats) { m.transparent = on; m.opacity = on ? 0.3 : 1; m.depthWrite = !on; m.needsUpdate = true; }
  }

  updatePawns(s, prev, k, me, names, dt) {
    const alive = new Set();
    s.p.forEach((p, idx) => {
      alive.add(p.id);
      let w = this.pawns.get(p.id);
      if (w && !w.model && this.gltf) { this.dropPawn(w); w = null; }
      if (!w) { w = this.gltf ? this.makeModelWarlock(COLORS[idx % 10]) : this.makeWarlock(COLORS[idx % 10]); this.pawns.set(p.id, w); }
      const invisible = p.m.includes('windwalk');
      // A dead warlock plays its death for a moment before disappearing.
      if (p.d && w.seen && !w.death) w.death = { t: this.time, x: w.x, y: w.y };
      const dying = w.death && this.time - w.death.t < 1.6;
      if (!p.d) w.death = null;
      const show = (!p.d && !p.l && (!invisible || p.id === me)) || (dying && !p.l);
      w.root.visible = !!show;
      w.label.style.display = show && !dying ? '' : 'none';
      w.shield.visible = !!(show && !dying && p.sh > 0);
      w.spawn.visible = !!(show && !dying && p.m.includes('spawnShield'));
      if (!show) { if (!dying) w.seen = false; return; }
      if (dying) { this.animateDeath(w, dt); return; }
      this.setInvisible(w, invisible);
      const q = prev.p.find((o) => o.id === p.id) || p;
      const tx = q.d ? p.x : q.x + (p.x - q.x) * k;
      const ty = q.d ? p.y : q.y + (p.y - q.y) * k;
      if (!w.seen) { w.x = tx; w.y = ty; w.f = p.f; w.seen = true; }
      const speed = Math.hypot(tx - w.x, ty - w.y) / Math.max(dt, 0.001);
      w.speed = approach(w.speed, speed, dt, 12);
      w.x = tx;
      w.y = ty;
      // Facing comes straight from the game, which turns at Dota's turn rate.
      w.f = angleLerp(q.f, p.f, k);
      const onLava = this.onLava(tx, ty, s.layer);
      w.root.position.set(tx, onLava ? -12 : 0, ty);
      w.root.rotation.set(0, -w.f, 0);
      if (w.model) this.animateModel(w, p, dt, w.speed, onLava);
      else this.animate(w, p, dt, w.speed, onLava);
      w.circle.material.opacity = p.id === me ? 0.95 : 0.55;
      w.sel.visible = this.selected === p.id;
      if (w.sel.visible) {
        w.sel.material.uniforms.uColor.value.set(p.id === me ? '#40ff60' : '#ff3a2a');
        w.sel.material.uniforms.uAlpha.value = 0.75 + 0.25 * Math.sin(this.time * 6);
      }
      if (onLava && Math.random() < dt * 40) this.fire.add({ p: [tx + rand(-28, 28), rand(0, 30), ty + rand(-28, 28)], v: [rand(-20, 20), rand(120, 260), rand(-20, 20)], c0: col('#ffd070'), c1: col('#c02000'), size: rand(22, 36), size1: 6, life: rand(0.4, 0.7), tile: TILE_FLAME, drag: 0.95 });
      if (onLava && Math.random() < dt * 8) this.smoke.add({ p: [tx, 60, ty], v: [rand(-20, 20), rand(60, 120), rand(-20, 20)], c0: col('#2a1a14'), size: 40, size1: 110, life: 1.4, a: 0.35, tile: TILE_SMOKE, spin: rand(-1, 1) });
      if (w.run > 0.5 && Math.random() < dt * 14) this.smoke.add({ p: [tx + rand(-12, 12), 6, ty + rand(-12, 12)], v: [rand(-20, 20), rand(15, 40), rand(-20, 20)], c0: col('#5a4a40'), size: 16, size1: 44, life: 0.7, a: 0.3, tile: TILE_SMOKE });
      if (w.slide > 0.3 && !onLava && Math.random() < dt * 40) {
        this.smoke.add({ p: [tx + rand(-15, 15), 8, ty + rand(-15, 15)], v: [rand(-30, 30), rand(20, 60), rand(-30, 30)], c0: col('#6a5a50'), size: 20, size1: 60, life: 0.8, a: 0.4, tile: TILE_SMOKE });
        this.fire.add({ p: [tx, 4, ty], v: [rand(-140, 140), rand(40, 120), rand(-140, 140)], c0: col('#ffe0a0'), c1: col('#ff6010'), size: 3, life: 0.35, tile: TILE_SPARK, stretch: 0.06, grav: 500 });
      }
      if (p.m.includes('rush')) {
        if (Math.random() < dt * 50) this.fire.add({ p: [tx + rand(-30, 30), rand(0, 20), ty + rand(-30, 30)], v: [0, rand(150, 280), 0], c0: col('#ffb070'), c1: col('#d01000'), size: 6, life: 0.4, tile: TILE_SPARK, stretch: 0.08 });
        if (Math.random() < dt * 20) this.fire.add({ p: [tx + rand(-25, 25), 10, ty + rand(-25, 25)], v: [0, rand(60, 120), 0], c0: col('#ff6a2a'), c1: col('#600000'), size: 36, size1: 10, life: 0.4, tile: TILE_FLAME });
      }
      if (invisible && Math.random() < dt * 10) this.smoke.add({ p: [tx, rand(20, 120), ty], v: [rand(-20, 20), 40, rand(-20, 20)], c0: col('#c8d0e0'), size: 24, size1: 60, life: 0.8, a: 0.15, tile: TILE_SMOKE });
      if (w.shield.visible) {
        w.shield.position.set(tx, 50, ty);
        w.shield.scale.set(p.sh, p.sh * 0.8, p.sh);
        const u = w.shield.material.uniforms;
        u.uTime.value = this.time;
        u.uHit.value = Math.max(0, u.uHit.value - dt * 3);
      }
      if (w.spawn.visible) {
        w.spawn.position.set(tx, 70, ty);
        w.spawn.scale.setScalar(95);
        w.spawn.material.uniforms.uTime.value = this.time;
        w.spawn.material.uniforms.uAlpha.value = 0.55 + 0.15 * Math.sin(this.time * 6);
      }
      // Label above the head.
      const [lx, ly] = this.toScreen(tx, ty, (onLava ? -12 : 0) + (w.model ? MODEL_HEIGHT + 30 : 152 * MODEL_SCALE));
      w.label.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px) translate(-50%, -100%)`;
      const f = Math.max(0, p.hp / p.mx);
      const lk = `${names[p.id] || ''}|${p.hp}|${p.dp}|${p.id === me}`;
      if (w.label.dataset.k !== lk) {
        w.label.dataset.k = lk;
        w.label.firstChild.textContent = names[p.id] || '';
        w.label.classList.toggle('me', p.id === me);
        const bar = w.label.querySelector('i');
        bar.style.width = `${f * 100}%`;
        bar.style.background = f > 0.5 ? 'linear-gradient(#7fe88a,#2fa846)' : f > 0.25 ? 'linear-gradient(#ffe070,#d29a10)' : 'linear-gradient(#ff7a6a,#c02018)';
        w.label.lastChild.textContent = p.dp > 0 ? `+${Math.round(p.dp / 10)}%` : '';
      }
    });
    for (const [id, w] of this.pawns) {
      if (alive.has(id)) continue;
      this.dropPawn(w);
      this.pawns.delete(id);
    }
  }

  dropPawn(w) {
    for (const o of [w.root, w.shield, w.spawn]) this.scene.remove(o);
    w.label.remove();
  }

  animateDeath(w, dt) {
    const k = (this.time - w.death.t) / 1.6;
    const onLava = this.onLava(w.death.x, w.death.y, this.builtLayer);
    w.root.position.set(w.death.x, (onLava ? -12 : 0) - k * k * 160, w.death.y);
    if (w.model) {
      if (w.cur !== 'Death') this.play(w, 'Death', 0.1, true);
      w.mixer.update(dt);
      for (const m of w.mats) { m.emissive.setRGB(1.2 * k, 0.3 * k, 0.03); if (m.userData.flash) m.userData.flash.value = 0; }
      if (Math.random() < dt * 60) this.fire.add({ p: [w.death.x + rand(-30, 30), rand(0, 90) - k * 100, w.death.y + rand(-30, 30)], v: [rand(-30, 30), rand(150, 300), rand(-30, 30)], c0: col('#ffe090'), c1: col('#b01800'), size: rand(26, 46), size1: 8, life: 0.6, tile: TILE_FLAME });
      return;
    }
    w.spine.rotation.z = approach(w.spine.rotation.z, 0.9, dt, 4);
    w.L.shoulder.rotation.z = approach(w.L.shoulder.rotation.z, 2.6, dt, 6);
    w.R.shoulder.rotation.z = approach(w.R.shoulder.rotation.z, 2.4, dt, 6);
    for (const m of w.mats) { m.emissive.setRGB(1.2 * k, 0.3 * k, 0.03); if (m.userData.flash) m.userData.flash.value = 0; }
    if (Math.random() < dt * 60) this.fire.add({ p: [w.death.x + rand(-30, 30), rand(0, 90) - k * 100, w.death.y + rand(-30, 30)], v: [rand(-30, 30), rand(150, 300), rand(-30, 30)], c0: col('#ffe090'), c1: col('#b01800'), size: rand(26, 46), size1: 8, life: 0.6, tile: TILE_FLAME });
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
    const g = new THREE.Group();
    const o = { kind, g, acc: 0, age: 0, parts: [] };
    o.st = (BALL_STYLE[kind] || BALL_STYLE.fireball).map(col);
    const halo = (color, size) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow(), color: col(color).multiplyScalar(1.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sp.scale.setScalar(size);
      g.add(sp);
      return sp;
    };
    if (kind === 'boomerang') {
      const shape = new THREE.Shape();
      shape.absarc(0, 0, 30, 0.2, Math.PI * 1.35, false);
      shape.absarc(-6, 4, 21, Math.PI * 1.3, 0.3, true);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: true, bevelThickness: 1.2, bevelSize: 1.5, bevelSegments: 2 });
      geo.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(geo, addRim(new THREE.MeshStandardMaterial({ color: 0xdfe6f0, metalness: 0.95, roughness: 0.18 }), '#9fc8ff', 1.2));
      m.castShadow = true;
      g.add(m);
      o.spin = m;
      halo('#c8dcff', 50);
    } else if (kind === 'meteor') {
      const geo = new THREE.IcosahedronGeometry(62, 2);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) { const k = 1 + rand(-0.12, 0.12); p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k); }
      geo.computeVertexNormals();
      o.rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 0.9, emissive: 0xffffff, emissiveMap: this.rockGlow, emissiveIntensity: 2.2 }));
      o.rock.castShadow = true;
      g.add(o.rock);
      halo('#ff6a1a', 260);
      o.mark = new THREE.Mesh(this.discGeo, shockMaterial('#ff7a20'));
      o.mark.renderOrder = 5;
      o.shadow = new THREE.Mesh(this.discGeo, new THREE.MeshBasicMaterial({ map: this.glow(), color: 0x000000, transparent: true, depthWrite: false }));
      this.scene.add(o.mark, o.shadow);
    } else if (kind === 'gravity') {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(30, 24, 16), new THREE.MeshBasicMaterial({ color: 0x000000 })));
      const ring = new THREE.Mesh(this.sphereGeo, bubbleMaterial('#b070ff', false));
      ring.scale.setScalar(40);
      g.add(ring);
      o.halo = ring;
      o.disk = new THREE.Mesh(new THREE.CircleGeometry(1, 64), swirlMaterial('#9a50ff'));
      o.disk.rotation.x = -Math.PI / 2;
      o.disk.scale.setScalar(560);
      o.disk.renderOrder = 5;
      this.scene.add(o.disk);
    } else {
      o.core = new THREE.Mesh(this.sphereGeo, orbMaterial(o.st[0], o.st[1], o.st[2]));
      g.add(o.core);
      o.glow = halo(o.st[1].getStyle(), 120);
      if (kind === 'swap') {
        for (let k = 0; k < 2; k++) {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 6, 32), new THREE.MeshBasicMaterial({ color: o.st[1].clone().multiplyScalar(2.5) }));
          g.add(ring);
          o.parts.push(ring);
        }
      }
      if (kind === 'link') {
        const hook = new THREE.Mesh(new THREE.TorusGeometry(14, 3, 6, 14, Math.PI * 1.3), addRim(new THREE.MeshStandardMaterial({ color: 0x9aa4b0, metalness: 0.9, roughness: 0.3 }), '#9ec9ff', 1));
        g.add(hook);
        o.hook = hook;
      }
    }
    this.scene.add(g);
    return o;
  }

  // A chain of iron links between two points.
  chain(o, x1, y1, x2, y2) {
    const a = V(x1, 62, y1);
    const b = V(x2, 62, y2);
    const len = a.distanceTo(b);
    const n = Math.min(80, Math.max(2, Math.floor(len / 13)));
    if (!o.chainMesh) {
      o.chainMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(6, 1.6, 6, 12), addRim(new THREE.MeshStandardMaterial({ color: 0x8a94a0, metalness: 0.9, roughness: 0.35 }), '#9ec9ff', 1.2), 80);
      o.chainMesh.castShadow = true;
      o.chainMesh.frustumCulled = false;
      this.scene.add(o.chainMesh);
    }
    const dir = b.clone().sub(a).normalize();
    const base = new THREE.Quaternion().setFromUnitVectors(V(1, 0, 0), dir);
    const twisted = base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI / 2));
    const m4 = new THREE.Matrix4();
    const one = V(1, 1, 1);
    const sag = Math.min(40, len * 0.03);
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const p = a.clone().lerp(b, f);
      p.y += -Math.sin(f * Math.PI) * sag + Math.sin(this.time * 30 + i) * 1.5;
      m4.compose(p, i % 2 ? twisted : base, one);
      o.chainMesh.setMatrixAt(i, m4);
    }
    o.chainMesh.count = n;
    o.chainMesh.instanceMatrix.needsUpdate = true;
    if (Math.random() < 0.3) {
      const f = Math.random();
      this.fire.add({ p: [x1 + (x2 - x1) * f, 62, y1 + (y2 - y1) * f], v: [rand(-40, 40), rand(20, 60), rand(-40, 40)], c0: col('#d0e6ff'), c1: col('#3a6ab0'), size: 4, life: 0.3, tile: TILE_SPARK, stretch: 0.05 });
    }
  }

  removeBall(o) {
    const shared = new Set([this.discGeo, this.sphereGeo, this.ringGeo]);
    for (const x of [o.g, o.mark, o.shadow, o.disk, o.chainMesh]) {
      if (!x) continue;
      this.scene.remove(x);
      x.traverse((m) => {
        if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose();
        if (m.material) m.material.dispose();
      });
    }
  }

  // How many particles to emit this frame for a rate per second.
  emit(o, rate, dt) {
    o.acc += rate * dt;
    const n = Math.floor(o.acc);
    o.acc -= n;
    return n;
  }

  updateBalls(s, since, dt) {
    const live = new Set();
    for (const b of s.b) {
      const [kind, bx, by, vx, vy, r, owner, extra, id] = b;
      const key = id !== undefined ? id : `${kind}${bx}${by}`;
      live.add(key);
      let o = this.balls.get(key);
      if (!o) { o = this.makeBall(kind); this.balls.set(key, o); }
      o.age += dt;
      const x = bx + vx * since;
      const y = by + vy * since;
      if (kind === 'linked') {
        o.g.visible = false;
        const a = this.pawnPos(s, owner);
        const tgt = this.pawnPos(s, extra);
        if (a && tgt) this.chain(o, a.x, a.y, tgt.x, tgt.y);
        continue;
      }
      if (kind === 'meteor') {
        this.updateMeteor(o, x, y, r, extra, since, dt);
        continue;
      }
      o.g.position.set(x, BALL_Y, y);
      if (kind === 'gravity') {
        o.disk.position.set(x, 4, y);
        o.disk.material.uniforms.uTime.value = this.time;
        o.halo.material.uniforms.uTime.value = this.time;
        for (let i = this.emit(o, 70, dt); i > 0; i--) {
          const a = rand(0, TAU);
          const d = rand(300, 560);
          this.fire.add({ p: [x + Math.cos(a) * d, rand(10, 120), y + Math.sin(a) * d], v: [-Math.cos(a) * d * 1.8 - Math.sin(a) * 300, 0, -Math.sin(a) * d * 1.8 + Math.cos(a) * 300], c0: col(Math.random() < 0.5 ? '#c890ff' : '#ffffff'), c1: col('#3a0a8a'), size: 4, life: 0.5, tile: TILE_SPARK, stretch: 0.05, drag: 1 });
        }
        this.light(x, 120, y, '#9a50ff', 3.5);
        continue;
      }
      if (kind === 'boomerang') {
        o.spin.rotation.y += dt * 24;
        for (let i = this.emit(o, 60, dt); i > 0; i--) this.fire.add({ p: [x, BALL_Y, y], v: [rand(-20, 20), rand(-10, 10), rand(-20, 20)], c0: col('#e8f0ff'), c1: col('#5a7ab0'), size: 18, size1: 4, life: 0.3 });
        this.light(x, BALL_Y + 30, y, '#b8d0ff', 1.5);
        continue;
      }
      if (kind === 'link') {
        const a = this.pawnPos(s, owner);
        if (a) this.chain(o, a.x, a.y, x, y);
        o.hook.rotation.set(Math.PI / 2, 0, Math.atan2(vy, vx));
      }
      const rr = Math.max(14, r * 0.95);
      o.core.scale.setScalar(rr * 0.62);
      o.core.material.uniforms.uTime.value = this.time;
      o.glow.scale.setScalar(rr * 6 * (1 + 0.08 * Math.sin(this.time * 30)));
      o.parts.forEach((ring, i) => {
        ring.scale.setScalar(rr * 1.3);
        ring.rotation.set(this.time * (7 + i * 3), this.time * (5 - i * 4), 0);
      });
      this.trail(o, kind, x, y, vx, vy, rr, dt);
    }
    for (const [key, o] of this.balls) {
      if (live.has(key)) continue;
      this.removeBall(o);
      this.balls.delete(key);
    }
  }

  // Trails behind flying spells.
  trail(o, kind, x, y, vx, vy, rr, dt) {
    const [hot, mid, cool] = o.st;
    const bx = -vx * 0.06;
    const bz = -vy * 0.06;
    const fiery = kind === 'fireball' || kind === 'cluster';
    for (let i = this.emit(o, fiery ? 120 : 70, dt); i > 0; i--) {
      this.fire.add({
        p: [x + rand(-rr, rr) * 0.4, BALL_Y + rand(-rr, rr) * 0.4, y + rand(-rr, rr) * 0.4],
        v: [bx + rand(-30, 30), rand(10, fiery ? 90 : 30), bz + rand(-30, 30)],
        c0: hot.clone().multiplyScalar(1.6), c1: cool, size: rr * rand(1.8, 2.6), size1: rr * 0.5, life: rand(0.25, 0.45),
        tile: fiery ? TILE_FLAME : TILE_GLOW, spin: rand(-3, 3), drag: 0.9,
      });
    }
    if (Math.random() < dt * 30) this.fire.add({ p: [x, BALL_Y, y], v: [bx * 4 + rand(-120, 120), rand(0, 140), bz * 4 + rand(-120, 120)], c0: hot.clone().multiplyScalar(2), c1: mid, size: 3, life: rand(0.3, 0.6), tile: TILE_SPARK, stretch: 0.04, grav: 300 });
    if (fiery && Math.random() < dt * 22) this.smoke.add({ p: [x, BALL_Y + 10, y], v: [rand(-20, 20), rand(40, 80), rand(-20, 20)], c0: col('#2a1c16'), size: rr * 2, size1: rr * 6, life: 1.1, a: 0.32, tile: TILE_SMOKE, spin: rand(-1, 1) });
    if (kind === 'homing') {
      for (let k = 0; k < 2; k++) {
        const a = this.time * 9 + k * Math.PI;
        this.fire.add({ p: [x + Math.cos(a) * rr * 1.6, BALL_Y + Math.sin(a) * rr * 1.6, y + Math.sin(a * 0.7) * rr * 1.6], c0: col('#e8c8ff'), c1: col('#4a0ea8'), size: 10, size1: 2, life: 0.35 });
      }
    }
    if (kind === 'bouncer' && Math.random() < dt * 25) this.fire.add({ p: [x, BALL_Y - rr * 0.5, y], v: [rand(-20, 20), 0, rand(-20, 20)], c0: col('#b8ff90'), c1: col('#0a5a0a'), size: 8, life: 0.6, grav: 400 });
    this.light(x, BALL_Y + 25, y, mid.getStyle(), fiery ? 3.4 : 2.4);
  }

  updateMeteor(o, x, y, r, left, since, dt) {
    const prog = Math.min(1, 1 - Math.max(0, left - since) / SPELLS.meteor.delay);
    const h = (1 - prog) * 2400;
    const px = x - h * 0.42;
    const py = 40 + h;
    const pz = y - h * 0.32;
    o.g.position.set(px, py, pz);
    o.rock.rotation.x += dt * 3;
    o.rock.rotation.z += dt * 2;
    o.mark.position.set(x, 3, y);
    o.mark.scale.setScalar(r);
    const u = o.mark.material.uniforms;
    u.uProg.value = 1 - ((this.time * 1.6) % 1) * 0.6;
    u.uWidth.value = 0.06;
    u.uAlpha.value = 0.5 + prog * 0.6;
    o.shadow.position.set(x, 2.5, y);
    o.shadow.scale.setScalar(r * (0.3 + prog * 0.6));
    o.shadow.material.opacity = 0.2 + prog * 0.6;
    for (let i = this.emit(o, 160, dt); i > 0; i--) {
      this.fire.add({ p: [px + rand(-40, 40), py + rand(-40, 40), pz + rand(-40, 40)], v: [rand(-60, 60), rand(40, 160), rand(-60, 60)], c0: col('#fff0b0').multiplyScalar(1.5), c1: col('#a01800'), size: rand(70, 120), size1: 20, life: rand(0.4, 0.7), tile: TILE_FLAME, spin: rand(-2, 2) });
    }
    if (Math.random() < dt * 40) this.smoke.add({ p: [px, py + 30, pz], v: [rand(-30, 30), rand(30, 80), rand(-30, 30)], c0: col('#1e1410'), size: 90, size1: 260, life: 1.8, a: 0.5, tile: TILE_SMOKE, spin: rand(-1, 1) });
    this.light(px, py, pz, '#ff7a2a', 3 + 5 * prog);
  }

  // ------------------------------------------------------------ one-shot effects
  wave(x, y, r, color, life = 0.5, width = 0.08, h = 4) {
    const m = new THREE.Mesh(this.discGeo, shockMaterial(color));
    m.position.set(x, h, y);
    m.scale.setScalar(r);
    m.renderOrder = 5;
    m.material.uniforms.uWidth.value = width;
    this.scene.add(m);
    this.waves.push({ m, t0: this.time, life });
  }

  beam(x, y, color, h = 420, rad = 45) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad * 0.6, h, 24, 1, true), beamMaterial(color));
    m.position.set(x, h / 2, y);
    this.scene.add(m);
    this.beams.push({ m, t0: this.time, life: 0.55 });
  }

  scorch(x, y, r, glow = '#ff6a1a') {
    const m = new THREE.Mesh(this.discGeo, new THREE.MeshBasicMaterial({ map: this.scorchTex, color: 0x000000, transparent: true, opacity: 0.75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.position.set(x, 1, y);
    m.scale.setScalar(r);
    m.rotation.y = rand(0, TAU);
    const g = new THREE.Mesh(this.discGeo, new THREE.MeshBasicMaterial({ map: this.scorchTex, color: col(glow).multiplyScalar(1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    g.position.set(x, 1.5, y);
    g.scale.setScalar(r * 0.7);
    this.scene.add(m, g);
    this.decals.push({ m, g, t0: this.time, life: 7 });
    while (this.decals.length > 30) this.dropDecal(this.decals.shift());
  }

  dropDecal(d) {
    for (const m of [d.m, d.g]) { this.scene.remove(m); m.material.dispose(); }
  }

  makeDebris() {
    const mesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(6, 0), new THREE.MeshStandardMaterial({ color: 0x3a2e26, roughness: 0.9, flatShading: true }), 160);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return { mesh, list: [] };
  }

  rocks(x, y, n, speed) {
    for (let i = 0; i < n && this.debris.list.length < 160; i++) {
      const a = rand(0, TAU);
      const v = speed * rand(0.4, 1.1);
      this.debris.list.push({ p: V(x, 20, y), v: V(Math.cos(a) * v, rand(250, 600), Math.sin(a) * v), r: V(rand(0, 3), rand(0, 3), rand(0, 3)), s: rand(0.6, 2), life: rand(1.5, 2.5), age: 0 });
    }
  }

  updateDebris(dt) {
    const d = this.debris;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const sc = V();
    d.list = d.list.filter((k) => (k.age += dt) < k.life);
    d.list.forEach((k, i) => {
      k.v.y -= 1600 * dt;
      k.p.addScaledVector(k.v, dt);
      const lava = this.onLava(k.p.x, k.p.z, this.builtLayer);
      const floor = lava ? LAVA_Y - 30 : 3 * k.s;
      if (k.p.y < floor) {
        if (!lava) { k.p.y = floor; k.v.y *= -0.35; k.v.x *= 0.6; k.v.z *= 0.6; } else k.life = 0;
      }
      k.r.x += dt * 6;
      k.r.z += dt * 4;
      const s = k.s * Math.min(1, (k.life - k.age) * 3);
      m4.compose(k.p, q.setFromEuler(e.set(k.r.x, k.r.y, k.r.z)), sc.set(s, s, s));
      d.mesh.setMatrixAt(i, m4);
    });
    d.mesh.count = d.list.length;
    d.mesh.instanceMatrix.needsUpdate = true;
  }

  burst(x, y, z, o) {
    const n = o.n || 20;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const e = rand(o.up ?? -0.1, 1);
      const v = (o.speed || 300) * rand(0.3, 1.1);
      this.fire.add({
        p: [x, z, y], v: [Math.cos(a) * v * (1 - Math.abs(e) * 0.5), e * v, Math.sin(a) * v * (1 - Math.abs(e) * 0.5)],
        c0: o.c0, c1: o.c1, size: (o.size || 20) * rand(0.6, 1.3), size1: o.size1 ?? (o.size || 20) * 0.3, life: (o.life || 0.6) * rand(0.6, 1.3),
        tile: o.tile ?? TILE_GLOW, stretch: o.stretch || 0, grav: o.grav || 0, drag: o.drag ?? 0.9, spin: rand(-3, 3),
      });
    }
  }

  smokeCloud(x, y, n, size = 90, color = '#2a1c16', z = 30) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      this.smoke.add({ p: [x + rand(-30, 30), z, y + rand(-30, 30)], v: [Math.cos(a) * rand(40, 180), rand(40, 160), Math.sin(a) * rand(40, 180)], c0: col(color), size: size * rand(0.6, 1.1), size1: size * rand(2, 3), life: rand(1.2, 2.2), a: 0.55, tile: TILE_SMOKE, spin: rand(-1, 1), drag: 0.9 });
    }
  }

  // An explosion: flash, fire puffs, sparks, smoke, scorch mark and light.
  explode(x, y, z, scale, [hot, mid, cool], { rocks = 0 } = {}) {
    const H = col(hot).multiplyScalar(2);
    const M = col(mid);
    const C = col(cool);
    this.burst(x, y, z, { n: 3, c0: H.clone().multiplyScalar(2), c1: M, size: 140 * scale, size1: 220 * scale, life: 0.18, speed: 10 });
    this.burst(x, y, z, { n: Math.round(18 * scale + 6), c0: H, c1: C, size: 70 * scale, size1: 20 * scale, life: 0.5, speed: 260 * scale, tile: TILE_FLAME, drag: 0.86 });
    this.burst(x, y, z, { n: Math.round(26 * scale + 8), c0: H, c1: M, size: 3.5, life: 0.6, speed: 650 * scale, tile: TILE_SPARK, stretch: 0.05, grav: 700, up: 0.1 });
    this.smokeCloud(x, y, Math.round(6 * scale + 2), 70 * scale, '#2a1c16', z);
    if (!this.onLava(x, y, this.builtLayer)) this.scorch(x, y, 70 * scale, mid);
    if (rocks) this.rocks(x, y, rocks, 260 * scale);
    this.flashes.push({ x, y, z: z + 60, color: mid, power: 6 * scale, t0: this.time, life: 0.3 });
  }

  bolt(x1, y1, x2, y2) {
    this.bolts.push({ x1, y1, x2, y2, t0: this.time, last: -1, meshes: [] });
    this.burst(x2, y2, 70, { n: 22, c0: col('#ffffff').multiplyScalar(2), c1: col('#3a8aff'), size: 3, life: 0.4, speed: 520, tile: TILE_SPARK, stretch: 0.05, grav: 500 });
    this.burst(x2, y2, 70, { n: 4, c0: col('#e0f0ff').multiplyScalar(2), c1: col('#3a8aff'), size: 90, size1: 160, life: 0.15, speed: 10 });
  }

  // Jagged lightning path.
  boltPath(x1, y1, x2, y2) {
    const pts = [];
    const segs = 16;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L;
    const ny = dx / L;
    let off = 0;
    for (let j = 0; j <= segs; j++) {
      const f = j / segs;
      off = j === 0 || j === segs ? 0 : off * 0.5 + rand(-1, 1) * Math.min(60, L * 0.06);
      pts.push(V(x1 + dx * f + nx * off, 70 + (j && j < segs ? rand(-12, 12) : 0), y1 + dy * f + ny * off));
    }
    return pts;
  }

  // A camera-facing strip along points (lightning).
  ribbon(pts, width, mat) {
    const cam = this.camera.position;
    const pos = [];
    const side = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const n = b.clone().sub(a).cross(a.clone().sub(cam)).normalize().multiplyScalar(width);
      const quad = [a.clone().add(n), a.clone().sub(n), b.clone().add(n), b.clone().sub(n)];
      for (const [k, sd] of [[0, 1], [1, -1], [2, 1], [1, -1], [3, -1], [2, 1]]) { pos.push(quad[k].x, quad[k].y, quad[k].z); side.push(sd); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('side', new THREE.Float32BufferAttribute(side, 1));
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = 6;
    this.scene.add(m);
    return m;
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

  // Damage numbers: hits that follow quickly on the same warlock add up.
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

  // Particles rushing into a point (the start of a teleport).
  implode(x, y, c) {
    for (let i = 0; i < 30; i++) {
      const a = rand(0, TAU);
      const d = rand(80, 160);
      this.fire.add({ p: [x + Math.cos(a) * d, rand(20, 160), y + Math.sin(a) * d], v: [-Math.cos(a) * d * 4, 0, -Math.sin(a) * d * 4], c0: c.clone().multiplyScalar(2), c1: c, size: 4, life: 0.25, tile: TILE_SPARK, stretch: 0.04, drag: 1 });
    }
    this.fire.add({ p: [x, 80, y], c0: c.clone().multiplyScalar(2.5), c1: c, size: 160, size1: 20, life: 0.3 });
  }

  fx(e, s) {
    const w = e.id !== undefined ? this.pawns.get(e.id) : null;
    switch (e.e) {
      case 'cast': {
        if (w) w.rel = { t: this.time, k: e.k };
        const c = col(SPELL_COLOR[e.k] || '#ffffff');
        if (e.k === 'shield') this.wave(e.x, e.y, 240, '#a0e6ff', 0.35, 0.08, 40);
        if (e.k === 'windwalk') this.smokeCloud(e.x, e.y, 14, 70, '#c8d0e0');
        if (e.k === 'rush') { this.wave(e.x, e.y, 150, '#ff5a2a', 0.35); this.burst(e.x, e.y, 20, { n: 30, c0: col('#ffb070'), c1: col('#a00000'), size: 5, life: 0.5, speed: 300, tile: TILE_SPARK, stretch: 0.06, up: 0.4 }); }
        if (e.k === 'thrust') { this.wave(e.x, e.y, 120, '#dfe9ff', 0.3); this.smokeCloud(e.x, e.y, 6, 50, '#8a8078', 10); }
        if (e.k === 'teleport') this.implode(e.x, e.y, c);
        // Flash at the staff's crystal for spells that are thrown.
        if (w && !NO_AIM.includes(e.k)) {
          const tip = V();
          w.crystal.getWorldPosition(tip);
          this.fire.add({ p: [tip.x, tip.y, tip.z], c0: c.clone().multiplyScalar(3), c1: c, size: 90, size1: 140, life: 0.15 });
          for (let i = 0; i < 10; i++) this.fire.add({ p: [tip.x, tip.y, tip.z], v: [rand(-200, 200), rand(-50, 200), rand(-200, 200)], c0: c.clone().multiplyScalar(2), c1: c, size: 3, life: 0.3, tile: TILE_SPARK, stretch: 0.05 });
        }
        break;
      }
      case 'boom': {
        const st = e.k === 'homing' ? ['#f0d8ff', '#b066ff', '#3a0a8a'] : e.k === 'bouncer' ? ['#e8ffe0', '#6cff5a', '#0a6a0a'] : e.k === 'clash' ? ['#ffffff', '#ffe8a0', '#5aa0ff'] : e.k === 'cluster' ? ['#fff6c8', '#ffb83a', '#a03008'] : ['#fff2c0', '#ff8a1c', '#a02006'];
        this.explode(e.x, e.y, BALL_Y, e.k === 'cluster' ? 0.7 : 1, st);
        this.wave(e.x, e.y, 130, st[1], 0.35, 0.1);
        break;
      }
      case 'bolt':
        this.bolt(e.x1, e.y1, e.x2, e.y2);
        break;
      case 'blink':
        this.implode(e.x1, e.y1, col('#7fe8ff'));
        this.beam(e.x2, e.y2, '#7fe8ff');
        this.burst(e.x2, e.y2, 60, { n: 40, c0: col('#ffffff').multiplyScalar(2), c1: col('#2a8ad8'), size: 4, life: 0.5, speed: 380, tile: TILE_SPARK, stretch: 0.05, up: 0.2 });
        this.wave(e.x2, e.y2, 140, '#7fe8ff', 0.4);
        this.flashes.push({ x: e.x2, y: e.y2, z: 120, color: '#7fe8ff', power: 5, t0: this.time, life: 0.3 });
        break;
      case 'swap':
        for (const [x, y] of [[e.x1, e.y1], [e.x2, e.y2]]) {
          this.beam(x, y, '#5ad2ff', 320, 40);
          this.wave(x, y, 110, '#5ad2ff', 0.45);
          this.burst(x, y, 60, { n: 24, c0: col('#e0faff').multiplyScalar(2), c1: col('#0e5aa8'), size: 14, life: 0.5, speed: 200 });
        }
        break;
      case 'scourge':
        this.wave(e.x, e.y, e.r, '#ff2020', 0.45, 0.07);
        this.wave(e.x, e.y, e.r * 0.65, '#ff9090', 0.3, 0.1);
        this.burst(e.x, e.y, 40, { n: 40, c0: col('#ff9090').multiplyScalar(2), c1: col('#4a0000'), size: 4, life: 0.5, speed: 700, tile: TILE_SPARK, stretch: 0.05, up: 0 });
        this.burst(e.x, e.y, 30, { n: 24, c0: col('#ff4040'), c1: col('#300000'), size: 70, size1: 20, life: 0.4, speed: 420, tile: TILE_FLAME, up: -0.1 });
        this.smokeCloud(e.x, e.y, 8, 60, '#3a0a0a', 20);
        if (!this.onLava(e.x, e.y, this.builtLayer)) this.scorch(e.x, e.y, e.r * 0.5, '#ff2020');
        this.flashes.push({ x: e.x, y: e.y, z: 80, color: '#ff2a2a', power: 7, t0: this.time, life: 0.3 });
        this.shake(16, 0.22);
        break;
      case 'meteor':
        this.explode(e.x, e.y, 30, 2.4, ['#fff0b0', '#ff7a1a', '#801000'], { rocks: 26 });
        this.wave(e.x, e.y, e.r * 1.3, '#ffa040', 0.6, 0.06);
        this.wave(e.x, e.y, e.r * 0.8, '#ffe0a0', 0.4, 0.1);
        this.smokeCloud(e.x, e.y, 22, 140, '#241812', 40);
        this.flashes.push({ x: e.x, y: e.y, z: 150, color: '#ff8a2a', power: 12, t0: this.time, life: 0.45 });
        this.shake(38, 0.45);
        break;
      case 'reflect':
        this.wave(e.x, e.y, 60, '#c8f5ff', 0.25);
        this.burst(e.x, e.y, BALL_Y, { n: 20, c0: col('#ffffff').multiplyScalar(2), c1: col('#3a9aff'), size: 3, life: 0.35, speed: 420, tile: TILE_SPARK, stretch: 0.05 });
        for (const ww of this.pawns.values()) if (ww.shield.visible && Math.hypot(ww.x - e.x, ww.y - e.y) < 400) ww.shield.material.uniforms.uHit.value = 1;
        break;
      case 'link':
        this.burst(e.x, e.y, 60, { n: 16, c0: col('#e0f0ff').multiplyScalar(2), c1: col('#3a6ab0'), size: 3, life: 0.4, speed: 300, tile: TILE_SPARK, stretch: 0.05 });
        break;
      case 'hit':
        if (w) w.hitT = this.time;
        this.damage(e.id, e.x, e.y, e.n);
        if (e.n >= 5) this.burst(e.x, e.y, 70, { n: Math.min(14, Math.round(4 + e.n / 10)), c0: col('#ffd0a0').multiplyScalar(2), c1: col('#ff3a0a'), size: 3, life: 0.35, speed: 380, tile: TILE_SPARK, stretch: 0.05, grav: 600 });
        break;
      case 'burn': {
        const p = s && s.p.find((q) => q.id === e.id);
        if (p) this.burst(p.x, p.y, 30, { n: 6, c0: col('#ffd070'), c1: col('#a01800'), size: 30, size1: 8, life: 0.5, speed: 100, tile: TILE_FLAME, up: 0.7, grav: -100 });
        break;
      }
      case 'death': {
        const lava = this.onLava(e.x, e.y, this.builtLayer);
        this.explode(e.x, e.y, 40, 1.6, ['#fff0b0', '#ff7a1a', '#801000'], { rocks: lava ? 0 : 8 });
        if (lava) this.burst(e.x, e.y, 0, { n: 40, c0: col('#ffd070').multiplyScalar(1.5), c1: col('#a01800'), size: 12, life: 1.0, speed: 380, up: 0.7, grav: 900 });
        this.wave(e.x, e.y, 240, '#ff7a2a', 0.6);
        this.shake(24, 0.3);
        break;
      }
      case 'shrink':
        this.sink(this.builtLayer, e.layer);
        this.buildTiles(e.layer);
        this.shake(8, 0.5);
        break;
      default:
        break;
    }
  }

  updateEffects(dt) {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wv = this.waves[i];
      const k = (this.time - wv.t0) / wv.life;
      if (k >= 1) { this.scene.remove(wv.m); wv.m.material.dispose(); this.waves.splice(i, 1); continue; }
      wv.m.material.uniforms.uProg.value = 0.15 + 0.85 * Math.sqrt(k);
      wv.m.material.uniforms.uAlpha.value = 1 - k;
    }
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      const k = (this.time - b.t0) / b.life;
      if (k >= 1) { this.scene.remove(b.m); b.m.geometry.dispose(); b.m.material.dispose(); this.beams.splice(i, 1); continue; }
      b.m.material.uniforms.uTime.value = this.time;
      b.m.material.uniforms.uAlpha.value = (1 - k) * Math.min(1, k * 10);
      b.m.scale.set(1 - k * 0.6, 1 + k * 0.4, 1 - k * 0.6);
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      const k = (this.time - d.t0) / d.life;
      if (k >= 1) { this.dropDecal(d); this.decals.splice(i, 1); continue; }
      d.m.material.opacity = 0.75 * (1 - k * k);
      d.g.material.opacity = Math.max(0, 1 - k * 5);
    }
    for (let i = this.sinking.length - 1; i >= 0; i--) {
      const sk = this.sinking[i];
      const k = (this.time - sk.t0 - sk.delay) / 2;
      if (k >= 1) { this.scene.remove(sk.m); sk.m.material.dispose(); this.sinking.splice(i, 1); continue; }
      if (k < 0) continue;
      sk.m.position.y = -3 - k * k * 200;
      sk.m.rotation.x = sk.rx * k;
      sk.m.rotation.z = sk.rz * k;
      sk.warn.value = 1.2 + k * 2.5;
      if (!sk.splashed && k > 0.25) {
        sk.splashed = true;
        this.burst(sk.x, sk.y, -10, { n: 10, c0: col('#ffd070').multiplyScalar(1.4), c1: col('#901000'), size: 10, life: 0.9, speed: 260, up: 0.6, grav: 900 });
        this.smoke.add({ p: [sk.x, 10, sk.y], v: [0, 60, 0], c0: col('#2a1a12'), size: 90, size1: 240, life: 2, a: 0.45, tile: TILE_SMOKE });
      }
    }
    // Lightning flickers: a new jagged path every 40 ms while it fades.
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const k = (this.time - b.t0) / 0.32;
      if (k >= 1 || (b.last >= 0 && this.time - b.last >= 0.04)) {
        for (const m of b.meshes) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
        b.meshes = [];
      }
      if (k >= 1) { this.bolts.splice(i, 1); continue; }
      if (!b.meshes.length) {
        b.last = this.time;
        const fade = 1 - k;
        const main = this.boltPath(b.x1, b.y1, b.x2, b.y2);
        const glow = ribbonMaterial('#5aa8ff');
        glow.uniforms.uAlpha.value = fade * 0.8;
        const core = ribbonMaterial('#ffffff');
        core.uniforms.uColor.value.setRGB(3, 3.4, 4);
        core.uniforms.uAlpha.value = fade;
        b.meshes.push(this.ribbon(main, 26, glow), this.ribbon(main, 6, core));
        for (let j = 0; j < 3; j++) {
          const from = main[2 + Math.floor(Math.random() * (main.length - 5))];
          const a = rand(0, TAU);
          const l = rand(60, 160);
          const bc = ribbonMaterial('#bfe0ff');
          bc.uniforms.uAlpha.value = fade * 0.8;
          b.meshes.push(this.ribbon(this.boltPath(from.x, from.z, from.x + Math.cos(a) * l, from.z + Math.sin(a) * l), 4, bc));
        }
      }
      this.light((b.x1 + b.x2) / 2, 140, (b.y1 + b.y2) / 2, '#9fd6ff', 7 * (1 - k));
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const k = (this.time - f.t0) / f.life;
      if (k >= 1) { this.flashes.splice(i, 1); continue; }
      this.light(f.x, f.z, f.y, f.color, f.power * (1 - k) * (1 - k));
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      const k = (this.time - f.t0) / 0.9;
      if (k >= 1) { f.el.remove(); this.floaters.splice(i, 1); continue; }
      const [sx, sy] = this.toScreen(f.x, f.y, 200 + k * 100);
      f.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%) scale(${(k < 0.12 ? 0.6 + k * 6 : 1.3 - k * 0.4).toFixed(2)})`;
      f.el.style.opacity = String(1 - k * k);
    }
    const mk = (this.time - this.moveAt) / 0.45;
    this.moveMark.visible = mk >= 0 && mk < 1;
    if (this.moveMark.visible) {
      this.moveMark.scale.setScalar(55);
      const u = this.moveMark.material.uniforms;
      u.uProg.value = 1 - mk * 0.8;
      u.uWidth.value = 0.12;
      u.uAlpha.value = 1 - mk;
    }
    // The lava lives: embers rise, bubbles burst, smoke drifts.
    for (let i = 0; i < 4; i++) {
      const x = this.target.x + rand(-2600, 2600);
      const z = this.target.z + rand(-2000, 1500);
      if (!this.onLava(x, z, this.builtLayer)) continue;
      this.fire.add({ p: [x, LAVA_Y, z], v: [rand(-30, 30), rand(80, 200), rand(-30, 30)], c0: col('#ffb050').multiplyScalar(1.6), c1: col('#801000'), size: rand(3, 5), life: rand(1.5, 3), tile: TILE_SPARK, stretch: 0.02, drag: 0.995, grav: -15 });
    }
    if (Math.random() < dt * 6) {
      const x = this.target.x + rand(-2200, 2200);
      const z = this.target.z + rand(-1700, 1200);
      if (this.onLava(x, z, this.builtLayer + 2)) {
        this.burst(x, z, LAVA_Y + 4, { n: 10, c0: col('#ffe090').multiplyScalar(1.6), c1: col('#901000'), size: 9, life: 0.8, speed: 160, up: 0.75, grav: 700 });
        this.wave(x, z, 60, '#ff7a20', 0.6, 0.12, LAVA_Y + 2);
      }
    }
    if (Math.random() < dt * 3) {
      const x = this.target.x + rand(-2400, 2400);
      const z = this.target.z + rand(-1800, 1300);
      if (this.onLava(x, z, this.builtLayer + 1)) this.smoke.add({ p: [x, LAVA_Y + 20, z], v: [rand(10, 40), rand(30, 60), rand(-10, 10)], c0: col('#3a2620'), size: 200, size1: 600, life: 5, a: 0.18, tile: TILE_SMOKE, spin: rand(-0.3, 0.3), drag: 1 });
    }
    this.updateDebris(dt);
    this.fire.update(dt);
    this.smoke.update(dt);
  }

  // ------------------------------------------------------------ frame
  frame({ s, prev, k, since, dt, me, names, follow }) {
    this.time += dt;
    this.lightN = 0;
    if (s.layer !== this.builtLayer) this.buildTiles(s.layer);
    // The ring that sinks next glows red in its last seconds.
    this.warn.value = s.ph === 'fight' && s.layer > 1 && s.shrink < 3
      ? (0.5 + 0.5 * Math.sin(this.time * (8 + (3 - s.shrink) * 4))) * (1 - s.shrink / 3) * 1.2 : 0;
    this.lavaMat.uniforms.uTime.value = this.time;
    this.haze.uniforms.uTime.value = this.time;

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
      dist = FOLLOW_DIST * this.zoom;
    } else {
      const R = s.layer * 100 + 300;
      const fovV = (FOV * Math.PI) / 180;
      const fovH = 2 * Math.atan(Math.tan(fovV / 2) * this.camera.aspect);
      dist = Math.max(((R * 1.15) / Math.tan(fovV / 2)) * Math.sin(PITCH) * 0.95, R / Math.tan(fovH / 2)) * 1.05;
    }
    const a = Math.min(1, dt * 5);
    this.target.x += (tx - this.target.x) * a;
    this.target.z += (tz - this.target.z) * a;
    this.dist += (dist - this.dist) * Math.min(1, dt * 3);
    // In the lobby the camera circles slowly; in a match it faces north like Dota.
    if (s.ph === 'lobby') this.yaw += dt * 0.08;
    else this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw)) * Math.max(0, 1 - dt * 3);
    const hd = Math.cos(PITCH) * this.dist;
    const cp = V(this.target.x + Math.sin(this.yaw) * hd, Math.sin(PITCH) * this.dist, this.target.z + Math.cos(this.yaw) * hd);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      cp.x += rand(-1, 1) * this.shakeAmp;
      cp.y += rand(-1, 1) * this.shakeAmp;
    } else this.shakeAmp = 0;
    this.camera.position.copy(cp);
    this.camera.lookAt(this.target.x, 0, this.target.z);
    this.camera.updateMatrixWorld();
    const sh = Math.max(1600, this.dist * 0.9);
    this.sun.position.set(this.target.x - 900, 2200, this.target.z - 700);
    this.sun.target.position.copy(this.target);
    const sc = this.sun.shadow.camera;
    if (sc.right !== sh) { sc.left = -sh; sc.right = sh; sc.top = sh; sc.bottom = -sh; sc.near = 100; sc.far = 6000; sc.updateProjectionMatrix(); }

    this.updateEffects(dt);
    for (let i = this.lightN; i < this.lights.length; i++) this.lights[i].intensity = 0;
    this.measure(dt);
    if (this.quality >= 1) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
