import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Box3, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const bytes = await readFile(
  new URL("../static/models/vehicles/motorbike.glb", import.meta.url),
);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const { scene } = await loader.parseAsync(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  "",
);
scene.updateMatrixWorld(true);
const node = (name) => {
  const result = scene.getObjectByName(name);
  assert.ok(result, `missing riding node ${name}`);
  return result;
};
const position = (name) => node(name).getWorldPosition(new Vector3());

test("replacement moto preserves ground contact, wheelbase and rider anchors", () => {
  node("Body");
  node("SteerParts");
  const front = position("WheelFront"),
    rear = position("WheelRear");
  assert.ok(Math.abs(front.z - rear.z - 1.24) < 0.001);
  assert.ok(Math.abs(front.y - 0.29) < 0.001);
  assert.ok(Math.abs(rear.y - 0.29) < 0.001);
  assert.ok(Math.abs(position("Seat").y - 0.86) < 0.001);
  for (const name of ["GripL", "GripR", "PegL", "PegR"])
    assert.ok(Number.isFinite(position(name).length()));
  const bounds = new Box3().setFromObject(scene, true);
  assert.ok(
    bounds.min.y >= -0.003,
    "geometry must not extend through the ground",
  );
  assert.ok(
    bounds.max.y < 1.4 && bounds.max.z - bounds.min.z < 2,
    "metre-scale vehicle",
  );
});

test("front wheel and hand grips follow steering without moving rear wheel or seat", () => {
  const front = position("WheelFront"),
    grip = position("GripL"),
    rear = position("WheelRear"),
    seat = position("Seat");
  node("Steer").rotation.y = 0.35;
  scene.updateMatrixWorld(true);
  assert.ok(front.distanceTo(position("WheelFront")) > 0.03);
  assert.ok(grip.distanceTo(position("GripL")) > 0.05);
  assert.ok(rear.distanceTo(position("WheelRear")) < 1e-8);
  assert.ok(seat.distanceTo(position("Seat")) < 1e-8);
  node("Steer").rotation.y = 0;
  scene.updateMatrixWorld(true);
});

test("moto loads with Meshopt, bounded geometry and semantic night light materials", () => {
  let triangles = 0,
    primitives = 0;
  const materials = new Set();
  scene.traverse((obj) => {
    if (!obj.isMesh) return;
    triangles +=
      (obj.geometry.index?.count ?? obj.geometry.attributes.position.count) / 3;
    primitives += 1;
    for (const material of Array.isArray(obj.material)
      ? obj.material
      : [obj.material])
      materials.add(material.name);
  });
  assert.ok(triangles < 20000, `${triangles} triangles exceeds budget`);
  assert.ok(primitives <= 32, `${primitives} primitives exceeds budget`);
  assert.ok(bytes.length < 220000, "compressed download budget");
  for (const name of [
    "DreamBlack",
    "Chrome",
    "Light",
    "TailLight",
    "Amber",
    "Gold",
  ])
    assert.ok(materials.has(name));
});
