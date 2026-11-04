import test from "node:test";
import assert from "node:assert/strict";
import {
  SimulatorAdapter,
  simulationConfig,
} from "../agents/device/adapter.js";
import { createControlServer } from "../services/control/server.js";
import {
  accepted,
  api,
  createClient,
  delay,
  device,
  enable,
  rejected,
  state,
} from "./helpers.js";

const tolerance = 1e-5;
const axes = ["x", "y", "z"];
const closeTo = (actual, expected, label, epsilon = tolerance) =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${label}: expected ${expected}, received ${actual}`,
  );

function rig(config = simulationConfig) {
  let monotonic = 0;
  let sequence = 0;
  const events = [];
  const adapter = new SimulatorAdapter({
    config,
    now: () => monotonic,
    onEvent: (event) => events.push(event),
  });
  const command = (action, params = {}) => ({
    version: 1,
    sessionId: "cartesian-session",
    commandId: `cartesian-command-${++sequence}`,
    sequence,
    deviceId: "arm-1",
    action,
    params,
    clockToken: "device-local-test-token",
    ttlMs: 1000,
  });
  const execute = (action, params = {}, options = {}) => {
    const sent = command(action, params);
    return {
      sent,
      result: adapter.execute(sent, {
        expiresInMs: 1000,
        leaseMs: 1200,
        ...options,
      }),
    };
  };
  const arm = () => adapter.snapshot().find((entry) => entry.id === "arm-1");
  const advance = (ms) => {
    monotonic += ms;
    adapter.tick();
  };
  execute("acquire");
  execute("enable");
  return { adapter, arm, execute, advance, events, command };
}

// Compute the pose independently from actual simulated joint feedback. This
// catches a console that merely reports the requested Cartesian target.
function observedForwardKinematics(arm) {
  const radians = arm.joints.map((joint) => (joint.position * Math.PI) / 180);
  const [yaw, shoulder, elbow, wrist, roll] = radians;
  const pitch = shoulder + elbow + wrist;
  const model = arm.kinematics;
  const radial =
    model.upperArmMm * Math.cos(shoulder) +
    model.forearmMm * Math.cos(shoulder + elbow) +
    model.toolMm * Math.cos(pitch);
  return {
    xMm: radial * Math.cos(yaw),
    yMm: radial * Math.sin(yaw),
    zMm:
      model.baseHeightMm +
      model.upperArmMm * Math.sin(shoulder) +
      model.forearmMm * Math.sin(shoulder + elbow) +
      model.toolMm * Math.sin(pitch),
    pitchDeg: (pitch * 180) / Math.PI,
    rollDeg: (roll * 180) / Math.PI,
  };
}

function assertPoseMatchesJoints(arm) {
  const observed = observedForwardKinematics(arm);
  for (const field of ["xMm", "yMm", "zMm", "pitchDeg", "rollDeg"]) {
    closeTo(
      arm.endEffector[field],
      observed[field],
      `forward kinematics ${field}`,
    );
  }
  assert.equal(arm.endEffector.frame, "base");
}

test("arm exposes a simulated base-frame pose derived from its actual joint positions", () => {
  const r = rig();
  const arm = r.arm();
  assert.equal(arm.kinematics.mode, "simulation");
  assert.equal(arm.kinematics.frame, "base");
  assert.match(arm.kinematics.name, /模拟/);
  assertPoseMatchesJoints(arm);
  closeTo(arm.endEffector.xMm, 281.520848927587, "initial x", 0.01);
  closeTo(arm.endEffector.yMm, 0, "initial y");
  closeTo(arm.endEffector.zMm, 109.671771620203, "initial z", 0.01);
});

for (const axis of axes) {
  for (const sign of [-1, 1]) {
    test(`Cartesian ${axis}${sign > 0 ? "+" : "-"} follows a straight path at the requested speed`, () => {
      const r = rig();
      const start = r.arm().endEffector;
      const deltaMm = sign * 6;
      const speedMmS = 10;
      const movement = r.execute("cartesian-jog", {
        frame: "base",
        axis,
        deltaMm,
        speedMmS,
      });
      assert.equal(movement.result.status, "executing");
      let previous = start;
      let previousJoints = r.arm().joints;
      let complete = false;
      let samples = 0;
      for (; samples < 250; samples++) {
        if (samples % 10 === 0) r.adapter.heartbeat("cartesian-session", 1200);
        r.advance(20);
        const arm = r.arm();
        const pose = arm.endEffector;
        assertPoseMatchesJoints(arm);
        for (let index = 0; index < arm.joints.length; index++) {
          assert.ok(
            Math.abs(
              arm.joints[index].position - previousJoints[index].position,
            ) <=
              arm.joints[index].maxSpeed * 0.02 + tolerance,
            "Cartesian interpolation obeys each joint speed limit",
          );
        }
        for (const coordinate of axes) {
          const field = `${coordinate}Mm`;
          if (coordinate === axis) {
            const step = (pose[field] - previous[field]) * sign;
            assert.ok(step >= -tolerance, "target axis never reverses");
            assert.ok(
              step <= speedMmS * 0.02 + tolerance,
              "target axis obeys speed limit",
            );
            assert.ok(
              (pose[field] - start[field]) * sign <=
                Math.abs(deltaMm) + tolerance,
              "target axis never overshoots",
            );
          } else
            closeTo(
              pose[field],
              start[field],
              `orthogonal ${coordinate} remains fixed`,
            );
        }
        closeTo(pose.pitchDeg, start.pitchDeg, "tool pitch remains fixed");
        closeTo(pose.rollDeg, start.rollDeg, "tool roll remains fixed");
        previous = pose;
        previousJoints = arm.joints;
        complete = r.events.some(
          (event) =>
            event.commandId === movement.sent.commandId &&
            event.code === "COMMAND_COMPLETED",
        );
        if (complete) break;
      }
      assert.ok(complete, "Cartesian target reaches completion");
      assert.ok(samples >= 2, "several intermediate poses were observed");
      closeTo(
        r.arm().endEffector[`${axis}Mm`],
        start[`${axis}Mm`] + deltaMm,
        "final target",
      );
    });
  }
}

test("Cartesian frame, axis, distance and speed validation do not alter joint state", () => {
  const r = rig();
  const before = r.arm();
  const valid = { frame: "base", axis: "x", deltaMm: 3, speedMmS: 10 };
  for (const [params, code] of [
    [{ ...valid, frame: "tool" }, "INVALID_CARTESIAN_PARAMS"],
    [{ ...valid, axis: "yaw" }, "INVALID_CARTESIAN_PARAMS"],
    [{ ...valid, deltaMm: 10.01 }, "OUT_OF_RANGE"],
    [{ ...valid, deltaMm: Number.NaN }, "OUT_OF_RANGE"],
    [{ ...valid, speedMmS: 0 }, "OUT_OF_RANGE"],
    [{ ...valid, speedMmS: 30.01 }, "OUT_OF_RANGE"],
  ])
    assert.throws(() => r.execute("cartesian-jog", params), { code });
  assert.deepEqual(r.arm().joints, before.joints);
  assert.deepEqual(r.arm().endEffector, before.endEffector);
});

test("Cartesian workspace rejection is atomic and preserves an existing valid joint motion", () => {
  const config = structuredClone(simulationConfig);
  config.kinematics.workspace.yMm = [-2, 2];
  const r = rig(config);
  const older = r.execute("jog", { jointId: "joint-2", delta: 2, speed: 5 });
  r.advance(100);
  const before = r.arm();
  assert.throws(
    () =>
      r.execute("cartesian-jog", {
        frame: "base",
        axis: "y",
        deltaMm: 6,
        speedMmS: 10,
      }),
    { code: "WORKSPACE_LIMIT" },
  );
  assert.deepEqual(r.arm().joints, before.joints);
  assert.deepEqual(r.arm().endEffector, before.endEffector);
  assert.equal(
    r.events.some(
      (event) =>
        event.commandId === older.sent.commandId &&
        event.code === "COMMAND_FAILED",
    ),
    false,
  );
  r.advance(100);
  assert.ok(
    r.arm().joints[1].position > before.joints[1].position,
    "original valid target still executes",
  );
});

test("unreachable Cartesian target is rejected before moving any joint", () => {
  const config = structuredClone(simulationConfig);
  for (const joint of config.joints) joint.position = 0;
  const r = rig(config);
  const before = r.arm();
  assert.throws(
    () =>
      r.execute("cartesian-jog", {
        frame: "base",
        axis: "x",
        deltaMm: 6,
        speedMmS: 10,
      }),
    { code: "IK_UNREACHABLE" },
  );
  assert.deepEqual(r.arm().joints, before.joints);
  assert.deepEqual(r.arm().endEffector, before.endEffector);
});

test("Cartesian planning rejects an unsafe intermediate radius even when both endpoints are valid", () => {
  const config = structuredClone(simulationConfig);
  const xMm = 60.05;
  const yMm = -4;
  const wristRadius = Math.hypot(xMm, yMm) - config.kinematics.toolMm;
  const elbow =
    (Math.acos(
      (wristRadius ** 2 - 2 * config.kinematics.upperArmMm ** 2) /
        (2 * config.kinematics.upperArmMm ** 2),
    ) *
      180) /
    Math.PI;
  const positions = [
    (Math.atan2(yMm, xMm) * 180) / Math.PI,
    -elbow / 2,
    elbow,
    -elbow / 2,
    0,
  ];
  config.joints[2].max = 180;
  config.joints.forEach((joint, index) => {
    joint.position = positions[index];
  });
  config.kinematics.workspace.minRadiusMm = 60.1;
  const r = rig(config);
  const before = r.arm();
  closeTo(before.endEffector.xMm, xMm, "custom initial x");
  closeTo(before.endEffector.yMm, yMm, "custom initial y");
  assert.ok(Math.hypot(xMm, yMm) > config.kinematics.workspace.minRadiusMm);
  assert.ok(Math.hypot(xMm, yMm + 8) > config.kinematics.workspace.minRadiusMm);
  assert.ok(
    xMm < config.kinematics.workspace.minRadiusMm,
    "the straight segment crosses the inner exclusion cylinder",
  );
  assert.throws(
    () =>
      r.execute("cartesian-jog", {
        frame: "base",
        axis: "y",
        deltaMm: 8,
        speedMmS: 10,
      }),
    { code: "WORKSPACE_LIMIT" },
  );
  assert.deepEqual(r.arm().joints, before.joints);
  assert.deepEqual(r.arm().endEffector, before.endEffector);
});

test("Cartesian IK respects configured joint limits before starting the entire path", () => {
  const config = structuredClone(simulationConfig);
  config.joints[1].max = -19;
  const r = rig(config);
  const before = r.arm();
  assert.throws(
    () =>
      r.execute("cartesian-jog", {
        frame: "base",
        axis: "x",
        deltaMm: 6,
        speedMmS: 10,
      }),
    { code: "JOINT_LIMIT" },
  );
  assert.deepEqual(r.arm().joints, before.joints);
  assert.deepEqual(r.arm().endEffector, before.endEffector);
});

test("Cartesian planning catches a narrow intermediate joint-limit peak between spatial samples", () => {
  const config = structuredClone(simulationConfig);
  const positions = [
    92.32636180357507, -10.292628182856392, 119.96471589485839,
    -64.672087712002, 0,
  ];
  config.joints.forEach((joint, index) => {
    joint.position = positions[index];
  });
  const r = rig(config);
  const original = r.execute("jog", { jointId: "joint-5", delta: 2, speed: 5 });
  const before = r.arm();
  closeTo(before.endEffector.xMm, -4.875, "narrow-peak initial x");
  closeTo(before.endEffector.yMm, 120, "narrow-peak initial y");
  // The elbow reaches 120.00001 degrees at x=0 (distance 4.875 mm),
  // while the 0.25 mm sample points remain below 120 degrees.
  assert.throws(
    () =>
      r.execute("cartesian-jog", {
        frame: "base",
        axis: "x",
        deltaMm: 10,
        speedMmS: 5,
      }),
    { code: "JOINT_LIMIT" },
  );
  assert.deepEqual(
    r.arm().joints,
    before.joints,
    "planning rejection is atomic",
  );
  assert.deepEqual(r.arm().endEffector, before.endEffector);
  assert.equal(
    r.events.some(
      (event) =>
        event.commandId === original.sent.commandId &&
        event.code === "COMMAND_FAILED",
    ),
    false,
  );
  r.advance(20);
  assert.ok(
    r.arm().joints[4].position > before.joints[4].position,
    "previous target remains active after rejected replacement",
  );
});

test("stop cancels a Cartesian target, freezes feedback, and requires explicit enable", () => {
  const r = rig();
  const movement = r.execute("cartesian-jog", {
    frame: "base",
    axis: "z",
    deltaMm: 6,
    speedMmS: 10,
  });
  r.advance(100);
  r.execute("stop");
  const stopped = r.arm();
  r.adapter.heartbeat("cartesian-session", 1200);
  r.advance(100);
  assert.deepEqual(r.arm().endEffector, stopped.endEffector);
  assert.deepEqual(r.arm().joints, stopped.joints);
  assert.equal(r.arm().enabled, false);
  assert.ok(
    r.events.some(
      (event) =>
        event.commandId === movement.sent.commandId &&
        event.code === "COMMAND_FAILED",
    ),
  );
  assert.throws(
    () =>
      r.execute("cartesian-jog", {
        frame: "base",
        axis: "z",
        deltaMm: 1,
        speedMmS: 10,
      }),
    { code: "NOT_ENABLED" },
  );
});

test("joint and Cartesian motion replace one another instead of running concurrently", () => {
  const r = rig();
  const joint = r.execute("jog", { jointId: "joint-2", delta: 10, speed: 5 });
  r.advance(100);
  const start = r.arm().endEffector;
  const cartesian = r.execute("cartesian-jog", {
    frame: "base",
    axis: "y",
    deltaMm: 6,
    speedMmS: 10,
  });
  assert.ok(
    r.events.some(
      (event) =>
        event.commandId === joint.sent.commandId &&
        event.code === "COMMAND_FAILED",
    ),
  );
  r.advance(100);
  closeTo(
    r.arm().endEffector.xMm,
    start.xMm,
    "Cartesian replacement keeps x fixed",
  );
  closeTo(
    r.arm().endEffector.zMm,
    start.zMm,
    "Cartesian replacement keeps z fixed",
  );
  r.execute("jog", { jointId: "joint-1", delta: 1, speed: 10 });
  assert.ok(
    r.events.some(
      (event) =>
        event.commandId === cartesian.sent.commandId &&
        event.code === "COMMAND_FAILED",
    ),
  );
  r.advance(150);
  const finished = r.arm();
  r.advance(100);
  assert.deepEqual(r.arm().joints, finished.joints);
});

test("Cartesian commands use the same HTTP ownership, expiry, deduplication and lifecycle gate", async (t) => {
  const control = await createControlServer({ port: 0 });
  t.after(() => control.close());
  const request = api(control.url);
  const client = await createClient(request);
  const params = { frame: "base", axis: "z", deltaMm: 2, speedMmS: 10 };
  rejected(await client.send("arm-1", "cartesian-jog", params), "NOT_OWNER");
  await accepted(request, client, "arm-1", "acquire");
  rejected(await client.send("arm-1", "cartesian-jog", params), "NOT_ENABLED");
  await accepted(request, client, "arm-1", "enable");
  const before = device(await state(request), "arm-1").endEffector;
  const movement = await accepted(
    request,
    client,
    "arm-1",
    "cartesian-jog",
    params,
  );
  const duplicate = await request("/api/commands", {
    method: "POST",
    body: movement.sent,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  closeTo(
    device(await state(request), "arm-1").endEffector.zMm,
    before.zMm + 2,
    "duplicate is not executed again",
  );
  await client.refresh();
  const delayed = client.envelope("arm-1", "cartesian-jog", params, {
    ttlMs: 1,
  });
  await delay(30);
  rejected(
    await request("/api/commands", { method: "POST", body: delayed }),
    "EXPIRED",
  );
  const snapshot = await state(request);
  closeTo(
    device(snapshot, "arm-1").endEffector.zMm,
    before.zMm + 2,
    "expired movement is ignored",
  );
  const command = snapshot.commands.find(
    (entry) => entry.commandId === movement.sent.commandId,
  );
  assert.deepEqual(
    command.transitions.map((entry) => entry.status),
    ["received", "executing", "completed"],
  );
});
