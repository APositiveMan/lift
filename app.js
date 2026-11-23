/* Lift — personal fitness, diet & grocery PWA. All data stays on this device (localStorage). */
'use strict';

/* ============================== Utilities ============================== */
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { if (v === null || v === undefined || v === '') return 0; const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; };
const r1 = (n) => Math.round(n * 10) / 10;
const fmtN = (n) => { n = r1(n); return Number.isInteger(n) ? String(n) : n.toFixed(1); };
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const todayKey = () => dayKey(Date.now());
const keyToDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDay = (k) => keyToDate(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDayLong = (k) => {
  if (k === todayKey()) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (k === dayKey(y)) return 'Yesterday';
  const t = new Date(); t.setDate(t.getDate() + 1);
  if (k === dayKey(t)) return 'Tomorrow';
  return keyToDate(k).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
};
const shiftKey = (k, days) => { const d = keyToDate(k); d.setDate(d.getDate() + days); return dayKey(d); };
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; };
const pctDelta = (now, before) => before ? Math.round(((now - before) / before) * 100) : null;
const deltaHtml = (now, before, unit = '') => {
  if (!before && before !== 0) return '<span class="muted">—</span>';
  const d = now - before;
  if (d === 0) return `<span class="muted">same</span>`;
  const p = pctDelta(now, before);
  return `<span class="${d > 0 ? 'delta-up' : 'delta-down'}">${d > 0 ? '▲' : '▼'} ${fmtN(Math.abs(d))}${unit}${p !== null ? ` (${p > 0 ? '+' : ''}${p}%)` : ''}</span>`;
};

/* ============================== Store ============================== */
const STORE_KEY = 'lift_app_v1';

function defaultState() {
  const cats = ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core'].map(name => ({ id: uid(), name }));
  const c = Object.fromEntries(cats.map(x => [x.name, x.id]));
  const ex = (name, catNames) => ({ id: uid(), name, categoryIds: catNames.map(n => c[n]), notes: '' });
  return {
    version: 1,
    categories: cats,
    exercises: [
      ex('Bench Press', ['Chest']), ex('Incline Dumbbell Press', ['Chest', 'Shoulders']),
      ex('Pull-up', ['Back']), ex('Barbell Row', ['Back']),
      ex('Squat', ['Legs']), ex('Romanian Deadlift', ['Legs', 'Back']),
      ex('Overhead Press', ['Shoulders']), ex('Lateral Raise', ['Shoulders']),
      ex('Barbell Curl', ['Arms']), ex('Triceps Pushdown', ['Arms']),
      ex('Plank', ['Core']),
    ],
    sets: [],
    workouts: [],
    activeWorkoutId: null,
    diet: { days: {} },
    grocery: { days: 7, items: [] },
    chat: [],
    settings: { provider: 'gemini', apiKey: '', model: '', weightUnit: 'kg', gistToken: '', gistId: '', lastCloudBackup: 0, lastExport: 0 },
  };
}

let S;
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    S = raw ? JSON.parse(raw) : defaultState();
  } catch (e) { S = defaultState(); }
  const d = defaultState();
  for (const k of Object.keys(d)) if (S[k] === undefined) S[k] = d[k];
  S.settings = Object.assign({}, d.settings, S.settings);
  S.diet = S.diet || { days: {} }; S.diet.days = S.diet.days || {};
  S.grocery = Object.assign({ days: 7, items: [] }, S.grocery);
}
let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
    catch (e) { toast('⚠️ Could not save — storage full? Export a backup in Settings.'); }
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 250);
  scheduleCloudBackup();
}

/* ============================== Auto cloud backup (private GitHub Gist) ============================== */
const GIST_FILE = 'lift-backup.json', GIST_DESC = 'Lift app backup (auto)';
let cloudTimer = null, cloudBusy = false, cloudDirty = false;
const ghHeaders = () => ({ Authorization: `Bearer ${S.settings.gistToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' });
function backupPayload() {
  const copy = JSON.parse(JSON.stringify(S));
  copy.settings.apiKey = ''; copy.settings.gistToken = ''; // never upload secrets
  return JSON.stringify(copy);
}
function scheduleCloudBackup(delay = 15000) {
  if (!S?.settings?.gistToken) return;
  cloudDirty = true; clearTimeout(cloudTimer); cloudTimer = setTimeout(() => cloudBackup(), delay);
}
async function findGist() {
  const res = await fetch('https://api.github.com/gists?per_page=100', { headers: ghHeaders() });
  if (!res.ok) throw new Error(res.status === 401 ? 'GitHub token is invalid or expired' : `GitHub error ${res.status}`);
  const list = await res.json();
  return list.find(g => g.files && g.files[GIST_FILE]) || null;
}
async function cloudBackup(manual = false) {
  const st = S.settings;
  if (!st.gistToken || cloudBusy || !navigator.onLine) return false;
  cloudBusy = true; cloudDirty = false;
  try {
    if (!st.gistId) { const g = await findGist(); if (g) st.gistId = g.id; }
    const body = JSON.stringify({ description: GIST_DESC, files: { [GIST_FILE]: { content: backupPayload() } } });
    let res = st.gistId
      ? await fetch(`https://api.github.com/gists/${st.gistId}`, { method: 'PATCH', headers: ghHeaders(), body })
      : await fetch('https://api.github.com/gists', { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ ...JSON.parse(body), public: false }) });
    if (res.status === 404 && st.gistId) { st.gistId = ''; cloudBusy = false; return cloudBackup(manual); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 401 ? 'GitHub token is invalid or expired' : (data.message || `GitHub error ${res.status}`));
    st.gistId = data.id; st.lastCloudBackup = Date.now();
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
    if (manual) toast('☁️ Backed up to GitHub ✓');
    const el = $('#cloudStatus'); if (el) el.innerHTML = cloudStatusHtml();
    return true;
  } catch (e) {
    if (manual) toast('⚠️ Backup failed: ' + e.message, false, 5000);
    cloudDirty = true; return false;
  } finally { cloudBusy = false; }
}
async function cloudRestore() {
  const st = S.settings;
  if (!st.gistToken) { toast('Paste your GitHub token first'); return; }
  try {
    const g = st.gistId ? { id: st.gistId } : await findGist();
    if (!g) { toast('No Lift backup found on this GitHub account'); return; }
    const res = await fetch(`https://api.github.com/gists/${g.id}`, { headers: ghHeaders() });
    if (!res.ok) throw new Error(`GitHub error ${res.status}`);
    const gist = await res.json(); const f = gist.files[GIST_FILE];
    const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
    const data = JSON.parse(text);
    if (!data.exercises || !data.sets) throw new Error('Backup file is not valid');
    const when = new Date(gist.updated_at).toLocaleString();
    if (!confirm(`Restore backup from ${when}? This replaces the data on this phone.`)) return;
    const keep = { apiKey: st.apiKey, gistToken: st.gistToken };
    data.settings = Object.assign({}, data.settings, keep, { gistId: gist.id, lastCloudBackup: Date.now() });
    localStorage.setItem(STORE_KEY, JSON.stringify(data)); load(); render(); toast('Restored from GitHub ✓');
  } catch (e) { toast('⚠️ Restore failed: ' + e.message, false, 5000); }
}
function cloudStatusHtml() {
  const st = S.settings;
  if (!st.gistToken) return '<span class="muted">Off — paste a token to turn on automatic backups.</span>';
  if (!st.lastCloudBackup) return '<span class="muted">On — first backup will happen shortly.</span>';
  const mins = Math.round((Date.now() - st.lastCloudBackup) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  return `<span style="color:var(--good)">✓ On</span> <span class="muted">· last backup ${ago}</span>`;
}
window.addEventListener('online', () => { if (cloudDirty) scheduleCloudBackup(2000); });
window.addEventListener('pagehide', () => save(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { save(true); if (cloudDirty) { clearTimeout(cloudTimer); cloudBackup(); } }
});

/* ============================== UI state ============================== */
const UI = {
  tab: 'train',
  foodSub: 'diet',
  dietDate: todayKey(),
  trainSearch: '',
  progressEx: null,
  progressMetric: 'weight',
  aiBusy: false,
};

/* ============================== Lookups ============================== */
const catById = (id) => S.categories.find(c => c.id === id);
const exById = (id) => S.exercises.find(e => e.id === id);
const wu = () => S.settings.weightUnit || 'kg';
const vol = (s) => num(s.weight) * num(s.reps);
const setsOf = (exId) => S.sets.filter(s => s.exerciseId === exId).sort((a, b) => a.t - b.t);
const activeWorkout = () => S.workouts.find(w => w.id === S.activeWorkoutId) || null;

function prFlags(set) {
  const prior = S.sets.filter(s => s.exerciseId === set.exerciseId && s.id !== set.id && s.t < set.t);
  if (!prior.length) return [];
  const f = [];
  const w = num(set.weight), r = num(set.reps), v = vol(set);
  if (w > 0 && w > Math.max(...prior.map(s => num(s.weight)))) f.push('weight');
  if (r > 0 && r > Math.max(...prior.map(s => num(s.reps)))) f.push('reps');
  if (v > 0 && v > Math.max(...prior.map(vol))) f.push('volume');
  return f;
}
const PR_LABEL = { weight: '🏆 Heaviest', reps: '🏆 Most reps', volume: '🏆 Best set' };
const prBadges = (flags) => flags.map(f => `<span class="pr">${PR_LABEL[f]}</span>`).join('');

function records(exId) {
  const ss = setsOf(exId);
  if (!ss.length) return null;
  const by = (fn) => ss.reduce((best, s) => (fn(s) > fn(best) ? s : best), ss[0]);
  return { weight: by(s => num(s.weight)), reps: by(s => num(s.reps)), volume: by(vol) };
}

/* ============================== Toast & sheet ============================== */
let toastTimer;
function toast(msg, gold = false, ms = 2600) {
  const t = $('#toast');
  t.innerHTML = esc(msg); t.className = 'toast' + (gold ? ' gold' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
let sheetRender = null;
function openSheet(renderFn) {
  sheetRender = renderFn;
  renderSheet();
  $('#sheet').classList.remove('hidden'); $('#sheetBackdrop').classList.remove('hidden');
  $('#sheet').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}
function renderSheet() {
  if (!sheetRender) return;
  const sh = $('#sheet'); const st = sh.scrollTop;
  sh.innerHTML = '<div class="grabber"></div>' + sheetRender();
  sh.scrollTop = st;
}
function closeSheet() {
  sheetRender = null;
  $('#sheet').classList.add('hidden'); $('#sheetBackdrop').classList.add('hidden');
  $('#sheet').innerHTML = '';
  document.body.style.overflow = '';
  render();
}
const sheetHead = (title, done = true) => `<div class="sheet-head"><h2>${esc(title)}</h2>${done ? '<button class="btn sm ghost" data-act="closeSheet">Done</button>' : ''}</div>`;
$('#sheetBackdrop').addEventListener('click', closeSheet);

/* ============================== Render root ============================== */
const TITLES = { train: 'Train', progress: 'Progress', coach: 'AI Coach', food: 'Food', settings: 'Settings' };
function render() {
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === UI.tab));
  renderBanner();
  const v = $('#view');
  const views = { train: viewTrain, progress: viewProgress, coach: viewCoach, food: viewFood, settings: viewSettings };
  v.innerHTML = views[UI.tab]();
  if (UI.tab === 'coach') { const c = $('#chatEnd'); if (c) c.scrollIntoView({ block: 'end' }); }
}
function renderBanner() {
  const b = $('#workoutBanner'); const w = activeWorkout();
  if (!w) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  const cats = w.categoryIds.map(id => catById(id)?.name).filter(Boolean).join(', ') || 'Workout';
  const n = S.sets.filter(s => s.workoutId === w.id).length;
  b.innerHTML = `<div><div class="wb-title">🔥 ${esc(cats)}</div><div class="wb-sub"><span id="wbTimer">${fmtDur(Date.now() - w.start)}</span> · ${n} set${n === 1 ? '' : 's'}</div></div>
    <button class="btn sm primary" data-act="endWorkout">End workout</button>`;
}
setInterval(() => { const w = activeWorkout(); const t = $('#wbTimer'); if (w && t) t.textContent = fmtDur(Date.now() - w.start); }, 20000);

document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => {
  UI.tab = b.dataset.tab; window.scrollTo(0, 0); render();
}));

