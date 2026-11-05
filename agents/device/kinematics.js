// Deliberately simplified, configurable simulation model. This is not an SO101
// calibration or a physical-hardware motion planner. X forward, Y left, Z up.
const DEG = Math.PI / 180;
const EPS = 1e-8;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const positionsOf = (joints) =>
  joints.map((joint) => (typeof joint === "number" ? joint : joint.position));

function checkModel(model) {
  if (
    !model ||
    ![
      model.baseHeightMm,
      model.upperArmMm,
      model.forearmMm,
      model.toolMm,
    ].every(finite) ||
    model.upperArmMm <= 0 ||
    model.forearmMm <= 0 ||
    model.toolMm < 0
  ) {
    throw fail("INVALID_CARTESIAN_PARAMS", "模拟运动学模型参数无效");
  }
}
function jointData(joints) {
  if (
    !Array.isArray(joints) ||
    joints.length !== 5 ||
    !positionsOf(joints).every(finite)
  ) {
    throw fail("INVALID_CARTESIAN_PARAMS", "简化模拟模型需要五个有限关节角");
  }
  return joints.map((joint) =>
    typeof joint === "number"
      ? { position: joint, min: -Infinity, max: Infinity }
      : joint,
  );
}
function within(value, min, max) {
  return value >= min - EPS && value <= max + EPS;
}
function equivalents(value, joint) {
  const near = Math.round((joint.position - value) / 360);
  const low = finite(joint.min)
    ? Math.ceil((joint.min - value - EPS) / 360)
    : near - 1;
  const high = finite(joint.max)
    ? Math.floor((joint.max - value + EPS) / 360)
    : near + 1;
  const result = [];
  for (let k = Math.max(low, near - 3); k <= Math.min(high, near + 3); k++)
    result.push(value + 360 * k);
  return result;
}

export function forwardKinematics(joints, model) {
  checkModel(model);
  const [yaw, shoulder, elbow, wrist, roll] = positionsOf(jointData(joints));
  const pitchDeg = shoulder + elbow + wrist;
  const radius =
    model.upperArmMm * Math.cos(shoulder * DEG) +
    model.forearmMm * Math.cos((shoulder + elbow) * DEG) +
    model.toolMm * Math.cos(pitchDeg * DEG);
  return {
    frame: "base",
    xMm: radius * Math.cos(yaw * DEG),
    yMm: radius * Math.sin(yaw * DEG),
    zMm:
      model.baseHeightMm +
      model.upperArmMm * Math.sin(shoulder * DEG) +
      model.forearmMm * Math.sin((shoulder + elbow) * DEG) +
      model.toolMm * Math.sin(pitchDeg * DEG),
    pitchDeg,
    rollDeg: roll,
  };
}

