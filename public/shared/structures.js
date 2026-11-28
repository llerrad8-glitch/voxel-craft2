// Generation 11 structures, worked out from the seed alone (the browser and the server build exactly the same ones):
//   - the PIRATE OUTPOST: a walled camp on a beach with cannon towers, a lodge, an armory, a watchtower with a flag and a long dock with berths for ships;
//   - the SHIPWRECK: a damaged pirate ship lying on the sea floor (fairly rare), and now and then one washed up on a beach (rarer, and more broken).
// The world is cut into square cells; each cell may hold one of each kind, anywhere inside it (kept away from the cell's edge so a structure never crosses into the next cell).
// A structure is worked out once per cell (stamp list in world coordinates) and every chunk it touches copies its own part: no chunk needs to know about its neighbours.
import { B, CS, CH, idx, column, seaOf, hash3, isWater, isPlant, isLeaf, cannonId, bedId, WOOL0 } from './world.js';
import { pirateShipBlocks, unbk } from './ships.js';

export const OUTPOST_CELL = 160, WRECK_CELL = 96, BEACHWRECK_CELL = 192;
const GEN = 11;
const cache = new Map();
const cell = (kind, seed, gx, gz, make) => { const k = kind + ':' + seed + ':' + gx + ',' + gz; if (cache.has(k)) return cache.get(k); const v = make(); cache.set(k, v); if (cache.size > 600) cache.delete(cache.keys().next().value); return v; };
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const rr = (a, b, c, s, n) => hash3(a, b, c, s + n); // a number in [0, 1)

// A little builder in the structure's own frame: a runs toward the sea, b runs along the shore, y is a world height. Turned into world blocks by place().
class Build {
  constructor(px, pz, dx, dz) { this.px = px; this.pz = pz; this.dx = dx; this.dz = dz; this.lx = -dz; this.lz = dx; this.m = new Map(); this.chests = []; }
  w(a, b) { return [this.px + a * this.dx + b * this.lx, this.pz + a * this.dz + b * this.lz]; }
  dir(a, b) { return [a * this.dx + b * this.lx, a * this.dz + b * this.lz]; } // a direction in the frame -> a world direction
  set(a, y, b, id) { const [x, z] = this.w(a, b); this.m.set(x + ',' + y + ',' + z, [x, y, z, id]); if (id === B.CHEST) this.chests.push([x, y, z]); }
  fill(a0, a1, y0, y1, b0, b1, id) { for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) for (let y = y0; y <= y1; y++) this.set(a, y, b, id); }
  ring(a0, a1, y0, y1, b0, b1, id) { for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) if (a === a0 || a === a1 || b === b0 || b === b1) for (let y = y0; y <= y1; y++) this.set(a, y, b, id); }
  cannon(a, y, b, ca, cb) { const [wx, wz] = this.dir(ca, cb); this.set(a, y, b, cannonId(wx, wz)); }
  bed(a, y, b, ca, cb, col) { const [wx, wz] = this.dir(ca, cb), d = DIRS.findIndex(([p, q]) => p === wx && q === wz); this.set(a, y, b, bedId(col, false, d)); this.set(a + ca, y, b + cb, bedId(col, true, d)); }
  blocks() { return [...this.m.values()]; }
}

