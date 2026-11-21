// Weather. A world is either clear or stormy, and what a storm is depends on where you stand: rain in the temperate land, a snowstorm in the cold biome,
// a sandstorm in the desert. The storm itself is one switch for the whole world (clients draw it); this file also makes it do things:
//  - a snowstorm builds loose snow layers on open ground in the cold biome, up to six eighths of a block;
//  - a sandstorm builds sand layers, but only where sand can be caught: next to higher ground (a dune, a stone, a wall, other sand layers). Flat ground gets none,
//    and nothing ever piles up around a cactus;
//  - when it is not storming, loose snow slowly packs down into packed snow, which no longer falls.
// Only generation 4 worlds have these biomes; older worlds just get rain that does nothing. Protected chunks are never changed.
import { CH, B, biomeAt, isSolid, isWater, isLayer, layerKind, layerN, layerId, layerFull, isPlant } from '../public/shared/world.js';
import { blockAt, setBlock, claimAt } from './world.js';
import { broadcast } from './net.js';

const rnd = Math.random, fl = Math.floor;
const MAX_EDITS = 120000; // storms stop building once a world holds this many edits, so they can never fill up the save file
export const weatherOf = (room) => !!(room.wx && room.wx.on);
export function setWeather(room, on, secs) {
  const w = (room.wx ||= { on: false, t: 0 });
  w.on = !!on; w.t = secs || (on ? 180 + rnd() * 180 : 360 + rnd() * 480);
  broadcast(room, { t: 'wx', on: w.on });
}
// The first solid thing seen from above at (x, z): its height and id, or null (not generated yet, water, a tree top, a plant, a cactus).
function surface(room, x, z) {
  for (let y = CH - 1; y >= 1; y--) {
    const b = blockAt(room, x, y, z, false);
    if (b === -1) return null;
    if (b === 0) continue;
    if (isWater(b) || isPlant(b) || b === B.CACTUS || b === B.LEAVES || b === B.SPRUCE_LEAVES || b === B.LOG || b === B.SPRUCE_LOG) return null;
    return { y, b };
  }
  return null;
}
// The height of the top of a column in eighths of a block (a full block counts 8, a layer its own thickness).
function level(room, x, z) {
  for (let y = CH - 1; y >= 1; y--) {
    const b = blockAt(room, x, y, z, false);
    if (b === -1) return -1;
    if (b === 0 || isPlant(b) || isWater(b)) continue;
    return isLayer(b) ? y * 8 + layerN(b) : (y + 1) * 8;
  }
  return 8;
}
const occupied = (room, x, y, z) => {
  for (const q of room.players.values()) if (!q.dead && Math.abs(q.x - x - 0.5) < 1.2 && Math.abs(q.z - z - 0.5) < 1.2 && q.y < y + 2 && q.y + 1.9 > y) return true;
  for (const m of room.mobs.values()) if (Math.abs(m.x - x - 0.5) < 1.2 && Math.abs(m.z - z - 0.5) < 1.2 && m.y < y + 2 && m.y + 1.5 > y) return true;
  return false;
};
function snowAt(room, x, z) {
  const s = surface(room, x, z); if (!s) return;
  const { y, b } = s;
  if (isLayer(b)) {
    const k = layerKind(b), n = layerN(b);
    if (k === 0 || n >= 6 || occupied(room, x, y, z)) return; // storms build up to six eighths; sand layers are left alone
    setBlock(room, x, y, z, layerId(k, n + 1));
  } else if (isSolid(b) && b !== B.SNOW && b !== B.PACKED_SNOW && y + 1 < CH && !occupied(room, x, y + 1, z) && blockAt(room, x, y + 1, z, false) === 0) setBlock(room, x, y + 1, z, layerId(1, 1));
}
function sandAt(room, x, z) {
  const s = surface(room, x, z); if (!s) return;
  const { y, b } = s;
  if (b === B.SNOW || b === B.PACKED_SNOW || (isLayer(b) && layerKind(b) !== 0)) return;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 4; dy++) if (blockAt(room, x + dx, y + dy, z + dz, false) === B.CACTUS) return; // a cactus is never buried
  const here = isLayer(b) ? y * 8 + layerN(b) : (y + 1) * 8;
  let top = 0, higher = 0;
  for (const [a, c] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const l = level(room, x + a, z + c); if (l < 0) return;
    if (l >= here + 2) { higher++; top = Math.max(top, l); }
  }
  if (!higher || rnd() > 0.3 + 0.12 * higher) return; // sand is caught by bumps: it needs higher ground next to it, and more of it makes it likelier
  if (isLayer(b)) {
    const n = layerN(b);
    if (occupied(room, x, y, z)) return;
    setBlock(room, x, y, z, n >= 7 ? layerFull(0) : layerId(0, n + 1));
  } else if (y + 1 < CH && blockAt(room, x, y + 1, z, false) === 0 && !occupied(room, x, y + 1, z)) setBlock(room, x, y + 1, z, layerId(0, 1));
}
function packAt(room, x, z) {
  const s = surface(room, x, z); if (!s || !isLayer(s.b) || layerKind(s.b) !== 1) return;
  setBlock(room, x, s.y, z, layerId(2, layerN(s.b)));
}
// Called every server tick (20 per second).
export function tickWeather(room, n) {
  const w = (room.wx ||= { on: false, t: 60 + rnd() * 180 });
  if (n % 20 === 0 && --w.t <= 0) setWeather(room, !w.on);
  if (room.gen < 4 || n % 4 || room.edits.size > MAX_EDITS) return; // five times a second
  const gen = room.gen, seed = room.seed;
  for (const p of room.players.values()) {
    if (p.dead) continue;
    for (let i = 0; i < (w.on ? 12 : 4); i++) {
      const a = rnd() * 6.2832, d = 4 + Math.sqrt(rnd()) * 44, x = fl(p.x + Math.cos(a) * d), z = fl(p.z + Math.sin(a) * d);
      if (claimAt(room, x, z)) continue;
      const bio = biomeAt(x + 0.5, z + 0.5, seed, gen);
      if (bio === 2) { if (w.on) snowAt(room, x, z); else if (rnd() < 0.6) packAt(room, x, z); }
      else if (bio === 1 && w.on) sandAt(room, x, z);
    }
  }
}
