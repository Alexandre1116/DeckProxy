const { mkdirSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { History, remaining } = require('./metrics');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const uuid = arg('-pluginUUID');
const socket = new WebSocket('ws://127.0.0.1:' + arg('-port'));
const keys = new Map();
const labels = { hour:'Hora', day:'Hoje', week:'Semana', month:'Mês', quota:'Restante' };
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
  const {event, context, payload} = JSON.parse(data);
  switch (event) {
    case 'didReceiveGlobalSettings': config = payload.settings; break;
    case 'willAppear':
    case 'didReceiveSettings': keys.set(context, payload.settings); break;
    case 'willDisappear': keys.delete(context); return;
    case 'keyDown': break;
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
  } catch { throw Error('URL inválido'); }
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
  } catch { throw Error('Sem ligação'); }
  if (!response.ok) throw Error(response.status === 501 ? 'Sem quota' : 'HTTP ' + response.status);
  try { return await response.json(); } catch { throw Error('Formato API'); }
}
async function counts(server, settings) {
  if (!settings.collect) throw Error('Ativar fila');
  const db = openHistory();
  const status = await query(server, settings.key, 'usage-statistics-enabled');
  if (!status['usage-statistics-enabled']) throw Error('Ativar stats');
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
  function title(id, action, text) {
    if (keys.get(id) === action && config === settings) send('setTitle', id, {title:text});
  }
  try {
    if (!settings.key) throw Error('Configurar');
    const server = serverURL(settings.server);
    const results = new Map();
    function shared(key, run) {
      if (!results.has(key)) results.set(key, run());
      return results.get(key);
    }
    const collect = () => shared('counts', () => counts(server, settings));
    const jobs = snapshot.map(async ([id, action]) => {
      const metric = action.metric || 'hour';
      let value;
      try {
        if (metric === 'quota') {
          if (!action.auth) throw Error('Definir ID');
          const response = await shared('quota/' + action.auth, () =>
            query(server, settings.key, 'quota/fetch', {auth_index: action.auth}));
          value = remaining(response, action.window);
        } else {
          value = (await collect())[metric];
        }
      } catch (err) { value = err.message.length > 16 ? 'Erro local' : err.message; }
      title(id, action, labels[metric] + '\n' + value);
    });
    if (settings.collect) jobs.push(collect().catch(() => {}));
    await Promise.all(jobs);
  } catch (err) {
    for (const [id, action] of snapshot) title(id, action, err.message);
  } finally {
    busy = false;
    if (again) { again = false; void refresh(); }
  }
}
setInterval(refresh, 15000);
