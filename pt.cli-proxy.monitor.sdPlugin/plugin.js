const { mkdirSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { History, remaining, codexRemaining, codexWindow } = require('./metrics');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const uuid = arg('-pluginUUID');
const socket = new WebSocket('ws://127.0.0.1:' + arg('-port'));
const keys = new Map();
const weeklyDisplays = new Map();
const quotaCache = new Map();
const manualRefresh = new Set();
const quotaInterval = 2 * 60 * 1000;
const labels = { hour:'Hour', day:'Today', week:'Week', month:'Month', quota:'Remaining', codex5:'Codex 5h', codexweek:'Codex week', codex:'Codex' };
let config = {}, history, busy = false, again = false;
function send(event, context, payload) {
  socket.send(JSON.stringify({ event, context, payload }));
}
socket.onopen = () => {
  socket.send(JSON.stringify({ event: arg('-registerEvent'), uuid }));
  send('getGlobalSettings', uuid);
};
socket.onclose = () => process.exit(0);
socket.onmessage = ({data}) => {
  const {event, context, payload, action} = JSON.parse(data);
  switch (event) {
    case 'didReceiveGlobalSettings': config = payload.settings; break;
    case 'willAppear':
    case 'didReceiveSettings': {
      weeklyDisplays.delete(context);
      const previous = keys.get(context);
      keys.set(context, {settings: payload.settings, action: action || previous?.action});
      break;
    }
    case 'willDisappear': keys.delete(context); weeklyDisplays.delete(context); return;
    case 'keyDown': manualRefresh.add(context); break;
    case 'sendToPlugin':
      if (payload?.type === 'credentials' || payload?.type === 'testConnection') void listCredentials(context, payload);
      return;
    default: return;
  }
  refresh();
};
function openHistory() {
  if (history) return history;
  const dir = path.join(homedir(), '.cliproxy-streamdeck');
  mkdirSync(dir, {recursive:true, mode:0o700});
  history = new History(path.join(dir, 'counts.sqlite'));
  return history;
}
function serverURL(address) {
  try {
    const url = new URL(address || 'http://127.0.0.1:8317');
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) throw Error();
    return url.href.replace(/\/+$/, '');
  } catch { throw Error('Invalid URL'); }
}
async function query(server, key, route, body) {
  const headers = {Authorization:'Bearer ' + key};
  if (body) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(server + '/v0/management/' + route, {
      method: body ? 'POST' : 'GET', headers, body: JSON.stringify(body),
      redirect:'error', signal:AbortSignal.timeout(8000)
    });
  } catch { throw Error('No connection'); }
  if (!response.ok) throw Error(response.status === 501 ? 'No quota' : 'HTTP ' + response.status);
  try { return await response.json(); } catch { throw Error('Invalid API data'); }
}
async function listCredentials(context, payload) {
  const result = {type: payload.type, requestId: payload.requestId};
  try {
    if (!payload.key) throw Error('Enter the management key.');
    if (!payload.server) throw Error('Enter the proxy address.');
    const data = await query(serverURL(payload.server), payload.key, 'auth-files');
    if (!Array.isArray(data.files)) throw Error('Invalid API data');
    result.files = data.files
      .filter(file => typeof file.auth_index === 'string' && file.auth_index)
      .map(file => ({
        index: file.auth_index,
        name: file.label || file.name || file.id || file.auth_index,
        provider: file.provider || file.type || ''
      }));
  } catch (err) {
    const messages = {
      'HTTP 401': 'Management key rejected (HTTP 401).',
      'HTTP 403': 'Management access denied (HTTP 403). Check remote access settings.',
      'HTTP 404': 'Management API not found (HTTP 404). Check the address and CLIProxyAPI version.',
      'No connection': 'Connection failed. Check the address, port, network and HTTPS certificate.',
      'Invalid URL': 'Invalid address. Include http:// or https:// and the port.'
    };
    result.error = messages[err.message] || err.message;
  }
  send('sendToPropertyInspector', context, result);
}
async function fetchCodexQuota(server, key, authIndex) {
  const credentials = await query(server, key, 'auth-files');
  const file = credentials.files?.find(item => item.auth_index === authIndex);
  if (!file) throw Error('Account missing');
  if ((file.provider || file.type || '').toLowerCase() !== 'codex') throw Error('Not Codex');
  let token = file.id_token;
  if (typeof token === 'string') {
    try { token = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
    catch { token = null; }
  }
  const claims = token?.['https://api.openai.com/auth'] ?? token;
  const accountId = file.chatgpt_account_id ?? file.chatgptAccountId ??
    file.metadata?.chatgpt_account_id ?? file.attributes?.chatgpt_account_id ??
    claims?.chatgpt_account_id ?? claims?.chatgptAccountId;
  const header = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'codex-tui/0.149.1'
  };
  if (accountId) header['Chatgpt-Account-Id'] = accountId;
  const response = await query(server, key, 'api-call', {
    auth_index: authIndex,
    method: 'GET',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    header
  });
  const status = response.status_code ?? response.statusCode;
  if (status < 200 || status >= 300 || !Number.isFinite(Number(status))) {
    throw Error(status ? 'Account ' + status : 'Invalid API data');
  }
  try {
    return typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
  } catch { throw Error('Invalid API data'); }
}
async function fetchWeeklyQuota(server, key, authIndex) {
  const credentials = await query(server, key, 'auth-files');
  const file = credentials.files?.find(item => item.auth_index === authIndex);
  if (!file) throw Error('Account missing');
  const provider = String(file.provider || file.type || '').toLowerCase();
  if (provider === 'codex') {
    const response = await fetchCodexQuota(server, key, authIndex);
    const windows = [];
    for (const [period, label] of [['five', '5H'], ['week', 'WK']]) {
      try { windows.push({label, percent:codexWindow(response, period).percent}); }
      catch {}
    }
    if (!windows.length) throw Error('Unavailable');
    return windows;
  }
  const request = {
    claude: {
      url: 'https://api.anthropic.com/api/oauth/usage',
      header: {'anthropic-beta':'oauth-2025-04-20', 'User-Agent':'claude-cli/2.1.280', Accept:'application/json'}
    },
    kimi: {url:'https://api.kimi.com/coding/v1/usages', header:{}},
    'kimi-ai': {url:'https://api.kimi.ai/coding/v1/usages', header:{}},
    xai: {
      url:'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      header:{'x-xai-token-auth':'xai-grok-cli','x-grok-client-version':'1.0.70','User-Agent':'grok-pager/1.0.70 grok-shell/1.0.70'}
    }
  }[provider];
  if (request) {
    const response = await query(server, key, 'api-call', {
      auth_index:authIndex, method:'GET', url:request.url,
      header:{...request.header, Authorization:'Bearer $TOKEN$'}
    });
    const status = Number(response.status_code ?? response.statusCode);
    if (!Number.isFinite(status) || status < 200 || status >= 300) throw Error(status ? 'Account ' + status : 'Invalid API data');
    let data = response.body;
    try { if (typeof data === 'string') data = JSON.parse(data); }
    catch { throw Error('Invalid API data'); }
    const windows = [];
    function add(label, raw) {
      if (raw === null || raw === undefined || raw === '') return;
      const used = Number(raw);
      if (Number.isFinite(used) && used >= 0 && used <= 100) windows.push({label, percent:Math.round(100 - used)});
    }
    if (provider === 'claude') {
      add('5H', data?.five_hour?.utilization);
      add('WK', data?.seven_day?.utilization);
    } else if (provider === 'kimi' || provider === 'kimi-ai') {
      for (const limit of data?.limits ?? []) {
        const duration = Number(limit.window?.duration ?? limit.duration);
        const unit = String(limit.window?.timeUnit ?? limit.timeUnit ?? 'minute').toLowerCase();
        const hours = unit.startsWith('week') ? duration * 168 : unit.startsWith('day') ? duration * 24 :
          unit.startsWith('hour') ? duration : unit.startsWith('sec') ? duration / 3600 : duration / 60;
        const label = hours === 24 ? 'DAY' : hours === 5 ? '5H' : hours === 168 ? 'WK' : '';
        const detail = limit.detail ?? limit;
        const total = Number(detail.limit);
        const rawUsed = detail.used ?? (detail.remaining != null ? total - Number(detail.remaining) : null);
        if (label && total > 0 && rawUsed != null) add(label, Number(rawUsed) * 100 / total);
      }
      const usage = data?.usage;
      if (usage && Number(usage.limit) > 0) {
        const used = usage.used ?? (usage.remaining != null ? Number(usage.limit) - Number(usage.remaining) : null);
        if (used != null && !windows.some(window => window.label === 'WK')) add('WK', 100 * Number(used) / Number(usage.limit));
      }
    } else {
      const config = data?.config;
      const period = config?.currentPeriod ?? config?.current_period;
      if (String(period?.type ?? 'weekly').toLowerCase().includes('weekly')) {
        add('WK', config?.creditUsagePercent ?? config?.credit_usage_percent);
      }
    }
    if (!windows.length) throw Error('Unavailable');
    return windows.slice(0, 2);
  }
  const quota = await query(server, key, 'quota/fetch', {auth_index:authIndex});
  const buckets = (quota.groups ?? []).flatMap(group => group.buckets ?? []);
  const windows = [];
  for (const [label, pattern] of [['5H', /^(5h|5 hours|five.hour)$/i], ['DAY', /^(day|daily|24h|1d)$/i], ['WK', /^(week|weekly|7d|7 days|seven.day)$/i]]) {
    const values = buckets.filter(bucket => pattern.test(String(bucket.window ?? '').trim()))
      .map(bucket => bucket.remainingFraction ?? bucket.remaining_fraction)
      .filter(value => value !== null && value !== undefined && value !== '')
      .map(Number)
      .filter(value => Number.isFinite(value) && value >= 0 && value <= 1);
    if (values.length) windows.push({label, percent:Math.round(Math.min(...values) * 100)});
  }
  if (!windows.length) throw Error('Unavailable');
  return windows.slice(0, 2);
}

