import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { validateEnvelope, fingerprint as commandFingerprint } from '../../protocol/validation.js';

export const simulationConfig = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const motionActions = new Set(['jog', 'grip', 'drive']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const error = (code, message) => Object.assign(new Error(message), { code });
const clone = value => structuredClone(value);

/**
 * Shared, hardware-independent command gate. Future drivers inherit execute() and
 * implement applyMotion()/tickMotion()/stopMotion(); no hardware driver is loaded
 * by M1. Clocks here are receiver-local monotonic milliseconds, never wall time.
 */
export class DeviceAdapter {
  constructor({ now = () => performance.now(), config = simulationConfig, onEvent = () => {} } = {}) {
    this.now = now;
    this.config = clone(config);
    this.onEvent = onEvent;
    this.devices = new Map();
    this.sequences = new Map();
    this.results = new Map();
    this.lastTick = this.now();
    this.lastPublished = '';
  }

  getDevice(id) {
    const device = this.devices.get(id);
    if (!device) throw error('DEVICE_NOT_FOUND', '设备不存在');
    return device;
  }

  execute(command, { expiresInMs, leaseMs = 1200, generation, deadlineMonotonicMs } = {}) {
    validateEnvelope(command);
    const key = `${command.sessionId}:${command.commandId}`;
    const fingerprint = commandFingerprint(command);
    const previous = this.results.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw error('DUPLICATE_CONFLICT', '命令标识已被其他内容使用');
      if (previous.error) throw error(previous.error.code, previous.error.message);
      return { ...clone(previous.result), duplicate: true };
    }
    const remaining = deadlineMonotonicMs === undefined ? expiresInMs : Math.min(expiresInMs, deadlineMonotonicMs - this.now());
    if (!finite(remaining) || remaining <= 0 || remaining > 2000) throw error('EXPIRED', '命令已过期或有效期无效');
    const device = this.getDevice(command.deviceId);
    const sequenceKey = `${command.sessionId}:${command.deviceId}`;
    if (command.sequence <= (this.sequences.get(sequenceKey) ?? 0)) throw error('OUT_OF_ORDER', '命令序号未递增');
    this.sequences.set(sequenceKey, command.sequence);
    try {
      this.tick();
      if (command.action !== 'stop' && generation !== undefined && generation !== device.generation) throw error('STALE_GENERATION', '设备控制代次已改变，请重新启用');
      if (device.type === 'camera') throw error('UNSUPPORTED_ACTION', '模拟相机不接受运动命令');
      if (command.action === 'acquire') {
        if (!device.connected) throw error('OFFLINE', '模拟设备已断线');
        if (device.fault) throw error('DEVICE_FAULT', '模拟设备故障未清除');
        if (device.ownerSessionId && device.ownerSessionId !== command.sessionId) throw error('BUSY', '设备已被其他会话控制');
        const duration = this.leaseDuration(leaseMs);
        device.ownerSessionId = command.sessionId;
        device.leaseDeadline = this.now() + duration;
      } else if (command.action === 'stop') {
        // Any live session may request a software stop; it never grants control.
        this.stopDevice(device, '软件停止', false);
      } else {
        if (device.ownerSessionId !== command.sessionId) throw error('NOT_OWNER', '当前会话没有设备控制权');
        if (command.action === 'release') this.stopDevice(device, '已释放控制权', true);
        else {
          if (!device.connected) throw error('OFFLINE', '模拟设备已断线');
          if (device.fault) throw error('DEVICE_FAULT', '模拟设备故障未清除');
          if (command.action === 'enable') {
            device.enabled = true;
            device.stopReason = null;
          } else {
            if (!device.enabled) throw error('NOT_ENABLED', '设备未启用，请显式启用控制');
            this.validateMotion(device, command);
            device.commandStatus = this.applyMotion(device, command)?.status ?? 'completed';
          }
        }
      }
      device.updatedAt = new Date().toISOString();
      const result = { deviceId: device.id, action: command.action, generation: device.generation, status: motionActions.has(command.action) ? (device.commandStatus ?? 'completed') : 'completed' };
      delete device.commandStatus;
      this.remember(key, { fingerprint, result });
      return result;
    } catch (err) {
      this.remember(key, { fingerprint, error: { code: err.code ?? 'DEVICE_ERROR', message: err.message } });
      throw err;
    }
  }

  remember(key, result) {
    this.results.set(key, result);
    if (this.results.size > 512) this.results.delete(this.results.keys().next().value);
  }

  leaseDuration(value) {
    if (!finite(value) || value <= 0) throw error('INVALID_LEASE', '控制租约无效');
    return Math.min(value, this.config.maxLeaseMs);
  }

  validateMotion(device, command) {
    const p = command.params;
    if (command.action === 'jog' && device.type === 'arm') {
      const joint = device.joints.find(item => item.id === p.jointId);
      if (!joint) throw error('INVALID_JOINT', '关节不存在');
      if (!finite(p.delta) || !finite(p.speed) || p.speed <= 0 || p.speed > joint.maxSpeed) throw error('OUT_OF_RANGE', '点动角度或速度超出模拟限制');
      const target = joint.position + p.delta;
      if (target < joint.min || target > joint.max) throw error('OUT_OF_RANGE', '目标角度超出模拟关节限位');
      return;
    }
    if (command.action === 'grip' && device.type === 'arm') {
      if (!finite(p.position) || p.position < device.gripper.min || p.position > device.gripper.max) throw error('OUT_OF_RANGE', '夹爪开度必须在 0 至 100% 之间');
      return;
    }
    if (command.action === 'drive' && device.type === 'car') {
      if (!finite(p.linear) || !finite(p.angular) || Math.abs(p.linear) > device.limits.maxLinear || Math.abs(p.angular) > device.limits.maxAngular) throw error('OUT_OF_RANGE', '小车速度超出模拟限制');
      return;
    }
    throw error('UNSUPPORTED_ACTION', '设备不支持此运动类型');
  }

  heartbeat(sessionId, leaseMs = 1200, deadlineMonotonicMs) {
    this.tick();
    const now = this.now();
    if (deadlineMonotonicMs !== undefined && (!finite(deadlineMonotonicMs) || deadlineMonotonicMs <= now)) return;
    for (const device of this.devices.values()) {
      if (device.ownerSessionId === sessionId && device.connected && !device.fault) device.leaseDeadline = Math.min(now + this.leaseDuration(leaseMs), deadlineMonotonicMs ?? Infinity);
    }
  }

  stopDevice(device, reason, revoke) {
    device.enabled = false;
    device.generation++;
    device.stopReason = reason;
    device.updatedAt = new Date().toISOString();
    this.stopMotion(device, reason);
    if (revoke) {
      device.ownerSessionId = null;
      device.leaseDeadline = null;
    }
    this.onEvent({ deviceId: device.id, code: 'STOPPED', message: reason });
  }

  stop(deviceId, reason = '服务停止') {
    for (const device of this.devices.values()) {
      if ((!deviceId || device.id === deviceId) && device.type !== 'camera') this.stopDevice(device, reason, false);
    }
  }

  revoke(sessionId, reason = '会话失效') {
    for (const device of this.devices.values()) {
      if (device.ownerSessionId === sessionId) this.stopDevice(device, reason, true);
    }
  }

  inject(deviceId, injection) {
    const device = this.getDevice(deviceId);
    if (injection === 'disconnect') {
      device.connected = false;
      this.stopDevice(device, '模拟断线', true);
    } else if (injection === 'reconnect') {
      device.connected = true;
      device.lastSeenAt = new Date().toISOString();
      this.stopDevice(device, '模拟重连，等待重新获取控制权并启用', true);
    } else if (injection === 'fault') {
      device.fault = { code: 'SIMULATED_FAULT', message: '注入的模拟设备故障' };
      this.stopDevice(device, '模拟设备故障', true);
    } else if (injection === 'clear-fault') {
      device.fault = null;
      this.stopDevice(device, '故障已清除，等待显式启用', true);
    } else throw error('INVALID_INJECTION', '未知的模拟故障类型');
    this.onEvent({ deviceId, code: 'SIMULATION', message: `模拟事件：${injection}` });
    return { deviceId, injection, generation: device.generation };
  }

  tick() {
    const now = this.now();
    const dt = Math.max(0, Math.min((now - this.lastTick) / 1000, 0.2));
    this.lastTick = now;
    for (const device of this.devices.values()) {
      if (device.ownerSessionId && device.leaseDeadline <= now) this.stopDevice(device, '设备端控制租约过期', true);
      if (device.type === 'car' && device.enabled && device.motionDeadline && device.motionDeadline <= now) this.stopDevice(device, '设备端运动心跳超时', false);
      if (device.connected) device.lastSeenAt = new Date().toISOString();
      if (device.enabled && device.connected && !device.fault) this.tickMotion(device, dt);
    }
  }

  snapshot() {
    this.tick();
    return [...this.devices.values()].map(device => {
      const { leaseDeadline, motionDeadline, targets, gripperTarget, ...state } = clone(device);
      return { ...state, leaseRemainingMs: leaseDeadline == null ? 0 : Math.max(0, Math.round(leaseDeadline - this.now())) };
    });
  }

  applyMotion() { throw error('NOT_IMPLEMENTED', '设备适配器未实现运动执行'); }
  tickMotion() {}
  stopMotion() {}
}

