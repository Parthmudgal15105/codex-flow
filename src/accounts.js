import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { recommend } from './optimizer.js';

export const root = process.env.CODEX_FLOW_HOME || join(homedir(), '.codex-flow');
export const executable = process.env.CODEX_FLOW_CODEX || 'codex';
export function accountHome(name) {
  if (!['a', 'b'].includes(name)) throw new Error('Account must be a or b.');
  return join(root, 'accounts', name);
}
export async function prepare(name) {
  const home = accountHome(name);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const config = join(home, 'config.toml');
  try { await access(config); } catch {
    await writeFile(config, 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: 'wx' });
  }
  return home;
}
export function environment(name) {
  const env = { ...process.env, CODEX_HOME: accountHome(name) };
  // Never accidentally route a subscription session through API billing.
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
  return env;
}
export class Rpc {
  constructor(name) {
    this.pending = new Map(); this.nextId = 0;
    this.child = spawn(executable, ['app-server', '--stdio'], { env: environment(name), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume();
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const p = this.pending.get(message.id);
      if (p) { this.pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
      else if (message.id !== undefined && message.method) this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported request' } }) + '\n');
    });
    const fail = err => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); } this.pending.clear(); };
    this.child.on('error', fail);
    this.child.on('exit', () => fail(new Error('Codex account service stopped.')));
    this.child.stdin.on('error', fail);
  }
  request(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'codex_flow', title: 'Codex Flow', version: '0.1.0' } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  close() { this.child.stdin.end(); this.child.kill(); this.lines.close(); }
}
export function evaluate(result) {
  const buckets = result.rateLimitsByLimitId;
  const limits = buckets && Object.keys(buckets).length ? Object.values(buckets) : [result.rateLimits].filter(Boolean);
  if (!limits.length) return { state: 'unknown', windows: [] };
  const windows = limits.flatMap(l => [l.primary, l.secondary].filter(Boolean).map(w => ({ ...w, bucket: l.limitName || l.limitId || 'Codex' })));
  if (limits.some(l => l.rateLimitReachedType) || windows.some(w => w.usedPercent >= 100)) return { state: 'blocked', windows };
  if (!windows.length || windows.some(w => !Number.isFinite(w.usedPercent) || w.usedPercent < 0)) return { state: 'unknown', windows };
  return { state: 'ready', windows };
}
export async function inspect(name) {
  await prepare(name);
  const rpc = new Rpc(name);
  try {
    await rpc.initialize();
    const { account } = await rpc.request('account/read', { refreshToken: false });
    if (!account) return { name, state: 'signed-out', windows: [] };
    if (account.type !== 'chatgpt') return { name, state: 'unknown', windows: [], error: 'A ChatGPT subscription login is required.' };
    return { name, email: account.email, plan: account.planType, ...evaluate(await rpc.request('account/rateLimits/read')) };
  } catch (error) { return { name, state: 'unknown', windows: [], error: error.message }; }
  finally { rpc.close(); }
}
export async function inspectAll() { return Promise.all(['a', 'b'].map(inspect)); }
export function choose(accounts, preferred, excluded = new Set(), history = {}, now = Date.now()) {
  return recommend(accounts, preferred, excluded, history, now).account || undefined;
}
export function display(accounts) {
  for (const a of accounts) {
    console.log(`\nAccount ${a.name.toUpperCase()} · ${a.email || 'No login'} · ${a.state}${a.plan ? ` · ${a.plan}` : ''}`);
    for (const w of a.windows) {
      const duration = w.windowDurationMins >= 1440 ? `${Math.round(w.windowDurationMins / 1440)} days` : `${w.windowDurationMins / 60} hours`;
      const reset = Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000).toLocaleString() : 'unknown';
      console.log(`  ${w.bucket} / ${duration}: ${Math.max(0, 100 - w.usedPercent)}% remaining · resets ${reset}`);
    }
    if (a.error) console.log(`  ${a.error}`);
  }
}
