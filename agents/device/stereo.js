import { protocolError } from "../../protocol/validation.js";

const FRAME_INTERVAL_MS = 500;
const FRAME_CACHE_SIZE = 6;
const SENSOR = Object.freeze({
  width: 960,
  height: 540,
  focalLengthPx: 480,
  baselineMm: 60,
  principalPoint: { x: 480, y: 270 },
});
// Deliberately synthetic, known geometry in the camera frame: X right, Y down,
// Z forward. Depth is ground truth from this scene, not an inference result.
const OBJECTS = Object.freeze([
  {
    id: "sock-1",
    label: "袜子",
    xMm: -180,
    yMm: 95,
    zMm: 900,
    widthMm: 180,
    heightMm: 110,
    color: "#d4e2df",
  },
  {
    id: "bin-1",
    label: "收纳盒",
    xMm: 370,
    yMm: 140,
    zMm: 1400,
    widthMm: 320,
    heightMm: 260,
    color: "#bc9c67",
  },
]);

const round = (value) => Math.round(value * 1000) / 1000;
const clone = (value) => structuredClone(value);

export const ptzCapability = Object.freeze({
  id: "ptz-1",
  name: "双轴相机云台",
  mode: "reserved",
  status: "not-configured",
  configured: false,
  connected: false,
  enabled: false,
  axes: [
    {
      id: "pan",
      name: "水平旋转",
      unit: "deg",
      positionDeg: null,
      limits: { minDeg: -150, maxDeg: 150, maxSpeedDegS: 30 },
      limitsSource: "example-only",
    },
    {
      id: "tilt",
      name: "俯仰",
      unit: "deg",
      positionDeg: null,
      limits: { minDeg: -60, maxDeg: 60, maxSpeedDegS: 20 },
      limitsSource: "example-only",
    },
  ],
  mount: { cameraId: "camera-1", frame: "camera-mount", extrinsics: null },
  transport: {
    configured: false,
    kind: null,
    endpoint: null,
    supported: ["serial", "can", "tcp"],
    pinAssignments: null,
  },
  command: {
    endpoint: "/api/ptz/commands",
    action: "ptz-jog",
    params: { axis: "pan | tilt", deltaDeg: "number", speedDegS: "number" },
  },
  message: "仅预留水平、俯仰适配接口；电机型号、标定、通信和引脚均未配置。",
});

function project(object, right = false) {
  const width = (SENSOR.focalLengthPx * object.widthMm) / object.zMm;
  const height = (SENSOR.focalLengthPx * object.heightMm) / object.zMm;
  const centerX =
    SENSOR.principalPoint.x +
    (SENSOR.focalLengthPx * (object.xMm - (right ? SENSOR.baselineMm : 0))) /
      object.zMm;
  const centerY =
    SENSOR.principalPoint.y + (SENSOR.focalLengthPx * object.yMm) / object.zMm;
  return {
    x: round(centerX - width / 2),
    y: round(centerY - height / 2),
    width: round(width),
    height: round(height),
    units: "px",
    view: right ? "right" : "left",
  };
}

function detection(object) {
  return {
    id: object.id,
    label: object.label,
    bbox: project(object),
    rightBbox: project(object, true),
    depthMm: object.zMm,
    disparityPx: (SENSOR.focalLengthPx * SENSOR.baselineMm) / object.zMm,
    confidence: 1,
    source: "synthetic-ground-truth",
  };
}

