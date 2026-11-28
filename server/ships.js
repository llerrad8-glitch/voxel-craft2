// Ships, cannons and pirates (server side; the rules both sides share are in public/shared/ships.js).
// A ship is an entity with a block grid of its own. Players turn a build into one by placing a steering wheel; the server takes the build's blocks out of the world,
// floats the ship on the water and sails it when somebody holds the wheel. A pirate ship is the same thing, ready made, with a crew of pirates walking about its deck.
import { B, isWater, isSolid, isFluid, isPlant, waterHeight, seaOf, column, isCannon, cannonId, cannonDir, isVariant, isBed, bedId, bedColor, bedDir, bedIsHead, DIR4, BED_H } from '../public/shared/world.js';
import { outpostsNear } from '../public/shared/structures.js';
import { I, itemInfo, blockDrops, toolId, armorId, CANNON, GUNS } from '../public/shared/items.js';
import { MOBS } from '../public/shared/mobs.js';
import { SHIP_MAX, PIRATE_SIZES, bk, unbk, bounds, toWorld, toLocal, dirToLocal, dirToWorld, shipBoxHit, shipSweep, collectBuild, pirateShipBlocks } from '../public/shared/ships.js';
import { send, broadcast } from './net.js';
import { mk, newContainer, packCont, loadCont, newWin, tickFurnace } from './inventory.js';
import { blockAt, setEdit, setBlock, claimAt, lineClear, wakeWater } from './world.js';
import { spawnMob, spawnItem, spawnArrow, explode, hurtMob, viewOf } from './ents.js';
import { damagePlayer, openWindow } from './survival.js';
import { award, bump } from './achievements.js';

const rnd = Math.random, fl = Math.floor, r2 = (v) => Math.round(v * 100) / 100, wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const tell = (p, m) => send(p.ws, { t: 'chat', m, sys: 1 });
const tSec = () => Date.now() / 1000;
export const shipsOf = (room) => room.ships || (room.ships = new Map());

/* ---------- ships as objects ---------- */
// Work out everything that depends on which blocks the ship has: bounds, a flat list for collision, the cannons and (for a pirate crew) the cells it is safe to walk on.
export function refresh(S) {
  bounds(S);
  S.list = []; S.cannons ||= new Map(); S.walk = new Set();
  for (const [k, id] of S.blocks) { const [x, y, z] = unbk(k); if (isSolid(id)) S.list.push([x, y, z]); if (isCannon(id) && !S.cannons.has(k)) S.cannons.set(k, { loaded: S.kind === 'pirate', cd: rnd() * 4 }); }
  for (const k of [...S.cannons.keys()]) if (!isCannon(S.blocks.get(k))) S.cannons.delete(k);
  for (const k of S.blocks.keys()) {
    const [x, y, z] = unbk(k), id = S.blocks.get(k);
    if (isSolid(id) && !S.blocks.has(bk(x, y + 1, z)) && !S.blocks.has(bk(x, y + 2, z))) S.walk.add(`${x},${y},${z}`);
  }
  S.deck = [...S.walk].map((s) => s.split(',').map(Number)); // [lx, ly(of the block we stand on), lz]
  S.ver = (S.ver || 0) + 1;
}
export function newShip(room, kind, x, y, z, yaw, blocks, extra = {}) {
  const S = { id: ++room.entId, uid: Math.random().toString(36).slice(2, 12), kind, x, y, z, yaw, blocks, cannons: new Map(), chests: new Map(), fr: 0, speed: 0, inF: 0, inS: 0, helm: 0, ver: 0, draft: 0.5, owner: '', crew: [], born: Date.now(), ...extra };
  refresh(S); shipsOf(room).set(S.id, S); return S;
}
export function deleteShip(room, S) {
  for (const id of S.crew) room.mobs.delete(id);
  if (S.helm) { const p = room.players.get(S.helm); if (p) { p.helmShip = 0; send(p.ws, { t: 'helm', on: 0 }); } }
  shipsOf(room).delete(S.id);
}
// Ships that are saved with the world, with everything about them: the ones you built or captured, and any pirate ship you have had anything to do with (boarded, shot,
// opened a chest of, fought its crew...). Those keep their blocks, chests and furnaces, cannons (loaded or not), place and heading, and what is left of their crew.
// A pirate ship nobody has touched is not kept: it sails away when no one is near.
export const shipsToSave = (room) => [...shipsOf(room).values()].filter((S) => S.kind === 'p' || S.keep).map((S) => {
  const b = []; for (const [k, id] of S.blocks) { const [x, y, z] = unbk(k); b.push(x, y, z, id); }
  const cr = []; for (const id of S.crew) { const m = room.mobs.get(id); if (m) cr.push([+m.hp.toFixed(1), +m.lx.toFixed(2), +m.lz.toFixed(2), m.deckY, m.aux | 0, m.lookout ? 1 : 0]); }
  return { uid: S.uid, k: S.kind === 'pirate' ? 1 : 0, sz: S.size || '', dr: S.draft, mo: S.moor ? 1 : 0, x: +S.x.toFixed(2), y: +S.y.toFixed(2), z: +S.z.toFixed(2), yaw: +S.yaw.toFixed(3), owner: S.owner, fr: S.fr | 0,
    ch: [...S.chests].map(([k, c]) => [...unbk(k), packCont(c)]), cn: [...S.cannons].map(([k, c]) => [...unbk(k), c.loaded ? 1 : 0]), cr, b };
});
export function loadShips(room, list) {
  for (const d of Array.isArray(list) ? list.slice(0, 60) : []) {
    if (!d || ![d.x, d.y, d.z, d.yaw].every(Number.isFinite) || !Array.isArray(d.b) || d.b.length > 4 * (SHIP_MAX + 400)) continue;
    const blocks = new Map();
    for (let i = 0; i + 3 < d.b.length; i += 4) if (d.b.slice(i, i + 4).every(Number.isInteger) && d.b[i + 3] > 0 && d.b[i + 3] < 256) blocks.set(bk(d.b[i], d.b[i + 1], d.b[i + 2]), d.b[i + 3]);
    if (!blocks.size) continue;
    const pirate = d.k === 1, size = ['small', 'medium', 'large'].includes(d.sz) ? d.sz : undefined;
    const S = newShip(room, pirate ? 'pirate' : 'p', d.x, d.y, d.z, d.yaw, blocks, { owner: String(d.owner || ''), fr: [0, 1, 2, 3].includes(d.fr) ? d.fr : 0, keep: true, ...(pirate ? { size, draft: Number.isFinite(d.dr) ? d.dr : 0.8, moor: !!d.mo } : {}), ...(typeof d.uid === 'string' && d.uid.length <= 20 ? { uid: d.uid } : {}) });
    for (const c of Array.isArray(d.ch) ? d.ch.slice(0, 20) : []) if (Array.isArray(c) && c.slice(0, 3).every(Number.isInteger) && c[3] && (blocks.get(bk(c[0], c[1], c[2])) === B.CHEST || blocks.get(bk(c[0], c[1], c[2])) === B.FURNACE)) S.chests.set(bk(c[0], c[1], c[2]), loadCont(c[3]));
    for (const c of Array.isArray(d.cn) ? d.cn.slice(0, 40) : []) if (Array.isArray(c) && c.slice(0, 3).every(Number.isInteger)) { const st = S.cannons.get(bk(c[0], c[1], c[2])); if (st) st.loaded = !!c[3]; }
    if (pirate) for (const c of Array.isArray(d.cr) ? d.cr.slice(0, 12) : []) {
      if (!Array.isArray(c) || !c.every(Number.isFinite)) continue;
      const m = spawnMob(room, 'pirate', S.x, S.y, S.z); if (!m) continue;
      Object.assign(m, { shipId: S.id, hp: Math.max(1, Math.min(MOBS.pirate.hp, c[0])), lx: c[1], lz: c[2], deckY: c[3], aux: c[4] ? 1 : 0, ly: rnd() * 6.28, gx: null, gz: null, moving: false, ...(c[5] ? { lookout: true } : {}) });
      S.crew.push(m.id);
    }
  }
}

