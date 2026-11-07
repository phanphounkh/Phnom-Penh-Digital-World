import { test, expect } from "@playwright/test";
async function location(page) {
  return page
    .locator(".world")
    .evaluate((el) => ({ x: Number(el.dataset.x), z: Number(el.dataset.z) }));
}
async function walkTo(page, x, z, { until = null } = {}) {
  let previous = "";
  let wasRunning = false;
  for (let i = 0; i < 150; i++) {
    const p = await location(page),
      dx = x - p.x,
      dz = z - p.z;
    if (i % 20 === 0) console.log("Walking", x, z, "at", p);
    const interactiveArrival = until
      ? (await page.locator(".interaction").allTextContents()).some((text) =>
          text.includes(until),
        )
      : false;
    if (interactiveArrival || Math.hypot(dx, dz) < 0.5) {
      if (previous) await page.keyboard.up(previous);
      await page.keyboard.up("Shift");
      await page.waitForTimeout(150);
      return;
    }
    // Inverse of the initial camera-relative movement transform. Use actual keyboard input.
    const localX = dx * Math.cos(0.12) - dz * Math.sin(0.12),
      localZ = dx * Math.sin(0.12) + dz * Math.cos(0.12);
    const key =
      Math.abs(localX) > Math.abs(localZ)
        ? localX > 0
          ? "d"
          : "a"
        : localZ > 0
          ? "s"
          : "w";
    const run = Math.hypot(dx, dz) > 2;
    if (run !== wasRunning) {
      await page.keyboard[run ? "down" : "up"]("Shift");
      wasRunning = run;
    }
    if (key !== previous) {
      if (previous) await page.keyboard.up(previous);
      await page.keyboard.down(key);
      previous = key;
    }
    await page.waitForTimeout(180);
  }
  throw new Error(
    `Unable to walk to ${x},${z}. At ${JSON.stringify(await location(page))}`,
  );
}
test("physical shopping, collisions, paused movement, demo payment, receipt persistence and exit", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/mall");
  await expect(page.locator(".loading-screen")).toBeHidden({ timeout: 90000 });
  await page.getByRole("button", { name: "Open settings" }).click();
  if (
    (
      await page.getByRole("button", { name: /Graphics quality/ }).innerText()
    ).includes("High")
  )
    await page.getByRole("button", { name: /Graphics quality/ }).click();
  await page.getByRole("button", { name: "Back to exploring" }).click();
  await expect(page.locator(".cart-heading strong")).toHaveText("$0.00");
  // Checkout HUD only guides the player; it cannot remotely charge a cart.
  await page.getByRole("button", { name: "Let’s check out" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Your world, your way." }),
  ).toBeVisible();
  const paused = await location(page);
  await page.keyboard.down("w");
  await page.waitForTimeout(600);
  await page.keyboard.up("w");
  expect(await location(page)).toEqual(paused);
  await page.keyboard.press("Escape");
  await walkTo(page, 1.6, -2.5);
  await walkTo(page, 1.6, -6.3, { until: "Pick up Miso ramen" });
  await expect(page.locator(".world")).toHaveAttribute(
    "data-nearby-shop",
    "noodles",
  );
  await expect(page.locator(".interaction")).toContainText(
    "Pick up Miso ramen",
  );
  await page.keyboard.press("e");
  await expect(page.locator(".interaction")).toContainText("Place Miso ramen");
  await expect(page.locator(".cart-heading strong")).toHaveText("$0.00");
  // E returns the hand item without affecting the cart.
  await page.keyboard.press("e");
  await expect(page.locator(".interaction")).toContainText(
    "Pick up Miso ramen",
  );
  await page.keyboard.press("e");
  await expect(page.locator(".interaction")).toContainText("Place Miso ramen");
  await page.keyboard.press("q");
  await expect(page.locator(".cart-heading strong")).toHaveText("$3.75");
  await page.waitForTimeout(550);
  await page.keyboard.press("q");
  await expect(page.locator(".cart-heading strong")).toHaveText("$3.75");
  // Holding forward into a counter cannot cross its collision boundary.
  await page.keyboard.down("w");
  await page.waitForTimeout(1400);
  await expect
    .poll(() => page.locator(".world").getAttribute("data-cart-blocked"))
    .toBe("true");
  await page.keyboard.up("w");
  const atCounter = await location(page);
  expect(atCounter.z).toBeGreaterThan(-6.2);
  await page.locator(".cart-heading").click();
  await page.getByRole("button", { name: "Remove Miso ramen" }).click();
  await expect(page.locator(".cart-heading strong")).toHaveText("$0.00");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.keyboard.press("e");
  await expect(page.locator(".interaction")).toContainText("Place Miso ramen");
  await page.keyboard.press("q");
  await expect(page.locator(".cart-heading strong")).toHaveText("$3.75");
  // The counter opening is navigable: enter the shop and greet its employee.
  await walkTo(page, 2.2, -4.5);
  await walkTo(page, 4.1, -4.5);
  await walkTo(page, 4.1, -8.4, { until: "Say hello" });
  await expect(page.locator(".interaction")).toContainText("Say hello");
  await page.keyboard.press("e");
  await expect(page.locator(".toast")).toContainText("Welcome in");
  await walkTo(page, 4.1, -2.5);
  await walkTo(page, 4.1, 5.7);
  await walkTo(page, 12, 5.7);
  await expect(page.locator(".interaction")).toContainText(
    "Talk to the cashier",
  );
  await page.keyboard.press("e");
  await expect(page.getByRole("dialog")).toHaveAttribute(
    "aria-label",
    "Demo KHQR checkout",
  );
  await expect(page.locator(".total-row strong")).toHaveText("$3.75");
  await page.screenshot({ path: "artifacts/checkout.png" });
  await page.getByRole("button", { name: "Simulate payment" }).click();
  await expect(
    page.getByRole("heading", { name: "Good food, secured." }),
  ).toBeVisible();
  await expect(page.locator(".cart-heading strong")).toHaveText("$0.00");
  await page.getByRole("button", { name: "View receipt", exact: true }).click();
  await expect(page.locator(".receipt-row")).toContainText("1 × Miso ramen");
  await expect(page.locator(".total-row strong")).toHaveText("$3.75");
  await page.getByRole("button", { name: "Continue exploring" }).click();
  await page.getByRole("button", { name: "Show completed (1)" }).click();
  await expect(page.locator(".mission-row.completed")).toContainText(
    "Enjoy your first meal",
  );
  await page.getByRole("button", { name: "Hide completed" }).click();
  await expect(page.locator(".mission-row.completed")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".loading-screen")).toBeHidden({ timeout: 90000 });
  await page.getByRole("button", { name: /My orders/ }).click();
  await expect(page.locator(".orders-list")).toContainText("CE-0001");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page
    .getByRole("button", { name: "Exit the world", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Exit CampusEats World", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Session ended" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Return to the food court" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("all four shops offer navigation and responsive HUD remains in the viewport", async ({
  page,
}) => {
  await page.goto("/mall");
  await expect(page.locator(".loading-screen")).toBeHidden({ timeout: 90000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "artifacts/desktop.png" });
  // Orbit into the nearby planter: it must fade without hiding every plant instance.
  await page.mouse.move(720, 430);
  await page.mouse.down();
  await page.mouse.move(900, 430, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        Number(await page.locator(".world").getAttribute("data-camera-faded")),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: "artifacts/camera-foliage.png" });
  await page.mouse.down();
  await page.mouse.move(720, 430, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        Number(await page.locator(".world").getAttribute("data-npc-spacing")),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0.65);
  await page.getByRole("button", { name: /The shops/ }).click();
  for (const name of [
    "Burger Bay",
    "Pizza Planet",
    "Noodle Nook",
    "Sweet & Sip",
  ])
    await expect(page.locator(".shop-list")).toContainText(name);
  await page
    .locator(".shop-list")
    .getByRole("button", { name: /Sweet & Sip/ })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("Sweet & Sip");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  for (const selector of [
    ".topbar",
    ".cart-card",
    ".inventory-anchor",
    ".mini-map",
  ]) {
    const box = await page.locator(selector).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
  }
  await page.screenshot({ path: "artifacts/mobile.png" });
});
