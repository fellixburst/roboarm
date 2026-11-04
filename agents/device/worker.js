import { parentPort } from 'node:worker_threads';
import { SimulatorAdapter } from './adapter.js';

if (!parentPort) throw new Error('模拟设备必须在独立 worker_threads 工作线程中运行');
const adapter = new SimulatorAdapter({ onEvent: event => parentPort.postMessage({ type: 'event', event }) });
const publish = () => parentPort.postMessage({ type: 'state', devices: adapter.snapshot() });
parentPort.on('message', message => {
  try {
    let result;
    if (message.type === 'command') result = adapter.execute(message.command, message);
    else if (message.type === 'heartbeat') adapter.heartbeat(message.sessionId, message.leaseMs, message.deadlineMonotonicMs);
    else if (message.type === 'simulate') result = adapter.inject(message.deviceId, message.injection);
    else if (message.type === 'revoke') adapter.revoke(message.sessionId, message.reason);
    else if (message.type === 'stop') adapter.stop(message.deviceId, message.reason);
    else throw Object.assign(new Error('未知设备消息'), { code: 'INVALID_MESSAGE' });
    publish();
    if (message.id !== undefined) parentPort.postMessage({ id: message.id, ok: true, result });
  } catch (err) {
    publish();
    if (message.id !== undefined) parentPort.postMessage({ id: message.id, ok: false, error: { code: err.code ?? 'DEVICE_ERROR', message: err.message } });
  }
});
setInterval(publish, 50);
publish();
