'use strict';
// كورة برو - خادم مباشر بدون أي اعتماديات (Node 18+)
const http = require('http'), fs = require('fs'), path = require('path');
const { TEAMS, resolve } = require('./teams');

const PORT = +process.env.PORT || 3000;
const TOKEN = process.env.FD_TOKEN || '';
const MOCK = process.env.MOCK === '1' || !TOKEN;           // بدون مفتاح = وضع تجريبي
const COMPS = (process.env.COMPS || 'PL,PD').split(',').map(s => s.trim());
const LIVE_S = +process.env.POLL_LIVE_S || (MOCK ? 2 : 15);  // فاصل التحديث وقت وجود مباراة
const IDLE_S = +process.env.POLL_IDLE_S || (MOCK ? 5 : 60);  // فاصل التحديث في الأوقات الهادئة
const LGS = { PL: { id: 1, n: 'الدوري الإنجليزي', i: '🏴' }, PD: { id: 2, n: 'الدوري الإسباني', i: '🇪🇸' } };
const lgOf = c => LGS[c] || { id: c, n: c, i: '⚽' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const extra = {};
const nm = c => TEAMS[c] ? TEAMS[c][0] : (extra[c] && extra[c].ar) || c;
function teamCode(t) {
  const c = resolve(t.name) || resolve(t.shortName || '');
  if (c) return c;
  const k = t.tla || String(t.id);
  extra[k] = { ar: t.shortName || t.name, c: '#555', logo: t.crest || '' };
  return k;
}
const fT = new Intl.DateTimeFormat('ar-IQ-u-nu-arab', { timeZone: 'Asia/Baghdad', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true });

/* ---------- أدوات الأسماء ---------- */
const PRE = new Set(['van', 'de', 'da', 'di', 'dos', 'der', 'den', 'le', 'la', 'el', 'al', 'von', 'ter', 'ten']);
const short = n => { const p = String(n).trim().split(/\s+/); return p.length > 2 && PRE.has(p[p.length - 2].toLowerCase()) ? p.slice(-2).join(' ') : p[p.length - 1]; };
const grp = p => /goal/i.test(p) ? 'gk' : /def|back/i.test(p) ? 'd' : /mid/i.test(p) ? 'm' : 'f';
function lineup(t) {
  if (!t || !t.lineup || !t.lineup.length) return null;
  const o = { gk: '', d: [], m: [], f: [], b: [] };
  t.lineup.forEach(p => { const g = grp(p.position || ''), n = short(p.name); if (g === 'gk') o.gk = n; else o[g].push(n); });
  (t.bench || []).forEach(p => o.b.push(short(p.name)));
  return o.gk && o.d.length + o.m.length + o.f.length === 10 ? o : null;
}
function stats(h, a) {
  if (!h || !h.statistics || !a || !a.statistics) return null;
  const f = s => [s.ball_possession || 0, s.shots || 0, s.shots_on_goal || 0, s.corner_kicks || 0, s.fouls || 0, s.yellow_cards || 0, s.offsides || 0, s.saves || 0, (s.red_cards || 0) + (s.yellow_red_cards || 0)];
  return [f(h.statistics), f(a.statistics)];
}

/* ---------- المزوّد الحقيقي: football-data.org ---------- */
const hits = [];
const prune = () => { const n = Date.now(); while (hits.length && n - hits[0] > 6e4) hits.shift(); return hits.length; };
async function fd(p) {
  if (prune() >= 9) throw new Error('rate-limit');
  hits.push(Date.now());
  const r = await fetch('https://api.football-data.org/v4' + p, { headers: { 'X-Auth-Token': TOKEN } });
  if (!r.ok) throw new Error('football-data ' + r.status + ' ' + p);
  return r.json();
}
const day = d => new Date(d).toISOString().slice(0, 10);
const FDP = {
  async matches(c, from, to) {
    const j = await fd(`/competitions/${c}/matches?dateFrom=${day(from)}&dateTo=${day(to)}`);
    return (j.matches || []).map(x => ({ id: x.id, lg: c, utc: x.utcDate, st: x.status, min: x.minute, h: x.homeTeam, a: x.awayTeam,
      hs: (x.score && x.score.fullTime && x.score.fullTime.home) || 0, as: (x.score && x.score.fullTime && x.score.fullTime.away) || 0 }));
  },
  async standings(c) {
    const j = await fd(`/competitions/${c}/standings`);
    const tb = (j.standings || []).find(s => s.type === 'TOTAL') || (j.standings || [])[0];
    return tb ? tb.table.map(r => [teamCode(r.team), r.won, r.draw, r.lost, r.points]) : [];
  },
  async detail(id) {
    const x = await fd('/matches/' + id), hid = x.homeTeam && x.homeTeam.id, side = t => t && t.id === hid ? 'h' : 'a';
    const ev = [];
    (x.goals || []).forEach(g => ev.push([g.minute, 'g', side(g.team), g.scorer && g.scorer.name ? short(g.scorer.name) : '']));
    (x.bookings || []).forEach(b => ev.push([b.minute, /RED/.test(b.card) ? 'r' : 'y', side(b.team)]));
    (x.substitutions || []).forEach(s => ev.push([s.minute, 's', side(s.team)]));
    ev.sort((p, q) => p[0] - q[0]);
    return { ev, st: stats(x.homeTeam, x.awayTeam), lu: { h: lineup(x.homeTeam), a: lineup(x.awayTeam) } };
  }
};

/* ---------- المزوّد التجريبي (1 ثانية حقيقية = 1 دقيقة مباراة) ---------- */
const T0 = Date.now();
const MK = [
  [9001, 'PL', 'LFC', 'ARS', -20, [[7, 'a', 'Saka'], [15, 'h', 'Salah'], [40, 'h', 'Diaz']]],
  [9002, 'PL', 'MCI', 'CFC', -60, [[12, 'h', 'Haaland'], [30, 'h', 'Foden'], [44, 'a', 'Palmer'], [62, 'h', 'Doku']]],
  [9003, 'PD', 'BAR', 'RMA', -5, [[20, 'a', 'Mbappe'], [33, 'h', 'Yamal']]],
  [9004, 'PD', 'ATM', 'SEV', 3, [[4, 'h', 'Griezmann'], [9, 'a', 'Ocampos']]],
  [9005, 'PL', 'TOT', 'NEW', 90, [], { pp: 20 }],
  [9006, 'PD', 'VIL', 'VCF', 150, [], { rs: [25, 260] }],
  [9007, 'PD', 'RVC', 'ESP', 200, []]
];
function mockState(m) {
  const [id, c, h, a, k0, gl, o] = m, el = (Date.now() - T0) / 1000;
  const k = o && o.rs && el >= o.rs[0] ? o.rs[1] : k0, e = el - k;
  const mm = e <= 45 ? e : e <= 60 ? 45 : Math.min(e - 15, 90);
  let hs = 0, as = 0;
  if (e >= 0) gl.forEach(g => { if (g[0] <= mm) g[1] === 'h' ? hs++ : as++; });
  const st = o && o.pp && el >= o.pp && e < 0 ? 'POSTPONED' : e < 0 ? 'TIMED' : e > 105 ? 'FINISHED' : e > 45 && e <= 60 ? 'PAUSED' : 'IN_PLAY';
  return { id, lg: c, utc: new Date(T0 + k * 1000).toISOString(), st, min: st === 'IN_PLAY' ? Math.floor(mm) : null, h: { name: TEAMS[h][1] }, a: { name: TEAMS[a][1] }, hs, as, _m: mm, _g: gl, _h: h, _a: a };
}
const mkLu = c => ({ gk: c + ' GK', d: [1, 2, 3, 4].map(i => c + ' D' + i), m: [1, 2, 3].map(i => c + ' M' + i), f: [1, 2, 3].map(i => c + ' F' + i), b: [c + ' B1', c + ' B2'] });
const MOCKP = {
  async matches(c) { return MK.filter(m => m[1] === c).map(mockState).map(({ _m, _g, _h, _a, ...r }) => r); },
  async standings(c) {
    const t = Object.keys(TEAMS).filter(k => TEAMS[k][3] === c);
    return t.map((k, i) => [k, 8 - (i % 6), i % 3, i % 4, (8 - (i % 6)) * 3 + (i % 3)]).sort((a, b) => b[4] - a[4]);
  },
  async detail(id) {
    const m = MK.find(x => x[0] === id); if (!m) throw new Error('no match');
    const s = mockState(m), ev = [];
    m[5].forEach(g => { if (g[0] <= s._m) ev.push([g[0], 'g', g[1], g[2]]); });
    if (s._m >= 25) ev.push([25, 'y', 'a']); if (s._m >= 70) ev.push([70, 's', 'h'], [72, 's', 'a']);
    ev.sort((p, q) => p[0] - q[0]);
    return { ev, st: [[55, 12, 5, 6, 9, 1, 2, 3, 0], [45, 8, 3, 3, 11, 2, 1, 4, 0]], lu: { h: mkLu(m[2]), a: mkLu(m[3]) } };
  }
};
const P = MOCK ? MOCKP : FDP;

/* ---------- الحالة والتنبيهات ---------- */
const SM = { SCHEDULED: 'ns', TIMED: 'ns', IN_PLAY: 'live', LIVE: 'live', PAUSED: 'live', FINISHED: 'ft', AWARDED: 'ft', POSTPONED: 'pp', SUSPENDED: 'pp', CANCELLED: 'cn' };
let M = [], ST = {}, LUT = {}, FEED = [], UPD = null, primed = false, last = '';
const prev = new Map(), mf = {}, lined = new Set(), lutAt = {}, dc = new Map(), clients = new Set();

function mlabel(x) {
  if (x.st === 'PAUSED') return 'استراحة';
  if (x.min != null) return x.min + '′';
  const e = Math.floor((Date.now() - Date.parse(x.utc)) / 6e4);
  return e < 0 ? 'مباشر' : e <= 45 ? e + '′' : e <= 60 ? 'استراحة' : Math.min(e - 15, 90) + '′';
}
const norm = x => { const s = SM[x.st] || 'ns'; return { id: x.id, lg: lgOf(x.lg).id, h: teamCode(x.h), a: teamCode(x.a), s, hs: x.hs, as: x.as, t: x.utc, ml: s === 'live' ? mlabel(x) : '', note: x.st === 'SUSPENDED' ? 'متوقفة' : '' }; };
const send = str => { for (const r of clients) r.write('data: ' + str + '\n\n'); };
function alert(icon, text, id) {
  FEED.unshift({ i: icon, text, at: new Date().toISOString(), id });
  FEED.length = Math.min(FEED.length, 60);
  log(icon, text);
  send(JSON.stringify({ type: 'alert', text: icon + ' ' + text }));
}
const teamsPayload = () => { const o = {}; for (const c in TEAMS) o[c] = { ar: TEAMS[c][0], c: TEAMS[c][2], logo: `/logos/${c}.png` }; return Object.assign(o, extra); };
const state = () => ({ teams: teamsPayload(), leagues: COMPS.map(lgOf), standings: ST, matches: M, lineups: LUT, feed: FEED, at: UPD, mock: MOCK });
function publish() {
  const s = JSON.stringify({ type: 'state', data: state() });
  const key = s.replace(/"at":"[^"]*"/, '');
  if (key !== last) { last = key; send(s); }
}

function update(list) {
  const cur = list.map(norm).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  for (const m of cur) {
    const o = prev.get(m.id), lab = `${nm(m.h)} ${m.hs}-${m.as} ${nm(m.a)}`, vs = `${nm(m.h)} × ${nm(m.a)}`;
    if (primed && o) {
      if (o.s === 'ns' && m.s === 'live') alert('🟢', `انطلقت المباراة: ${vs}`, m.id);
      for (const side of ['h', 'a']) {
        const k = side === 'h' ? 'hs' : 'as';
        if (m[k] > o[k]) {
          (mf[m.id] = mf[m.id] || []).push([parseInt(m.ml) || 0, 'g', side, '']);
          alert('⚽', `هدف! ${nm(m[side])} يسجل — ${lab}${m.ml ? ' (' + m.ml + ')' : ''}`, m.id);
        } else if (m[k] < o[k]) alert('🔁', `إلغاء هدف في مباراة ${vs}، النتيجة الآن ${lab}`, m.id);
      }
      if (o.ml !== 'استراحة' && m.ml === 'استراحة') alert('⏱️', `استراحة بين الشوطين: ${lab}`, m.id);
      if (o.s !== 'ft' && m.s === 'ft') alert('🏁', `انتهت المباراة: ${lab}`, m.id);
      if (o.s !== 'pp' && m.s === 'pp') alert('⏸️', `${m.note || 'تأجيل'} المباراة: ${vs}`, m.id);
      if (o.s !== 'cn' && m.s === 'cn') alert('🚫', `إلغاء المباراة: ${vs}`, m.id);
      if (o.s === 'pp' && m.s === 'ns') alert('📅', `أُعيدت جدولة ${vs} إلى ${fT.format(new Date(m.t))}`, m.id);
      else if (m.s === 'ns' && Math.abs(Date.parse(m.t) - Date.parse(o.t)) > 6e4) alert('🕒', `تغيّر موعد ${vs} إلى ${fT.format(new Date(m.t))}`, m.id);
    }
    prev.set(m.id, m);
  }
  primed = true; M = cur; UPD = new Date().toISOString(); publish();
}

function setLUT(m, d) {
  const when = Date.parse(m.t);
  [['h', m.h], ['a', m.a]].forEach(([s, c]) => { if (d.lu && d.lu[s] && when > (lutAt[c] || 0)) { LUT[c] = d.lu[s]; lutAt[c] = when; } });
}
async function detail(id) {
  const c = dc.get(id), m = M.find(x => x.id === id), ttl = m && m.s === 'live' ? 12e3 : 12e4;
  if (c && Date.now() - c.at < ttl) return c.v;
  let v = { ev: [], st: null, lu: null };
  try { v = await P.detail(id); } catch (e) { log('detail', e.message); }
  if (!v.ev.some(e => e[1] === 'g') && mf[id]) v = { ...v, ev: [...v.ev, ...mf[id]].sort((a, b) => a[0] - b[0]) };
  dc.set(id, { at: Date.now(), v });
  if (m && v.lu) setLUT(m, v);
  return v;
}

/* ---------- حلقات الجلب ---------- */
async function pollMatches() {
  try {
    const now = Date.now(), all = [];
    for (const c of COMPS) all.push(...await P.matches(c, now - 3 * 864e5, now + 7 * 864e5));
    update(all);
    // تعبئة تشكيلات "آخر مباراة" تدريجياً (طلب واحد كل دورة) لاستخدامها كتشكيلة متوقعة
    if (MOCK || prune() <= 4) {
      const t = M.find(m => m.s === 'ft' && !lined.has(m.id) && now - Date.parse(m.t) < 5 * 864e5);
      if (t) { try { setLUT(t, await P.detail(t.id)); lined.add(t.id); publish(); } catch (e) { log('lineup', e.message); } }
    }
  } catch (e) { log('poll error:', e.message); }
  const n = Date.now(), near = M.some(m => m.s === 'live' || (m.s === 'ns' && Date.parse(m.t) - n < 3e5 && Date.parse(m.t) - n > -36e5));
  setTimeout(pollMatches, (near ? LIVE_S : IDLE_S) * 1000);
}
async function pollStandings() {
  for (const c of COMPS) { try { ST[lgOf(c).id] = await P.standings(c); } catch (e) { log('standings', e.message); } }
  publish(); setTimeout(pollStandings, 6e5);
}

/* ---------- خادم HTTP ---------- */
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/state') return json(res, state());
  if (u.pathname === '/healthz') return json(res, { ok: true, mock: MOCK, matches: M.length });
  if (u.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n'); clients.add(res);
    res.write('data: ' + JSON.stringify({ type: 'state', data: state() }) + '\n\n');
    req.on('close', () => clients.delete(res)); return;
  }
  const mt = u.pathname.match(/^\/api\/match\/(\d+)$/);
  if (mt) return json(res, await detail(+mt[1]));
  const f = path.join(PUB, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('.png') ? 'public, max-age=86400' : 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => log(`كورة برو يعمل على المنفذ ${PORT} • ${MOCK ? 'وضع تجريبي (بدون مفتاح FD_TOKEN)' : 'بيانات حقيقية'}`));
setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 25000);
pollMatches(); pollStandings();
