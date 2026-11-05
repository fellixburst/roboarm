import { test, expect } from "@playwright/test";

async function device(page, id = "car-1") {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  return (await response.json()).devices.find((entry) => entry.id === id);
}

async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#connection-state")).toContainText("已连接");
  await expect(page.locator("#acquire-control")).toBeEnabled();
}

async function enable(page, id = "car-1") {
  await page.locator(`[data-device="${id}"]`).click();
  await page.locator("#acquire-control").click();
  await expect(page.locator("#enable-control")).toBeEnabled();
  await page.locator("#enable-control").click();
  await expect.poll(async () => (await device(page, id)).enabled).toBe(true);
}

async function holdForward(page) {
  const button = page.locator('[data-direction="forward"]');
  await expect(button).toBeEnabled();
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect
    .poll(async () => (await device(page)).velocity.linear)
    .toBeGreaterThan(0);
}

async function expectStopped(page) {
  await expect
    .poll(async () => {
      const car = await device(page);
      return (
        !car.enabled && car.velocity.linear === 0 && car.velocity.angular === 0
      );
    })
    .toBe(true);
}

test("Chinese simulated console shows arm feedback, command history and downloadable camera frame", async ({
  page,
}) => {
  await ready(page);
  await expect(page).toHaveTitle(/机器人模拟控制台/);
  await expect(page.locator(".simulation-badge")).toHaveText(/模拟模式/);
  await expect(page.locator("#enable-control")).toBeDisabled();
  await enable(page, "arm-1");
  const before = (await device(page, "arm-1")).joints[0].position;
  await page.locator('[data-jog="plus"][data-joint="joint-1"]').click();
  await expect
    .poll(async () => (await device(page, "arm-1")).joints[0].position)
    .toBeGreaterThan(before);
  await expect(page.locator("#log-rows")).toContainText("已完成");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#capture-frame").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.svg$/);
  expect(await download.failure()).toBeNull();
  await page.locator("#stop-device").click();
  await expect
    .poll(async () => (await device(page, "arm-1")).enabled)
    .toBe(false);
});

test("holding the car button keeps moving and pointer release stops until explicitly enabled", async ({
  page,
}) => {
  await ready(page);
  await enable(page);
  await holdForward(page);
  const first = (await device(page)).pose.x;
  await expect
    .poll(async () => (await device(page)).pose.x)
    .toBeGreaterThan(first + 0.05);
  await page.mouse.up();
  await expectStopped(page);
  await expect(page.locator('[data-direction="forward"]')).toBeDisabled();
  await page.locator("#enable-control").click();
  await expect.poll(async () => (await device(page)).enabled).toBe(true);
  expect((await device(page)).velocity.linear).toBe(0);
});

test("window blur while holding a car button stops and discards the held intent", async ({
  page,
}) => {
  await ready(page);
  await enable(page);
  await holdForward(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expectStopped(page);
  await page.mouse.up();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator('[data-direction="forward"]')).toBeDisabled();
});

test("lost control requests mark the UI offline and reconnect never resumes old motion", async ({
  page,
}) => {
  await ready(page);
  await enable(page);
  await holdForward(page);
  await page.route("**/api/**", (route) => route.abort());
  await expect(page.locator("#connection-state")).toContainText(
    /失联|断开|离线/,
  );
  await page.unroute("**/api/**");
  await page.mouse.up();
  await expectStopped(page);
  await page.locator("#reconnect").click();
  await expect(page.locator("#connection-state")).toContainText("已连接");
  await expect(page.locator('[data-direction="forward"]')).toBeDisabled();
  expect((await device(page)).enabled).toBe(false);
});

test("a second browser session observes ownership without gaining motion controls", async ({
  page,
  browser,
}) => {
  await ready(page);
  await enable(page);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await other.goto("/");
    await expect(other.locator("#connection-state")).toContainText("已连接");
    await other.locator('[data-device="car-1"]').click();
    await expect(other.locator("#metric-owner")).toContainText("会话");
    await expect(other.locator("#enable-control")).toBeDisabled();
    await expect(other.locator('[data-direction="forward"]')).toBeDisabled();
  } finally {
    await otherContext.close();
  }
});

test("mobile layout preserves visible controls without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await expect(page.locator("#acquire-control")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
});