function solveIK(pose, model, joints, branch) {
  checkModel(model);
  const limits = jointData(joints);
  if (
    !pose ||
    (pose.frame !== undefined && pose.frame !== "base") ||
    ![pose.xMm, pose.yMm, pose.zMm, pose.pitchDeg, pose.rollDeg].every(finite)
  )
    throw fail(
      "INVALID_CARTESIAN_PARAMS",
      "末端位姿必须使用基座坐标系和有限数值",
    );
  const radius = Math.hypot(pose.xMm, pose.yMm);
  const yawBase =
    radius < EPS ? limits[0].position * DEG : Math.atan2(pose.yMm, pose.xMm);
  const pitch = pose.pitchDeg * DEG;
  const wristZ = pose.zMm - model.baseHeightMm - model.toolMm * Math.sin(pitch);
  let geometricallyReachable = false;
  const candidates = [];
  for (const radialSign of branch ? [branch.radialSign] : [1, -1]) {
    const wristRadius = radialSign * radius - model.toolMm * Math.cos(pitch);
    const cosine =
      (wristRadius ** 2 +
        wristZ ** 2 -
        model.upperArmMm ** 2 -
        model.forearmMm ** 2) /
      (2 * model.upperArmMm * model.forearmMm);
    if (cosine < -1 - EPS || cosine > 1 + EPS) continue;
    geometricallyReachable = true;
    const elbowMagnitude = Math.acos(Math.max(-1, Math.min(1, cosine)));
    const yaw = (yawBase + (radialSign < 0 ? Math.PI : 0)) / DEG;
    for (const elbowSign of branch ? [branch.elbowSign] : [1, -1]) {
      const elbow = elbowSign * elbowMagnitude;
      const shoulder =
        Math.atan2(wristZ, wristRadius) -
        Math.atan2(
          model.forearmMm * Math.sin(elbow),
          model.upperArmMm + model.forearmMm * Math.cos(elbow),
        );
      for (const yawDeg of equivalents(yaw, limits[0])) {
        for (const shoulderDeg of equivalents(shoulder / DEG, limits[1])) {
          for (const elbowDeg of equivalents(elbow / DEG, limits[2])) {
            const wristDeg = pose.pitchDeg - shoulderDeg - elbowDeg;
            const positions = [
              yawDeg,
              shoulderDeg,
              elbowDeg,
              wristDeg,
              pose.rollDeg,
            ];
            if (
              !positions.every((value, index) =>
                within(
                  value,
                  limits[index].min ?? -Infinity,
                  limits[index].max ?? Infinity,
                ),
              )
            )
              continue;
            const score = positions.reduce(
              (sum, value, index) =>
                sum + (value - limits[index].position) ** 2,
              0,
            );
            candidates.push({
              positions,
              score,
              branch: { radialSign, elbowSign },
            });
          }
        }
      }
    }
  }
  if (!candidates.length)
    throw fail(
      geometricallyReachable ? "JOINT_LIMIT" : "IK_UNREACHABLE",
      geometricallyReachable
        ? "笛卡尔路径超出模拟关节限位"
        : "笛卡尔路径超出简化模拟模型可达范围",
    );
  candidates.sort((left, right) => left.score - right.score);
  return candidates[0];
}

export function inverseKinematics(pose, model, jointsOrSeed) {
  return solveIK(pose, model, jointsOrSeed).positions;
}

function checkWorkspace(pose, workspace) {
  if (!workspace) return;
  for (const key of ["xMm", "yMm", "zMm"]) {
    const range = workspace[key];
    if (range && !within(pose[key], range[0], range[1]))
      throw fail("WORKSPACE_LIMIT", "笛卡尔路径超出模拟工作空间");
  }
  const radius = Math.hypot(pose.xMm, pose.yMm);
  if (
    !within(
      radius,
      workspace.minRadiusMm ?? 0,
      workspace.maxRadiusMm ?? Infinity,
    )
  )
    throw fail("WORKSPACE_LIMIT", "笛卡尔路径超出模拟径向工作空间");
}
function poseAt(plan, distanceMm) {
  const fraction =
    plan.distanceMm === 0
      ? 0
      : Math.max(0, Math.min(1, distanceMm / plan.distanceMm));
  return {
    ...plan.startPose,
    xMm:
      plan.startPose.xMm + (plan.endPose.xMm - plan.startPose.xMm) * fraction,
    yMm:
      plan.startPose.yMm + (plan.endPose.yMm - plan.startPose.yMm) * fraction,
    zMm:
      plan.startPose.zMm + (plan.endPose.zMm - plan.startPose.zMm) * fraction,
  };
}

