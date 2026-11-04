import test from "node:test";
import assert from "node:assert/strict";
import { StereoSimulator } from "../agents/device/stereo.js";
import { createControlServer } from "../services/control/server.js";
import { api, createClient, device, eventually, state } from "./helpers.js";

const onlineCamera = { connected: true, fault: null };

function simulator() {
  let monotonic = 0;
  const stereo = new StereoSimulator({
    now: () => monotonic,
    wallNow: () => new Date(Date.UTC(2026, 10, 4) + monotonic).toISOString(),
  });
  return {
    stereo,
    advance: (ms) => {
      monotonic += ms;
    },
  };
}

async function setup(t) {
  const control = await createControlServer({ port: 0 });
  t.after(() => control.close());
  const request = api(control.url);
  const client = await createClient(request);
  return { control, request, client };
}

function assertSyntheticDetection(metadata) {
  assert.equal(metadata.mode, "simulation");
  assert.equal(metadata.calibration.status, "simulated");
  assert.equal(
    metadata.calibration.robotTransform,
    null,
    "no invented camera-to-robot calibration",
  );
  assert.equal(metadata.depthSource, "synthetic-ground-truth");
  assert.ok(metadata.detections.length > 0);
  for (const detection of metadata.detections) {
    assert.equal(detection.source, "synthetic-ground-truth");
    assert.equal(detection.confidence, 1);
    assert.ok(detection.depthMm > 0);
    assert.ok(detection.disparityPx > 0);
    const fromDisparity =
      (metadata.calibration.focalLengthPx * metadata.calibration.baselineMm) /
      detection.disparityPx;
    assert.ok(
      Math.abs(detection.depthMm - fromDisparity) < 1e-6,
      "depth has consistent millimetre units and stereo geometry",
    );
    for (const [box, view] of [
      [detection.bbox, "left"],
      [detection.rightBbox, "right"],
    ]) {
      assert.equal(box.units, "px");
      assert.equal(box.view, view);
      assert.ok(box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0);
      assert.ok(box.x + box.width <= metadata.calibration.width);
      assert.ok(box.y + box.height <= metadata.calibration.height);
    }
    assert.ok(
      Math.abs(
        detection.bbox.x - detection.rightBbox.x - detection.disparityPx,
      ) < 0.01,
    );
  }
}

test("synthetic stereo detections use explicit simulation, calibrated units and matching disparity", () => {
  const { stereo } = simulator();
  const metadata = stereo.metadata(onlineCamera);
  assertSyntheticDetection(metadata);
  assert.equal(metadata.synchronization.frameId, metadata.frameId);
  assert.equal(metadata.synchronization.skewMs, 0);
  assert.equal(metadata.synchronization.source, "synthetic-shared-frame");
  for (const view of ["left", "right", "depth"]) {
    const image = stereo.image(view, metadata.frameId, onlineCamera);
    assert.equal(image.frameId, metadata.frameId);
    assert.equal(image.capturedAt, metadata.capturedAt);
    assert.match(image.svg, new RegExp(`data-frame-id="${metadata.frameId}"`));
    assert.match(image.svg, new RegExp(`data-view="${view}"`));
    assert.match(image.svg, /模拟/);
  }
});

test("stereo frame generation is rate-limited and image cache remains bounded", () => {
  const { stereo, advance } = simulator();
  const first = stereo.metadata(onlineCamera);
  for (let index = 0; index < 20; index++)
    assert.equal(stereo.metadata(onlineCamera).frameId, first.frameId);
  advance(499);
  assert.equal(stereo.metadata(onlineCamera).frameId, first.frameId);
  advance(1);
  assert.notEqual(stereo.metadata(onlineCamera).frameId, first.frameId);
  for (let index = 0; index < 20; index++) {
    advance(500);
    const metadata = stereo.metadata(onlineCamera);
    assert.ok(stereo.frames.size <= 6);
    assert.ok(
      JSON.stringify(metadata).length < 20000,
      "metadata contains resource references rather than unbounded images",
    );
    for (const view of ["left", "right", "depth"]) {
      assert.ok(
        Buffer.byteLength(
          stereo.image(view, metadata.frameId, onlineCamera).svg,
        ) < 100000,
      );
    }
  }
  assert.throws(() => stereo.image("left", first.frameId, onlineCamera), {
    code: "FRAME_EXPIRED",
  });
  assert.throws(() => stereo.image("left", "stereo-99999", onlineCamera), {
    code: "FRAME_NOT_FOUND",
  });
});