export class SimulatorAdapter extends DeviceAdapter {
  constructor(options = {}) {
    super(options);
    const common = { mode: 'simulation', connected: true, enabled: false, fault: null, ownerSessionId: null, generation: 0, stopReason: '默认未启用', updatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), leaseDeadline: null };
    this.devices.set('arm-1', { ...clone(common), id: 'arm-1', name: 'SO101 模拟机械臂', type: 'arm', joints: clone(this.config.joints), gripper: clone(this.config.gripper), targets: {} });
    this.devices.set('car-1', { ...clone(common), id: 'car-1', name: '模拟移动底盘', type: 'car', velocity: { linear: 0, angular: 0 }, pose: { x: 0, y: 0, heading: 0 }, limits: clone(this.config.car) });
    this.devices.set('camera-1', { ...clone(common), id: 'camera-1', name: '模拟工作区相机', type: 'camera', resolution: '960 × 540', fps: 2 });
  }

  applyMotion(device, command) {
    if (command.action === 'jog') {
      const old = device.targets[command.params.jointId];
      if (old) this.finishCommand(device, old, false, '关节目标被新命令替换');
      delete device.targets[command.params.jointId];
      if (command.params.delta === 0) return { status: 'completed' };
      device.targets[command.params.jointId] = { position: device.joints.find(j => j.id === command.params.jointId).position + command.params.delta, speed: command.params.speed, commandId: command.commandId, sessionId: command.sessionId };
      return { status: 'executing' };
    }
    if (command.action === 'grip') {
      if (device.gripperTarget) this.finishCommand(device, device.gripperTarget, false, '夹爪目标被新命令替换');
      delete device.gripperTarget;
      if (command.params.position === device.gripper.position) return { status: 'completed' };
      device.gripperTarget = { position: command.params.position, commandId: command.commandId, sessionId: command.sessionId };
      return { status: 'executing' };
    }
    if (command.action === 'drive') {
      device.velocity = { linear: command.params.linear, angular: command.params.angular };
      if (command.params.linear === 0 && command.params.angular === 0) this.stopDevice(device, '零速度停止，等待显式启用', false);
      else device.motionDeadline = this.now() + this.config.watchdogMs;
    }
    return { status: 'completed' };
  }

  tickMotion(device, dt) {
    let moved = false;
    if (device.type === 'car') {
      device.pose.heading += device.velocity.angular * dt;
      device.pose.x += Math.cos(device.pose.heading) * device.velocity.linear * dt;
      device.pose.y += Math.sin(device.pose.heading) * device.velocity.linear * dt;
      moved = device.velocity.linear !== 0 || device.velocity.angular !== 0;
    } else if (device.type === 'arm') {
      for (const joint of device.joints) {
        const target = device.targets[joint.id];
        if (!target) continue;
        const difference = target.position - joint.position;
        const step = Math.sign(difference) * Math.min(Math.abs(difference), target.speed * dt);
        joint.position += step;
        moved ||= step !== 0;
        if (Math.abs(difference) <= target.speed * dt) {
          delete device.targets[joint.id];
          this.finishCommand(device, target, true, '关节点动已到达模拟目标');
        }
      }
      if (device.gripperTarget !== undefined) {
        const difference = device.gripperTarget.position - device.gripper.position;
        device.gripper.position += Math.sign(difference) * Math.min(Math.abs(difference), device.gripper.maxSpeed * dt);
        moved ||= difference !== 0;
        if (Math.abs(difference) <= device.gripper.maxSpeed * dt) {
          const target = device.gripperTarget;
          delete device.gripperTarget;
          this.finishCommand(device, target, true, '夹爪已到达模拟目标');
        }
      }
    }
    if (moved) device.updatedAt = new Date().toISOString();
  }

  finishCommand(device, target, completed, message) {
    this.onEvent({ deviceId: device.id, commandId: target.commandId, sessionId: target.sessionId, code: completed ? 'COMMAND_COMPLETED' : 'COMMAND_FAILED', reason: completed ? undefined : 'INTERRUPTED', message });
  }

  stopMotion(device, reason) {
    if (device.type === 'car') {
      device.velocity = { linear: 0, angular: 0 };
      delete device.motionDeadline;
    }
    if (device.type === 'arm') {
      for (const target of Object.values(device.targets)) this.finishCommand(device, target, false, reason);
      if (device.gripperTarget) this.finishCommand(device, device.gripperTarget, false, reason);
      device.targets = {};
      delete device.gripperTarget;
    }
  }
}
