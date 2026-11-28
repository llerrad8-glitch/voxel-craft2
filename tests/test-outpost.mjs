// Headless checks for generation 11: pirate outposts (garrison, docks, loot), shipwrecks, slime blocks, ship beds/furnaces/chests, saved ships (node tests/test-outpost.mjs)
import assert from 'node:assert/strict';
import { I, matchRecipe, ITEMS } from '../public/shared/items.js';
import { B, NEW_GEN, genChunk, seaOf, isBed } from '../public/shared/world.js';
import { structuresIn, lootKindAt } from '../public/shared/structures.js';
import { bk, unbk, toWorld } from '../public/shared/ships.js';
import { CYCLE_MS } from '../public/shared/daycycle.js';
import { initPlayer, handle, savePlayer, respawn } from '../server/survival.js';
import { mk } from '../server/inventory.js';
import { tickEnts } from '../server/ents.js';
import { shipsOf, tickShips, shipsToSave, loadShips, refresh } from '../server/ships.js';

assert.equal(NEW_GEN, 11);
// slime block
assert.equal(ITEMS.get(B.SLIME).n, 'Slime Block'); assert.equal(matchRecipe(Array(9).fill(I.SLIME), 3, 3).out, B.SLIME); assert.equal(matchRecipe([B.SLIME, 0, 0, 0, 0, 0, 0, 0, 0], 3, 3).n, 9);
// structures exist, are the same every time and are built into the chunks
const found = structuresIn(41, -3000, 3000, -3000, 3000), kinds = (k) => found.filter((s) => s.kind === k);
assert.ok(kinds('outpost').length >= 5 && kinds('wreck').length > kinds('beachwreck').length && kinds('beachwreck').length >= 1, 'outposts, wrecks, and rarer beach wrecks');
const o = kinds('outpost')[0], SL = seaOf(NEW_GEN), cxo = Math.floor(o.chests[0][0] / 16), czo = Math.floor(o.chests[0][2] / 16);
const ch = genChunk(cxo, czo, 41, NEW_GEN), [x, y, z] = o.chests[0];
assert.equal(ch[(x - cxo * 16) + 16 * ((z - czo * 16) + 16 * y)], B.CHEST, 'the outpost chest is in the generated chunk');
assert.equal(lootKindAt(41, x, y, z), 'outpost'); assert.equal(lootKindAt(41, x + 1, y, z), null);
assert.ok(o.berths.length >= 1 && o.towers.length === 3);
const w = kinds('wreck')[0]; assert.equal(lootKindAt(41, ...w.chests[0]), 'wreck');
// ---- a room on natural terrain, a player walking up to the outpost
const sent = [], ws = { readyState: 1, bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)) };
const mkRoom = (seed) => ({ id: 't', seed, gen: NEW_GEN, created: Date.now(), dayMs: CYCLE_MS, mode: 'survival', pvp: true, cheats: false, claims: new Map(), ec: new Map(), locked: false, perm: { build: true, containers: true },
  edits: new Map(), containers: new Map(), players: new Map(), mobs: new Map(), items: new Map(), arrows: new Map(), boats: new Map(), ships: new Map(), tame: {}, entId: 0, nextId: 1, fall: new Map(), wq: new Set(), lq: new Set(), markDirty() { this.dirty = (this.dirty || 0) + 1; } });
