// Pudge Wars 3D view (three.js): the river map, animated Pudges, hooks and
// their chains, cleavers, runes, barrels, totems and effects. It only draws;
// the rules live in shared/pudgewars.js and the window logic in pudge.js.
// Game coordinates are Dota's (x east, y north); in the scene north is -Z.
import * as THREE from './vendor/three/three.module.min.js';
import { EffectComposer } from './vendor/three/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/postprocessing/OutputPass.js';
import { GLTFLoader } from './vendor/three/loaders/GLTFLoader.js';
import * as SkeletonUtils from './vendor/three/utils/SkeletonUtils.js';
import { buildPudgeMap, groundH, WATER_Y } from './pudge-map.js';
import {
  rand, col, Particles, particleAtlas, TILE_FLAME, TILE_SMOKE, TILE_SPARK,
  shockMaterial, bubbleMaterial, ribbonMaterial, addRim,
} from './warlock3d-lib.js';

const PW = window.PudgeWars;
const { RIVER, COLORS } = PW;
const MODEL_HEIGHT = 235; // Pudge is big
const CLIPS = {
  Idle: 'pudge_idle_anim', Walk: '@pudge_walkN_anim', Haste: 'pudge_run_haste_anim', Hook: 'pudge_meathook_start_anim',
  HookPose: 'pudge_hook_pose', HookEnd: 'pudge_meathook_end', Attack: 'pudge_attack1_anim', Cleaver: 'pudge_attack2_anim',
  Death: 'pudge_death', Stun: 'pudge_stun_anim', Flail: 'pudge_flail_anim', Spawn: 'pudge_spawn_anim',
};
const ONCE = ['Hook', 'HookEnd', 'Attack', 'Cleaver', 'Death', 'Spawn', 'HookPose'];
const PITCH = 0.98;
const FOV = 40;
const FOLLOW_DIST = 2050;
const HAND_Y = 95; // chain height
const TAU = Math.PI * 2;
const TEAM_COL = ['#46e046', '#e8443a']; // Radiant green, Dire red (as in Dota)
const RUNE_COL = { haste: '#ff3a2a', gold: '#ffd23a', shield: '#7fd2ff', fire: '#ff7a1a', dynamite: '#ff9a3a', lightning: '#9fd6ff' };
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const angleLerp = (a, b, t) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; };
const approach = (cur, target, dt, speed) => cur + (target - cur) * Math.min(1, dt * speed);
const smooth = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

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
    r.toneMappingExposure = 1.0;
    this.scene = new THREE.Scene();
    this.scene.background = col('#0d1408');
    this.scene.fog = new THREE.Fog(0x16200f, 4500, 11000);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 20, 30000);
    this.target = V();
    this.dist = FOLLOW_DIST;
    this.zoom = 1.35;
    this.yaw = 0;
    this.time = 0;
    this.shakeAmp = 0;
    this.shakeT = 0;

    // Dota daylight: a warm sun with shadows and a soft sky.
    this.scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x3a3018, 0.95));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 2;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    this.lights = [];
    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xff8a30, 0, 900, 1.2);
      this.scene.add(l);
      this.lights.push(l);
    }
    this.lightN = 0;

    this.atlas = particleAtlas();
    this.fire = new Particles(this.scene, 5000, true, this.atlas);
    this.smoke = new Particles(this.scene, 2500, false, this.atlas);
    this.discGeo = new THREE.CircleGeometry(1, 64);
    this.discGeo.rotateX(-Math.PI / 2);
    this.sphereGeo = new THREE.SphereGeometry(1, 32, 20);
    this.ringGeo = new THREE.RingGeometry(0.88, 1, 72);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.map = buildPudgeMap(this.scene, this);

    this.pawns = new Map();
    this.hookHeads = new Map();
    this.cleaverMeshes = new Map();
    this.mineMeshes = new Map();
    this.barrierMeshes = new Map();
    this.runeMeshes = new Map();
    this.waves = [];
    this.bolts = [];
    this.floaters = [];
    this.flashes = [];
    this.decals = [];
    this.selected = null;
    new GLTFLoader().load('models/pudge.glb', (g) => { this.gltf = g; }, undefined, (err) => console.warn('pudge model', err));

    this.moveMark = new THREE.Mesh(this.discGeo, shockMaterial('#4dff6a'));
    this.moveMark.visible = false;
    this.moveMark.renderOrder = 5;
    this.scene.add(this.moveMark);
    this.moveAt = -9;

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.45, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.quality = 2;
    this.perf = { t: 0, n: 0, wait: 3 };
    this.ray = new THREE.Raycaster();
    this.ground = new THREE.Plane(V(0, 1, 0), 0);
    this.resize();
  }

  // ------------------------------------------------------------ helpers
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

  // Screen point -> game point (on the ground plane).
  pick(cx, cy) {
    const v = new THREE.Vector2((cx / this.w) * 2 - 1, -(cy / this.h) * 2 + 1);
    this.ray.setFromCamera(v, this.camera);
    const hit = V();
    if (!this.ray.ray.intersectPlane(this.ground, hit)) return { x: this.target.x, y: -this.target.z };
    return { x: hit.x, y: -hit.z };
  }

  toScreen(x, y, h = 0) {
    const v = V(x, h, -y).project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.w, (-v.y * 0.5 + 0.5) * this.h];
  }

  showMove(x, y) {
    this.moveMark.position.set(x, Math.max(groundH(x, y), 0) + 3, -y);
    this.moveAt = this.time;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      this.fire.add({ p: [x, 6, -y], v: [Math.cos(a) * 160, 30, Math.sin(a) * 160], c0: col('#9dffb0'), c1: col('#1a8a2a'), size: 10, life: 0.3, tile: TILE_SPARK, stretch: 0.05, drag: 0.85 });
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

  // ------------------------------------------------------------ Pudges
  modelScale() {
    if (this.mScale) return this.mScale;
    const box = new THREE.Box3().setFromObject(this.gltf.scene);
    this.mScale = MODEL_HEIGHT / ((box.max.y - box.min.y) || 1);
    return this.mScale;
  }

  makePudge(color, team) {
    const root = new THREE.Group();
    const model = SkeletonUtils.clone(this.gltf.scene);
    model.scale.setScalar(this.modelScale());
    model.rotation.y = Math.PI / 2; // the model faces +Z; facing 0 is east (+X)
    root.add(model);
    const mats = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false;
      const m = o.material.clone();
      addRim(m, new THREE.Color(1, 0.9, 0.8).lerp(col(TEAM_COL[team]), 0.3), 0.22);
      mats.push(m);
      o.material = m;
    });
    let hand = null;
    model.traverse((o) => { if (!hand && o.isBone && /weapon_lf/.test(o.name)) hand = o; });
    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    for (const [k, name] of Object.entries(CLIPS)) {
      const c = this.gltf.animations.find((a) => a.name === name);
      if (!c) continue;
      actions[k] = mixer.clipAction(c);
      if (ONCE.includes(k)) { actions[k].setLoop(THREE.LoopOnce, 1); actions[k].clampWhenFinished = true; }
    }
    if (actions.Idle) actions.Idle.play();
    // Team ring, selection ring and shadow blob.
    const blob = new THREE.Mesh(this.discGeo, new THREE.MeshBasicMaterial({ map: this.glow(), color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }));
    blob.scale.setScalar(80);
    blob.position.y = 1.5;
    const circle = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: col(TEAM_COL[team]).multiplyScalar(1.6), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
    circle.scale.setScalar(60);
    circle.position.y = 2;
    const sel = new THREE.Mesh(this.discGeo, shockMaterial('#40ff60'));
    sel.position.y = 3;
    sel.scale.setScalar(90);
    sel.visible = false;
    sel.material.uniforms.uProg.value = 0.82;
    sel.material.uniforms.uWidth.value = 0.07;
    root.add(blob, circle, sel);
    // Rune auras.
    const aura = new THREE.Mesh(this.sphereGeo, bubbleMaterial('#7fd2ff'));
    aura.visible = false;
    this.scene.add(aura, root);
    const label = document.createElement('div');
    label.className = 'lbl';
    label.innerHTML = '<b></b><div class="bar"><i></i></div><small></small>';
    this.labels.append(label);
    return {
      root, model, mixer, actions, cur: 'Idle', mats, hand, circle, sel, aura, label, color,
      x: 0, y: 0, f: 0, seen: false, speed: 0, run: 0, hitT: -9, death: null, hookWas: false, endT: -9, attackT: -9, spawnT: -9,
    };
  }

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

  animate(w, p, dt) {
    const t = this.time;
    const m = p.m || [];
    const flying = m.includes('hooked') || m.includes('tossed') || m.includes('grappling');
    const walking = p.mv && w.speed > 40 && !p.cast;
    if (w.hookWas && !p.hk) w.endT = t;
    w.hookWas = !!p.hk;
    if (flying) this.play(w, 'Flail', 0.1);
    else if (m.includes('stun')) this.play(w, 'Stun', 0.1);
    else if (p.cast && p.cs === 'hook') {
      if (w.cur !== 'Hook') { this.play(w, 'Hook', 0.08, true); w.actions.Hook.timeScale = 1.4; }
    } else if (p.cast && p.cs === 'cleaver') {
      if (w.cur !== 'Cleaver') { this.play(w, 'Cleaver', 0.08, true); w.actions.Cleaver.timeScale = 2.2; }
    } else if (p.cast) {
      if (w.cur !== 'Attack') { this.play(w, 'Attack', 0.08, true); w.actions.Attack.timeScale = 2; }
    } else if (p.at || t - w.attackT < 0.5) {
      if (w.cur !== 'Attack' || p.at && w.actions.Attack && !w.actions.Attack.isRunning()) { this.play(w, 'Attack', 0.1, true); w.actions.Attack.timeScale = 1.3; }
    } else if (walking) {
      const haste = m.includes('haste');
      this.play(w, haste ? 'Haste' : 'Walk', 0.15);
      const a = w.actions[haste ? 'Haste' : 'Walk'];
      if (a) a.timeScale = Math.max(0.6, w.speed / (haste ? 520 : 300));
    } else if (t - w.spawnT < 1.3) {
      if (w.cur !== 'Spawn') this.play(w, 'Spawn', 0.1, true);
    } else if (t - w.endT < 0.55) {
      if (w.cur !== 'HookEnd') this.play(w, 'HookEnd', 0.1, true);
    } else if (p.hk) {
      // Waiting for the hook to come back: hold the throwing pose.
      if (!['Hook', 'HookPose'].includes(w.cur) || (w.cur === 'Hook' && !w.actions.Hook.isRunning())) this.play(w, 'HookPose', 0.2);
    } else {
      this.play(w, 'Idle', 0.25);
    }
    w.mixer.update(dt);
    const hit = Math.max(0, 1 - (t - w.hitT) / 0.3);
    for (const mat of w.mats) if (mat.userData.flash) mat.userData.flash.value = hit * 0.6;
  }

  // Which Pudge is under the mouse, or null.
  pawnAt(cx, cy, skip) {
    let best = null;
    let bd = 70;
    for (const [id, w] of this.pawns) {
      if (!w.root.visible || w.death || id === skip) continue;
      const [sx, sy] = this.toScreen(w.x, w.y, 110);
      const d = Math.hypot(sx - cx, sy - cy);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  updatePawns(s, prev, k, me, names, dt) {
    const alive = new Set();
    const myTeam = (s.p.find((q) => q.id === me) || {}).tm;
    s.p.forEach((p, idx) => {
      alive.add(p.id);
      let w = this.pawns.get(p.id);
      if (!w) { w = this.makePudge(COLORS[idx % 10], p.tm); this.pawns.set(p.id, w); }
      if (p.d && w.seen && !w.death) w.death = { t: this.time, x: w.x, y: w.y };
      const dying = w.death && this.time - w.death.t < 2.2;
      if (!p.d && w.death) { w.death = null; w.seen = false; w.spawnT = this.time; }
      const show = (!p.d && !p.l) || (dying && !p.l);
      w.root.visible = !!show;
      w.label.style.display = show && !dying ? '' : 'none';
      w.aura.visible = false;
      if (!show) { if (!dying) w.seen = false; return; }
      if (dying) {
        w.root.position.set(w.death.x, Math.max(groundH(w.death.x, w.death.y), WATER_Y - 10), -w.death.y);
        if (w.cur !== 'Death') this.play(w, 'Death', 0.1, true);
        w.mixer.update(dt);
        return;
      }
      const q = prev.p.find((o) => o.id === p.id) || p;
      let tx = q.d ? p.x : q.x + (p.x - q.x) * k;
      let ty = q.d ? p.y : q.y + (p.y - q.y) * k;
      if (!w.seen || Math.hypot(tx - w.x, ty - w.y) > 600) { w.x = tx; w.y = ty; w.seen = true; w.speed = 0; }
      const speed = Math.hypot(tx - w.x, ty - w.y) / Math.max(dt, 0.001);
      w.speed = approach(w.speed, speed, dt, 12);
      w.x = tx;
      w.y = ty;
      w.f = angleLerp(q.f, p.f, k);
      const z = (q.z || 0) + ((p.z || 0) - (q.z || 0)) * k;
      const gh = groundH(tx, ty);
      const inWater = gh < WATER_Y;
      w.root.position.set(tx, Math.max(gh, WATER_Y - 22) + z, -ty);
      w.root.rotation.set(0, w.f, 0);
      this.animate(w, p, dt);
      w.circle.material.opacity = p.id === me ? 0.95 : 0.55;
      w.sel.visible = this.selected === p.id;
      if (w.sel.visible) {
        w.sel.material.uniforms.uColor.value.set(p.tm === myTeam ? '#40ff60' : '#ff3a2a');
        w.sel.material.uniforms.uAlpha.value = 0.75 + 0.25 * Math.sin(this.time * 6);
      }
      // Splashing through the river while being dragged.
      if (inWater && w.speed > 100 && Math.random() < dt * 40) this.splash(tx, ty, 4);
      this.runeEffects(w, p, tx, ty, dt);
      if (w.run > 0.5 && Math.random() < dt * 10) this.smoke.add({ p: [tx + rand(-12, 12), gh + 6, -ty + rand(-12, 12)], v: [rand(-20, 20), rand(15, 40), rand(-20, 20)], c0: col('#6a5a40'), size: 16, size1: 44, life: 0.7, a: 0.25, tile: TILE_SMOKE });
      w.run = approach(w.run, p.mv && w.speed > 40 ? 1 : 0, dt, 10);
      // Name, level and health bar above the head.
      const [lx, ly] = this.toScreen(tx, ty, Math.max(gh, WATER_Y) + z + MODEL_HEIGHT + 20);
      w.label.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px) translate(-50%, -100%)`;
      const f = Math.max(0, p.hp / p.mx);
      const lk = `${names[p.id] || ''}|${p.hp}|${p.lv}|${p.id === me}|${p.tm}|${myTeam}`;
      if (w.label.dataset.k !== lk) {
        w.label.dataset.k = lk;
        const ally = p.id !== me && p.tm === myTeam;
        const nm = (names[p.id] || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        w.label.firstChild.innerHTML = `<span class="tm" style="background:${TEAM_COL[p.tm]}"></span>${nm}`;
        w.label.classList.toggle('me', p.id === me);
        w.label.classList.toggle('ally', ally);
        w.label.classList.toggle('enemy', p.id !== me && !ally);
        const bar = w.label.querySelector('i');
        bar.style.width = `${f * 100}%`;
        bar.style.background = f > 0.5 ? 'linear-gradient(#7fe88a,#2fa846)' : f > 0.25 ? 'linear-gradient(#ffe070,#d29a10)' : 'linear-gradient(#ff7a6a,#c02018)';
        w.label.lastChild.textContent = `${p.lv}`;
      }
    });
    for (const [id, w] of this.pawns) {
      if (alive.has(id)) continue;
      this.scene.remove(w.root, w.aura);
      w.label.remove();
      this.pawns.delete(id);
    }
  }

  // Visible rune buffs on a Pudge.
  runeEffects(w, p, x, y, dt) {
    const m = p.m || [];
    const h = Math.max(groundH(x, y), WATER_Y);
    if (m.includes('shield')) {
      w.aura.visible = true;
      w.aura.position.set(x, h + 110, -y);
      w.aura.scale.set(150, 140, 150);
      w.aura.material.uniforms.uTime.value = this.time;
      this.light(x, h + 120, -y, '#7fd2ff', 2.5);
      // The burning ring around a shield carrier (400 range).
      if (Math.random() < dt * 30) {
        const a = rand(0, TAU);
        this.fire.add({ p: [x + Math.cos(a) * 400, h + 10, -y + Math.sin(a) * 400], v: [0, rand(60, 120), 0], c0: col('#c8f0ff'), c1: col('#2a7ab8'), size: 10, life: 0.5, tile: TILE_SPARK, stretch: 0.05 });
      }
    }
    if (m.includes('haste') && Math.random() < dt * 40) {
      this.fire.add({ p: [x + rand(-30, 30), h + rand(10, 140), -y + rand(-30, 30)], v: [0, rand(60, 160), 0], c0: col('#ffb0a0'), c1: col('#c01000'), size: 7, life: 0.4, tile: TILE_SPARK, stretch: 0.06 });
    }
    if (m.includes('slowRune') && Math.random() < dt * 8) {
      this.smoke.add({ p: [x, h + 30, -y], v: [rand(-20, 20), 20, rand(-20, 20)], c0: col('#6a2a2a'), size: 30, size1: 70, life: 0.8, a: 0.25, tile: TILE_SMOKE });
    }
    if (m.includes('fire') && Math.random() < dt * 25) {
      this.fire.add({ p: [x + rand(-25, 25), h + rand(40, 160), -y + rand(-25, 25)], v: [0, rand(80, 160), 0], c0: col('#ffd070'), c1: col('#c02000'), size: rand(16, 26), size1: 4, life: 0.5, tile: TILE_FLAME });
    }
    if (m.includes('dynamite')) {
      if (Math.random() < dt * 30) this.fire.add({ p: [x, h + 250, -y], v: [rand(-80, 80), rand(60, 160), rand(-80, 80)], c0: col('#ffffa0'), c1: col('#ff4000'), size: 5, life: 0.3, tile: TILE_SPARK, stretch: 0.05, grav: 400 });
      this.light(x, h + 250, -y, '#ffa040', 1 + Math.sin(this.time * 20));
    }
    if (m.includes('lightning') && Math.random() < dt * 12) {
      const a = rand(0, TAU);
      this.fire.add({ p: [x + Math.cos(a) * 50, h + rand(30, 200), -y + Math.sin(a) * 50], v: [rand(-200, 200), rand(-200, 200), rand(-200, 200)], c0: col('#e8f6ff'), c1: col('#3a8aff'), size: 4, life: 0.15, tile: TILE_SPARK, stretch: 0.04 });
    }
    if (m.includes('cleaved') && Math.random() < dt * 6) this.blood(x, y, h + 80, 3, 80);
    if (m.includes('silenced') && Math.random() < dt * 4) this.smoke.add({ p: [x, h + MODEL_HEIGHT, -y], v: [0, 30, 0], c0: col('#8a6aa8'), size: 20, size1: 40, life: 0.6, a: 0.4, tile: TILE_SMOKE });
    if (m.includes('stun') && Math.random() < dt * 20) {
      const a = this.time * 6 + rand(0, 0.4);
      this.fire.add({ p: [x + Math.cos(a) * 40, h + MODEL_HEIGHT + 10, -y + Math.sin(a) * 40], c0: col('#fff6a0'), c1: col('#ffb000'), size: 10, life: 0.25 });
    }
  }

  // ------------------------------------------------------------ hooks and chains
  makeHookHead() {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x8a8e94, metalness: 0.85, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a3634, metalness: 0.6, roughness: 0.5 });
    const curve = new THREE.Mesh(new THREE.TorusGeometry(22, 5, 8, 18, Math.PI * 1.3), metal);
    curve.rotation.set(Math.PI / 2, 0, -Math.PI * 0.15);
    curve.position.x = 18;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(7, 22, 8), metal);
    tip.position.set(18 + 22 * Math.cos(Math.PI * 1.15), 0, 22 * Math.sin(Math.PI * 1.15));
    tip.rotation.set(Math.PI / 2, 0, Math.PI * 0.6);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 50, 8), dark);
    shaft.rotation.z = Math.PI / 2;
    shaft.position.x = -15;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(8, 3, 6, 12), dark);
    ring.position.x = -42;
    ring.rotation.y = Math.PI / 2;
    for (const m of [curve, tip, shaft, ring]) { m.castShadow = true; g.add(m); }
    // Blood on a hit; a fire trail with the fire rune.
    this.scene.add(g);
    return { g, x: 0, y: 0 };
  }

  chainMesh() {
    if (!this.links) {
      const geo = new THREE.TorusGeometry(10, 3.2, 6, 12);
      geo.scale(1.35, 1, 1);
      const mat = new THREE.MeshStandardMaterial({ color: 0xb0b0b8, metalness: 0.75, roughness: 0.3, emissive: 0x202024 });
      this.links = new THREE.InstancedMesh(geo, mat, 2400);
      this.linkMax = 2400;
      this.links.castShadow = true;
      this.links.frustumCulled = false;
      this.scene.add(this.links);
    }
    return this.links;
  }

  // Lays chain links along a path of game points (at chain height).
  layChain(path, from, step = 16, scale = 1) {
    const links = this.chainMesh();
    const m4 = this.m4 || (this.m4 = new THREE.Matrix4());
    const q = new THREE.Quaternion();
    const q2 = new THREE.Quaternion();
    let n = from;
    const max = this.linkMax;
    for (let i = 1; i < path.length && n < max; i++) {
      const [x1, y1, h1] = path[i - 1];
      const [x2, y2, h2] = path[i];
      const L = Math.hypot(x2 - x1, y2 - y1);
      if (L < 1) continue;
      const a = Math.atan2(y2 - y1, x2 - x1);
      const cnt = Math.ceil(L / step);
      for (let j = 0; j < cnt && n < max; j++) {
        const k = j / cnt;
        const x = x1 + (x2 - x1) * k;
        const y = y1 + (y2 - y1) * k;
        const h = h1 + (h2 - h1) * k + Math.sin(k * Math.PI) * -6;
        q.setFromEuler(new THREE.Euler(0, a, 0));
        q2.setFromAxisAngle(V(1, 0, 0), (n % 2) * Math.PI / 2);
        q.multiply(q2);
        m4.compose(V(x, h, -y), q, V(scale, scale, scale));
        links.setMatrixAt(n++, m4);
      }
    }
    return n;
  }

  updateHooks(s, prev, k, dt) {
    let n = 0;
    const seen = new Set();
    const handPos = (id) => {
      const w = this.pawns.get(id);
      if (!w || !w.seen) return null;
      const h = Math.max(groundH(w.x, w.y), WATER_Y);
      return [w.x + Math.cos(w.f) * 40, w.y + Math.sin(w.f) * 40, h + HAND_Y];
    };
    for (const hk of s.h || []) {
      const [id, owner, x, y, radius, hooked, corners, fire] = hk;
      seen.add(id);
      let o = this.hookHeads.get(id);
      if (!o) { o = this.makeHookHead(); this.hookHeads.set(id, o); o.x = x; o.y = y; }
      const ph = (prev.h || []).find((q) => q[0] === id);
      const hx = ph ? ph[2] + (x - ph[2]) * k : x;
      const hy = ph ? ph[3] + (y - ph[3]) * k : y;
      const dx = hx - o.x;
      const dy = hy - o.y;
      if (Math.hypot(dx, dy) > 0.5) o.dir = Math.atan2(dy, dx);
      o.x = hx;
      o.y = hy;
      const hh = Math.max(groundH(hx, hy), WATER_Y) + HAND_Y * 0.8;
      const sc = radius / 100;
      o.g.position.set(hx, hh, -hy);
      // The point leads on the way out; on the way back it trails.
      o.g.rotation.set(0, (o.dir || 0) + (hk[8] ? 0 : Math.PI), 0);
      o.g.scale.setScalar(1.8 * sc);
      const hand = handPos(owner);
      if (hand) {
        const path = [hand, ...corners.map(([cx, cy]) => [cx, cy, Math.max(groundH(cx, cy), WATER_Y) + HAND_Y * 0.8]), [hx, hy, hh]];
        n = this.layChain(path, n, 22, 1);
      }
      if (fire && Math.random() < dt * 60) this.fire.add({ p: [hx + rand(-20, 20), hh, -hy + rand(-20, 20)], v: [rand(-30, 30), rand(80, 160), rand(-30, 30)], c0: col('#ffd070'), c1: col('#c02000'), size: rand(30, 50), size1: 8, life: 0.6, tile: TILE_FLAME });
      if (hooked && Math.random() < dt * 25) this.blood(hx, hy, hh, 1, 60);
      // Splash where the hook skims the river.
      if (Math.abs(hx) < RIVER && Math.random() < dt * 20) this.splash(hx, hy, 2);
    }
    for (const [id, o] of this.hookHeads) if (!seen.has(id)) { this.scene.remove(o.g); this.hookHeads.delete(id); }
    // Grappling hooks: a thin chain to a claw.
    for (const gp of s.g || []) {
      const [, owner, x, y] = gp;
      const hand = handPos(owner);
      if (hand) n = this.layChain([hand, [x, y, hand[2]]], n, 12, 0.55);
    }
    const links = this.chainMesh();
    links.count = n;
    links.instanceMatrix.needsUpdate = true;
  }

  updateCleavers(s, prev, k, dt) {
    const seen = new Set();
    for (const c of s.c || []) {
      const [id, x, y, vx, vy] = c;
      seen.add(id);
      let o = this.cleaverMeshes.get(id);
      if (!o) {
        const g = new THREE.Group();
        const blade = new THREE.Mesh(new THREE.BoxGeometry(70, 4, 44), new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.9, roughness: 0.25 }));
        const handle = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 40, 6), new THREE.MeshStandardMaterial({ color: 0x4a2a14 }));
        handle.rotation.z = Math.PI / 2;
        handle.position.x = -52;
        g.add(blade, handle);
        this.scene.add(g);
        o = { g };
        this.cleaverMeshes.set(id, o);
      }
      const pc = (prev.c || []).find((q) => q[0] === id);
      const cx = pc ? pc[1] + (x - pc[1]) * k : x;
      const cy = pc ? pc[2] + (y - pc[2]) * k : y;
      o.g.position.set(cx, Math.max(groundH(cx, cy), WATER_Y) + 80, -cy);
      o.g.rotation.set(0, Math.atan2(vy, vx) + this.time * 22, 0);
      if (Math.random() < dt * 30) this.fire.add({ p: [cx, 80, -cy], c0: col('#ffffff'), c1: col('#8090a0'), size: 30, size1: 4, life: 0.15 });
    }
    for (const [id, o] of this.cleaverMeshes) if (!seen.has(id)) { this.scene.remove(o.g); this.cleaverMeshes.delete(id); }
  }

  updateMines(s, dt) {
    const seen = new Set();
    for (const [id, team, x, y, arming] of s.mi || []) {
      seen.add(id);
      let o = this.mineMeshes.get(id);
      if (!o) {
        const g = new THREE.Group();
        const wood = new THREE.MeshStandardMaterial({ color: 0x7a4a24, roughness: 0.9 });
        const band = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.7, roughness: 0.4 });
        const body = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 60, 14), wood);
        body.scale.set(1, 1, 1);
        body.position.y = 30;
        const b1 = new THREE.Mesh(new THREE.TorusGeometry(27, 2.5, 6, 18), band);
        b1.rotation.x = Math.PI / 2;
        b1.position.y = 12;
        const b2 = b1.clone();
        b2.position.y = 48;
        const fuse = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow(), color: col(TEAM_COL[team]).multiplyScalar(1.6), blending: THREE.AdditiveBlending, depthWrite: false }));
        fuse.position.y = 70;
        fuse.scale.setScalar(40);
        for (const m of [body, b1, b2]) m.castShadow = true;
        g.add(body, b1, b2, fuse);
        this.scene.add(g);
        o = { g, fuse };
        this.mineMeshes.set(id, o);
      }
      o.g.position.set(x, Math.max(groundH(x, y), WATER_Y), -y);
      o.fuse.material.opacity = arming ? 0.3 : 0.6 + 0.4 * Math.sin(this.time * 8);
    }
    for (const [id, o] of this.mineMeshes) if (!seen.has(id)) { this.scene.remove(o.g); this.mineMeshes.delete(id); }
  }

  updateBarriers(s) {
    const seen = new Set();
    for (const [id, team, x, y, r, hp, mx] of s.b || []) {
      seen.add(id);
      let o = this.barrierMeshes.get(id);
      if (!o) {
        const g = new THREE.Group();
        const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a2a, roughness: 0.95 });
        const paint = new THREE.MeshStandardMaterial({ color: col(TEAM_COL[team]), roughness: 0.8 });
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.7, 190, 10), wood);
        pole.position.y = 95;
        const head = new THREE.Mesh(new THREE.BoxGeometry(r * 1.3, 60, r * 1.3), wood);
        head.position.y = 200;
        const stripe = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, 14, 10), paint);
        stripe.position.y = 140;
        const horn = new THREE.Mesh(new THREE.ConeGeometry(10, 50, 6), wood);
        horn.position.set(r * 0.75, 225, 0);
        horn.rotation.z = -0.6;
        const horn2 = horn.clone();
        horn2.position.x = -r * 0.75;
        horn2.rotation.z = 0.6;
        for (const m of [pole, head, stripe, horn, horn2]) { m.castShadow = true; g.add(m); }
        this.scene.add(g);
        const bar = document.createElement('div');
        bar.className = 'obar';
        bar.innerHTML = '<i></i>';
        this.labels.append(bar);
        o = { g, bar };
        this.barrierMeshes.set(id, o);
      }
      const gh = Math.max(groundH(x, y), WATER_Y);
      o.g.position.set(x, gh, -y);
      const [sx, sy] = this.toScreen(x, y, gh + 260);
      o.bar.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
      o.bar.firstChild.style.width = `${Math.max(0, hp / mx) * 100}%`;
    }
    for (const [id, o] of this.barrierMeshes) if (!seen.has(id)) { this.scene.remove(o.g); o.bar.remove(); this.barrierMeshes.delete(id); }
  }

  updateRunes(s, prev, k, dt) {
    const seen = new Set();
    for (const [id, type, x, y] of s.r || []) {
      seen.add(id);
      let o = this.runeMeshes.get(id);
      const c = col(RUNE_COL[type] || '#ffffff');
      if (!o) {
        const g = new THREE.Group();
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(30, 0), new THREE.MeshStandardMaterial({ color: c, emissive: c.clone().multiplyScalar(0.9), metalness: 0.3, roughness: 0.2, flatShading: true }));
        gem.scale.y = 1.4;
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow(), color: c.clone().multiplyScalar(1.5), blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.scale.setScalar(150);
        const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(1.5), transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }));
        ring.scale.setScalar(55);
        ring.position.y = -55;
        g.add(gem, halo, ring);
        this.scene.add(g);
        o = { g, gem };
        this.runeMeshes.set(id, o);
      }
      const pr = (prev.r || []).find((q) => q[0] === id);
      const rx = pr ? pr[2] + (x - pr[2]) * k : x;
      const ry = pr ? pr[3] + (y - pr[3]) * k : y;
      o.g.position.set(rx, Math.max(groundH(rx, ry), WATER_Y) + 70 + Math.sin(this.time * 3 + id) * 10, -ry);
      o.gem.rotation.y += dt * 2;
      this.light(rx, 120, -ry, RUNE_COL[type] || '#ffffff', 2);
      if (Math.random() < dt * 15) this.fire.add({ p: [rx + rand(-30, 30), 40, -ry + rand(-30, 30)], v: [0, rand(40, 90), 0], c0: c.clone().multiplyScalar(2), c1: c, size: 6, life: 0.6, tile: TILE_SPARK, stretch: 0.04 });
    }
    for (const [id, o] of this.runeMeshes) if (!seen.has(id)) { this.scene.remove(o.g); this.runeMeshes.delete(id); }
  }

  // ------------------------------------------------------------ effects
  blood(x, y, h, n, speed = 220) {
    for (let i = 0; i < n; i++) {
      this.smoke.add({ p: [x + rand(-10, 10), h, -y + rand(-10, 10)], v: [rand(-speed, speed), rand(speed * 0.3, speed), rand(-speed, speed)], c0: col('#8a0a06'), size: rand(8, 18), size1: rand(14, 26), life: rand(0.4, 0.8), a: 0.9, tile: TILE_SMOKE, grav: 900, drag: 0.98 });
    }
  }

  splash(x, y, n) {
    for (let i = 0; i < n; i++) {
      this.smoke.add({ p: [x + rand(-20, 20), WATER_Y + 4, -y + rand(-20, 20)], v: [rand(-120, 120), rand(120, 260), rand(-120, 120)], c0: col('#d8eef0'), size: rand(8, 16), size1: rand(20, 34), life: rand(0.4, 0.7), a: 0.6, tile: TILE_SMOKE, grav: 900 });
    }
  }

  wave(x, y, r, color, life = 0.5, width = 0.08, h = 4) {
    const m = new THREE.Mesh(this.discGeo, shockMaterial(color));
    m.position.set(x, h, -y);
    m.scale.setScalar(r);
    m.material.uniforms.uWidth.value = width;
    m.renderOrder = 4;
    this.scene.add(m);
    this.waves.push({ m, t0: this.time, life });
  }

  bloodPool(x, y) {
    if (!this.poolTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      for (let i = 0; i < 14; i++) {
        const px = 64 + rand(-30, 30);
        const py = 64 + rand(-30, 30);
        const r = rand(12, 34);
        const grd = g.createRadialGradient(px, py, 0, px, py, r);
        grd.addColorStop(0, 'rgba(110,4,2,.95)');
        grd.addColorStop(0.7, 'rgba(90,2,0,.8)');
        grd.addColorStop(1, 'rgba(60,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 128, 128);
      }
      this.poolTex = new THREE.CanvasTexture(c);
    }
    const m = new THREE.Mesh(this.discGeo, new THREE.MeshBasicMaterial({ map: this.poolTex, transparent: true, depthWrite: false, opacity: 0.85 }));
    m.position.set(x, Math.max(groundH(x, y), WATER_Y) + 2, -y);
    m.scale.setScalar(rand(70, 100));
    m.rotation.y = rand(0, TAU);
    m.renderOrder = 2;
    this.scene.add(m);
    this.decals.push({ m, t0: this.time, life: 12 });
    if (this.decals.length > 30) { const d = this.decals.shift(); this.scene.remove(d.m); }
  }

  explode(x, y, r, colors = ['#fff0b0', '#ff7a1a', '#601000']) {
    const h = Math.max(groundH(x, y), WATER_Y);
    const [a, b, c] = colors.map(col);
    for (let i = 0; i < 60; i++) {
      const ang = rand(0, TAU);
      const sp = rand(0.3, 1) * r * 2.4;
      this.fire.add({ p: [x, h + 30, -y], v: [Math.cos(ang) * sp, rand(80, 400), Math.sin(ang) * sp], c0: a.clone().multiplyScalar(2), c1: b, size: rand(40, 80), size1: 10, life: rand(0.4, 0.8), tile: TILE_FLAME, drag: 0.9 });
    }
    for (let i = 0; i < 24; i++) this.smoke.add({ p: [x + rand(-r / 2, r / 2), h + 40, -y + rand(-r / 2, r / 2)], v: [rand(-80, 80), rand(60, 160), rand(-80, 80)], c0: c, size: rand(80, 130), size1: 260, life: rand(1.2, 2), a: 0.5, tile: TILE_SMOKE, spin: rand(-1, 1) });
    for (let i = 0; i < 30; i++) this.fire.add({ p: [x, h + 20, -y], v: [rand(-600, 600), rand(200, 600), rand(-600, 600)], c0: col('#ffe0a0'), c1: col('#ff6010'), size: 4, life: 0.6, tile: TILE_SPARK, stretch: 0.06, grav: 900 });
    this.wave(x, y, r, colors[1], 0.6, 0.1, h + 4);
    this.flashes.push({ x, y, z: h + 120, color: colors[1], power: 10, t0: this.time, life: 0.5 });
  }

  bolt(x, y) {
    const pts = [];
    let px = x + rand(-100, 100);
    let py = y + rand(-100, 100);
    for (let i = 0; i <= 12; i++) {
      const k = i / 12;
      pts.push(V(px + (x - px) * k + rand(-30, 30) * (1 - k), 1400 * (1 - k), -(py + (y - py) * k) + rand(-30, 30) * (1 - k)));
    }
    const geo = new THREE.BufferGeometry();
    const pos = [];
    const side = [];
    for (const p of pts) { pos.push(p.x - 12, p.y, p.z, p.x + 12, p.y, p.z); side.push(-1, 1); }
    const idx = [];
    for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('side', new THREE.Float32BufferAttribute(side, 1));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, ribbonMaterial('#bfe4ff'));
    this.scene.add(m);
    this.bolts.push({ m, t0: this.time, x, y });
    this.flashes.push({ x, y, z: 300, color: '#9fd6ff', power: 12, t0: this.time, life: 0.4 });
  }

  floater(x, y, text, color = '#ff5a4a', big = false) {
    const el = document.createElement('div');
    el.className = `floater${big ? ' big' : ''}`;
    el.textContent = text;
    el.style.color = color;
    this.labels.append(el);
    const f = { el, x: x + rand(-20, 20), y, t0: this.time, life: big ? 1.6 : 0.9 };
    this.floaters.push(f);
    return f;
  }

  damage(id, x, y, n) {
    let f = this.floaters.find((o) => o.id === id && this.time - o.t0 < 0.45);
    if (f) {
      f.n += n;
      f.x = x;
      f.y = y;
      f.t0 = Math.max(f.t0, this.time - 0.15);
    } else {
      f = this.floater(x, y, '');
      Object.assign(f, { id, n });
    }
    f.el.textContent = `-${Math.round(f.n)}`;
  }

  fx(e) {
    const w = e.id ? this.pawns.get(e.id) : null;
    const at = (o) => [o.x, o.y, Math.max(groundH(o.x, o.y), WATER_Y)];
    switch (e.e) {
      case 'hit':
        if (w) { w.hitT = this.time; this.damage(e.id, w.x, w.y, e.n); }
        break;
      case 'hooked': {
        const [x, y, h] = at(w || e);
        this.blood(x, y, h + 110, e.ally ? 4 : 26, 260);
        if (!e.ally) this.flashes.push({ x, y, z: h + 120, color: '#ff3020', power: 4, t0: this.time, life: 0.3 });
        break;
      }
      case 'headshot':
        if (w) { this.floater(w.x, w.y, 'HEADSHOT!', '#ff2a1a', true); this.blood(w.x, w.y, 160, 60, 420); this.shake(14, 0.25); }
        break;
      case 'deny':
        if (w) this.floater(w.x, w.y, 'DENIED!', '#e8e8e8', true);
        break;
      case 'firstBlood':
        if (w) this.floater(w.x, w.y, 'FIRST BLOOD!', '#ff5a3a', true);
        break;
      case 'death': {
        this.bloodPool(e.x, e.y);
        this.blood(e.x, e.y, 120, 30, 300);
        break;
      }
      case 'bounce': {
        const h = Math.max(groundH(e.x, e.y), WATER_Y) + HAND_Y * 0.8;
        for (let i = 0; i < 18; i++) this.fire.add({ p: [e.x, h, -e.y], v: [rand(-300, 300), rand(50, 300), rand(-300, 300)], c0: col('#fff6c0'), c1: col('#ff9a20'), size: 4, life: 0.35, tile: TILE_SPARK, stretch: 0.05, grav: 600 });
        this.flashes.push({ x: e.x, y: e.y, z: h, color: '#ffc060', power: 3, t0: this.time, life: 0.2 });
        break;
      }
      case 'cleave':
        if (w) this.blood(w.x, w.y, 120, 16, 240);
        break;
      case 'mineBoom':
        this.explode(e.x, e.y, 300);
        this.shake(18, 0.35);
        break;
      case 'dynamite':
        this.explode(e.x, e.y, 400, ['#ffffd0', '#ff5a10', '#401000']);
        this.shake(26, 0.5);
        break;
      case 'lightning':
        this.bolt(e.x, e.y);
        this.shake(8, 0.2);
        break;
      case 'toss':
      case 'land':
        this.wave(e.x, e.y, e.e === 'land' ? 200 : 80, '#d8b070', 0.5, 0.12, Math.max(groundH(e.x, e.y), WATER_Y) + 4);
        for (let i = 0; i < 16; i++) this.smoke.add({ p: [e.x + rand(-40, 40), 10, -e.y + rand(-40, 40)], v: [rand(-160, 160), rand(30, 90), rand(-160, 160)], c0: col('#7a6a50'), size: 40, size1: 110, life: 1, a: 0.4, tile: TILE_SMOKE });
        if (e.e === 'land') this.shake(10, 0.2);
        break;
      case 'totem':
        this.wave(e.x, e.y, 140, '#e8c070', 0.6, 0.12, Math.max(groundH(e.x, e.y), WATER_Y) + 4);
        break;
      case 'barrierHit':
      case 'barrierBreak':
        for (let i = 0; i < (e.e === 'barrierBreak' ? 30 : 10); i++) this.smoke.add({ p: [e.x, 120, -e.y], v: [rand(-260, 260), rand(80, 300), rand(-260, 260)], c0: col('#6a4a2a'), size: 10, size1: 14, life: 0.8, a: 1, tile: TILE_SMOKE, grav: 900 });
        break;
      case 'mine':
        this.wave(e.x, e.y, 60, '#ffa040', 0.4, 0.15, Math.max(groundH(e.x, e.y), WATER_Y) + 4);
        break;
      case 'level':
        if (w) {
          for (let i = 0; i < 40; i++) {
            const a = rand(0, TAU);
            this.fire.add({ p: [w.x + Math.cos(a) * 50, 10, -w.y + Math.sin(a) * 50], v: [0, rand(200, 420), 0], c0: col('#fff6c0'), c1: col('#ffb000'), size: 6, life: 0.8, tile: TILE_SPARK, stretch: 0.05 });
          }
          this.wave(w.x, w.y, 110, '#ffd040', 0.7, 0.08, 6);
        }
        break;
      case 'rune':
        if (w) {
          const c = col(RUNE_COL[e.type] || '#ffffff');
          for (let i = 0; i < 40; i++) this.fire.add({ p: [w.x, 100, -w.y], v: [rand(-300, 300), rand(0, 300), rand(-300, 300)], c0: c.clone().multiplyScalar(2), c1: c, size: 7, life: 0.6, tile: TILE_SPARK, stretch: 0.04 });
          this.wave(w.x, w.y, 160, RUNE_COL[e.type] || '#ffffff', 0.6, 0.1, 6);
        }
        break;
      case 'heal':
        if (w) { this.floater(w.x, w.y, `+${e.n}`, '#7aff8a'); for (let i = 0; i < 20; i++) this.fire.add({ p: [w.x + rand(-40, 40), rand(20, 140), -w.y + rand(-40, 40)], v: [0, rand(60, 140), 0], c0: col('#c0ffc0'), c1: col('#0a6a2a'), size: 8, life: 0.6 }); }
        break;
      case 'latch':
        for (let i = 0; i < 12; i++) this.fire.add({ p: [e.x, HAND_Y, -e.y], v: [rand(-200, 200), rand(50, 200), rand(-200, 200)], c0: col('#ffffff'), c1: col('#8090a0'), size: 4, life: 0.3, tile: TILE_SPARK, stretch: 0.05 });
        break;
      case 'trap':
        this.wave(e.x, e.y, 70, { spike: '#ff4a1a', fire: '#ff7a1a', venom: '#5aff3a', pendulum: '#c060ff' }[e.k] || '#ffffff', 0.4, 0.15, Math.max(groundH(e.x, e.y), WATER_Y) + 16);
        break;
      case 'trapSpike':
        this.map.spikeUp(e.i, this.time);
        this.shake(10, 0.2);
        for (let i = 0; i < 24; i++) this.smoke.add({ p: [e.x + rand(-150, 150), 10, -e.y + rand(-150, 150)], v: [rand(-60, 60), rand(60, 160), rand(-60, 60)], c0: col('#7a6a50'), size: 40, size1: 100, life: 0.9, a: 0.4, tile: TILE_SMOKE });
        break;
      case 'trapSlice':
        if (w) { this.blood(w.x, w.y, 120, 60, 500); this.shake(12, 0.25); }
        break;
      case 'attack':
        if (w) w.attackT = this.time;
        { const t = this.pawns.get(e.t); if (t) this.blood(t.x, t.y, 110, 6, 160); }
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
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const k = (this.time - b.t0) / 0.35;
      if (k >= 1) { this.scene.remove(b.m); b.m.geometry.dispose(); b.m.material.dispose(); this.bolts.splice(i, 1); continue; }
      b.m.material.uniforms.uAlpha.value = 1 - k;
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const k = (this.time - f.t0) / f.life;
      if (k >= 1) { this.flashes.splice(i, 1); continue; }
      this.light(f.x, f.z, -f.y, f.color, f.power * (1 - k) * (1 - k));
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      const k = (this.time - d.t0) / d.life;
      if (k >= 1) { this.scene.remove(d.m); d.m.material.dispose(); this.decals.splice(i, 1); continue; }
      d.m.material.opacity = 0.85 * (1 - k * k);
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      const k = (this.time - f.t0) / f.life;
      if (k >= 1) { f.el.remove(); this.floaters.splice(i, 1); continue; }
      const [sx, sy] = this.toScreen(f.x, f.y, 260 + k * 100);
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
    this.map.update(dt, this.time, this.target);
    this.fire.update(dt);
    this.smoke.update(dt);
  }

  // ------------------------------------------------------------ aiming
  updateAim(aim, me) {
    if (!this.aimG) {
      const lineMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uColor: { value: col('#8fe8ff') } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `
          uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
          void main() {
            float edge = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
            float border = 1.0 - smoothstep(0.03, 0.09, min(vUv.x, 1.0 - vUv.x));
            float chev = smoothstep(0.55, 0.9, fract(vUv.y * 9.0 + abs(vUv.x - 0.5) * 2.0 - uTime * 1.6));
            float tip = smoothstep(0.82, 1.0, vUv.y);
            float a = edge * (0.14 + 0.22 * chev) + border * 0.6;
            a *= 1.0 - tip * 0.9;
            gl_FragColor = vec4(uColor * a, 1.0);
          }`,
      });
      const line = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lineMat);
      const head = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 3), new THREE.MeshBasicMaterial({ color: col('#bff4ff').multiplyScalar(1.4), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
      const circle = new THREE.Mesh(this.discGeo, shockMaterial('#8fe8ff'));
      const reach = new THREE.Mesh(this.discGeo, shockMaterial('#8fe8ff'));
      for (const m of [line, head, circle, reach]) m.renderOrder = 7;
      this.aimG = { line, head, circle, reach };
      this.scene.add(line, head, circle, reach);
    }
    const g = this.aimG;
    const w = this.pawns.get(me);
    const show = !!(aim && w && w.seen);
    g.line.visible = g.head.visible = show && aim.kind === 'line';
    g.circle.visible = show && aim.kind === 'area';
    g.reach.visible = show && aim.range > 0 && aim.kind === 'area';
    if (!show) return;
    const dx = aim.at.x - w.x;
    const dy = aim.at.y - w.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const a = Math.atan2(uy, ux);
    if (aim.kind === 'line') {
      const L = aim.range;
      g.line.material.uniforms.uTime.value = this.time;
      g.line.scale.set(aim.width * 2, L, 1);
      g.line.position.set(w.x + ux * L / 2, 8, -(w.y + uy * L / 2));
      g.line.rotation.set(-Math.PI / 2, 0, a - Math.PI / 2);
      g.head.scale.set(aim.width * 1.1, 60, aim.width * 0.25);
      g.head.position.set(w.x + ux * (L + 20), 8, -(w.y + uy * (L + 20)));
      g.head.rotation.set(-Math.PI / 2, 0, a - Math.PI / 2);
    } else {
      const r = aim.range > 0 ? Math.min(d, aim.range) : d;
      g.circle.position.set(w.x + ux * r, 8, -(w.y + uy * r));
      g.circle.scale.setScalar(aim.radius);
      const u = g.circle.material.uniforms;
      u.uProg.value = 0.95;
      u.uWidth.value = 0.06;
      u.uAlpha.value = 0.8 + 0.2 * Math.sin(this.time * 6);
      g.reach.position.set(w.x, 7, -w.y);
      g.reach.scale.setScalar(aim.range || 1);
      const v = g.reach.material.uniforms;
      v.uProg.value = 0.985;
      v.uWidth.value = 0.012;
      v.uAlpha.value = 0.35;
    }
  }

  // ------------------------------------------------------------ frame
  frame({ s, prev, k, dt, me, names, cam, aim }) {
    this.time += dt;
    this.lightN = 0;
    if (this.gltf) {
      this.updatePawns(s, prev, k, me, names, dt);
      this.updateHooks(s, prev, k, dt);
    }
    this.updateCleavers(s, prev, k, dt);
    this.updateMines(s, dt);
    this.updateBarriers(s);
    this.updateRunes(s, prev, k, dt);
    this.map.updateTraps(s, dt, this.time);

    // Camera: on your Pudge like Dota, free while you are dead, or the whole map.
    const mine = this.pawns.get(me);
    let tx = 0;
    let tz = 0;
    let dist;
    let rate = 5;
    if (cam && cam.mode === 'follow' && mine && mine.seen) {
      tx = mine.x;
      tz = -mine.y;
      dist = FOLLOW_DIST * this.zoom;
      if (cam.snap) rate = 1000;
    } else if (cam && cam.mode === 'free') {
      tx = cam.x;
      tz = -cam.y;
      dist = FOLLOW_DIST * this.zoom;
      rate = 14;
    } else {
      dist = 4300;
    }
    const a = Math.min(1, dt * rate);
    this.target.x += (tx - this.target.x) * a;
    this.target.z += (tz - this.target.z) * a;
    this.dist += (dist - this.dist) * Math.min(1, dt * 3);
    if (s.ph === 'lobby') this.yaw += dt * 0.06;
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
    this.sun.position.set(this.target.x - 900, 2400, this.target.z - 700);
    this.sun.target.position.copy(this.target);
    const sc = this.sun.shadow.camera;
    if (sc.right !== sh) { sc.left = -sh; sc.right = sh; sc.top = sh; sc.bottom = -sh; sc.near = 100; sc.far = 6000; sc.updateProjectionMatrix(); }

    this.updateAim(aim, me);
    this.updateEffects(dt);
    for (let i = this.lightN; i < this.lights.length; i++) this.lights[i].intensity = 0;
    this.measure(dt);
    if (this.quality >= 1) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}

export { groundH, TEAM_COL, RUNE_COL };
