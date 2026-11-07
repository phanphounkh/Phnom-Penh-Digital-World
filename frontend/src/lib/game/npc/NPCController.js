import { Vector3, MathUtils } from "three";
/** Authored routes, reserved queue slots and local avoidance; no remote AI. */
export class NPCController {
  constructor(mesh, index, crowd = { queue: [] }) {
    this.mesh = mesh;
    this.index = index;
    this.crowd = crowd;
    this.state = "arriving";
    this.wait = index * 0.35;
    this.speed = 0.65 + (index % 3) * 0.12;
    this.routeIndex = 0;
    this.cycles = 0;
    this.distance = 0;
    this.plan();
  }
  plan() {
    const shop = (this.index + this.cycles) % 4,
      x = -14.4 + shop * 8 + ((this.index % 3) - 1) * 0.45,
      lane = ((this.index % 3) - 1) * 0.6;
    this.route = [
      { x: 2 + lane, z: 9, state: "arriving" },
      { x: 2 + lane, z: -3.4, state: "walking" },
      { x, z: -3.4, state: "walking" },
      { x, z: -6.2, state: "browsing", wait: 4 + (this.index % 3) },
      { x, z: -3.4, state: "walking" },
      { x: 14.8, z: -3.4, state: "walking" },
      { x: 14.8, z: 5, state: "queueing" },
      { x: 14.7, z: 4.25, state: "checkout", wait: 3 },
      { x: 8.5, z: 5.6, state: "leaving" },
      { x: 2, z: 12, state: "leaving" },
      { x: 0, z: 13.7, state: "leaving", wait: 1 },
    ];
  }
  releaseQueue() {
    const i = this.crowd.queue.indexOf(this);
    if (i >= 0) this.crowd.queue.splice(i, 1);
  }
  update(dt, blocked, peers = [], obstacles = []) {
    if (this.routeIndex === 8 && this.wait <= 0) this.releaseQueue();
    const before = this.mesh.position.clone();
    let target = this.route[this.routeIndex];
    if (this.routeIndex >= 6 && this.routeIndex <= 7) {
      if (!this.crowd.queue.includes(this)) this.crowd.queue.push(this);
      const slot = this.crowd.queue.indexOf(this);
      if (this.routeIndex === 6) target = { ...target, z: 5 + slot * 1.05 };
      if (this.routeIndex === 7 && slot > 0) {
        this.routeIndex = 6;
        target = { ...this.route[6], z: 5 + slot * 1.05 };
      }
    }
    const delta = new Vector3(target.x, 0, target.z).sub(this.mesh.position);
    const dir = new Vector3();
    if (this.wait <= 0 && delta.length() > 0.2)
      dir.copy(delta).normalize().multiplyScalar(this.speed);
    // Slow and steer around neighbors before bodies touch.
    for (const other of peers) {
      if (other === this) continue;
      const away = this.mesh.position.clone().sub(other.mesh.position);
      away.y = 0;
      const d = away.length();
      if (d > 0 && d < 1.15)
        dir.addScaledVector(away.normalize(), (1.15 - d) * 1.3);
    }
    for (const o of obstacles) {
      const away = new Vector3(
          this.mesh.position.x - o.x,
          0,
          this.mesh.position.z - o.z,
        ),
        d = away.length(),
        r = o.radius + 0.7;
      if (d < r) {
        if (d < 0.001) away.set(this.index % 2 ? 1 : -1, 0, 0.2);
        dir.addScaledVector(away.normalize(), (r - d) * 2.5 + 0.18);
      }
    }
    if (dir.length() > this.speed * 1.3) dir.setLength(this.speed * 1.3);
    const step = dir.multiplyScalar(dt);
    let x = this.mesh.position.x + step.x,
      z = this.mesh.position.z + step.z;
    if (!blocked(x, this.mesh.position.z)) this.mesh.position.x = x;
    if (!blocked(this.mesh.position.x, z)) this.mesh.position.z = z;
    const travel = this.mesh.position.distanceTo(before);
    this.distance += travel;
    if (travel > 0.003) {
      const aim = Math.atan2(
        this.mesh.position.x - before.x,
        this.mesh.position.z - before.z,
      );
      this.mesh.rotation.y +=
        Math.atan2(
          Math.sin(aim - this.mesh.rotation.y),
          Math.cos(aim - this.mesh.rotation.y),
        ) *
        (1 - Math.exp(-dt * 7));
    }
    if (this.wait > 0) this.wait -= dt;
    else if (delta.length() < 0.24) {
      this.state = target.state;
      if (this.routeIndex === 6 && this.crowd.queue.indexOf(this) > 0)
        return travel / Math.max(dt, 0.001);
      this.wait = target.wait || 0;

      this.routeIndex++;
      if (this.routeIndex >= this.route.length) {
        this.releaseQueue();
        this.cycles++;
        this.routeIndex = 0;
        this.plan();
      }
    }
    return travel / Math.max(dt, 0.001);
  }
}
export function separateCrowd(controllers, blocked, obstacles = []) {
  for (let pass = 0; pass < 3; pass++)
    for (let i = 0; i < controllers.length; i++)
      for (let j = i + 1; j < controllers.length; j++) {
        const a = controllers[i],
          b = controllers[j];
        let dx = b.mesh.position.x - a.mesh.position.x,
          dz = b.mesh.position.z - a.mesh.position.z,
          d = Math.hypot(dx, dz);
        if (d >= 0.82) continue;
        const penetration = 0.82 - d;
        if (d < 0.001) {
          dx = i % 2 ? 1 : -1;
          dz = 0.2;
          d = Math.hypot(dx, dz);
        }
        const amount = penetration * 0.51;
        dx = (dx / d) * amount;
        dz = (dz / d) * amount;
        for (const [actor, sign] of [
          [a, -1],
          [b, 1],
        ]) {
          const x = actor.mesh.position.x + dx * sign,
            z = actor.mesh.position.z + dz * sign;
          if (!blocked(x, z)) actor.mesh.position.set(x, 0, z);
        }
      }
}

/** Resolve the rare overlap at the shared player/cart handle instead of trapping a shopper. */
export function yieldToShoppers(controllers, blocked, obstacles) {
  const clear = (x, z) =>
    !blocked(x, z) &&
    obstacles.every((o) => Math.hypot(x - o.x, z - o.z) >= o.radius + 0.34);
  for (const actor of controllers) {
    const pos = actor.mesh.position;
    if (
      obstacles.every(
        (o) => Math.hypot(pos.x - o.x, pos.z - o.z) >= o.radius + 0.34,
      )
    )
      continue;
    let best = null,
      cost = Infinity;
    for (const obstacle of obstacles)
      for (let i = 0; i < 32; i++) {
        const angle = (i * Math.PI) / 16,
          r = obstacle.radius + 0.345,
          x = obstacle.x + Math.cos(angle) * r,
          z = obstacle.z + Math.sin(angle) * r;
        if (!clear(x, z)) continue;
        const score =
          Math.hypot(x - pos.x, z - pos.z) +
          controllers.reduce(
            (sum, other) =>
              other === actor
                ? sum
                : sum +
                  Math.max(
                    0,
                    0.78 -
                      Math.hypot(
                        other.mesh.position.x - x,
                        other.mesh.position.z - z,
                      ),
                  ) *
                    3,
            0,
          );
        if (score < cost) {
          cost = score;
          best = { x, z };
        }
      }
    if (best) pos.set(best.x, 0, best.z);
  }
}
