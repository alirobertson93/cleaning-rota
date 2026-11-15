import * as S from './schedule.js';
import { createStore } from './store.js';
import { buildSeedConfig, PERSON_COLORS } from './seed.js';
import { Idiomorph } from './vendor/idiomorph.esm.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const store = createStore();
const root = document.getElementById('app');
const toastEl = document.getElementById('toast');

// The same script serves both pages. admin/index.html sets
// <body data-page="admin">; there is no link to it from the housemate page.
const IS_ADMIN = document.body.dataset.page === 'admin';
const SITE_ROOT = IS_ADMIN ? '../' : './';

const LS_ME = 'rota:me';
const MAX_EVERY = 12;

const storageGet = (s, k) => {
  try {
    return s.getItem(k);
  } catch {
    return null;
  }
};
const storageSet = (s, k, v) => {
  try {
    if (v == null) s.removeItem(k);
    else s.setItem(k, v);
  } catch {
    /* private mode etc. — not critical */
  }
};

const state = {
  config: undefined, // undefined = loading, null = empty database
  weekId: S.currentWeekId(),
  week: { done: {} },
  weekLoaded: false,
  me: storageGet(localStorage, LS_ME),
  adminTab: 'people',
  openSchedules: new Set(), // task ids whose "next 6" list is expanded in Admin → Tasks
  error: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const clean = (s, max = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Defensive: the config comes from a shared database anyone with the link can
// write to, so drop malformed entries rather than crash every housemate's page.
function normalizeConfig(c) {
  const list = (v, ok) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && ok(x)) : []);
  const str = (v) => typeof v === 'string';
  return {
    version: 1,
    houseName: str(c.houseName) && c.houseName.trim() ? c.houseName : 'Cleaning Rota',
    anchor: S.isValidWeekId(c.anchor) ? c.anchor : '2025-01-20',
    rotationShift: Number.isFinite(Number(c.rotationShift)) ? Math.trunc(Number(c.rotationShift)) : 0,
    people: list(c.people, (p) => str(p.name)).map((p) => ({ ...p, color: safeColor(p.color) })),
    zones: list(c.zones, (z) => str(z.name)),
    rooms: list(c.rooms, (r) => str(r.name)),
    tasks: list(c.tasks, (t) => str(t.name) && str(t.roomId)),
  };
}

/** Only allow #rgb / #rrggbb colours into style attributes. */
function safeColor(v) {
  return typeof v === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? v : PERSON_COLORS[0];
}

const findPerson = (id) => state.config?.people.find((p) => p.id === id) || null;
const me = () => findPerson(state.me);
const personName = (id) => findPerson(id)?.name || 'a former housemate';
const isCurrentWeek = () => state.weekId === S.currentWeekId();
const isFutureWeek = () => state.weekId > S.currentWeekId();

function weekRelative(id) {
  const n = S.weekIndex(id, S.currentWeekId());
  if (n === 0) return 'This week';
  if (n === 1) return 'Next week';
  if (n === -1) return 'Last week';
  return n > 0 ? `In ${n} weeks` : `${-n} weeks ago`;
}

function zoneNames(zones) {
  if (!zones.length) return '';
  return zones.map((z) => z.name).join(' + ');
}

function initials(name) {
  const parts = clean(name).split(' ').filter(Boolean);
  return esc((parts[0]?.[0] || '?').toUpperCase() + (parts[1]?.[0] || '').toUpperCase());
}

const avatar = (p, size = '') =>
  `<span class="avatar ${size}" style="--pc:${safeColor(p.color)}" aria-hidden="true">${initials(p.name)}</span>`;

function nextColor(config) {
  const used = new Set(config.people.map((p) => p.color));
  return PERSON_COLORS.find((c) => !used.has(c)) || PERSON_COLORS[config.people.length % PERSON_COLORS.length];
}

let toastTimer;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = 'toast'), isError ? 4000 : 1800);
}


// ---------------------------------------------------------------------------
// Data subscriptions
// ---------------------------------------------------------------------------

function onStoreError(err) {
  console.error(err);
  const code = err?.code || '';
  if (code.includes('permission-denied')) state.error = 'permission';
  else if (code.includes('admin-restricted-operation') || code.includes('operation-not-allowed')) state.error = 'auth';
  else state.error = state.error || 'connect';
  render();
}

const loadTimer = setTimeout(() => {
  if (state.config === undefined) {
    state.error = state.error || 'timeout';
    render();
  }
}, 10000);

store.ready.catch(onStoreError);
store.onConfig((c) => {
  clearTimeout(loadTimer);
  if (state.error === 'timeout' || state.error === 'connect') state.error = null;
  state.config = c ? normalizeConfig(c) : null;
  render();
}, onStoreError);

let unsubWeek = () => {};
function watchWeek() {
  unsubWeek();
  const id = state.weekId;
  state.week = { done: {} };
  state.weekLoaded = false;
  unsubWeek = store.onWeek(
    id,
    (d) => {
      if (id !== state.weekId) return;
      state.week = { done: { ...(d?.done || {}) } };
      state.weekLoaded = true;
      render();
    },
    onStoreError,
  );
}
watchWeek();

// Roll over to the new week if the page is left open past Sunday midnight.
setInterval(() => {
  const now = S.currentWeekId();
  if (state.lastSeenCurrent && state.lastSeenCurrent !== now && state.weekId === state.lastSeenCurrent) {
    state.weekId = now;
    watchWeek();
  }
  state.lastSeenCurrent = now;
  render();
}, 60000);
state.lastSeenCurrent = S.currentWeekId();

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function route() {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0];
  const decode = (x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  };
  const [name = '', id = ''] = path.split('/').map(decode);
  return { name: name || 'home', id };
}

