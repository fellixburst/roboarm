import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerBridge } from "./worker-bridge.js";
import {
  TIMING,
  validateEnvelope,
  fingerprint,
  protocolError,
} from "../../protocol/validation.js";

const WEB_ROOT = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const MAX_HISTORY = 250;
const MAX_SESSIONS = 100;
const bounded = (array, item) => {
  array.unshift(item);
  if (array.length > MAX_HISTORY) array.length = MAX_HISTORY;
};
const nowISO = () => new Date().toISOString();
const publicCommand = (c) => {
  const { fingerprint: _, sessionId: __, ...out } = c;
  return structuredClone(out);
};

async function bodyJSON(request) {
  let data = "";
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 16384)
      throw protocolError("BODY_TOO_LARGE", "请求超过 16 KiB 限制");
  }
  try {
    return data ? JSON.parse(data) : {};
  } catch {
    throw protocolError("INVALID_JSON", "JSON 格式错误");
  }
}

export async function createControlServer({
  host = "127.0.0.1",
  port = 0,
  timing = {},
} = {}) {
  const config = { ...TIMING, ...timing };
  const adapter = new WorkerBridge();
  await adapter.ready;
  const sessions = new Map();
  const commands = [];
  const commandCache = new Map();
  const logs = [];
  let revision = 0;
  let sequenceLog = 0;
  let closed = false;
  let lastFrame = 0;
  let cachedFrame = "";
  function log(event, message, details = {}, level = "info") {
    bounded(logs, {
      id: ++sequenceLog,
      at: nowISO(),
      level,
      event,
      message,
      ...details,
    });
    revision++;
  }
  function change(record, status, details = {}) {
    if (record.status === status && record.transitions.length) return;
    record.status = status;
    record.updatedAt = nowISO();
    Object.assign(record, details);
    record.transitions.push({ status, at: record.updatedAt });
    log(
      status,
      details.message || `${record.action} · ${status}`,
      { commandId: record.commandId, deviceId: record.deviceId },
      status === "rejected" || status === "failed" ? "warn" : "info",
    );
  }
  function revoke(sessionId, reason, remove = false) {
    const session = sessions.get(sessionId);
    if (!session) return;
    adapter.revoke(sessionId, reason);
    session.leaseExpired = true;
    if (remove) sessions.delete(sessionId);
    log(reason, `${session.label} 控制已停止：${reason}`);
  }
  function sessionFor(id) {
    const session = sessions.get(id);
    if (
      !session ||
      performance.now() - session.lastHeartbeat > config.sessionTimeoutMs
    ) {
      if (session) revoke(id, "SESSION_EXPIRED", true);
      throw protocolError(
        "SESSION_EXPIRED",
        "会话已过期，请重新连接并主动启用控制",
      );
    }
    return session;
  }
  function clockFor(session) {
    const token = randomUUID();
    const now = performance.now();
    session.clocks.set(token, now);
    for (const [key, issued] of session.clocks)
      if (now - issued > config.clockWindowMs * 2) session.clocks.delete(key);
    return { token, validForMs: config.clockWindowMs };
  }
  function sessionResponse(session) {
    return {
      sessionId: session.id,
      label: session.label,
      clock: clockFor(session),
      timing: config,
    };
  }
  function snapshot(sessionId) {
    const session = sessions.get(sessionId);
    return {
      mode: "simulation",
      revision,
      updatedAt: nowISO(),
      timing: config,
      devices: adapter.getState().map((device) => {
        const { ownerSessionId, ...publicDevice } = device;
        return {
          ...publicDevice,
          owned: !!session && ownerSessionId === sessionId,
          ownerLabel: sessions.get(ownerSessionId)?.label || null,
        };
      }),
      commands: commands.map(publicCommand),
      logs: structuredClone(logs),
    };
  }
  adapter.on("state", () => {
    revision++;
  });
  adapter.on("device-event", (event) => {
    if (event.commandId) {
      const cached = commandCache.get(`${event.sessionId}:${event.commandId}`);
      const record =
        cached?.deviceId === event.deviceId &&
        ["received", "executing"].includes(cached.status)
          ? cached
          : null;
      if (record && event.code === "COMMAND_COMPLETED")
        change(record, "completed", { message: event.message });
      if (record && event.code === "COMMAND_FAILED")
        change(record, "failed", {
          code: event.reason || "INTERRUPTED",
          message: event.message,
        });
    }
    log(
      event.code || "DEVICE_EVENT",
      event.message || "模拟设备状态改变",
      { deviceId: event.deviceId, commandId: event.commandId },
      /FAULT|TIMEOUT|EXPIRED/.test(event.code || "") ? "warn" : "info",
    );
  });
  log("SERVICE_STARTED", "M1 模拟控制服务已启动；未连接真实硬件");
  const monitor = setInterval(() => {
    const now = performance.now();
    for (const [id, session] of sessions) {
      const age = now - session.lastHeartbeat;
      if (age > config.sessionTimeoutMs) revoke(id, "SESSION_EXPIRED", true);
      else if (age > config.leaseMs && !session.leaseExpired)
        revoke(id, "SERVICE_LEASE_EXPIRED");
    }
  }, 50);
  monitor.unref();

  const server = http.createServer(async (request, response) => {
    const send = (status, payload) => {
      if (response.writableEnded) return;
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(payload));
    };
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'",
    );
    try {
      if (
        request.headers.origin &&
        new URL(request.headers.origin).host !== request.headers.host
      )
        throw protocolError("ORIGIN_REJECTED", "仅接受同源请求");
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname;
      if (request.method === "GET" && path === "/api/health")
        return send(200, { ok: true, mode: "simulation", realHardware: false });
      if (request.method === "POST" && path === "/api/sessions") {
        if (sessions.size >= MAX_SESSIONS)
          return send(429, {
            error: {
              code: "SESSION_LIMIT",
              message: "会话数量已达上限，请稍后再试",
            },
          });
        const id = randomUUID();
        const session = {
          id,
          label: `会话 ${id.slice(0, 6)}`,
          lastHeartbeat: performance.now(),
          clocks: new Map(),
          sequence: 0,
          leaseExpired: false,
        };
        sessions.set(id, session);
        log("SESSION_CREATED", `${session.label} 已加入模拟控制台`);
        return send(201, sessionResponse(session));
      }
      const sessionRoute = path.match(
        /^\/api\/sessions\/([^/]+)(\/heartbeat)?$/,
      );
      if (sessionRoute && request.method === "POST" && sessionRoute[2]) {
        const session = sessionFor(sessionRoute[1]);
        session.lastHeartbeat = performance.now();
        session.leaseExpired = false;
        adapter.heartbeat(session.id, config.leaseMs);
        return send(200, sessionResponse(session));
      }
      if (sessionRoute && request.method === "DELETE" && !sessionRoute[2]) {
        revoke(sessionRoute[1], "SESSION_CLOSED", true);
        return send(200, { ok: true });
      }
      if (request.method === "GET" && path === "/api/state")
        return send(200, snapshot(request.headers["x-session-id"]));
      if (request.method === "POST" && path === "/api/commands") {
        const command = await bodyJSON(request);
        let record;
        try {
          validateEnvelope(command);
          const session = sessionFor(command.sessionId);
          const key = `${command.sessionId}:${command.commandId}`;
          const prior = commandCache.get(key);
          if (prior) {
            if (prior.fingerprint !== fingerprint(command)) {
              log(
                "rejected",
                "同一命令标识不能用于不同内容",
                { commandId: command.commandId, deviceId: command.deviceId },
                "warn",
              );
              return send(400, {
                command: publicCommand(prior),
                error: {
                  code: "DUPLICATE_CONFLICT",
                  message: "同一命令标识不能用于不同内容",
                },
              });
            }
            log("DUPLICATE", "重复命令已返回原执行结果，未再次运动", {
              commandId: command.commandId,
              deviceId: command.deviceId,
            });
            return send(200, {
              command: publicCommand(prior),
              duplicate: true,
            });
          }
          record = {
            commandId: command.commandId,
            deviceId: command.deviceId,
            action: command.action,
            sequence: command.sequence,
            sessionId: command.sessionId,
            sessionLabel: session.label,
            receivedAt: nowISO(),
            updatedAt: nowISO(),
            transitions: [],
            fingerprint: fingerprint(command),
          };
          bounded(commands, record);
          commandCache.set(key, record);
          // Keep session-lifetime tombstones: never evict active session IDs and accidentally replay a duplicate.
          if (commandCache.size > 10000) {
            for (const [cacheKey, value] of commandCache)
              if (!sessions.has(value.sessionId)) commandCache.delete(cacheKey);
            if (commandCache.size > 10000) {
              revoke(session.id, "COMMAND_LIMIT", true);
              throw protocolError(
                "COMMAND_LIMIT",
                "会话命令数量已达上限，请重新连接",
              );
            }
          }
          change(record, "received", {
            message: "服务已接收命令，尚未完成动作",
          });
          const issued = session.clocks.get(command.clockToken);
          if (issued === undefined)
            throw protocolError(
              "CLOCK_EXPIRED",
              "有效期凭据不存在，请等待新心跳",
            );
          const age = performance.now() - issued;
          if (age > command.ttlMs || age > config.clockWindowMs)
            throw protocolError("EXPIRED", "命令已过期，未执行运动");
          if (command.sequence <= session.sequence)
            throw protocolError("OUT_OF_ORDER", "拒绝乱序或已使用的序号");
          session.sequence = command.sequence;
          const device = adapter
            .getState()
            .find((d) => d.id === command.deviceId);
          if (!device) throw protocolError("UNKNOWN_DEVICE", "未知设备");
          change(record, "executing", { message: "设备正在校验并执行命令" });
          const remaining = command.ttlMs - (performance.now() - issued);
          const result = await adapter.request({
            type: "command",
            command,
            generation: device.generation,
            expiresInMs: remaining,
            deadlineMonotonicMs:
              issued + Math.min(command.ttlMs, config.clockWindowMs),
            leaseMs: config.leaseMs,
          });
          if (result?.status !== "executing")
            change(record, "completed", { message: "模拟设备已确认执行结果" });
          return send(record.status === "executing" ? 202 : 200, {
            command: publicCommand(record),
          });
        } catch (error) {
          if (!record) {
            record = {
              commandId:
                typeof command?.commandId === "string"
                  ? command.commandId
                  : randomUUID(),
              deviceId: command?.deviceId,
              action: command?.action,
              receivedAt: nowISO(),
              updatedAt: nowISO(),
              transitions: [],
            };
            bounded(commands, record);
          }
          change(record, "rejected", {
            code: error.code || "INVALID_COMMAND",
            message: error.message,
          });
          return send(400, {
            command: publicCommand(record),
            error: {
              code: error.code || "INVALID_COMMAND",
              message: error.message,
            },
          });
        }
      }
      if (request.method === "POST" && path === "/api/simulate") {
        const data = await bodyJSON(request);
        sessionFor(data.sessionId);
        if (
          !["disconnect", "reconnect", "fault", "clear-fault"].includes(
            data.type,
          )
        )
          throw protocolError("INVALID_INJECTION", "未知模拟注入类型");
        const device = adapter.getState().find((d) => d.id === data.deviceId);
        if (!device) throw protocolError("UNKNOWN_DEVICE", "未知设备");
        const owner = device.ownerSessionId;
        await adapter.request({
          type: "simulate",
          deviceId: data.deviceId,
          injection: data.type,
        });
        if (owner && ["disconnect", "fault"].includes(data.type))
          revoke(
            owner,
            data.type === "disconnect" ? "DEVICE_DISCONNECTED" : "DEVICE_FAULT",
            true,
          );
        log("SIMULATION_INJECTED", `已注入模拟事件：${data.type}`, {
          deviceId: data.deviceId,
        });
        return send(200, { ok: true });
      }
      if (request.method === "GET" && path === "/api/camera/frame.svg") {
        const camera = adapter.getState().find((d) => d.id === "camera-1");
        if (!camera?.connected || camera.fault) {
          response.writeHead(503, { "Cache-Control": "no-store" });
          return response.end("模拟相机离线");
        }
        // One small shared frame per 500 ms; no video encoder, queue, or unbounded stream.
        if (performance.now() - lastFrame > 500 || !cachedFrame) {
          lastFrame = performance.now();
          const t = nowISO().replace("T", " ").slice(0, 19);
          cachedFrame = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="b" x2="0" y2="1"><stop stop-color="#222e39"/><stop offset="1" stop-color="#101a22"/></linearGradient><pattern id="grid" width="60" height="30" patternUnits="userSpaceOnUse"><path d="M60 0H0V30" fill="none" stroke="#456071" stroke-opacity=".22"/></pattern></defs><path fill="url(#b)" d="M0 0h960v540H0z"/><path d="M0 280 480 205 960 280v260H0z" fill="#25333b"/><path d="M0 280 480 205 960 280v260H0z" fill="url(#grid)"/><path d="m170 400 220-67 109 41-220 81z" fill="#151f26" stroke="#607c8c"/><path d="m291 353 0-130 115-49 60 95" fill="none" stroke="#c2c9c7" stroke-width="32" stroke-linejoin="round"/><path d="m291 353 0-130 115-49 60 95" fill="none" stroke="#e7e9e5" stroke-width="20" stroke-linejoin="round"/><g fill="#4fae9a" stroke="#1d342f" stroke-width="7"><circle cx="291" cy="223" r="19"/><circle cx="406" cy="174" r="19"/></g><path d="m450 267 18 24 30-5m-40-13 18 13" fill="none" stroke="#e8ece8" stroke-width="12"/><path d="m660 355 108-26 44 35-110 29z" fill="#b4a27b"/><path d="m660 355 42 38v65l-42-37zm42 38 110-29v65l-110 29z" fill="#847351"/><path d="m554 366 16-8 15 15-12 28-30-3 1-13z" fill="#d1d7db"/><g stroke="#6bc7ad" fill="none" stroke-width="2"><path d="M24 65V24h40M896 24h40v40M24 476v40h40M896 516h40v-40"/><path d="M465 270h30m-15-15v30" opacity=".5"/></g><g font-family="monospace" fill="#e4eae7"><rect x="36" y="32" width="248" height="34" rx="4" fill="#11241c"/><text x="48" y="55" font-size="18">SIMULATED CAMERA · M1</text><text x="36" y="496" font-size="16">${t} UTC · 960 × 540</text><text x="650" y="496" font-size="16">模拟画面 · 无真实相机</text></g></svg>`;
        }
        response.writeHead(200, {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": Buffer.byteLength(cachedFrame),
        });
        return response.end(cachedFrame);
      }
      if (path.startsWith("/api/"))
        return send(404, {
          error: { code: "NOT_FOUND", message: "接口不存在" },
        });
      if (request.method !== "GET" && request.method !== "HEAD")
        return send(405, {
          error: { code: "METHOD_NOT_ALLOWED", message: "不支持的方法" },
        });
      const relative = decodeURIComponent(path === "/" ? "/index.html" : path);
      const filename = resolve(WEB_ROOT, `.${relative}`);
      if (!filename.startsWith(WEB_ROOT))
        return send(404, {
          error: { code: "NOT_FOUND", message: "文件不存在" },
        });
      try {
        const data = await readFile(filename);
        response.writeHead(200, {
          "Content-Type": MIME[extname(filename)] || "application/octet-stream",
          "Cache-Control": "no-cache",
        });
        return response.end(request.method === "HEAD" ? undefined : data);
      } catch {
        return send(404, {
          error: { code: "NOT_FOUND", message: "页面不存在" },
        });
      }
    } catch (error) {
      return send(error.code === "BODY_TOO_LARGE" ? 413 : 400, {
        error: { code: error.code || "REQUEST_ERROR", message: error.message },
      });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 6000;
  try {
    await new Promise((resolveReady, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolveReady);
    });
  } catch (error) {
    clearInterval(monitor);
    await adapter.close();
    throw error;
  }
  const address = server.address();
  return {
    server,
    adapter,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(monitor);
      for (const id of sessions.keys()) adapter.revoke(id, "SERVICE_SHUTDOWN");
      await new Promise((resolveClose) => {
        server.close(resolveClose);
        server.closeAllConnections();
      });
      await adapter.close();
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT 必须为 1–65535");
  const app = await createControlServer({ host, port });
  console.log(`M1 模拟控制台：${app.url}（仅模拟；未连接真实硬件）`);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