function svgFrame(frame, view) {
  const depth = view === "depth";
  const title = depth
    ? "SIMULATED DEPTH"
    : `SIMULATED ${view.toUpperCase()} CAMERA`;
  const points = OBJECTS.map((object, index) => {
    const box =
      view === "right"
        ? frame.detections[index].rightBbox
        : frame.detections[index].bbox;
    const fill = depth ? (index === 0 ? "#49ceb7" : "#6b8dde") : object.color;
    const shape =
      object.id === "sock-1"
        ? `<path d="M${box.x + box.width * 0.3} ${box.y}h${box.width * 0.45}v${box.height * 0.55}l${box.width * 0.22} ${box.height * 0.22}q${box.width * 0.02} ${box.height * 0.24}-${box.width * 0.3} ${box.height * 0.23}h-${box.width * 0.6}q-${box.width * 0.12}-${box.height * 0.1} 0-${box.height * 0.35}l${box.width * 0.23}-${box.height * 0.1}z" fill="${fill}"/>`
        : `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="6" fill="${fill}"/><path d="M${box.x} ${box.y + box.height * 0.24}h${box.width}" stroke="#182b37" stroke-opacity=".5" stroke-width="5"/>`;
    return `${shape}<rect x="${box.x - 9}" y="${box.y - 9}" width="${box.width + 18}" height="${box.height + 18}" rx="3" fill="none" stroke="#6ef2cd" stroke-width="2" stroke-dasharray="7 4"/><text x="${box.x - 9}" y="${box.y - 19}" fill="#9ef4d9" font-size="15">${object.label} · ${(object.zMm / 1000).toFixed(2)} m</text>`;
  }).join("");
  const background = depth ? "#102938" : "#1c303b";
  const brightness = depth
    ? 1
    : Math.max(0.3, Math.min(1.4, frame.exposureMs / 8));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" data-frame-id="${frame.id}" data-view="${view}"><defs><pattern id="g" width="60" height="30" patternUnits="userSpaceOnUse"><path d="M60 0H0V30" fill="none" stroke="#5b7c8a" stroke-opacity=".25"/></pattern><linearGradient id="depth"><stop stop-color="#49ceb7"/><stop offset="1" stop-color="#6b8dde"/></linearGradient></defs><rect width="960" height="540" fill="${background}"/><path d="M0 242H960V540H0z" fill="#233e49"/><path d="M0 242H960V540H0z" fill="url(#g)"/><g opacity="${Math.min(1, brightness)}">${points}</g><g fill="none" stroke="#74cbb7"><path d="M30 80V30h50M880 30h50v50M30 460v50h50M880 510h50v-50"/><path d="M465 270h30m-15-15v30" stroke-opacity=".5"/></g><g font-family="system-ui,sans-serif"><rect x="42" y="36" width="370" height="34" rx="4" fill="#102820"/><text x="54" y="59" fill="#9ee2c9" font-size="17">${title}</text><text x="42" y="100" fill="#abc7ce" font-size="14">${frame.id} · ${frame.exposureMs} ms · SYNTHETIC</text><text x="42" y="480" fill="#b9cdd2" font-size="15">${frame.capturedAt} · ${view.toUpperCase()}</text><text x="42" y="503" fill="#dcece8" font-size="16">模拟画面与几何真值 · 无真实双目设备 / 无识别模型</text>${depth ? '<rect x="702" y="72" width="200" height="12" fill="url(#depth)"/><text x="702" y="108" fill="#c3d8df" font-size="14">近 0.9 m　　远 1.4 m</text>' : ""}</g></svg>`;
}

/** Bounded, deterministic image channel, independent of motion-command delivery. */
export class StereoSimulator {
  constructor({
    now = () => performance.now(),
    wallNow = () => new Date().toISOString(),
  } = {}) {
    this.now = now;
    this.wallNow = wallNow;
    this.streaming = true;
    this.exposureMs = 8;
    this.lastFrameAt = -Infinity;
    this.sequence = 0;
    this.frames = new Map();
    this.latest = null;
  }

  available(camera) {
    return Boolean(camera?.connected && !camera.fault);
  }

  nextFrame() {
    this.lastFrameAt = this.now();
    const id = `stereo-${++this.sequence}`;
    const frame = {
      id,
      capturedAt: this.wallNow(),
      exposureMs: this.exposureMs,
      detections: OBJECTS.map(detection),
    };
    frame.images = Object.fromEntries(
      ["left", "right", "depth"].map((view) => [view, svgFrame(frame, view)]),
    );
    this.frames.set(id, frame);
    this.latest = frame;
    while (this.frames.size > FRAME_CACHE_SIZE)
      this.frames.delete(this.frames.keys().next().value);
    return frame;
  }

