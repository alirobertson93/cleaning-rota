// Pure scheduling logic — no DOM, no storage. Safe to import from Node tests.
//
// Model (mirrors the original Google Sheet):
//   - Rooms belong to zones. Zones rotate between housemates weekly.
//   - In week index w, zone at position z is held by person at position
//     mod(z - w, N), where N = number of housemates. With N > zones, the
//     people not holding a zone that week have a week off. With N < zones,
//     some people hold more than one zone.
//   - A task is due in week w when mod(w - task.offset, task.every) === 0.
//   - Week index is counted in whole weeks from config.anchor (a Monday,
//     YYYY-MM-DD). The default anchor 2025-01-20 continues the sheet's
//     rotation exactly.

export const DAY_MS = 86400000;
export const WEEK_MS = 7 * DAY_MS;

export const mod = (a, n) => ((a % n) + n) % n;

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/** Monday (as a UTC-midnight Date) of the week containing the given local date. */
export function mondayOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(d.getTime() - dow * DAY_MS);
}

export const weekIdOf = (utcDate) => utcDate.toISOString().slice(0, 10);
export const currentWeekId = (now = new Date()) => weekIdOf(mondayOf(now));

export function parseWeekId(id) {
  const [y, m, d] = String(id).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export const addWeeks = (id, n) => weekIdOf(new Date(parseWeekId(id).getTime() + n * WEEK_MS));

export const weekIndex = (id, anchorId) =>
  Math.round((parseWeekId(id).getTime() - parseWeekId(anchorId).getTime()) / WEEK_MS);

export const isValidWeekId = (id) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(id)) && parseWeekId(id).getUTCDay() === 1;

/** "9–15 Nov" / "29 Dec – 4 Jan" */
export function weekLabel(id) {
  const start = parseWeekId(id);
  const end = new Date(start.getTime() + 6 * DAY_MS);
  const fmt = (d, withMonth) =>
    d.toLocaleDateString('en-GB', { day: 'numeric', month: withMonth ? 'short' : undefined, timeZone: 'UTC' });
  if (start.getUTCMonth() === end.getUTCMonth()) return `${start.getUTCDate()}–${fmt(end, true)}`;
  return `${fmt(start, true)} – ${fmt(end, true)}`;
}

export function isDue(task, w) {
  const every = Math.max(1, Math.floor(Number(task.every) || 1));
  return mod(w - (Math.floor(Number(task.offset)) || 0), every) === 0;
}

/** Map of zoneId -> personId for week index w. */
export function zoneHolders(config, w) {
  const people = config.people || [];
  const zones = config.zones || [];
  const holders = new Map();
  if (people.length === 0) return holders;
  const shift = Math.floor(Number(config.rotationShift)) || 0;
  zones.forEach((zone, z) => holders.set(zone.id, people[mod(z - w - shift, people.length)].id));
  return holders;
}

/**
 * Full allocation for a week.
 * Returns { weekId, w, people: [{ person, zones, rooms: [{ room, tasks }], tasks, weekOff }] }
 * People keep config order. Rooms and tasks keep config order. Rooms with no
 * due tasks that week are omitted. Rooms whose zone doesn't exist are not
 * allocated (see unassignedRooms).
 */
export function allocate(config, weekId) {
  const w = weekIndex(weekId, config.anchor);
  const holders = zoneHolders(config, w);
  const zonesById = new Map((config.zones || []).map((z) => [z.id, z]));
  const tasksByRoom = new Map();
  for (const t of config.tasks || []) {
    if (!isDue(t, w)) continue;
    if (!tasksByRoom.has(t.roomId)) tasksByRoom.set(t.roomId, []);
    tasksByRoom.get(t.roomId).push(t);
  }

  const people = (config.people || []).map((person) => {
    const zones = (config.zones || []).filter((z) => holders.get(z.id) === person.id);
    const zoneIds = new Set(zones.map((z) => z.id));
    const rooms = (config.rooms || [])
      .filter((r) => zoneIds.has(r.zoneId))
      .map((room) => ({ room, tasks: tasksByRoom.get(room.id) || [] }))
      .filter((r) => r.tasks.length > 0);
    const tasks = rooms.flatMap((r) => r.tasks);
    return { person, zones, rooms, tasks, weekOff: zones.length === 0 };
  });

  return { weekId, w, people, zonesById };
}

/** Which person (id) is responsible for a task in a given week, or null. */
export function assigneeOf(config, taskId, weekId) {
  const task = (config.tasks || []).find((t) => t.id === taskId);
  if (!task) return null;
  const room = (config.rooms || []).find((r) => r.id === task.roomId);
  if (!room) return null;
  return zoneHolders(config, weekIndex(weekId, config.anchor)).get(room.zoneId) || null;
}