/* ============================== TRAIN ============================== */
function viewTrain() {
  const w = activeWorkout();
  let h = '';
  if (!S.settings.gistToken && S.sets.length && Date.now() - (S.settings.lastExport || 0) > 7 * 864e5)
    h += `<div class="notice warn" data-act="goSettings" style="cursor:pointer">☁️ Your progress is only on this phone. <b>Turn on automatic backup</b> in Settings →</div>`;
  if (!w) {
    h += `<button class="btn primary block" data-act="startWorkout" style="padding:15px;font-size:17px">▶ Start workout</button>`;
  } else {
    // Only the exercises you add yourself during this workout
    const exs = workoutExIds(w).map(exById).filter(Boolean);
    h += `<div class="section-title"><h2>This workout</h2></div>`;
    if (!exs.length) h += `<div class="empty" style="padding:14px"><div class="big">➕</div>Add the first exercise you're doing.</div>`;
    for (const e of exs) h += workoutExerciseCard(e, w);
    h += `<button class="btn primary block" data-act="addWorkoutEx" style="margin-bottom:6px">+ Add exercise</button>`;
  }

  // Categories
  h += `<div class="section-title"><h2>Muscle groups</h2><button class="btn sm" data-act="newCategory">+ Group</button></div>`;
  h += `<div class="chips">` + S.categories.map(c => {
    const n = S.exercises.filter(e => e.categoryIds.includes(c.id)).length;
    return `<button class="chip" data-act="editCategory" data-id="${c.id}">${esc(c.name)} <span class="muted">${n}</span></button>`;
  }).join('') + `</div>`;

  // Exercises list
  h += `<div class="section-title"><h2>Exercises</h2><button class="btn sm" data-act="newExercise">+ Exercise</button></div>`;
  h += `<input type="text" placeholder="Search exercises…" value="${esc(UI.trainSearch)}" data-in="trainSearch" style="margin-bottom:10px">`;
  h += `<div id="exList">${exerciseListHtml()}</div>`;

  // Workout history
  const done = S.workouts.filter(x => x.end).sort((a, b) => b.start - a.start).slice(0, 8);
  if (done.length) {
    h += `<div class="section-title"><h2>Recent workouts</h2></div>`;
    for (const x of done) {
      const cats = x.categoryIds.map(id => catById(id)?.name).filter(Boolean).join(', ') || 'Workout';
      const n = S.sets.filter(s => s.workoutId === x.id).length;
      h += `<div class="list-item" data-act="showSummary" data-id="${x.id}"><div class="li-main"><div class="li-title">${esc(cats)}</div>
        <div class="li-sub">${fmtDay(dayKey(x.start))} · ${fmtDur(x.end - x.start)} · ${n} sets</div></div><span class="chev">›</span></div>`;
    }
  }
  return h;
}

function exerciseListHtml() {
  const q = UI.trainSearch.trim().toLowerCase();
  const list = S.exercises.filter(e => !q || e.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) return `<div class="empty"><div class="big">🏋️</div>No exercises found.</div>`;
  return list.map(e => {
    const rec = records(e.id);
    const cats = e.categoryIds.map(id => catById(id)?.name).filter(Boolean);
    return `<div class="list-item" data-act="openExercise" data-id="${e.id}"><div class="li-main">
      <div class="li-title ellipsis">${esc(e.name)}</div>
      <div class="li-sub">${cats.map(c => `<span class="tag">${esc(c)}</span>`).join('') || '<span class="tag">No group</span>'}
      ${rec ? ` · PR ${fmtN(num(rec.weight.weight))} ${wu()}` : ''}</div></div><span class="chev">›</span></div>`;
  }).join('');
}

function workoutExIds(w) {
  if (!w.exerciseIds) w.exerciseIds = [...new Set(S.sets.filter(s => s.workoutId === w.id).sort((a, b) => a.t - b.t).map(s => s.exerciseId))];
  return w.exerciseIds;
}
function workoutExerciseCard(e, w) {
  const today = S.sets.filter(s => s.exerciseId === e.id && s.workoutId === w.id).sort((a, b) => a.t - b.t);
  const last = lastSessionBefore(e.id, w.start);
  const lastTxt = last ? last.sets.map(s => `${fmtN(num(s.weight))}×${s.reps}`).join(', ') : 'first time';
  const prefill = today[today.length - 1] || (last && last.sets[last.sets.length - 1]) || {};
  let h = `<div class="card"><div class="spread"><h3 style="margin:0" data-act="openExercise" data-id="${e.id}">${esc(e.name)} <span class="chev">›</span></h3>
    <button class="btn xs ghost" data-act="removeWorkoutEx" data-id="${e.id}">✕ Remove</button></div>
    <div class="tiny muted" style="margin:2px 0 6px">Last time: ${esc(lastTxt)}</div>`;
  today.forEach((s, i) => {
    h += `<div class="set-row"><div class="set-num">${i + 1}</div><div class="set-main"><b>${fmtN(num(s.weight))}</b> ${wu()} × <b>${s.reps}</b>
      ${s.notes ? `<div class="tiny muted">${esc(s.notes)}</div>` : ''}<div>${prBadges(prFlags(s))}</div></div>
      <button class="icon-btn" data-act="editSet" data-id="${s.id}">✎</button></div>`;
  });
  h += `<div class="quick-set">
    <input type="text" inputmode="decimal" placeholder="${wu()}" id="qw_${e.id}" value="${prefill.weight !== undefined ? esc(prefill.weight) : ''}">
    <input type="text" inputmode="numeric" placeholder="reps" id="qr_${e.id}" value="${prefill.reps !== undefined ? esc(prefill.reps) : ''}">
    <button class="btn primary sm" data-act="quickAddSet" data-id="${e.id}">+ Set</button></div></div>`;
  return h;
}

function lastSessionBefore(exId, beforeT) {
  const prior = S.sets.filter(s => s.exerciseId === exId && s.t < beforeT).sort((a, b) => a.t - b.t);
  if (!prior.length) return null;
  const lastDay = dayKey(prior[prior.length - 1].t);
  return { day: lastDay, sets: prior.filter(s => dayKey(s.t) === lastDay) };
}

function addSet(exId, weight, reps, notes = '', t = Date.now()) {
  const w = activeWorkout();
  const s = { id: uid(), exerciseId: exId, t, weight: num(weight), reps: Math.round(num(reps)), notes, workoutId: w ? w.id : null };
  S.sets.push(s);
  if (w && !workoutExIds(w).includes(exId)) w.exerciseIds.push(exId);
  save();
  const f = prFlags(s);
  if (f.length) toast(`New personal best! ${f.map(x => PR_LABEL[x].replace('🏆 ', '')).join(' · ')} 🏆`, true, 3500);
  else toast('Set logged ✓');
  return s;
}

/* ---- Exercise sheet ---- */
function exerciseSheet(exId) {
  return () => {
    const e = exById(exId); if (!e) return sheetHead('Exercise') + '<p>Deleted.</p>';
    const rec = records(e.id);
    let h = sheetHead('Exercise');
    h += `<label class="field"><span>Name</span><input type="text" value="${esc(e.name)}" data-in="exName" data-id="${e.id}"></label>`;
    h += `<label class="field"><span>Muscle groups</span></label><div class="chips" style="margin:-4px 0 12px">` +
      S.categories.map(c => `<button class="chip ${e.categoryIds.includes(c.id) ? 'on' : ''}" data-act="toggleExCat" data-id="${e.id}" data-cat="${c.id}">${esc(c.name)}</button>`).join('') + `</div>`;
    h += `<label class="field"><span>Notes</span><textarea data-in="exNotes" data-id="${e.id}" placeholder="Setup, seat height, cues…">${esc(e.notes)}</textarea></label>`;

    h += `<h3>Personal bests</h3><div class="pr-cards">
      <div class="pr-card"><div class="v">${rec ? fmtN(num(rec.weight.weight)) : '—'}</div><div class="l">Heaviest (${wu()})${rec ? `<br>×${rec.weight.reps}` : ''}</div></div>
      <div class="pr-card"><div class="v">${rec ? rec.reps.reps : '—'}</div><div class="l">Most reps${rec ? `<br>@ ${fmtN(num(rec.reps.weight))} ${wu()}` : ''}</div></div>
      <div class="pr-card"><div class="v">${rec ? fmtN(vol(rec.volume)) : '—'}</div><div class="l">Best set (${wu()}×reps)${rec ? `<br>${fmtN(num(rec.volume.weight))}×${rec.volume.reps}` : ''}</div></div></div>`;

    const last = setsOf(e.id).slice(-1)[0] || {};
    h += `<div class="card" style="background:var(--card2)"><h3>Add set</h3>
      <div class="grid2"><label class="field"><span>Weight (${wu()})</span><input type="text" inputmode="decimal" id="nsW" value="${last.weight ?? ''}"></label>
      <label class="field"><span>Reps</span><input type="text" inputmode="numeric" id="nsR" value="${last.reps ?? ''}"></label></div>
      <label class="field"><span>Notes</span><input type="text" id="nsN" placeholder="optional"></label>
      <button class="btn primary block" data-act="sheetAddSet" data-id="${e.id}">+ Log set</button></div>`;

    h += `<div class="row" style="margin:6px 0 4px"><button class="btn sm" data-act="viewProgressFor" data-id="${e.id}">📈 Progress graph</button>
      <button class="btn sm" data-act="askCoachAbout" data-id="${e.id}">🤖 How to do it</button></div>`;

    const ss = setsOf(e.id).reverse();
    if (ss.length) {
      h += `<h3 style="margin-top:16px">History</h3>`;
      let cur = null;
      for (const s of ss) {
        const k = dayKey(s.t);
        if (k !== cur) { h += `<div class="date-head">${fmtDay(k)}</div>`; cur = k; }
        h += `<div class="set-row"><div class="set-main"><b>${fmtN(num(s.weight))}</b> ${wu()} × <b>${s.reps}</b>
          <span class="muted small"> = ${fmtN(vol(s))}</span>${s.notes ? `<div class="tiny muted">${esc(s.notes)}</div>` : ''}
          <div>${prBadges(prFlags(s))}</div></div><button class="icon-btn" data-act="editSet" data-id="${s.id}">✎</button></div>`;
      }
    }
    h += `<button class="btn danger block" style="margin-top:20px" data-act="deleteExercise" data-id="${e.id}">Delete exercise</button>`;
    return h;
  };
}