/* ---------- water ---------- */
// The height of the water surface at (x, z), looking from y0 + 3 downward, or null when there is no water there.
export function surfaceAt(room, x, z, y0) {
  const bx = fl(x), bz = fl(z);
  for (let y = fl(y0) + 3; y > y0 - 14; y--) {
    const id = blockAt(room, bx, y, bz);
    if (isWater(id)) { let yy = y; while (isWater(blockAt(room, bx, yy + 1, bz))) yy++; return yy + waterHeight(blockAt(room, bx, yy, bz)); }
  }
  return null;
}

const FR = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // which way the ship's front can point, in its own frame (bow, starboard, stern, port)
// The side of the ship that lies closest to the way a player looks (yaw): the ship's front.
function frontFor(S, yaw) {
  const [lx, lz] = dirToLocal(S.yaw, -Math.sin(yaw), -Math.cos(yaw)); let best = 0, bd = -9;
  FR.forEach(([a, b], i) => { const d = a * lx + b * lz; if (d > bd) { bd = d; best = i; } });
  return best;
}
/* ---------- placing a steering wheel: build -> ship ---------- */
export function launchShip(room, p, wx, wy, wz) {
  const get = (x, y, z) => { const v = room.edits.get(`${x},${y},${z}`); return v > 0 ? v : 0; };
  const res = collectBuild(get, wx, wy, wz);
  if (!res.ok) return { ok: false, msg: `That build is too big for a ship: a ship can be at most ${SHIP_MAX} blocks. Keep it apart from other things you built.` };
  const cells = res.cells;
  for (const [x, y, z] of cells) {
    const id = x === wx && y === wy && z === wz ? B.STEERING_WHEEL : get(x, y, z), c = claimAt(room, x, z);
    if (id === B.CHUNK_SAVER || (c && c.vid !== p.vid)) return { ok: false, msg: 'Part of this build is in a protected chunk.' };
  }
  const low = Math.min(...cells.map((c) => c[1])), sf = surfaceAt(room, wx + 0.5, wz + 0.5, wy);
  if (sf === null || low > sf + 1.6) return { ok: false, msg: 'A ship has to float: build it on the water, then place the steering wheel.' };
  const blocks = new Map(), changes = [];
  for (const [x, y, z] of cells) { const wheel = x === wx && y === wy && z === wz; blocks.set(bk(x - wx, y - wy, z - wz), wheel ? B.STEERING_WHEEL : get(x, y, z)); }
  for (const [x, y, z] of cells) { if (!(x === wx && y === wy && z === wz)) { setEdit(room, x, y, z, 0); changes.push(x, y, z, 0); wakeWater(room, x, y, z); } }
  if (changes.length) { broadcast(room, { t: 'blks', b: changes }); room.markDirty(); }
  const S = newShip(room, 'p', wx + 0.5, wy, wz + 0.5, 0, blocks, { owner: p.th });
  S.fr = frontFor(S, p.yaw); // the front is the way you were facing when you placed the wheel (the arrow on the wheel shows it)
  for (const [x, y, z] of cells) { // chests and furnaces come along with everything in them
    const key = `${x},${y},${z}`, c = room.containers.get(key), id = blocks.get(bk(x - wx, y - wy, z - wz));
    if (c && (id === B.CHEST || id === B.FURNACE)) {
      S.chests.set(bk(x - wx, y - wy, z - wz), c); room.containers.delete(key);
      for (const q of room.players.values()) if (q.win && q.win.key === key) { q.win = newWin('inv'); q.dirtyInv = true; send(q.ws, { t: 'wclose' }); }
    }
  }
  for (const q of room.players.values()) if (q.spawnPt && cells.some(([x, y, z]) => (x === q.spawnPt[0] && y === q.spawnPt[1] && z === q.spawnPt[2]) && isBed(blocks.get(bk(x - wx, y - wy, z - wz))))) { const [x, y, z] = q.spawnPt; q.spawnPt = null; q.spawnShip = { u: S.uid, lx: x - wx, ly: y - wy, lz: z - wz }; tell(q, 'Your bed is part of a ship now: your respawn point sails with it.'); }
  S.y = sf - S.draft - S.b.y0 - 1; // it starts a little low and bobs up to where it floats
  award(room, p, 'ship_launch');
  return { ok: true, ship: S };
}
// Taking the wheel off a ship lets it settle back into the world as ordinary blocks (turned to the nearest compass direction).
function dock(room, S) {
  const q = Math.round(S.yaw / (Math.PI / 2)), c = Math.round(Math.cos(q * Math.PI / 2)), s = Math.round(Math.sin(q * Math.PI / 2)), ox = fl(S.x), oz = fl(S.z), oy = Math.round(S.y), yaw = q * Math.PI / 2;
  for (const [k, id0] of S.blocks) {
    const [lx, ly, lz] = unbk(k), x = ox + lx * c + lz * s, z = oz - lx * s + lz * c, y = oy + ly;
    if (y < 1 || y > 250) continue;
    let id = id0;
    if (isCannon(id)) { const [dx, dz] = cannonDir(id); const [wx, wz] = dirToWorld(yaw, dx, dz); id = cannonId(wx, wz); }
    if (isBed(id)) { const [dx, dz] = DIR4[bedDir(id)], [wx, wz] = dirToWorld(yaw, dx, dz), d = DIR4.findIndex(([a, b]) => a === Math.round(wx) && b === Math.round(wz)); id = bedId(bedColor(id), bedIsHead(id), d < 0 ? 0 : d); }
    const cur = blockAt(room, x, y, z);
    if (cur === 0 || isWater(cur) || isPlant(cur)) {
      setBlock(room, x, y, z, id); const ch = (id === B.CHEST || id === B.FURNACE) && S.chests.get(k); if (ch) room.containers.set(`${x},${y},${z}`, ch);
      for (const q of room.players.values()) if (q.spawnShip && q.spawnShip.u === S.uid && q.spawnShip.lx === lx && q.spawnShip.ly === ly && q.spawnShip.lz === lz && isBed(id)) { q.spawnShip = null; q.spawnPt = [x, y, z]; tell(q, 'The ship was taken apart: your bed is an ordinary bed again, and still your respawn point.'); }
    }
    else if (room.mode !== 'creative') for (const [item, n] of blockDrops(id, { id: toolId('axe', 2) })) spawnItem(room, mk(item, n), x + 0.5, y + 0.5, z + 0.5);
  }
  deleteShip(room, S);
}

