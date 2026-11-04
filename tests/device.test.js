import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulatorAdapter } from '../agents/device/adapter.js';
import { WorkerBridge } from '../services/control/worker-bridge.js';
import { eventually } from './helpers.js';

function rig() {
  let monotonic = 0;
  let sequence = 0;
  const events = [];
  const adapter = new SimulatorAdapter({ now: () => monotonic, onEvent: (event) => events.push(event) });
  const command = (deviceId, action, params = {}) => ({
    version: 1, sessionId: 'test-session', commandId: `device-command-${++sequence}`,
    sequence, deviceId, action, params, clockToken: 'device-local-test-token', ttlMs: 1000,
  });
  const execute = (deviceId, action, params = {}, options = {}) => adapter.execute(
    command(deviceId, action, params), { expiresInMs: 1000, leaseMs: 1200, ...options },
  );
  const get = (id) => adapter.snapshot().find((entry) => entry.id === id);
  const advance = (ms) => { monotonic += ms; adapter.tick(); };
  const enable = (id, options) => {
    execute(id, 'acquire', {}, options);
    execute(id, 'enable', {}, options);
  };
  return { adapter, command, execute, get, advance, enable, events };
}

test('device watchdog uses its own monotonic clock without a control service', () => {
  const r = rig();
  r.enable('car-1');
  r.execute('car-1', 'drive', { linear: 0.2, angular: 0 });
  r.advance(449);
  assert.equal(r.get('car-1').velocity.linear, 0.2);
  r.advance(1);
  assert.deepEqual(r.get('car-1').velocity, { linear: 0, angular: 0 });
  assert.equal(r.get('car-1').enabled, false);
  assert.match(r.get('car-1').stopReason, /设备端.*心跳超时/);
  assert.throws(() => r.execute('car-1', 'drive', { linear: 0.2, angular: 0 }), { code: 'NOT_ENABLED' });
});

test('device lease expiration stops motion before watchdog and revokes ownership', () => {
  const r = rig();
  r.enable('car-1', { leaseMs: 300 });
  r.execute('car-1', 'drive', { linear: 0.2, angular: 0 });
  r.advance(299);
  assert.equal(r.get('car-1').ownerSessionId, 'test-session');
  r.advance(1);
  const car = r.get('car-1');
  assert.equal(car.ownerSessionId, null);
  assert.equal(car.enabled, false);
  assert.deepEqual(car.velocity, { linear: 0, angular: 0 });
  assert.match(car.stopReason, /设备端控制租约过期/);
});

test('queued heartbeat deadlines cannot extend a lease from their later arrival time', () => {
  const r = rig();
  r.enable('car-1', { leaseMs: 300 });
  r.advance(200);
  // An expired heartbeat is ignored, even if it carries a long duration.
  r.adapter.heartbeat('test-session', 1200, 100);
  assert.equal(r.get('car-1').leaseRemainingMs, 100);
  // A still-valid delayed heartbeat is bounded by its original deadline.
  r.adapter.heartbeat('test-session', 1200, 250);
  assert.equal(r.get('car-1').leaseRemainingMs, 50);
  r.advance(49);
  assert.equal(r.get('car-1').ownerSessionId, 'test-session');
  r.advance(1);
  assert.equal(r.get('car-1').ownerSessionId, null);
  assert.equal(r.get('car-1').enabled, false);
});

test('lease heartbeat cannot re-enable a stopped device or replay an old generation', () => {
  const r = rig();
  r.enable('car-1');
  const generation = r.get('car-1').generation;
  const delayed = r.command('car-1', 'drive', { linear: 0.2, angular: 0 });
  r.execute('car-1', 'stop');
  r.adapter.heartbeat('test-session', 1200);
  assert.equal(r.get('car-1').enabled, false);
  r.execute('car-1', 'enable');
  // A delayed pre-stop command has a newer sequence here so the generation
  // check is the independent barrier, rather than the sequence check.
  delayed.sequence = 100;
  assert.throws(() => r.adapter.execute(delayed, { expiresInMs: 1000, generation }), { code: 'STALE_GENERATION' });
  assert.deepEqual(r.get('car-1').velocity, { linear: 0, angular: 0 });
});

test('device rejects a deadline that elapsed in transport even with positive TTL', () => {
  const r = rig();
  r.enable('car-1');
  r.advance(11);
  assert.throws(() => r.execute('car-1', 'drive', { linear: 0.2, angular: 0 }, {
    expiresInMs: 1000, deadlineMonotonicMs: 10,
  }), { code: 'EXPIRED' });
  assert.deepEqual(r.get('car-1').velocity, { linear: 0, angular: 0 });
});

test('device validates bounds and speed independently of the service', () => {
  const r = rig();
  r.enable('arm-1');
  const before = r.get('arm-1').joints.map((joint) => joint.position);
  assert.throws(() => r.execute('arm-1', 'jog', { jointId: 'joint-1', delta: 151, speed: 15 }), { code: 'OUT_OF_RANGE' });
  assert.throws(() => r.execute('arm-1', 'jog', { jointId: 'joint-1', delta: 5, speed: 31 }), { code: 'OUT_OF_RANGE' });
  assert.throws(() => r.execute('arm-1', 'grip', { position: -1 }), { code: 'OUT_OF_RANGE' });
  assert.deepEqual(r.get('arm-1').joints.map((joint) => joint.position), before);
  r.enable('car-1');
  assert.throws(() => r.execute('car-1', 'drive', { linear: 0.31, angular: 0 }), { code: 'OUT_OF_RANGE' });
  assert.deepEqual(r.get('car-1').velocity, { linear: 0, angular: 0 });
});