function setSheet(setId) {
  return () => {
    const s = S.sets.find(x => x.id === setId); if (!s) return sheetHead('Set') + '<p>Deleted.</p>';
    const e = exById(s.exerciseId);
    return sheetHead('Edit set') + `<p class="muted" style="margin-top:-6px">${esc(e?.name || '')}</p>
      <div class="grid2"><label class="field"><span>Weight (${wu()})</span><input type="text" inputmode="decimal" value="${esc(s.weight)}" data-in="setWeight" data-id="${s.id}"></label>
      <label class="field"><span>Reps</span><input type="text" inputmode="numeric" value="${esc(s.reps)}" data-in="setReps" data-id="${s.id}"></label></div>
      <label class="field"><span>Date</span><input type="date" value="${dayKey(s.t)}" data-in="setDate" data-id="${s.id}"></label>
      <label class="field"><span>Notes</span><textarea data-in="setNotes" data-id="${s.id}">${esc(s.notes)}</textarea></label>
      <button class="btn danger block" data-act="deleteSet" data-id="${s.id}">Delete set</button>`;
  };
}

function categorySheet(catId) {
  return () => {
    const c = catById(catId); if (!c) return sheetHead('Group') + '<p>Deleted.</p>';
    let h = sheetHead('Muscle group');
    h += `<label class="field"><span>Name</span><input type="text" value="${esc(c.name)}" data-in="catName" data-id="${c.id}"></label>`;
    h += `<label class="field"><span>Exercises in this group (tap to add/remove)</span></label>`;
    const list = [...S.exercises].sort((a, b) => (b.categoryIds.includes(c.id) - a.categoryIds.includes(c.id)) || a.name.localeCompare(b.name));
    h += list.map(e => `<label class="list-item" style="cursor:pointer"><input type="checkbox" ${e.categoryIds.includes(c.id) ? 'checked' : ''} data-in="catEx" data-id="${c.id}" data-ex="${e.id}">
      <div class="li-main"><div class="li-title">${esc(e.name)}</div></div></label>`).join('');
    h += `<button class="btn danger block" style="margin-top:16px" data-act="deleteCategory" data-id="${c.id}">Delete group</button>`;
    return h;
  };
}

/* ---- Add exercise to the running workout ---- */
let pickerSearch = '';
function exercisePickerSheet() {
  const w = activeWorkout(); if (!w) return sheetHead('Add exercise');
  const inW = workoutExIds(w); const q = pickerSearch.trim().toLowerCase();
  const list = S.exercises.filter(e => !inW.includes(e.id) && (!q || e.name.toLowerCase().includes(q)));
  const inGroup = (e) => e.categoryIds.some(c => w.categoryIds.includes(c));
  const row = (e) => `<div class="list-item" data-act="pickWorkoutEx" data-id="${e.id}"><div class="li-main"><div class="li-title">${esc(e.name)}</div>
    <div class="li-sub">${e.categoryIds.map(id => catById(id)?.name).filter(Boolean).map(c => `<span class="tag">${esc(c)}</span>`).join('') || '<span class="tag">No group</span>'}</div></div><span style="color:var(--accent);font-size:22px">+</span></div>`;
  let h = sheetHead('Add exercise');
  h += `<input type="text" id="pickSearch" placeholder="Search or type a new exercise…" value="${esc(pickerSearch)}" data-in="pickSearch" style="margin-bottom:10px">`;
  if (q && !S.exercises.some(e => e.name.toLowerCase() === q))
    h += `<button class="btn block" data-act="createWorkoutEx" style="margin-bottom:10px">＋ Create “${esc(pickerSearch.trim())}”</button>`;
  const a = list.filter(inGroup), b = list.filter(e => !inGroup(e));
  if (a.length) h += `<div class="date-head">${esc(catNames(w.categoryIds))}</div>` + a.map(row).join('');
  if (b.length) h += `<div class="date-head">Other exercises</div>` + b.map(row).join('');
  if (!list.length && !q) h += `<p class="muted small">All your exercises are already in this workout. Type a name above to create a new one.</p>`;
  return h;
}

/* ---- Workout start / end ---- */
let pickCats = [];
function startWorkoutSheet() {
  return sheetHead('Start workout') + `<p class="muted" style="margin-top:-4px">What are you training today?</p>
    <div class="chips" style="margin-bottom:16px">` +
    S.categories.map(c => `<button class="chip ${pickCats.includes(c.id) ? 'on' : ''}" data-act="pickCat" data-id="${c.id}">${esc(c.name)}</button>`).join('') +
    `</div><button class="btn primary block" data-act="confirmStart" ${pickCats.length ? '' : 'disabled'}>▶ Start</button>`;
}

function computeSummary(w) {
  const wsets = S.sets.filter(s => s.workoutId === w.id).sort((a, b) => a.t - b.t);
  const exIds = [...new Set(wsets.map(s => s.exerciseId))];
  const tot = (arr) => ({ sets: arr.length, reps: arr.reduce((a, s) => a + num(s.reps), 0), volume: arr.reduce((a, s) => a + vol(s), 0) });
  const totals = tot(wsets);
  const duration = (w.end || Date.now()) - w.start;

  const prev = S.workouts.filter(x => x.id !== w.id && x.end && x.start < w.start && x.categoryIds.some(c => w.categoryIds.includes(c)))
    .sort((a, b) => b.start - a.start)[0] || null;
  const prevSets = prev ? S.sets.filter(s => s.workoutId === prev.id) : [];
  const prevTotals = prev ? tot(prevSets) : null;

  const good = [], bad = [], missed = [], perEx = [];
  const prs = [];
  for (const s of wsets) { const f = prFlags(s); if (f.length) prs.push({ ex: exById(s.exerciseId)?.name, set: `${fmtN(num(s.weight))}${wu()}×${s.reps}`, flags: f }); }
  if (prs.length) good.push(...prs.map(p => `New PR on ${p.ex}: ${p.set} (${p.flags.map(f => PR_LABEL[f].replace('🏆 ', '').toLowerCase()).join(', ')})`));

  for (const exId of exIds) {
    const e = exById(exId); if (!e) continue;
    const today = wsets.filter(s => s.exerciseId === exId);
    const last = lastSessionBefore(exId, w.start);
    const tBest = Math.max(...today.map(s => num(s.weight)));
    const tVol = today.reduce((a, s) => a + vol(s), 0);
    const row = { name: e.name, sets: today.length, best: tBest, volume: tVol, lastBest: null, lastVolume: null, lastSets: null };
    if (last) {
      row.lastBest = Math.max(...last.sets.map(s => num(s.weight)));
      row.lastVolume = last.sets.reduce((a, s) => a + vol(s), 0);
      row.lastSets = last.sets.length;
      if (tVol > row.lastVolume || tBest > row.lastBest) good.push(`${e.name}: improved vs last time (${fmtN(row.lastVolume)} → ${fmtN(tVol)} total ${wu()})`);
      else if (tVol < row.lastVolume && tBest <= row.lastBest) bad.push(`${e.name}: less volume than last time (${fmtN(row.lastVolume)} → ${fmtN(tVol)} ${wu()})`);
      if (today.length < last.sets.length) bad.push(`${e.name}: ${today.length} set${today.length === 1 ? '' : 's'} vs ${last.sets.length} last time`);
    } else {
      good.push(`${e.name}: first time logged — baseline set`);
    }
    perEx.push(row);
  }

  // Missed: exercises from these groups you did last time but not today; groups with zero sets
  if (prev) {
    const prevExIds = [...new Set(prevSets.map(s => s.exerciseId))];
    for (const id of prevExIds) {
      const e = exById(id);
      if (e && !exIds.includes(id) && e.categoryIds.some(c => w.categoryIds.includes(c))) missed.push(`${e.name} (you did it last ${catNames(prev.categoryIds)} session)`);
    }
  }
  for (const cid of w.categoryIds) {
    const hit = wsets.some(s => exById(s.exerciseId)?.categoryIds.includes(cid));
    if (!hit) missed.push(`No sets logged for ${catById(cid)?.name || 'a selected group'}`);
  }
  if (!wsets.length) bad.push('No sets were logged in this workout.');

  return {
    duration, totals, perEx, good, bad, missed,
    prev: prev ? { id: prev.id, day: dayKey(prev.start), duration: prev.end - prev.start, totals: prevTotals, cats: catNames(prev.categoryIds) } : null,
  };
}
const catNames = (ids) => ids.map(id => catById(id)?.name).filter(Boolean).join(', ');