/* ---------- player actions on a ship ---------- */
const near = (p, S, lx, ly, lz, max) => { const [x, y, z] = toWorld(S, lx, ly + 0.5, lz, tSec()); return Math.hypot(x - p.x, y - (p.y + 1.5), z - p.z) <= max; };
function takeItem(p, id) { const i = p.inv.findIndex((s) => s && s.id === id); if (i < 0) return false; if (--p.inv[i].n <= 0) p.inv[i] = null; p.dirtyInv = true; return true; }
const worldCannons = (room) => room.cannons || (room.cannons = new Map());
export function handleShip(room, p, m) {
  if (p.dead) return;
  const now = Date.now();
  if (m.op === 'cannon' && m.id === 0) { // a cannon standing in the world
    const { x, y, z } = m; if (![x, y, z].every(Number.isInteger) || !isCannon(blockAt(room, x, y, z)) || Math.hypot(x + 0.5 - p.x, y + 0.5 - (p.y + 1.5), z + 0.5 - p.z) > 7) return;
    const key = `${x},${y},${z}`, st = worldCannons(room).get(key) || { loaded: false, cd: 0 }; worldCannons(room).set(key, st);
    return cannonAct(room, p, st, [x + 0.5, y + 0.5, z + 0.5], cannonDir(blockAt(room, x, y, z)), m.act, null);
  }
  const S = shipsOf(room).get(m.id); if (!S) return;
  S.keep = true; // anything you do with a ship makes it stay (and be saved with the world)
  if (m.op === 'steer') { if (S.helm !== p.id) return; S.inF = Math.max(-1, Math.min(1, +m.f || 0)); S.inS = Math.max(-1, Math.min(1, +m.s || 0)); return; }
  if (m.op === 'front') { // at the wheel: the side you are looking toward becomes the front of the ship
    if (S.helm !== p.id || !Number.isFinite(+m.yaw)) return;
    S.fr = frontFor(S, +m.yaw); S.speed = 0; S.ver++; // (a new version makes everyone's copy of the ship redraw the arrow on the wheel)
    return tell(p, 'The front of the ship is now the side you are looking toward (the arrow on the wheel shows it; G again to change it).');
  }
  if (m.op === 'leave') { if (S.helm === p.id) { S.helm = 0; S.inF = S.inS = 0; p.helmShip = 0; send(p.ws, { t: 'helm', on: 0 }); } return; }
  const { x: lx, y: ly, z: lz } = m;
  if (m.op === 'helm') {
    if (S.helm === p.id) { S.helm = 0; S.inF = S.inS = 0; p.helmShip = 0; return send(p.ws, { t: 'helm', on: 0 }); }
    if (S.helm && room.players.has(S.helm)) return tell(p, 'Somebody else is steering this ship.');
    if (S.kind === 'pirate' && S.crew.some((id) => room.mobs.has(id))) return tell(p, 'The pirates will not let go of their wheel! Defeat the crew first.');
    if (!near(p, S, 0, 0, 0, 5)) return;
    if (S.kind === 'pirate') { S.kind = 'p'; S.owner = p.th; S.crew = []; award(room, p, 'pirate_capture'); tell(p, 'You have captured the pirate ship!'); }
    S.helm = p.id; p.helmShip = S.id; S.inF = S.inS = 0; award(room, p, 'ship_sail');
    return send(p.ws, { t: 'helm', on: 1, id: S.id, x: r2(p.x), y: r2(p.y), z: r2(p.z) });
  }
  if (![lx, ly, lz].every(Number.isInteger) || !near(p, S, lx, ly, lz, 7.5)) return;
  const id = S.blocks.get(bk(lx, ly, lz));
  if (m.op === 'chest') { // a chest or a furnace on the ship (a pirate ship's chests open even while its crew is still alive)
    if (id !== B.CHEST && id !== B.FURNACE) return;
    const kind = id === B.CHEST ? 'chest' : 'furnace', k = bk(lx, ly, lz); let c = S.chests.get(k); if (!c || c.t !== kind) { c = newContainer(kind); S.chests.set(k, c); }
    const [wx, wy, wz] = toWorld(S, lx, ly, lz, tSec());
    openWindow(room, p, kind, fl(wx), fl(wy), fl(wz), c, `ship${S.id}:${k}`); p.win.shipId = S.id; p.win.lpos = [lx, ly, lz];
    return;
  }
  if (m.op === 'table') { // a crafting table on the ship
    if (id !== B.TABLE) return;
    const [wx, wy, wz] = toWorld(S, lx, ly, lz, tSec());
    openWindow(room, p, 'table', fl(wx), fl(wy), fl(wz), null, `ship${S.id}:table`); p.win.shipId = S.id; p.win.lpos = [lx, ly, lz];
    return;
  }
  if (m.op === 'bed') { // a bed on the ship becomes your respawn point, and the respawn point sails with the ship
    if (!isBed(id)) return;
    p.spawnShip = { u: S.uid, lx, ly, lz }; p.spawnPt = null; p.dirtyEq = true;
    return tell(p, 'Respawn point set to this bed. It stays with the ship wherever it sails (you cannot sleep through the night on a ship, though).');
  }
  if (m.op === 'cannon') {
    if (!isCannon(id)) return;
    const st = S.cannons.get(bk(lx, ly, lz)); if (!st) return;
    const [dx, dz] = cannonDir(id), [wx, wz] = dirToWorld(S.yaw, dx, dz), [px, py, pz] = toWorld(S, lx, ly + 0.5, lz, tSec());
    return cannonAct(room, p, st, [px, py, pz], [wx, wz], m.act, S);
  }
  if (m.op === 'break') {
    if (!id || now - (p.shipBrk || 0) < 120) return; p.shipBrk = now;
    const cr = room.mode === 'creative';
    if (id === B.STEERING_WHEEL) return dock(room, S);
    if (isBed(id)) { // both halves go, one bed comes back
      const [dx, dz] = DIR4[bedDir(id)], sg = bedIsHead(id) ? -1 : 1, ok2 = bk(lx + dx * sg, ly, lz + dz * sg);
      if (isBed(S.blocks.get(ok2))) S.blocks.delete(ok2);
      for (const q of room.players.values()) if (q.spawnShip && q.spawnShip.u === S.uid && (bk(q.spawnShip.lx, q.spawnShip.ly, q.spawnShip.lz) === ok2 || (q.spawnShip.lx === lx && q.spawnShip.ly === ly && q.spawnShip.lz === lz))) q.spawnShip = null;
    }
    if (id === B.CHEST || id === B.FURNACE) { const k = bk(lx, ly, lz), c = S.chests.get(k); if (c) { const [x, y, z] = toWorld(S, lx, ly + 0.5, lz, tSec()); for (const st of c.s) if (st) spawnItem(room, st, x, y, z, [(rnd() - 0.5) * 1.5, 2.5, (rnd() - 0.5) * 1.5], 0.4); S.chests.delete(k); for (const q of room.players.values()) if (q.win && q.win.key === `ship${S.id}:${k}`) { q.win = newWin('inv'); q.dirtyInv = true; send(q.ws, { t: 'wclose' }); } } }
    if (!cr) { const [x, y, z] = toWorld(S, lx, ly + 0.5, lz, tSec()); for (const [item, n] of blockDrops(id, p.inv[p.sel])) spawnItem(room, mk(item, n), x, y, z, [(rnd() - 0.5) * 1.5, 2.5, (rnd() - 0.5) * 1.5], 0.4); }
    S.blocks.delete(bk(lx, ly, lz)); refresh(S);
    if (S.blocks.size <= 1) deleteShip(room, S);
    return;
  }
  if (m.op === 'place') {
    const st = p.inv[p.sel], it = st && itemInfo(st.id);
    const { nx, ny, nz } = m; if (![nx, ny, nz].every(Number.isInteger) || Math.abs(nx) + Math.abs(ny) + Math.abs(nz) !== 1) return;
    const tx = lx + nx, ty = ly + ny, tz = lz + nz;
    if (!it || (!it.block && !it.bed) || S.blocks.has(bk(tx, ty, tz)) || Math.abs(tx) > 30 || Math.abs(tz) > 30 || ty < -10 || ty > 40) return;
    if (S.blocks.size >= SHIP_MAX - (it.bed ? 1 : 0)) return tell(p, `A ship can be at most ${SHIP_MAX} blocks.`);
    const use = () => { if (room.mode !== 'creative') { if (--st.n <= 0) p.inv[p.sel] = null; p.dirtyInv = true; p.dirtyEq = true; } };
    if (it.bed) { // a bed is two blocks long and points the way you face; it needs room and a solid floor under both halves
      const [fx, fz] = dirToLocal(S.yaw, -Math.sin(p.yaw), -Math.cos(p.yaw)), dir = Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 0 : 1) : fz > 0 ? 2 : 3, [dx, dz] = DIR4[dir], hx = tx + dx, hz = tz + dz;
      const floor = (x, z) => { const f = S.blocks.get(bk(x, ty - 1, z)); return f && isSolid(f) && !isBed(f); };
      if (S.blocks.has(bk(hx, ty, hz)) || !floor(tx, tz) || !floor(hx, hz) || Math.abs(hx) > 30 || Math.abs(hz) > 30) return tell(p, 'A bed needs two free blocks over solid floor.');
      const col = it.color | 0; S.blocks.set(bk(tx, ty, tz), bedId(col, false, dir)); S.blocks.set(bk(hx, ty, hz), bedId(col, true, dir)); refresh(S); return use();
    }
    const blk = it.block;
    if ([B.CHUNK_SAVER, B.STEERING_WHEEL].includes(blk) || isPlant(blk) || isFluid(blk) || (blk === B.TORCH && ny !== 1)) return tell(p, 'That cannot go on a ship.');
    let id2 = blk;
    if (blk === B.CANNON) { const [dx, dz] = dirToLocal(S.yaw, -Math.sin(p.yaw), -Math.cos(p.yaw)); id2 = cannonId(dx, dz); }
    S.blocks.set(bk(tx, ty, tz), id2);
    if (blk === B.CHEST || blk === B.FURNACE) S.chests.set(bk(tx, ty, tz), newContainer(blk === B.CHEST ? 'chest' : 'furnace'));
    refresh(S); use();
  }
}
// Loading and firing, for a cannon on a ship (S) or in the world (S = null). pos: where the cannon is; dir: the way the barrel points (x, z).
function cannonAct(room, p, st, pos, dir, act, S) {
  const cr = room.mode === 'creative', now = Date.now(), held = p.inv[p.sel];
  if (act === 'load' || (held && held.id === I.GUNPOWDER && act !== 'fire')) {
    if (st.loaded) return tell(p, 'The cannon is already loaded with gunpowder.');
    if (!cr && !takeItem(p, I.GUNPOWDER)) return tell(p, 'You need gunpowder to load a cannon.');
    st.loaded = true; award(room, p, 'cannon_load'); return tell(p, 'Cannon loaded. Press F or right click it to fire.');
  }
  if (!st.loaded) return tell(p, 'Load the cannon with gunpowder first (right click it holding gunpowder).');
  if (now - (st.at || 0) < CANNON.reloadMs) return;
  if (!cr && !takeItem(p, I.CANNONBALL)) return tell(p, 'You need a cannonball in your inventory to fire the cannon.');
  st.loaded = false; st.at = now;
  fireCannon(room, { kind: 'p', id: p.id, name: p.name, ref: p }, pos, dir, 0.1, S && S.id);
  award(room, p, 'cannon_fire'); bump(room, p, 'cannons', 1);
}
export function fireCannon(room, owner, pos, dir /* [x, z] unit */, elev, from) {
  const len = Math.hypot(dir[0], dir[1]) || 1, ux = dir[0] / len, uz = dir[1] / len, ce = Math.cos(elev), se = Math.sin(elev), sp = CANNON.speed;
  const x = pos[0] + ux * 1.1, y = pos[1] + 0.25, z = pos[2] + uz * 1.1;
  const a = spawnArrow(room, owner, x, y, z, ux * ce * sp, se * sp, uz * ce * sp, CANNON.dmg, 2); if (a) a.from = from || 0;
  broadcast(room, { t: 'fx', k: 'shot', big: 1, x: r2(x), y: r2(y), z: r2(z), dx: r2(ux), dy: r2(se), dz: r2(uz) });
}

