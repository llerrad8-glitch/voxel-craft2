// Headless checks for view-distance behaviour: pirate ships spawn inside a short view distance; birds vanish past the edge of view instead of freezing (run with: node tests/test-view.mjs)
import assert from 'node:assert/strict';
import { NEW_GEN } from '../public/shared/world.js';
import { CYCLE_MS } from '../public/shared/daycycle.js';
import { tickEnts, entsFor, spawnMob } from '../server/ents.js';
import { shipsOf, trySpawnPirateShip } from '../server/ships.js';
const mkRoom = () => ({ id: 't', seed: 41, gen: NEW_GEN, created: Date.now(), dayMs: CYCLE_MS, mode: 'survival', pvp: true, cheats: false, claims: new Map(), ec: new Map(), locked: false, perm: { build: true, containers: true },
  edits: new Map(), containers: new Map(), players: new Map(), mobs: new Map(), items: new Map(), arrows: new Map(), boats: new Map(), ships: new Map(), tame: {}, entId: 0, nextId: 1, fall: new Map(), wq: new Set(), lq: new Set(), markDirty() {} });
for (const viewR of [48, 96, 256]) {
  const room = mkRoom(), p = { id: 1, x: 0, y: 40, z: 0, viewR, name: 'a', hp: 20 }; let made = false;
  for (let i = 0; i < 600 && !made; i++) made = trySpawnPirateShip(room, p);
  const S = [...shipsOf(room).values()][0];
  const d = S && Math.hypot(S.x - p.x, S.z - p.z);
  console.log(`view ${viewR}: pirate ship ${made ? 'spawned ' + d.toFixed(0) + ' blocks away' : 'did not spawn'}`);
  if (made) assert.ok(d <= viewR, 'inside the view distance');
}
{ // a duck far past the view distance is removed, one inside it is kept and sent
  const room = mkRoom(), p = { id: 1, x: 0, y: 40, z: 0, viewR: 64, name: 'a', hp: 20, ws: null };
  room.players.set(1, p);
  const near = spawnMob(room, 'duck', 30, 45, 0), far = spawnMob(room, 'duck', 90, 45, 0);
  tickEnts(room, 0.05);
  assert.ok(room.mobs.has(near.id), 'the near duck stays'); assert.ok(!room.mobs.has(far.id), 'the far duck is gone');
}
console.log('view tests ok');
