const path = require('node:path');
const store = require('./store.cjs');
const routing = require('./routing.cjs');
const usage = require('./usage.cjs');
module.exports = require('./window-activation.cjs')({
  file: path.join(store.userDataDir(), 'flow-window-activation.json'),
  accounts: () => store.accounts(),
  enabled: () => routing.read().autoRoute,
  allowed: account => routing.isEligible(account, routing.read().learnedIneligible),
  busy: id => require('./flow-routing.cjs').learning.activeAccounts().includes(id),
  async activate(account) {
    const accessToken = await require('./tokens.cjs').accessTokenFor(account);
    if (!accessToken) throw new Error('Account session unavailable');
    return require('./activation-probe.cjs')({...account, accessToken}, {
      binary: require('./login.cjs').codexBinary(),
      normalize: require('./rate-limits.cjs').normalizeAllRateLimits
    });
  },
  refresh: () => usage.refreshAll({force: true})
});
