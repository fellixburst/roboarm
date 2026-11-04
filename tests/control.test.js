import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlServer } from '../services/control/server.js';
import {
  accepted, api, createClient, delay, device, enable, eventually,
  rejected, settled, state,
} from './helpers.js';

async function setup(t, options) {
  const control = await createControlServer({ port: 0, ...options });
  t.after(() => control.close());
  const request = api(control.url);
  return { control, request, client: await createClient(request) };
}

test('all devices start disabled and explicitly identified as simulated', async (t) => {
  const { request } = await setup(t);
  const snapshot = await state(request);
  assert.equal(snapshot.mode, 'simulation');
  assert.deepEqual(snapshot.devices.map((entry) => entry.id).sort(), ['arm-1', 'camera-1', 'car-1']);
  for (const entry of snapshot.devices) {
    assert.equal(entry.mode, 'simulation');
    assert.ok(Number.isFinite(Date.parse(entry.updatedAt)), 'device has an actual update timestamp');
    if (entry.id !== 'camera-1') assert.equal(entry.enabled, false);
  }
});

test('ownership and explicit enable are required before arm movement', async (t) => {
  const { request, client } = await setup(t);
  rejected(await client.send('arm-1', 'jog', { jointId: 'joint-1', delta: 5, speed: 15 }), 'NOT_OWNER');
  await accepted(request, client, 'arm-1', 'acquire');
  rejected(await client.send('arm-1', 'jog', { jointId: 'joint-1', delta: 5, speed: 15 }), 'NOT_ENABLED');
  assert.equal(device(await state(request), 'arm-1').joints[0].position, 0);
});

test('arm jog and gripper produce device feedback, lifecycle transitions and logs', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'arm-1');
  const before = device(await state(request), 'arm-1').joints[0].position;
  const movement = await accepted(request, client, 'arm-1', 'jog', {
    jointId: 'joint-1', delta: 5, speed: 15,
  });
  const snapshot = await state(request, client);
  assert.equal(device(snapshot, 'arm-1').joints[0].position, before + 5);
  assert.equal(device(snapshot, 'arm-1').owned, true);
  const command = snapshot.commands.find((entry) => entry.commandId === movement.sent.commandId);
  assert.deepEqual(command.transitions.map((entry) => entry.status), ['received', 'executing', 'completed']);
  assert.ok(snapshot.logs.some((entry) => entry.commandId === movement.sent.commandId));
  await accepted(request, client, 'arm-1', 'grip', { position: 80 });
  assert.equal(device(await state(request), 'arm-1').gripper.position, 80);
});

test('joint, gripper and speed limits reject without modifying device position', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'arm-1');
  const before = device(await state(request), 'arm-1');
  for (const [action, params] of [
    ['jog', { jointId: 'joint-1', delta: 10000, speed: 15 }],
    ['jog', { jointId: 'joint-1', delta: 5, speed: 10000 }],
    ['grip', { position: 101 }],
  ]) rejected(await client.send('arm-1', action, params), 'OUT_OF_RANGE');
  const after = device(await state(request), 'arm-1');
  assert.deepEqual(after.joints.map((joint) => joint.position), before.joints.map((joint) => joint.position));
  assert.deepEqual(after.gripper, before.gripper);
  const snapshot = await state(request);
  assert.ok(snapshot.commands.some((entry) => entry.status === 'rejected'));
});

test('an interrupted arm command stays failed rather than reporting completed motion', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'arm-1');
  const movement = await client.send('arm-1', 'jog', { jointId: 'joint-1', delta: 20, speed: 5 });
  assert.equal(movement.status, 202);
  assert.equal(movement.body.command.status, 'executing');
  await delay(80);
  assert.ok(device(await state(request), 'arm-1').joints[0].position < 20);
  await accepted(request, client, 'arm-1', 'stop');
  const interrupted = await settled(request, movement.sent.commandId, 'failed');
  assert.deepEqual(interrupted.transitions.map((entry) => entry.status), ['received', 'executing', 'failed']);
  const stopped = device(await state(request), 'arm-1');
  await delay(80);
  assert.equal(device(await state(request), 'arm-1').joints[0].position, stopped.joints[0].position);
});

test('car drive produces motion feedback and explicit stop disables further motion', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'car-1');
  await accepted(request, client, 'car-1', 'drive', { linear: 0.2, angular: 0 });
  const moving = device(await state(request), 'car-1');
  assert.equal(moving.velocity.linear, 0.2);
  await delay(100);
  assert.ok(device(await state(request), 'car-1').pose.x > moving.pose.x);
  await accepted(request, client, 'car-1', 'stop');
  const stopped = device(await state(request), 'car-1');
  assert.deepEqual(stopped.velocity, { linear: 0, angular: 0 });
  assert.equal(stopped.enabled, false);
  rejected(await client.send('car-1', 'drive', { linear: 0.2, angular: 0 }), 'NOT_ENABLED');
  await delay(100);
  assert.deepEqual(device(await state(request), 'car-1').pose, stopped.pose);
  await accepted(request, client, 'car-1', 'enable');
  assert.deepEqual(device(await state(request), 'car-1').velocity, { linear: 0, angular: 0 });
});

