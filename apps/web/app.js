const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const deviceNames = { 'arm-1': 'SO101 机械臂', 'car-1': '移动小车', 'camera-1': '模拟相机' };
const actionNames = { acquire:'获取控制权', enable:'启用设备', stop:'停止设备', release:'释放控制权', jog:'关节点动', grip:'夹爪操作', drive:'方向控制' };
const eventNames = {SERVICE_STARTED:'模拟服务启动',SESSION_CREATED:'建立控制会话',SESSION_CLOSED:'关闭控制会话',SESSION_EXPIRED:'控制会话过期',SERVICE_LEASE_EXPIRED:'服务端租约过期',DEVICE_DISCONNECTED:'模拟设备断线',DEVICE_FAULT:'模拟设备故障',SIMULATION_INJECTED:'模拟异常注入',DUPLICATE:'重复命令已忽略',COMMAND_LIMIT:'会话命令数达上限',LEASE_EXPIRED:'设备控制租约过期',DEADMAN_TIMEOUT:'运动指令超时',DEVICE_RECONNECTED:'模拟设备重连',FAULT_CLEARED:'模拟故障清除',DEVICE_STOPPED:'模拟设备已停止'};
const statusNames = { received:'已接收', rejected:'已拒绝', executing:'执行中', completed:'已完成', failed:'失败' };
const state = {
  session:null, sequence:0, selected:'arm-1', snapshot:null, receivedAt:0, connected:false,
  connecting:false, polling:false, heartbeatBusy:false, timing:{heartbeatMs:250,stateStaleMs:1500},
  hold:null, holdTimer:null, driving:false, pendingStop:new Set(), expiredToken:null,
};
let toastTimer;
function toast(message, error = false) {
  const element = $('#toast'); element.textContent = message; element.classList.toggle('error', error); element.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, 3500);
}
function time(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('zh-CN', {hour12:false, timeZone:'Asia/Shanghai'}); }
function faultText(device) { return typeof device?.fault === 'object' ? device.fault?.message : device?.fault; }
function selectedDevice() { return state.snapshot?.devices?.find((device) => device.id === state.selected); }
function snapshotAge() { return state.receivedAt ? performance.now() - state.receivedAt : Infinity; }
function stale() { return !state.connected || snapshotAge() > state.timing.stateStaleMs; }
function isFresh(device) {
  if (!device || stale() || !device.connected) return false;
  const serverNow = Date.parse(state.snapshot.updatedAt);
  const deviceTime = Date.parse(device.lastSeenAt ?? device.updatedAt);
  const deviceAge = serverNow - deviceTime;
  return Number.isFinite(deviceAge) && deviceAge >= 0 && deviceAge + snapshotAge() <= state.timing.stateStaleMs;
}
function canMove(device = selectedDevice()) { return Boolean(state.session && device?.owned && device.enabled && isFresh(device) && !device.fault && !state.pendingStop.has(device.id)); }
async function request(path, options = {}) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 1100);
  try {
    const response = await fetch(path, { cache:'no-store', ...options, signal:controller.signal, headers:{'Content-Type':'application/json', ...(state.session ? {'X-Session-Id':state.session.sessionId} : {}), ...options.headers} });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error?.message ?? data.command?.message ?? `请求被拒绝 (${response.status})`); error.code = data.error?.code ?? data.command?.code; error.data = data; throw error; }
    return data;
  } finally { clearTimeout(timeout); }
}
function clearHold() {
  state.hold = null; clearTimeout(state.holdTimer); state.holdTimer = null;
  $$('.direction').forEach((button) => button.classList.remove('pressed'));
}
function connectionLost(message = '控制服务连接已中断，设备将由独立看门狗停止。') {
  clearHold(); state.connected = false; state.session = null; state.expiredToken = null; state.pendingStop.clear();
  $('#connection-banner').textContent = `${message} 重连后不会恢复运动，请重新获取控制权并启用。`;
  $('#connection-banner').hidden = false; renderFreshness(); renderControls();
}
async function connect() {
  if (state.connecting || state.session) return;
  state.connecting = true;
  try {
    const session = await request('/api/sessions', {method:'POST', body:'{}'});
    state.session = session; state.sequence = 0; state.timing = {...state.timing, ...session.timing}; state.expiredToken = session.clock?.token;
    state.connected = true; $('#session-label').textContent = session.label ?? '本浏览器会话';
    $('#connection-banner').hidden = true;
    await pollState();
  } catch { connectionLost('暂时无法连接控制服务。'); }
  finally { state.connecting = false; renderControls(); }
}
async function heartbeat() {
  if (!state.session || state.heartbeatBusy) return;
  state.heartbeatBusy = true;
  const session = state.session;
  try {
    const updated = await request(`/api/sessions/${encodeURIComponent(session.sessionId)}/heartbeat`, {method:'POST', body:'{}'});
    if (state.session === session) { state.session = {...session, ...updated}; state.timing = {...state.timing, ...updated.timing}; }
  } catch { if (state.session?.sessionId === session.sessionId) connectionLost('控制会话已失效。'); }
  finally { state.heartbeatBusy = false; }
}
function commandEnvelope(action, params = {}, deviceId = state.selected, overrides = {}) {
  return {version:1, deviceId, sessionId:state.session?.sessionId, commandId:crypto.randomUUID(), sequence:++state.sequence, clockToken:state.session?.clock?.token, ttlMs:1000, action, params, ...overrides};
}
async function sendCommand(action, params = {}, deviceId = state.selected, options = {}) {
  if (!state.session) { if (!options.quiet) toast('请等待控制服务重新连接。', true); return null; }
  const sessionId = state.session.sessionId;
  try {
    const result = await request('/api/commands', {method:'POST', body:JSON.stringify(commandEnvelope(action, params, deviceId, options.envelope))});
    if (!options.quiet && action !== 'drive') toast(`${actionNames[action]} · ${statusNames[result.command?.status] ?? '已提交'}`);
    if (action === 'enable') state.pendingStop.delete(deviceId);
    void pollState(); return result.command;
  } catch (error) {
    if (error.code === 'SESSION_EXPIRED' || error.code === 'INVALID_SESSION' || error.code === 'OLD_SESSION') { if (state.session?.sessionId === sessionId) connectionLost('旧会话已作废。'); }
    else if (!error.data) connectionLost();
    if (!options.quiet) toast(`${actionNames[action] ?? action}：${error.message}`, true);
    if (action === 'drive') clearHold();
    void pollState(); return error.data?.command ?? null;
  }
}
async function stopDevice(deviceId = state.selected, quiet = false) {
  clearHold(); state.pendingStop.add(deviceId); renderControls();
  return sendCommand('stop', {}, deviceId, {quiet});
}
function safetyStop() {
  clearHold();
  for (const device of state.snapshot?.devices ?? []) {
    if (device.owned && device.enabled && device.type !== 'camera') void stopDevice(device.id, true);
  }
}
async function pollState() {
  if (state.polling) return;
  state.polling = true;
  try {
    const snapshot = await request('/api/state');
    state.snapshot = snapshot; state.receivedAt = performance.now(); state.connected = Boolean(state.session);
    state.timing = {...state.timing, ...snapshot.timing};
    render();
  } catch { if (state.session) connectionLost(); }
  finally { state.polling = false; }
}
function selectDevice(deviceId) {
  if (state.selected === deviceId) return;
  if (state.hold) void stopDevice(state.selected, true);
  state.selected = deviceId; render();
}
function nav(section) {
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.nav === section));
  const labels = {overview:'工作台总览',arm:'机械臂控制',car:'移动小车控制',camera:'相机预览',logs:'操作日志'};
  $('#breadcrumb-current').textContent = labels[section] ?? labels.overview;
  if (section === 'arm' || section === 'car') selectDevice(section === 'arm' ? 'arm-1' : 'car-1');
  const target = {overview:'#overview',arm:'#control-section',car:'#control-section',camera:'#camera-section',logs:'#logs-section'}[section];
  $(target ?? '#overview').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block:'start'});
}
function renderFreshness() {
  const isStale = stale(); const connection = $('#connection-state');
  connection.classList.toggle('online', !isStale && Boolean(state.session)); connection.classList.toggle('offline', isStale);
  connection.innerHTML = `<span class="dot"></span>${isStale ? '服务失联' : '控制服务已连接'}`;
  $('#state-age').textContent = state.receivedAt ? (isStale ? '状态过期 · 已失联' : `${Math.round(snapshotAge())} ms 前更新`) : '等待服务状态';
  if (isStale && state.hold) safetyStop();
  const device = selectedDevice();
  if (device) {
    const fresh = isFresh(device); const fault = faultText(device);
    $('#device-status').className = `status-badge ${!fresh || fault ? 'bad' : device.enabled ? '' : 'stopped'}`;
    $('#device-status').innerHTML = `<span class="dot"></span>${!fresh ? '模拟设备失联' : fault ? '模拟设备故障' : device.enabled ? '模拟设备已启用' : '模拟在线 · 未启用'}`;
    $('#feedback-status').textContent = !fresh ? '反馈已过期，控制已禁用' : fault ? `模拟故障：${fault}` : '服务端模拟状态反馈';
    $('#feedback-dot').style.color = fresh && !fault ? '#63a394' : '#cb8272';
    $('#device-scene').classList.toggle('device-offline', !fresh);
  }
}
function renderControls() {
  const device = selectedDevice(); const usable = Boolean(state.session && isFresh(device) && !device?.fault);
  const owned = device?.owned; const movingAllowed = canMove(device);
  $('#acquire-control').disabled = !usable || Boolean(owned) || Boolean(device?.ownerLabel);
  $('#enable-control').disabled = !usable || !owned || Boolean(device?.enabled && !state.pendingStop.has(device.id));
  $('#release-control').hidden = !owned;
  $('#stop-device').disabled = !state.session;
  $('#pad-stop').disabled = !state.session;
  $('#inject-fault').disabled = !state.session;
  $('#capture-frame').disabled = stale() || !isFresh(state.snapshot?.devices?.find((d) => d.id === 'camera-1'));
  $$('.motion-button').forEach((button) => { button.disabled = !movingAllowed; });
  const ownedText = owned ? (device.enabled && !state.pendingStop.has(device.id) ? '控制已启用 · 请低速操作' : '已持有控制权 · 等待主动启用') : device?.ownerLabel ? `观察模式 · ${device.ownerLabel} 正在控制` : '当前处于观察模式';
  $('#access-text').textContent = stale() ? '状态失联 · 控制不可用' : ownedText;
  if (state.hold && !movingAllowed) clearHold();
}
function renderJoints(device) {
  const joints = device?.joints ?? [];
  if (!joints.length) { $('#joint-table').innerHTML = '<p class="joint-help">等待服务端关节状态与模拟限位配置。</p>'; return; }
  const same = $('#joint-table').dataset.joints === joints.map((j) => j.id).join(',');
  if (!same) {
    $('#joint-table').dataset.joints = joints.map((j) => j.id).join(',');
    $('#joint-table').innerHTML = joints.map((joint,index) => `<div class="joint-row"><div><div class="joint-name"><small>J${index+1}</small>${escapeHtml(joint.name)}</div><div class="joint-limits" title="模拟限位 ${joint.min}° 至 ${joint.max}°"><i id="range-${joint.id}"></i></div></div><button class="joint-button motion-button" data-jog="minus" data-joint="${joint.id}" aria-label="${escapeHtml(joint.name)} 减少" disabled>−</button><output class="joint-value" id="value-${joint.id}">—°</output><button class="joint-button motion-button" data-jog="plus" data-joint="${joint.id}" ${index === 0 ? 'data-testid="joint-jog-plus"' : ''} aria-label="${escapeHtml(joint.name)} 增加" disabled>+</button></div>`).join('');
  }
  joints.forEach((joint) => {
    $(`#value-${joint.id}`).textContent = `${Number(joint.position).toFixed(1)}°`;
    const range = Math.max(0,Math.min(100,(joint.position-joint.min)/(joint.max-joint.min)*100));
    $(`#range-${joint.id}`).style.width = `${range}%`;
  });
}
function render() {
  const snapshot = state.snapshot; const device = selectedDevice();
  if (!snapshot) { renderFreshness(); renderControls(); return; }
  const devices = snapshot.devices ?? [];
  const online = devices.filter(isFresh).length;
  $('#online-count').textContent = online; $('#overview-online').textContent = stale() ? '反馈失联' : `${online} 个模拟连接`;
  $('#ownership-summary').textContent = devices.some((d) => d.owned) ? '已获取控制权' : '观察模式';
  $('#command-count').textContent = (snapshot.commands ?? []).length;
  $('#updated-time').textContent = time(snapshot.updatedAt);
  const latestCommand = [...(snapshot.commands ?? [])].sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0];
  $('#last-command-status').textContent = latestCommand ? `${actionNames[latestCommand.action] ?? latestCommand.action} · ${statusNames[latestCommand.status] ?? latestCommand.status}` : '尚未发送命令';
  $$('.device-tab').forEach((tab) => { const active = tab.dataset.device === state.selected; tab.classList.toggle('active',active); tab.setAttribute('aria-selected',String(active)); });
  for (const [type,id] of [['arm','arm-1'],['car','car-1']]) {
    const d = devices.find((item) => item.id === id); $(`#${type}-nav-dot`).style.background = isFresh(d) ? '#55b7a1' : '#c47765';
  }
  $('#arm-controls').hidden = state.selected !== 'arm-1'; $('#car-controls').hidden = state.selected !== 'car-1';
  $('#stage-device-title').textContent = deviceNames[state.selected]; $('#fault-device-name').textContent = deviceNames[state.selected];
  $('#stage-device-subtitle').textContent = state.selected === 'arm-1' ? '5 旋转关节 + 夹爪 · 关节空间控制' : '差速底盘 · 按住运行 · 松手停止';
  if (device) {
    $('#metric-enabled').textContent = device.enabled && !state.pendingStop.has(device.id) ? '已启用' : '未启用';
    $('#metric-owner').textContent = device.owned ? '当前会话' : device.ownerLabel ?? '未分配';
    const reason = {STOP_COMMAND:'软件停止',DEADMAN_TIMEOUT:'运动指令超时',LEASE_EXPIRED:'控制租约过期',SESSION_EXPIRED:'会话已过期',DISCONNECTED:'设备断线',FAULT:'设备故障',RELEASED:'控制权已释放'};
    $('#metric-protection').textContent = faultText(device) ?? reason[device.stopReason] ?? (device.stopReason ? String(device.stopReason).replaceAll('_',' ') : '看门狗监视中');
    $('#device-updated').textContent = `状态时间 ${time(device.updatedAt ?? snapshot.updatedAt)}`;
    if (state.selected === 'arm-1') { renderJoints(device); $('#grip-position').textContent = `${Number(device.gripper?.position ?? 0).toFixed(0)}%`; }
    if (state.selected === 'car-1') {
      $('#linear-velocity').innerHTML = `${Number(device.velocity?.linear ?? 0).toFixed(2)} <small>m/s</small>`;
      $('#angular-velocity').innerHTML = `${Number(device.velocity?.angular ?? 0).toFixed(2)} <small>rad/s</small>`;
    }
  }
  renderScene(device); renderLogs(); renderFreshness(); renderControls();
}
function renderScene(device) {
  const scene = $('#device-scene');
  const grid = `<defs><linearGradient id="metal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#dae9e7"/><stop offset=".5" stop-color="#9dbcb9"/><stop offset="1" stop-color="#5e8a8c"/></linearGradient><linearGradient id="darkMetal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#4d7980"/><stop offset="1" stop-color="#234853"/></linearGradient><linearGradient id="accent" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#58c6ab"/><stop offset="1" stop-color="#238c79"/></linearGradient><radialGradient id="glow"><stop stop-color="#63d0b2" stop-opacity=".12"/><stop offset="1" stop-color="#63d0b2" stop-opacity="0"/></radialGradient><filter id="shadow"><feGaussianBlur stdDeviation="8"/></filter></defs><ellipse cx="380" cy="283" rx="270" ry="93" fill="url(#glow)"/><g stroke="#3b626b" stroke-width=".65" opacity=".5">${Array.from({length:15},(_,i)=>`<path d="M${20+i*47} 390L${275+i*15} 171"/><path d="M${40+i*18} ${190+i*12}L${720-i*18} ${190+i*12}"/>`).join('')}</g><path d="M141 337L629 337" stroke="#638c8e" stroke-opacity=".25"/><path d="M380 171V390" stroke="#5e8d88" stroke-opacity=".3" stroke-dasharray="4 5"/>`;
  if (!device) { scene.innerHTML = `${grid}<text x="380" y="210" text-anchor="middle" class="stage-empty">等待模拟设备反馈</text>`; return; }
  if (device.type === 'arm') {
    const joints = device.joints ?? []; const shoulder = Number(joints[1]?.position ?? 0), elbowAngle = Number(joints[2]?.position ?? 0), wrist = Number(joints[3]?.position ?? 0), baseAngle = Number(joints[0]?.position ?? 0);
    const a1 = (-137 + shoulder*.45) * Math.PI/180, a2 = (-40 + elbowAngle*.5) * Math.PI/180, a3 = (-12+wrist*.4)*Math.PI/180;
    const p0 = [371,281], p1 = [p0[0]+Math.cos(a1)*112,p0[1]+Math.sin(a1)*112], p2 = [p1[0]+Math.cos(a2)*110,p1[1]+Math.sin(a2)*110], p3=[p2[0]+Math.cos(a3)*47,p2[1]+Math.sin(a3)*47];
    const p = (v) => v.map((n)=>n.toFixed(2)).join(','); const grip = Number(device.gripper?.position ?? 50)/100*13+3;
    scene.innerHTML = `${grid}<ellipse cx="376" cy="318" rx="107" ry="20" fill="#061c23" opacity=".5" filter="url(#shadow)"/><g transform="translate(${(baseAngle*.13).toFixed(2)} 0)"><path d="M310 309L363 330 427 307 373 288z" fill="#41636b" stroke="#789592" stroke-width="1"/><path d="M310 309v9l53 21v-9M363 339l64-23v-9" fill="#234852" stroke="#456d72"/><path d="M348 306v-29q22-16 47 0v29q-22 13-47 0" fill="url(#darkMetal)" stroke="#729a9c"/><ellipse cx="371" cy="276" rx="24" ry="9" fill="#a0beb7"/><ellipse cx="371" cy="278" rx="19" ry="6" fill="#377f77"/><path d="M${p(p0)}L${p(p1)}" fill="none" stroke="#193d48" stroke-width="34" stroke-linecap="round"/><path d="M${p(p0)}L${p(p1)}" fill="none" stroke="url(#metal)" stroke-width="27" stroke-linecap="round"/><path d="M${p(p1)}L${p(p2)}" fill="none" stroke="#20414a" stroke-width="28" stroke-linecap="round"/><path d="M${p(p1)}L${p(p2)}" fill="none" stroke="url(#metal)" stroke-width="22" stroke-linecap="round"/><path d="M${p(p2)}L${p(p3)}" fill="none" stroke="url(#darkMetal)" stroke-width="19" stroke-linecap="round"/>${[p0,p1,p2].map((point,i)=>`<circle cx="${point[0]}" cy="${point[1]}" r="${i===0?20:i===1?17:14}" fill="url(#darkMetal)" stroke="#a0c5bf" stroke-width="1.3"/><circle cx="${point[0]}" cy="${point[1]}" r="${i===0?12:i===1?10:8}" fill="url(#accent)" stroke="#90d9c6" stroke-width=".8"/><circle cx="${point[0]}" cy="${point[1]}" r="3" fill="#216d65"/>`).join('')}<g transform="translate(${p3[0]} ${p3[1]}) rotate(${a3*180/Math.PI})"><rect x="-5" y="-11" width="21" height="22" rx="3" fill="url(#metal)"/><path d="M13 -7L28 ${-grip} 39 ${-grip+3}M13 7L28 ${grip} 39 ${grip-3}" fill="none" stroke="#91b4af" stroke-width="6" stroke-linejoin="round"/><path d="M39 ${-grip+3}v6M39 ${grip-3}v-6" stroke="#4d7779" stroke-width="4"/></g><path d="M${p(p0)}Q${p0[0]+21},${p0[1]-23} ${p1[0]+10},${p1[1]+8}T${p2[0]-2},${p2[1]+10}" fill="none" stroke="#183e48" stroke-width="3" stroke-linecap="round"/></g><g fill="#6c9ca4" font-size="7" font-family="monospace"><path d="M${p1[0]-20} ${p1[1]}h-43l-20-16" fill="none" stroke="#638d95" stroke-width=".6"/><text x="${p1[0]-111}" y="${p1[1]-21}">JOINT 02</text><path d="M${p2[0]+14} ${p2[1]}h49l20 17" fill="none" stroke="#638d95" stroke-width=".6"/><text x="${p2[0]+64}" y="${p2[1]+29}">SO101 / SIM</text></g><circle cx="371" cy="337" r="3" fill="#55b6a0"/><circle cx="371" cy="337" r="11" fill="none" stroke="#55b6a0" stroke-opacity=".4"/>`;
    scene.setAttribute('aria-label','SO101 机械臂的服务端模拟关节姿态');
    $('#stage-coordinates').innerHTML = `BASE J1 ${baseAngle.toFixed(1)}°<br>GRIPPER ${Number(device.gripper?.position ?? 0).toFixed(0)}% / SIM`;
  } else {
    const x = Number(device.pose?.x ?? 0), y = Number(device.pose?.y ?? 0), heading=Number(device.pose?.heading ?? 0), angle=heading*180/Math.PI;
    const sx=380+Math.sin(x)*60,sy=259+Math.sin(y)*23;
    scene.innerHTML = `${grid}<g stroke="#3d817b" stroke-width="1" fill="none" opacity=".4"><ellipse cx="380" cy="276" rx="152" ry="62" stroke-dasharray="4 6"/><ellipse cx="380" cy="276" rx="210" ry="87" stroke-dasharray="2 8"/></g><ellipse cx="${sx}" cy="${sy+51}" rx="91" ry="23" fill="#071e26" opacity=".5" filter="url(#shadow)"/><g transform="translate(${sx} ${sy}) rotate(${angle})"><g fill="#18313b" stroke="#567d85" stroke-width="2"><rect x="-74" y="-43" width="25" height="37" rx="6"/><rect x="49" y="-43" width="25" height="37" rx="6"/><rect x="-74" y="10" width="25" height="37" rx="6"/><rect x="49" y="10" width="25" height="37" rx="6"/></g><path d="M-54 -52Q0 -69 54-52V45Q0 68-54 45z" fill="url(#darkMetal)" stroke="#8db5b1" stroke-width="1.5"/><path d="M-45 -43Q0 -57 45-43V33Q0 48-45 33z" fill="url(#metal)" stroke="#b1d5cb" stroke-width="1"/><rect x="-29" y="-19" width="58" height="43" rx="7" fill="#2a5b60" stroke="#5b9b92"/><rect x="-21" y="-11" width="42" height="26" rx="4" fill="#366f6d"/><path d="M-12 -1h24M-12 5h24" stroke="#7eb6a2" stroke-width="2"/><path d="M-24 -37h48" stroke="#73d6b6" stroke-width="4" stroke-linecap="round"/><circle cx="-34" cy="30" r="3" fill="#78c5ad"/><circle cx="34" cy="30" r="3" fill="#78c5ad"/><path d="M0 -80v-30m-7 8l7-8 7 8" stroke="#7bb9ac" fill="none" stroke-width="2"/></g><g fill="#6d9da5" font-size="8" font-family="monospace"><path d="M${sx+90} ${sy-20}h53l16-17" fill="none" stroke="#648e97" stroke-width=".7"/><text x="${sx+118}" y="${sy-44}">ROVER / SIM</text></g>`;
    scene.setAttribute('aria-label','小车的服务端模拟位姿');
    $('#stage-coordinates').innerHTML=`X ${x.toFixed(3)} m / Y ${y.toFixed(3)} m<br>HEADING ${heading.toFixed(3)} rad`;
  }
}
function renderLogs() {
  const commands = state.snapshot?.commands ?? [], logs = state.snapshot?.logs ?? []; const filter = $('#log-filter').value;
  let rows = commands.map((command)=>({at:command.updatedAt ?? command.receivedAt,deviceId:command.deviceId,title:actionNames[command.action]??command.action,status:command.status,message:command.message??command.code??'',transitions:command.transitions,commandId:command.commandId,code:command.code,kind:'command'}));
  if (filter !== 'commands') rows.push(...logs.filter((log)=>!log.commandId).map((log)=>({...log,title:eventNames[log.event]??log.event??'设备事件',status:log.level==='error'?'failed':log.level==='warn'?'rejected':'completed',kind:'event'})));
  if(filter==='errors') rows=rows.filter((row)=>['rejected','failed'].includes(row.status));
  rows.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)); rows=rows.slice(0,60);
  $('#nav-log-count').textContent=String(commands.length+logs.length); $('#log-count').textContent=String(rows.length);
  $('#log-rows').innerHTML=rows.length ? rows.map((row)=>{
    const transitions=(row.transitions??[]).map((transition)=>statusNames[transition.status]??transition.status).join(' → ');
    const details=[row.message,transitions,row.code].filter(Boolean).join(' · ');
    return `<tr ${row.commandId?`data-command-id="${escapeHtml(row.commandId)}"`:''}><td>${escapeHtml(time(row.at))}</td><td>${escapeHtml(deviceNames[row.deviceId]??'控制服务')}</td><td>${escapeHtml(row.title)}</td><td><span class="log-state ${escapeHtml(row.status)}"><span class="dot"></span>${escapeHtml(row.kind==='event'?'设备事件':statusNames[row.status]??row.status)}</span></td><td title="${escapeHtml(row.commandId??'')}">${escapeHtml(details)}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty-state">暂无符合条件的事件。获取控制权后，即可开始模拟操作。</td></tr>';
}
async function driveLoop(intent) {
  if(state.hold!==intent || !canMove() || state.driving) return;
  state.driving=true;
  const speed=Number($('#drive-speed').value); const maxAngular=selectedDevice()?.limits?.maxAngular??0.8;
  const params={linear:0,angular:0};
  if(intent.direction==='forward') params.linear=speed;
  if(intent.direction==='backward') params.linear=-speed;
  if(intent.direction==='left') params.angular=Math.min(maxAngular,0.5);
  if(intent.direction==='right') params.angular=-Math.min(maxAngular,0.5);
  try { await sendCommand('drive',params,'car-1',{quiet:true}); }
  finally { state.driving=false; if(state.hold===intent && canMove()) state.holdTimer=setTimeout(()=>void driveLoop(intent),110); }
}
function startDrive(direction,button) {
  if(state.selected!=='car-1'||!canMove()||state.hold) return;
  const intent={direction}; state.hold=intent; button?.classList.add('pressed'); void driveLoop(intent);
}
function endDrive() { if(!state.hold) return; clearHold(); void stopDevice('car-1',true); }
$$('.device-tab').forEach((tab)=>tab.addEventListener('click',()=>selectDevice(tab.dataset.device)));
$$('.nav-item').forEach((button)=>button.addEventListener('click',()=>nav(button.dataset.nav)));
$('.brand').addEventListener('click',(event)=>{event.preventDefault();nav('overview');});
$('#acquire-control').addEventListener('click',()=>void sendCommand('acquire'));
$('#enable-control').addEventListener('click',()=>void sendCommand('enable'));
$('#release-control').addEventListener('click',()=>{clearHold();state.pendingStop.add(state.selected);void sendCommand('release');});
$('#stop-device').addEventListener('click',()=>void stopDevice()); $('#pad-stop').addEventListener('click',()=>void stopDevice('car-1'));
$('#joint-table').addEventListener('click',(event)=>{
  const button=event.target.closest('[data-jog]');if(!button||button.disabled||!canMove())return;
  const step=Number($('#jog-step').value),joint=selectedDevice()?.joints?.find((item)=>item.id===button.dataset.joint);
  void sendCommand('jog',{jointId:button.dataset.joint,delta:button.dataset.jog==='plus'?step:-step,speed:Math.min(15,joint?.maxSpeed??15)});
});
$('#jog-step').addEventListener('input',()=>{$('#jog-step-value').textContent=`${$('#jog-step').value}°`;});
$('#drive-speed').addEventListener('input',()=>{$('#drive-speed-value').textContent=`${Number($('#drive-speed').value).toFixed(2)} m/s`;});
$('#grip-open').addEventListener('click',()=>void sendCommand('grip',{position:100}));$('#grip-close').addEventListener('click',()=>void sendCommand('grip',{position:0}));
$$('.direction').forEach((button)=>{
  button.addEventListener('pointerdown',(event)=>{if(event.button!==0||button.disabled)return;event.preventDefault();button.setPointerCapture(event.pointerId);startDrive(button.dataset.direction,button);});
  for(const eventName of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(eventName,endDrive);
  button.addEventListener('keydown',(event)=>{if([' ','Enter'].includes(event.key)){event.preventDefault();if(!event.repeat)startDrive(button.dataset.direction,button);}});
  button.addEventListener('keyup',(event)=>{if([' ','Enter'].includes(event.key)){event.preventDefault();endDrive();}});
});
window.addEventListener('pointerup',endDrive);window.addEventListener('pointercancel',endDrive);
const keyDirection={ArrowUp:'forward',ArrowDown:'backward',ArrowLeft:'left',ArrowRight:'right'};
window.addEventListener('keydown',(event)=>{
  if(event.key==='Escape'){event.preventDefault();void stopDevice();return;}
  if(!keyDirection[event.key]||state.selected!=='car-1'||['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName))return;
  event.preventDefault();if(!event.repeat)startDrive(keyDirection[event.key],$(`[data-direction="${keyDirection[event.key]}"]`));
});
window.addEventListener('keyup',(event)=>{if(keyDirection[event.key]&&state.hold?.direction===keyDirection[event.key]){event.preventDefault();endDrive();}});
window.addEventListener('blur',safetyStop);document.addEventListener('visibilitychange',()=>{if(document.hidden)safetyStop();});
window.addEventListener('pagehide',()=>{
  clearHold();const session=state.session;if(!session)return;
  for(const device of state.snapshot?.devices??[])if(device.owned&&device.type!=='camera')void fetch('/api/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(commandEnvelope('stop',{},device.id)),keepalive:true}).catch(()=>{});
  void fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}`,{method:'DELETE',keepalive:true}).catch(()=>{});state.session=null;
});
$('#reconnect').addEventListener('click',async()=>{
  safetyStop();const old=state.session;state.session=null;clearHold();
  if(old)try{await request(`/api/sessions/${encodeURIComponent(old.sessionId)}`,{method:'DELETE'});}catch{}
  connectionLost('正在建立新的控制会话。');await connect();toast('已重新建立模拟会话，请重新获取控制权。');
});
$('#inject-fault').addEventListener('click',async()=>{
  if(!state.session)return;
  clearHold();const type=$('#fault-type').value;$('#diagnostic-result').classList.remove('error');
  try{
    if(type==='expire-command'){
      const token=state.session.clock?.token;await new Promise((resolve)=>setTimeout(resolve,20));
      const command=await sendCommand(state.selected==='car-1'?'drive':'jog',state.selected==='car-1'?{linear:0.1,angular:0}:{jointId:'joint-1',delta:1,speed:10},state.selected,{quiet:true,envelope:{clockToken:token,ttlMs:1}});
      const rejected=command?.status==='rejected';$('#diagnostic-result').textContent=`过期命令：${command?.code??statusNames[command?.status]??'请查看操作日志'}${rejected?' · 未执行运动':''}`;$('#diagnostic-result').classList.toggle('error',!rejected);
      toast(rejected?'过期命令已被服务端拒绝。':'请查看服务端命令反馈。',!rejected);
    }else{
      await request('/api/simulate',{method:'POST',body:JSON.stringify({sessionId:state.session.sessionId,deviceId:state.selected,type})});
      $('#diagnostic-result').textContent=`已执行：${$('#fault-type').selectedOptions[0].textContent}，以服务端状态和日志为准。`;
      toast('模拟异常已注入。恢复后需重新获取控制权并启用。');
    }
    await pollState();
  }catch(error){$('#diagnostic-result').textContent=error.message;$('#diagnostic-result').classList.add('error');toast(error.message,true);}
});
$('#log-filter').addEventListener('change',renderLogs);
$('#camera-image').addEventListener('load',()=>{frameBusy=false;$('#camera-state').textContent='模拟画面';});$('#camera-image').addEventListener('error',()=>{frameBusy=false;$('#camera-state').textContent='图像通道暂不可用';});
let frameBusy=false;
function refreshCamera(){
  if(document.hidden||frameBusy)return;
  const camera=state.snapshot?.devices?.find((device)=>device.id==='camera-1');
  if(!isFresh(camera)){$('#camera-state').textContent='模拟相机失联';return;}
  frameBusy=true;const image=$('#camera-image');image.src=`/api/camera/frame.svg?frame=${Date.now()}`;
}
$('#capture-frame').addEventListener('click',async()=>{
  try{
    const response=await fetch('/api/camera/frame.svg',{cache:'no-store'});if(!response.ok)throw new Error('模拟抓图失败');
    const blob=await response.blob(),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=`robolab-simulated-${new Date().toISOString().replace(/[:.]/g,'-')}.svg`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('#capture-status').textContent=`已保存模拟帧 ${time(new Date())}`;toast('已保存模拟相机 SVG 画面。');
  }catch(error){toast(error.message,true);}
});
const testIds={'#acquire-control':'acquire-control','#enable-control':'enable-control','#stop-device':'stop-control','[data-device="arm-1"]':'device-arm','[data-device="car-1"]':'device-car','[data-direction="forward"]':'car-forward','#connection-state':'connection-status','#log-rows':'command-log','#camera-image':'camera-preview','#capture-frame':'snapshot-btn'};
for(const [selector,id]of Object.entries(testIds))$(selector).dataset.testid=id;
renderScene(null);renderControls();void connect();
setInterval(()=>{if(!state.session)void connect();else void heartbeat();},250);
setInterval(()=>void pollState(),250);
setInterval(()=>{renderFreshness();renderControls();},250);
setInterval(refreshCamera,600);
