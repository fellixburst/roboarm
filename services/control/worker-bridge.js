import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { protocolError } from "../../protocol/validation.js";

export class WorkerBridge extends EventEmitter {
  constructor() {
    super();
    this.devices = [];
    this.pending = new Map();
    this.nextId = 1;
    this.worker = new Worker(
      new URL("../../agents/device/worker.js", import.meta.url),
    );
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.on("message", (message) => {
      if (message.type === "state") {
        this.devices = message.devices;
        this.resolveReady();
        this.emit("state", this.devices);
      }
      if (message.type === "event") this.emit("device-event", message.event);
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else
          pending.reject(
            protocolError(
              message.error?.code || "DEVICE_ERROR",
              message.error?.message || "模拟设备执行失败",
            ),
          );
      }
    });
    this.worker.on("error", (error) => {
      this.rejectReady(error);
      this.fail(error);
    });
    this.worker.on("exit", (code) => {
      if (!this.closing)
        this.fail(
          protocolError("DEVICE_UNAVAILABLE", `模拟设备线程退出 (${code})`),
        );
    });
  }
  fail(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.devices = this.devices.map((d) => ({
      ...d,
      connected: false,
      enabled: false,
      fault: "模拟设备线程不可用",
    }));
    this.emit("state", this.devices);
  }
  request(message) {
    if (this.closing)
      return Promise.reject(
        protocolError("DEVICE_UNAVAILABLE", "模拟设备已关闭"),
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(protocolError("DEVICE_TIMEOUT", "模拟设备响应超时"));
      }, 2000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...message, id });
    });
  }
  heartbeat(sessionId, leaseMs) {
    this.worker.postMessage({
      type: "heartbeat",
      sessionId,
      leaseMs,
      deadlineMonotonicMs: performance.now() + leaseMs,
    });
  }
  revoke(sessionId, reason) {
    this.worker.postMessage({ type: "revoke", sessionId, reason });
  }
  getState() {
    return structuredClone(this.devices);
  }
  async close() {
    this.closing = true;
    await this.worker.terminate();
    this.fail(protocolError("DEVICE_UNAVAILABLE", "模拟设备已关闭"));
  }
}
