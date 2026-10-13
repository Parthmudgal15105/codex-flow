const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');

// Uses an isolated engine/home, never switches the user's active engine.
module.exports = async function activateWindow(entry, {binary, normalize, timeoutMs = 45_000, spawnImpl = spawn}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-window-'));
  fs.chmodSync(home, 0o700);
  const env = {...process.env, CODEX_HOME: home, RUST_LOG: 'error'};
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
  const child = spawnImpl(binary, ['app-server'], {cwd: home, env, stdio: ['pipe', 'pipe', 'ignore']});
  const pending = new Map(), completed = new Map(), waiters = new Map();
  let nextId = 0, failure = null, timer;
  const fail = () => {
    failure = new Error('Activation engine stopped or timed out');
    for (const p of pending.values()) p.reject(failure);
    for (const p of waiters.values()) p.reject(failure);
    pending.clear(); waiters.clear();
  };
  const lines = createInterface({input: child.stdout});
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id != null) {
      // A minimal activation must never ask the app to execute tools/approvals.
      child.stdin.write(JSON.stringify({id: message.id, error: {code: -32601, message: 'Activation does not support tools'}}) + '\n');
    } else if (pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id);
      message.error ? p.reject(new Error('Activation request failed')) : p.resolve(message.result);
    } else if (message.method === 'turn/completed') {
      const turn = message.params?.turn;
      if (!turn?.id) return;
      completed.set(turn.id, turn);
      const waiter = waiters.get(turn.id);
      if (waiter) { waiters.delete(turn.id); waiter.resolve(turn); }
    }
  });
  child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
  function rpc(method, params = {}) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, {resolve, reject});
      child.stdin.write(JSON.stringify({id, method, params}) + '\n');
    });
  }
  timer = setTimeout(() => {fail(); child.kill();}, timeoutMs);
  try {
    await rpc('initialize', {clientInfo: {name: 'flow_window_activation', version: '1'}, capabilities: {experimentalApi: true}});
    child.stdin.write('{"method":"initialized"}\n');
    await rpc('account/login/start', {type: 'chatgptAuthTokens', accessToken: entry.accessToken,
      chatgptAccountId: entry.accountId, chatgptPlanType: entry.planType});
    const limits = normalize(await rpc('account/rateLimits/read'));
    const windows = [limits.usageWindows?.fiveHour, limits.usageWindows?.weekly, ...(limits.usageWindows?.other || [])].filter(Boolean);
    if (limits.usageWindows?.fiveHour?.usedPercent !== 0 || windows.some(w => !Number.isFinite(w.usedPercent) || w.usedPercent >= 100)) {
      return {...limits, model: null};
    }
    const models = (await rpc('model/list')).data || [];
    const model = models.find(m => m.model === 'gpt-6-luna' || m.id === 'gpt-6-luna')
      || models.find(m => m.isDefault);
    if (!model) throw new Error('No activation model available');
    const modelId = model.model || model.id;
    const {thread} = await rpc('thread/start', {cwd: home, ephemeral: true, model: modelId,
      approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'flow-window-activation',
      baseInstructions: 'Reply exactly OK. Do not use tools or inspect files.',
      config: {'features.shell_tool': false, 'features.unified_exec': false, 'web_search': 'disabled'}});
    const effort = model.supportedReasoningEfforts?.find(e => e.reasoningEffort === 'low')?.reasoningEffort;
    const {turn} = await rpc('turn/start', {threadId: thread.id,
      input: [{type: 'text', text: 'Reply exactly OK.'}], ...(effort ? {effort} : {}), serviceTierForTurn: 'default'});
    const done = completed.get(turn.id) || await new Promise((resolve, reject) => {
      if (failure) reject(failure); else waiters.set(turn.id, {resolve, reject});
    });
    if (done.status !== 'completed') throw new Error('Activation turn failed');
    return {...normalize(await rpc('account/rateLimits/read')), model: modelId};
  } finally {
    clearTimeout(timer); lines.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        child.once('exit', () => {clearTimeout(killTimer); resolve();});
        child.kill();
      });
    }
    fs.rmSync(home, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
};