/* ---------- things the rest of the server asks ---------- */
// Is the point inside a block of some ship? (not the ship `ignore`, which is the one that just fired it)
export function shipAt(room, x, y, z, ignore = 0) {
  const ships = room.ships; if (!ships || !ships.size) return null;
  const t = tSec();
  for (const S of ships.values()) {
    if (S.id === ignore) continue;
    const b = S.b; if ((x - S.x) ** 2 + (z - S.z) ** 2 > (b.rad + 1) ** 2) continue;
    const [lx, ly, lz] = toLocal(S, x, y, z, t), k = bk(Math.round(lx), fl(ly), Math.round(lz)), id = S.blocks.get(k);
    if (id && isSolid(id)) return { S, k };
  }
  return null;
}
// Does a bullet's path from a to b pass through a ship's hull? (the ship `ignore` is the one that fired it, for a moment)
export function shipSweepAt(room, a, b, ignore = 0) {
  const ships = room.ships; if (!ships || !ships.size) return null;
  const t = tSec();
  for (const S of ships.values()) { if (S.id === ignore) continue; const k = shipSweep(S, a[0], a[1], a[2], b[0], b[1], b[2], t); if (k !== null) return { S, k }; }
  return null;
}
export const hitsShipBox = (room, x, y, z, w, h) => { const ships = room.ships; if (!ships || !ships.size) return false; const t = tSec(); for (const S of ships.values()) if (shipBoxHit(S, x, y, z, w, h, t)) return true; return false; };
// A blast knocks blocks off ships near it.
export function damageShips(room, x, y, z, r) {
  const ships = room.ships; if (!ships || !ships.size) return;
  const t = tSec();
  for (const S of [...ships.values()]) {
    if ((x - S.x) ** 2 + (z - S.z) ** 2 > (S.b.rad + r + 1) ** 2) continue;
    let hit = 0;
    for (const [k] of [...S.blocks]) {
      const [lx, ly, lz] = unbk(k), [wx, wy, wz] = toWorld(S, lx, ly + 0.5, lz, t);
      if (Math.hypot(wx - x, wy - y, wz - z) <= r && rnd() < 0.85) { S.blocks.delete(k); hit++; }
    }
    if (hit) { S.keep = true; refresh(S); if (S.blocks.size < 6 || !S.blocks.has(bk(0, 0, 0))) { if (S.kind === 'pirate' && room.players.size) for (const p of room.players.values()) if (Math.hypot(p.x - S.x, p.z - S.z) < 60) award(room, p, 'sink_pirate'); deleteShip(room, S); } }
  }
}

