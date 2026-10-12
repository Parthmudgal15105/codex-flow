import { mkdir, readFile, writeFile, open, unlink, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './accounts.js';
export async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
export async function saveJson(path, data) { const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); }
export async function setupProject(path, createNotes = true) {
  const cwd = await realpath(path);
  const id = createHash('sha256').update(cwd).digest('hex');
  const dir = join(root, 'projects', id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const notes = join(cwd, 'implementation.md');
  if (createNotes) try { await writeFile(notes, '# Implementation\n\n## Goal\nDescribe the project goal here.\n\n## Decisions and preferences\n\n## Completed\n\n## In progress\n\n## Checks and known issues\n\n## Next steps\n', { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return { cwd, dir, notes };
}
export async function lockProject(project) {
  const file = join(project.dir, 'worker.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close();
      return async () => { await unlink(file).catch(() => {}); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid project lock: ${file}. Inspect it before removing it.`);
      try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') { await unlink(file); continue; } throw err; }
      throw new Error('Another Codex Flow worker is already using this project.');
    }
  }
  throw new Error('Could not acquire project lock.');
}
export function promptFor(task, interrupted = false) {
  return `You are continuing work on this project through Codex Flow.\nRead implementation.md and the actual project files before changing anything. Respect AGENTS.md.\n${interrupted ? 'The previous account stopped during this task. Some operations may already have completed. Inspect the workspace and verify results; do not blindly repeat commands.\n' : ''}Update implementation.md after each meaningful milestone and before your final response. Keep it concise: goal, decisions/preferences, completed work, unfinished work, tests/results, blockers, exact next steps. Never claim a check passed unless run. Preserve unrelated user edits.\n\nUser task:\n${task}`;
}