test('car limits reject excessive translation and rotation speeds', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'car-1');
  for (const params of [{ linear: 0.31, angular: 0 }, { linear: 0, angular: 0.81 }]) {
    rejected(await client.send('car-1', 'drive', params), 'OUT_OF_RANGE');
  }
  assert.deepEqual(device(await state(request), 'car-1').velocity, { linear: 0, angular: 0 });
});

test('release stops a moving car and another session can acquire it', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'car-1');
  await accepted(request, client, 'car-1', 'drive', { linear: 0.1, angular: 0 });
  await accepted(request, client, 'car-1', 'release');
  const stopped = device(await state(request, client), 'car-1');
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.owned, false);
  assert.deepEqual(stopped.velocity, { linear: 0, angular: 0 });
  const other = await createClient(request);
  await accepted(request, other, 'car-1', 'acquire');
  assert.equal(device(await state(request, other), 'car-1').owned, true);
});

test('two browser sessions cannot simultaneously own or drive one device', async (t) => {
  const { request, client } = await setup(t);
  const other = await createClient(request);
  await enable(request, client, 'car-1');
  rejected(await other.send('car-1', 'acquire'), 'BUSY');
  rejected(await other.send('car-1', 'drive', { linear: 0.1, angular: 0 }), 'NOT_OWNER');
  assert.equal(device(await state(request, other), 'car-1').owned, false);
  assert.equal(device(await state(request, client), 'car-1').owned, true);
});

test('duplicate command executes once and conflicting reuse is rejected', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'arm-1');
  const first = await accepted(request, client, 'arm-1', 'jog', {
    jointId: 'joint-1', delta: 5, speed: 15,
  });
  const duplicate = await request('/api/commands', { method: 'POST', body: first.sent });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(device(await state(request), 'arm-1').joints[0].position, 5);
  rejected(await request('/api/commands', {
    method: 'POST', body: { ...first.sent, params: { ...first.sent.params, delta: 10 } },
  }), 'DUPLICATE_CONFLICT');
  const commands = (await state(request)).commands.filter((entry) => entry.commandId === first.sent.commandId);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].transitions.filter((entry) => entry.status === 'executing').length, 1);
});

test('out-of-order sequence cannot execute a new movement', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'arm-1');
  await accepted(request, client, 'arm-1', 'jog', { jointId: 'joint-1', delta: 5, speed: 15 });
  const before = device(await state(request), 'arm-1').joints[0].position;
  rejected(await client.send('arm-1', 'jog', { jointId: 'joint-1', delta: 5, speed: 15 }, { sequence: 1 }), 'OUT_OF_ORDER');
  assert.equal(device(await state(request), 'arm-1').joints[0].position, before);
});

test('receiver-monotonic deadline rejects an expired command without motion', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'arm-1');
  await client.refresh();
  const delayed = client.envelope('arm-1', 'jog', { jointId: 'joint-1', delta: 5, speed: 15 }, { ttlMs: 1 });
  await delay(30);
  rejected(await request('/api/commands', { method: 'POST', body: delayed }), 'EXPIRED');
  assert.equal(device(await state(request), 'arm-1').joints[0].position, 0);
});

test('unknown or another session clock token is rejected', async (t) => {
  const { request, client } = await setup(t);
  const other = await createClient(request);
  rejected(await client.send('arm-1', 'acquire', {}, { clockToken: other.clock.token }), 'CLOCK_EXPIRED');
  rejected(await client.send('arm-1', 'acquire', {}, { clockToken: 'not-issued' }), 'CLOCK_EXPIRED');
});

test('closing a session stops the car and old session commands cannot resume it', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'car-1');
  await accepted(request, client, 'car-1', 'drive', { linear: 0.2, angular: 0 });
  const old = client.envelope('car-1', 'drive', { linear: 0.2, angular: 0 });
  const closed = await request(`/api/sessions/${client.sessionId}`, { method: 'DELETE' });
  assert.equal(closed.status, 200);
  await eventually(() => state(request), (snapshot) => device(snapshot, 'car-1').velocity.linear === 0, 'session close stops car');
  rejected(await request('/api/commands', { method: 'POST', body: old }), 'SESSION_EXPIRED');
  const fresh = await createClient(request);
  await accepted(request, fresh, 'car-1', 'acquire');
  assert.equal(device(await state(request), 'car-1').enabled, false);
  rejected(await fresh.send('car-1', 'drive', { linear: 0.2, angular: 0 }), 'NOT_ENABLED');
});