function summarySheet(wId) {
  return () => {
    const w = S.workouts.find(x => x.id === wId); if (!w) return sheetHead('Summary');
    const s = computeSummary(w);
    const li = (arr, empty) => arr.length ? `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="muted small" style="margin:0">${empty}</p>`;
    let h = sheetHead('Workout summary');
    h += `<p class="muted" style="margin-top:-6px">${esc(catNames(w.categoryIds))} · ${fmtDay(dayKey(w.start))}</p>`;
    const p = s.prev?.totals;
    h += `<div class="grid2" style="margin-bottom:14px">
      <div class="stat"><div class="l">Duration</div><div class="v">${fmtDur(s.duration)}</div><div class="tiny">${s.prev ? deltaHtml(Math.round(s.duration / 60000), Math.round(s.prev.duration / 60000), ' min') : ''}</div></div>
      <div class="stat"><div class="l">Sets</div><div class="v">${s.totals.sets}</div><div class="tiny">${p ? deltaHtml(s.totals.sets, p.sets) : ''}</div></div>
      <div class="stat"><div class="l">Reps</div><div class="v">${s.totals.reps}</div><div class="tiny">${p ? deltaHtml(s.totals.reps, p.reps) : ''}</div></div>
      <div class="stat"><div class="l">Volume (${wu()})</div><div class="v">${fmtN(s.totals.volume)}</div><div class="tiny">${p ? deltaHtml(s.totals.volume, p.volume) : ''}</div></div></div>`;
    h += `<p class="small muted" style="margin-top:-6px">${s.prev ? `Compared with your last ${esc(s.prev.cats)} workout on ${fmtDay(s.prev.day)}.` : 'No earlier workout for these muscle groups to compare with yet.'}</p>`;
    h += `<div class="sum-block"><h3>✅ What went well</h3>${li(s.good, 'Nothing stood out — log more sets to get feedback.')}</div>`;
    h += `<div class="sum-block"><h3>⚠️ What could be better</h3>${li(s.bad, 'Nothing went backwards. 💪')}</div>`;
    h += `<div class="sum-block"><h3>❓ Missed</h3>${li(s.missed, 'You didn’t skip anything.')}</div>`;
    if (s.perEx.length) {
      h += `<div class="sum-block"><h3>Per exercise</h3>` + s.perEx.map(r => `<div class="set-row"><div class="set-main"><b>${esc(r.name)}</b>
        <div class="tiny muted">${r.sets} sets · top ${fmtN(r.best)} ${wu()} · vol ${fmtN(r.volume)}</div></div>
        <div class="tiny" style="text-align:right">${r.lastVolume !== null ? deltaHtml(r.volume, r.lastVolume) : '<span class="muted">new</span>'}</div></div>`).join('') + `</div>`;
    }
    h += `<div class="card" style="background:var(--card2)"><h3>🤖 AI coach review</h3>`;
    if (w.aiReview) h += `<div class="small">${md(w.aiReview)}</div>`;
    h += `<button class="btn sm ${w.aiReview ? 'ghost' : 'primary'}" data-act="aiReview" data-id="${w.id}" ${UI.aiBusy ? 'disabled' : ''}>${UI.aiBusy ? 'Thinking…' : w.aiReview ? 'Regenerate' : 'Get AI feedback'}</button></div>`;
    h += `<button class="btn danger block" style="margin-top:8px" data-act="deleteWorkout" data-id="${w.id}">Delete workout record</button>`;
    return h;
  };
}

/* ============================== PROGRESS ============================== */
const METRICS = {
  weight: { label: 'Max weight', fn: (ss) => Math.max(...ss.map(s => num(s.weight))), unit: () => wu() },
  reps: { label: 'Max reps', fn: (ss) => Math.max(...ss.map(s => num(s.reps))), unit: () => 'reps' },
  set: { label: 'Best set', fn: (ss) => Math.max(...ss.map(vol)), unit: () => `${wu()}×reps` },
  volume: { label: 'Total volume', fn: (ss) => ss.reduce((a, s) => a + vol(s), 0), unit: () => wu() },
};

