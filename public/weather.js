// Weather you can see: rain streaks, drifting snow flakes and blowing sand around the camera. Which one you get depends on the biome you stand in.
// kind: 0 none, 1 rain, 2 snow, 3 sandstorm. k: how strong it is right now (0 to 1, fades in and out).
import * as THREE from 'three';

const N = 1500, R = 15, HI = 13;
export class Weather {
  constructor(scene) {
    this.kind = 0; this.t = 0;
    this.px = new Float32Array(N); this.py = new Float32Array(N); this.pz = new Float32Array(N); this.sp = new Float32Array(N);
    this.rainPos = new Float32Array(N * 6); this.ptsPos = new Float32Array(N * 3);
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaec6ff, transparent: true, opacity: 0.5, depthWrite: false }));
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(this.ptsPos, 3));
    this.snow = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.16, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false }));
    this.sand = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xdcb66f, size: 0.13, sizeAttenuation: true, transparent: true, opacity: 0.75, depthWrite: false }));
    for (const o of [this.rain, this.snow, this.sand]) { o.frustumCulled = false; o.visible = false; o.renderOrder = 3; scene.add(o); }
    this.wind = [0.8, 0.6]; // sandstorms blow one way across the world
  }
  spawn(i, c, anywhere) {
    this.px[i] = c.x + (Math.random() * 2 - 1) * R; this.pz[i] = c.z + (Math.random() * 2 - 1) * R;
    this.py[i] = anywhere ? c.y - 4 + Math.random() * HI : c.y + HI * 0.6 + Math.random() * HI * 0.5;
    this.sp[i] = Math.random();
  }
  update(dt, kind, k, cam) {
    if (kind !== this.kind) { this.kind = kind; for (let i = 0; i < N; i++) this.spawn(i, cam, true); }
    this.rain.visible = kind === 1 && k > 0.02; this.snow.visible = kind === 2 && k > 0.02; this.sand.visible = kind === 3 && k > 0.02;
    if (!kind || k <= 0.02) return;
    this.t += dt;
    const n = Math.max(80, Math.floor(N * (0.25 + 0.75 * k))), px = this.px, py = this.py, pz = this.pz, sp = this.sp;
    if (kind === 1) {
      this.rain.material.opacity = 0.5 * k;
      for (let i = 0; i < n; i++) {
        const v = 22 + sp[i] * 8; py[i] -= v * dt; px[i] += 2.2 * dt;
        if (py[i] < cam.y - 5 || Math.abs(px[i] - cam.x) > R || Math.abs(pz[i] - cam.z) > R) this.spawn(i, cam, false);
        const j = i * 6; this.rainPos[j] = px[i]; this.rainPos[j + 1] = py[i]; this.rainPos[j + 2] = pz[i]; this.rainPos[j + 3] = px[i] - 0.1; this.rainPos[j + 4] = py[i] + 0.75; this.rainPos[j + 5] = pz[i];
      }
      for (let i = n * 6; i < N * 6; i++) this.rainPos[i] = 0;
      this.rain.geometry.attributes.position.needsUpdate = true;
    } else {
      const a = this.ptsPos;
      for (let i = 0; i < N; i++) {
        if (i >= n) { a[i * 3] = a[i * 3 + 1] = a[i * 3 + 2] = 0; continue; }
        if (kind === 2) { // snow: slow, swaying flakes
          py[i] -= (1.3 + sp[i] * 1.2) * dt; px[i] += Math.sin(this.t * 0.9 + i) * 0.6 * dt + 0.5 * dt; pz[i] += Math.cos(this.t * 0.7 + i * 1.7) * 0.5 * dt;
        } else { // sand: fast, mostly sideways, with a bit of tumbling
          const v = 9 + sp[i] * 6; px[i] += this.wind[0] * v * dt; pz[i] += this.wind[1] * v * dt; py[i] += Math.sin(this.t * 3 + i * 2.3) * 1.2 * dt - 0.4 * dt;
        }
        if (py[i] < cam.y - 5 || py[i] > cam.y + HI + 2 || Math.abs(px[i] - cam.x) > R || Math.abs(pz[i] - cam.z) > R) {
          this.spawn(i, cam, true);
          if (kind === 3) { px[i] = cam.x - this.wind[0] * R * 0.95 + (Math.random() - 0.5) * 6; pz[i] = cam.z - this.wind[1] * R * 0.95 + (Math.random() - 0.5) * 6; } // blown in from upwind
        }
        a[i * 3] = px[i]; a[i * 3 + 1] = py[i]; a[i * 3 + 2] = pz[i];
      }
      (kind === 2 ? this.snow : this.sand).material.opacity = (kind === 2 ? 0.9 : 0.75) * Math.min(1, k * 1.2);
      this.snow.geometry.attributes.position.needsUpdate = true;
    }
  }
}