/* ---------- the pirate outpost ---------- */
function makeOutpost(seed, gx, gz) {
  const SL = seaOf(GEN), col = (x, z) => column(x, z, seed, GEN);
  const ox = gx * OUTPOST_CELL, oz = gz * OUTPOST_CELL;
  for (let i = 0; i < 90; i++) {
    const x = ox + 44 + Math.floor(rr(gx, gz, i, seed, 701) * (OUTPOST_CELL - 88)), z = oz + 44 + Math.floor(rr(gx, gz, i, seed, 702) * (OUTPOST_CELL - 88));
    const c0 = col(x, z); if (c0.k !== 1 || c0.h < SL + 1 || c0.h > SL + 3) continue; // a beach: sand just above the sea
    let best = null;
    for (const [dx, dz] of DIRS) { // find the sea: it must start within 14 blocks and be deep soon after
      let t = 1; while (t < 22 && col(x + dx * t, z + dz * t).h >= SL) t++;
      if (t >= 22 || t > 14) continue;
      const deep = (u, v) => col(x + dx * (t + u) - dz * v, z + dz * (t + u) + dx * v).h <= SL - 3;
      if (deep(10, 0) && deep(24, 0) && deep(24, 8) && deep(24, -8) && deep(14, 7) && deep(14, -7)) { best = [dx, dz, t - 1]; break; }
    }
    if (!best) continue;
    const [dx, dz, t] = best, px = x + dx * t, pz = z + dz * t; // the last bit of land before the water
    const B0 = new Build(px, pz, dx, dz);
    let bad = 0; for (let a = -24; a <= 0; a += 4) for (let b = -14; b <= 14; b += 4) { const [wx, wz] = B0.w(a, b), h = col(wx, wz).h; if (h < SL - 1 || h > SL + 6) bad++; }
    if (bad > 6) continue;
    return buildOutpost(B0, seed, SL, col, gx, gz);
  }
  return null;
}
function buildOutpost(b0, seed, SL, col, gx, gz) {
  const F = SL + 1, LOG = B.SPRUCE_LOG, PL = B.SPRUCE_PLANKS, OAK = B.PLANKS, TORCH = 31, RED = WOOL0;
  const A0 = -23, A1 = -3, Bm = -13, Bp = 13; // the compound
  b0.pad = [A0 - 3, 1, -16, 16]; // [a0, a1, b0, b1] cleared and levelled: the compound and the beach in front of it
  b0.fill(A0, 1, F, F, Bm - 1, Bp + 1, PL); // the floor of the compound (sand shows through where a path would be: the gate path)
  b0.fill(A1 - 1, 1, F, F, -2, 2, OAK);
  // the wall of logs, with battlements, a gate to the sea and a back gate
  b0.ring(A0, A1, F + 1, F + 4, Bm, Bp, LOG);
  for (let a = A0; a <= A1; a++) for (const b of [Bm, Bp]) if ((a + b) & 1) b0.set(a, F + 5, b, PL);
  for (let b = Bm; b <= Bp; b++) for (const a of [A0, A1]) if ((a + b) & 1) b0.set(a, F + 5, b, PL);
  b0.fill(A1, A1, F + 1, F + 3, -2, 2, 0); b0.fill(A1, A1, F + 4, F + 4, -2, 2, OAK); // the sea gate
  b0.fill(A0, A0, F + 1, F + 3, -1, 1, 0); b0.fill(A0, A0, F + 4, F + 4, -1, 1, OAK); // the back gate
  for (const b of [-9, -6, 6, 9]) b0.cannon(A1, F + 5, b, 1, 0); // cannons on the sea wall
  b0.set(A1 + 1, F + 1, -3, TORCH); b0.set(A1 + 1, F + 1, 3, TORCH);
  // a tower with a spiral of steps inside and a platform on top; the cannon on it looks out over `out`
  b0.towers = [];
  const tower = (ca, cb, h, out, side) => {
    b0.towers.push([ca, cb, h]);
    b0.ring(ca - 2, ca + 2, F + 1, F + h, cb - 2, cb + 2, LOG);
    b0.fill(ca - 1, ca + 1, F + 1, F + h, cb - 1, cb + 1, 0);
    const spiral = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
    spiral.forEach(([p, q], k) => { if (k + 1 < h) b0.fill(ca + p, ca + p, F + 1, F + k + 1, cb + q, cb + q, OAK); });
    for (let a = ca - 2; a <= ca + 2; a++) for (let b = cb - 2; b <= cb + 2; b++) { const p = a - ca, q = b - cb, k = spiral.findIndex(([u, v]) => u === p && v === q); if (k >= 0 && k + 1 < h) continue; b0.set(a, F + h, b, PL); }
    b0.ring(ca - 2, ca + 2, F + h + 1, F + h + 1, cb - 2, cb + 2, PL);
    b0.cannon(ca + out[0] * 2, F + h + 1, cb + out[1] * 2, out[0], out[1]);
    const da = side === 'a' ? ca - 2 : ca - 1, db = side === 'a' ? cb - 1 : cb - 2; // the doorway: beside the foot of the spiral
    b0.fill(da, da, F + 1, F + 2, db, db, 0);
    b0.set(ca, F + h + 2, cb, TORCH);
  };
  tower(A1 - 1, Bm + 1, 6, [1, 0], 'a'); // the two cannon towers by the sea gate (their doors face into the compound)
  tower(A1 - 1, Bp - 1, 6, [1, 0], 'a');
  // the watchtower at the back, taller, with a flag
  tower(A0 + 3, 0, 9, [0, 1], 'b');
  { const ca = A0 + 3, top = F + 9 + 2; for (let y = top; y <= top + 5; y++) b0.set(ca, y, 0, LOG); b0.fill(ca, ca, top + 3, top + 5, 1, 3, B.COAL_BLOCK); b0.set(ca, top + 4, 2, B.WOOL); }
  // the lodge: beds, a crafting table, a furnace and a chest
  { const a0 = -16, a1 = -8, bb0 = -11, bb1 = -4;
    b0.fill(a0, a1, F + 1, F + 4, bb0, bb1, 0); b0.ring(a0, a1, F + 1, F + 3, bb0, bb1, PL); b0.fill(a0 - 0, a1, F + 4, F + 4, bb0, bb1, OAK); b0.ring(a0, a1, F + 4, F + 4, bb0, bb1, LOG);
    b0.fill(a0, a1, F, F, bb0, bb1, OAK);
    for (const a of [-14, -12, -10]) { b0.set(a, F + 2, bb0, B.GLASS); b0.set(a, F + 2, bb1, B.GLASS); }
    b0.fill(a1, a1, F + 1, F + 2, -8, -7, 0); // the door, onto the courtyard
    b0.bed(a0 + 1, F + 1, bb0 + 1, 0, 1, 0); b0.bed(a0 + 1, F + 1, bb0 + 3, 0, 1, 0); b0.bed(a0 + 1, F + 1, bb0 + 5, 0, 1, 0);
    b0.set(a1 - 1, F + 1, bb1 - 1, B.TABLE); b0.set(a1 - 1, F + 1, bb1 - 2, B.FURNACE); b0.set(a0 + 4, F + 1, bb1 - 1, B.CHEST); b0.set(a0 + 4, F + 1, bb0 + 1, TORCH); b0.set(a1 - 1, F + 1, bb0 + 1, TORCH);
  }
  // the armory: two chests and a pair of cannons
  { const a0 = -16, a1 = -8, bb0 = 4, bb1 = 11;
    b0.fill(a0, a1, F + 1, F + 4, bb0, bb1, 0); b0.ring(a0, a1, F + 1, F + 3, bb0, bb1, B.COBBLE); b0.fill(a0, a1, F + 4, F + 4, bb0, bb1, OAK); b0.ring(a0, a1, F + 4, F + 4, bb0, bb1, LOG);
    b0.fill(a0, a1, F, F, bb0, bb1, OAK);
    for (const a of [-14, -12, -10]) b0.set(a, F + 2, bb1, B.GLASS);
    b0.fill(a1, a1, F + 1, F + 2, 7, 8, 0);
    b0.set(a0 + 1, F + 1, bb0 + 1, B.CHEST); b0.set(a0 + 1, F + 1, bb1 - 1, B.CHEST);
    b0.cannon(a0 + 4, F + 1, bb1 - 1, 1, 0); b0.cannon(a0 + 4, F + 1, bb0 + 1, 1, 0);
    b0.set(a1 - 1, F + 1, bb0 + 1, TORCH); b0.set(a1 - 1, F + 1, bb1 - 1, TORCH); b0.set(a0 + 6, F + 1, 7, B.CHEST);
  }
  // a courtyard: barrels of logs, a well-lit square in front of the gate
  for (const [a, b] of [[-5, -6], [-5, 6], [-19, -1], [-19, 1]]) { b0.set(a, F + 1, b, LOG); b0.set(a, F + 2, b, TORCH); }
  // the dock: a main pier into the sea, a cross pier at each end, posts and lamps
  const PIER_END = 30;
  b0.fill(2, PIER_END, F, F, -1, 1, OAK);
  b0.fill(3, 4, F, F, -9, 9, OAK); b0.fill(PIER_END - 1, PIER_END, F, F, -8, 8, OAK);
  for (let a = 2; a <= PIER_END; a += 4) for (const b of [-1, 1]) b0.fill(a, a, F - 14, F - 1, b, b, LOG);
  for (let b = -8; b <= 8; b += 8) { b0.fill(PIER_END, PIER_END, F - 14, F - 1, b, b, LOG); b0.fill(3, 3, F - 14, F - 1, b, b, LOG); }
  for (let a = 6; a <= PIER_END; a += 8) for (const b of [-1, 1]) { b0.set(a, F + 1, b, LOG); b0.set(a, F + 2, b, TORCH); }
  for (const b of [-9, 9, -8, 8]) { b0.set(3, F + 1, b, LOG); b0.set(PIER_END, F + 1, b, LOG); }
  b0.set(PIER_END, F + 1, 0, B.CHEST); // a chest at the end of the pier
  const berths = [];
  const slot = (a, b, sizes) => { // a ship's wheel at (a, b), bow toward the sea; only a berth over deep enough water counts
    const ok = [[a, b], [a + 6, b], [a + 12, b], [a - 1, b - 2], [a + 8, b + 2]].every(([p, q]) => { const [wx, wz] = b0.w(p, q); return col(wx, wz).h <= SL - 2; });
    if (!ok) return; const [wx, wz] = b0.w(a, b); berths.push({ x: wx + 0.5, z: wz + 0.5, yaw: Math.atan2(-b0.dx, -b0.dz), sizes });
  };
  slot(6, -5, ['medium', 'small']); slot(8, 5, ['large', 'medium']); slot(19, -5, ['small']);
  if (!berths.length) return null;
  b0.kind = 'outpost'; b0.berths = berths; b0.key = `o${gx},${gz}`;
  const bx = [], bz = []; for (const [a, bb] of [[b0.pad[0], b0.pad[2]], [b0.pad[0], b0.pad[3]], [PIER_END + 3, -10], [PIER_END + 3, 10]]) { const [wx, wz] = b0.w(a, bb); bx.push(wx); bz.push(wz); }
  b0.box = [Math.min(...bx) - 2, Math.max(...bx) + 2, Math.min(...bz) - 2, Math.max(...bz) + 2];
  b0.X = b0.px; b0.Z = b0.pz;
  return b0;
}