// Between these points each selected-branch joint angle is monotone. Checking
// only evenly spaced samples misses arbitrarily narrow limit excursions, so add
// the exact planar-Jacobian stationary points before accepting a whole path.
// R is signed wrist radius, Z is wrist height, phi = shoulder + elbow:
//   d(elbow) = -(R*dR + Z*dZ) / (L1*L2*sin(elbow))
//   d(shoulder) = (cos(phi)*dR + sin(phi)*dZ) / (L1*sin(elbow))
//   d(phi) = -(cos(shoulder)*dR + sin(shoulder)*dZ) / (L2*sin(elbow))
// Wrist pitch is held constant, so wrist-joint extrema are phi extrema.
function criticalDistances(plan, model) {
  const distances = [0, plan.distanceMm];
  if (plan.distanceMm === 0) return distances;
  const direction = Math.sign(plan.deltaMm);
  const axisKey = `${plan.axis}Mm`;
  const startCoordinate = plan.startPose[axisKey];
  const addCoordinate = (coordinate) => {
    const distance = (coordinate - startCoordinate) * direction;
    if (
      finite(distance) &&
      distance >= -EPS &&
      distance <= plan.distanceMm + EPS
    ) {
      distances.push(Math.max(0, Math.min(plan.distanceMm, distance)));
    }
  };
  const roots = (squared, addRoot) => {
    if (squared < -EPS) return;
    const root = Math.sqrt(Math.max(0, squared));
    addRoot(root);
    addRoot(-root);
  };
  const pitch = plan.startPose.pitchDeg * DEG;
  const toolRadius = model.toolMm * Math.cos(pitch);
  const toolHeight = model.toolMm * Math.sin(pitch);
  const L1 = model.upperArmMm;
  const L2 = model.forearmMm;
  if (plan.axis === "x" || plan.axis === "y") {
    const fixedCoordinate = plan.startPose[plan.axis === "x" ? "yMm" : "xMm"];
    const Z = plan.startPose.zMm - model.baseHeightMm - toolHeight;
    const addWristRadius = (R) => {
      const radius = (R + toolRadius) / plan.branch.radialSign;
      if (radius < -EPS) return;
      roots(Math.max(0, radius) ** 2 - fixedCoordinate ** 2, addCoordinate);
    };
    // dR = 0 at the axis origin; R = 0 gives the other wrist-distance
    // extremum and therefore the other possible elbow-angle extremum.
    addCoordinate(0);
    addWristRadius(0);
    for (const sign of [-1, 1]) {
      // cos(phi) = 0: R^2 + (Z +/- L2)^2 = L1^2.
      roots(L1 ** 2 - (Z - sign * L2) ** 2, addWristRadius);
      // cos(shoulder) = 0: R^2 + (Z +/- L1)^2 = L2^2.
      roots(L2 ** 2 - (Z - sign * L1) ** 2, addWristRadius);
    }
  } else {
    const R =
      plan.branch.radialSign *
        Math.hypot(plan.startPose.xMm, plan.startPose.yMm) -
      toolRadius;
    const addWristHeight = (Z) =>
      addCoordinate(Z + model.baseHeightMm + toolHeight);
    // Z = 0 is the wrist-distance/elbow extremum for a vertical line.
    addWristHeight(0);
    for (const sign of [-1, 1]) {
      // sin(phi) = 0: (R +/- L2)^2 + Z^2 = L1^2.
      roots(L1 ** 2 - (R - sign * L2) ** 2, addWristHeight);
      // sin(shoulder) = 0: (R +/- L1)^2 + Z^2 = L2^2.
      roots(L2 ** 2 - (R - sign * L1) ** 2, addWristHeight);
    }
  }
  return distances;
}

function checkCartesianSingularity(pose, positions) {
  if (
    Math.hypot(pose.xMm, pose.yMm) <= EPS ||
    Math.abs(Math.sin(positions[2] * DEG)) <= EPS
  ) {
    throw fail(
      "IK_UNREACHABLE",
      "路径经过奇异姿态，简化模拟模型不支持此笛卡尔路径",
    );
  }
}