/**
 * The next `count` weeks (from fromWeekId inclusive) a task is due, and who
 * holds it each time: [{ weekId, personId }]. personId is null when the
 * task's room isn't in a zone or there are no people.
 */
export function upcoming(config, task, fromWeekId, count = 6) {
  const every = Math.max(1, Math.floor(Number(task.every) || 1));
  const w0 = weekIndex(fromWeekId, config.anchor);
  const room = (config.rooms || []).find((r) => r.id === task.roomId);
  const out = [];
  for (let i = 0; out.length < count && i < (count + 1) * every; i++) {
    if (!isDue(task, w0 + i)) continue;
    const personId = room ? zoneHolders(config, w0 + i).get(room.zoneId) || null : null;
    out.push({ weekId: addWeeks(fromWeekId, i), personId });
  }
  return out;
}

/**
 * How the next `count` occurrences of a task split between housemates.
 * Returns { people: [{ person, n }] in config order (n may be 0), nobody }
 * where nobody counts occurrences with no holder (room not in a zone).
 */
export function tallyUpcoming(config, task, fromWeekId, count) {
  const counts = new Map();
  let nobody = 0;
  for (const { personId } of upcoming(config, task, fromWeekId, count)) {
    if (personId) counts.set(personId, (counts.get(personId) || 0) + 1);
    else nobody++;
  }
  return { people: (config.people || []).map((person) => ({ person, n: counts.get(person.id) || 0 })), nobody };
}

export function unassignedRooms(config) {
  const zoneIds = new Set((config.zones || []).map((z) => z.id));
  return (config.rooms || []).filter((r) => !zoneIds.has(r.zoneId));
}

/**
 * Which people a recurring task can ever land on. With N housemates and a
 * task every k weeks, only N / gcd(k, N) distinct people ever get it — e.g.
 * a 4-weekly task with 4 housemates always lands on the same person.
 */
export function reachablePeople(config, task) {
  const people = config.people || [];
  const N = people.length;
  if (N === 0) return [];
  const room = (config.rooms || []).find((r) => r.id === task.roomId);
  const z = (config.zones || []).findIndex((zz) => zz.id === room?.zoneId);
  if (z < 0) return [];
  const every = Math.max(1, Math.floor(Number(task.every) || 1));
  const offset = Math.floor(Number(task.offset)) || 0;
  const shift = Math.floor(Number(config.rotationShift)) || 0;
  const seen = new Set();
  const steps = N / gcd(every, N);
  for (let j = 0; j < steps; j++) seen.add(mod(z - (offset + j * every) - shift, N));
  return [...seen].sort((a, b) => a - b).map((i) => people[i]);
}

/**
 * Offset that makes a task first due in week index w (used when a task is
 * added or its frequency changes, so it shows up on this week's list).
 */
export function offsetStartingAt(every, w) {
  const n = Math.max(1, Math.floor(Number(every) || 1));
  return mod(w, n);
}

/**
 * After people or zones change, pick a rotationShift for `next` that keeps
 * as many of this week's zone holders the same as under `prev` — so adding a
 * housemate mid-week doesn't reshuffle everyone who's already started.
 * Ties prefer the shift closest to the previous one.
 */
export function stableShift(prev, next, weekId) {
  const N = (next.people || []).length;
  if (!N || !(next.zones || []).length) return Math.floor(Number(next.rotationShift)) || 0;
  const before = zoneHolders(prev, weekIndex(weekId, prev.anchor));
  const w = weekIndex(weekId, next.anchor);
  const base = Math.floor(Number(prev.rotationShift)) || 0;
  let best = null;
  for (let d = 0; d < N; d++) {
    for (const s of d === 0 ? [base] : [base + d, base - d]) {
      const after = zoneHolders({ ...next, rotationShift: s }, w);
      let kept = 0;
      for (const [zoneId, personId] of after) if (before.get(zoneId) === personId) kept++;
      if (!best || kept > best.kept) best = { s, kept };
    }
  }
  return best.s;
}

/** Number of due tasks per person for `count` weeks starting at weekId. */
export function loadPreview(config, weekId, count = 8) {
  const weeks = [];
  for (let i = 0; i < count; i++) {
    const id = addWeeks(weekId, i);
    const a = allocate(config, id);
    weeks.push({ weekId: id, counts: a.people.map((p) => (p.weekOff ? null : p.tasks.length)) });
  }
  return weeks;
}

export function frequencyLabel(every) {
  const n = Math.max(1, Math.floor(Number(every) || 1));
  return n === 1 ? 'Weekly' : `Every ${n} weeks`;
}

let idCounter = 0;
export function newId(prefix) {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