test('motion deadman stops and disables even while browser heartbeat continues', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'car-1');
  await accepted(request, client, 'car-1', 'drive', { linear: 0.2, angular: 0 });
  await delay(200);
  await client.refresh();
  await delay(200);
  await client.refresh();
  await eventually(() => state(request), (snapshot) => {
    const car = device(snapshot, 'car-1');
    return car.velocity.linear === 0 && car.enabled === false;
  }, 'missing held-drive intents stop independently of browser session', 1200);
  rejected(await client.send('car-1', 'drive', { linear: 0.2, angular: 0 }), 'NOT_ENABLED');
});

test('lease expiry releases ownership and requires explicit reacquire and enable', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'car-1');
  await eventually(() => state(request, client), (snapshot) => {
    const car = device(snapshot, 'car-1');
    return !car.owned && !car.enabled && car.velocity.linear === 0;
  }, 'lease must expire without browser heartbeat', 2500);
  const fresh = await createClient(request);
  await accepted(request, fresh, 'car-1', 'acquire');
  rejected(await fresh.send('car-1', 'drive', { linear: 0.2, angular: 0 }), 'NOT_ENABLED');
});

test('session expiry rejects an old session even when a new clock is requested', async (t) => {
  const { request, client } = await setup(t);
  const old = client.envelope('car-1', 'acquire');
  await delay(client.timing.sessionTimeoutMs + 100);
  const refresh = await request(`/api/sessions/${client.sessionId}/heartbeat`, { method: 'POST', body: {} });
  assert.equal(refresh.status, 400);
  assert.equal(refresh.body.error.code, 'SESSION_EXPIRED');
  rejected(await request('/api/commands', { method: 'POST', body: old }), 'SESSION_EXPIRED');
});

test('disconnect stops movement, invalidates session and reconnect never replays commands', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'car-1');
  await accepted(request, client, 'car-1', 'drive', { linear: 0.2, angular: 0 });
  const queued = client.envelope('car-1', 'drive', { linear: 0.2, angular: 0 });
  const disconnected = await request('/api/simulate', {
    method: 'POST', body: { sessionId: client.sessionId, deviceId: 'car-1', type: 'disconnect' },
  });
  assert.equal(disconnected.status, 200);
  let car = device(await state(request), 'car-1');
  assert.equal(car.connected, false);
  assert.equal(car.enabled, false);
  assert.deepEqual(car.velocity, { linear: 0, angular: 0 });
  const replacement = await createClient(request);
  const reconnected = await request('/api/simulate', {
    method: 'POST', body: { sessionId: replacement.sessionId, deviceId: 'car-1', type: 'reconnect' },
  });
  assert.equal(reconnected.status, 200);
  rejected(await request('/api/commands', { method: 'POST', body: queued }), 'SESSION_EXPIRED');
  await accepted(request, replacement, 'car-1', 'acquire');
  car = device(await state(request), 'car-1');
  assert.equal(car.connected, true);
  assert.equal(car.enabled, false);
  assert.deepEqual(car.velocity, { linear: 0, angular: 0 });
  await delay(100);
  assert.deepEqual(device(await state(request), 'car-1').pose, car.pose);
});

test('injected device fault is visible and prevents motion until cleared and re-enabled', async (t) => {
  const { request, client } = await setup(t);
  await enable(request, client, 'arm-1');
  const injection = await request('/api/simulate', {
    method: 'POST', body: { sessionId: client.sessionId, deviceId: 'arm-1', type: 'fault' },
  });
  assert.equal(injection.status, 200);
  const arm = device(await state(request), 'arm-1');
  assert.ok(arm.fault);
  assert.equal(arm.enabled, false);
  const replacement = await createClient(request);
  rejected(await replacement.send('arm-1', 'acquire'), 'DEVICE_FAULT');
  const cleared = await request('/api/simulate', {
    method: 'POST', body: { sessionId: replacement.sessionId, deviceId: 'arm-1', type: 'clear-fault' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(device(await state(request), 'arm-1').enabled, false);
});

test('malformed protocol is rejected and leaves server responsive', async (t) => {
  const { request, client } = await setup(t);
  rejected(await client.send('arm-1', 'acquire', {}, { version: 999 }), 'PROTOCOL_VERSION');
  const response = await request('/api/commands', { method: 'POST', body: {} });
  assert.equal(response.status, 400);
  assert.ok(response.body.error.code);
  assert.equal((await state(request)).mode, 'simulation');
});

test('camera uses a bounded independent SVG resource clearly marked as simulated', async (t) => {
  const { control, request } = await setup(t);
  const frame = await fetch(`${control.url}/api/camera/frame.svg`, { signal: AbortSignal.timeout(4000) });
  assert.equal(frame.status, 200);
  assert.match(frame.headers.get('content-type'), /image\/svg\+xml/);
  const svg = await frame.text();
  assert.ok(svg.length < 100000);
  assert.match(svg, /模拟/);
  assert.equal((await state(request)).mode, 'simulation');
});