/* ---------- ticking ---------- */
function blocked(room, S, x, y, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const [lx, ly, lz] of S.list) {
    if (S.list.length > 90 && ly > S.b.y0 + 2 && ((lx + lz + ly) & 3)) continue; // a big ship: the waterline and every fourth block above it is enough
    if (isSolid(blockAt(room, fl(x + lx * c + lz * s), fl(y + ly + 0.5), fl(z - lx * s + lz * c)))) return true;
  }
  return false;
}
const FRONT = FR;
const near2 = (room, S, d) => { for (const p of room.players.values()) if ((p.x - S.x) ** 2 + (p.z - S.z) ** 2 < d * d) return p; return null; };
export function tickShips(room, dt) {
  tickForts(room, dt); tickDocks(room, dt);
  const ships = room.ships; if (!ships || !ships.size) return;
  const t = tSec();
  for (const S of [...ships.values()]) {
    const nearest = near2(room, S, S.kind === 'pirate' ? 175 : 140);
    if (!nearest) { if (S.kind === 'pirate' && !S.keep) deleteShip(room, S); continue; } // a pirate ship you have not touched is not kept: it sails away when nobody is near
    if (S.helm) { const h = room.players.get(S.helm); if (!h || h.dead || Math.hypot(h.x - S.x, h.z - S.z) > S.b.rad + 12) { S.helm = 0; S.inF = S.inS = 0; if (h) { h.helmShip = 0; send(h.ws, { t: 'helm', on: 0 }); } } }
    if (S.kind === 'pirate') aiShip(room, S, dt, t);
    // floating
    const sf = surfaceAt(room, S.x, S.z, S.y + S.b.y0 + 0.5), afloat = sf !== null;
    if (afloat) S.y += (sf - S.draft - S.b.y0 - S.y) * Math.min(1, 2.2 * dt);
    // sailing
    const maxF = S.kind === 'pirate' ? 2.8 : 4.4;
    S.speed += ((afloat ? (S.inF > 0 ? maxF * S.inF : S.inF < 0 ? -1.5 : 0) : 0) - S.speed) * Math.min(1, (S.inF ? 0.55 : 0.3) * dt);
    const turn = S.inS * 0.5 * Math.min(1, 0.35 + Math.abs(S.speed) / 2) * dt * (S.speed < -0.2 ? -1 : 1);
    if (Math.abs(turn) > 1e-4) { if (!blocked(room, S, S.x, S.y, S.z, S.yaw + turn)) S.yaw += turn; else S.speed *= 0.9; }
    if (Math.abs(S.speed) > 0.02) {
      const [fdx, fdz] = dirToWorld(S.yaw, ...FRONT[S.fr | 0]), nx = S.x + fdx * S.speed * dt, nz = S.z + fdz * S.speed * dt;
      if (!blocked(room, S, nx, S.y, nz, S.yaw)) { S.x = nx; S.z = nz; } else S.speed *= 0.2; // aground: it stops
    }
    if (S.kind === 'pirate') { for (const p of room.players.values()) { const [lx, ly, lz] = toLocal(S, p.x, p.y, p.z, t); if (Math.abs(lx) < 3 && lz > S.b.z0 && lz < S.b.z1 && ly > -2 && ly < 3) { award(room, p, 'pirate_board'); S.keep = true; } } tickCrew(room, S, dt, t); tickCannonsAI(room, S, dt, t); }
    else for (const st of S.cannons.values()) st.cd = Math.max(0, st.cd - dt);
    for (const [k, c] of S.chests) if (c.t === 'furnace') { const changed = tickFurnace(c, dt), key = `ship${S.id}:${k}`; for (const q of room.players.values()) if (q.win && q.win.key === key) { if (changed) q.dirtyInv = true; else if (room.tickN % 5 === 0 && (c.burn > 0 || c.cook > 0)) q.dirtyProg = true; } } // (a furnace on a ship cooks while the ship is near anyone)
    for (const q of room.players.values()) if (q.win && q.win.shipId === S.id) { const [a, b, c2] = toWorld(S, ...q.win.lpos, t); q.win.pos = [fl(a), fl(b), fl(c2)]; }
    S.stale = 0;
    if ((S.kind === 'p' || S.keep) && (Math.abs(S.speed) > 0.05 || S.helm)) room.shipDirtyT = (room.shipDirtyT || 0) + dt;
  }
  if ((room.shipDirtyT || 0) > 15 && room.markDirty) { room.shipDirtyT = 0; room.markDirty(); } // (a moving ship that is kept is saved every so often)
}
export function keepShipOf(room, m) { const S = m.shipId && shipsOf(room).get(m.shipId); if (S && S.kind === 'pirate') S.keep = true; } // (fighting a ship's crew counts too)

