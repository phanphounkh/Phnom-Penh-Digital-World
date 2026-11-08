import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import {
  totalCents,
  groupItems,
  makeReceipt,
  newItemId,
} from "../src/lib/stores/cartStore.js";
test("checkout calculates exact cents, quantities, immutable receipt and earned points", () => {
  const items = [
    { id: "a", uid: "1", price: 0.1, name: "A" },
    { id: "a", uid: "2", price: 0.1, name: "A" },
    { id: "b", uid: "3", price: 0.2, name: "B" },
  ];
  assert.equal(totalCents(items), 40);
  assert.equal(groupItems(items)[0].quantity, 2);
  const r = makeReceipt(items, 12, new Date("2026-11-07T12:00:00Z"));
  assert.equal(r.total, 0.4);
  assert.equal(r.id, "CE-0012");
  assert.equal(r.points, 4);
  items[0].name = "Changed";
  assert.equal(r.items[0].name, "A");
  assert.equal(totalCents([]), 0);
});
test("every shipped GLB is a valid glTF 2 binary with meshes and embedded buffers", () => {
  let count = 0;
  for (const folder of readdirSync("static/models")) {
    if (!statSync("static/models/" + folder).isDirectory()) continue;
    for (const name of readdirSync("static/models/" + folder)) {
      if (!name.endsWith(".glb")) continue;
      const b = readFileSync("static/models/" + folder + "/" + name);
      assert.equal(b.readUInt32LE(0), 0x46546c67);
      assert.equal(b.readUInt32LE(4), 2);
      assert.equal(b.readUInt32LE(8), b.length);
      const json = JSON.parse(
        b.subarray(20, 20 + b.readUInt32LE(12)).toString(),
      );
      assert.ok(json.meshes.length > 0);
      assert.ok(
        json.nodes.every(
          (node) => !["Cube", "Camera", "Light"].includes(node.name),
        ),
        `${name} must not contain Blender default-scene objects`,
      );
      assert.ok(json.buffers.every((buf) => !buf.uri));
      count++;
    }
  }
  // 29 CampusEats assets + Phnom Penh Digital World: avatar, 6 street props, 2 landmarks
  // (the new ones are Meshopt-compressed; still valid, self-contained GLB 2.0).
  assert.equal(count, 38);
});

test("inventory IDs also work on mobile LAN pages without randomUUID", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newItemId({})));
  assert.equal(ids.size, 1000);
  assert.equal(newItemId({ randomUUID: () => "test-uuid" }), "test-uuid");
});
