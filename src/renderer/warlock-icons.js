// Paints spell and item icons in a Warcraft III style: a dark painted
// background in the spell's colour, the shape lit from the top-left with a
// glow and a dark outline, and a bevelled frame. Shapes: vendor/game-icons.js.
import { GAME_ICONS } from './vendor/game-icons.js';

export const ICON_COLOR = {
  fireball: '#ff7a1a', scourge: '#ff2a3a', lightning: '#7fc8ff', homing: '#b066ff', boomerang: '#d8e2f0', teleport: '#5fe0ff',
  thrust: '#ffd27a', swap: '#4ab8ff', cluster: '#ffb02a', bouncer: '#6cff5a', meteor: '#ff5a1a', windwalk: '#b8c8e8',
  shield: '#7fd2ff', rush: '#ff4a1a', gravity: '#a060ff', link: '#9ec9ff',
  ring: '#ff6a8a', cape: '#c0a0ff', armor: '#c8c8d0', boots: '#d8a060', hero: '#ff8a3a',
};

const cache = new Map();

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
const mix = (c, k) => `rgb(${c.map((v) => Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k))).join(',')})`;
const rgba = (c, a) => `rgba(${c.join(',')},${a})`;

export function iconURL(key, size = 128) {
  const id = `${key}|${size}`;
  if (cache.has(id)) return cache.get(id);
  const paths = GAME_ICONS[key];
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const col = rgb(ICON_COLOR[key] || '#ffaa55');
  const S = size;
  // Painted background: dark, with soft brush strokes of the spell colour.
  const bg = g.createRadialGradient(S * 0.45, S * 0.4, S * 0.05, S * 0.5, S * 0.5, S * 0.75);
  bg.addColorStop(0, mix(col, -0.35));
  bg.addColorStop(0.55, mix(col, -0.72));
  bg.addColorStop(1, mix(col, -0.93));
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);
  let seed = [...key].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 40; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = S * (0.05 + rnd() * 0.18);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, rnd() < 0.5 ? rgba(col, 0.16) : 'rgba(0,0,0,.22)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
  }
  if (paths) {
    const shape = new Path2D();
    for (const d of paths) shape.addPath(new Path2D(d));
    const k = (S / 512) * 0.8;
    const at = (fn) => { g.save(); g.translate(S * 0.1, S * 0.1); g.scale(k, k); fn(); g.restore(); };
    // Drop shadow, then a coloured glow.
    at(() => { g.translate(14, 18); g.filter = 'blur(3px)'; g.fillStyle = 'rgba(0,0,0,.85)'; g.fill(shape); });
    at(() => { g.shadowColor = rgba(col, 1); g.shadowBlur = S * 0.14; g.fillStyle = mix(col, 0.2); g.fill(shape); });
    // Body lit from the top-left.
    at(() => {
      const fill = g.createLinearGradient(40, 40, 470, 470);
      fill.addColorStop(0, mix(col, 0.9));
      fill.addColorStop(0.45, mix(col, 0.35));
      fill.addColorStop(1, mix(col, -0.35));
      g.fillStyle = fill;
      g.fill(shape);
      g.clip(shape);
      const gloss = g.createRadialGradient(150, 120, 10, 150, 120, 300);
      gloss.addColorStop(0, 'rgba(255,255,255,.55)');
      gloss.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gloss;
      g.fillRect(0, 0, 512, 512);
      const shade = g.createLinearGradient(0, 260, 0, 512);
      shade.addColorStop(0, 'rgba(0,0,0,0)');
      shade.addColorStop(1, 'rgba(0,0,0,.45)');
      g.fillStyle = shade;
      g.fillRect(0, 0, 512, 512);
    });
    at(() => { g.lineWidth = 9; g.strokeStyle = 'rgba(10,5,2,.85)'; g.lineJoin = 'round'; g.stroke(shape); });
  }
  // Vignette and a bevelled frame.
  const vig = g.createRadialGradient(S / 2, S / 2, S * 0.35, S / 2, S / 2, S * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,.6)');
  g.fillStyle = vig;
  g.fillRect(0, 0, S, S);
  const b = Math.max(2, S * 0.035);
  const bev = g.createLinearGradient(0, 0, S, S);
  bev.addColorStop(0, 'rgba(255,240,210,.55)');
  bev.addColorStop(0.5, 'rgba(120,100,80,.25)');
  bev.addColorStop(1, 'rgba(0,0,0,.7)');
  g.lineWidth = b;
  g.strokeStyle = bev;
  g.strokeRect(b * 1.5, b * 1.5, S - b * 3, S - b * 3);
  g.lineWidth = b;
  g.strokeStyle = 'rgba(0,0,0,.95)';
  g.strokeRect(b / 2, b / 2, S - b, S - b);
  const url = c.toDataURL('image/png');
  cache.set(id, url);
  return url;
}
