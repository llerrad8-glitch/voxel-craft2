// What zombies and skeletons spawn wearing and carrying. Four in five have nothing at all. The rest wear one to four pieces of armor, always damaged and mostly almost
// broken, and the commoner a kind of armor is, the more of it you meet (leather is everywhere, diamond is a rare find; leather is often dyed). A few carry a weapon or a tool.
import { armorId, dyedArmorId, toolId, spearId, battleAxeId, itemInfo, ITEMS } from '../public/shared/items.js';
import { mk } from './inventory.js';
const rnd = Math.random;
const pick = (list) => { let t = 0; for (const [, w] of list) t += w; let r = rnd() * t; for (const [v, w] of list) { r -= w; if (r <= 0) return v; } return list[0][0]; };
const ARMOR_W = [[0, 46], [1, 28], [2, 20], [3, 4]]; // leather, iron, gold, diamond: the commoner, the likelier
const COUNT_W = [[1, 22], [2, 30], [3, 26], [4, 22]]; // an armored one usually wears several pieces
const MAT_W = [[0, 40], [1, 30], [2, 20], [3, 8], [4, 2]]; // wood, stone, iron, gold, diamond
const KIND_W = [['sword', 3], ['axe', 2], ['pickaxe', 2], ['shovel', 2], ['spear', 2], ['battleaxe', 1]];
const worn = (id) => { const dur = itemInfo(id).dur, left = rnd() < 0.75 ? 0.02 + rnd() * 0.1 : 0.14 + rnd() * 0.5; return { id, n: 1, d: Math.max(0, Math.min(dur - 1, Math.floor(dur * (1 - left)))) }; };
export function rollGear(type) {
  const gear = { w: null, a: [null, null, null, null] };
  if (rnd() < 0.2) {
    let slots = [0, 1, 2, 3].sort(() => rnd() - 0.5).slice(0, pick(COUNT_W));
    for (const t of slots) {
      const mat = pick(ARMOR_W);
      gear.a[t] = worn(mat === 0 && rnd() < 0.55 ? dyedArmorId(t, (rnd() * 7) | 0) : armorId(t, mat));
    }
  }
  if (rnd() < (type === 'skeleton' ? 0.1 : 0.12)) { // slightly rarer than armor
    const kind = pick(KIND_W), mat = pick(MAT_W);
    gear.w = worn(kind === 'spear' ? spearId(mat) : kind === 'battleaxe' ? battleAxeId(mat) : toolId(kind, mat));
  }
  return gear.w || gear.a.some(Boolean) ? gear : null;
}
export const gearPacket = (g) => (g ? [g.w ? g.w.id : 0, ...g.a.map((s) => (s ? s.id : 0))] : 0);
export const gearDmg = (g) => (g && g.w ? Math.round((itemInfo(g.w.id).dmg || 2) * 0.5) : 0); // extra damage from what it carries
// Armor takes the blow: the more of it is left, the more it soaks up. Every hit wears the pieces down, and a piece that wears out breaks away.
export function gearHit(m, dmg) {
  const g = m.gear; if (!g) return dmg;
  let red = 0; const have = [];
  g.a.forEach((s, i) => { if (!s) return; const it = itemInfo(s.id), dur = it.dur, left = (dur - s.d) / dur; red += it.def * 0.04 * left; have.push(i); });
  if (have.length) {
    const i = have[(rnd() * have.length) | 0], s = g.a[i], wear = Math.max(1, Math.floor(dmg / 2.5));
    s.d += wear; if (s.d >= itemInfo(s.id).dur) { g.a[i] = null; m.gearDirty = true; }
  }
  return dmg * (1 - Math.min(0.6, red));
}
// What falls when it dies (the pieces keep their wear).
export function gearDrops(m) {
  const g = m.gear, out = []; if (!g) return out;
  for (const s of g.a) if (s && rnd() < 0.25) out.push(mk(s.id, 1, s.d));
  if (g.w && rnd() < 0.3) out.push(mk(g.w.id, 1, g.w.d));
  return out;
}