export function planCartesianJog(joints, model, params) {
  checkModel(model);
  const limits = jointData(joints);
  if (
    !params ||
    params.frame !== "base" ||
    !["x", "y", "z"].includes(params.axis)
  )
    throw fail(
      "INVALID_CARTESIAN_PARAMS",
      "笛卡尔点动需要基座坐标系、XYZ 轴和有限数值",
    );
  if (
    !finite(params.deltaMm) ||
    !finite(params.speedMmS) ||
    Math.abs(params.deltaMm) > model.maxStepMm ||
    params.speedMmS <= 0 ||
    params.speedMmS > model.maxSpeedMmS
  )
    throw fail("OUT_OF_RANGE", "笛卡尔步长或速度超出模拟限制");
  const startPose = forwardKinematics(limits, model);
  const endPose = {
    ...startPose,
    [`${params.axis}Mm`]: startPose[`${params.axis}Mm`] + params.deltaMm,
  };
  checkWorkspace(startPose, model.workspace);
  checkWorkspace(endPose, model.workspace);
  // The box is convex. Radial maximum is at an endpoint, but a line can cross
  // the inner exclusion cylinder with valid endpoints; check its exact minimum.
  const dx = endPose.xMm - startPose.xMm;
  const dy = endPose.yMm - startPose.yMm;
  const denominator = dx * dx + dy * dy;
  const fraction =
    denominator === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, -(startPose.xMm * dx + startPose.yMm * dy) / denominator),
        );
  checkWorkspace(
    {
      ...startPose,
      xMm: startPose.xMm + fraction * dx,
      yMm: startPose.yMm + fraction * dy,
      zMm: startPose.zMm + fraction * (endPose.zMm - startPose.zMm),
    },
    model.workspace,
  );
  const initial = solveIK(startPose, model, limits);
  checkCartesianSingularity(startPose, initial.positions);
  const plan = {
    startPose,
    endPose,
    distanceMm: Math.abs(params.deltaMm),
    speedMmS: params.speedMmS,
    axis: params.axis,
    deltaMm: params.deltaMm,
    branch: initial.branch,
    samples: [{ distanceMm: 0, positions: positionsOf(limits) }],
  };
  // Validate endpoints and every analytic joint/reach extremum, supplemented
  // by fine samples for branch continuity, before changing any target. Runtime
  // interpolation still solves the actual Cartesian point; the validation
  // samples are never used as a joint-linear trajectory.
  const resolution =
    finite(model.interpolationMm) && model.interpolationMm > 0
      ? Math.min(model.interpolationMm, 0.25)
      : 0.25;
  const steps = Math.max(1, Math.ceil(plan.distanceMm / resolution));
  const distances = criticalDistances(plan, model);
  for (let index = 1; index <= steps; index++)
    distances.push((plan.distanceMm * index) / steps);
  distances.sort((left, right) => left - right);
  let seed = limits;
  let previousDistance = 0;
  for (const distanceMm of distances) {
    if (distanceMm <= previousDistance) continue;
    previousDistance = distanceMm;
    const pose = poseAt(plan, distanceMm);
    checkWorkspace(pose, model.workspace);
    const positions = solveIK(pose, model, seed, plan.branch).positions;
    checkCartesianSingularity(pose, positions);
    if (
      positions.some(
        (position, i) => Math.abs(position - seed[i].position) > 180,
      )
    )
      throw fail("IK_UNREACHABLE", "笛卡尔路径经过模拟运动学不连续点");
    plan.samples.push({ distanceMm, positions });
    seed = seed.map((joint, i) => ({ ...joint, position: positions[i] }));
  }
  return plan;
}

export function interpolateCartesian(plan, distanceMm, model, joints) {
  if (!finite(distanceMm))
    throw fail("INVALID_CARTESIAN_PARAMS", "插补距离无效");
  const pose = poseAt(plan, distanceMm);
  checkWorkspace(pose, model.workspace);
  return solveIK(pose, model, joints, plan.branch).positions;
}

/** Actual forward-kinematics link origins for the simulation viewer. */
export function linkPoints(joints, model) {
  checkModel(model);
  const [yaw, shoulder, elbow, wrist] = positionsOf(jointData(joints));
  const pitch = shoulder + elbow + wrist;
  const yawRadians = yaw * DEG;
  const point = (radius, height) => ({
    xMm: radius * Math.cos(yawRadians),
    yMm: radius * Math.sin(yawRadians),
    zMm: height,
  });
  const elbowRadius = model.upperArmMm * Math.cos(shoulder * DEG);
  const elbowHeight =
    model.baseHeightMm + model.upperArmMm * Math.sin(shoulder * DEG);
  const wristRadius =
    elbowRadius + model.forearmMm * Math.cos((shoulder + elbow) * DEG);
  const wristHeight =
    elbowHeight + model.forearmMm * Math.sin((shoulder + elbow) * DEG);
  return [
    point(0, 0),
    point(0, model.baseHeightMm),
    point(elbowRadius, elbowHeight),
    point(wristRadius, wristHeight),
    point(
      wristRadius + model.toolMm * Math.cos(pitch * DEG),
      wristHeight + model.toolMm * Math.sin(pitch * DEG),
    ),
  ];
}
