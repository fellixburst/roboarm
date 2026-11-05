const $ = (selector) => document.querySelector(selector);
let world3d;
import("./scene3d.js")
  .then(({ createWorld }) => {
    world3d = createWorld();
    if (state.snapshot) world3d.update(state.snapshot);
  })
  .catch(() => {
    document.querySelector("#world-message").textContent =
      "3D 场景不可用，请使用下方二维反馈；设备控制不受影响。";
  });
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const deviceNames = {
  "arm-1": "SO101 机械臂",
  "car-1": "移动小车",
  "camera-1": "模拟相机",
};
const actionNames = {
  acquire: "获取控制权",
  enable: "启用设备",
  stop: "停止设备",
  release: "释放控制权",
  jog: "关节点动",
  "cartesian-jog": "坐标点动",
  grip: "夹爪操作",
  drive: "方向控制",
};
const eventNames = {
  SERVICE_STARTED: "模拟服务启动",
  SESSION_CREATED: "建立控制会话",
  SESSION_CLOSED: "关闭控制会话",
  SESSION_EXPIRED: "控制会话过期",
  SERVICE_LEASE_EXPIRED: "服务端租约过期",
  DEVICE_DISCONNECTED: "模拟设备断线",
  DEVICE_FAULT: "模拟设备故障",
  SIMULATION_INJECTED: "模拟异常注入",
  DUPLICATE: "重复命令已忽略",
  COMMAND_LIMIT: "会话命令数达上限",
  LEASE_EXPIRED: "设备控制租约过期",
  DEADMAN_TIMEOUT: "运动指令超时",
  DEVICE_RECONNECTED: "模拟设备重连",
  FAULT_CLEARED: "模拟故障清除",
  DEVICE_STOPPED: "模拟设备已停止",
};
const statusNames = {
  received: "已接收",
  rejected: "已拒绝",
  executing: "执行中",
  completed: "已完成",
  failed: "失败",
};
const state = {
  session: null,
  sequence: 0,
  selected: "arm-1",
  armMode: "joint",
  cameraView: "left",
  vision: null,
  visionReceivedAt: 0,
  visionBusy: false,
  visionControlBusy: false,
  ptz: null,
  snapshot: null,
  receivedAt: 0,
  connected: false,
  connecting: false,
  polling: false,
  heartbeatBusy: false,
  timing: { heartbeatMs: 250, stateStaleMs: 1500 },
  hold: null,
  holdTimer: null,
  driving: false,
  pendingStop: new Set(),
  expiredToken: null,
};
let toastTimer;
function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 3500);
}
function time(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString("zh-CN", {
        hour12: false,
        timeZone: "Asia/Shanghai",
      });
}
function faultText(device) {
  return typeof device?.fault === "object"
    ? device.fault?.message
    : device?.fault;
}
function selectedDevice() {
  return state.snapshot?.devices?.find(
    (device) => device.id === state.selected,
  );
}
function snapshotAge() {
  return state.receivedAt ? performance.now() - state.receivedAt : Infinity;
}
function stale() {
  return !state.connected || snapshotAge() > state.timing.stateStaleMs;
}
function isFresh(device) {
  if (!device || stale() || !device.connected) return false;
  const serverNow = Date.parse(state.snapshot.updatedAt);
  const deviceTime = Date.parse(device.lastSeenAt ?? device.updatedAt);
  const deviceAge = serverNow - deviceTime;
  return (
    Number.isFinite(deviceAge) &&
    deviceAge >= 0 &&
    deviceAge + snapshotAge() <= state.timing.stateStaleMs
  );
}
function canMove(device = selectedDevice()) {
  return Boolean(
    state.session &&
      device?.owned &&
      device.enabled &&
      isFresh(device) &&
      !device.fault &&
      !state.pendingStop.has(device.id),
  );
}
async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1100);
  try {
    const response = await fetch(path, {
      cache: "no-store",
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(state.session ? { "X-Session-Id": state.session.sessionId } : {}),
        ...options.headers,
      },
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(
        data.error?.message ??
          data.command?.message ??
          `请求被拒绝 (${response.status})`,
      );
      error.code = data.error?.code ?? data.command?.code;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}
function clearHold() {
  state.hold = null;
  clearTimeout(state.holdTimer);
  state.holdTimer = null;
  $$(".direction").forEach((button) => button.classList.remove("pressed"));
}
function connectionLost(
  message = "控制服务连接已中断，设备将由独立看门狗停止。",
) {
  clearHold();
  state.connected = false;
  state.session = null;
  state.expiredToken = null;
  state.pendingStop.clear();
  $("#connection-banner").textContent =
    `${message} 重连后不会恢复运动，请重新获取控制权并启用。`;
  $("#connection-banner").hidden = false;
  renderFreshness();
  renderControls();
}
async function connect() {
  if (state.connecting || state.session) return;
  state.connecting = true;
  try {
    const session = await request("/api/sessions", {
      method: "POST",
      body: "{}",
    });
    state.session = session;
    state.sequence = 0;
    state.timing = { ...state.timing, ...session.timing };
    state.expiredToken = session.clock?.token;
    state.connected = true;
    $("#session-label").textContent = session.label ?? "本浏览器会话";
    $("#connection-banner").hidden = true;
    await pollState();
  } catch {
    connectionLost("暂时无法连接控制服务。");
  } finally {
    state.connecting = false;
    renderControls();
  }
}
async function heartbeat() {
  if (!state.session || state.heartbeatBusy) return;
  state.heartbeatBusy = true;
  const session = state.session;
  try {
    const updated = await request(
      `/api/sessions/${encodeURIComponent(session.sessionId)}/heartbeat`,
      { method: "POST", body: "{}" },
    );
    if (state.session === session) {
      state.session = { ...session, ...updated };
      state.timing = { ...state.timing, ...updated.timing };
    }
  } catch {
    if (state.session?.sessionId === session.sessionId)
      connectionLost("控制会话已失效。");
  } finally {
    state.heartbeatBusy = false;
  }
}
function commandEnvelope(
  action,
  params = {},
  deviceId = state.selected,
  overrides = {},
) {
  return {
    version: 1,
    deviceId,
    sessionId: state.session?.sessionId,
    commandId: crypto.randomUUID(),
    sequence: ++state.sequence,
    clockToken: state.session?.clock?.token,
    ttlMs: 1000,
    action,
    params,
    ...overrides,
  };
}
async function sendCommand(
  action,
  params = {},
  deviceId = state.selected,
  options = {},
) {
  if (!state.session) {
    if (!options.quiet) toast("请等待控制服务重新连接。", true);
    return null;
  }
  const sessionId = state.session.sessionId;
  try {
    const result = await request("/api/commands", {
      method: "POST",
      body: JSON.stringify(
        commandEnvelope(action, params, deviceId, options.envelope),
      ),
    });
    if (!options.quiet && action !== "drive")
      toast(
        `${actionNames[action]} · ${statusNames[result.command?.status] ?? "已提交"}`,
      );
    if (action === "enable") state.pendingStop.delete(deviceId);
    void pollState();
    return result.command;
  } catch (error) {
    if (
      error.code === "SESSION_EXPIRED" ||
      error.code === "INVALID_SESSION" ||
      error.code === "OLD_SESSION"
    ) {
      if (state.session?.sessionId === sessionId)
        connectionLost("旧会话已作废。");
    } else if (!error.data) connectionLost();
    if (!options.quiet)
      toast(`${actionNames[action] ?? action}：${error.message}`, true);
    if (action === "drive") clearHold();
    void pollState();
    return error.data?.command ?? null;
  }
}
async function stopDevice(deviceId = state.selected, quiet = false) {
  clearHold();
  state.pendingStop.add(deviceId);
  renderControls();
  return sendCommand("stop", {}, deviceId, { quiet });
}
function safetyStop() {
  clearHold();
  for (const device of state.snapshot?.devices ?? []) {
    if (device.owned && device.enabled && device.type !== "camera")
      void stopDevice(device.id, true);
  }
}
async function pollState() {
  if (state.polling) return;
  state.polling = true;
  try {
    const snapshot = await request("/api/state");
    state.snapshot = snapshot;
    world3d?.update(snapshot);
    state.receivedAt = performance.now();
    state.connected = Boolean(state.session);
    state.timing = { ...state.timing, ...snapshot.timing };
    render();
  } catch {
    if (state.session) connectionLost();
  } finally {
    state.polling = false;
  }
}
function selectDevice(deviceId) {
  if (state.selected === deviceId) return;
  if (state.hold) void stopDevice(state.selected, true);
  state.selected = deviceId;
  render();
}
function nav(section) {
  $$(".nav-item").forEach((button) =>
    button.classList.toggle("active", button.dataset.nav === section),
  );
  const labels = {
    overview: "工作台总览",
    arm: "机械臂控制",
    car: "移动小车控制",
    camera: "相机预览",
    logs: "操作日志",
  };
  $("#breadcrumb-current").textContent = labels[section] ?? labels.overview;
  if (section === "arm" || section === "car")
    selectDevice(section === "arm" ? "arm-1" : "car-1");
  const target = {
    overview: "#overview",
    arm: "#control-section",
    car: "#control-section",
    camera: "#camera-section",
    logs: "#logs-section",
  }[section];
  $(target ?? "#overview").scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
    block: "start",
  });
}
function renderFreshness() {
  const isStale = stale();
  const connection = $("#connection-state");
  connection.classList.toggle("online", !isStale && Boolean(state.session));
  connection.classList.toggle("offline", isStale);
  connection.innerHTML = `<span class="dot"></span>${isStale ? "服务失联" : "控制服务已连接"}`;
  $("#state-age").textContent = state.receivedAt
    ? isStale
      ? "状态过期 · 已失联"
      : `${Math.round(snapshotAge())} ms 前更新`
    : "等待服务状态";
  if (isStale && state.hold) safetyStop();
  const device = selectedDevice();
  if (device) {
    const fresh = isFresh(device);
    const fault = faultText(device);
    $("#device-status").className =
      `status-badge ${!fresh || fault ? "bad" : device.enabled ? "" : "stopped"}`;
    $("#device-status").innerHTML =
      `<span class="dot"></span>${!fresh ? "模拟设备失联" : fault ? "模拟设备故障" : device.enabled ? "模拟设备已启用" : "模拟在线 · 未启用"}`;
    $("#feedback-status").textContent = !fresh
      ? "反馈已过期，控制已禁用"
      : fault
        ? `模拟故障：${fault}`
        : "服务端模拟状态反馈";
    $("#feedback-dot").style.color = fresh && !fault ? "#63a394" : "#cb8272";
    $("#device-scene").classList.toggle("device-offline", !fresh);
  }
}
function renderControls() {
  const device = selectedDevice();
  const usable = Boolean(state.session && isFresh(device) && !device?.fault);
  const owned = device?.owned;
  const movingAllowed = canMove(device);
  $("#acquire-control").disabled =
    !usable || Boolean(owned) || Boolean(device?.ownerLabel);
  $("#enable-control").disabled =
    !usable ||
    !owned ||
    Boolean(device?.enabled && !state.pendingStop.has(device.id));
  $("#release-control").hidden = !owned;
  $("#stop-device").disabled = !state.session;
  $("#pad-stop").disabled = !state.session;
  $("#inject-fault").disabled = !state.session;
  const cameraAvailable = Boolean(
    state.vision?.available && state.vision?.frames && visionFresh(),
  );
  $("#capture-frame").disabled =
    !cameraAvailable || cameraImage.status !== "loaded";
  $$("[data-capture-view]").forEach((button) => {
    button.disabled = !cameraAvailable;
  });
  $("#pause-camera").disabled =
    !state.session ||
    !state.vision?.available ||
    !visionFresh() ||
    state.visionControlBusy;
  $("#camera-exposure").disabled =
    !state.session ||
    !state.vision?.available ||
    !visionFresh() ||
    state.visionControlBusy;
  $$(".motion-button").forEach((button) => {
    button.disabled = !movingAllowed;
  });
  if (!device?.endEffector || !device?.kinematics) {
    $$("[data-cartesian-axis]").forEach((button) => {
      button.disabled = true;
    });
  }
  const ownedText = owned
    ? device.enabled && !state.pendingStop.has(device.id)
      ? "控制已启用 · 请低速操作"
      : "已持有控制权 · 等待主动启用"
    : device?.ownerLabel
      ? `观察模式 · ${device.ownerLabel} 正在控制`
      : "当前处于观察模式";
  $("#access-text").textContent = stale() ? "状态失联 · 控制不可用" : ownedText;
  if (state.hold && !movingAllowed) clearHold();
}
function renderJoints(device) {
  const joints = device?.joints ?? [];
  if (!joints.length) {
    $("#joint-table").innerHTML =
      '<p class="joint-help">等待服务端关节状态与模拟限位配置。</p>';
    return;
  }
  const same =
    $("#joint-table").dataset.joints === joints.map((j) => j.id).join(",");
  if (!same) {
    $("#joint-table").dataset.joints = joints.map((j) => j.id).join(",");
    $("#joint-table").innerHTML = joints
      .map(
        (joint, index) =>
          `<div class="joint-row"><div><div class="joint-name"><small>J${index + 1}</small>${escapeHtml(joint.name)}</div><div class="joint-limits" title="模拟限位 ${joint.min}° 至 ${joint.max}°"><i id="range-${joint.id}"></i></div></div><button class="joint-button motion-button" data-jog="minus" data-joint="${joint.id}" aria-label="${escapeHtml(joint.name)} 减少" disabled>−</button><output class="joint-value" id="value-${joint.id}">—°</output><button class="joint-button motion-button" data-jog="plus" data-joint="${joint.id}" ${index === 0 ? 'data-testid="joint-jog-plus"' : ""} aria-label="${escapeHtml(joint.name)} 增加" disabled>+</button></div>`,
      )
      .join("");
  }
  joints.forEach((joint) => {
    $(`#value-${joint.id}`).textContent =
      `${Number(joint.position).toFixed(1)}°`;
    const range = Math.max(
      0,
      Math.min(
        100,
        ((joint.position - joint.min) / (joint.max - joint.min)) * 100,
      ),
    );
    $(`#range-${joint.id}`).style.width = `${range}%`;
  });
}
function render() {
  const snapshot = state.snapshot;
  const device = selectedDevice();
  if (!snapshot) {
    renderFreshness();
    renderControls();
    return;
  }
  const devices = snapshot.devices ?? [];
  const online = devices.filter(isFresh).length;
  $("#online-count").textContent = online;
  $("#overview-online").textContent = stale()
    ? "反馈失联"
    : `${online} 个模拟连接`;
  $("#ownership-summary").textContent = devices.some((d) => d.owned)
    ? "已获取控制权"
    : "观察模式";
  $("#command-count").textContent = (snapshot.commands ?? []).length;
  $("#updated-time").textContent = time(snapshot.updatedAt);
  const latestCommand = [...(snapshot.commands ?? [])].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  )[0];
  $("#last-command-status").textContent = latestCommand
    ? `${actionNames[latestCommand.action] ?? latestCommand.action} · ${statusNames[latestCommand.status] ?? latestCommand.status}`
    : "尚未发送命令";
  $$(".device-tab").forEach((tab) => {
    const active = tab.dataset.device === state.selected;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  for (const [type, id] of [
    ["arm", "arm-1"],
    ["car", "car-1"],
  ]) {
    const d = devices.find((item) => item.id === id);
    $(`#${type}-nav-dot`).style.background = isFresh(d) ? "#55b7a1" : "#c47765";
  }
  $("#arm-controls").hidden = state.selected !== "arm-1";
  $("#car-controls").hidden = state.selected !== "car-1";
  $("#end-effector-strip").hidden = state.selected !== "arm-1";
  $("#joint-controls").hidden = state.armMode !== "joint";
  $("#cartesian-controls").hidden = state.armMode !== "cartesian";
  $$("[data-arm-mode]").forEach((button) => {
    const active = button.dataset.armMode === state.armMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#stage-device-title").textContent = deviceNames[state.selected];
  $("#fault-device-name").textContent = deviceNames[state.selected];
  $("#stage-device-subtitle").textContent =
    state.selected === "arm-1"
      ? "简化五关节模拟模型 · 非 SO101 标定"
      : "差速底盘 · 按住运行 · 松手停止";
  if (device) {
    $("#metric-enabled").textContent =
      device.enabled && !state.pendingStop.has(device.id) ? "已启用" : "未启用";
    $("#metric-owner").textContent = device.owned
      ? "当前会话"
      : (device.ownerLabel ?? "未分配");
    const reason = {
      STOP_COMMAND: "软件停止",
      DEADMAN_TIMEOUT: "运动指令超时",
      LEASE_EXPIRED: "控制租约过期",
      SESSION_EXPIRED: "会话已过期",
      DISCONNECTED: "设备断线",
      FAULT: "设备故障",
      RELEASED: "控制权已释放",
    };
    $("#metric-protection").textContent =
      faultText(device) ??
      reason[device.stopReason] ??
      (device.stopReason
        ? String(device.stopReason).replaceAll("_", " ")
        : "看门狗监视中");
    $("#device-updated").textContent =
      `状态时间 ${time(device.updatedAt ?? snapshot.updatedAt)}`;
    if (state.selected === "arm-1") {
      renderJoints(device);
      for (const axis of ["x", "y", "z"]) {
        const value = device.endEffector?.[`${axis}Mm`];
        $(`#end-effector-${axis}`).textContent = Number.isFinite(value)
          ? value.toFixed(2)
          : "—";
      }
      $("#grip-position").textContent =
        `${Number(device.gripper?.position ?? 0).toFixed(0)}%`;
    }
    if (state.selected === "car-1") {
      $("#linear-velocity").innerHTML =
        `${Number(device.velocity?.linear ?? 0).toFixed(2)} <small>m/s</small>`;
      $("#angular-velocity").innerHTML =
        `${Number(device.velocity?.angular ?? 0).toFixed(2)} <small>rad/s</small>`;
    }
  }
  renderScene(device);
  renderLogs();
  renderFreshness();
  renderControls();
}
function renderScene(device) {
  const scene = $("#device-scene");
  const grid = `<defs><linearGradient id="metal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#dae9e7"/><stop offset=".5" stop-color="#9dbcb9"/><stop offset="1" stop-color="#5e8a8c"/></linearGradient><linearGradient id="darkMetal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#4d7980"/><stop offset="1" stop-color="#234853"/></linearGradient><linearGradient id="accent" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#58c6ab"/><stop offset="1" stop-color="#238c79"/></linearGradient><radialGradient id="glow"><stop stop-color="#63d0b2" stop-opacity=".12"/><stop offset="1" stop-color="#63d0b2" stop-opacity="0"/></radialGradient><filter id="shadow"><feGaussianBlur stdDeviation="8"/></filter></defs><ellipse cx="380" cy="283" rx="270" ry="93" fill="url(#glow)"/><g stroke="#3b626b" stroke-width=".65" opacity=".5">${Array.from({ length: 15 }, (_, i) => `<path d="M${20 + i * 47} 390L${275 + i * 15} 171"/><path d="M${40 + i * 18} ${190 + i * 12}L${720 - i * 18} ${190 + i * 12}"/>`).join("")}</g><path d="M141 337L629 337" stroke="#638c8e" stroke-opacity=".25"/><path d="M380 171V390" stroke="#5e8d88" stroke-opacity=".3" stroke-dasharray="4 5"/>`;
  if (!device) {
    scene.innerHTML = `${grid}<text x="380" y="210" text-anchor="middle" class="stage-empty">等待模拟设备反馈</text>`;
    return;
  }
  if (device.type === "arm") {
    const chain = device.linkPointsMm;
    if (!Array.isArray(chain) || chain.length < 5) {
      scene.innerHTML = `${grid}<text x="380" y="210" text-anchor="middle" class="stage-empty">等待模拟正向运动学反馈</text>`;
      $("#stage-coordinates").textContent = "等待基座坐标系反馈";
      return;
    }
    // One fixed linear projection for every link, tool point and coordinate axis.
    // Cartesian straight lines remain straight in this projection.
    const project = ({ xMm, yMm, zMm }) => [
      300 + xMm * 0.9 - yMm * 0.6,
      320 + xMm * 0.22 + yMm * 0.22 - zMm * 0.86,
    ];
    const points = chain.map(project);
    const [base, shoulder, elbow, wrist, tool] = points;
    const p = (point) => point.map((value) => value.toFixed(2)).join(",");
    const segments = [
      [shoulder, elbow, 25],
      [elbow, wrist, 21],
      [wrist, tool, 17],
    ];
    const grip = (Number(device.gripper?.position ?? 50) / 100) * 11 + 3;
    const toolAngle =
      (Math.atan2(tool[1] - wrist[1], tool[0] - wrist[0]) * 180) / Math.PI;
    const axes = [
      { point: { xMm: 65, yMm: 0, zMm: 0 }, color: "#c58b7c", label: "+X 前" },
      { point: { xMm: 0, yMm: 65, zMm: 0 }, color: "#78bba1", label: "+Y 左" },
      { point: { xMm: 0, yMm: 0, zMm: 65 }, color: "#83aacc", label: "+Z 上" },
    ];
    const axisSvg = axes
      .map(({ point, color, label }) => {
        const end = project(point);
        return `<path d="M${p(base)}L${p(end)}" stroke="${color}" stroke-width="1.2"/><circle cx="${end[0]}" cy="${end[1]}" r="2" fill="${color}"/><text x="${end[0] + 5}" y="${end[1] - 5}" fill="${color}" font-size="8">${label}</text>`;
      })
      .join("");
    const modelLabel = `<g fill="#6c9ca4" font-size="7" font-family="monospace"><path d="M${elbow[0] - 17} ${elbow[1]}h-43l-20-16" fill="none" stroke="#638d95" stroke-width=".6"/><text x="${elbow[0] - 105}" y="${elbow[1] - 21}">JOINT 02</text><path d="M${tool[0] + 12} ${tool[1]}h36l16-18" fill="none" stroke="#638d95" stroke-width=".6"/><text x="${tool[0] + 48}" y="${tool[1] - 26}">TCP / BASE</text></g>`;
    scene.innerHTML = `${grid}<ellipse cx="${base[0] + 10}" cy="${base[1] + 9}" rx="100" ry="20" fill="#061c23" opacity=".5" filter="url(#shadow)"/><path d="M${base[0] - 51} ${base[1]}l48 17 62-20-49-16z" fill="#41636b" stroke="#789592"/><path d="M${base[0] - 51} ${base[1]}v8l48 17v-8m0 8 62-20v-8" fill="#234852" stroke="#456d72"/><path d="M${p(base)}L${p(shoulder)}" stroke="url(#darkMetal)" stroke-width="31" stroke-linecap="round"/><path d="M${base[0] - 14} ${base[1] - 5}L${shoulder[0] - 14} ${shoulder[1] + 6}" stroke="#749c9c" stroke-width="2" opacity=".5"/>${segments.map(([a, b, width]) => `<path d="M${p(a)}L${p(b)}" fill="none" stroke="#193d48" stroke-width="${width + 6}" stroke-linecap="round"/><path d="M${p(a)}L${p(b)}" fill="none" stroke="url(#metal)" stroke-width="${width}" stroke-linecap="round"/>`).join("")}${[shoulder, elbow, wrist].map((point, i) => `<circle cx="${point[0]}" cy="${point[1]}" r="${19 - i * 3}" fill="url(#darkMetal)" stroke="#a0c5bf" stroke-width="1.3"/><circle cx="${point[0]}" cy="${point[1]}" r="${11 - i * 2}" fill="url(#accent)" stroke="#90d9c6" stroke-width=".8"/><circle cx="${point[0]}" cy="${point[1]}" r="3" fill="#216d65"/>`).join("")}<g transform="translate(${tool[0]} ${tool[1]}) rotate(${toolAngle})"><rect x="-5" y="-9" width="15" height="18" rx="3" fill="url(#metal)"/><path d="M6 -6L21 ${-grip} 30 ${-grip + 2}M6 6L21 ${grip} 30 ${grip - 2}" fill="none" stroke="#91b4af" stroke-width="5" stroke-linejoin="round"/></g><circle cx="${tool[0]}" cy="${tool[1]}" r="3" fill="#c5f4df" stroke="#4bbf9e"/><g font-family="sans-serif">${axisSvg}</g>${modelLabel}`;
    scene.setAttribute(
      "aria-label",
      "简化模拟机械臂的真实 FK 链与基座 XYZ 坐标投影，非 SO101 标定",
    );
    const eef = device.endEffector;
    $("#stage-coordinates").innerHTML = eef
      ? `BASE / TCP · mm<br>X ${eef.xMm.toFixed(2)} / Y ${eef.yMm.toFixed(2)} / Z ${eef.zMm.toFixed(2)}<br>SIMPLIFIED MODEL · 非 SO101 标定`
      : "等待末端坐标反馈";
  } else {
    const x = Number(device.pose?.x ?? 0),
      y = Number(device.pose?.y ?? 0),
      heading = Number(device.pose?.heading ?? 0),
      angle = (heading * 180) / Math.PI;
    const sx = 380 + Math.sin(x) * 60,
      sy = 259 + Math.sin(y) * 23;
    scene.innerHTML = `${grid}<g stroke="#3d817b" stroke-width="1" fill="none" opacity=".4"><ellipse cx="380" cy="276" rx="152" ry="62" stroke-dasharray="4 6"/><ellipse cx="380" cy="276" rx="210" ry="87" stroke-dasharray="2 8"/></g><ellipse cx="${sx}" cy="${sy + 51}" rx="91" ry="23" fill="#071e26" opacity=".5" filter="url(#shadow)"/><g transform="translate(${sx} ${sy}) rotate(${angle})"><g fill="#18313b" stroke="#567d85" stroke-width="2"><rect x="-74" y="-43" width="25" height="37" rx="6"/><rect x="49" y="-43" width="25" height="37" rx="6"/><rect x="-74" y="10" width="25" height="37" rx="6"/><rect x="49" y="10" width="25" height="37" rx="6"/></g><path d="M-54 -52Q0 -69 54-52V45Q0 68-54 45z" fill="url(#darkMetal)" stroke="#8db5b1" stroke-width="1.5"/><path d="M-45 -43Q0 -57 45-43V33Q0 48-45 33z" fill="url(#metal)" stroke="#b1d5cb" stroke-width="1"/><rect x="-29" y="-19" width="58" height="43" rx="7" fill="#2a5b60" stroke="#5b9b92"/><rect x="-21" y="-11" width="42" height="26" rx="4" fill="#366f6d"/><path d="M-12 -1h24M-12 5h24" stroke="#7eb6a2" stroke-width="2"/><path d="M-24 -37h48" stroke="#73d6b6" stroke-width="4" stroke-linecap="round"/><circle cx="-34" cy="30" r="3" fill="#78c5ad"/><circle cx="34" cy="30" r="3" fill="#78c5ad"/><path d="M0 -80v-30m-7 8l7-8 7 8" stroke="#7bb9ac" fill="none" stroke-width="2"/></g><g fill="#6d9da5" font-size="8" font-family="monospace"><path d="M${sx + 90} ${sy - 20}h53l16-17" fill="none" stroke="#648e97" stroke-width=".7"/><text x="${sx + 118}" y="${sy - 44}">ROVER / SIM</text></g>`;
    scene.setAttribute("aria-label", "小车的服务端模拟位姿");
    $("#stage-coordinates").innerHTML =
      `X ${x.toFixed(3)} m / Y ${y.toFixed(3)} m<br>HEADING ${heading.toFixed(3)} rad`;
  }
}
function renderLogs() {
  const commands = state.snapshot?.commands ?? [],
    logs = state.snapshot?.logs ?? [];
  const filter = $("#log-filter").value;
  let rows = commands.map((command) => ({
    at: command.updatedAt ?? command.receivedAt,
    deviceId: command.deviceId,
    title: actionNames[command.action] ?? command.action,
    status: command.status,
    message: command.message ?? command.code ?? "",
    transitions: command.transitions,
    commandId: command.commandId,
    code: command.code,
    kind: "command",
  }));
  if (filter !== "commands")
    rows.push(
      ...logs
        .filter((log) => !log.commandId)
        .map((log) => ({
          ...log,
          title: eventNames[log.event] ?? log.event ?? "设备事件",
          status:
            log.level === "error"
              ? "failed"
              : log.level === "warn"
                ? "rejected"
                : "completed",
          kind: "event",
        })),
    );
  if (filter === "errors")
    rows = rows.filter((row) => ["rejected", "failed"].includes(row.status));
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  rows = rows.slice(0, 60);
  $("#nav-log-count").textContent = String(commands.length + logs.length);
  $("#log-count").textContent = String(rows.length);
  $("#log-rows").innerHTML = rows.length
    ? rows
        .map((row) => {
          const transitions = (row.transitions ?? [])
            .map(
              (transition) =>
                statusNames[transition.status] ?? transition.status,
            )
            .join(" → ");
          const details = [row.message, transitions, row.code]
            .filter(Boolean)
            .join(" · ");
          return `<tr ${row.commandId ? `data-command-id="${escapeHtml(row.commandId)}"` : ""}><td>${escapeHtml(time(row.at))}</td><td>${escapeHtml(deviceNames[row.deviceId] ?? "控制服务")}</td><td>${escapeHtml(row.title)}</td><td><span class="log-state ${escapeHtml(row.status)}"><span class="dot"></span>${escapeHtml(row.kind === "event" ? "设备事件" : (statusNames[row.status] ?? row.status))}</span></td><td title="${escapeHtml(row.commandId ?? "")}">${escapeHtml(details)}</td></tr>`;
        })
        .join("")
    : '<tr><td colspan="5" class="empty-state">暂无符合条件的事件。获取控制权后，即可开始模拟操作。</td></tr>';
}
async function driveLoop(intent) {
  if (state.hold !== intent || !canMove() || state.driving) return;
  state.driving = true;
  const speed = Number($("#drive-speed").value);
  const maxAngular = selectedDevice()?.limits?.maxAngular ?? 0.8;
  const params = { linear: 0, angular: 0 };
  if (intent.direction === "forward") params.linear = speed;
  if (intent.direction === "backward") params.linear = -speed;
  if (intent.direction === "left") params.angular = Math.min(maxAngular, 0.5);
  if (intent.direction === "right") params.angular = -Math.min(maxAngular, 0.5);
  try {
    await sendCommand("drive", params, "car-1", { quiet: true });
  } finally {
    state.driving = false;
    if (state.hold === intent && canMove())
      state.holdTimer = setTimeout(() => void driveLoop(intent), 110);
  }
}
function startDrive(direction, button) {
  if (state.selected !== "car-1" || !canMove() || state.hold) return;
  const intent = { direction };
  state.hold = intent;
  button?.classList.add("pressed");
  void driveLoop(intent);
}
function endDrive() {
  if (!state.hold) return;
  clearHold();
  void stopDevice("car-1", true);
}
$$(".device-tab").forEach((tab) =>
  tab.addEventListener("click", () => selectDevice(tab.dataset.device)),
);
$$(".nav-item").forEach((button) =>
  button.addEventListener("click", () => nav(button.dataset.nav)),
);
$(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  nav("overview");
});
$("#acquire-control").addEventListener(
  "click",
  () => void sendCommand("acquire"),
);
$("#enable-control").addEventListener(
  "click",
  () => void sendCommand("enable"),
);
$("#release-control").addEventListener("click", () => {
  clearHold();
  state.pendingStop.add(state.selected);
  void sendCommand("release");
});
$("#stop-device").addEventListener("click", () => void stopDevice());
$("#pad-stop").addEventListener("click", () => void stopDevice("car-1"));
$("#joint-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-jog]");
  if (!button || button.disabled || !canMove()) return;
  const step = Number($("#jog-step").value),
    joint = selectedDevice()?.joints?.find(
      (item) => item.id === button.dataset.joint,
    );
  void sendCommand("jog", {
    jointId: button.dataset.joint,
    delta: button.dataset.jog === "plus" ? step : -step,
    speed: Math.min(15, joint?.maxSpeed ?? 15),
  });
});
$$("[data-arm-mode]").forEach((button) =>
  button.addEventListener("click", () => {
    state.armMode = button.dataset.armMode;
    render();
  }),
);
$$("[data-cartesian-axis]").forEach((button) =>
  button.addEventListener("click", () => {
    if (button.disabled || state.selected !== "arm-1" || !canMove()) return;
    const step = Number($("#cartesian-step").value);
    void sendCommand("cartesian-jog", {
      frame: "base",
      axis: button.dataset.cartesianAxis,
      deltaMm: button.dataset.cartesianDirection === "plus" ? step : -step,
      speedMmS: Number($("#cartesian-speed").value),
    });
  }),
);
$("#jog-step").addEventListener("input", () => {
  $("#jog-step-value").textContent = `${$("#jog-step").value}°`;
});
$("#drive-speed").addEventListener("input", () => {
  $("#drive-speed-value").textContent =
    `${Number($("#drive-speed").value).toFixed(2)} m/s`;
});
$("#grip-open").addEventListener(
  "click",
  () => void sendCommand("grip", { position: 100 }),
);
$("#grip-close").addEventListener(
  "click",
  () => void sendCommand("grip", { position: 0 }),
);
$$(".direction").forEach((button) => {
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || button.disabled) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    startDrive(button.dataset.direction, button);
  });
  for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"])
    button.addEventListener(eventName, endDrive);
  button.addEventListener("keydown", (event) => {
    if ([" ", "Enter"].includes(event.key)) {
      event.preventDefault();
      if (!event.repeat) startDrive(button.dataset.direction, button);
    }
  });
  button.addEventListener("keyup", (event) => {
    if ([" ", "Enter"].includes(event.key)) {
      event.preventDefault();
      endDrive();
    }
  });
});
window.addEventListener("pointerup", endDrive);
window.addEventListener("pointercancel", endDrive);
const keyDirection = {
  ArrowUp: "forward",
  ArrowDown: "backward",
  ArrowLeft: "left",
  ArrowRight: "right",
};
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    void stopDevice();
    return;
  }
  if (
    !keyDirection[event.key] ||
    state.selected !== "car-1" ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)
  )
    return;
  event.preventDefault();
  if (!event.repeat)
    startDrive(
      keyDirection[event.key],
      $(`[data-direction="${keyDirection[event.key]}"]`),
    );
});
window.addEventListener("keyup", (event) => {
  if (
    keyDirection[event.key] &&
    state.hold?.direction === keyDirection[event.key]
  ) {
    event.preventDefault();
    endDrive();
  }
});
window.addEventListener("blur", safetyStop);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) safetyStop();
});
window.addEventListener("pagehide", () => {
  clearHold();
  const session = state.session;
  if (!session) return;
  for (const device of state.snapshot?.devices ?? [])
    if (device.owned && device.type !== "camera")
      void fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(commandEnvelope("stop", {}, device.id)),
        keepalive: true,
      }).catch(() => {});
  void fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => {});
  state.session = null;
});
$("#reconnect").addEventListener("click", async () => {
  safetyStop();
  const old = state.session;
  state.session = null;
  clearHold();
  if (old)
    try {
      await request(`/api/sessions/${encodeURIComponent(old.sessionId)}`, {
        method: "DELETE",
      });
    } catch {}
  connectionLost("正在建立新的控制会话。");
  await connect();
  toast("已重新建立模拟会话，请重新获取控制权。");
});
$("#inject-fault").addEventListener("click", async () => {
  if (!state.session) return;
  clearHold();
  const type = $("#fault-type").value;
  $("#diagnostic-result").classList.remove("error");
  try {
    if (type === "expire-command") {
      const token = state.session.clock?.token;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const command = await sendCommand(
        state.selected === "car-1" ? "drive" : "jog",
        state.selected === "car-1"
          ? { linear: 0.1, angular: 0 }
          : { jointId: "joint-1", delta: 1, speed: 10 },
        state.selected,
        { quiet: true, envelope: { clockToken: token, ttlMs: 1 } },
      );
      const rejected = command?.status === "rejected";
      $("#diagnostic-result").textContent =
        `过期命令：${command?.code ?? statusNames[command?.status] ?? "请查看操作日志"}${rejected ? " · 未执行运动" : ""}`;
      $("#diagnostic-result").classList.toggle("error", !rejected);
      toast(
        rejected ? "过期命令已被服务端拒绝。" : "请查看服务端命令反馈。",
        !rejected,
      );
    } else {
      await request("/api/simulate", {
        method: "POST",
        body: JSON.stringify({
          sessionId: state.session.sessionId,
          deviceId: state.selected,
          type,
        }),
      });
      $("#diagnostic-result").textContent =
        `已执行：${$("#fault-type").selectedOptions[0].textContent}，以服务端状态和日志为准。`;
      toast("模拟异常已注入。恢复后需重新获取控制权并启用。");
    }
    await pollState();
  } catch (error) {
    $("#diagnostic-result").textContent = error.message;
    $("#diagnostic-result").classList.add("error");
    toast(error.message, true);
  }
});
$("#log-filter").addEventListener("change", renderLogs);
const cameraImage = { requestedUrl: null, displayedUrl: null, status: "empty" };
function visionFresh() {
  return Boolean(
    state.visionReceivedAt && performance.now() - state.visionReceivedAt < 1800,
  );
}
function cameraFrameUrl(view = state.cameraView) {
  return state.vision?.frames?.[view] ?? null;
}
function updateCameraImage() {
  const image = $("#camera-image"),
    url = cameraFrameUrl();
  if (!url || !visionFresh()) return;
  const fullUrl = new URL(url, location.origin).href;
  if (cameraImage.requestedUrl === fullUrl) return;
  cameraImage.requestedUrl = fullUrl;
  cameraImage.status = "loading";
  image.hidden = true;
  image.src = url;
}
function renderVision() {
  const vision = state.vision,
    fresh = visionFresh();
  const available = Boolean(vision?.available && fresh);
  const paused = vision?.status === "paused";
  const viewLabels = { left: "左目", right: "右目", depth: "深度" };
  if (available) updateCameraImage();
  $("#camera-view-label").textContent =
    `${state.cameraView.toUpperCase()} / SIMULATED`;
  $("#camera-image").alt =
    `${viewLabels[state.cameraView]}模拟画面，非真实硬件图像`;
  $$("[data-camera-view]").forEach((button) => {
    const active = button.dataset.cameraView === state.cameraView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#camera-state").textContent = !fresh
    ? "视觉通道失联"
    : !available
      ? "模拟相机离线"
      : cameraImage.status === "error"
        ? "图像不可用或已过期"
        : cameraImage.status !== "loaded"
          ? paused
            ? "冻结帧加载中"
            : "同步帧加载中"
          : paused
            ? "模拟画面已暂停 · 冻结帧"
            : "双目模拟画面";
  $("#vision-frame-id").textContent = available
    ? `${vision.frameId}${cameraImage.status === "loaded" ? "" : " · 待显示"} · ${time(vision.capturedAt ?? vision.updatedAt)}`
    : "无有效同步帧";
  $("#pause-camera").textContent = paused ? "恢复" : "暂停";
  const sync = $("#vision-sync");
  sync.textContent = !available
    ? "同步不可用"
    : paused
      ? "左右同帧 · 已冻结"
      : `左右同帧 · 偏差 ${Number(vision.synchronization?.skewMs ?? 0).toFixed(1)} ms`;
  sync.classList.toggle("unavailable", !available);
  const calibration = vision?.calibration;
  $("#vision-calibration").textContent =
    calibration?.status === "simulated"
      ? "模拟标定参数 · 非真机标定"
      : "尚无有效标定";
  $("#vision-parameters").textContent = calibration
    ? `模拟基线 ${calibration.baselineMm} mm · 焦距 ${calibration.focalLengthPx} px · 帧曝光 ${Number(vision.frameExposureMs ?? vision.exposureMs).toFixed(1)} ms · 外参未配置`
    : "仅模拟参数，无摄像头访问";
  if (document.activeElement !== $("#camera-exposure")) {
    $("#camera-exposure").value = vision?.exposureMs ?? 8;
    $("#camera-exposure-value").textContent =
      `${Number(vision?.exposureMs ?? 8).toFixed(1)} ms`;
  }
  const targets = available ? (vision?.detections ?? []) : [];
  $("#vision-targets").innerHTML = targets.length
    ? targets
        .map((target) => {
          const b = target.bbox,
            r = target.rightBbox;
          const bboxText = (box) =>
            box ? `${box.x}, ${box.y}, ${box.width}×${box.height}` : "—";
          return `<div class="vision-target" data-target-id="${escapeHtml(target.id)}"><span class="vision-target-name"><i class="target-swatch"></i>${escapeHtml(target.label)}</span><span class="vision-target-box">L [${escapeHtml(bboxText(b))}] px<br>R [${escapeHtml(bboxText(r))}] px</span><span class="vision-target-depth">${Number(target.depthMm).toFixed(0)}<small>mm</small></span></div>`;
        })
        .join("")
    : '<p class="vision-empty">暂无有效模拟目标，等待双目图像通道</p>';
  if (!available) {
    $("#camera-image").hidden = true;
  } else {
    $("#camera-image").hidden = cameraImage.status !== "loaded";
  }
  renderControls();
}
async function refreshCamera() {
  if (document.hidden || state.visionBusy) return;
  state.visionBusy = true;
  try {
    const vision = await request("/api/vision/stereo");
    state.vision = vision;
    state.visionReceivedAt = performance.now();
    renderVision();
  } catch {
    if (!visionFresh()) {
      renderVision();
    }
  } finally {
    state.visionBusy = false;
  }
}
async function controlVision(action, options = {}) {
  if (!state.session || state.visionControlBusy) return;
  state.visionControlBusy = true;
  renderControls();
  try {
    state.vision = await request("/api/vision/stereo/control", {
      method: "POST",
      body: JSON.stringify({
        sessionId: state.session.sessionId,
        action,
        ...options,
      }),
    });
    state.visionReceivedAt = performance.now();
    renderVision();
    toast(
      action === "pause"
        ? "双目图像已暂停，运动控制保持独立。"
        : action === "resume"
          ? "双目图像已恢复。"
          : "模拟曝光参数已更新。",
    );
  } catch (error) {
    toast(`图像通道：${error.message}`, true);
  } finally {
    state.visionControlBusy = false;
    renderControls();
  }
}
async function captureFrame(view = state.cameraView) {
  const url = cameraFrameUrl(view),
    frameId = state.vision?.frameId;
  if (!url || !visionFresh()) {
    toast("当前没有可抓取的同步模拟帧。", true);
    return;
  }
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("同步帧不可用或已过期，请刷新后重试");
    const blob = await response.blob(),
      downloadUrl = URL.createObjectURL(blob),
      anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `robolab-simulated-${frameId}-${view}.svg`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    $("#capture-status").textContent =
      `已保存 ${view.toUpperCase()} / ${frameId}`;
    toast("已保存对应同步帧的模拟图像。");
  } catch (error) {
    toast(error.message, true);
  }
}
$("#camera-image").addEventListener("load", () => {
  cameraImage.displayedUrl = $("#camera-image").currentSrc;
  cameraImage.status =
    cameraImage.displayedUrl === cameraImage.requestedUrl
      ? "loaded"
      : "loading";
  renderVision();
});
$("#camera-image").addEventListener("error", () => {
  cameraImage.status = "error";
  renderVision();
});
$$("[data-camera-view]").forEach((button) =>
  button.addEventListener("click", () => {
    state.cameraView = button.dataset.cameraView;
    renderVision();
  }),
);
$("#pause-camera").addEventListener(
  "click",
  () =>
    void controlVision(state.vision?.status === "paused" ? "resume" : "pause"),
);
$("#camera-exposure").addEventListener("input", () => {
  $("#camera-exposure-value").textContent =
    `${Number($("#camera-exposure").value).toFixed(1)} ms`;
});
$("#camera-exposure").addEventListener(
  "change",
  () =>
    void controlVision("set-exposure", {
      exposureMs: Number($("#camera-exposure").value),
    }),
);
$("#capture-frame").addEventListener("click", () => void captureFrame());
$$("[data-capture-view]").forEach((button) =>
  button.addEventListener(
    "click",
    () => void captureFrame(button.dataset.captureView),
  ),
);
async function readPtzCapability() {
  try {
    state.ptz = await request("/api/ptz");
    $("#ptz-status").textContent =
      state.ptz.configured === false ? "未接硬件" : "接口待现场验收";
    // M1 reserves pan/tilt capability only; movement remains disabled in every state.
    $$("[data-ptz-axis]").forEach((button) => {
      button.disabled = true;
    });
  } catch {
    $("#ptz-status").textContent = "预留接口暂不可用";
  }
}
const testIds = {
  "#acquire-control": "acquire-control",
  "#enable-control": "enable-control",
  "#stop-device": "stop-control",
  '[data-device="arm-1"]': "device-arm",
  '[data-device="car-1"]': "device-car",
  '[data-direction="forward"]': "car-forward",
  "#connection-state": "connection-status",
  "#log-rows": "command-log",
  "#camera-image": "camera-preview",
  "#capture-frame": "snapshot-btn",
};
for (const [selector, id] of Object.entries(testIds))
  $(selector).dataset.testid = id;
renderScene(null);
renderControls();
void connect();
setInterval(() => {
  if (!state.session) void connect();
  else void heartbeat();
}, 250);
setInterval(() => void pollState(), 250);
setInterval(() => {
  renderFreshness();
  renderControls();
}, 250);
void refreshCamera();
void readPtzCapability();
setInterval(refreshCamera, 600);
setInterval(() => {
  if (!visionFresh()) renderVision();
}, 400);