test('arm simulation respects speed and reports completion only on reaching target', () => {
  const r = rig();
  r.enable('arm-1');
  const command = r.command('arm-1', 'jog', { jointId: 'joint-1', delta: 2, speed: 5 });
  const result = r.adapter.execute(command, { expiresInMs: 1000 });
  assert.equal(result.status, 'executing');
  assert.equal(r.get('arm-1').joints[0].position, 0);
  r.advance(100);
  assert.equal(r.get('arm-1').joints[0].position, 0.5);
  assert.equal(r.events.some((event) => event.commandId === command.commandId && event.code === 'COMMAND_COMPLETED'), false);
  r.advance(100);
  r.advance(100);
  r.advance(100);
  assert.equal(r.get('arm-1').joints[0].position, 2);
  assert.ok(r.events.some((event) => event.commandId === command.commandId && event.code === 'COMMAND_COMPLETED'));
});

test('duplicate device command never changes the target or repeats movement', () => {
  const r = rig();
  r.enable('arm-1');
  const command = r.command('arm-1', 'jog', { jointId: 'joint-1', delta: 2, speed: 5 });
  r.adapter.execute(command, { expiresInMs: 1000 });
  r.advance(100);
  const duplicate = r.adapter.execute(structuredClone(command), { expiresInMs: 1000 });
  assert.equal(duplicate.duplicate, true);
  for (let i = 0; i < 5; i++) r.advance(100);
  assert.equal(r.get('arm-1').joints[0].position, 2);
  assert.equal(r.events.filter((event) => event.commandId === command.commandId && event.code === 'COMMAND_COMPLETED').length, 1);
});

test('software stop cancels an in-progress arm command and cannot resume by heartbeat', () => {
  const r = rig();
  r.enable('arm-1');
  const movement = r.command('arm-1', 'jog', { jointId: 'joint-1', delta: 10, speed: 5 });
  r.adapter.execute(movement, { expiresInMs: 1000 });
  r.advance(100);
  r.execute('arm-1', 'stop');
  const position = r.get('arm-1').joints[0].position;
  r.adapter.heartbeat('test-session', 1200);
  r.advance(200);
  assert.equal(r.get('arm-1').joints[0].position, position);
  assert.equal(r.get('arm-1').enabled, false);
  assert.ok(r.events.some((event) => event.commandId === movement.commandId && event.code === 'COMMAND_FAILED'));
});

test('zero-distance joint replacement cancels an older target instead of continuing it', () => {
  const r = rig();
  r.enable('arm-1');
  const movement = r.command('arm-1', 'jog', { jointId: 'joint-1', delta: 10, speed: 5 });
  r.adapter.execute(movement, { expiresInMs: 1000 });
  r.advance(100);
  const position = r.get('arm-1').joints[0].position;
  const replacement = r.execute('arm-1', 'jog', { jointId: 'joint-1', delta: 0, speed: 5 });
  assert.equal(replacement.status, 'completed');
  r.advance(100);
  assert.equal(r.get('arm-1').joints[0].position, position);
  assert.ok(r.events.some((event) => event.commandId === movement.commandId && event.code === 'COMMAND_FAILED'));
});

test('zero-distance gripper replacement cancels an older gripper target', () => {
  const r = rig();
  r.enable('arm-1');
  const movement = r.command('arm-1', 'grip', { position: 90 });
  r.adapter.execute(movement, { expiresInMs: 1000 });
  r.advance(100);
  const position = r.get('arm-1').gripper.position;
  const replacement = r.execute('arm-1', 'grip', { position });
  assert.equal(replacement.status, 'completed');
  r.advance(100);
  assert.equal(r.get('arm-1').gripper.position, position);
  assert.ok(r.events.some((event) => event.commandId === movement.commandId && event.code === 'COMMAND_FAILED'));
});

test('real device worker stops while the main service thread is blocked', async (t) => {
  const bridge = new WorkerBridge();
  t.after(() => bridge.close());
  await bridge.ready;
  let sequence = 0;
  const send = (action, params = {}) => bridge.request({
    type: 'command',
    command: {
      version: 1, sessionId: 'worker-only-session', deviceId: 'car-1',
      commandId: `worker-command-${++sequence}`, sequence, action, params,
      clockToken: 'worker-local-test-token', ttlMs: 1000,
    },
    expiresInMs: 1000, leaseMs: 1200,
  });
  await send('acquire');
  await send('enable');
  await send('drive', { linear: 0.2, angular: 0 });
  // This deliberately stalls only the test's main thread. The device thread
  // owns its interval and monotonic deadline, so it must stop without help.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
  const car = await eventually(
    () => bridge.getState().find((entry) => entry.id === 'car-1'),
    (entry) => entry?.enabled === false && entry.velocity.linear === 0,
    'independent worker watchdog must stop during a main-thread stall',
  );
  assert.match(car.stopReason, /设备端.*心跳超时/);
});
