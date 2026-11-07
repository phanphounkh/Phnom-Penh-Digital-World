import { Vector3 } from "three";
const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
/** Controlled cart with a swept footprint. Dimensions match the Blender wire basket. */
export class CartController {
  constructor(
    root,
    colliders,
    bounds = { minX: -17.5, maxX: 17.5, minZ: -11.7, maxZ: 14.1 },
  ) {
    this.root = root;
    this.colliders = colliders;
    this.bounds = bounds;
    this.distance = 1.08;
    this.halfWidth = 0.53;
    this.halfLength = 0.72;
    this.blocked = false;
    this.wheels = [];
    root.traverse((n) => {
      if (n.name.startsWith("Wheel")) this.wheels.push(n);
    });
    this.targets = [new Vector3(), new Vector3()];
  }
  pose(x, z, yaw) {
    return {
      x: x - Math.sin(yaw) * this.distance,
      z: z - Math.cos(yaw) * this.distance,
      yaw,
    };
  }
  canPose(x, z, yaw, people = []) {
    const p = this.pose(x, z, yaw),
      cs = Math.cos(yaw),
      sn = Math.sin(yaw),
      hx = this.halfWidth,
      hz = this.halfLength;
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz,
      ez = Math.abs(sn) * hx + Math.abs(cs) * hz,
      b = this.bounds;
    if (
      p.x - ex < b.minX ||
      p.x + ex > b.maxX ||
      p.z - ez < b.minZ ||
      p.z + ez > b.maxZ
    )
      return false;
    for (const c of this.colliders) {
      const w = c.w - 0.38,
        d = c.d - 0.38,
        dx = c.x - p.x,
        dz = c.z - p.z;
      if (Math.abs(dx) >= ex + w || Math.abs(dz) >= ez + d) continue;
      if (
        Math.abs(dx * cs - dz * sn) >=
        hx + w * Math.abs(cs) + d * Math.abs(sn)
      )
        continue;
      if (
        Math.abs(dx * sn + dz * cs) >=
        hz + w * Math.abs(sn) + d * Math.abs(cs)
      )
        continue;
      return false;
    }
    for (const other of people) {
      const point = other.mesh?.position || other;
      const dx = point.x - p.x,
        dz = point.z - p.z,
        lx = dx * cs - dz * sn,
        lz = dx * sn + dz * cs;
      const qx = Math.max(0, Math.abs(lx) - hx),
        qz = Math.max(0, Math.abs(lz) - hz);
      if (qx * qx + qz * qz < 0.31 * 0.31) return false;
    }
    return true;
  }
  canSteer(x, z, from, to, people = []) {
    const delta = wrap(to - from),
      steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.1));
    for (let i = 1; i <= steps; i++)
      if (!this.canPose(x, z, from + (delta * i) / steps, people)) return false;
    return true;
  }
  steering(yaw, dx, dz, dt) {
    if (Math.hypot(dx, dz) < 0.02) return yaw;
    let target = Math.atan2(-dx, -dz);
    if (Math.abs(wrap(target - yaw)) > Math.PI * 0.62)
      target = wrap(target + Math.PI);
    return yaw + wrap(target - yaw) * (1 - Math.exp(-dt * 8));
  }
  sync(player, travel) {
    const p = this.pose(
      player.position.x,
      player.position.z,
      player.rotation.y,
    );
    this.root.position.set(p.x, 0, p.z);
    this.root.rotation.y = p.yaw;
    for (const wheel of this.wheels) wheel.rotation.x += travel / 0.12;
    this.root.updateMatrixWorld(true);
    this.targets[0].set(0.3, 1.14, 0.7);
    this.targets[1].set(-0.3, 1.14, 0.7);
    this.targets.forEach((t) => this.root.localToWorld(t));
    return this.targets;
  }
  obstacles(player) {
    const p = this.root.position,
      yaw = this.root.rotation.y;
    return [
      { x: player.position.x, z: player.position.z, radius: 0.5 },
      { x: p.x, z: p.z, radius: 0.7 },
      {
        x: p.x - Math.sin(yaw) * 0.4,
        z: p.z - Math.cos(yaw) * 0.4,
        radius: 0.58,
      },
    ];
  }
}