test("paused stereo freezes captured images while exposure changes apply to later frames", () => {
  const { stereo, advance } = simulator();
  const first = stereo.metadata(onlineCamera);
  const firstImage = stereo.image("left", first.frameId, onlineCamera).svg;
  assert.equal(first.frameExposureMs, 8);
  const paused = stereo.control({ action: "pause" }, onlineCamera);
  assert.equal(paused.status, "paused");
  assert.equal(paused.streaming, false);
  advance(5000);
  assert.equal(stereo.metadata(onlineCamera).frameId, first.frameId);
  assert.equal(
    stereo.image("left", first.frameId, onlineCamera).svg,
    firstImage,
  );
  stereo.control({ action: "set-exposure", exposureMs: 16 }, onlineCamera);
  assert.equal(stereo.metadata(onlineCamera).frameId, first.frameId);
  assert.equal(stereo.metadata(onlineCamera).frameExposureMs, 8);
  assert.equal(stereo.metadata(onlineCamera).exposureMs, 16);
  assert.equal(
    stereo.image("left", first.frameId, onlineCamera).svg,
    firstImage,
  );
  const resumed = stereo.control({ action: "resume" }, onlineCamera);
  assert.equal(resumed.status, "streaming");
  assert.notEqual(resumed.frameId, first.frameId);
  assert.equal(resumed.exposureMs, 16);
  assert.equal(resumed.frameExposureMs, 16);
  assert.match(
    stereo.image("left", resumed.frameId, onlineCamera).svg,
    /16 ms/,
  );
});

test("invalid stereo controls and offline cameras cannot claim successful frames", () => {
  const { stereo } = simulator();
  for (const exposureMs of [-1, 0, 50.01, Number.NaN, "8"]) {
    assert.throws(
      () =>
        stereo.control({ action: "set-exposure", exposureMs }, onlineCamera),
      { code: "OUT_OF_RANGE" },
    );
  }
  assert.throws(
    () => stereo.control({ action: "set-exposure" }, onlineCamera),
    { code: "OUT_OF_RANGE" },
  );
  assert.throws(() => stereo.control({ action: "unknown" }, onlineCamera), {
    code: "INVALID_VISION_ACTION",
  });
  assert.equal(stereo.exposureMs, 8);
  for (const camera of [
    { connected: false, fault: null },
    { connected: true, fault: { code: "SIMULATED_FAULT" } },
  ]) {
    const offline = stereo.metadata(camera);
    assert.equal(offline.status, "offline");
    assert.equal(offline.available, false);
    assert.equal(offline.streaming, false);
    assert.equal(offline.frameId, null);
    assert.equal(offline.frames, null);
    assert.deepEqual(offline.detections, []);
    assert.equal(offline.synchronization.status, "unavailable");
    assert.throws(() => stereo.control({ action: "resume" }, camera), {
      code: "CAMERA_OFFLINE",
    });
    assert.throws(() => stereo.image("left", null, camera), {
      code: "CAMERA_OFFLINE",
    });
  }
});

test("HTTP stereo metadata references synchronized bounded SVG resources for left, right and depth", async (t) => {
  const { control, request } = await setup(t);
  const response = await request("/api/vision/stereo");
  assert.equal(response.status, 200);
  const metadata = response.body;
  assertSyntheticDetection(metadata);
  assert.equal(metadata.synchronization.status, "synchronized");
  const images = await Promise.all(
    ["left", "right", "depth"].map(async (view) => {
      assert.match(
        metadata.frames[view],
        new RegExp(`frameId=${metadata.frameId}`),
      );
      const image = await fetch(`${control.url}${metadata.frames[view]}`, {
        signal: AbortSignal.timeout(4000),
      });
      assert.equal(image.status, 200);
      assert.match(image.headers.get("content-type"), /image\/svg\+xml/);
      assert.equal(image.headers.get("x-frame-id"), metadata.frameId);
      assert.equal(image.headers.get("x-captured-at"), metadata.capturedAt);
      const svg = await image.text();
      assert.ok(Buffer.byteLength(svg) < 100000);
      assert.match(svg, /模拟/);
      assert.match(svg, new RegExp(`data-view="${view}"`));
      return svg;
    }),
  );
  assert.notEqual(images[0], images[1]);
  const unknown = await fetch(
    `${control.url}/api/camera/left.svg?frameId=stereo-99999`,
  );
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "FRAME_NOT_FOUND");
});

test("HTTP stereo controls require a live session, enforce exposure ranges and log pause/resume", async (t) => {
  const { request, client } = await setup(t);
  const send = (action, extra = {}) =>
    request("/api/vision/stereo/control", {
      method: "POST",
      body: { sessionId: client.sessionId, action, ...extra },
    });
  const unauthorized = await request("/api/vision/stereo/control", {
    method: "POST",
    body: { action: "pause" },
  });
  assert.equal(unauthorized.status, 400);
  assert.equal(unauthorized.body.error.code, "SESSION_EXPIRED");
  for (const exposureMs of [0, 50.01, "8"]) {
    const invalid = await send("set-exposure", { exposureMs });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "OUT_OF_RANGE");
  }
  for (const exposureMs of [0.1, 50]) {
    const exposure = await send("set-exposure", { exposureMs });
    assert.equal(exposure.status, 200);
    assert.equal(exposure.body.exposureMs, exposureMs);
  }
  const paused = await send("pause");
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, "paused");
  assert.equal(
    (await request("/api/vision/stereo")).body.frameId,
    paused.body.frameId,
  );
  const resumed = await send("resume");
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, "streaming");
  assert.notEqual(resumed.body.frameId, paused.body.frameId);
  const logs = (await state(request)).logs.filter(
    (entry) => entry.event === "STEREO_CONTROL",
  );
  assert.ok(logs.some((entry) => /pause/.test(entry.message)));
  assert.ok(logs.some((entry) => /resume/.test(entry.message)));
  assert.ok(logs.every((entry) => entry.deviceId === "camera-1"));
  await request(`/api/sessions/${client.sessionId}`, { method: "DELETE" });
  const expired = await send("resume");
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error.code, "SESSION_EXPIRED");
});