function viewProgress() {
  const withSets = S.exercises.filter(e => S.sets.some(s => s.exerciseId === e.id)).sort((a, b) => a.name.localeCompare(b.name));
  if (!withSets.length) return `<div class="empty"><div class="big">📈</div>Log some sets and your progress graphs will appear here.</div>`;
  if (!UI.progressEx || !withSets.find(e => e.id === UI.progressEx)) UI.progressEx = withSets[0].id;
  const e = exById(UI.progressEx);
  const m = METRICS[UI.progressMetric];
  const days = {};
  for (const s of setsOf(e.id)) (days[dayKey(s.t)] ||= []).push(s);
  const pts = Object.keys(days).sort().map(k => ({ x: k, y: m.fn(days[k]) }));
  const rec = records(e.id);

  let h = `<select data-in="progressEx" style="margin-bottom:10px">${withSets.map(x => `<option value="${x.id}" ${x.id === e.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
  h += `<div class="seg">${Object.entries(METRICS).map(([k, v]) => `<button class="${k === UI.progressMetric ? 'on' : ''}" data-act="metric" data-id="${k}">${v.label}</button>`).join('')}</div>`;
  h += `<div class="card"><div class="spread"><h3 style="margin:0">${esc(m.label)}</h3><span class="muted small">${esc(m.unit())}</span></div>
    <div class="chart-wrap">${lineChart(pts)}</div></div>`;
  h += `<div class="pr-cards">
    <div class="pr-card"><div class="v">${fmtN(num(rec.weight.weight))}</div><div class="l">Heaviest ${wu()}</div></div>
    <div class="pr-card"><div class="v">${rec.reps.reps}</div><div class="l">Most reps</div></div>
    <div class="pr-card"><div class="v">${fmtN(vol(rec.volume))}</div><div class="l">Best set</div></div></div>`;

  // Weekly volume overall
  const weeks = {};
  for (const s of S.sets) {
    const d = new Date(s.t); const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const k = dayKey(mon); weeks[k] = (weeks[k] || 0) + vol(s);
  }
  const wpts = Object.keys(weeks).sort().slice(-12).map(k => ({ x: k, y: weeks[k] }));
  h += `<div class="card"><div class="spread"><h3 style="margin:0">Weekly volume — all exercises</h3><span class="muted small">${wu()}</span></div>
    <div class="chart-wrap">${lineChart(wpts, true)}</div></div>`;

  const nW = S.workouts.filter(w => w.end).length;
  h += `<div class="grid3"><div class="stat"><div class="l">Workouts</div><div class="v">${nW}</div></div>
    <div class="stat"><div class="l">Sets</div><div class="v">${S.sets.length}</div></div>
    <div class="stat"><div class="l">Exercises</div><div class="v">${withSets.length}</div></div></div>`;
  return h;
}

function lineChart(pts, bars = false) {
  const W = 340, H = 190, L = 40, R = 10, T = 12, B = 26;
  if (!pts.length) return `<p class="muted small">No data yet.</p>`;
  const ys = pts.map(p => p.y);
  let min = bars ? 0 : Math.min(...ys), max = Math.max(...ys);
  if (min === max) { min = Math.max(0, min - 1); max = max + 1; }
  const padY = (max - min) * 0.1; if (!bars) min = Math.max(0, min - padY); max += padY;
  const x = (i) => pts.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min));
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4, yy = y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#2a2f3a" stroke-width="1"/>`;
    g += `<text x="${L - 6}" y="${yy + 4}" fill="#8b92a1" font-size="10" text-anchor="end">${v >= 1000 ? fmtN(v / 1000) + 'k' : fmtN(v)}</text>`;
  }
  const labelIdx = [...new Set([0, Math.floor((pts.length - 1) / 2), pts.length - 1])];
  for (const i of labelIdx) {
    const d = keyToDate(pts[i].x);
    g += `<text x="${x(i)}" y="${H - 8}" fill="#8b92a1" font-size="10" text-anchor="middle">${d.getDate()}/${d.getMonth() + 1}</text>`;
  }
  if (bars) {
    const bw = Math.max(4, Math.min(22, (W - L - R) / pts.length - 6));
    pts.forEach((p, i) => { const yy = y(p.y); g += `<rect x="${x(i) - bw / 2}" y="${yy}" width="${bw}" height="${y(min) - yy}" rx="3" fill="#ff6a3d" opacity=".85"/>`; });
  } else {
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
    const area = `${path} L${x(pts.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z`;
    g += `<defs><linearGradient id="gr" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff6a3d" stop-opacity=".35"/><stop offset="1" stop-color="#ff6a3d" stop-opacity="0"/></linearGradient></defs>`;
    if (pts.length > 1) g += `<path d="${area}" fill="url(#gr)"/><path d="${path}" fill="none" stroke="#ff6a3d" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    const maxY = Math.max(...ys);
    pts.forEach((p, i) => { g += `<circle cx="${x(i)}" cy="${y(p.y)}" r="${p.y === maxY ? 5 : 3.5}" fill="${p.y === maxY ? '#ffd34d' : '#ff6a3d'}" stroke="#0f1115" stroke-width="1.5"/>`; });
    const li = pts.length - 1;
    g += `<text x="${Math.min(x(li), W - R - 2)}" y="${y(pts[li].y) - 9}" fill="#eef0f4" font-size="11" font-weight="700" text-anchor="end">${fmtN(pts[li].y)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

/* ============================== COACH (AI chat) ============================== */
const COACH_SYSTEM = `You are an expert strength & conditioning coach inside a personal workout app.
When the user asks about an exercise, answer in clear Markdown with these sections:
## How to do it (numbered step-by-step setup and execution)
## Form tips & tricks (cues, breathing, tempo, grip/stance, mind-muscle tips)
## Common mistakes (and how to fix each)
## Muscles worked
## Programming (typical sets × reps for strength vs. hypertrophy, progression advice)
## Safer alternatives / variations
## Video
In the Video section, name 1–2 reputable YouTube creators known for good technique explanations of this exercise (e.g. Jeff Nippard, Squat University, Alan Thrall, Renaissance Periodization, Athlean-X, Mind Pump) — do NOT invent video URLs.
For other fitness questions, answer helpfully and concisely. Mention seeing a professional for pain or injury.
On the very last line, ALWAYS output exactly: YOUTUBE_QUERY: <best YouTube search query for a proper-form tutorial of the main exercise discussed>`;

function viewCoach() {
  let h = '';
  if (!S.settings.apiKey) h += `<div class="notice warn">Add a free AI key in <b>Settings</b> to use the coach (takes ~1 minute).</div>`;
  if (S.chat.length) h += `<div style="text-align:right;margin-bottom:6px"><button class="btn xs ghost" data-act="clearChat">Clear chat</button></div>`;
  h += `<div class="chat">`;
  if (!S.chat.length) {
    h += `<div class="empty"><div class="big">🤖</div>Ask how to do any exercise — you'll get step-by-step form, tips, common mistakes and a YouTube tutorial link.</div>
      <div class="chips" style="justify-content:center">${['How do I do a Romanian deadlift?', 'Proper bench press form', 'Best exercises for side delts', 'How to do a Bulgarian split squat'].map(q => `<button class="chip" data-act="coachQuick" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
  }
  for (const m of S.chat) h += chatMsgHtml(m);
  if (UI.aiBusy && UI.tab === 'coach') h += `<div class="msg assistant typing">Thinking…</div>`;
  h += `<div id="chatEnd"></div></div>`;
  h += `<div class="chat-input"><textarea id="chatBox" rows="1" placeholder="Ask about an exercise…"></textarea>
    <button class="btn primary" data-act="sendChat" ${UI.aiBusy ? 'disabled' : ''}>Send</button></div>`;
  return h;
}
function chatMsgHtml(m) {
  if (m.role === 'user') return `<div class="msg user">${esc(m.content)}</div>`;
  let text = m.content, q = null;
  const match = text.match(/YOUTUBE_QUERY:\s*(.+)\s*$/i);
  if (match) { q = match[1].trim().replace(/^["']|["']$/g, ''); text = text.slice(0, match.index).trim(); }
  let h = `<div class="msg assistant">${md(text)}`;
  if (q) h += `<a class="yt-btn" href="https://www.youtube.com/results?search_query=${encodeURIComponent(q)}" target="_blank" rel="noopener">▶ Watch on YouTube: ${esc(q)}</a>`;
  return h + `</div>`;
}
async function sendChat(text) {
  text = (text || '').trim(); if (!text || UI.aiBusy) return;
  if (!S.settings.apiKey) { toast('Add your AI key in Settings first'); UI.tab = 'settings'; render(); return; }
  S.chat.push({ role: 'user', content: text }); save();
  UI.aiBusy = true; render();
  try {
    const reply = await aiCall({ system: COACH_SYSTEM, messages: S.chat.slice(-12) });
    S.chat.push({ role: 'assistant', content: reply });
  } catch (e) {
    S.chat.push({ role: 'assistant', content: `⚠️ ${e.message}` });
  }
  UI.aiBusy = false; save(); render();
}

/* ============================== FOOD ============================== */
const MEAL_TYPES = {
  breakfast: { label: 'Breakfast', emoji: '🍳', order: 1 },
  lunch: { label: 'Lunch', emoji: '🍱', order: 3 },
  dinner: { label: 'Dinner', emoji: '🍽️', order: 5 },
  snack: { label: 'Snack', emoji: '🍎', order: 4 },
  vitamin: { label: 'Vitamins / supplements', emoji: '💊', order: 6 },
};
const UNITS = ['g', 'kg', 'mg', 'mcg', 'ml', 'l', 'fl oz', 'oz', 'lb', 'pcs', 'slice', 'cup', 'tbsp', 'tsp', 'scoop', 'serving', 'portion', 'handful', 'pinch', 'clove', 'can', 'jar', 'bottle', 'pack', 'bag', 'box', 'bunch', 'dozen', 'capsule', 'tablet', 'softgel', 'drop', 'IU'];
const MACROS = [['kcal', 'kcal'], ['protein', 'Protein g'], ['carbs', 'Carbs g'], ['fat', 'Fat g'], ['fiber', 'Fiber g'], ['sugar', 'Sugar g']];
const unitSelect = (val, attrs) => `<select ${attrs}>${UNITS.map(u => `<option ${u === val ? 'selected' : ''}>${u}</option>`).join('')}</select>`;

function viewFood() {
  let h = `<div class="seg"><button class="${UI.foodSub === 'diet' ? 'on' : ''}" data-act="foodSub" data-id="diet">🥗 Diet</button>
    <button class="${UI.foodSub === 'grocery' ? 'on' : ''}" data-act="foodSub" data-id="grocery">🛒 Grocery list</button></div>`;
  return h + (UI.foodSub === 'diet' ? viewDiet() : viewGrocery());
}

const dietDay = (k, create = false) => { if (!S.diet.days[k] && create) S.diet.days[k] = { meals: [] }; return S.diet.days[k]; };
const mealTotals = (meal) => { const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 }; for (const p of meal.products) for (const k in t) t[k] += num(p[k]); return t; };
const sortMeals = (meals) => [...meals].sort((a, b) => (MEAL_TYPES[a.type].order - MEAL_TYPES[b.type].order) || (a.created - b.created));

function viewDiet() {
  const k = UI.dietDate; const day = dietDay(k);
  let h = `<div class="date-nav"><button class="btn sm" data-act="dietShift" data-id="-1">‹</button>
    <div style="text-align:center"><div class="d">${esc(fmtDayLong(k))}</div>${k !== todayKey() ? `<button class="btn xs ghost" data-act="dietToday" style="margin-top:3px">Go to today</button>` : `<div class="tiny muted">${fmtDay(k)}</div>`}</div>
    <button class="btn sm" data-act="dietShift" data-id="1">›</button></div>`;
  const meals = day ? sortMeals(day.meals) : [];
  const eaten = { kcal: 0, protein: 0, carbs: 0, fat: 0 }, plan = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const m of meals) { const t = mealTotals(m); for (const x in plan) { plan[x] += t[x]; if (m.eaten) eaten[x] += t[x]; } }
  h += `<div class="card"><div class="macro-bar">${[['kcal', 'kcal'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']].map(([x, l]) =>
    `<div class="m"><div class="v">${Math.round(eaten[x])}</div><div class="l">${l}${x === 'kcal' ? '' : ' g'}</div><div class="p">of ${Math.round(plan[x])} planned</div></div>`).join('')}</div></div>`;

  if (!meals.length) {
    const prevKey = Object.keys(S.diet.days).filter(d => d < k && S.diet.days[d].meals.length).sort().pop();
    h += `<div class="empty"><div class="big">🥗</div>No meals for this day yet.</div>`;
    if (prevKey) h += `<button class="btn block" style="margin-bottom:8px" data-act="copyDay" data-id="${prevKey}">⧉ Copy meals from ${fmtDay(prevKey)}</button>`;
  }
  for (const m of meals) {
    const t = mealTotals(m); const mt = MEAL_TYPES[m.type];
    h += `<div class="meal ${m.eaten ? 'eaten' : ''}"><input type="checkbox" ${m.eaten ? 'checked' : ''} data-in="mealEaten" data-id="${m.id}" aria-label="Eaten">
      <div class="li-main grow" data-act="openMeal" data-id="${m.id}" style="cursor:pointer"><div class="li-title ellipsis">${mt.emoji} ${esc(m.name || mt.label)}</div>
      <div class="li-sub">${m.products.length} item${m.products.length === 1 ? '' : 's'} · ${Math.round(t.kcal)} kcal · P ${fmtN(t.protein)} · C ${fmtN(t.carbs)} · F ${fmtN(t.fat)}</div></div>
      <span class="chev" data-act="openMeal" data-id="${m.id}">›</span></div>`;
  }
  h += `<div class="section-title"><h2>Add</h2></div><div class="chips">` +
    Object.entries(MEAL_TYPES).map(([t, v]) => `<button class="chip" data-act="addMeal" data-id="${t}">${v.emoji} ${v.label.split(' /')[0]}</button>`).join('') + `</div>`;
  if (meals.some(m => m.products.length)) h += `<button class="btn block" style="margin-top:14px" data-act="aiMacrosDay" ${UI.aiBusy ? 'disabled' : ''}>${UI.aiBusy ? 'Calculating…' : '🤖 Calculate all macros with AI'}</button>`;
  return h;
}

function findMeal(id) { for (const k in S.diet.days) { const m = S.diet.days[k].meals.find(x => x.id === id); if (m) return { meal: m, key: k }; } return null; }

function mealSheet(mealId) {
  return () => {
    const f = findMeal(mealId); if (!f) return sheetHead('Meal') + '<p>Deleted.</p>';
    const m = f.meal; const t = mealTotals(m);
    let h = sheetHead(MEAL_TYPES[m.type].emoji + ' ' + MEAL_TYPES[m.type].label, false);
    h += `<div class="grid2"><label class="field"><span>Type</span><select data-in="mealType" data-id="${m.id}">${Object.entries(MEAL_TYPES).map(([k, v]) => `<option value="${k}" ${k === m.type ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      <label class="field"><span>Name</span><input type="text" value="${esc(m.name)}" placeholder="${MEAL_TYPES[m.type].label}" data-in="mealName" data-id="${m.id}"></label></div>
      <label class="row" style="margin-bottom:12px"><input type="checkbox" ${m.eaten ? 'checked' : ''} data-in="mealEaten" data-id="${m.id}"> <span>Eaten</span></label>`;
    h += `<div class="card" style="background:var(--card2)"><div class="macro-bar">${[['kcal', 'kcal'], ['protein', 'Protein g'], ['carbs', 'Carbs g'], ['fat', 'Fat g']].map(([x, l]) => `<div class="m"><div class="v" id="mt_${x}">${Math.round(t[x])}</div><div class="l">${l}</div></div>`).join('')}</div>
      <div class="tiny muted" style="text-align:center;margin-top:6px" id="mt_extra">Fiber ${fmtN(t.fiber)} g · Sugar ${fmtN(t.sugar)} g</div></div>`;
    const busy = (id) => UI.aiBusy && UI.aiTarget === id;
    h += `<div class="row" style="margin:14px 0 8px"><h3 style="margin:0">Products</h3>
      ${m.products.length ? `<button class="btn xs ghost" style="white-space:nowrap" data-act="aiMacrosMeal" data-id="${m.id}" ${UI.aiBusy ? 'disabled' : ''}>${busy(m.id) ? 'Calculating…' : '🤖 Calculate all macros with AI'}</button>` : ''}</div>`;
    if (!m.products.length) h += `<p class="muted small">Add the foods in this meal with exact amounts, then let AI calculate the macros.</p>`;
    m.products.forEach((p) => {
      h += `<div class="product-edit"><div class="row"><input type="text" class="grow" placeholder="Product (e.g. Oats, Greek yogurt 2%)" value="${esc(p.name)}" data-in="prod" data-f="name" data-m="${m.id}" data-id="${p.id}">
        <button class="icon-btn" data-act="delProduct" data-m="${m.id}" data-id="${p.id}">✕</button></div>
        <div class="qty-row"><input type="text" inputmode="decimal" placeholder="Amount" value="${esc(p.qty)}" data-in="prod" data-f="qty" data-m="${m.id}" data-id="${p.id}">
        ${unitSelect(p.unit, `data-in="prod" data-f="unit" data-m="${m.id}" data-id="${p.id}"`)}</div>
        <div class="tiny muted" style="margin-top:8px">✏️ Macros for this amount — type them in yourself, or use AI below</div>
        <div class="macros">${MACROS.map(([k, l]) => `<label><span>${l}</span><input type="text" inputmode="decimal" placeholder="0" value="${p[k] === '' || p[k] === undefined ? '' : esc(p[k])}" data-in="prod" data-f="${k}" data-m="${m.id}" data-id="${p.id}"></label>`).join('')}</div>
        <button class="btn xs ghost" style="margin-top:8px" data-act="aiMacrosProduct" data-m="${m.id}" data-id="${p.id}" ${UI.aiBusy ? 'disabled' : ''}>${busy(p.id) ? 'Calculating…' : '🤖 Calculate with AI'}</button></div>`;
    });
    h += `<button class="btn ghost block" data-act="addProduct" data-id="${m.id}">+ Add product</button>`;
    h += `<button class="btn primary block" style="margin-top:12px" data-act="saveMeal">Save</button>`;
    h += `<button class="btn danger block" style="margin-top:16px" data-act="deleteMeal" data-id="${m.id}">Delete</button>`;
    return h;
  };
}

function updateMealTotalsInSheet(m) {
  const t = mealTotals(m);
  for (const x of ['kcal', 'protein', 'carbs', 'fat']) { const el = $('#mt_' + x); if (el) el.textContent = Math.round(t[x]); }
  const ex = $('#mt_extra'); if (ex) ex.textContent = `Fiber ${fmtN(t.fiber)} g · Sugar ${fmtN(t.sugar)} g`;
}

async function aiMacros(products, target = null) {
  if (!S.settings.apiKey) { toast('Add your AI key in Settings first'); return; }
  const items = [];
  products.forEach(p => { if (p.name.trim()) items.push({ ref: p, desc: `${p.name} — ${p.qty || '?'} ${p.unit}` }); });
  if (!items.length) { toast('Type the product name first'); return; }
  UI.aiBusy = true; UI.aiTarget = target; renderSheet(); render();
  try {
    const prompt = `Estimate nutrition for each food item for EXACTLY the stated amount. Use standard nutrition databases (USDA etc.). For supplements/vitamins, kcal and macros are usually 0 unless they contain calories.
Items:
${items.map((it, i) => `${i}. ${it.desc}`).join('\n')}
Reply with ONLY JSON: {"items":[{"i":0,"kcal":0,"protein":0,"carbs":0,"fat":0,"fiber":0,"sugar":0}, ...]} — numbers only, grams for macros, one decimal max.`;
    const txt = await aiCall({ system: 'You are a precise nutrition calculator. Output only valid JSON.', messages: [{ role: 'user', content: prompt }], json: true });
    const data = parseJson(txt);
    let n = 0;
    for (const r of data.items || []) {
      const it = items[r.i]; if (!it) continue;
      for (const [k] of MACROS) if (r[k] !== undefined) it.ref[k] = r1(num(r[k]));
      n++;
    }
    save(); toast(`Macros calculated for ${n} item${n === 1 ? '' : 's'} ✓`);
  } catch (e) { toast('⚠️ ' + e.message, false, 5000); }
  UI.aiBusy = false; UI.aiTarget = null; renderSheet(); render();
}

/* ---- Grocery ---- */
function displayQty(qty, unit) {
  if (unit === 'g' && qty >= 1000) return `${fmtN(qty / 1000)} kg`;
  if (unit === 'ml' && qty >= 1000) return `${fmtN(qty / 1000)} l`;
  if (unit === 'mg' && qty >= 1000) return `${fmtN(qty / 1000)} g`;
  return `${fmtN(qty)} ${unit}`;
}
function viewGrocery() {
  const G = S.grocery;
  let h = `<div class="card"><div class="spread"><h3 style="margin:0">Shopping for</h3><b style="color:var(--accent2)">${G.days} day${G.days === 1 ? '' : 's'}</b></div>
    <div class="days-pick" style="margin-top:8px"><button class="btn sm" data-act="gDays" data-id="-1">−</button>
    <input type="range" min="1" max="31" value="${G.days}" data-in="gDays"><button class="btn sm" data-act="gDays" data-id="1">+</button></div>
    <div class="chips" style="margin-top:8px">${[1, 3, 5, 7, 14, 30].map(d => `<button class="chip ${G.days === d ? 'on' : ''}" data-act="gDaysSet" data-id="${d}">${d}d</button>`).join('')}</div>
    <p class="tiny muted" style="margin:8px 0 0">Items marked “per day” are multiplied by the number of days. Fixed items stay as entered.</p></div>`;

  h += `<div class="card"><h3>Add product</h3><input type="text" id="gName" placeholder="Product name">
    <div class="qty-row"><input type="text" inputmode="decimal" id="gQty" placeholder="Amount">${unitSelect('g', 'id="gUnit"')}</div>
    <label class="row" style="margin:8px 0"><input type="checkbox" id="gScale" checked> <span class="small">Amount is per day (scale with days)</span></label>
    <button class="btn primary block" data-act="gAdd">+ Add to list</button></div>`;

  h += `<div class="row wrap" style="margin-bottom:10px"><button class="btn sm" data-act="gImport">⬇ From today's diet</button>
    ${G.items.some(i => i.checked) ? `<button class="btn sm" data-act="gUncheck">↺ Uncheck all</button><button class="btn sm danger" data-act="gClearChecked">Remove bought</button>` : ''}</div>`;

  if (!G.items.length) h += `<div class="empty"><div class="big">🛒</div>Your grocery list is empty.</div>`;
  const items = [...G.items].sort((a, b) => (a.checked - b.checked) || a.name.localeCompare(b.name));
  for (const it of items) {
    const total = it.scale ? num(it.qty) * G.days : num(it.qty);
    h += `<div class="g-item ${it.checked ? 'done' : ''}"><input type="checkbox" ${it.checked ? 'checked' : ''} data-in="gCheck" data-id="${it.id}">
      <div class="grow" data-act="gEdit" data-id="${it.id}" style="cursor:pointer;min-width:0"><div class="g-name ellipsis">${esc(it.name)}</div>
      <div class="tiny muted">${it.scale ? `${displayQty(num(it.qty), it.unit)} / day` : 'fixed amount'}</div></div>
      <div class="g-qty" data-act="gEdit" data-id="${it.id}">${displayQty(total, it.unit)}</div></div>`;
  }
  return h;
}
function groceryItemSheet(id) {
  return () => {
    const it = S.grocery.items.find(x => x.id === id); if (!it) return sheetHead('Item') + '<p>Deleted.</p>';
    return sheetHead('Edit item') + `<label class="field"><span>Name</span><input type="text" value="${esc(it.name)}" data-in="gi" data-f="name" data-id="${id}"></label>
      <div class="qty-row" style="margin-bottom:10px"><input type="text" inputmode="decimal" value="${esc(it.qty)}" data-in="gi" data-f="qty" data-id="${id}">${unitSelect(it.unit, `data-in="gi" data-f="unit" data-id="${id}"`)}</div>
      <label class="row" style="margin-bottom:14px"><input type="checkbox" ${it.scale ? 'checked' : ''} data-in="gi" data-f="scale" data-id="${id}"> <span>Amount is per day (scale with days)</span></label>
      <button class="btn danger block" data-act="gDelete" data-id="${id}">Delete item</button>`;
  };
}

/* ============================== SETTINGS ============================== */
const PROVIDERS = {
  gemini: { label: 'Google Gemini (free tier)', defModel: 'gemini-flash-latest', keyUrl: 'https://aistudio.google.com/apikey' },
  anthropic: { label: 'Anthropic Claude (paid API)', defModel: 'claude-haiku-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
};
function viewSettings() {
  const st = S.settings; const P = PROVIDERS[st.provider];
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let h = '';
  if (!standalone) h += `<div class="notice"><b>Install on your iPhone:</b> open this page in <b>Safari</b> → tap <b>Share</b> → <b>Add to Home Screen</b>. Always open the app from the Home Screen icon so your data stays safe.</div>`;
  h += `<div class="card"><h3>Units</h3><div class="seg" style="margin:0">${['kg', 'lb'].map(u => `<button class="${st.weightUnit === u ? 'on' : ''}" data-act="setUnit" data-id="${u}">${u}</button>`).join('')}</div></div>`;
  h += `<div class="card"><h3>AI (coach, macros, workout review)</h3>
    <label class="field"><span>Provider</span><select data-in="setProvider">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === st.provider ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
    <label class="field"><span>API key</span><input type="password" autocomplete="off" value="${esc(st.apiKey)}" placeholder="Paste your key" data-in="setKey"></label>
    <label class="field"><span>Model (optional)</span><input type="text" value="${esc(st.model)}" placeholder="${P.defModel}" data-in="setModel"></label>
    <p class="small muted" style="margin-top:0">Get a key: <a href="${P.keyUrl}" target="_blank" rel="noopener" style="color:var(--blue)">${P.keyUrl.replace('https://', '')}</a>. The key is stored only on this phone.</p>
    <button class="btn sm" data-act="testAi" ${UI.aiBusy ? 'disabled' : ''}>${UI.aiBusy ? 'Testing…' : 'Test connection'}</button></div>`;
  h += `<div class="card"><h3>☁️ Automatic backup</h3>
    <p class="small muted" style="margin-top:0">Backs up all your data to a private Gist on your GitHub account a few seconds after every change. Your AI key and token are never uploaded.</p>
    <p class="small" id="cloudStatus">${cloudStatusHtml()}</p>
    <label class="field"><span>GitHub token (gist access)</span><input type="password" autocomplete="off" value="${esc(st.gistToken)}" placeholder="ghp_…" data-in="setGist"></label>
    <p class="small muted" style="margin-top:0">Create one: <a href="https://github.com/settings/tokens/new?scopes=gist&description=Lift%20backup" target="_blank" rel="noopener" style="color:var(--blue)">github.com/settings/tokens/new</a> → set <b>Expiration: No expiration</b> → <b>Generate token</b> → copy it here.</p>
    <div class="row wrap"><button class="btn sm primary" data-act="cloudNow">☁️ Back up now</button><button class="btn sm" data-act="cloudRestore">⬇ Restore from GitHub</button></div></div>`;
  h += `<div class="card"><h3>Manual backup file</h3><p class="small muted" style="margin-top:0">Optional extra copy you can save to Files/iCloud.</p>
    <div class="row wrap"><button class="btn sm" data-act="exportData">⬆ Export backup</button><label class="btn sm" style="cursor:pointer">⬇ Import backup<input type="file" accept=".json,application/json" data-in="importData" hidden></label></div>
    <p class="tiny muted" id="persistInfo" style="margin-bottom:0"></p></div>`;
  h += `<div class="card"><h3>Danger zone</h3><button class="btn danger sm" data-act="resetAll">Erase all data</button></div>`;
  h += `<p class="tiny muted" style="text-align:center">Lift · personal build · ${S.sets.length} sets · ${Object.keys(S.diet.days).length} diet days</p>`;
  setTimeout(updatePersistInfo, 0);
  return h;
}
async function updatePersistInfo() {
  const el = $('#persistInfo'); if (!el || !navigator.storage?.persisted) return;
  const p = await navigator.storage.persisted();
  el.textContent = p ? '✓ Storage is marked persistent.' : 'Tip: open the app from the Home Screen icon to keep storage safe.';
}

/* ============================== AI ============================== */
async function aiCall({ system, messages, json = false }) {
  const st = S.settings; const model = (st.model || PROVIDERS[st.provider].defModel).trim();
  if (!st.apiKey) throw new Error('No API key set (Settings).');
  if (!navigator.onLine) throw new Error('You are offline.');
  let res, data;
  if (st.provider === 'gemini') {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': st.apiKey.trim() },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: json ? { responseMimeType: 'application/json', temperature: 0.2 } : { temperature: 0.6 },
      }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Gemini error ${res.status}`);
    const txt = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!txt) throw new Error('Empty reply from Gemini.');
    return txt;
  } else {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': st.apiKey.trim(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 2500, system, messages: messages.map(m => ({ role: m.role, content: m.content })) }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Claude error ${res.status}`);
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
}
function parseJson(txt) {
  const t = txt.replace(/```json|```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('AI reply was not valid JSON — try again.');
  return JSON.parse(t.slice(a, b + 1));
}

/* Minimal, safe Markdown → HTML */
function md(src) {
  const lines = esc(src).split('\n'); let out = '', list = null;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<span class="kbd">$1</span>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { close(); out += `<h3>${inline(m[2])}</h3>`; }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) { close(); }
    else { close(); out += `<p>${inline(l)}</p>`; }
  }
  close(); return out;
}

/* ============================== Actions (clicks) ============================== */
const A = {
  closeSheet,
  // Train
  startWorkout() { pickCats = []; openSheet(startWorkoutSheet); },
  pickCat(el) { const id = el.dataset.id; pickCats = pickCats.includes(id) ? pickCats.filter(x => x !== id) : [...pickCats, id]; renderSheet(); },
  confirmStart() {
    if (!pickCats.length) return;
    const w = { id: uid(), start: Date.now(), end: null, categoryIds: [...pickCats], exerciseIds: [], aiReview: null };
    S.workouts.push(w); S.activeWorkoutId = w.id; save(true);
    UI.tab = 'train'; closeSheet(); toast('Workout started 💪');
  },
  endWorkout() {
    const w = activeWorkout(); if (!w) return;
    if (!confirm('End this workout?')) return;
    w.end = Date.now(); S.activeWorkoutId = null; save(true); render();
    openSheet(summarySheet(w.id));
  },
  addWorkoutEx() { pickerSearch = ''; openSheet(exercisePickerSheet); setTimeout(() => $('#pickSearch')?.focus(), 100); },
  pickWorkoutEx(el) {
    const w = activeWorkout(); if (!w) return;
    workoutExIds(w).push(el.dataset.id); save(); closeSheet();
    toast(`${exById(el.dataset.id).name} added`);
  },
  createWorkoutEx() {
    const w = activeWorkout(); const name = pickerSearch.trim(); if (!w || !name) return;
    const e = { id: uid(), name, categoryIds: w.categoryIds.slice(0, 1), notes: '' };
    S.exercises.push(e); workoutExIds(w).push(e.id); save(); closeSheet(); toast(`${name} created & added`);
  },
  removeWorkoutEx(el) {
    const w = activeWorkout(); if (!w) return; const id = el.dataset.id;
    const n = S.sets.filter(s => s.workoutId === w.id && s.exerciseId === id).length;
    if (n && !confirm(`Remove ${exById(id)?.name} from this workout and delete its ${n} logged set${n === 1 ? '' : 's'}?`)) return;
    S.sets = S.sets.filter(s => !(s.workoutId === w.id && s.exerciseId === id));
    w.exerciseIds = workoutExIds(w).filter(x => x !== id); save(); render();
  },
  showSummary(el) { openSheet(summarySheet(el.dataset.id)); },
  deleteWorkout(el) {
    if (!confirm('Delete this workout record? Logged sets are kept.')) return;
    S.sets.forEach(s => { if (s.workoutId === el.dataset.id) s.workoutId = null; });
    S.workouts = S.workouts.filter(w => w.id !== el.dataset.id); save(); closeSheet();
  },
  async aiReview(el) {
    const w = S.workouts.find(x => x.id === el.dataset.id); if (!w) return;
    if (!S.settings.apiKey) { toast('Add your AI key in Settings first'); return; }
    const s = computeSummary(w);
    const sets = S.sets.filter(x => x.workoutId === w.id).map(x => `${exById(x.exerciseId)?.name}: ${x.weight}${wu()} x ${x.reps}${x.notes ? ` (${x.notes})` : ''}`);
    const prevSets = s.prev ? S.sets.filter(x => x.workoutId === s.prev.id).map(x => `${exById(x.exerciseId)?.name}: ${x.weight}${wu()} x ${x.reps}`) : [];
    const prompt = `Review my workout. Muscle groups: ${catNames(w.categoryIds)}. Duration: ${fmtDur(s.duration)}.
Today's sets:\n${sets.join('\n') || '(none)'}
${s.prev ? `Last ${s.prev.cats} workout (${s.prev.day}, ${fmtDur(s.prev.duration)}):\n${prevSets.join('\n')}` : 'No previous workout for these groups.'}
App analysis — went well: ${s.good.join('; ') || 'n/a'}. Worse: ${s.bad.join('; ') || 'n/a'}. Missed: ${s.missed.join('; ') || 'n/a'}.
Give short, direct feedback in Markdown with sections: **Verdict** (1–2 sentences), **Did well**, **Improve**, **Missed / balance**, **vs last time**, **Next session target** (concrete weights/reps). Max ~200 words. Do not include a YOUTUBE_QUERY line.`;
    UI.aiBusy = true; renderSheet();
    try { w.aiReview = await aiCall({ system: 'You are a concise, honest strength coach.', messages: [{ role: 'user', content: prompt }] }); save(); }
    catch (e) { toast('⚠️ ' + e.message, false, 5000); }
    UI.aiBusy = false; renderSheet();
  },
  newCategory() {
    const name = prompt('New muscle group name:'); if (!name?.trim()) return;
    const c = { id: uid(), name: name.trim() }; S.categories.push(c); save(); render(); openSheet(categorySheet(c.id));
  },
  editCategory(el) { openSheet(categorySheet(el.dataset.id)); },
  deleteCategory(el) {
    const c = catById(el.dataset.id); if (!c || !confirm(`Delete group “${c.name}”? Exercises are kept.`)) return;
    S.categories = S.categories.filter(x => x.id !== c.id);
    S.exercises.forEach(e => e.categoryIds = e.categoryIds.filter(x => x !== c.id));
    S.workouts.forEach(w => w.categoryIds = w.categoryIds.filter(x => x !== c.id));
    save(); closeSheet();
  },
  newExercise() {
    const name = prompt('Exercise name:'); if (!name?.trim()) return;
    const w = activeWorkout();
    const e = { id: uid(), name: name.trim(), categoryIds: w ? [...w.categoryIds].slice(0, 1) : [], notes: '' };
    S.exercises.push(e); save(); render(); openSheet(exerciseSheet(e.id));
  },
  openExercise(el) { openSheet(exerciseSheet(el.dataset.id)); },
  toggleExCat(el) {
    const e = exById(el.dataset.id); const c = el.dataset.cat;
    e.categoryIds = e.categoryIds.includes(c) ? e.categoryIds.filter(x => x !== c) : [...e.categoryIds, c]; save(); renderSheet();
  },
  deleteExercise(el) {
    const e = exById(el.dataset.id); if (!e) return;
    const n = S.sets.filter(s => s.exerciseId === e.id).length;
    if (!confirm(`Delete “${e.name}”${n ? ` and its ${n} logged sets` : ''}?`)) return;
    S.exercises = S.exercises.filter(x => x.id !== e.id); S.sets = S.sets.filter(s => s.exerciseId !== e.id); save(); closeSheet();
  },
  quickAddSet(el) {
    const id = el.dataset.id; const w = $('#qw_' + id).value, r = $('#qr_' + id).value;
    if (!num(r)) { toast('Enter reps'); return; }
    addSet(id, w, r); render();
  },
  sheetAddSet(el) {
    const w = $('#nsW').value, r = $('#nsR').value, n = $('#nsN').value.trim();
    if (!num(r)) { toast('Enter reps'); return; }
    addSet(el.dataset.id, w, r, n); renderSheet();
  },
  editSet(el) { openSheet(setSheet(el.dataset.id)); },
  deleteSet(el) {
    if (!confirm('Delete this set?')) return;
    const s = S.sets.find(x => x.id === el.dataset.id);
    S.sets = S.sets.filter(x => x.id !== el.dataset.id); save();
    if (s && exById(s.exerciseId)) openSheet(exerciseSheet(s.exerciseId)); else closeSheet();
  },
  viewProgressFor(el) { UI.progressEx = el.dataset.id; UI.tab = 'progress'; closeSheet(); window.scrollTo(0, 0); },
  askCoachAbout(el) { const e = exById(el.dataset.id); closeSheet(); UI.tab = 'coach'; render(); sendChat(`How do I properly do the ${e.name}?`); },
  metric(el) { UI.progressMetric = el.dataset.id; render(); },
  // Coach
  sendChat() { const b = $('#chatBox'); const v = b.value; b.value = ''; sendChat(v); },
  coachQuick(el) { sendChat(el.dataset.q); },
  clearChat() { if (confirm('Clear the chat?')) { S.chat = []; save(); render(); } },
  // Food
  foodSub(el) { UI.foodSub = el.dataset.id; render(); },
  dietShift(el) { UI.dietDate = shiftKey(UI.dietDate, +el.dataset.id); render(); },
  dietToday() { UI.dietDate = todayKey(); render(); },
  copyDay(el) {
    const src = S.diet.days[el.dataset.id]; const day = dietDay(UI.dietDate, true);
    day.meals = src.meals.map(m => ({ ...m, id: uid(), eaten: false, created: Date.now() + Math.random(), products: m.products.map(p => ({ ...p, id: uid() })) }));
    save(); render(); toast('Meals copied ✓');
  },
  addMeal(el) {
    const day = dietDay(UI.dietDate, true);
    const m = { id: uid(), type: el.dataset.id, name: '', eaten: false, created: Date.now(), products: [] };
    m.products.push(newProduct(el.dataset.id === 'vitamin' ? 'capsule' : 'g'));
    day.meals.push(m); save(); render(); openSheet(mealSheet(m.id));
  },
  openMeal(el) { openSheet(mealSheet(el.dataset.id)); },
  addProduct(el) { const f = findMeal(el.dataset.id); f.meal.products.push(newProduct(f.meal.type === 'vitamin' ? 'capsule' : 'g')); save(); renderSheet(); },
  delProduct(el) { const f = findMeal(el.dataset.m); f.meal.products = f.meal.products.filter(p => p.id !== el.dataset.id); save(); renderSheet(); },
  deleteMeal(el) {
    const f = findMeal(el.dataset.id); if (!f || !confirm('Delete this meal?')) return;
    S.diet.days[f.key].meals = S.diet.days[f.key].meals.filter(m => m.id !== f.meal.id); save(); closeSheet();
  },
  aiMacrosMeal(el) { const f = findMeal(el.dataset.id); if (f) aiMacros(f.meal.products, f.meal.id); },
  aiMacrosProduct(el) { const f = findMeal(el.dataset.m); const p = f?.meal.products.find(x => x.id === el.dataset.id); if (p) aiMacros([p], p.id); },
  saveMeal() { save(true); closeSheet(); toast('Meal saved ✓'); },
  aiMacrosDay() { const d = dietDay(UI.dietDate); if (d) aiMacros(d.meals.flatMap(m => m.products), 'day'); },
  // Grocery
  gDays(el) { S.grocery.days = Math.min(31, Math.max(1, S.grocery.days + +el.dataset.id)); save(); render(); },
  gDaysSet(el) { S.grocery.days = +el.dataset.id; save(); render(); },
  gAdd() {
    const name = $('#gName').value.trim(); if (!name) { toast('Enter a product name'); return; }
    S.grocery.items.push({ id: uid(), name, qty: num($('#gQty').value) || 1, unit: $('#gUnit').value, scale: $('#gScale').checked, checked: false });
    save(); render(); toast('Added ✓'); setTimeout(() => $('#gName')?.focus(), 50);
  },
  gEdit(el) { openSheet(groceryItemSheet(el.dataset.id)); },
  gDelete(el) { S.grocery.items = S.grocery.items.filter(i => i.id !== el.dataset.id); save(); closeSheet(); },
  gUncheck() { S.grocery.items.forEach(i => i.checked = false); save(); render(); },
  gClearChecked() { if (!confirm('Remove all bought items?')) return; S.grocery.items = S.grocery.items.filter(i => !i.checked); save(); render(); },
  gImport() {
    const k = todayKey(); const day = dietDay(k);
    if (!day || !day.meals.length) { toast("Today's diet is empty — add meals first"); return; }
    const agg = {};
    for (const m of day.meals) for (const p of m.products) {
      if (!p.name.trim()) continue;
      const key = p.name.trim().toLowerCase() + '|' + p.unit;
      agg[key] = agg[key] || { name: p.name.trim(), unit: p.unit, qty: 0 }; agg[key].qty += num(p.qty);
    }
    let added = 0, updated = 0;
    for (const a of Object.values(agg)) {
      const ex = S.grocery.items.find(i => i.name.toLowerCase() === a.name.toLowerCase() && i.unit === a.unit);
      if (ex) { ex.qty = r1(a.qty); ex.scale = true; updated++; }
      else { S.grocery.items.push({ id: uid(), name: a.name, qty: r1(a.qty), unit: a.unit, scale: true, checked: false }); added++; }
    }
    save(); render(); toast(`${added} added, ${updated} updated (per day × ${S.grocery.days} days)`);
  },
  // Settings
  goSettings() { UI.tab = 'settings'; window.scrollTo(0, 0); render(); },
  setUnit(el) { S.settings.weightUnit = el.dataset.id; save(); render(); },
  async testAi() {
    UI.aiBusy = true; render();
    try { const r = await aiCall({ system: 'Reply with one short sentence.', messages: [{ role: 'user', content: 'Say hello to a lifter.' }] }); toast('✓ ' + r.slice(0, 90), false, 4000); }
    catch (e) { toast('⚠️ ' + e.message, false, 6000); }
    UI.aiBusy = false; render();
  },
  async cloudNow() { if (!S.settings.gistToken) { toast('Paste your GitHub token first'); return; } toast('Backing up…'); await cloudBackup(true); },
  cloudRestore() { cloudRestore(); },
  exportData() {
    S.settings.lastExport = Date.now(); save();
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `lift-backup-${todayKey()}.json`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  },
  resetAll() {
    if (!confirm('Erase ALL workouts, diet and grocery data? This cannot be undone.')) return;
    if (!confirm('Really erase everything?')) return;
    S = defaultState(); save(true); render(); toast('All data erased');
  },
};
function newProduct(unit = 'g') { return { id: uid(), name: '', qty: '', unit, kcal: '', protein: '', carbs: '', fat: '', fiber: '', sugar: '' }; }

/* ============================== Inputs ============================== */
const I = {
  pickSearch(el) {
    pickerSearch = el.value; const pos = el.selectionStart; renderSheet();
    const n = $('#pickSearch'); if (n) { n.focus(); n.setSelectionRange(pos, pos); }
  },
  trainSearch(el) { UI.trainSearch = el.value; $('#exList').innerHTML = exerciseListHtml(); },
  exName(el) { exById(el.dataset.id).name = el.value; save(); },
  exNotes(el) { exById(el.dataset.id).notes = el.value; save(); },
  catName(el) { catById(el.dataset.id).name = el.value; save(); },
  catEx(el) {
    const e = exById(el.dataset.ex); const c = el.dataset.id;
    e.categoryIds = el.checked ? [...new Set([...e.categoryIds, c])] : e.categoryIds.filter(x => x !== c); save();
  },
  setWeight(el) { S.sets.find(s => s.id === el.dataset.id).weight = num(el.value); save(); },
  setReps(el) { S.sets.find(s => s.id === el.dataset.id).reps = Math.round(num(el.value)); save(); },
  setNotes(el) { S.sets.find(s => s.id === el.dataset.id).notes = el.value; save(); },
  setDate(el) {
    if (!el.value) return; const s = S.sets.find(x => x.id === el.dataset.id);
    const old = new Date(s.t); const d = keyToDate(el.value); d.setHours(old.getHours(), old.getMinutes(), old.getSeconds(), old.getMilliseconds()); s.t = d.getTime(); save();
  },
  progressEx(el) { UI.progressEx = el.value; render(); },
  mealEaten(el) { const f = findMeal(el.dataset.id); f.meal.eaten = el.checked; save(); if (sheetRender) renderSheet(); render(); },
  mealType(el) { findMeal(el.dataset.id).meal.type = el.value; save(); renderSheet(); },
  mealName(el) { findMeal(el.dataset.id).meal.name = el.value; save(); },
  prod(el) {
    const f = findMeal(el.dataset.m); const p = f.meal.products.find(x => x.id === el.dataset.id); const k = el.dataset.f;
    p[k] = (k === 'name' || k === 'unit') ? el.value : el.value.replace(',', '.');
    save(); updateMealTotalsInSheet(f.meal);
  },
  gDays(el) { S.grocery.days = +el.value; save(); render(); },
  gCheck(el) { const it = S.grocery.items.find(i => i.id === el.dataset.id); it.checked = el.checked; save(); setTimeout(render, 200); },
  gi(el) {
    const it = S.grocery.items.find(i => i.id === el.dataset.id); const k = el.dataset.f;
    it[k] = k === 'scale' ? el.checked : k === 'qty' ? num(el.value) : el.value; save();
  },
  setProvider(el) { S.settings.provider = el.value; S.settings.model = ''; save(); render(); },
  setKey(el) { S.settings.apiKey = el.value.trim(); save(); },
  setGist(el) {
    const v = el.value.trim(); if (v === S.settings.gistToken) return;
    S.settings.gistToken = v; S.settings.gistId = ''; save();
    if (v) { clearTimeout(cloudTimer); cloudBackup(true).then(() => { const x = $('#cloudStatus'); if (x) x.innerHTML = cloudStatusHtml(); }); }
  },
  setModel(el) { S.settings.model = el.value.trim(); save(); },
  importData(el) {
    const file = el.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(rd.result);
        if (!data.exercises || !data.sets) throw new Error('Not a Lift backup');
        if (!confirm('Replace all current data with this backup?')) return;
        localStorage.setItem(STORE_KEY, JSON.stringify(data)); load(); render(); toast('Backup restored ✓');
      } catch (e) { toast('⚠️ Import failed: ' + e.message); }
    };
    rd.readAsText(file);
  },
};
// Text inputs update live; selects/checkboxes/files/range fire on change.
const LIVE = new Set(['pickSearch', 'trainSearch', 'exName', 'exNotes', 'catName', 'setWeight', 'setReps', 'setNotes', 'mealName', 'prod', 'gi', 'setKey', 'setModel']);
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-in]'); if (!el) return;
  const n = el.dataset.in;
  if (el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'file') return;
  if (n === 'gDays') { S.grocery.days = +el.value; const b = el.closest('.card').querySelector('b'); if (b) b.textContent = `${el.value} day${el.value === '1' ? '' : 's'}`; return; }
  if (LIVE.has(n) && I[n]) I[n](el);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-in]'); if (!el) return;
  const n = el.dataset.in;
  if (el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'file' || el.type === 'date' || el.type === 'range') { I[n] && I[n](el); return; }
  if (n === 'setGist') { I.setGist(el); return; }
  // Re-render sheet after edits that affect PR badges etc.
  if (['setWeight', 'setReps'].includes(n)) render();
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.tagName === 'INPUT') return;
  const fn = A[el.dataset.act]; if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'chatBox') { e.preventDefault(); A.sendChat(); }
  if (e.key === 'Enter' && e.target.id === 'gName') { e.preventDefault(); $('#gQty')?.focus(); }
});

/* ============================== Spotify ============================== */
$('#spotifyBtn').addEventListener('click', (e) => {
  e.preventDefault();
  const started = Date.now();
  window.location.href = 'spotify:';
  setTimeout(() => {
    // If the app didn't open (page still visible), fall back to the web player.
    if (document.visibilityState === 'visible' && Date.now() - started < 2500) window.open('https://open.spotify.com', '_blank');
  }, 1600);
});

/* ============================== Boot ============================== */
load();
render();
if (S.settings.gistToken && Date.now() - (S.settings.lastCloudBackup || 0) > 6 * 3600e3) scheduleCloudBackup(3000);
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