// Render by morphing the existing DOM towards the new markup rather than
// replacing it: elements keep their identity, so focus, an open <select>,
// scroll positions and in-flight taps survive re-renders triggered by other
// housemates' changes. ignoreActiveValue leaves whatever the user is typing
// in the focused field alone.
function render() {
  Idiomorph.morph(root, view(), { morphStyle: 'innerHTML', ignoreActiveValue: true });
}

function view() {
  if (IS_ADMIN) return `${adminTopbar()}${banner()}<main class="wrap">${adminBody()}</main>`;
  const r = route();
  return `${topbar(r)}${banner()}<main class="wrap">${body(r)}</main>`;
}

function adminTopbar() {
  const house = state.config?.houseName || 'Cleaning Rota';
  return `
  <header class="topbar">
    <div class="topbar-inner">
      <span class="brand">${icon('gear')}<span>${esc(house)} · Admin</span></span>
      <nav class="tabs" aria-label="Sections">
        <a href="${SITE_ROOT}" class="tab">View rota${icon('right')}</a>
      </nav>
    </div>
  </header>`;
}

function loadingBody() {
  if (state.error) return emptyState('Can’t load the rota', errorText());
  return `<div class="loading" role="status"><span class="spinner"></span>Loading the rota…</div>`;
}

function adminBody() {
  if (state.config === undefined) return loadingBody();
  if (state.config === null) return setupView();
  return adminView();
}

function topbar(r) {
  const house = state.config?.houseName || 'Cleaning Rota';
  const tab = (href, label, active) =>
    `<a href="${href}" class="tab${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>${label}</a>`;
  const mine = r.name === 'home' || (r.name === 'person' && r.id === state.me);
  return `
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="#/">${icon('sparkle')}<span>${esc(house)}</span></a>
      <nav class="tabs" aria-label="Sections">
        ${tab('#/', 'Me', mine)}
        ${tab('#/house', 'Everyone', r.name === 'house' || (r.name === 'person' && !mine))}
      </nav>
    </div>
  </header>`;
}

function banner() {
  const parts = [];
  if (store.mode === 'demo') {
    parts.push(
      `<div class="banner demo">Demo mode — changes are only saved in this browser. Add your Firebase details to share with housemates.</div>`,
    );
  }
  if (state.error && state.config !== undefined) parts.push(`<div class="banner error">${errorText()}</div>`);
  return parts.join('');
}

function errorText() {
  switch (state.error) {
    case 'permission':
      return 'The database refused access. Check the Firestore rules have been published (see README).';
    case 'auth':
      return 'Anonymous sign-in is turned off in Firebase. Turn it on under Authentication → Sign-in method.';
    case 'timeout':
      return "Still can't reach the database. Check your connection, or the Firebase settings.";
    default:
      return "Can't reach the database right now. Your ticks will sync when you're back online.";
  }
}

function body(r) {
  if (state.config === undefined) return loadingBody();
  if (state.config === null || !state.config.people.length) return notSetUp();
  switch (r.name) {
    case 'house':
      return houseView();
    case 'person':
      return findPerson(r.id) ? personView(findPerson(r.id)) : emptyState('Not found', 'That housemate no longer exists.', '#/house', 'See everyone');
    default:
      return me() ? personView(me()) : pickerView();
  }
}

function emptyState(title, text, href, cta) {
  return `<section class="empty"><h1>${esc(title)}</h1><p>${esc(text)}</p>${href ? `<a class="btn" href="${href}">${esc(cta)}</a>` : ''}</section>`;
}

// Housemates never see admin wording or links.
function notSetUp() {
  return emptyState('Nothing here yet', 'The rota hasn’t been set up yet. Check back soon.');
}

function setupView() {
  return `
  <section class="card setup">
    <h1>Set up your rota</h1>
    <p>The rota is empty. Start with the rota you already use: the same tasks, rooms, housemates and rotation. You can change any of it afterwards on this page.</p>
    <ul class="setup-list">
      <li><strong>52 tasks</strong> across 5 rooms</li>
      <li><strong>3 zones</strong> that rotate weekly</li>
      <li><strong>4 housemates</strong>: Ali, Shauna, Oliver, Emmy</li>
    </ul>
    <button class="btn primary" data-action="seed">Start with our current rota</button>
  </section>`;
}

function pickerView() {
  const people = state.config.people;
  return `
  <section class="picker" aria-label="Choose your name">
    <div class="picker-grid">
      ${people
        .map(
          (p) => `<button class="picker-btn" data-action="pick-me" data-id="${esc(p.id)}" style="--pc:${safeColor(p.color)}">
            ${avatar(p, 'lg')}<span>${esc(p.name)}</span></button>`,
        )
        .join('')}
    </div>
    <a class="link" href="#/house">Show everyone’s tasks</a>
  </section>`;
}

function weekbar() {
  const current = isCurrentWeek();
  return `
  <div class="weekbar">
    <button class="icon-btn" data-action="week-prev" aria-label="Previous week">${icon('left')}</button>
    <div class="weekbar-label" aria-live="polite">
      <strong>${esc(weekRelative(state.weekId))}</strong>
      <span>${esc(S.weekLabel(state.weekId))}</span>
    </div>
    <button class="icon-btn" data-action="week-next" aria-label="Next week">${icon('right')}</button>
  </div>
  ${current ? '' : `<div class="weekbar-back"><button class="link" data-action="week-now">Back to this week</button></div>`}`;
}

function doneCount(tasks) {
  return tasks.filter((t) => state.week.done[t.id]).length;
}

