// Draws a ship: its blocks are meshed by the same mesher as the world (the ship's grid is laid out as little chunks far from the origin), and every cannon gets a barrel.
// A ship is drawn with as few draw calls as possible: all of its little chunks are joined into one mesh per material, all its cannon barrels into two, and the whole thing
// can be skipped when it is off screen (it has a proper bounding sphere) or farther away than you can see (game.js hides it).
import * as THREE from 'three';
import { CS, isCannon, cannonDir } from './shared/world.js';
import { unbk } from './shared/ships.js';
import { buildMeshData, padChunk } from './mesher.js';

const OFF = 32, OFFY = 16; // block (lx, ly, lz) sits at (lx + OFF, ly + OFFY, lz + OFF) in the little chunk grid
const EMPTY = new Uint8Array(CS * CS); // (an empty neighbour: one row of air)
const barrelMat = new THREE.MeshBasicMaterial({ color: 0x2c2e33 }), ringMat = new THREE.MeshBasicMaterial({ color: 0x55585f });
// One barrel and one ring shared by every cannon in the game (they are never disposed).
const BARREL_GEO = new THREE.CylinderGeometry(0.2, 0.26, 1.15, 10).rotateX(Math.PI / 2);
const RING_GEO = new THREE.CylinderGeometry(0.27, 0.27, 0.12, 10).rotateX(Math.PI / 2).translate(0, 0, -0.5);
export function cannonBarrel(dx, dz) { // a barrel lying along (dx, dz), standing on the cannon block's top
  const g = new THREE.Group();
  g.add(new THREE.Mesh(BARREL_GEO, barrelMat), new THREE.Mesh(RING_GEO, ringMat));
  g.rotation.y = Math.atan2(dx, dz); // the barrel lies along local z; point it along (dx, dz)
  return g;
}
// Joins copies of one geometry, each placed by a matrix, into a single geometry.
function mergePlaced(src, mats) {
  const sp = src.attributes.position, sn = src.attributes.normal, si = src.index, n = sp.count, k = mats.length;
  const pos = new Float32Array(n * k * 3), nor = new Float32Array(n * k * 3), idx = new Uint16Array(si.count * k), v = new THREE.Vector3(), nm = new THREE.Matrix3();
  for (let c = 0; c < k; c++) {
    nm.getNormalMatrix(mats[c]);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(sp, i).applyMatrix4(mats[c]); pos.set([v.x, v.y, v.z], (c * n + i) * 3);
      v.fromBufferAttribute(sn, i).applyMatrix3(nm).normalize(); nor.set([v.x, v.y, v.z], (c * n + i) * 3);
    }
    for (let i = 0; i < si.count; i++) idx[c * si.count + i] = si.getX(i) + c * n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
// Joins the parts the mesher made for each little chunk into one geometry (or null when there are none).
function joinParts(list) {
  let nv = 0, ni = 0; for (const q of list) { nv += q.p.length / 3; ni += q.i.length; }
  if (!nv) return null;
  const p = new Float32Array(nv * 3), u = new Float32Array(nv * 2), c = new Float32Array(nv * 3), ix = nv < 65536 ? new Uint16Array(ni) : new Uint32Array(ni);
  let vo = 0, io = 0, mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
  for (const q of list) {
    p.set(q.p, vo * 3); u.set(q.u, vo * 2); c.set(q.c, vo * 3);
    for (let i = 0; i < q.i.length; i++) ix[io + i] = q.i[i] + vo;
    vo += q.p.length / 3; io += q.i.length;
    mnx = Math.min(mnx, q.min[0]); mny = Math.min(mny, q.min[1]); mnz = Math.min(mnz, q.min[2]); mxx = Math.max(mxx, q.max[0]); mxy = Math.max(mxy, q.max[1]); mxz = Math.max(mxz, q.max[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('uv', new THREE.BufferAttribute(u, 2)); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.setIndex(new THREE.BufferAttribute(ix, 1));
  g.boundingBox = new THREE.Box3(new THREE.Vector3(mnx, mny, mnz), new THREE.Vector3(mxx, mxy, mxz));
  g.boundingSphere = new THREE.Sphere(); g.boundingBox.getBoundingSphere(g.boundingSphere); g.boundingSphere.radius += 1.5; // (a little extra for the rocking)
  return g;
}
// Build the meshes for a block map (key -> id). Returns a group in ship-local coordinates; root.userData.rad is how far from the ship's origin anything of it reaches.
export function buildShipGroup(blocks, mats) {
  const root = new THREE.Group(), inner = new THREE.Group();
  inner.position.set(-(OFF + 0.5), -OFFY, -(OFF + 0.5)); root.add(inner);
  const chunks = new Map(); let maxY = 0, rad = 0;
  for (const k of blocks.keys()) { const py = unbk(k)[1] + OFFY; if (py > maxY) maxY = py; }
  const rows = Math.min(255, maxY + 2), barrels = [];
  for (const [k, id] of blocks) {
    const [x, y, z] = unbk(k), px = x + OFF, py = y + OFFY, pz = z + OFF;
    if (px < 0 || pz < 0 || px >= 4 * CS || pz >= 4 * CS || py < 0) continue;
    rad = Math.max(rad, Math.hypot(Math.abs(x) + 0.5, Math.abs(z) + 0.5));
    const key = (px >> 4) + ',' + (pz >> 4); let c = chunks.get(key);
    if (!c) chunks.set(key, (c = new Uint8Array(CS * CS * rows)));
    c[(px & 15) + CS * ((pz & 15) + CS * py)] = id;
    if (isCannon(id)) { const [dx, dz] = cannonDir(id); barrels.push(new THREE.Matrix4().makeRotationY(Math.atan2(dx, dz)).setPosition(x + dx * 0.55, y + 0.75, z + dz * 0.55)); }
  }
  const parts = { o: [], t: [], p: [] };
  for (const key of chunks.keys()) {
    const [cx, cz] = key.split(',').map(Number), ch = [];
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const n = chunks.get(`${cx + a},${cz + b}`); ch.push(padChunk(n || EMPTY, (b + 1) * 3 + a + 1)); }
    const m = buildMeshData(cx, cz, ch, false, 0);
    for (const pk of 'otp') if (m[pk]) parts[pk].push(m[pk]);
  }
  const geos = [];
  for (const [pk, mat] of [['o', mats.o], ['t', mats.t], ['p', mats.p]]) {
    const g = joinParts(parts[pk]); if (!g) continue;
    const m = new THREE.Mesh(g, mat); inner.add(m); geos.push(g); // (frustum culling stays on: the sphere above covers the whole ship)
  }
  if (barrels.length) { // every barrel in one mesh and every ring in another, in ship-local coordinates
    for (const [src, mat] of [[BARREL_GEO, barrelMat], [RING_GEO, ringMat]]) { const g = mergePlaced(src, barrels); g.computeBoundingSphere(); g.boundingSphere.radius += 1; root.add(new THREE.Mesh(g, mat)); geos.push(g); }
  }
  root.userData.geos = geos; root.userData.rad = rad;
  return root;
}
export function disposeShipGroup(g) { for (const geo of g.userData.geos || []) geo.dispose(); }