/* ---------- shipwrecks ---------- */
// A pirate ship (the same blocks as the ones that sail), broken: sails gone or in rags, masts snapped, holes in the hull, most cannons and some chests missing.
function wreckBlocks(seed, gx, gz, i, size, beach) {
  const ps = pirateShipBlocks(size), out = [], chests = [];
  const cutY = 1 + Math.floor(rr(gx, gz, i, seed, 711) * 5), holes = [];
  const nH = beach ? 2 + Math.floor(rr(gx, gz, i, seed, 712) * 2) : 1 + Math.floor(rr(gx, gz, i, seed, 712) * 3), keys = [...ps.blocks.keys()].map((k) => unbk(k));
  for (let h = 0; h < nH; h++) { const [x, y, z] = keys[Math.floor(rr(gx, gz, h, seed, 713) * keys.length)]; holes.push([x, Math.min(y, 0), z, 1.2 + rr(gx, gz, h, seed, 714) * 1.2]); }
  const chestList = ps.chests.map(([x, y, z]) => x + ',' + y + ',' + z), keepChest = Math.floor(rr(gx, gz, i, seed, 715) * ps.chests.length);
  for (const k of ps.blocks.keys()) {
    const [x, y, z] = unbk(k); let id = ps.blocks.get(k); const r = rr(x + gx * 977, y + 31, z + gz * 613, seed, 716);
    const chest = id === B.CHEST;
    if (chest) { if (chestList.indexOf(x + ',' + y + ',' + z) !== keepChest && r < (beach ? 0.6 : 0.3)) continue; }
    else if (y > cutY) continue; // snapped masts: nothing above a certain height
    else if (id === B.WOOL || (id >= WOOL0 && id < WOOL0 + 7)) { if (r < 0.8) continue; }
    else if (id >= 214 && id <= 217) { if (r < 0.7) continue; }
    else if (id === B.STEERING_WHEEL) { if (r < 0.4) continue; }
    else if (y === 0 && r < 0.4) continue; // rails: broken in many places
    else if (r < (beach ? 0.12 : 0.08)) continue;
    if (!chest && holes.some(([hx, hy, hz, hr]) => Math.hypot(x - hx, (y - hy) * 0.8, z - hz) < hr)) continue;
    out.push([x, y, z, id]);
    if (chest) chests.push([x, y, z]);
  }
  return { out, chests, L: size === 'large' ? 16 : size === 'medium' ? 11 : 7 };
}
function makeWreck(seed, gx, gz, beach) {
  const SL = seaOf(GEN), CELLW = beach ? BEACHWRECK_CELL : WRECK_CELL, col = (x, z) => column(x, z, seed, GEN), tag = beach ? 20 : 0;
  const ox = gx * CELLW, oz = gz * CELLW;
  for (let i = 0; i < (beach ? 70 : 20); i++) {
    const x = ox + 30 + Math.floor(rr(gx, gz, i, seed, 721 + tag) * (CELLW - 60)), z = oz + 30 + Math.floor(rr(gx, gz, i, seed, 722 + tag) * (CELLW - 60));
    const c0 = col(x, z);
    if (beach ? !(c0.k === 1 && c0.h >= SL + 1 && c0.h <= SL + 2) : c0.h > SL - 8) continue;
    const q = rr(gx, gz, i, seed, 723 + tag), size = q < 0.28 ? 'small' : q < 0.72 ? 'medium' : 'large', [dx, dz] = DIRS[Math.floor(rr(gx, gz, i, seed, 724 + tag) * 4)];
    const wb = wreckBlocks(seed, gx, gz, i, size, beach), lx = -dz, lz = dx, half = 4;
    // the footprint must sit on level ground (and, for a beach, with the sea close by on one side)
    let lo = 1e9, hi = -1e9, wet = 0, n = 0;
    for (let a = -half - 1; a <= wb.L + 2; a += 2) for (let b = -3; b <= 3; b += 3) { const h = col(x + a * dx + b * lx, z + a * dz + b * lz).h; lo = Math.min(lo, h); hi = Math.max(hi, h); if (h < SL) wet++; n++; }
    if (beach ? (hi - lo > 1 || hi > SL + 3 || lo < SL + 1 || wet > 0) : (hi - lo > 2 || hi > SL - 7)) continue;
    if (beach) { // the sea must be near: some water within 18 blocks of the wreck
      let sea = false; for (let t = 4; t <= 18 && !sea; t += 2) for (const [ddx, ddz] of DIRS) if (col(x + ddx * t, z + ddz * t).h < SL) { sea = true; break; }
      if (!sea) continue;
    }
    const baseY = beach ? lo - 1 : lo + 1, B0 = new Build(x, z, dx, dz); // the keel; the ship's z runs from its stern (+1) to the bow (-L)
    // ship-local (lx, ly, lz) -> frame (a = forward = -lz, b = lx)
    const set = (blk) => { const [sx, sy, sz, id] = blk; let idw = id; if (id >= 214 && id <= 217) { const ca = -(id === 216 ? 1 : id === 217 ? -1 : 0), cb = id === 214 ? 1 : id === 215 ? -1 : 0; B0.cannon(-sz, baseY + sy + 3, sx, ca, cb); return; } B0.set(-sz, baseY + sy + 3, sx, idw); };
    for (const blk of wb.out) set(blk);
    B0.kind = beach ? 'beachwreck' : 'wreck'; B0.key = (beach ? 'b' : 'w') + `${gx},${gz}`; B0.X = x; B0.Z = z; B0.soft = true;
    const xs = [], zs = []; for (const [a, b] of [[-wb.L - 3, -5], [-wb.L - 3, 5], [4, -5], [4, 5]]) { const [wx, wz] = B0.w(a, b); xs.push(wx); zs.push(wz); }
    B0.box = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    if (beach) B0.clearBox = { box: B0.box, y0: baseY + 1, y1: baseY + 20 }; // a wreck on the sand stands in a pit: whatever grew or lay there is cleared
    if (!B0.chests.length) continue;
    return B0;
  }
  return null;
}