  current(camera) {
    if (!this.available(camera)) return null;
    if (
      !this.latest ||
      (this.streaming && this.now() - this.lastFrameAt >= FRAME_INTERVAL_MS)
    )
      this.nextFrame();
    return this.latest;
  }

  metadata(camera) {
    const frame = this.current(camera);
    const available = this.available(camera);
    const status = available
      ? this.streaming
        ? "streaming"
        : "paused"
      : "offline";
    return {
      mode: "simulation",
      deviceId: "camera-1",
      available,
      status,
      streaming: available && this.streaming,
      frameId: frame?.id ?? null,
      capturedAt: frame?.capturedAt ?? null,
      updatedAt: this.wallNow(),
      fpsLimit: 2,
      exposureMs: this.exposureMs,
      // Paused frames keep their original exposure even if the next capture's
      // setting is changed through the control endpoint.
      frameExposureMs: frame?.exposureMs ?? null,
      calibration: {
        status: "simulated",
        ...clone(SENSOR),
        robotTransform: null,
        message: "合成针孔参数，仅供模拟；未执行真机标定。",
      },
      coordinateFrame: "camera: X right, Y down, Z forward; depth in mm",
      depthSource: "synthetic-ground-truth",
      synchronization: {
        status: available
          ? this.streaming
            ? "synchronized"
            : "paused"
          : "unavailable",
        frameId: frame?.id ?? null,
        skewMs: available ? 0 : null,
        source: "synthetic-shared-frame",
      },
      frames: frame
        ? Object.fromEntries(
            ["left", "right", "depth"].map((view) => [
              view,
              `/api/camera/${view}.svg?frameId=${frame.id}`,
            ]),
          )
        : null,
      detections: frame ? clone(frame.detections) : [],
      mount: { deviceId: "ptz-1", status: "reserved", configured: false },
    };
  }

  control(input, camera) {
    if (!["pause", "resume", "set-exposure"].includes(input?.action))
      throw protocolError("INVALID_VISION_ACTION", "未知双目相机操作");
    if (
      input.exposureMs !== undefined &&
      (typeof input.exposureMs !== "number" ||
        !Number.isFinite(input.exposureMs) ||
        input.exposureMs < 0.1 ||
        input.exposureMs > 50)
    )
      throw protocolError("OUT_OF_RANGE", "模拟曝光时间范围为 0.1–50 毫秒");
    if (input.action === "set-exposure" && input.exposureMs === undefined)
      throw protocolError("OUT_OF_RANGE", "设置曝光必须提供 exposureMs");
    if (!this.available(camera))
      throw protocolError("CAMERA_OFFLINE", "模拟双目相机已离线或故障");
    this.current(camera);
    if (input.exposureMs !== undefined) {
      this.exposureMs = input.exposureMs;
      this.lastFrameAt = -Infinity;
    }
    if (input.action === "pause") this.streaming = false;
    if (input.action === "resume") {
      this.streaming = true;
      this.lastFrameAt = -Infinity;
    }
    return this.metadata(camera);
  }

  image(view, frameId, camera) {
    if (!this.available(camera))
      throw protocolError("CAMERA_OFFLINE", "模拟双目相机已离线或故障");
    if (!["left", "right", "depth"].includes(view))
      throw protocolError("FRAME_NOT_FOUND", "未知图像通道");
    const frame = frameId ? this.frames.get(frameId) : this.current(camera);
    if (!frame) {
      const sequence = /^stereo-(\d+)$/.exec(frameId ?? "");
      if (
        sequence &&
        Number.isSafeInteger(Number(sequence[1])) &&
        Number(sequence[1]) > 0 &&
        Number(sequence[1]) <= this.sequence
      )
        throw protocolError(
          "FRAME_EXPIRED",
          "该双目帧已从有界缓存淘汰，请请求新的成对帧",
        );
      throw protocolError("FRAME_NOT_FOUND", "双目帧不存在");
    }
    return {
      svg: frame.images[view],
      frameId: frame.id,
      capturedAt: frame.capturedAt,
    };
  }
}