/* ---------- pirates ---------- */
const players = (room) => [...room.players.values()].filter((p) => !p.dead && room.mode !== 'creative');
function aiShip(room, S, dt, t) {
  const live = S.crew.some((id) => room.mobs.has(id));
  if (!live) { S.inF = 0; S.inS = 0; return; } // a ship with no crew just drifts
  let tgt = null, bd = 1e9; for (const p of players(room)) { const d = Math.hypot(p.x - S.x, p.z - S.z); if (d < bd) { bd = d; tgt = p; } }
  S.ai ||= { wanderT: 0, turn: 0 };
  if (S.moor && (!tgt || bd > 55)) { S.inF = 0; S.inS = 0; return; } // a ship tied up at a dock stays there until somebody comes close
  if (!tgt || bd > 95) { // no one near: cruise, now and then turning
    S.ai.wanderT -= dt; if (S.ai.wanderT <= 0) { S.ai.wanderT = 6 + rnd() * 10; S.ai.turn = rnd() < 0.4 ? 0 : (rnd() < 0.5 ? -1 : 1) * (0.3 + rnd() * 0.7); }
    S.inF = 0.5; S.inS = S.ai.turn; if (S.speed < 0.2 && S.inF > 0) S.inS = S.ai.turn || 1; return;
  }
  const want = Math.atan2(-(tgt.x - S.x), -(tgt.z - S.z)); // the heading that points the bow at the player
  let goal = want, f = 1;
  if (bd < 40) { // close enough: turn side-on so the cannons bear, and slow down
    const a = want + Math.PI / 2, b = want - Math.PI / 2; goal = Math.abs(wrap(a - S.yaw)) < Math.abs(wrap(b - S.yaw)) ? a : b; f = bd < 24 ? 0.3 : 0.55;
    if (bd < 16) { goal = want + Math.PI; f = 0.5; } // too close: sail away
  }
  S.inS = Math.max(-1, Math.min(1, wrap(goal - S.yaw) * 2)); S.inF = f;
}
// A pirate cannon cannot be aimed: it fires straight out of its barrel, the way it points (a little high, like a cannon of yours), and only when somebody stands in that line.
// To hit you the pirates have to turn the whole ship, which is what aiShip does.
function tickCannonsAI(room, S, dt, t) {
  const crew = S.crew.filter((id) => room.mobs.has(id)).length; if (!crew) return;
  const ps = players(room); if (!ps.length) return;
  for (const [k, st] of S.cannons) {
    st.cd -= dt; if (st.cd > 0) continue;
    const id = S.blocks.get(k), [lx, ly, lz] = unbk(k), [dx, dz] = cannonDir(id), [wx, wz] = dirToWorld(S.yaw, dx, dz), [px, py, pz] = toWorld(S, lx, ly + 0.5, lz, t);
    let tgt = false;
    for (const p of ps) {
      const ex = p.x - px, ez = p.z - pz, along = ex * wx + ez * wz, side = Math.abs(-ex * wz + ez * wx); // how far ahead of the barrel and how far off its line
      if (along > 10 && along < 60 && side < 2.2 + along * 0.05) { tgt = true; break; }
    }
    if (!tgt) { st.cd = 0.4; continue; }
    fireCannon(room, { kind: 'm', id: S.id, name: 'Pirate cannon' }, [px, py, pz], [wx, wz], 0.1, S.id);
    st.cd = 6 + rnd() * 5;
  }
}
// The cells (\"x,z\") a pirate can stand on at one deck level (the level is the y of the block it stands on). Kept until the ship's blocks change.
function levelCells(S, y) {
  if (!S.lvl || S.lvl.ver !== S.ver) S.lvl = { ver: S.ver, m: new Map() };
  let c = S.lvl.m.get(y);
  if (!c) { c = new Set(); for (const k of S.walk) { const [x, yy, z] = k.split(',').map(Number); if (yy === y) c.add(`${x},${z}`); } S.lvl.m.set(y, c); }
  return c;
}
// The cell a spot belongs to, or the nearest walkable cell when the spot is not on one ([x, z] or null).
function cellOf(cells, x, z) {
  const cx = Math.round(x), cz = Math.round(z); if (cells.has(`${cx},${cz}`)) return [cx, cz];
  let best = null, bd = 1e9; for (const k of cells) { const [a, b] = k.split(',').map(Number), d = (a - x) ** 2 + (b - z) ** 2; if (d < bd) { bd = d; best = [a, b]; } }
  return best;
}
// The next cell on the shortest way from cell a to cell g over walkable cells (so a pirate goes round a mast or a cannon instead of walking into it).
// The distances from a goal cell are worked out once and kept (until the ship's blocks change), so a crowd of pirates heading for the same cell costs one walk of the deck, not one each tick.
const NB4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function distFrom(S, y, cells, g) {
  const dm = S.lvl.d || (S.lvl.d = new Map()), key = y + '|' + g[0] + ',' + g[1];
  let d = dm.get(key); if (d) return d;
  if (dm.size > 48) dm.clear();
  d = new Map([[g[0] + ',' + g[1], 0]]);
  const q = [g];
  for (let i = 0; i < q.length; i++) {
    const c = q[i], dc = d.get(c[0] + ',' + c[1]);
    for (const [dx, dz] of NB4) { const nx = c[0] + dx, nz = c[1] + dz, k = nx + ',' + nz; if (cells.has(k) && !d.has(k)) { d.set(k, dc + 1); q.push([nx, nz]); } }
  }
  dm.set(key, d); return d;
}
function nextCell(S, y, cells, a, g) {
  const d = distFrom(S, y, cells, g), da = d.get(a[0] + ',' + a[1]);
  if (da === undefined) return null; // no way over the deck
  if (da <= 1) return g;
  for (const [dx, dz] of NB4) { const nx = a[0] + dx, nz = a[1] + dz; if (d.get(nx + ',' + nz) === da - 1) return [nx, nz]; }
  return g;
}
// A pirate has a body: all four corners of it must be over the deck, so it never stands half inside a rail, a cannon or a mast.
const PR = 0.27, bodyOk = (cells, x, z) => cells.has(`${Math.round(x - PR)},${Math.round(z - PR)}`) && cells.has(`${Math.round(x + PR)},${Math.round(z - PR)}`) && cells.has(`${Math.round(x - PR)},${Math.round(z + PR)}`) && cells.has(`${Math.round(x + PR)},${Math.round(z + PR)}`);
function tickCrew(room, S, dt, t) {
  const def = MOBS.pirate, ps = players(room);
  for (const id of [...S.crew]) {
    const m = room.mobs.get(id); if (!m) { S.crew.splice(S.crew.indexOf(id), 1); continue; }
    m.hurtT = Math.max(0, m.hurtT - dt); m.atkT = Math.max(0, m.atkT - dt); m.shootT = Math.max(0, m.shootT - dt); m.swing = Math.max(0, m.swing - dt); m.vx = m.vy = m.vz = 0; m.ground = true;
    let lx = m.lx, lz = m.lz;
    let tgt = null, bd = def.sight * def.sight;
    for (const p of ps) { const dx = p.x - m.x, dz = p.z - m.z, dy = p.y - m.y, d = dx * dx + dz * dz + dy * dy * 0.5; if (d < bd) { bd = d; tgt = p; } }
    let gx = m.gx, gz = m.gz, speed = def.speed * 0.5, faceX = null, faceZ = null;
    if (tgt) {
      const [tlx, tly, tlz] = toLocal(S, tgt.x, tgt.y, tgt.z, t), dx = tgt.x - m.x, dz = tgt.z - m.z, hd = Math.hypot(dx, dz);
      const aboard = tly > -1.5 && tly < 3.5 && S.walk.has(`${Math.round(tlx)},${m.deckY - 1},${Math.round(tlz)}`) || (Math.abs(tlx) < 3.2 && tlz > S.b.z0 - 1.5 && tlz < S.b.z1 + 1.5 && tly > -1.5 && tly < 3.5);
      faceX = tlx - lx; faceZ = tlz - lz;
      if (m.aux === 1) { // a pistol: stands and shoots, and steps toward a player on the deck
        m.arrowT -= dt;
        const from = [m.x, m.y + 1.5, m.z], to = [tgt.x, tgt.y + 1.1, tgt.z];
        if (m.arrowT <= 0 && hd < 32 && lineClear(room, from, to)) {
          const sp = GUNS[I.FLINTLOCK].speed * 0.85, ex = to[0] - from[0] + (rnd() - 0.5) * (1.2 + hd * 0.42), ey = to[1] - from[1] + (rnd() - 0.5) * (0.8 + hd * 0.2) + hd * 0.02, ez = to[2] - from[2] + (rnd() - 0.5) * (1.2 + hd * 0.42), len = Math.hypot(ex, ey, ez);
          const a = spawnArrow(room, { kind: 'm', id: m.id, name: def.name }, from[0] + ex / len, from[1] + ey / len, from[2] + ez / len, (ex / len) * sp, (ey / len) * sp, (ez / len) * sp, 6, true); if (a) a.from = S.id;
          broadcast(room, { t: 'fx', k: 'shot', x: r2(from[0]), y: r2(from[1]), z: r2(from[2]), dx: r2(ex / len), dy: r2(ey / len), dz: r2(ez / len) });
          m.arrowT = 3 + rnd() * 2; m.shootT = 0.5;
        }
        if (aboard && hd > 7) { gx = tlx; gz = tlz; speed = def.speed * 0.7; } else { gx = null; }
      } else { // a sword: runs at a player on the deck, or toward the nearest part of the deck
        if (aboard) { gx = tlx; gz = tlz; }
        else if (!m.gT || (m.gT -= dt) <= 0) { m.gT = 0.6; const c = cellOf(levelCells(S, m.deckY - 1), tlx, tlz); if (c) { gx = c[0]; gz = c[1]; } }
        speed = def.speed;
        if (hd < 2.1 && Math.abs(tgt.y - m.y) < 2 && m.atkT <= 0) { damagePlayer(room, tgt, def.dmg, { kind: 'mob', name: def.name }, [(dx / (hd || 1)) * 5, 4, (dz / (hd || 1)) * 5]); m.atkT = 1.0; m.swing = 0.4; }
      }
    } else if (gx === null || gx === undefined || Math.hypot(gx - lx, gz - lz) < 0.3 || rnd() < 0.004) { // wander between cells of the deck
      const cs = [...levelCells(S, m.deckY - 1)], c = cs.length ? cs[(rnd() * cs.length) | 0] : null; if (c) { const [a, b] = c.split(',').map(Number); gx = a; gz = b; }
    }
    let moving = false;
    if (gx !== null && gx !== undefined) {
      const cells = levelCells(S, m.deckY - 1), d = Math.hypot(gx - lx, gz - lz);
      if (d > 0.15 && cells.size) {
        // head for the goal itself when it is in the same cell, else for the next cell on the way round whatever is in the road
        let wx = gx, wz = gz; const a = cellOf(cells, lx, lz), g = cellOf(cells, gx, gz);
        if (a && g && (a[0] !== g[0] || a[1] !== g[1])) { const n = nextCell(S, m.deckY - 1, cells, a, g); if (n) { wx = n[0]; wz = n[1]; } else gx = null; }
        if (gx !== null) {
          const dx = wx - lx, dz = wz - lz, dd = Math.hypot(dx, dz) || 1, mv = Math.min(speed * dt, dd), sx = (dx / dd) * mv, sz = (dz / dd) * mv;
          if (bodyOk(cells, lx + sx, lz + sz)) { lx += sx; lz += sz; moving = true; } else if (bodyOk(cells, lx + sx, lz)) { lx += sx; moving = true; } else if (bodyOk(cells, lx, lz + sz)) { lz += sz; moving = true; }
          else if (!bodyOk(cells, lx, lz) && a) { lx += (a[0] - lx) * Math.min(1, 4 * dt); lz += (a[1] - lz) * Math.min(1, 4 * dt); moving = true; } // (found itself half in a block: slide back to the middle of its cell)
          else gx = null;
          if (faceX === null) { faceX = dx; faceZ = dz; }
        }
      }
    }
    m.lx = lx; m.lz = lz; m.gx = gx; m.gz = gz; m.moving = moving;
    if (faceX !== null && (faceX || faceZ)) m.ly = wrap(Math.atan2(-faceX, -faceZ)); // (the way it faces, in the ship's frame)
    const [x, y, z] = toWorld(S, lx, m.deckY, lz, t); m.x = x; m.y = y; m.z = z;
    m.yaw += wrap(S.yaw + (m.ly || 0) - m.yaw) * Math.min(1, 10 * dt);
  }
}

