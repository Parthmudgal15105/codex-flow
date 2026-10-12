#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { appendFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { prepare, environment, executable, inspectAll, inspect, root, display } from './accounts.js';
import { setupProject, lockProject, readJson, saveJson, promptFor } from './project.js';
import { runWorker } from './worker.js';
import { recommend, learn } from './optimizer.js';

async function work(path, initialTask) {
  const project = await setupProject(path);
  const release = await lockProject(project);
  const stateFile = join(project.dir, 'state.json');
  const state = await readJson(stateFile, { sessions: {}, preferred: null });
  const input = createInterface({ input: stdin, output: stdout });
  try {
    let task = initialTask;
    console.log(`\nCodex Flow · ${project.cwd}\nShared notes: ${project.notes}\nType /status to see usage, /quit to stop. No break reminders.\n`);
    while (true) {
      if (!task) task = (await input.question('What should we work on? ')).trim();
      if (task === '/quit') break;
      if (!task) continue;
      if (task === '/status') { display(await inspectAll()); task = null; continue; }
      const excluded = new Set();
      let interrupted = true;
      await saveJson(join(project.dir, 'pending.json'), { task, interrupted });
      while (true) {
        const accounts = await inspectAll();
        const emails = accounts.map(a => a.email).filter(Boolean);
        if (emails.length === 2 && emails[0] === emails[1]) throw new Error('Both profiles use the same account. Sign into a different account for B.');
        const history = await readJson(join(root, 'usage-learning.json'), {});
        const recommendation = recommend(accounts, state.preferred, excluded, history);
        const selected = recommendation.account;
        if (!selected) { display(accounts); console.log('\nNo verified available account. Your request is saved; run again when allowance returns.'); await saveJson(join(project.dir, 'pending.json'), { task, interrupted }); process.exitCode = 2; return; }
        console.log(`\nWorking with Account ${selected.name.toUpperCase()} (${selected.email || selected.plan})…`);
        console.log(recommendation.reason);
        const started = Date.now();
        state.preferred = selected.name;
        await saveJson(stateFile, state);
        await appendFile(join(project.dir, 'history.jsonl'), JSON.stringify({ time: new Date().toISOString(), account: selected.name, task }) + '\n', { mode: 0o600 });
        const result = await runWorker({ account: selected.name, cwd: project.cwd, prompt: promptFor(task, interrupted), session: state.sessions[selected.name], logPath: join(project.dir, 'events.jsonl'), onSession: async id => { state.sessions[selected.name] = id; await saveJson(stateFile, state); } });
        const after = await inspect(selected.name);
        const updatedHistory = await readJson(join(root, 'usage-learning.json'), {});
        await saveJson(join(root, 'usage-learning.json'), learn(updatedHistory, selected, after, (Date.now() - started) / 60000));
        if (result.interrupted) { console.log('\nStopped. Project files and session history are preserved.'); return; }
        if (!result.limited) {
          if (result.code !== 0 || result.failure) { console.error(`\nWork stopped: ${result.failure || `Codex exited with code ${result.code}`}. No automatic retry for non-quota errors.`); process.exitCode = 1; return; }
          await saveJson(join(project.dir, 'pending.json'), null);
          break;
        }
        excluded.add(selected.name); interrupted = true;
        console.log('\nAccount allowance reached. Checking the other account before continuing…');
      }
      task = null;
      if (initialTask) break;
    }
  } finally { input.close(); await release(); }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'ui-run') { const { uiRun } = await import('./ui.js'); await uiRun(); }
  else if (command === 'login') {
    const name = args[0]; await prepare(name);
    const child = spawn(executable, ['login', '-c', 'cli_auth_credentials_store="file"'], { env: environment(name), stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code ?? 1)); });
  } else if (command === 'status') {
    const accounts = await inspectAll();
    const history = await readJson(join(root, 'usage-learning.json'), {});
    let preferred = null;
    const index = args.indexOf('--project');
    if (index >= 0 && args[index + 1]) {
      const path = await realpath(args[index + 1]);
      const id = createHash('sha256').update(path).digest('hex');
      const chatIndex = args.indexOf('--chat');
      const chat = chatIndex >= 0 ? args[chatIndex + 1] : null;
      if (chat && !/^[a-zA-Z0-9-]{1,80}$/.test(chat)) throw new Error('Invalid chat identifier.');
      preferred = (await readJson(chat ? join(root, 'projects', id, 'chats', chat, 'state.json') : join(root, 'projects', id, 'state.json'), {})).preferred;
    }
    const decision = recommend(accounts, preferred, new Set(), history);
    const enriched = accounts.map(a => ({ ...a, recommended: a.name === decision.account?.name, recommendationReason: a.name === decision.account?.name ? decision.reason : null }));
    if (args.includes('--json')) console.log(JSON.stringify(enriched));
    else { display(accounts); console.log('\n' + decision.reason); }
  }
  else if (command === 'start') await work(args[0] || process.cwd(), args.slice(1).join(' ') || null);
  else if (command === 'continue') {
    const project = await setupProject(args[0] || process.cwd());
    const pending = await readJson(join(project.dir, 'pending.json'), null);
    if (!pending) throw new Error('No pending request. Use start to begin a task.');
    await work(project.cwd, pending.task);
  } else console.log(`Codex Flow\n\n  codex-flow login a            Sign into your first account\n  codex-flow login b            Sign into your second account\n  codex-flow status             Read both accounts' live usage\n  codex-flow start /path/to/project\n  codex-flow start /path/to/project "Build the login screen"\n  codex-flow continue /path/to/project\n\nUse a Git repository. Codex runs with workspace-write permissions.\nAccount data stays in ~/.codex-flow; your desktop login is untouched.`);
}
main().catch(error => { console.error(`\n${error.message}`); process.exitCode = 1; });