async function cachedQuota(server, key, authIndex, force) {
  const cacheKey = JSON.stringify([server, key, authIndex]);
  const previous = quotaCache.get(cacheKey);
  const now = Date.now();
  if (previous && (now < previous.retryAt || (!force && now < previous.updatedAt + quotaInterval))) {
    if (previous.windows) return {windows:previous.windows, stale:!!previous.retryAt};
    throw Error(previous.error);
  }
  try {
    const windows = await fetchWeeklyQuota(server, key, authIndex);
    quotaCache.set(cacheKey, {windows, updatedAt:now, retryAt:0});
    return {windows, stale:false};
  } catch (err) {
    const retryAt = now + (/429/.test(err.message) ? quotaInterval : 60000);
    quotaCache.set(cacheKey, {windows:previous?.windows, updatedAt:previous?.updatedAt ?? 0, retryAt, error:err.message});
    if (previous?.windows) return {windows:previous.windows, stale:true};
    throw err;
  }
}

function weeklyImage(windows, options, dimmed, stale) {
  const good = /^#[0-9a-f]{6}$/i.test(options.goodColor) ? options.goodColor : '#4aebb0';
  const medium = /^#[0-9a-f]{6}$/i.test(options.mediumColor) ? options.mediumColor : '#ffd34e';
  const low = /^#[0-9a-f]{6}$/i.test(options.lowColor) ? options.lowColor : '#fa554f';
  const background = /^#[0-9a-f]{6}$/i.test(options.backgroundColor) ? options.backgroundColor : '#101e22';
  const threshold = Number.isFinite(Number(options.threshold)) ? Math.max(0, Math.min(100, Number(options.threshold))) : 20;
  const mediumThreshold = Number.isFinite(Number(options.mediumThreshold)) ? Math.max(0, Math.min(100, Number(options.mediumThreshold))) : 80;
  const warning = windows.some(window => window.percent <= threshold);
  const flash = warning && options.blink && !dimmed;
  const rows = windows.map((window, i) => {
    const y = windows.length === 1 ? 44 : 17 + i * 72;
    const color = window.percent <= threshold ? low : window.percent < mediumThreshold ? medium : good;
    return `<text x="13" y="${y + 24}" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="#fff">${window.percent}%</text>
      <text x="130" y="${y + 20}" text-anchor="end" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="${color}">${window.label}</text>
      <rect x="13" y="${y + 35}" width="118" height="6" rx="3" fill="#42585c"/>
      <rect x="13" y="${y + 35}" width="${Math.round(118 * window.percent / 100)}" height="6" rx="3" fill="${color}"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="20" fill="${background}"/>
    ${flash ? `<rect width="144" height="144" rx="20" fill="${low}" opacity=".25"/>` : ''}
    ${rows}
    ${stale ? '<text x="130" y="137" text-anchor="end" font-family="Arial,sans-serif" font-size="12" fill="#ffd36e">STALE</text>' : ''}
  </svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

let blinkPhase = false;
setInterval(() => {
  blinkPhase = !blinkPhase;
  for (const [id, display] of weeklyDisplays) {
    if (keys.get(id) !== display.action || !display.options.blink ||
        !display.windows.some(window => window.percent <= Number(display.options.threshold ?? 20))) continue;
    send('setImage', id, {image:weeklyImage(display.windows, display.options, blinkPhase, display.stale)});
  }
}, 750);

function requestsImage(count, period, options) {
  const background = /^#[0-9a-f]{6}$/i.test(options.backgroundColor) ? options.backgroundColor : '#123239';
  const textColor = /^#[0-9a-f]{6}$/i.test(options.requestTextColor) ? options.requestTextColor : '#ffffff';
  const accent = /^#[0-9a-f]{6}$/i.test(options.requestAccentColor) ? options.requestAccentColor : '#8eedc2';
  const label = {hour:'HOUR', day:'TODAY', week:'WEEK', month:'MONTH'}[period];
  const text = String(count);
  const fontSize = text.length > 8 ? 22 : text.length > 6 ? 27 : text.length > 4 ? 33 : 42;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="20" fill="${background}"/>
    ${options.showPeriod !== false ? `<text x="72" y="35" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" fill="${accent}">${label}</text>` : ''}
    <text x="72" y="${options.showPeriod !== false ? 92 : 86}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold" fill="${textColor}">${text}</text>
    <rect x="45" y="120" width="54" height="5" rx="2.5" fill="${accent}"/>
  </svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function codexImage(response) {
  function row(period, label, y) {
    let window;
    try { window = codexWindow(response, period); }
    catch { window = null; }
    const percent = window?.percent;
    const amount = percent === undefined ? '—' : percent + '%';
    let remainingTime = '';
    const reset = Number(window?.resetAt);
    const offset = Number(window?.resetAfter);
    const seconds = Number.isFinite(reset) && reset > 0
      ? Math.max(0, reset - Date.now() / 1000)
      : Number.isFinite(offset) && offset > 0 ? offset : 0;
    if (seconds > 0) {
      remainingTime = seconds >= 86400 ? Math.ceil(seconds / 86400) + 'd' :
        seconds >= 3600 ? Math.ceil(seconds / 3600) + 'h' : Math.ceil(seconds / 60) + 'm';
    }
    const color = percent === undefined ? '#78878c' : percent <= 20 ? '#fa806b' : '#4aebb0';
    const width = percent === undefined ? 0 : Math.round(78 * percent / 100);
    return `<text x="13" y="${y + 23}" font-size="25" font-weight="700" fill="#fff">${amount}</text>
      <text x="130" y="${y + 15}" text-anchor="end" font-size="15" font-weight="700" fill="${color}">${label}</text>
      <text x="130" y="${y + 33}" text-anchor="end" font-size="13" fill="#dbe5e7">${remainingTime}</text>
      <rect x="13" y="${y + 32}" width="78" height="5" rx="2.5" fill="#42585c"/>
      <rect x="13" y="${y + 32}" width="${width}" height="5" rx="2.5" fill="${color}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="20" fill="#101e22"/>
    ${row('five', '5H', 15)}
    <path d="M13 72h118" stroke="#364c50" stroke-width="1"/>
    ${row('week', 'WK', 86)}
  </svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
async function counts(server, settings) {
  if (!settings.collect) throw Error('Enable queue');
  const db = openHistory();
  const status = await query(server, settings.key, 'usage-statistics-enabled');
  if (!status['usage-statistics-enabled']) throw Error('Enable stats');
  for (let batch = 0; batch < 10 && config === settings; batch++) {
    const rows = await query(server, settings.key, 'usage-queue?count=500');
    db.record(server, rows);
    if (rows.length < 500) break;
  }
  return db.counts(server);
}
async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  const settings = config;
  const snapshot = [...keys];
  const forced = new Set(manualRefresh);
  manualRefresh.clear();
  function title(id, action, text) {
    if (keys.get(id) === action && config === settings) send('setTitle', id, {title:text});
  }
  function feedback(id, action, success) {
    if (!forced.has(id)) return;
    if (keys.get(id) === action && config === settings) {
      send(success ? 'showOk' : 'showAlert', id);
    } else if (keys.has(id)) {
      manualRefresh.add(id);
      again = true;
    }
  }
  try {
    if (!settings.key) throw Error('Configure');
    const server = serverURL(settings.server);
    const results = new Map();
    function shared(key, run) {
      if (!results.has(key)) results.set(key, run());
      return results.get(key);
    }
    const collect = () => shared('counts', () => counts(server, settings));
    const jobs = snapshot.map(async ([id, action]) => {
      const suffix = action.action?.split('.').pop();
      const metric = suffix === 'requests'
        ? (['hour', 'day', 'week', 'month'].includes(action.settings.period) ? action.settings.period : 'hour')
        : suffix && suffix !== 'metric' ? suffix : (action.settings.metric || 'hour');
      const options = action.settings;
      let value;
      let failed = false;
      try {
        if (metric === 'weeklyremaining') {
          if (!options.auth) throw Error('Select account');
          const force = snapshot.some(([keyId, keyAction]) => forced.has(keyId) && keyAction.settings.auth === options.auth);
          const result = await shared('weekly/' + options.auth, () =>
            cachedQuota(server, settings.key, options.auth, force));
          if (keys.get(id) === action && config === settings) {
            weeklyDisplays.set(id, {action, options, ...result});
            send('setTitle', id, {title:''});
            send('setImage', id, {image:weeklyImage(result.windows, options, false, result.stale)});
          }
          feedback(id, action, !result.stale);
          return;
        } else if (metric === 'codex') {
          if (!options.auth) throw Error('Select account');
          const response = await shared('codex/' + options.auth, () =>
            fetchCodexQuota(server, settings.key, options.auth));
          if (keys.get(id) === action && config === settings) {
            send('setTitle', id, {title:''});
            send('setImage', id, {image: codexImage(response)});
          }
          feedback(id, action, true);
          return;
        } else if (metric === 'codex5' || metric === 'codexweek') {
          if (!options.auth) throw Error('Select account');
          const response = await shared('codex/' + options.auth, () =>
            fetchCodexQuota(server, settings.key, options.auth));
          value = codexRemaining(response, metric === 'codex5' ? 'five' : 'week');
        } else if (metric === 'quota') {
          if (!options.auth) throw Error('Select account');
          const response = await shared('quota/' + options.auth, () =>
            query(server, settings.key, 'quota/fetch', {auth_index: options.auth}));
          value = remaining(response, options.window);
        } else {
          value = (await collect())[metric];
          if (suffix === 'requests') {
            if (keys.get(id) === action && config === settings) {
              send('setTitle', id, {title:''});
              send('setImage', id, {image:requestsImage(value, metric, options)});
            }
            feedback(id, action, true);
            return;
          }
        }
      } catch (err) { failed = true; value = /429/.test(err.message) ? 'Rate limited' : err.message.length > 16 ? 'Unavailable' : err.message; }
      if ((metric === 'codex' || metric === 'weeklyremaining' || suffix === 'requests') && keys.get(id) === action && config === settings) {
        weeklyDisplays.delete(id);
        send('setImage', id, {});
      }
      title(id, action, (labels[metric] || 'Weekly') + '\n' + value);
      feedback(id, action, !failed);
    });
    if (settings.collect) jobs.push(collect().catch(() => {}));
    await Promise.all(jobs);
  } catch (err) {
    for (const [id, action] of snapshot) {
      if (keys.get(id) === action && config === settings) { weeklyDisplays.delete(id); send('setImage', id, {}); }
      title(id, action, err.message);
      feedback(id, action, false);
    }
  } finally {
    busy = false;
    if (again) { again = false; void refresh(); }
  }
}
setInterval(refresh, 15000);
