import { test, expect } from "@playwright/test";

test("3D draws feedback, tracks arm and gripper, and orbit controls do not command devices", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.locator("#world-viewport canvas");
  await expect(canvas).toHaveAttribute("data-arm-position", /xMm/);
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")))
    .toBeGreaterThan(0);
  await page.locator("#acquire-control").click();
  await expect(page.locator("#enable-control")).toBeEnabled();
  await page.locator("#enable-control").click();
  const initial = JSON.parse(await canvas.getAttribute("data-arm-position"));
  await page.locator('[data-arm-mode="cartesian"]').click();
  await page
    .locator('[data-cartesian-axis="z"][data-cartesian-direction="plus"]')
    .click();
  await expect
    .poll(
      async () =>
        JSON.parse(await canvas.getAttribute("data-arm-position")).zMm,
    )
    .toBeGreaterThan(initial.zMm + 1);
  await page.locator("#grip-open").click();
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-gripper")))
    .toBe(100);
  const before = (await (await page.request.get("/api/state")).json()).commands
    .length;
  await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 120);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + 160);
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-orbit", /,/);
  await page.locator('[data-world-view="car"]').click();
  await page.locator("#world-clear").click();
  const after = (await (await page.request.get("/api/state")).json()).commands
    .length;
  expect(after).toBe(before);
  await expect(page.locator("#world-status")).toContainText("机械臂");
});

test("3D car pose follows driving feedback and stops changing after release", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.locator("#world-viewport canvas");
  await expect(canvas).toHaveAttribute("data-car-position", /heading/);
  await page.locator('[data-device="car-1"]').click();
  await page.locator("#acquire-control").click();
  await expect(page.locator("#enable-control")).toBeEnabled();
  await page.locator("#enable-control").click();
  const before = JSON.parse(await canvas.getAttribute("data-car-position")).x;
  const btn = page.locator('[data-direction="forward"]');
  await expect(btn).toBeEnabled();
  await btn.scrollIntoViewIfNeeded();
  const b = await btn.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect
    .poll(
      async () => JSON.parse(await canvas.getAttribute("data-car-position")).x,
    )
    .toBeGreaterThan(before + 0.01);
  await page.mouse.up();
  await expect(page.locator("#metric-enabled")).toHaveText("未启用");
  const pose = (
    await (await page.request.get("/api/state")).json()
  ).devices.find((d) => d.id === "car-1").pose;
  await expect
    .poll(
      async () => JSON.parse(await canvas.getAttribute("data-car-position")).x,
    )
    .toBeCloseTo(pose.x, 5);
});

test("3D failure keeps the ordinary controls available", async ({ page }) => {
  await page.route("**/vendor/three/three.module.js", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#world-message")).toContainText("3D 场景不可用");
  await expect(page.locator("#acquire-control")).toBeEnabled();
  await page.locator("#acquire-control").click();
  await expect(page.locator("#enable-control")).toBeEnabled();
});

test("3D marks a frozen pose as stale when state feedback disappears", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.locator("#world-viewport canvas");
  await expect(canvas).toHaveAttribute("data-arm-position", /xMm/);
  await page.route("**/api/state", (route) => route.abort());
  await expect(page.locator("#world-message")).toContainText("失联");
  await expect(page.locator("#world-message")).toBeVisible();
  await expect(page.locator("#world-status")).toContainText("状态过期");
});