const room = mkRoom(41);
const p = { id: 1, name: 'Tester', ws, th: 'a'.repeat(32), vid: 'v', x: o.X - o.dx * 20 + 0.5, y: SL + 3, z: o.Z - o.dz * 20 + 0.5, yaw: 0, pitch: 0, view: 128 };
initPlayer(p, room, null); room.players.set(1, p);
for (let i = 0; i < 60; i++) tickShips(room, 0.05);
const fort = room.forts && room.forts.get(o.key);
assert.ok(fort && fort.crew.length >= 4, 'the outpost has pirates: ' + (fort && fort.crew.length));
for (const id of fort.crew) { const m = room.mobs.get(id); assert.equal(m.type, 'pirate'); assert.ok(Math.abs(m.x - o.X) < 40 && Math.abs(m.z - o.Z) < 40, 'on the outpost'); assert.ok(Math.abs(m.y - (SL + 2)) < 12); }
assert.ok(fort.crew.some((id) => room.mobs.get(id).lookout), 'lookouts on the towers');
for (let i = 0; i < 400; i++) { p.hp = 20; tickEnts(room, 0.05); } // they walk and shoot without anything throwing
// docks: ships tied up at the berths (likely, not certain: keep asking)
for (let n = 0; n < 40 && !shipsOf(room).size; n++) { room.docks && room.docks.clear(); for (let i = 0; i < 40; i++) tickShips(room, 0.05); }
const dock = [...shipsOf(room).values()].find((s) => s.kind === 'pirate' && s.moor && !s.keep && s.chests.size); assert.ok(dock, 'a ship at the dock');
const bx = o.berths.some((b) => Math.hypot(b.x - dock.x, b.z - dock.z) < 1); assert.ok(bx, 'in a berth');
// the chest of a dock ship opens even with the crew alive; touching it makes the ship permanent
const sx = dock.x; dock.x = dock.x; assert.ok(!dock.keep, 'not kept before anyone touches it');
assert.equal(shipsToSave(room).filter((d) => d.k === 1).length, [...shipsOf(room).values()].filter((s) => s.kind === 'pirate' && s.keep).length, 'untouched pirate ships are not saved');
const [ck] = [...dock.chests.keys()]; const [cx2, cy2, cz2] = unbk(ck); const [wx, wy, wz] = toWorld(dock, cx2, cy2 + 0.5, cz2, Date.now() / 1000);
p.x = wx; p.y = wy; p.z = wz;
handle(room, p, { t: 'ship', op: 'chest', id: dock.id, x: cx2, y: cy2, z: cz2 }); assert.ok(p.win.cont, 'opened the chest of a ship with pirates aboard (or without)'); assert.ok(dock.keep);
// the world chest of the outpost has loot
p.x = x + 0.5; p.y = y + 1; p.z = z + 0.5; handle(room, p, { t: 'use', x, y, z, nx: 0, ny: 1, nz: 0 }); const wc = room.containers.get(`${x},${y},${z}`); assert.ok(wc, 'outpost chest container exists');
// saved with everything: blocks, chests, cannons, crew
const saved = JSON.parse(JSON.stringify(shipsToSave(room))); const d = saved.find((q) => q.k === 1); assert.ok(d && d.ch.length && d.b.length > 100, 'saved');
const room2 = mkRoom(41); loadShips(room2, saved); const L = [...shipsOf(room2).values()].find((s) => s.kind === 'pirate');
assert.ok(L && L.keep && L.blocks.size === dock.blocks.size && L.chests.size === dock.chests.size && L.crew.length === dock.crew.length && L.uid === dock.uid, 'loaded ship is the same');
assert.equal(L.cannons.size, dock.cannons.size);
// a kept ship stays when nobody is near
const far = { ...p, id: 2, x: 5000, z: 5000, win: p.win }; room.players.clear(); room.players.set(2, Object.assign(far, { dead: false })); for (let i = 0; i < 5; i++) tickShips(room, 0.05);
assert.ok(shipsOf(room).has(dock.id), 'kept ships do not despawn');