function ring(done, total) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const pct = total ? done / total : 1;
  return `
  <div class="ring" role="img" aria-label="${done} of ${total} done">
    <svg viewBox="0 0 72 72" aria-hidden="true">
      <circle class="ring-track" cx="36" cy="36" r="${r}"/>
      <circle class="ring-fill" cx="36" cy="36" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(2)}" transform="rotate(-90 36 36)"/>
    </svg>
    <span class="ring-text"><strong>${done}</strong><small>/${total}</small></span>
  </div>`;
}

function progressBar(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="${done} of ${total} done"><span style="width:${pct}%"></span></div>`;
}

function taskRow(task, assigneeId, compact = false) {
  const d = state.week.done[task.id];
  const future = isFutureWeek();
  const locked = future || !state.weekLoaded;
  const meta = [];
  if (d && d.by && d.by !== assigneeId) meta.push(`Done by ${esc(personName(d.by))}`);
  return `
  <label class="task${d ? ' done' : ''}${compact ? ' compact' : ''}${future ? ' future' : ''}${!state.weekLoaded && !future ? ' pending' : ''}">
    <input type="checkbox" data-task="${esc(task.id)}" ${d ? 'checked' : ''} ${locked ? 'disabled' : ''}>
    <span class="check" aria-hidden="true">${icon('tick')}</span>
    <span class="task-body">
      <span class="task-name">${esc(task.name)}</span>
      ${meta.length ? `<span class="task-meta">${meta.join(' · ')}</span>` : ''}
    </span>
  </label>`;
}

function roomsList(alloc, compact = false) {
  return alloc.rooms
    .map(
      ({ room, tasks }) => `
    <section class="room">
      <h3 class="room-title"><span>${esc(room.name)}</span><span class="count">${doneCount(tasks)}/${tasks.length}</span></h3>
      <div class="tasks">${tasks.map((t) => taskRow(t, alloc.person.id, compact)).join('')}</div>
    </section>`,
    )
    .join('');
}

function personView(person) {
  const a = S.allocate(state.config, state.weekId);
  const mine = a.people.find((p) => p.person.id === person.id);
  const isMe = person.id === state.me;
  const done = doneCount(mine.tasks);
  const total = mine.tasks.length;
  const allDone = total > 0 && done === total;

  const nextId = S.addWeeks(state.weekId, 1);
  const next = S.allocate(state.config, nextId).people.find((p) => p.person.id === person.id);
  const peek = next.weekOff
    ? `<strong>Week off</strong> ${weekRelative(nextId) === 'Next week' ? 'next week' : `the week of ${esc(S.weekLabel(nextId))}`} 🎉`
    : `${weekRelative(nextId) === 'Next week' ? 'Next week' : esc(S.weekLabel(nextId))}: <strong>${esc(zoneNames(next.zones))}</strong> · ${next.tasks.length} tasks`;

  const subtitle = mine.weekOff ? 'Week off' : esc(zoneNames(mine.zones));

  let content;
  if (mine.weekOff) {
    content = `<div class="card weekoff"><div class="weekoff-emoji" aria-hidden="true">🛋️</div><h2>Week off</h2><p>Nothing on the rota for ${isMe ? 'you' : esc(person.name)} ${isCurrentWeek() ? 'this week' : 'that week'}. Enjoy it.</p></div>`;
  } else if (!total) {
    content = `<div class="card weekoff"><h2>Nothing due</h2><p>No tasks fall in ${esc(zoneNames(mine.zones))} that week.</p></div>`;
  } else {
    content = `
      ${allDone ? `<div class="card celebrate" role="status">${icon('party')}<div><strong>All done${isMe ? ' — nice one!' : '!'}</strong><span>Every task ${isCurrentWeek() ? 'this week' : 'that week'} is ticked off.</span></div></div>` : ''}
      ${isFutureWeek() ? `<p class="note">${icon('info')}This week hasn’t started yet — you can tick tasks off from ${esc(S.parseWeekId(state.weekId).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }))}.</p>` : ''}
      <div class="rooms">${roomsList(mine)}</div>`;
  }

  return `<div class="person-page">
  ${weekbar()}
  <section class="hero card" style="--pc:${safeColor(person.color)}">
    <div class="hero-text">
      ${avatar(person, 'lg')}
      <div>
        <h1>${isMe ? `Hi ${esc(person.name)}` : `${esc(person.name)}’s tasks`}</h1>
        <p class="hero-zone">${subtitle}</p>
      </div>
    </div>
    ${mine.weekOff ? '' : ring(done, total)}
  </section>
  ${content}
  <p class="peek">${icon('calendar')}<span>${peek}</span></p>
  ${
    isMe
      ? `<p class="switch">Not ${esc(person.name)}? <button class="link" data-action="switch-me">Switch person</button></p>`
      : `<p class="switch"><a class="link" href="#/house">← Everyone’s tasks</a></p>`
  }</div>`;
}

function houseView() {
  const a = S.allocate(state.config, state.weekId);
  const all = a.people.flatMap((p) => p.tasks);
  const done = doneCount(all);

  const offPeople = a.people.filter((p) => p.weekOff);
  const offStrip = offPeople.length
    ? `<div class="offstrip">${offPeople
        .map(
          (p) =>
            `<a class="offchip" href="#/person/${encodeURIComponent(p.person.id)}" style="--pc:${safeColor(p.person.color)}">${avatar(p.person, 'sm')}<span>${esc(p.person.name)}${p.person.id === state.me ? ' (you)' : ''}</span></a>`,
        )
        .join('')}<span class="offstrip-label">🛋️ ${offPeople.length === 1 ? 'has' : 'have'} the week off</span></div>`
    : '';
  const cards = a.people
    .filter((p) => !p.weekOff)
    .map((p) => {
      const pd = doneCount(p.tasks);
      const head = `
      <header class="pcard-head">
        ${avatar(p.person)}
        <div class="pcard-title">
          <a href="#/person/${encodeURIComponent(p.person.id)}"><h2>${esc(p.person.name)}${p.person.id === state.me ? ' <span class="you">you</span>' : ''}</h2></a>
          <span>${p.weekOff ? 'Week off' : esc(zoneNames(p.zones))}</span>
        </div>
        ${p.weekOff ? '<span class="pill off">Off</span>' : `<span class="pill${pd === p.tasks.length && p.tasks.length ? ' complete' : ''}">${pd}/${p.tasks.length}</span>`}
      </header>`;
      if (p.weekOff) return `<article class="pcard off" style="--pc:${safeColor(p.person.color)}">${head}<p class="pcard-off">🛋️ Week off</p></article>`;
      return `
      <article class="pcard" style="--pc:${safeColor(p.person.color)}">
        ${head}
        ${progressBar(pd, p.tasks.length)}
        <div class="rooms compact">${roomsList(p, true)}</div>
      </article>`;
    })
    .join('');

  return `
  ${weekbar()}
  <section class="summary card">
    <div><h1>Everyone</h1><p class="muted">${done} of ${all.length} tasks done${isCurrentWeek() ? ' this week' : ''}</p></div>
    ${progressBar(done, all.length)}
  </section>
  ${offStrip}
  <div class="pgrid">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const ADMIN_TABS = [
  ['people', 'Housemates'],
  ['rooms', 'Rooms & zones'],
  ['tasks', 'Tasks'],
  ['rotation', 'Rotation'],
  ['settings', 'Settings'],
];

function adminView() {
  const c = state.config;
  const unassigned = S.unassignedRooms(c);
  const tabs = ADMIN_TABS.map(
    ([id, label]) =>
      `<button class="seg${state.adminTab === id ? ' active' : ''}" data-action="admin-tab" data-id="${id}" ${state.adminTab === id ? 'aria-current="true"' : ''}>${esc(label)}</button>`,
  ).join('');

  const panel =
    {
      people: adminPeople,
      rooms: adminRooms,
      tasks: adminTasks,
      rotation: adminRotation,
      settings: adminSettings,
    }[state.adminTab] || adminPeople;

  return `
  <div class="admin-head">
    <h1>Admin</h1>
  </div>
  ${unassigned.length ? `<p class="note warn">${icon('info')}${unassigned.length} room${unassigned.length > 1 ? 's aren’t' : ' isn’t'} in a zone, so ${unassigned.length > 1 ? 'they aren’t' : 'it isn’t'} on anyone’s list. Fix in Rooms &amp; zones.</p>` : ''}
  <div class="segs" role="tablist">${tabs}</div>
  <div class="admin-panel">${panel()}</div>`;
}

function rotationSummary(c) {
  const N = c.people.length;
  const Z = c.zones.length;
  if (!N || !Z) return '';
  if (N === Z) return `${N} housemates and ${Z} zones — everyone has a zone every week.`;
  if (N > Z) {
    const off = N - Z;
    return `${N} housemates and ${Z} zones — each week ${off === 1 ? 'one person has' : `${off} people have`} the week off.`;
  }
  return `${N} housemates and ${Z} zones — some people cover more than one zone each week.`;
}

function adminPeople() {
  const c = state.config;
  const rows = c.people
    .map(
      (p, i) => `
    <div class="arow">
      <button class="avatar-btn" data-action="person-color" data-id="${esc(p.id)}" aria-label="Change ${esc(p.name)}’s colour" title="Change colour">${avatar(p)}</button>
      <input class="input grow" type="text" value="${esc(p.name)}" data-change="person-name" data-id="${esc(p.id)}" aria-label="Name" maxlength="40">
      <div class="row-actions">
        <button class="icon-btn" data-action="person-up" data-id="${esc(p.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(p.name)} up">${icon('up')}</button>
        <button class="icon-btn" data-action="person-down" data-id="${esc(p.id)}" ${i === c.people.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(p.name)} down">${icon('down')}</button>
        <button class="icon-btn danger" data-action="person-remove" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">${icon('trash')}</button>
      </div>
    </div>`,
    )
    .join('');
  return `
  <section class="card">
    <h2>Housemates</h2>
    <p class="muted">The order here is the rotation order. Changes take effect straight away, including this week.</p>
    <div class="alist">${rows || '<p class="muted">No housemates yet.</p>'}</div>
    <form class="add-row" data-submit="add-person">
      <input class="input grow" type="text" name="name" placeholder="New housemate’s name" maxlength="40" required aria-label="New housemate’s name">
      <button class="btn">Add</button>
    </form>
    ${rotationSummary(c) ? `<p class="note">${icon('info')}${esc(rotationSummary(c))}</p>` : ''}
  </section>`;
}

function zoneSelect(room, c) {
  const opts = c.zones.map((z) => `<option value="${esc(z.id)}" ${z.id === room.zoneId ? 'selected' : ''}>${esc(z.name)}</option>`).join('');
  const none = c.zones.some((z) => z.id === room.zoneId) ? '' : '<option value="" selected>No zone</option>';
  return `<select class="input" data-change="room-zone" data-id="${esc(room.id)}" aria-label="Zone for ${esc(room.name)}">${none}${opts}</select>`;
}

function roomRow(room, c) {
  const n = c.tasks.filter((t) => t.roomId === room.id).length;
  return `
  <div class="room-row">
    <input class="input" type="text" value="${esc(room.name)}" data-change="room-name" data-id="${esc(room.id)}" aria-label="Room name" maxlength="60">
    <div class="room-row-sub">
      <span class="tag">${n} task${n === 1 ? '' : 's'}</span>
      <span class="room-row-label">Zone</span>
      ${zoneSelect(room, c)}
      <button class="icon-btn danger" data-action="room-remove" data-id="${esc(room.id)}" aria-label="Delete ${esc(room.name)}">${icon('trash')}</button>
    </div>
  </div>`;
}

function adminRooms() {
  const c = state.config;
  const zones = c.zones
    .map((z, i) => {
      const rooms = c.rooms.filter((r) => r.zoneId === z.id);
      return `
      <section class="card zone">
        <div class="zone-head">
          <span class="zone-num">Zone ${i + 1}</span>
          <input class="input grow strong" type="text" value="${esc(z.name)}" data-change="zone-name" data-id="${esc(z.id)}" aria-label="Zone name" maxlength="60">
          <button class="icon-btn" data-action="zone-up" data-id="${esc(z.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Move zone up">${icon('up')}</button>
          <button class="icon-btn" data-action="zone-down" data-id="${esc(z.id)}" ${i === c.zones.length - 1 ? 'disabled' : ''} aria-label="Move zone down">${icon('down')}</button>
          <button class="icon-btn danger" data-action="zone-remove" data-id="${esc(z.id)}" aria-label="Delete zone ${esc(z.name)}">${icon('trash')}</button>
        </div>
        <div class="alist">${rooms.map((r) => roomRow(r, c)).join('') || '<p class="muted small">No rooms in this zone yet.</p>'}</div>
        <form class="add-row" data-submit="add-room" data-id="${esc(z.id)}">
          <input class="input grow" type="text" name="name" placeholder="Add a room to ${esc(z.name)}" maxlength="60" required aria-label="New room name">
          <button class="btn">Add room</button>
        </form>
      </section>`;
    })
    .join('');

  const orphans = S.unassignedRooms(c);
  return `
  <p class="muted intro">Zones are what rotate: each week every zone goes to one housemate. ${esc(rotationSummary(c))}</p>
  ${
    orphans.length
      ? `<section class="card zone warn"><h2>Not in a zone</h2><p class="muted small">These rooms aren’t on anyone’s list until you choose a zone.</p><div class="alist">${orphans.map((r) => roomRow(r, c)).join('')}</div></section>`
      : ''
  }
  ${zones}
  <form class="add-row card" data-submit="add-zone">
    <input class="input grow" type="text" name="name" placeholder="New zone name" maxlength="60" required aria-label="New zone name">
    <button class="btn">Add zone</button>
  </form>`;
}

function everySelect(task, attrs) {
  const opts = Array.from({ length: MAX_EVERY }, (_, i) => i + 1)
    .map((n) => `<option value="${n}" ${Number(task.every) === n ? 'selected' : ''}>${esc(S.frequencyLabel(n))}</option>`)
    .join('');
  return `<select class="input every" ${attrs} aria-label="How often">${opts}</select>`;
}

function taskAdminRow(t, c) {
  const reach = S.reachablePeople(c, t);
  const warn =
    Number(t.every) > 1 && c.people.length > 1 && reach.length > 0 && reach.length < c.people.length
      ? `<span class="row-warn">${icon('info')}With ${c.people.length} housemates this only ever lands on ${esc(reach.map((p) => p.name).join(' & '))}</span>`
      : '';
  const upcoming = S.upcoming(c, t, S.currentWeekId(), SCHEDULE_COUNT);
  const tally = taskTally(t, c);
  const next = Number(t.every) > 1 ? upcoming[0]?.weekId : null;
  const nextTxt = next ? `<span class="row-sub">Next due: ${esc(weekRelative(next) === 'This week' ? 'this week' : S.weekLabel(next))}</span>` : '';
  return `
  <div class="trow">
    <div class="trow-main">
      <input class="input grow" type="text" value="${esc(t.name)}" data-change="task-name" data-id="${esc(t.id)}" aria-label="Task" maxlength="160">
      ${everySelect(t, `data-change="task-every" data-id="${esc(t.id)}"`)}
      <button class="icon-btn danger" data-action="task-remove" data-id="${esc(t.id)}" aria-label="Delete task: ${esc(t.name)}">${icon('trash')}</button>
    </div>
    ${tally}
    ${nextTxt || warn ? `<div class="trow-sub">${nextTxt}${warn}</div>` : ''}
    ${scheduleDetails(t, upcoming)}
  </div>`;
}

const SCHEDULE_COUNT = 6;

// Horizontal "who gets it" summary over the next 2 × housemates occurrences
// (two full turns each if the task reaches everyone). Zeros are shown dimmed
// so a housemate who never gets the task stands out.
function taskTally(t, c) {
  const N = c.people.length;
  if (!N) return '';
  const count = 2 * N;
  const { people, nobody } = S.tallyUpcoming(c, t, S.currentWeekId(), count);
  const spoken = [...people.map(({ person, n }) => `${person.name} ${n}`), ...(nobody ? [`no one ${nobody}`] : [])].join(', ');
  const chips = people
    .map(({ person, n }) => `<span class="tally-chip${n ? '' : ' zero'}" title="${esc(person.name)}">${avatar(person, 'sm')}<span>${n}</span></span>`)
    .join('');
  return `
    <p class="tally" aria-label="${esc(`Next ${count} times: ${spoken}`)}">
      <span class="tally-label" aria-hidden="true">Next ${count}</span>
      <span class="tally-chips" aria-hidden="true">${chips}${nobody ? `<span class="tally-chip nobody">No zone <span>${nobody}</span></span>` : ''}</span>
    </p>`;
}

/**
 * Week label for lists that can reach into later years. Weeks starting this
 * year: "23–29 Nov". Later: "4–10 Jan 2027". A later week spanning New Year
 * gets both years: "27 Dec 2027 – 2 Jan 2028".
 */
function weekName(id) {
  const rel = weekRelative(id);
  if (rel === 'This week' || rel === 'Next week') return rel;
  const start = S.parseWeekId(id);
  const end = new Date(start.getTime() + 6 * S.DAY_MS);
  const [sy, ey] = [start.getUTCFullYear(), end.getUTCFullYear()];
  if (sy === S.parseWeekId(S.currentWeekId()).getUTCFullYear()) return S.weekLabel(id);
  if (sy === ey) return `${S.weekLabel(id)} ${sy}`;
  const d = (x) => x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${d(start)} ${sy} – ${d(end)} ${ey}`;
}

// Expand/collapse state lives in state.openSchedules so re-renders (any
// housemate's change) don't close an open list. See the 'toggle' listener.
function scheduleDetails(t, upcoming) {
  const open = state.openSchedules.has(t.id);
  const who = (personId) => {
    const p = personId && findPerson(personId);
    if (p) return `${avatar(p, 'sm')}<span>${esc(p.name)}</span>`;
    return `<span class="muted">${state.config.people.length ? 'No one (room isn’t in a zone)' : 'No one yet'}</span>`;
  };
  const items = upcoming
    .map(({ weekId, personId }) => `<li><span class="sched-when">${esc(weekName(weekId))}</span><span class="sched-who">${who(personId)}</span></li>`)
    .join('');
  return `
    <details class="sched" data-sched="${esc(t.id)}" ${open ? 'open' : ''}>
      <summary>${icon('right')}<span class="sched-show">Show next ${SCHEDULE_COUNT}</span><span class="sched-hide">Hide schedule</span></summary>
      <ol class="sched-list" aria-label="Next ${SCHEDULE_COUNT} times “${esc(t.name)}” is due">${items}</ol>
    </details>`;
}

function adminTasks() {
  const c = state.config;
  if (!c.rooms.length) return `<section class="card"><p class="muted">Add a room first (Rooms &amp; zones), then add its tasks here.</p></section>`;
  const zoneName = (id) => c.zones.find((z) => z.id === id)?.name || 'No zone';
  return c.rooms
    .map((r) => {
      const tasks = c.tasks.filter((t) => t.roomId === r.id);
      return `
      <section class="card">
        <div class="room-admin-head"><h2>${esc(r.name)}</h2><span class="tag">${esc(zoneName(r.zoneId))}</span></div>
        <div class="tlist">${tasks.map((t) => taskAdminRow(t, c)).join('') || '<p class="muted small">No tasks yet.</p>'}</div>
        <form class="add-row" data-submit="add-task" data-id="${esc(r.id)}">
          <input class="input grow" type="text" name="name" placeholder="New task in ${esc(r.name)}" maxlength="160" required aria-label="New task name">
          ${everySelect({ every: 1 }, 'name="every"')}
          <button class="btn">Add</button>
        </form>
      </section>`;
    })
    .join('');
}

function adminRotation() {
  const c = state.config;
  if (!c.people.length || !c.zones.length) return `<section class="card"><p class="muted">Add housemates and zones to see the rotation.</p></section>`;
  const start = S.currentWeekId();
  const weeks = [];
  for (let i = 0; i < 8; i++) {
    const id = S.addWeeks(start, i);
    weeks.push({ id, a: S.allocate(c, id) });
  }
  const head = c.people.map((p) => `<th scope="col">${avatar(p, 'sm')}<span>${esc(p.name)}</span></th>`).join('');
  const rows = weeks
    .map(
      ({ id, a }) => `
    <tr>
      <th scope="row"><strong>${esc(weekRelative(id))}</strong><span>${esc(S.weekLabel(id))}</span></th>
      ${a.people
        .map((p) =>
          p.weekOff
            ? `<td class="off">Week off</td>`
            : `<td><span class="cell-zone">${esc(zoneNames(p.zones))}</span><span class="cell-n">${p.tasks.length} tasks</span></td>`,
        )
        .join('')}
    </tr>`,
    )
    .join('');
  return `
  <section class="card">
    <h2>Next 8 weeks</h2>
    <p class="muted">${esc(rotationSummary(c))} Task counts include the occasional (every few weeks) tasks due that week.</p>
    <div class="table-scroll"><table class="rota-table"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
  </section>
  <section class="card">
    <h2>Nudge the rotation</h2>
    <p class="muted">If the rota’s out of step with what’s actually happening (say, after a swap), move everyone along. This only changes who has which zone — task frequencies stay as they are.</p>
    <div class="btn-row">
      <button class="btn" data-action="shift" data-id="-1">${icon('left')}Back a week</button>
      <button class="btn" data-action="shift" data-id="1">Forward a week${icon('right')}</button>
    </div>
  </section>`;
}

function adminSettings() {
  const c = state.config;
  return `
  <section class="card">
    <h2>House name</h2>
    <input class="input" type="text" value="${esc(c.houseName)}" data-change="house-name" aria-label="House name" maxlength="40">
  </section>
  <section class="card">
    <h2>Backup</h2>
    <p class="muted">Download all housemates, rooms and tasks as a file.</p>
    <button class="btn" data-action="export">${icon('download')}Download backup</button>
  </section>
  <section class="card">
    <h2>Sharing</h2>
    <p class="muted">${
      store.mode === 'demo'
        ? 'Demo mode: everything is saved in this browser only. Follow the README to connect Firebase so housemates share one rota.'
        : 'Connected to Firebase. Send housemates the rota link below (not this admin page). Each person picks their name the first time.'
    }</p>
    <p class="share-link"><a class="link" href="${SITE_ROOT}">${esc(new URL(SITE_ROOT, location.href).href)}</a></p>
    ${store.mode === 'demo' ? `<button class="btn danger-outline" data-action="reset-demo">Reset demo data</button>` : ''}
  </section>`;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

// keepThisWeek: after adding/removing people or zones, re-pick the rotation
// shift so as few of this week's assignments change as possible.
async function mutate(fn, msg = 'Saved', { keepThisWeek = false } = {}) {
  const next = structuredClone(state.config);
  if (fn(next) === false) return;
  if (keepThisWeek) next.rotationShift = S.stableShift(state.config, next, S.currentWeekId());
  state.config = next;
  render();
  try {
    await store.saveConfig(next);
    toast(msg);
  } catch (e) {
    console.error(e);
    toast('Couldn’t save — check your connection', true);
  }
}

const move = (arr, id, dir) => {
  const i = arr.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return false;
  [arr[i], arr[j]] = [arr[j], arr[i]];
};

async function toggleTask(taskId, checked) {
  if (isFutureWeek() || !state.weekLoaded) return render();
  const weekId = state.weekId;
  const prev = state.week.done[taskId];
  const by = me() ? state.me : S.assigneeOf(state.config, taskId, weekId);
  if (checked) state.week.done[taskId] = { by, at: Date.now() };
  else delete state.week.done[taskId];
  render();
  try {
    if (checked) await store.setDone(weekId, taskId, by);
    else await store.setUndone(weekId, taskId);
  } catch (e) {
    console.error(e);
    if (weekId === state.weekId) {
      if (prev) state.week.done[taskId] = prev;
      else delete state.week.done[taskId];
      render();
      root.querySelectorAll(`input[data-task="${CSS.escape(taskId)}"]`).forEach((el) => (el.checked = !!prev));
    }
    toast('Couldn’t save that tick — try again', true);
  }
}

function setWeek(id) {
  state.weekId = id;
  watchWeek();
  render();
}

const actions = {
  'pick-me': (id) => {
    state.me = id;
    storageSet(localStorage, LS_ME, id);
    location.hash = '#/';
    render();
  },
  'switch-me': () => {
    state.me = null;
    storageSet(localStorage, LS_ME, null);
    location.hash = '#/';
    render();
  },
  'week-prev': () => setWeek(S.addWeeks(state.weekId, -1)),
  'week-next': () => setWeek(S.addWeeks(state.weekId, 1)),
  'week-now': () => setWeek(S.currentWeekId()),
  seed: async () => {
    try {
      await store.createConfig(buildSeedConfig());
      toast('Rota set up');
    } catch (e) {
      console.error(e);
      if (e?.code === 'exists') toast('A rota already exists — loading it');
      else toast('Couldn’t set up — check your connection and the Firebase setup', true);
    }
  },
  'admin-tab': (id) => {
    state.adminTab = id;
    render();
    root.querySelector('.seg.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },
  'person-up': (id) => mutate((c) => move(c.people, id, -1)),
  'person-down': (id) => mutate((c) => move(c.people, id, 1)),
  'person-color': (id) =>
    mutate((c) => {
      const p = c.people.find((x) => x.id === id);
      const i = PERSON_COLORS.indexOf(p.color);
      p.color = PERSON_COLORS[(i + 1) % PERSON_COLORS.length];
    }),
  'person-remove': (id) => {
    const p = findPerson(id);
    if (!p || !confirm(`Remove ${p.name}? The rotation will be recalculated for everyone, keeping this week as close to unchanged as possible.`)) return;
    mutate((c) => {
      c.people = c.people.filter((x) => x.id !== id);
    }, `${p.name} removed`, { keepThisWeek: true });
  },
  'zone-up': (id) => mutate((c) => move(c.zones, id, -1)),
  'zone-down': (id) => mutate((c) => move(c.zones, id, 1)),
  'zone-remove': (id) => {
    const c0 = state.config;
    const z = c0.zones.find((x) => x.id === id);
    const n = c0.rooms.filter((r) => r.zoneId === id).length;
    const msg = n
      ? `Delete zone “${z.name}”? Its ${n} room${n > 1 ? 's' : ''} will be left without a zone (not on anyone’s list) until you move ${n > 1 ? 'them' : 'it'}.`
      : `Delete zone “${z.name}”?`;
    if (!confirm(msg)) return;
    mutate((c) => {
      c.zones = c.zones.filter((x) => x.id !== id);
    }, 'Zone deleted', { keepThisWeek: true });
  },
  'room-remove': (id) => {
    const c0 = state.config;
    const r = c0.rooms.find((x) => x.id === id);
    const n = c0.tasks.filter((t) => t.roomId === id).length;
    if (!confirm(`Delete “${r.name}”${n ? ` and its ${n} task${n > 1 ? 's' : ''}` : ''}?`)) return;
    mutate((c) => {
      c.rooms = c.rooms.filter((x) => x.id !== id);
      c.tasks = c.tasks.filter((t) => t.roomId !== id);
    }, 'Room deleted');
  },
  'task-remove': (id) => {
    const t = state.config.tasks.find((x) => x.id === id);
    if (!t || !confirm(`Delete “${t.name}”?`)) return;
    mutate((c) => {
      c.tasks = c.tasks.filter((x) => x.id !== id);
    }, 'Task deleted');
  },
  shift: (dir) =>
    mutate((c) => {
      c.rotationShift = (Number(c.rotationShift) || 0) + Number(dir);
    }, Number(dir) > 0 ? 'Moved forward a week' : 'Moved back a week'),
  export: () => {
    const blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cleaning-rota-backup-${S.currentWeekId()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'reset-demo': () => {
    if (!confirm('Reset the demo? This clears all demo data in this browser.')) return;
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('rota-demo:') || k === LS_ME)
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* ignore */
    }
    location.reload();
  },
};

const changes = {
  'person-name': (id, v) => {
    const name = clean(v, 40);
    if (!name) return render();
    mutate((c) => {
      c.people.find((p) => p.id === id).name = name;
    });
  },
  'zone-name': (id, v) => {
    const name = clean(v, 60);
    if (!name) return render();
    mutate((c) => {
      c.zones.find((z) => z.id === id).name = name;
    });
  },
  'room-name': (id, v) => {
    const name = clean(v, 60);
    if (!name) return render();
    mutate((c) => {
      c.rooms.find((r) => r.id === id).name = name;
    });
  },
  'room-zone': (id, v) =>
    mutate((c) => {
      c.rooms.find((r) => r.id === id).zoneId = v || null;
    }, 'Room moved'),
  'task-name': (id, v) => {
    const name = clean(v);
    if (!name) return render();
    mutate((c) => {
      c.tasks.find((t) => t.id === id).name = name;
    });
  },
  'task-every': (id, v) =>
    mutate((c) => {
      const t = c.tasks.find((x) => x.id === id);
      t.every = Math.min(MAX_EVERY, Math.max(1, Number(v) || 1));
      t.offset = S.offsetStartingAt(t.every, S.weekIndex(S.currentWeekId(), c.anchor));
    }),
  'house-name': (_id, v) => {
    const name = clean(v, 40) || 'Cleaning Rota';
    mutate((c) => {
      c.houseName = name;
    });
  },
};

const submits = {
  'add-person': (_id, data) => {
    const name = clean(data.get('name'), 40);
    if (!name) return;
    mutate((c) => {
      c.people.push({ id: S.newId('person'), name, color: nextColor(c) });
    }, `${name} added`, { keepThisWeek: true });
  },
  'add-zone': (_id, data) => {
    const name = clean(data.get('name'), 60);
    if (!name) return;
    mutate((c) => {
      c.zones.push({ id: S.newId('zone'), name });
    }, 'Zone added', { keepThisWeek: true });
  },
  'add-room': (zoneId, data) => {
    const name = clean(data.get('name'), 60);
    if (!name) return;
    mutate((c) => {
      c.rooms.push({ id: S.newId('room'), name, zoneId });
    }, 'Room added');
  },
  'add-task': (roomId, data) => {
    const name = clean(data.get('name'));
    if (!name) return;
    const every = Math.min(MAX_EVERY, Math.max(1, Number(data.get('every')) || 1));
    mutate((c) => {
      const offset = S.offsetStartingAt(every, S.weekIndex(S.currentWeekId(), c.anchor));
      c.tasks.push({ id: S.newId('task'), roomId, name, every, offset });
    }, 'Task added');
  },
};

// Admin actions only run on the admin page (and seeding only there too).
const ADMIN_ONLY = /^(person-|zone-|room-|task-|shift|export|house-|add-|reset-demo|seed|admin-)/;
const adminAllowed = (name) => IS_ADMIN || !ADMIN_ONLY.test(name);

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const name = el.dataset.action;
  if (!actions[name] || !adminAllowed(name)) return;
  e.preventDefault();
  actions[name](el.dataset.id);
});

root.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-task]')) return toggleTask(el.dataset.task, el.checked);
  const name = el.dataset.change;
  if (!name || !changes[name] || !adminAllowed(name)) return;
  changes[name](el.dataset.id, el.value);
});

root.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-submit]');
  if (!form) return;
  e.preventDefault();
  const name = form.dataset.submit;
  if (!submits[name] || !adminAllowed(name)) return;
  const data = new FormData(form);
  const input = form.querySelector('input[type=text]');
  if (input) input.value = '';
  form.querySelector('input')?.blur();
  submits[name](form.dataset.id, data);
});

// Enter in an inline-edit field commits it (fires `change` via blur).
root.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input[data-change]')) {
    e.preventDefault();
    e.target.blur();
  }
  if (e.key === 'Escape' && e.target.matches('input[data-change]')) {
    e.target.value = e.target.defaultValue;
    e.target.blur();
  }
});

// <details> 'toggle' doesn't bubble, so listen in the capture phase.
root.addEventListener(
  'toggle',
  (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.dataset.sched) return;
    if (d.open) state.openSchedules.add(d.dataset.sched);
    else state.openSchedules.delete(d.dataset.sched);
  },
  true,
);

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

// ---------------------------------------------------------------------------
// Icons (inline SVG, inherit currentColor)
// ---------------------------------------------------------------------------

function icon(name) {
  const p = {
    sparkle: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    left: '<path d="M15 18l-6-6 6-6"/>',
    right: '<path d="M9 18l6-6-6-6"/>',
    up: '<path d="M18 15l-6-6-6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    tick: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    party: '<path d="M4 20l4-11 7 7z"/><path d="M14 4l1 2M19 9l-2 1M17 3l-1 3M21 5l-3 1"/>',
  }[name];
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

render();
