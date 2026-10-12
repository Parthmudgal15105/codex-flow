import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';
import { executable, environment } from './accounts.js';
export function quotaError(event) {
  if (!['error', 'turn.failed'].includes(event.type)) return false;
  const err = event.error || event;
  return /usage_limit_reached|usage limit|quota exceeded|weekly limit|five.hour limit|5.hour limit/i.test(JSON.stringify(err));
}
export async function runWorker({ account, cwd, prompt, session, logPath, onSession = () => {}, onEvent = null, mode = 'build', images = [] }) {
  const args = ['exec', '--json', '-c', 'cli_auth_credentials_store="file"', '-c', `sandbox_mode="${mode === 'ask' ? 'read-only' : 'workspace-write'}"`];
  for (const path of images) args.push('-i', path);
  if (session) args.push('resume', session, '-'); else args.push('-');
  const child = spawn(executable, args, { cwd, env: environment(account), stdio: ['pipe', 'pipe', onEvent ? 'pipe' : 'inherit'] });
  if (onEvent) child.stderr.on('data', chunk => onEvent({ type: 'diagnostic', text: chunk.toString() }));
  let limited = false, failure = null, interrupted = false, queue = Promise.resolve();
  const stop = () => { interrupted = true; child.kill('SIGINT'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const lines = createInterface({ input: child.stdout });
  let processingError = null;
  lines.on('line', line => {
    queue = queue.then(async () => {
      await appendFile(logPath, line + '\n', { mode: 0o600 });
      let event; try { event = JSON.parse(line); } catch { return; }
      if (onEvent) await onEvent(event);
      if (event.type === 'thread.started') await onSession(event.thread_id);
      if (quotaError(event)) limited = true;
      if (event.type === 'turn.failed') failure = event.error?.message || 'Codex turn failed.';
      if (!onEvent && event.type === 'item.completed') {
        if (event.item?.type === 'agent_message') console.log('\n' + event.item.text);
        else if (event.item?.type === 'command_execution') console.log(`  ${event.item.command} [${event.item.exit_code ?? event.item.status}]`);
        else if (event.item?.type === 'file_change') console.log('  Updated project files');
      }
      if (!onEvent && event.type === 'error') console.error(event.message || event.error?.message || 'Codex reported an error.');
    }).catch(error => { processingError = error; child.kill('SIGINT'); });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    await queue;
    if (processingError) throw processingError;
    return { code, limited, failure, interrupted };
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); lines.close(); }
}