/* ---------- looking structures up ---------- */
const cellsOf = (kind, size, seed, x0, x1, z0, z1, make) => { // the structures of one kind whose cell touches the box
  const out = []; for (let gz = Math.floor(z0 / size); gz <= Math.floor(z1 / size); gz++) for (let gx = Math.floor(x0 / size); gx <= Math.floor(x1 / size); gx++) {
    const chance = kind === 'o' ? 0.6 : kind === 'w' ? 0.2 : 0.5;
    if (rr(gx, gz, 0, seed, kind === 'o' ? 731 : kind === 'w' ? 732 : 733) >= chance) continue;
    const s = cell(kind, seed, gx, gz, () => make(seed, gx, gz)); if (s) out.push(s);
  }
  return out;
};
export function structuresIn(seed, x0, x1, z0, z1) {
  return [...cellsOf('o', OUTPOST_CELL, seed, x0, x1, z0, z1, makeOutpost), ...cellsOf('w', WRECK_CELL, seed, x0, x1, z0, z1, (s, gx, gz) => makeWreck(s, gx, gz, false)), ...cellsOf('b', BEACHWRECK_CELL, seed, x0, x1, z0, z1, (s, gx, gz) => makeWreck(s, gx, gz, true))];
}
// Outposts within r blocks of a point (the server puts ships in their docks).
export const outpostsNear = (seed, x, z, r) => cellsOf('o', OUTPOST_CELL, seed, x - r, x + r, z - r, z + r, makeOutpost).filter((o) => Math.hypot(o.X - x, o.Z - z) <= r);
// What kind of loot a chest of the world holds: 'outpost', 'wreck' or null for an ordinary one (decided by where it stands).
export function lootKindAt(seed, x, y, z) {
  for (const s of structuresIn(seed, x, x, z, z)) for (const c of s.chests) if (c[0] === x && c[1] === y && c[2] === z) return s.kind === 'outpost' ? 'outpost' : 'wreck';
  return null;
}