// What lies in a pirate ship's chest: iron, cannonballs, musket balls, gunpowder, iron swords and flintlock pistols, now and then a diamond, and the galley's fishing poles, leather armor and raw fish.
function pirateLoot() {
  const c = newContainer('chest'), slots = [...Array(27).keys()].sort(() => rnd() - 0.5), put = (id, n) => { if (slots.length && n > 0) c.s[slots.pop()] = mk(id, n, 0); };
  const R = (a, b) => a + ((rnd() * (b - a + 1)) | 0);
  if (rnd() < 0.85) put(I.IRON_INGOT, R(2, 9));
  if (rnd() < 0.7) put(I.CANNONBALL, R(2, 8));
  if (rnd() < 0.8) put(I.MUSKET_BALL, R(4, 16));
  if (rnd() < 0.8) put(I.GUNPOWDER, R(3, 10));
  if (rnd() < 0.45) put(toolId('sword', 2), 1);
  if (rnd() < 0.35) put(I.FLINTLOCK, 1);
  if (rnd() < 0.07) put(I.DIAMOND, R(1, 2)); // rare
  if (rnd() < 0.4) put(I.FISHING_ROD, 1);
  for (let i = 0; i < 2; i++) if (rnd() < 0.4) put(armorId(R(0, 3), 0), 1); // leather armor
  if (rnd() < 0.7) put(rnd() < 0.5 ? I.RAW_SALMON : I.TROPICAL_FISH, R(3, 8));
  return c;
}
// A pirate ship rarely appears out on deep water, some way from a player. It needs open sea all round (no ground within its length) and nothing sticking out of the water.
export function trySpawnPirateShip(room, p) {
  const ships = shipsOf(room); let all = 0;
  const R = viewOf(p); // the player's view distance in blocks: the ship appears at the edge of it or closer, so it can show up even with a low view distance
  for (const S of ships.values()) if (S.kind === 'pirate' && !S.keep) { all++; if (Math.hypot(S.x - p.x, S.z - p.z) < Math.min(200, R + 60)) return false; }
  if (all >= 1 + room.players.size) return false;
  const sea = seaOf(room.gen), dMax = Math.max(14, Math.min(100, R - 8)), dMin = Math.min(60, dMax * 0.55); // (with a long view distance it is still 60 to 100 blocks out; with a short one it comes in closer)
  for (let tries = 0; tries < 24; tries++) {
    const r0 = rnd(), size = PIRATE_SIZES[r0 < 0.3 ? 0 : r0 < 0.65 ? 1 : 2], rc = size === 'large' ? 18 : size === 'medium' ? 12 : 9; // (the clear water needed all round depends on the ship's size)
    const a = rnd() * 6.2832, d = dMin + rnd() * (dMax - dMin), x = fl(p.x + Math.cos(a) * d), z = fl(p.z + Math.sin(a) * d);
    let ok = true;
    for (const dx of [-rc, -rc / 2, 0, rc / 2, rc]) { for (const dz of [-rc, -rc / 2, 0, rc / 2, rc]) if (sea - column(x + fl(dx), z + fl(dz), room.seed, room.gen).h < 5) { ok = false; break; } if (!ok) break; } // deep water all round, natural sea floor well down
    if (!ok) continue;
    const sf = surfaceAt(room, x + 0.5, z + 0.5, sea); if (sf === null) continue;
    for (let dx = -rc; dx <= rc && ok; dx += 3) for (let dz = -rc; dz <= rc && ok; dz += 3) for (let y = fl(sf); y <= fl(sf) + 9; y += 3) { const id = blockAt(room, x + dx, y, z + dz, false); if (id > 0 && isSolid(id)) { ok = false; break; } } // nothing built or growing out of the water there
    if (!ok) continue;
    buildPirate(room, x + 0.5, z + 0.5, rnd() * 6.2832, size, sf, -1);
    return true;
  }
  return false;
}
// Loot for chests that are part of a structure in the world: a pirate outpost (a good haul) or a shipwreck (the same sort of things, a bit less, and nothing much by way of guns).
export function lootFor(kind) {
  const c = newContainer('chest'), slots = [...Array(27).keys()].sort(() => rnd() - 0.5), put = (id, n) => { if (slots.length && n > 0) c.s[slots.pop()] = mk(id, n, 0); }, R = (a, b) => a + ((rnd() * (b - a + 1)) | 0);
  if (kind === 'outpost') {
    if (rnd() < 0.9) put(I.IRON_INGOT, R(3, 12)); if (rnd() < 0.5) put(I.GOLD_INGOT, R(1, 5)); if (rnd() < 0.7) put(I.CANNONBALL, R(3, 10)); if (rnd() < 0.85) put(I.MUSKET_BALL, R(6, 20)); if (rnd() < 0.85) put(I.GUNPOWDER, R(4, 12));
    if (rnd() < 0.5) put(toolId('sword', 2), 1); if (rnd() < 0.4) put(I.FLINTLOCK, 1); if (rnd() < 0.12) put(I.DIAMOND, R(1, 3)); if (rnd() < 0.45) put(armorId(R(0, 3), 1), 1); if (rnd() < 0.6) put(I.COOKED_SALMON, R(2, 6)); if (rnd() < 0.4) put(I.BREAD, R(2, 6));
  } else {
    if (rnd() < 0.7) put(I.IRON_INGOT, R(1, 5)); if (rnd() < 0.5) put(I.CANNONBALL, R(1, 5)); if (rnd() < 0.55) put(I.MUSKET_BALL, R(2, 8)); if (rnd() < 0.55) put(I.GUNPOWDER, R(1, 6));
    if (rnd() < 0.2) put(toolId('sword', 2), 1); if (rnd() < 0.1) put(I.FLINTLOCK, 1); if (rnd() < 0.03) put(I.DIAMOND, 1); if (rnd() < 0.3) put(I.FISHING_ROD, 1); if (rnd() < 0.25) put(armorId(R(0, 3), 0), 1); if (rnd() < 0.4) put(I.RAW_SALMON, R(1, 4));
    if (rnd() < 0.3) put(I.SLIME, R(1, 3));
  }
  return c;
}
// Where a bed on a ship is now (the spot on top of it), or null when the ship or the bed is gone.
export function shipSpawnPos(room, sp) {
  for (const S of shipsOf(room).values()) {
    if (S.uid !== sp.u) continue;
    if (!isBed(S.blocks.get(bk(sp.lx, sp.ly, sp.lz)))) return null;
    const [x, y, z] = toWorld(S, sp.lx + 0.5, sp.ly + BED_H + 0.1, sp.lz + 0.5, tSec()); return { x, y: y + 0.1, z };
  }
  return null;
}
// One pirate ship afloat at (x, z) facing yaw, with a chest or two of loot and crewN pirates (-1: the usual number for its size) plus a lookout in the crow's nest.
function buildPirate(room, x, z, yaw, size, sf, crewN, extra = {}) {
  const ps = pirateShipBlocks(size), S = newShip(room, 'pirate', x, 0, z, yaw, ps.blocks, { draft: size === 'small' ? 0.5 : size === 'medium' ? 0.8 : 1.0, size, ...extra });
  S.y = sf - S.draft - S.b.y0;
  for (const [cx, cy, cz] of ps.chests) S.chests.set(bk(cx, cy, cz), pirateLoot());
  const crew = crewN >= 0 ? crewN : size === 'large' ? 3 + ((rnd() * 3) | 0) : size === 'medium' ? 2 + ((rnd() * 2) | 0) : 1 + ((rnd() * 2) | 0), deck = S.deck.filter(([, cy, cz]) => cy === ps.deckY - 1 && cz > ps.zr[0] && cz < ps.zr[1]); // (only the deck floor: not a rail, a mast top or the bowsprit)
  for (let i = 0; i < crew && deck.length; i++) {
    const c = deck[(rnd() * deck.length) | 0], m = spawnMob(room, 'pirate', S.x, S.y, S.z);
    Object.assign(m, { shipId: S.id, lx: c[0], lz: c[2], deckY: c[1] + 1, aux: i % 2 === 0 ? 0 : 1, ly: rnd() * 6.28, gx: null, gz: null, moving: false, hp: m.hp });
    S.crew.push(m.id);
  }
  if (ps.nest && crew > 0) { // the lookout: a pirate with a pistol up in the crow's nest, who never comes down
    const m = spawnMob(room, 'pirate', S.x, S.y, S.z);
    Object.assign(m, { shipId: S.id, lx: ps.nest[0], lz: ps.nest[2], deckY: ps.nest[1] + 1, aux: 1, ly: rnd() * 6.28, gx: null, gz: null, moving: false, lookout: true });
    S.crew.push(m.id);
  }
  return S;
}
// Ships at the docks of pirate outposts. When somebody comes within sight of an outpost, each empty berth is likely (not certain) to get a ship tied up in it, and about
// half of those have no crew at all. They stay put until a player comes close. Once taken, a ship is yours (or kept as you left it), and the berth can fill again later.
const DOCK_CHANCE = 0.7, DOCK_EMPTY = 0.45;
function tickDocks(room, dt) {
  room.dockT = (room.dockT || 0) - dt; if (room.dockT > 0) return; room.dockT = 1.5;
  const docks = room.docks ||= new Map(), now = Date.now(), sea = seaOf(room.gen);
  for (const p of room.players.values()) {
    if (p.dead) continue;
    for (const o of outpostsNear(room.seed, p.x, p.z, 120)) {
      o.berths.forEach((b, i) => {
        const key = `${o.key}#${i}`, st = docks.get(key) || { id: 0, cool: 0 }; docks.set(key, st);
        const S = st.id && shipsOf(room).get(st.id); if (S && Math.hypot(S.x - b.x, S.z - b.z) < 16) return; // taken
        if (now < st.cool) return; st.cool = now + 90000; st.id = 0;
        if (Math.hypot(b.x - p.x, b.z - p.z) < 28 || rnd() > DOCK_CHANCE) return; // (never right in front of somebody's nose)
        const size = b.sizes[(rnd() * b.sizes.length) | 0], sf = surfaceAt(room, b.x, b.z, sea); if (sf === null) return;
        const ship = buildPirate(room, b.x, b.z, b.yaw, size, sf, rnd() < DOCK_EMPTY ? 0 : -1, { moor: true });
        if (blocked(room, ship, ship.x, ship.y, ship.z, ship.yaw)) { deleteShip(room, ship); return; } // (something is in the way: leave the berth empty)
        st.id = ship.id;
      });
    }
  }
}
// The garrison of a pirate outpost: a handful of pirates (swords and pistols) on its floors and lookouts on its towers. They stand on a "fort", a ship that does not float: the same
// walking, fighting and shooting as the crews of ships, over the outpost's own floor. They are not kept in the save, but a cleared outpost stays cleared for 20 minutes.
function spawnFort(room, o) {
  const SL = seaOf(room.gen), blocks = new Map(), ox = o.X, oz = o.Z;
  for (const [x, y, z, id] of o.blocks()) if (id > 0) blocks.set(bk(x - ox, y - SL, z - oz), id);
  const S = { id: 1e8 + (++room.entId), kind: 'fort', fort: true, key: o.key, x: ox, y: SL, z: oz, yaw: 0, blocks, cannons: new Map(), chests: new Map(), crew: [], ver: 0 };
  refresh(S);
  const cx = o.X - o.dx * 12, cz = o.Z - o.dz * 12, level = (cy) => S.deck.filter(([lx, cy2, lz]) => cy2 === cy && Math.hypot(ox + lx - cx, oz + lz - cz) < 16);
  const floor = level(1), n = 4 + ((rnd() * 3) | 0);
  const add = (c, aux, look) => { const m = spawnMob(room, 'pirate', ox + c[0], SL + c[1] + 1, oz + c[2]); if (!m) return; Object.assign(m, { shipId: S.id, lx: c[0], lz: c[2], deckY: c[1] + 1, aux, ly: rnd() * 6.28, gx: null, gz: null, moving: false, ...(look ? { lookout: true } : {}) }); S.crew.push(m.id); };
  for (let i = 0; i < n && floor.length; i++) add(floor[(rnd() * floor.length) | 0], i % 2 === 0 ? 0 : 1, false);
  for (const [ta, tb, th] of o.towers || []) { const [wx, wz] = o.w(ta, tb), cells = S.deck.filter(([lx, cy, lz]) => cy === th + 1 && Math.hypot(ox + lx - wx, oz + lz - wz) < 2.6); if (cells.length) add(cells[(rnd() * cells.length) | 0], 1, true); }
  if (!S.crew.length) return;
  (room.forts ||= new Map()).set(o.key, S);
}
function tickForts(room, dt) {
  if (room.gen < 11) return;
  const forts = room.forts ||= new Map(), t = tSec(), clr = room.fortClear ||= {};
  room.fortT = (room.fortT || 0) - dt;
  if (room.fortT <= 0) {
    room.fortT = 1.5;
    if (room.mode !== 'creative') for (const p of room.players.values()) {
      if (p.dead) continue;
      for (const o of outpostsNear(room.seed, p.x, p.z, 100)) { if (forts.has(o.key) || (clr[o.key] && Date.now() - clr[o.key] < 20 * 60000)) continue; if (Math.hypot(o.X - p.x, o.Z - p.z) < 90) spawnFort(room, o); }
    }
  }
  for (const [key, S] of [...forts]) {
    S.crew = S.crew.filter((id) => room.mobs.has(id));
    if (!S.crew.length) { forts.delete(key); clr[key] = Date.now(); if (room.markDirty) room.markDirty(); continue; } // (they are all dead: the outpost is cleared for a while)
    if (near2(room, S, 130)) tickCrew(room, S, dt, t);
  }
}
// What a player is told about the ships near them: the block list when it is new or changed, and every update the ship's place.
export function shipsMsg(room, p) {
  const ships = room.ships, out = [], seen = (p.shipVer ||= new Map());
  if (!ships || !ships.size) { seen.clear(); return out; }
  for (const S of ships.values()) {
    const sr = Math.max(100, viewOf(p) + 40); if ((S.x - p.x) ** 2 + (S.z - p.z) ** 2 > sr * sr) { seen.delete(S.id); continue; } // (a ship is sent while it can be in view; the sea beyond that costs nothing)
    if (seen.get(S.id) !== S.ver) {
      seen.set(S.id, S.ver);
      const b = []; for (const [k, id] of S.blocks) { const [x, y, z] = unbk(k); b.push(x, y, z, id); }
      send(p.ws, { t: 'ship', op: 'blocks', id: S.id, kind: S.kind === 'pirate' ? 1 : 0, ver: S.ver, fr: S.fr | 0, b });
    }
    out.push([S.id, S.kind === 'pirate' ? 1 : 0, r2(S.x), r2(S.y), r2(S.z), r2(S.yaw), S.ver, r2(S.speed), S.helm]);
  }
  for (const id of [...seen.keys()]) if (!ships.has(id)) seen.delete(id);
  return out;
}
export function releaseHelm(room, p) { const S = p.helmShip && shipsOf(room).get(p.helmShip); if (S && S.helm === p.id) { S.helm = 0; S.inF = S.inS = 0; } p.helmShip = 0; }