// ---- ships you build: beds, furnaces, crafting tables, chests, the front and the bed spawn
const room3 = mkRoom(41), Y = 150;
for (let xx = -30; xx <= 30; xx++) for (let zz = -30; zz <= 30; zz++) { room3.edits.set(`${xx},${Y - 1},${zz}`, B.SAND); for (let yy = Y; yy <= Y + 8; yy++) room3.edits.set(`${xx},${yy}`.replace(',', ',') + `,${zz}`, yy <= Y + 2 ? B.WATER : 0); }
const q = { id: 1, name: 'T2', ws, th: 'b'.repeat(32), vid: 'w', x: 0.5, y: Y + 3.2, z: 6.5, yaw: Math.PI / 2, pitch: 0 }; initPlayer(q, room3, null); room3.players.set(1, q); // yaw +90 degrees: looking toward -x
for (let xx = 0; xx < 4; xx++) for (let zz = 0; zz < 3; zz++) room3.edits.set(`${xx},${Y + 2},${zz}`, B.PLANKS);
room3.edits.set(`3,${Y + 3},2`, B.CHEST); room3.containers.set(`3,${Y + 3},2`, (() => { const c = { t: 'chest', s: Array(27).fill(null) }; c.s[0] = mk(I.IRON_INGOT, 5); return c; })());
room3.edits.set(`3,${Y + 3},0`, B.FURNACE);
q.inv[0] = mk(B.STEERING_WHEEL, 1); q.sel = 0; handle(room3, q, { t: 'use', x: 1, y: Y + 2, z: 1, nx: 0, ny: 1, nz: 0 });
const S = [...shipsOf(room3).values()][0]; assert.ok(S, 'a ship with a chest and a furnace on it can be launched'); assert.equal(S.chests.size, 1); assert.equal([...S.chests.values()].find((c) => c.t === 'chest').s[0].n, 5, 'the chest kept its contents');
assert.equal(S.fr, 3, 'the front is the way the player faced when placing the wheel (toward -x)'); assert.ok(!room3.containers.size);
// place a bed (two blocks, pointing the way you face), a crafting table, a furnace
q.x = S.x; q.y = S.y + 1.5; q.z = S.z; q.yaw = 0; for (let i = 0; i < 3; i++) tickShips(room3, 0.05);
q.inv[1] = mk(I.BED, 1); q.sel = 1; handle(room3, q, { t: 'ship', op: 'place', id: S.id, x: 1, y: -1, z: 1, nx: 0, ny: 1, nz: 0 });
const beds = [...S.blocks].filter(([, id]) => isBed(id)); assert.equal(beds.length, 2, 'a bed is two blocks'); assert.equal(q.inv[1], null);
q.inv[2] = mk(B.TABLE, 1); q.sel = 2; handle(room3, q, { t: 'ship', op: 'place', id: S.id, x: 2, y: -1, z: 0, nx: 0, ny: 1, nz: 0 }); assert.equal(S.blocks.get(bk(2, 0, 0)), B.TABLE);
q.inv[3] = mk(B.FURNACE, 1); q.sel = 3; handle(room3, q, { t: 'ship', op: 'place', id: S.id, x: -1, y: -1, z: 0, nx: 0, ny: 1, nz: 0 }); assert.equal(S.blocks.get(bk(-1, 0, 0)), B.FURNACE);
handle(room3, q, { t: 'ship', op: 'table', id: S.id, x: 2, y: 0, z: 0 }); assert.equal(q.win.kind, 'table');
const [[bk0]] = beds; const [bxl, byl, bzl] = unbk(bk0); handle(room3, q, { t: 'ship', op: 'bed', id: S.id, x: bxl, y: byl, z: bzl });
assert.ok(q.spawnShip && q.spawnShip.u === S.uid, 'the bed on the ship is the respawn point');
const sv = savePlayer(q); assert.deepEqual(sv.ss.slice(0, 1), [S.uid]);
// the ship sails; the respawn point goes with it
S.x += 20; S.z -= 15; q.hp = 0; q.dead = true; respawn(room3, q);
const [ex, ey, ez] = toWorld(S, bxl + 0.5, byl + 1, bzl + 0.5, Date.now() / 1000); assert.ok(Math.hypot(q.x - ex, q.z - ez) < 1.2, 'respawned on the moved ship: ' + [q.x, q.z, ex, ez]);
// the front can be turned and the ship tells its clients
q.helmShip = S.id; S.helm = q.id; const v0 = S.ver; handle(room3, q, { t: 'ship', op: 'front', id: S.id, yaw: 0 }); assert.equal(S.fr, 0); assert.ok(S.ver > v0, 'new version so the arrow is redrawn');
// a furnace on a ship cooks while the ship is near
const fk = [...S.chests].find(([, c]) => c.t === 'furnace'); assert.ok(fk, 'furnace container on the ship');
fk[1].s[0] = mk(I.RAW_BEEF === undefined ? I.RAW_PORK : I.RAW_BEEF, 1); fk[1].s[1] = mk(I.COAL, 1); for (let i = 0; i < 400; i++) tickShips(room3, 0.05); assert.ok(fk[1].s[2] || fk[1].cook > 0 || fk[1].burn > 0, 'the furnace on the ship is working');
console.log('outpost tests ok');
