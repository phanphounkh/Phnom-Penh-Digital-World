import { Vector3, Raycaster, Box3, MathUtils } from "three";
/** Shortens the camera against architecture and fades nearby foliage per instance. */
export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this.solids = [];
    this.foliage = [];
    this.ray = new Raycaster();
    this.origin = new Vector3();
    this.direction = new Vector3();
    this.hit = new Vector3();
    this.desired = new Vector3();
    this.materials = [];
    this.faded = 0;
    this.distance = 6.8;
  }
  register(root, { soft = false } = {}) {
    root.updateMatrixWorld(true);
    if (!soft) {
      root.traverse((n) => {
        if (n.isMesh && !n.material.transparent) this.solids.push(n);
      });
      return;
    }
    const meshes = [];
    root.traverse((n) => {
      if (!n.isMesh) return;
      n.material = n.material.clone();
      this.materials.push(n.material);
      meshes.push(n);
    });
    this.foliage.push({
      root,
      meshes,
      box: new Box3().setFromObject(root),
      opacity: 1,
    });
  }
  update(player, angle, height, dt) {
    this.origin.copy(player.position);
    this.origin.y = 1.3;
    this.desired.set(
      player.position.x + Math.sin(angle) * 6.8,
      height,
      player.position.z + Math.cos(angle) * 6.8,
    );
    this.direction.subVectors(this.desired, this.origin);
    const length = this.direction.length();
    this.direction.normalize();
    this.ray.set(this.origin, this.direction);
    this.ray.far = length;
    const hit = this.ray.intersectObjects(this.solids, false)[0];
    const distance = hit ? Math.max(1.3, hit.distance - 0.28) : length;
    this.distance = distance;
    this.desired.copy(this.origin).addScaledVector(this.direction, distance);
    if (hit) this.camera.position.copy(this.desired);
    else
      this.camera.position.lerp(
        this.desired,
        1 - Math.exp(-dt * (hit ? 18 : 6)),
      );
    this.camera.lookAt(player.position.x, 1.3, player.position.z - 0.6);
    this.faded = 0;
    this.direction.subVectors(this.origin, this.camera.position);
    const rayLength = this.direction.length();
    this.direction.normalize();
    this.ray.set(this.camera.position, this.direction);
    this.ray.far = rayLength;
    for (const plant of this.foliage) {
      const h = this.ray.ray.intersectBox(plant.box, this.hit);
      const between =
        h && this.hit.distanceTo(this.camera.position) < rayLength;
      const near =
        plant.box.distanceToPoint(
          new Vector3(this.camera.position.x, 1.4, this.camera.position.z),
        ) < 1.65;
      const fade = between || near;
      plant.opacity = MathUtils.lerp(
        plant.opacity,
        fade ? 0.13 : 1,
        1 - Math.exp(-dt * 10),
      );
      if (plant.opacity < 0.95) this.faded++;
      for (const mesh of plant.meshes) {
        const m = mesh.material;
        m.opacity = plant.opacity;
        if (m.transparent !== plant.opacity < 0.99) {
          m.transparent = plant.opacity < 0.99;
          m.depthWrite = !m.transparent;
          m.needsUpdate = true;
        }
        mesh.castShadow = plant.opacity > 0.8;
      }
    }
  }
  dispose() {
    this.materials.forEach((m) => m.dispose());
    this.materials = [];
  }
}