for (const type of ["disconnect", "fault"]) {
  test(`HTTP camera ${type} reports unavailable metadata and rejects old frames and controls`, async (t) => {
    const { control, request, client } = await setup(t);
    const original = (await request("/api/vision/stereo")).body;
    const injected = await request("/api/simulate", {
      method: "POST",
      body: { sessionId: client.sessionId, deviceId: "camera-1", type },
    });
    assert.equal(injected.status, 200);
    await eventually(
      () => state(request),
      (snapshot) => {
        const camera = device(snapshot, "camera-1");
        return type === "disconnect"
          ? !camera.connected
          : Boolean(camera.fault);
      },
      "camera state reflects injected condition",
    );
    const metadata = (await request("/api/vision/stereo")).body;
    assert.equal(metadata.status, "offline");
    assert.equal(metadata.available, false);
    assert.equal(metadata.frameId, null);
    assert.equal(metadata.frames, null);
    assert.deepEqual(metadata.detections, []);
    for (const view of ["left", "right", "depth"]) {
      const image = await fetch(`${control.url}${original.frames[view]}`);
      assert.equal(image.status, 503);
      assert.equal((await image.json()).error.code, "CAMERA_OFFLINE");
    }
    const resume = await request("/api/vision/stereo/control", {
      method: "POST",
      body: { sessionId: client.sessionId, action: "resume" },
    });
    assert.equal(resume.status, 503);
    assert.equal(resume.body.error.code, "CAMERA_OFFLINE");
  });
}

test("reserved PTZ has no fabricated positions or transport and cannot be enabled by reconnect injection", async (t) => {
  const { request, client } = await setup(t);
  const metadata = await request("/api/ptz");
  assert.equal(metadata.status, 200);
  const ptz = metadata.body;
  assert.equal(ptz.id, "ptz-1");
  assert.equal(ptz.mode, "reserved");
  assert.equal(ptz.configured, false);
  assert.equal(ptz.connected, false);
  assert.equal(ptz.enabled, false);
  assert.deepEqual(
    ptz.axes.map((axis) => axis.id),
    ["pan", "tilt"],
  );
  assert.ok(
    ptz.axes.every((axis) => axis.positionDeg === null && axis.unit === "deg"),
  );
  assert.equal(ptz.transport.configured, false);
  assert.equal(ptz.transport.endpoint, null);
  assert.equal(ptz.mount.extrinsics, null);
  for (const action of ["ptz-jog", "enable", "acquire"]) {
    const rejected = await client.send("ptz-1", action, {
      axis: "pan",
      deltaDeg: 5,
      speedDegS: 10,
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "NOT_CONFIGURED");
    assert.equal(rejected.body.command.status, "rejected");
  }
  const injection = await request("/api/simulate", {
    method: "POST",
    body: { sessionId: client.sessionId, deviceId: "ptz-1", type: "reconnect" },
  });
  assert.equal(injection.status, 400);
  const after = (await request("/api/ptz")).body;
  assert.equal(after.connected, false);
  assert.equal(after.configured, false);
  assert.ok(after.axes.every((axis) => axis.positionDeg === null));
});

test("reserved PTZ alias uses the same session, clock and sequence checks as motion commands", async (t) => {
  const { request, client } = await setup(t);
  const params = { axis: "tilt", deltaDeg: 5, speedDegS: 10 };
  const command = client.envelope("ptz-1", "ptz-jog", params);
  const rejected = await request("/api/ptz/commands", {
    method: "POST",
    body: command,
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "NOT_CONFIGURED");
  const wrongClock = await request("/api/ptz/commands", {
    method: "POST",
    body: client.envelope("ptz-1", "ptz-jog", params, {
      clockToken: "unknown",
    }),
  });
  assert.equal(wrongClock.status, 400);
  assert.equal(wrongClock.body.error.code, "CLOCK_EXPIRED");
  const wrongSequence = await request("/api/ptz/commands", {
    method: "POST",
    body: client.envelope("ptz-1", "ptz-jog", params, { sequence: 1 }),
  });
  assert.equal(wrongSequence.status, 400);
  assert.equal(wrongSequence.body.error.code, "OUT_OF_ORDER");
  await request(`/api/sessions/${client.sessionId}`, { method: "DELETE" });
  const oldSession = await request("/api/ptz/commands", {
    method: "POST",
    body: client.envelope("ptz-1", "ptz-jog", params),
  });
  assert.equal(oldSession.status, 400);
  assert.equal(oldSession.body.error.code, "SESSION_EXPIRED");
});
