// Local gameplay regression for the replacement mesh: mount, steer, spin, audio and park.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { perfSession } from "./session.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: [
    "--no-sandbox",
    "--use-angle=vulkan",
    "--enable-features=Vulkan",
    "--ignore-gpu-blocklist",
  ],
});
try {
  const context = await browser.newContext({
    baseURL: process.argv[2] ?? "http://localhost:3000",
    viewport: { width: 1280, height: 720 },
  });
  const bot = await perfSession(context, `dream_${Date.now().toString(36)}`);
  await bot.moveTo("central-market");
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/world");
  await page
    .locator('[data-testid="world-canvas"][data-ready="true"]')
    .waitFor({ timeout: 180000 });
  await expect(page.getByTestId("hud-net")).toHaveAttribute(
    "data-status",
    "open",
    { timeout: 30000 },
  );
  await page.mouse.click(600, 500);
  await page.keyboard.press("v");
  await page.getByTestId("get-motorbike").click();
  const card = page.getByTestId("vehicle-motorbike");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("vehicle-ride").or(card.getByText("Walk there", {exact:true}))).toBeVisible();
  if (await card.getByTestId("vehicle-ride").isVisible())
    await page.keyboard.press("v");
  else await card.getByText("Walk there", { exact: true }).click();
  await expect(page.getByTestId("ride-prompt")).toHaveAttribute(
    "data-kind",
    "ride",
    { timeout: 180000 },
  );
  await page.getByTestId("ride-action").click();
  await expect(page.getByTestId("hud-ride")).toHaveAttribute(
    "data-mode",
    "motorbike",
    { timeout: 30000 },
  );
  const inspect = () =>
    page.evaluate(() => {
      const perf = globalThis.__ppwPerf,
        vehicle = perf.scene.getObjectByName("vehicle:motorbike");
      if (!vehicle) throw Error("No mounted motorbike");
      const names = new Set();
      let triangles = 0,
        primitives = 0;
      vehicle.traverse((obj) => {
        if (!obj.isMesh || obj.isSkinnedMesh) return;
        const mats = Array.isArray(obj.material)
          ? obj.material
          : [obj.material];
        for (const m of mats) names.add(m.name);
        if (
          !mats.some((m) =>
            [
              "DreamBlack",
              "Chrome",
              "Rubber",
              "Alloy",
              "Light",
              "TailLight",
            ].includes(m.name),
          )
        )
          return;
        triangles +=
          (obj.geometry.index?.count ??
            obj.geometry.attributes.position.count) / 3;
        primitives++;
      });
      const renderer = perf.renderer;
      return {
        materials: [...names],
        triangles,
        primitives,
        wheel: vehicle.getObjectByName("WheelRear").rotation.x,
        steer: vehicle.getObjectByName("Steer").rotation.y,
        position: vehicle.position.toArray(),
        avatar: perf.avatar(),
        audio: perf.audio(),
        render: renderer.info.render,
        memory: renderer.info.memory,
      };
    });
  const mounted = await inspect();
  assert.ok(mounted.materials.includes("DreamBlack"));
  assert.ok(mounted.avatar.riding);
  await page.mouse.move(550, 400);
  await page.mouse.down();
  await page.mouse.move(760, 380, { steps: 6 });
  await page.mouse.up();
  for (let k = 0; k < 8; k++) await page.mouse.wheel(0, -300);
  await page.waitForTimeout(1500);
  // Inspect the model and mounted rider with a temporary close camera; restore gameplay camera.
  await page.evaluate(() => {
    const perf = globalThis.__ppwPerf,
      renderer = perf.renderer;
    const original = renderer.render;
    globalThis.__dreamRestoreCamera = () => {
      renderer.render = original;
    };
    renderer.render = function (scene, camera) {
      if (scene !== perf.scene) return original.call(this, scene, camera);
      const vehicle = scene.getObjectByName("vehicle:motorbike");
      const close = camera.clone();
      const eye = vehicle.position
        .clone()
        .set(2.4, 1.45, 2.4)
        .applyQuaternion(vehicle.quaternion)
        .add(vehicle.position);
      close.position.copy(eye);
      close.fov = 43;
      close.updateProjectionMatrix();
      close.lookAt(vehicle.position.clone().add({ x: 0, y: 0.85, z: 0 }));
      original.call(this, scene, close);
    };
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/ppg-dream-riding.png" });
  await page.evaluate(() => globalThis.__dreamRestoreCamera());
  const frameTimes = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const times = [];
        let last = performance.now(),
          start = last;
        function sample(now) {
          times.push(now - last);
          last = now;
          if (now - start < 8000) requestAnimationFrame(sample);
          else resolve(times);
        }
        requestAnimationFrame(sample);
      }),
  );
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const performanceSample = {
    durationMs: frameTimes.reduce((a, b) => a + b, 0),
    frames: frameTimes.length,
    fps: 1000 / (frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length),
    p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
  };
  await page.keyboard.down("w");
  await page.waitForTimeout(900);
  await page.keyboard.down("d");
  await page.waitForTimeout(500);
  const driving = await inspect();
  await page.keyboard.up("d");
  await page.keyboard.up("w");
  assert.notEqual(
    driving.wheel,
    mounted.wheel,
    "wheels must spin while driving",
  );
  assert.ok(Math.abs(driving.steer) > 0.01, "fork and bars must steer");
  assert.ok(
    driving.audio.media.loops.some(
      (l) => l.kind.startsWith("motorbike") && l.playing && l.time > 0.1,
    ),
  );
  await page.keyboard.down("s");
  await page.waitForTimeout(3000);
  await page.keyboard.up("s");
  await expect(page.getByTestId("ride-prompt")).toHaveAttribute(
    "data-kind",
    "park",
    { timeout: 30000 },
  );
  await page.getByTestId("ride-action").click();
  await expect(page.getByTestId("hud-ride")).toHaveCount(0, { timeout: 20000 });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        viewport: { width: 1280, height: 720 },
        mounted,
        driving,
        performanceSample,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
