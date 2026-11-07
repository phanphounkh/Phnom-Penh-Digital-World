import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Group,
  PerspectiveCamera,
  Mesh,
  BoxGeometry,
  MeshStandardMaterial,
  Vector3,
} from "three";
import { CartController } from "../src/lib/game/cart/CartController.js";
import { CameraController } from "../src/lib/game/camera/CameraController.js";
import { PlayerAnimations } from "../src/lib/game/player/PlayerAnimations.js";
import {
  NPCController,
  separateCrowd,
  yieldToShoppers,
} from "../src/lib/game/npc/NPCController.js";
import { readFileSync } from "node:fs";
test("cart footprint stops before a counter, turns safely and rotates wheels from distance", () => {
  const root = new Group(),
    wheel = new Group();
  wheel.name = "Wheel";
  root.add(wheel);
  const cart = new CartController(root, [
    { x: 0, z: -3, w: 1.5 + 0.38, d: 0.5 + 0.38 },
  ]);
  assert.equal(cart.canPose(0, 0, 0), true);
  assert.equal(cart.canPose(0, -1, 0), false);
  assert.equal(cart.canPose(4, -1, 0), true);
  assert.equal(cart.canPose(0, 0, 0, [{ x: 0, z: -1.1 }]), false);
  const player = new Group();
  player.position.set(0, 0, 0);
  const targets = cart.sync(player, 0.24);
  assert.ok(Math.abs(root.position.z + 1.08) < 1e-6);
  assert.equal(wheel.rotation.x, 2);
  assert.ok(Math.abs(targets[0].z + 0.38) < 1e-6);
  assert.ok(cart.canSteer(4, 0, 0, Math.PI / 2));
  cart.sync(player, -0.24);
  assert.equal(wheel.rotation.x, 0);
});
test("camera fades one obstructing plant, preserves cached materials and restores it", () => {
  const camera = new PerspectiveCamera();
  camera.position.set(0, 3.9, 6.8);
  const rig = new CameraController(camera),
    source = new MeshStandardMaterial({ color: "#345a3a" }),
    plant = new Group();
  plant.add(new Mesh(new BoxGeometry(2, 3, 2), source));
  plant.position.set(0, 2, 3);
  rig.register(plant, { soft: true });
  const player = new Group();
  for (let i = 0; i < 30; i++) rig.update(player, 0, 3.9, 1 / 60);
  assert.ok(plant.children[0].material.opacity < 0.3);
  assert.equal(source.opacity, 1);
  assert.ok(rig.faded > 0);
  for (let i = 0; i < 120; i++) rig.update(player, Math.PI / 2, 3.9, 1 / 60);
  assert.ok(plant.children[0].material.opacity > 0.98);
  rig.dispose();
});
test("camera stops in front of architecture", () => {
  const camera = new PerspectiveCamera();
  camera.position.set(0, 3.9, 6.8);
  const rig = new CameraController(camera),
    wall = new Mesh(new BoxGeometry(3, 5, 0.3), new MeshStandardMaterial());
  wall.position.set(0, 2, 4);
  rig.register(wall);
  rig.update(new Group(), 0, 3.9, 0.1);
  assert.ok(camera.position.z < 3.85);
  rig.dispose();
});
test("characters export articulated knees, elbows and wrist targets", () => {
  for (const name of [
    "player",
    "customer",
    "customer-female",
    "cashier",
    "employee",
  ]) {
    const b = readFileSync(`static/models/characters/${name}.glb`),
      j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString()),
      names = new Set(j.nodes.map((n) => n.name));
    for (const node of [
      "BodyRoot",
      "LeftKnee",
      "RightKnee",
      "LeftElbow",
      "RightElbow",
      "LeftWrist",
      "RightWrist",
    ])
      assert.ok(names.has(node), `${name} needs ${node}`);
  }
});
test("two-bone hands remain on the handle and blocked locomotion returns to idle", () => {
  const model = new Group();
  model.rotation.y = Math.PI;
  const body = new Group();
  body.name = "BodyRoot";
  model.add(body);
  for (const [side, x] of [
    ["Left", -0.285],
    ["Right", 0.285],
  ]) {
    const arm = new Group();
    arm.name = side + "Arm";
    arm.position.set(x, 1.405, 0);
    body.add(arm);
    const elbow = new Group();
    elbow.name = side + "Elbow";
    elbow.position.y = -0.29;
    arm.add(elbow);
    const wrist = new Group();
    wrist.name = side + "Wrist";
    wrist.position.y = -0.28;
    elbow.add(wrist);
    const leg = new Group();
    leg.name = side + "Leg";
    body.add(leg);
    const knee = new Group();
    knee.name = side + "Knee";
    leg.add(knee);
  }
  const anim = new PlayerAnimations(model, { pushing: true }),
    targets = [new Vector3(0.3, 1.14, -0.38), new Vector3(-0.3, 1.14, -0.38)];
  for (let i = 0; i < 120; i++)
    anim.update(1 / 60, 3, false, false, targets, 0.05);
  model.updateMatrixWorld(true);
  for (let i = 0; i < 2; i++) {
    const p = new Vector3();
    model.getObjectByName(i ? "RightWrist" : "LeftWrist").getWorldPosition(p);
    assert.ok(
      p.distanceTo(targets[i]) < 0.04,
      `Grip error ${p.distanceTo(targets[i])}`,
    );
  }
  for (let i = 0; i < 40; i++) anim.update(1 / 60, 0, false, false, targets, 0);
  assert.equal(anim.state, "idle");
  assert.ok(Math.abs(model.getObjectByName("LeftLeg").rotation.x) < 0.01);
  anim.update(1 / 60, 2, false, false, targets, 0.03, -1);
  assert.ok(anim.actions.walk.timeScale < 0);
  anim.dispose();
});
test("crowd separates overlapping customers and reserves distinct queue positions", () => {
  const shared = { queue: [] },
    a = new NPCController(new Group(), 0, shared),
    b = new NPCController(new Group(), 1, shared);
  a.mesh.position.set(14.8, 0, 5);
  b.mesh.position.set(14.8, 0, 5);
  a.routeIndex = b.routeIndex = 6;
  a.wait = b.wait = 0;
  for (let i = 0; i < 60; i++) {
    a.update(1 / 60, () => false, [a, b]);
    b.update(1 / 60, () => false, [a, b]);
    separateCrowd([a, b], () => false);
  }
  assert.ok(a.mesh.position.distanceTo(b.mesh.position) > 0.7);
  assert.equal(shared.queue[0], a);
  assert.equal(shared.queue[1], b);
  assert.equal(b.routeIndex, 6);
});

test("a customer trapped between the player and cart yields outside both footprints", () => {
  const npc = new NPCController(new Group(), 0);
  npc.mesh.position.set(0, 0, -0.55);
  const obstacles = [
    { x: 0, z: 0, radius: 0.5 },
    { x: 0, z: -1.08, radius: 0.7 },
  ];
  yieldToShoppers([npc], () => false, obstacles);
  for (const o of obstacles)
    assert.ok(
      Math.hypot(npc.mesh.position.x - o.x, npc.mesh.position.z - o.z) >=
        o.radius + 0.34,
    );
});
