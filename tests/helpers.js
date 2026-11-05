import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

export { delay };

export async function eventually(read, predicate, message, timeout = 2500) {
  const deadline = performance.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(20);
  } while (performance.now() < deadline);
  assert.fail(`${message}; last result: ${JSON.stringify(value)}`);
}

export function api(url) {
  return async (path, { method = 'GET', body, sessionId } = {}) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    return { status: response.status, body: await response.json() };
  };
}

export async function createClient(request) {
  const response = await request('/api/sessions', { method: 'POST', body: {} });
  assert.equal(response.status, 201);
  const client = { ...response.body, sequence: 0 };
  client.refresh = async () => {
    const renewed = await request(`/api/sessions/${client.sessionId}/heartbeat`, {
      method: 'POST', body: {},
    });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    Object.assign(client, renewed.body);
    return renewed;
  };
  client.envelope = (deviceId, action, params = {}, overrides = {}) => ({
    version: 1,
    deviceId,
    sessionId: client.sessionId,
    commandId: randomUUID(),
    sequence: ++client.sequence,
    clockToken: client.clock.token,
    ttlMs: 1000,
    action,
    params,
    ...overrides,
  });
  client.send = async (deviceId, action, params = {}, overrides = {}, refresh = true) => {
    if (refresh) await client.refresh();
    const command = client.envelope(deviceId, action, params, overrides);
    const result = await request('/api/commands', { method: 'POST', body: command });
    return { ...result, sent: command };
  };
  return client;
}

export const device = (state, id) => state.devices.find((entry) => entry.id === id);

export async function state(request, client) {
  const response = await request('/api/state', { sessionId: client?.sessionId });
  assert.equal(response.status, 200);
  return response.body;
}

export async function settled(request, commandId, expected = 'completed') {
  return eventually(
    async () => (await state(request)).commands.find((entry) => entry.commandId === commandId),
    (entry) => entry?.status === expected,
    `command ${commandId} should reach ${expected}`,
  );
}

export async function accepted(request, client, id, action, params = {}, overrides = {}) {
  const result = await client.send(id, action, params, overrides);
  assert.equal(result.status, result.body.command?.status === 'executing' ? 202 : 200, JSON.stringify(result.body));
  await settled(request, result.sent.commandId);
  return result;
}

export async function enable(request, client, id) {
  await accepted(request, client, id, 'acquire');
  await accepted(request, client, id, 'enable');
}

export function rejected(result, code) {
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code, JSON.stringify(result.body));
}
