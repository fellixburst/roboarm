export const VERSION = 1;
export const ACTIONS = new Set(['acquire', 'enable', 'stop', 'release', 'jog', 'grip', 'drive']);
export const MOTION_ACTIONS = new Set(['jog', 'grip', 'drive']);
export const TIMING = Object.freeze({ heartbeatMs: 250, sessionTimeoutMs: 1800, leaseMs: 1200, stateStaleMs: 1500, clockWindowMs: 1000 });
export function protocolError(code, message) { return Object.assign(new Error(message), { code }); }
export function validateEnvelope(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw protocolError('INVALID_COMMAND', '命令必须是对象');
  if (command.version !== VERSION) throw protocolError('PROTOCOL_VERSION', '不支持的协议版本');
  for (const field of ['deviceId', 'sessionId', 'commandId', 'clockToken']) {
    if (typeof command[field] !== 'string' || command[field].length < 1 || command[field].length > 128) throw protocolError('INVALID_COMMAND', `${field} 格式不正确`);
  }
  if (!Number.isSafeInteger(command.sequence) || command.sequence < 1) throw protocolError('INVALID_COMMAND', 'sequence 必须为正整数');
  if (!Number.isFinite(command.ttlMs) || command.ttlMs < 1 || command.ttlMs > 1000) throw protocolError('INVALID_COMMAND', 'ttlMs 范围为 1–1000 毫秒');
  if (!ACTIONS.has(command.action)) throw protocolError('INVALID_COMMAND', '未知操作');
  if (!command.params || typeof command.params !== 'object' || Array.isArray(command.params)) throw protocolError('INVALID_COMMAND', 'params 必须为对象');
  return command;
}
export function fingerprint(command) {
  const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered(command));
}
