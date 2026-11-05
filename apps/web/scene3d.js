import * as T from "/vendor/three/three.module.js";

// Scene coordinates use metres, Y up. Robot coordinates are X forward, Y left,
// Z up (mm for the arm). Keep every geometry update tied to received feedback.
export function createWorld() {
  const host = document.querySelector("#world-viewport");
  const message = document.querySelector("#world-message");
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x142b37);
  renderer.outputColorSpace = T.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-label", "可旋转缩放的三维机械臂与小车模拟画面");
  canvas.tabIndex = 0;
  host.prepend(canvas);
  host.closest(".workspace-card").classList.add("has-3d");
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(43, 1, 0.01, 30);
  scene.add(new T.HemisphereLight(0xd9f6ff, 0x274943, 2.5));
  const sun = new T.DirectionalLight(0xffffff, 3);
  sun.position.set(1, 3, 2);
  scene.add(sun);
  const floor = new T.Mesh(
    new T.PlaneGeometry(5, 5),
    new T.MeshStandardMaterial({ color: 0x1d3943, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.018;
  scene.add(floor);
  const grid = new T.GridHelper(5, 50, 0x4b7c82, 0x2c505b);
  grid.position.y = -0.015;
  scene.add(grid);
  const mat = (color, metalness = 0.25) =>
    new T.MeshStandardMaterial({ color, metalness, roughness: 0.43 });
  const metal = mat(0xb9d5d0),
    dark = mat(0x315d69),
    teal = mat(0x41c4a3),
    rubber = mat(0x15252e, 0);
  function mesh(geometry, material, parent = scene) {
    const m = new T.Mesh(geometry, material);
    parent.add(m);
    return m;
  }
  function box(w, h, d, material, parent = scene) {
    return mesh(new T.BoxGeometry(w, h, d), material, parent);
  }
  function label(text, position, color = "#bcdcd8") {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 96;
    const ctx = c.getContext("2d");
    ctx.font = "36px sans-serif";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(text, 256, 62);
    const texture = new T.CanvasTexture(c),
      sprite = new T.Sprite(
        new T.SpriteMaterial({
          map: texture,
          depthTest: false,
          sizeAttenuation: false,
        }),
      );
    sprite.position.copy(position);
    sprite.scale.set(0.32, 0.06, 1);
    scene.add(sprite);
  }
  const armRoot = new T.Group();
  scene.add(armRoot);
  const base = mesh(
    new T.CylinderGeometry(0.065, 0.08, 0.025, 32),
    dark,
    armRoot,
  );
  base.position.y = 0.0125;
  const links = Array.from({ length: 4 }, () =>
    mesh(new T.CylinderGeometry(0.014, 0.019, 1, 20), metal, armRoot),
  );
  const joints = Array.from({ length: 5 }, () =>
    mesh(new T.SphereGeometry(0.023, 20, 14), teal, armRoot),
  );
  const wrist = new T.Group();
  armRoot.add(wrist);
  box(0.028, 0.035, 0.035, dark, wrist);
  const jaws = [-1, 1].map(() => box(0.045, 0.009, 0.009, metal, wrist));
  label("机械臂 · 模拟 FK", new T.Vector3(0, 0.56, 0));
  // Positive robot Y maps to negative world Z, giving a right-handed frame.
  for (const [end, color, text] of [
    [new T.Vector3(0.45, 0, 0), 0xe48c77, "X 前"],
    [new T.Vector3(0, 0, -0.45), 0x54c5a6, "Y 左"],
    [new T.Vector3(0, 0.45, 0), 0x83b7ea, "Z 上"],
  ]) {
    scene.add(
      new T.ArrowHelper(
        end.clone().normalize(),
        new T.Vector3(0, 0.003, 0),
        0.42,
        color,
        0.035,
        0.015,
      ),
    );
    label(text, end, "#b9d4da");
  }
  const car = new T.Group();
  scene.add(car);
  box(0.3, 0.08, 0.22, dark, car);
  const lid = box(0.25, 0.025, 0.18, metal, car);
  lid.position.y = 0.052;
  const lamp = box(0.008, 0.025, 0.14, teal, car);
  lamp.position.set(0.155, 0.02, 0);
  const wheels = [];
  for (const x of [-0.1, 0.1])
    for (const z of [-0.135, 0.135]) {
      const wheel = mesh(
        new T.CylinderGeometry(0.048, 0.048, 0.025, 24),
        rubber,
        car,
      );
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, -0.018, z);
      wheels.push(wheel);
      const hub = mesh(new T.SphereGeometry(0.019, 12, 8), teal, car);
      hub.position.set(x, -0.018, z);
    }
  const carLabel = new T.Vector3(0.85, 0.38, 0.2);
  label("小车 · 独立模拟坐标", carLabel);
  const bin = box(0.16, 0.08, 0.12, mat(0xb59968));
  bin.position.set(0.48, 0.04, -0.42);
  const rim = box(0.175, 0.01, 0.135, dark);
  rim.position.set(0.48, 0.085, -0.42);
  const sock = box(0.07, 0.009, 0.03, metal);
  sock.position.set(0.23, 0, -0.43);
  sock.rotation.y = 0.3;
  label("场景道具 · 未配准", new T.Vector3(0.4, 0.18, -0.5), "#bcae8c");
  function trail(color) {
    const geometry = new T.BufferGeometry();
    const line = new T.Line(geometry, new T.LineBasicMaterial({ color }));
    scene.add(line);
    return {
      points: [],
      line,
      last: null,
      add(point) {
        if (this.last?.distanceToSquared(point) < 1e-10) return;
        this.last = point.clone();
        this.points.push(point.clone());
        if (this.points.length > 200) this.points.shift();
        this.line.geometry.dispose();
        this.line.geometry = new T.BufferGeometry().setFromPoints(this.points);
      },
      clear() {
        this.points = [];
        this.last = null;
        this.line.geometry.dispose();
        this.line.geometry = new T.BufferGeometry();
      },
    };
  }
  const armTrail = trail(0x57dec0),
    carTrail = trail(0xe7b56e);
  const vector = (p) =>
    new T.Vector3(p.xMm / 1000, p.zMm / 1000, -p.yMm / 1000);
  const up = new T.Vector3(0, 1, 0);
  let received = 0,
    snapshot,
    theta = 0.8,
    phi = 1.04,
    radius = 1.5,
    target = new T.Vector3(0.32, 0.12, 0),
    frame = 0,
    pending = false,
    disposed = false;
  function render() {
    pending = false;
    if (disposed || document.hidden) return;
    const w = host.clientWidth,
      h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.cos(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.sin(theta),
    );
    camera.lookAt(target);
    renderer.render(scene, camera);
    canvas.dataset.frames = String(++frame);
  }
  function draw() {
    if (!pending && !disposed) {
      pending = true;
      requestAnimationFrame(render);
    }
  }
  const observer = new ResizeObserver(draw);
  observer.observe(host);
  function view(name) {
    if (name === "arm") {
      target.set(0.12, 0.15, 0);
      radius = 1.1;
    } else if (name === "car") {
      target.copy(car.position);
      radius = 1.1;
    } else {
      target.set(0.32, 0.12, 0);
      radius = 1.5;
    }
    theta = 0.8;
    phi = 1.04;
    draw();
  }
  document
    .querySelectorAll("[data-world-view]")
    .forEach((b) =>
      b.addEventListener("click", () => view(b.dataset.worldView)),
    );
  document.querySelector("#world-clear").addEventListener("click", () => {
    armTrail.clear();
    carTrail.clear();
    draw();
  });
  const pointers = new Map();
  let pinch = 0;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const old = pointers.get(e.pointerId);
    if (!old) return;
    const dx = e.clientX - old.x,
      dy = e.clientY - old.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()],
        next = Math.hypot(a.x - b.x, a.y - b.y);
      if (next > 0 && pinch > 0)
        radius = Math.max(0.45, Math.min(5, (radius * pinch) / next));
      pinch = next;
    } else {
      theta -= dx * 0.008;
      phi = Math.max(0.12, Math.min(1.5, phi + dy * 0.006));
    }
    canvas.dataset.orbit = `${theta},${phi},${radius}`;
    draw();
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
    canvas.addEventListener(event, (e) => {
      pointers.delete(e.pointerId);
      pinch = 0;
    });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      radius = Math.max(0.45, Math.min(5, radius * Math.exp(e.deltaY * 0.001)));
      canvas.dataset.orbit = `${theta},${phi},${radius}`;
      draw();
    },
    { passive: false },
  );
  canvas.addEventListener("keydown", (e) => {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "+",
        "-",
        "Home",
      ].includes(e.key)
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Home") return view("all");
    if (e.key === "ArrowLeft") theta -= 0.1;
    if (e.key === "ArrowRight") theta += 0.1;
    if (e.key === "ArrowUp") phi = Math.max(0.12, phi - 0.1);
    if (e.key === "ArrowDown") phi = Math.min(1.5, phi + 0.1);
    if (e.key === "+") radius = Math.max(0.45, radius * 0.9);
    if (e.key === "-") radius = Math.min(5, radius * 1.1);
    draw();
  });
  function freshness() {
    const age = received ? performance.now() - received : Infinity;
    const deviceFresh = (d) =>
      Boolean(
        d?.connected &&
          Number.isFinite(Date.parse(d.lastSeenAt)) &&
          Date.parse(snapshot.updatedAt) - Date.parse(d.lastSeenAt) + age <
            1500,
      );
    const fresh = age < 1500;
    const arm = snapshot?.devices.find((d) => d.id === "arm-1"),
      rover = snapshot?.devices.find((d) => d.id === "car-1");
    message.hidden = Boolean(fresh && deviceFresh(arm) && deviceFresh(rover));
    message.textContent = "设备或状态失联 · 保留最后姿态，等待新反馈";
    armRoot.visible = Boolean(arm?.linkPointsMm);
    car.visible = Boolean(rover);
    document.querySelector("#world-status").textContent = fresh
      ? `机械臂：${!deviceFresh(arm) ? "失联" : arm.fault ? "故障" : arm.enabled ? "已启用" : "已停止"} · 小车：${!deviceFresh(rover) ? "失联" : rover.fault ? "故障" : rover.enabled ? "已启用" : "已停止"}`
      : "状态过期，不能将冻结姿态视为实时反馈";
  }
  const timer = setInterval(freshness, 250);
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    message.hidden = false;
    message.textContent =
      "3D 图形上下文丢失，请刷新；二维反馈与设备停止机制仍可用";
    clearInterval(timer);
    host.closest(".workspace-card").classList.remove("has-3d");
    disposed = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) draw();
  });
  window.addEventListener(
    "pagehide",
    (event) => {
      if (event.persisted) return;
      disposed = true;
      clearInterval(timer);
      observer.disconnect();
      scene.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) {
          o.material.map?.dispose();
          o.material.dispose();
        }
      });
      renderer.dispose();
    },
    { once: true },
  );
  draw();
  return {
    update(next) {
      if (disposed) return;
      snapshot = next;
      received = performance.now();
      const arm = next.devices.find((d) => d.id === "arm-1"),
        rover = next.devices.find((d) => d.id === "car-1");
      if (arm?.linkPointsMm?.length === 5) {
        const points = arm.linkPointsMm.map(vector);
        for (let i = 0; i < 4; i++) {
          const a = points[i],
            b = points[i + 1],
            delta = b.clone().sub(a);
          links[i].position.copy(a).add(b).multiplyScalar(0.5);
          links[i].scale.y = delta.length();
          links[i].quaternion.setFromUnitVectors(up, delta.normalize());
        }
        points.forEach((p, i) => joints[i].position.copy(p));
        wrist.position.copy(points[4]);
        const direction = points[4].clone().sub(points[3]).normalize();
        wrist.quaternion.setFromUnitVectors(new T.Vector3(1, 0, 0), direction);
        wrist.rotateX(((arm.endEffector?.rollDeg ?? 0) * Math.PI) / 180);
        const opening = 0.009 + (arm.gripper.position / 100) * 0.025;
        jaws.forEach((jaw, i) =>
          jaw.position.set(0.02, 0, (i ? 1 : -1) * opening),
        );
        if (arm.connected && !arm.fault) armTrail.add(points[4]);
        canvas.dataset.armPosition = JSON.stringify(arm.endEffector);
        canvas.dataset.gripper = String(arm.gripper.position);
      }
      if (rover) {
        car.position.set(0.85 + rover.pose.x, 0.075, 0.2 - rover.pose.y);
        car.rotation.y = rover.pose.heading;
        wheels.forEach((w) => (w.rotation.y = -rover.pose.x / 0.048));
        if (rover.connected && !rover.fault)
          carTrail.add(new T.Vector3(car.position.x, 0.004, car.position.z));
        canvas.dataset.carPosition = JSON.stringify(rover.pose);
      }
      const c = next.commands[0];
      document.querySelector("#world-command").textContent = c
        ? `${c.deviceId} · ${c.action} · ${{ received: "已接收", executing: "执行中", completed: "已完成", rejected: "已拒绝", failed: "失败" }[c.status] ?? c.status}`
        : "尚无命令";
      freshness();
      draw();
    },
  };
}