/* ---------- stamping onto a chunk ---------- */
const soft = (v) => v === 0 || isWater(v) || v === B.SEAWEED || isPlant(v) || isLeaf(v) || v === B.SNOW || (v >= 55 && v <= 75);
export function stampStructures(d, cx, cz, seed) {
  const ox = cx * CS, oz = cz * CS, list = structuresIn(seed, ox, ox + CS - 1, oz, oz + CS - 1);
  if (!list.length) return;
  const SL = seaOf(GEN);
  for (const s of list) {
    const [bx0, bx1, bz0, bz1] = s.box; if (bx1 < ox || bx0 >= ox + CS || bz1 < oz || bz0 >= oz + CS) continue;
    if (s.kind === 'outpost') { // level the beach under and around the compound: sand up to the floor, clear sky above, so nothing stands in the middle of it
      const [a0, a1, b0, b1] = s.pad, F = SL + 1;
      for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) {
        const [wx, wz] = s.w(a, b), x = wx - ox, z = wz - oz; if (x < 0 || x >= CS || z < 0 || z >= CS) continue;
        for (let y = F - 6; y <= F; y++) { const i = idx(x, y, z); if (soft(d[i]) || y === F) d[i] = B.SAND; }
        for (let y = F + 1; y <= Math.min(CH - 1, F + 16); y++) d[idx(x, y, z)] = 0;
      }
    } else if (s.clearBox) {
      const [x0, x1, z0, z1] = s.clearBox.box;
      for (let wz = Math.max(z0, oz); wz <= Math.min(z1, oz + CS - 1); wz++) for (let wx = Math.max(x0, ox); wx <= Math.min(x1, ox + CS - 1); wx++) for (let y = s.clearBox.y0; y <= Math.min(CH - 1, s.clearBox.y1); y++) d[idx(wx - ox, y, wz - oz)] = 0;
    }
    for (const [wx, y, wz, id] of s.bl || (s.bl = s.blocks())) {
      const x = wx - ox, z = wz - oz; if (x < 0 || x >= CS || z < 0 || z >= CS || y < 1 || y >= CH) continue;
      const i = idx(x, y, z); if (id === 0) { if (!isWater(d[i]) || s.kind === 'outpost') d[i] = 0; continue; } // (an air cell in the stamp: a gate or doorway)
      if (soft(d[i]) || s.kind === 'outpost') d[i] = id;
    }
  }
}
