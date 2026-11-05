import { test, expect } from "@playwright/test";

async function arm(page) {
  const response = await page.request.get("/api/state");
  return (await response.json()).devices.find((entry) => entry.id === "arm-1");
}

async function stereo(page) {
  const response = await page.request.get("/api/vision/stereo");
  return response.json();
}

async function prepareArm(page) {
  await page.goto("/");
  await expect(page.locator("#connection-state")).toContainText("已连接");
  await page.locator('[data-arm-mode="cartesian"]').click();
  await expect(page.locator("#cartesian-controls")).toBeVisible();
  await page.locator("#acquire-control").click();
  await expect(page.locator("#enable-control")).toBeEnabled();
  await page.locator("#enable-control").click();
  await expect.poll(async () => (await arm(page)).enabled).toBe(true);
}

test("Cartesian controls move one base-frame axis and show server FK coordinates", async ({
  page,
}) => {
  await prepareArm(page);
  await page.locator("#cartesian-step").selectOption("5");
  await page.locator("#cartesian-speed").selectOption("10");
  const before = (await arm(page)).endEffector;
  await page
    .locator('[data-cartesian-axis="z"][data-cartesian-direction="plus"]')
    .click();
  await expect
    .poll(async () => (await arm(page)).endEffector.zMm)
    .toBeCloseTo(before.zMm + 5, 3);
  const after = (await arm(page)).endEffector;
  expect(after.xMm).toBeCloseTo(before.xMm, 3);
  expect(after.yMm).toBeCloseTo(before.yMm, 3);
  await expect
    .poll(async () =>
      Number(await page.locator("#end-effector-z").textContent()),
    )
    .toBeCloseTo(after.zMm, 1);
  await expect(page.locator("#log-rows")).toContainText("坐标");
  await page.locator("#stop-device").click();
});

test("stopping a Cartesian trajectory freezes the tool and disables all axis controls", async ({
  page,
}) => {
  await prepareArm(page);
  await page.locator("#cartesian-step").selectOption("10");
  await page.locator("#cartesian-speed").selectOption("5");
  const before = (await arm(page)).endEffector.xMm;
  await page
    .locator('[data-cartesian-axis="x"][data-cartesian-direction="minus"]')
    .click();
  await expect
    .poll(async () => (await arm(page)).endEffector.xMm)
    .toBeLessThan(before - 0.2);
  await page.locator("#stop-device").click();
  await expect.poll(async () => (await arm(page)).enabled).toBe(false);
  const stopped = (await arm(page)).endEffector;
  expect(stopped.xMm).toBeGreaterThan(before - 10);
  await expect(
    page.locator('[data-cartesian-axis="x"][data-cartesian-direction="minus"]'),
  ).toBeDisabled();
  await page.locator("#enable-control").click();
  await expect.poll(async () => (await arm(page)).enabled).toBe(true);
  expect((await arm(page)).endEffector.xMm).toBeCloseTo(stopped.xMm, 5);
  await expect(page.locator("#log-rows")).toContainText("失败");
});

test("stereo panel shows synthetic targets and switches synchronized left, right and depth frames", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#connection-state")).toContainText("已连接");
  await expect(page.locator("#vision-calibration")).toContainText("模拟");
  await expect(page.locator("#vision-targets")).toContainText("袜子");
  await expect(page.locator("#vision-targets")).toContainText("收纳盒");
  for (const view of ["right", "depth", "left"]) {
    await page.locator(`[data-camera-view="${view}"]`).click();
    await expect(page.locator("#camera-image")).toHaveAttribute(
      "src",
      new RegExp(`/api/camera/${view}\\.svg\\?frameId=`),
    );
  }
  await page.locator("#pause-camera").click();
  await expect.poll(async () => (await stereo(page)).status).toBe("paused");
  const paused = await stereo(page);
  await expect(page.locator("#vision-sync")).toContainText(/暂停|冻结/);
  expect((await stereo(page)).frameId).toBe(paused.frameId);
  await page.locator("#pause-camera").click();
  await expect.poll(async () => (await stereo(page)).streaming).toBe(true);
  await expect
    .poll(async () => (await stereo(page)).frameId)
    .not.toBe(paused.frameId);
});

test("two-axis camera turret remains visibly reserved without configured hardware", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#ptz-status")).toContainText(
    /预留|未配置|未接硬件/,
  );
  await expect(page.locator("#ptz-section")).toContainText("水平");
  await expect(page.locator("#ptz-section")).toContainText("俯仰");
  const controls = page.locator("[data-ptz-axis]");
  expect(await controls.count()).toBeGreaterThanOrEqual(2);
  for (const control of await controls.all())
    await expect(control).toBeDisabled();
  const response = await page.request.get("/api/ptz");
  const capability = await response.json();
  expect(capability.configured).toBe(false);
  expect(capability.connected).toBe(false);
});

test("failed image resources remain visibly unavailable while motion control stays connected", async ({
  page,
}) => {
  const images = /\/api\/camera\/(left|right|depth)\.svg/;
  await page.route(images, (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#connection-state")).toContainText("已连接");
  await expect(page.locator("#acquire-control")).toBeEnabled();
  await expect(page.locator("#camera-state")).toContainText(
    /不可用|失败|加载|等待/,
  );
  await expect(page.locator("#vision-frame-id")).toContainText("待显示");
  await expect(page.locator("#capture-frame")).toBeDisabled();
  await page.unroute(images);
  await expect(page.locator("#camera-state")).toContainText("模拟画面");
  await expect
    .poll(async () =>
      page
        .locator("#camera-image")
        .evaluate((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
});
