// Pure scheduling logic — no DOM, no storage. Safe to import from Node tests.
//
// Model (mirrors the original Google Sheet):
//   - Rooms belong to zones. Zones rotate between housemates weekly.
//   - In week index w, zone at position z is held by person at position
//     mod(z - w, N), where N = number of housemates. With N > zones, the
//     people not holding a zone that week have a week off. With N < zones,
//     some people hold more than one zone.
//   - A task is due in week w when mod(w - task.offset, task.every) === 0.
//   - Exemptions (task.exempt = [personId]): a person exempt from every task
//     in a zone is skipped by that zone — it goes to the next person in line
//     (whoever holds it the following week). A person exempt from only some
//     tasks keeps the zone, and each exempt task goes to the next person in
//     line who isn't exempt, in the same week.
//   - Bins (config.bins) are separate from the zone rotation: the admin lists
//     collection dates; each week with a collection (counting the evening
//     before, when the bins go out) goes to the next non-exempt housemate.
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

export const isExempt = (task, personId) => Array.isArray(task?.exempt) && task.exempt.includes(personId);

// zoneId -> Set(personId) of people exempt from every task in that zone.
// Cached per config object; the app never mutates a config in place (it
// clones before every change), and the array identities guard the rest.
const skipCache = new WeakMap();
function skipsByZone(config) {
  const hit = skipCache.get(config);
  if (hit && hit.tasks === config.tasks && hit.rooms === config.rooms && hit.people === config.people) return hit.map;
  const zoneOfRoom = new Map((config.rooms || []).map((r) => [r.id, r.zoneId]));
  const tasksByZone = new Map();
  for (const t of config.tasks || []) {
    const z = zoneOfRoom.get(t.roomId);
    if (z == null) continue;
    if (!tasksByZone.has(z)) tasksByZone.set(z, []);
    tasksByZone.get(z).push(t);
  }
  const map = new Map();
  for (const [z, tasks] of tasksByZone) {
    map.set(z, new Set((config.people || []).filter((p) => tasks.every((t) => isExempt(t, p.id))).map((p) => p.id)));
  }
  skipCache.set(config, { tasks: config.tasks, rooms: config.rooms, people: config.people, map });
  return map;
}

/** People exempt from every task in a zone, so the zone skips them. A zone with no tasks skips no one. */
export function zoneSkips(config, zoneId) {
  const skip = skipsByZone(config).get(zoneId) || new Set();
  return (config.people || []).filter((p) => skip.has(p.id));
}

/**
 * Map of zoneId -> personId (or null) for week index w. The rotation puts
 * zone z with people[mod(z - w - shift, N)]; if that person is exempt from
 * the whole zone it passes down the line (people[i - 1] holds it next week).
 */
export function zoneHolders(config, w) {
  const people = config.people || [];
  const zones = config.zones || [];
  const holders = new Map();
  const N = people.length;
  if (N === 0) return holders;
  const shift = Math.floor(Number(config.rotationShift)) || 0;
  const skips = skipsByZone(config);
  zones.forEach((zone, z) => {
    const skip = skips.get(zone.id);
    const i = mod(z - w - shift, N);
    let holder = null;
    for (let j = 0; j < N; j++) {
      const p = people[mod(i - j, N)];
      if (!skip?.has(p.id)) {
        holder = p.id;
        break;
      }
    }
    holders.set(zone.id, holder);
  });
  return holders;
}

/**
 * Who does a (due) task given this week's zone holders: the zone holder,
 * or — if they're exempt from this task — the next person in line for that
 * zone who isn't. null if the room isn't in a zone or everyone is exempt.
 */
