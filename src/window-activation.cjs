const fs = require('node:fs');
const path = require('node:path');
const WINDOW_MS = 300 * 60_000;

// Zero percent can mean unused, or rounded usage. Never retry repeatedly to
// force a particular reset time: each identity gets at most one attempt per 5h.
function eligible(account, now) {
  const usage = account.usageWindows;
  const windows = [usage?.fiveHour, usage?.weekly, ...(usage?.other || [])].filter(Boolean);
  return Boolean(account.accountId && !account.usageError && !account.rateLimitReached
    && Number.isFinite(account.usageAt) && account.usageAt <= now && now - account.usageAt < 60_000
    && usage?.fiveHour?.usedPercent === 0
    && windows.every(w => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent < 100));
}

module.exports = function createActivation({file, accounts, enabled, allowed, busy, activate, refresh, clock = Date.now}) {
  let pending = null;
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || value.version !== 1 || !value.attempts || typeof value.attempts !== 'object') throw Error();
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return {version: 1, attempts: {}};
      // A corrupt ledger must not cause repeated quota consumption.
      throw new Error('Automatic activation ledger could not be read');
    }
  }
  function save(state) {
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', {mode: 0o600});
    fs.renameSync(temp, file);
  }
  async function run(excluded = []) {
    if (!enabled()) return [];
    const denied = new Set(excluded instanceof Set ? excluded : Array.isArray(excluded) ? excluded
      : typeof excluded === 'string' ? [excluded] : Object.keys(excluded || {}).filter(k => excluded[k]));
    const list = accounts();
    if (new Set(list.map(a => a.accountId).filter(Boolean)).size < 2) return [];
    const state = read(), results = [];
    for (const account of list) {
      const now = clock(), identity = account.accountId;
      if (!eligible(account, now) || !allowed(account) || busy(account.id)
        || denied.has(account.id) || denied.has(identity)) continue;
      const previous = state.attempts[identity];
      if (previous && (!Number.isFinite(previous.at) || now < previous.at + WINDOW_MS)) continue;
      // Persist before any network request; timeout/crash/restart must not retry.
      const attempt = {at: now, accountId: account.id, status: 'attempting',
        beforeResetAt: account.usageWindows.fiveHour.resetAt ?? null};
      state.attempts[identity] = attempt;
      save(state);
      try {
        const result = await activate(account);
        const after = result.usageWindows?.fiveHour;
        attempt.status = Number.isFinite(after?.resetAt) && after.resetAt > clock()
          && (after.usedPercent > 0 || after.resetAt !== attempt.beforeResetAt)
          ? 'reset_observed' : 'request_completed_reset_unconfirmed';
        attempt.afterResetAt = after?.resetAt ?? null;
        attempt.afterUsedPercent = after?.usedPercent ?? null;
        attempt.model = result.model ?? null;
      } catch {
        attempt.status = 'failed';
      }
      save(state);
      results.push({...attempt});
    }
    if (results.length) await refresh();
    return results;
  }
  return {
    ensure(excluded) {
      if (!pending) pending = run(excluded).finally(() => { pending = null; });
      return pending;
    },
    read
  };
};
module.exports.eligible = eligible;