function taskAssignee(config, task, holders) {
  const room = (config.rooms || []).find((r) => r.id === task.roomId);
  if (!room) return null;
  const holder = holders.get(room.zoneId);
  if (!holder) return null;
  if (!isExempt(task, holder)) return holder;
  const people = config.people || [];
  const i = people.findIndex((p) => p.id === holder);
  for (let j = 1; j < people.length; j++) {
    const p = people[mod(i - j, people.length)];
    if (!isExempt(task, p.id)) return p.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bins
// ---------------------------------------------------------------------------

export const BINS_ID = 'bins'; // pseudo zone / room / task id; weeks/{id}.done.bins
export const BIN_TYPES = [
  { id: 'recycling', name: 'Recycling' },
  { id: 'general', name: 'General waste' },
];
const BINS_ZONE = { id: BINS_ID, name: 'Bins' };
const BINS_ROOM = { id: BINS_ID, name: 'Bins' };

/** YYYY-MM-DD that is a real calendar date. */
export const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && weekIdOf(parseWeekId(s)) === s;

/** Bins go out the evening before collection; the bin week is the week of that evening. */
export function binWeekOf(date) {
  const out = parseWeekId(date).getTime() - DAY_MS;
  const dow = (new Date(out).getUTCDay() + 6) % 7;
  return weekIdOf(new Date(out - dow * DAY_MS));
}

/** Weeks with at least one collection, sorted: [{ weekId, collections: [{ type, date }] }]. */
export function binWeeks(config) {
  const bins = config.bins || {};
  const byWeek = new Map();
  BIN_TYPES.forEach(({ id: type }) => {
    for (const date of new Set(Array.isArray(bins[type]) ? bins[type] : [])) {
      if (!isValidDate(date)) continue;
      const wk = binWeekOf(date);
      if (!byWeek.has(wk)) byWeek.set(wk, []);
      byWeek.get(wk).push({ type, date });
    }
  });
  const order = (type) => BIN_TYPES.findIndex((b) => b.id === type);
  return [...byWeek.keys()].sort().map((weekId) => ({
    weekId,
    collections: byWeek.get(weekId).sort((a, b) => a.date.localeCompare(b.date) || order(a.type) - order(b.type)),
  }));
}

/** Housemates in the bins queue (config order, minus exemptions). */
export function binEligible(config) {
  const ex = new Set(Array.isArray(config.bins?.exempt) ? config.bins.exempt : []);
  return (config.people || []).filter((p) => !ex.has(p.id));
}

// The k-th bin week (0 = earliest date on file) goes to eligible[k + shift].
function binHolder(config, k, eligible = binEligible(config)) {
  if (!eligible.length) return null;
  const shift = Math.floor(Number(config.bins?.shift)) || 0;
  return eligible[mod(k + shift, eligible.length)].id;
}

/** Bin duty for a week: { weekId, collections, personId } — or null if nothing is collected. */
export function binsForWeek(config, weekId) {
  const weeks = binWeeks(config);
  const k = weeks.findIndex((b) => b.weekId === weekId);
  return k < 0 ? null : { ...weeks[k], personId: binHolder(config, k) };
}

/** The next `count` bin weeks from fromWeekId (inclusive), with who's on them. */
export function upcomingBins(config, fromWeekId, count = 6) {
  const weeks = binWeeks(config);
  const eligible = binEligible(config);
  const out = [];
  for (let k = 0; k < weeks.length && out.length < count; k++) {
    if (weeks[k].weekId >= fromWeekId) out.push({ ...weeks[k], personId: binHolder(config, k, eligible) });
  }
  return out;
}

/** The task that appears on the bin person's list. */
export const binsTask = (collections) => ({ id: BINS_ID, roomId: BINS_ID, name: 'Put the bins out', every: 1, collections });

/**
 * After people, exemptions or dates change, pick bins.shift for `next` so
 * whoever was on the next bin week (from weekId) still is — or, if they're
 * gone or now exempt, the next person after them in line.
 */
export function stableBinShift(prev, next, weekId) {
  const base = Math.floor(Number(next.bins?.shift)) || 0;
  const was = upcomingBins(prev, weekId, 1)[0];
  const k = binWeeks(next).findIndex((b) => b.weekId >= weekId);
  const eligible = binEligible(next);
  if (!was?.personId || k < 0 || !eligible.length) return base;
  const people = prev.people || [];
  const start = people.findIndex((p) => p.id === was.personId);
  for (let j = 0; j < people.length; j++) {
    const i = eligible.findIndex((e) => e.id === people[mod(start + j, people.length)].id);
    if (i >= 0) return mod(i - k, eligible.length);
  }
  return base;
}

/**
 * Full allocation for a week.
 * Returns { weekId, w, bins, people: [{ person, zones, rooms: [{ room, tasks }], tasks, weekOff }] }
 * People keep config order. Rooms and tasks keep config order; a person's
 * rooms are those with at least one task assigned to them that week (their
 * zones' tasks, minus exemptions, plus any they're covering). The bins, if
 * it's a bin week, come first as a pseudo room, and "Bins" is added to that
 * person's zones. weekOff = no zone, no bins and nothing to cover. Rooms
 * whose zone doesn't exist are not allocated (see unassignedRooms).
 */
export function allocate(config, weekId) {
  const w = weekIndex(weekId, config.anchor);
  const holders = zoneHolders(config, w);
  const zonesById = new Map((config.zones || []).map((z) => [z.id, z]));
  const assigned = new Map(); // personId -> Map(roomId -> tasks[])
  for (const t of config.tasks || []) {
    if (!isDue(t, w)) continue;
    const pid = taskAssignee(config, t, holders);
    if (!pid) continue;
    if (!assigned.has(pid)) assigned.set(pid, new Map());
    const byRoom = assigned.get(pid);
    if (!byRoom.has(t.roomId)) byRoom.set(t.roomId, []);
    byRoom.get(t.roomId).push(t);
  }
  const bins = binsForWeek(config, weekId);

  const people = (config.people || []).map((person) => {
    const zones = (config.zones || []).filter((z) => holders.get(z.id) === person.id);
    const byRoom = assigned.get(person.id) || new Map();
    const rooms = (config.rooms || []).filter((r) => byRoom.has(r.id)).map((room) => ({ room, tasks: byRoom.get(room.id) }));
    if (bins && bins.personId === person.id) {
      rooms.unshift({ room: BINS_ROOM, tasks: [binsTask(bins.collections)] });
      zones.push(BINS_ZONE);
    }
    const tasks = rooms.flatMap((r) => r.tasks);
    return { person, zones, rooms, tasks, weekOff: zones.length === 0 && tasks.length === 0 };
  });

  return { weekId, w, people, zonesById, bins };
}

/** Which person (id) is responsible for a task (or the bins) in a given week, or null. */
export function assigneeOf(config, taskId, weekId) {
  if (taskId === BINS_ID) return binsForWeek(config, weekId)?.personId || null;
  const task = (config.tasks || []).find((t) => t.id === taskId);
  if (!task) return null;
  return taskAssignee(config, task, zoneHolders(config, weekIndex(weekId, config.anchor)));
}

/**
 * The next `count` weeks (from fromWeekId inclusive) a task is due, and who
 * does it each time (exemptions applied): [{ weekId, personId }]. personId
 * is null when the task's room isn't in a zone, there are no people, or
 * everyone is exempt.
 */
export function upcoming(config, task, fromWeekId, count = 6) {
  const every = Math.max(1, Math.floor(Number(task.every) || 1));
  const w0 = weekIndex(fromWeekId, config.anchor);
  const first = mod((Math.floor(Number(task.offset)) || 0) - w0, every); // weeks until first due
  const out = [];
  for (let n = 0; n < count; n++) {
    const i = first + n * every;
    out.push({ weekId: addWeeks(fromWeekId, i), personId: taskAssignee(config, task, zoneHolders(config, w0 + i)) });
  }
  return out;
}

/**
 * How a list of occurrences ([{ personId }]) splits between housemates.
 * Returns { people: [{ person, n }] in config order (n may be 0), nobody }
 * where nobody counts occurrences with no one assigned.
 */
export function tally(config, occurrences) {
  const counts = new Map();
  let nobody = 0;
  for (const { personId } of occurrences) {
    if (personId) counts.set(personId, (counts.get(personId) || 0) + 1);
    else nobody++;
  }
  return { people: (config.people || []).map((person) => ({ person, n: counts.get(person.id) || 0 })), nobody };
}

/** tally() over the next `count` occurrences of a task. */
export const tallyUpcoming = (config, task, fromWeekId, count) => tally(config, upcoming(config, task, fromWeekId, count));

export function unassignedRooms(config) {
  const zoneIds = new Set((config.zones || []).map((z) => z.id));
  return (config.rooms || []).filter((r) => !zoneIds.has(r.zoneId));
}

/**
 * Which people a recurring task can ever land on (exemptions applied). With
 * N housemates and a task every k weeks, only N / gcd(k, N) distinct
 * rotation positions ever come up — e.g. a 4-weekly task with 4 housemates
 * always lands on the same person. Zone holders repeat every N weeks, so
 * checking those N / gcd(k, N) due weeks covers every case.
 */
export function reachablePeople(config, task) {
  const people = config.people || [];
  const N = people.length;
  if (N === 0) return [];
  const every = Math.max(1, Math.floor(Number(task.every) || 1));
  const offset = Math.floor(Number(task.offset)) || 0;
  const seen = new Set();
  const steps = N / gcd(every, N);
  for (let j = 0; j < steps; j++) {
    const pid = taskAssignee(config, task, zoneHolders(config, offset + j * every));
    if (pid) seen.add(pid);
  }
  return people.filter((p) => seen.has(p.id));
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
