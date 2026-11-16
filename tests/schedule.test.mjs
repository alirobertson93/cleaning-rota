// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/schedule.js';
import { buildSeedConfig } from '../js/seed.js';

const zonesFor = (config, weekId) =>
  Object.fromEntries(S.allocate(config, weekId).people.map((p) => [p.person.name, p.zones.map((z) => z.id).join('+') || 'off']));

test('seed has the 52 tasks from the sheet', () => {
  const c = buildSeedConfig();
  assert.equal(c.tasks.length, 52);
  assert.equal(c.rooms.length, 5);
  assert.equal(c.zones.length, 3);
  assert.deepEqual(c.people.map((p) => p.name), ['Ali', 'Shauna', 'Oliver', 'Emmy']);
  assert.equal(c.tasks.filter((t) => t.every === 1).length, 34);
  assert.equal(c.tasks.filter((t) => t.every === 3).length, 14);
  assert.equal(c.tasks.filter((t) => t.every === 5).length, 4);
});

test('rotation matches the spreadsheet (FULL tab)', () => {
  const c = buildSeedConfig();
  // 20/01/25: Ali Living, Shauna Kitchen+Downstairs, Oliver Hall+Upstairs, Emmy off
  assert.deepEqual(zonesFor(c, '2025-01-20'), { Ali: 'zone_1', Shauna: 'zone_2', Oliver: 'zone_3', Emmy: 'off' });
  // 27/01/25: Ali Kitchen, Shauna Hall, Oliver off, Emmy Living
  assert.deepEqual(zonesFor(c, '2025-01-27'), { Ali: 'zone_2', Shauna: 'zone_3', Oliver: 'off', Emmy: 'zone_1' });
  // 10/02/25: Ali off (sheet's "Week off :)" in ALI column, phase 4)
  assert.equal(zonesFor(c, '2025-02-10').Ali, 'off');
});

test('rotation continues where the sheet would be in Nov 2026', () => {
  const c = buildSeedConfig();
  assert.equal(S.weekIndex('2026-11-09', c.anchor), 94);
  assert.deepEqual(zonesFor(c, '2026-11-09'), { Ali: 'zone_3', Shauna: 'off', Oliver: 'zone_1', Emmy: 'zone_2' });
});

test('every zone has exactly one holder; each person gets at most one zone when N >= Z', () => {
  const c = buildSeedConfig();
  for (let i = 0; i < 20; i++) {
    const a = S.allocate(c, S.addWeeks('2026-11-09', i));
    const zoneCounts = a.people.flatMap((p) => p.zones.map((z) => z.id));
    assert.equal(new Set(zoneCounts).size, 3);
    assert.equal(zoneCounts.length, 3);
    assert.ok(a.people.every((p) => p.zones.length <= 1));
    assert.equal(a.people.filter((p) => p.weekOff).length, 1);
  }
});

test('every due task is allocated to exactly one person', () => {
  const c = buildSeedConfig();
  for (let i = 0; i < 30; i++) {
    const id = S.addWeeks('2026-11-09', i);
    const w = S.weekIndex(id, c.anchor);
    const due = c.tasks.filter((t) => S.isDue(t, w)).map((t) => t.id).sort();
    const allocated = S.allocate(c, id).people.flatMap((p) => p.tasks.map((t) => t.id)).sort();
    assert.deepEqual(allocated, due);
  }
});

test('fewer people than zones: everyone works, all zones covered', () => {
  const c = buildSeedConfig();
  c.people = c.people.slice(0, 2);
  for (let i = 0; i < 6; i++) {
    const a = S.allocate(c, S.addWeeks('2026-11-09', i));
    assert.equal(a.people.flatMap((p) => p.zones).length, 3);
    assert.ok(a.people.every((p) => !p.weekOff));
  }
});

test('five people, three zones: two off each week, everyone rotates through all zones', () => {
  const c = buildSeedConfig();
  c.people.push({ id: 'p5', name: 'Sam', color: '#000' });
  const seen = new Map(c.people.map((p) => [p.id, new Set()]));
  for (let i = 0; i < 5; i++) {
    const a = S.allocate(c, S.addWeeks('2026-11-09', i));
    assert.equal(a.people.filter((p) => p.weekOff).length, 2);
    a.people.forEach((p) => p.zones.forEach((z) => seen.get(p.person.id).add(z.id)));
  }
  for (const s of seen.values()) assert.equal(s.size, 3);
});

test('no people or no zones does not crash', () => {
  const c = buildSeedConfig();
  assert.deepEqual(S.allocate({ ...c, people: [] }, '2026-11-09').people, []);
  const a = S.allocate({ ...c, zones: [] }, '2026-11-09');
  assert.ok(a.people.every((p) => p.weekOff && p.tasks.length === 0));
});

test('frequencies: weekly always due, every-3 due one week in three', () => {
  for (let w = 0; w < 12; w++) assert.ok(S.isDue({ every: 1, offset: 0 }, w));
  const t = { every: 3, offset: 2 };
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((w) => S.isDue(t, w)), [false, false, true, false, false, true]);
  assert.ok(S.isDue({ every: 3, offset: 2 }, -1)); // negative week index (before anchor)
});

test('seed keeps the sheet\'s timing for occasional tasks', () => {
  const c = buildSeedConfig();
  // Sheet: every occasional task was due in its first week (20 Jan 2025) and every `every` weeks after.
  for (const t of c.tasks) assert.equal(t.offset, 0, t.name);
  const due = (weekId) => S.allocate(c, weekId).people.flatMap((p) => p.tasks).length;
  assert.equal(due('2025-01-20'), 52); // week 0: everything
  assert.equal(due('2026-11-09'), 34); // week 94: weekly only (94 % 3 = 1, 94 % 5 = 4)
  assert.equal(due('2026-11-23'), 48); // week 96: weekly + every-3
});

test('offsetStartingAt makes a task due in the given week', () => {
  for (const every of [1, 2, 3, 5, 12])
    for (const w of [-7, 0, 94, 95]) assert.ok(S.isDue({ every, offset: S.offsetStartingAt(every, w) }, w));
});

test('reachablePeople flags frequencies that share a factor with headcount', () => {
  const c = buildSeedConfig();
  const t4 = { roomId: 'room_kitchen', every: 4, offset: 0 };
  assert.equal(S.reachablePeople(c, t4).length, 1);
  const t2 = { roomId: 'room_kitchen', every: 2, offset: 0 };
  assert.equal(S.reachablePeople(c, t2).length, 2);
  const t3 = { roomId: 'room_kitchen', every: 3, offset: 0 };
  assert.equal(S.reachablePeople(c, t3).length, 4);
  // reachable set matches simulation
  for (const every of [2, 3, 4, 5, 6]) {
    const t = { roomId: 'room_kitchen', every, offset: 1, id: 'sim' };
    const cc = { ...c, tasks: [...c.tasks, t] };
    const sim = new Set();
    for (let i = 0; i < 60; i++) {
      const id = S.addWeeks('2026-11-09', i);
      if (!S.isDue(t, S.weekIndex(id, c.anchor))) continue;
      sim.add(S.assigneeOf(cc, 'sim', id));
    }
    assert.deepEqual([...sim].sort(), S.reachablePeople(c, t).map((p) => p.id).sort(), `every ${every}`);
  }
});

test('rotationShift moves everyone on a week without changing due tasks', () => {
  const c = buildSeedConfig();
  const shifted = { ...c, rotationShift: 1 };
  assert.deepEqual(zonesFor(shifted, '2026-11-09'), zonesFor(c, '2026-11-16'));
  const due = (cfg, id) => S.allocate(cfg, id).people.flatMap((p) => p.tasks.map((t) => t.id)).sort();
  assert.deepEqual(due(shifted, '2026-11-09'), due(c, '2026-11-09'));
});

test('week ids and labels', () => {
  // Sunday 15 Nov 2026 belongs to week starting Mon 9 Nov
  assert.equal(S.currentWeekId(new Date(2026, 10, 15, 23, 30)), '2026-11-09');
  assert.equal(S.currentWeekId(new Date(2026, 10, 16, 0, 5)), '2026-11-16');
  assert.equal(S.addWeeks('2026-12-28', 1), '2027-01-04');
  assert.equal(S.weekLabel('2026-11-09'), '9–15 Nov');
  assert.equal(S.weekLabel('2026-12-28'), '28 Dec – 3 Jan');
  assert.ok(S.isValidWeekId('2026-11-09'));
  assert.ok(!S.isValidWeekId('2026-11-10'));
  // DST boundary (UK clocks change 29 Mar 2026)
  assert.equal(S.addWeeks('2026-03-23', 1), '2026-03-30');
  assert.equal(S.weekIndex('2026-03-30', '2026-03-23'), 1);
});

test('stableShift: adding a 5th housemate keeps most of this week intact', () => {
  const prev = buildSeedConfig();
  const next = structuredClone(prev);
  next.people.push({ id: 'p5', name: 'Sam', color: '#000' });
  next.rotationShift = S.stableShift(prev, next, '2026-11-09');
  const before = zonesFor(prev, '2026-11-09');
  const after = zonesFor(next, '2026-11-09');
  const kept = ['zone_1', 'zone_2', 'zone_3'].filter((z) =>
    Object.keys(before).some((n) => before[n] === z && after[n] === z),
  ).length;
  assert.ok(kept >= 2, `kept ${kept} of 3: ${JSON.stringify(after)}`);
});

test('stableShift: removing someone who is off this week changes nothing this week', () => {
  const prev = buildSeedConfig(); // Shauna is off 9 Nov 2026
  const next = structuredClone(prev);
  next.people = next.people.filter((p) => p.name !== 'Shauna');
  next.rotationShift = S.stableShift(prev, next, '2026-11-09');
  const before = zonesFor(prev, '2026-11-09');
  const after = zonesFor(next, '2026-11-09');
  for (const n of ['Ali', 'Oliver', 'Emmy']) assert.equal(after[n], before[n]);
});

test('upcoming: next six due weeks and their holders', () => {
  const c = buildSeedConfig();
  const from = '2026-11-09'; // week 94
  const weekly = c.tasks.find((t) => t.every === 1);
  const u1 = S.upcoming(c, weekly, from);
  assert.deepEqual(u1.map((x) => x.weekId), [0, 1, 2, 3, 4, 5].map((i) => S.addWeeks(from, i)));
  const three = c.tasks.find((t) => t.every === 3);
  const u3 = S.upcoming(c, three, from);
  assert.deepEqual(u3.map((x) => x.weekId), ['2026-11-23', '2026-12-14', '2027-01-04', '2027-01-25', '2027-02-15', '2027-03-08']);
  for (const t of [weekly, three, c.tasks.find((x) => x.every === 5)])
    for (const x of S.upcoming(c, t, from)) assert.equal(x.personId, S.assigneeOf(c, t.id, x.weekId));
  // 12-weekly still finds 6
  assert.equal(S.upcoming(c, { ...three, every: 12, offset: 5 }, from).length, 6);
  // room not in a zone → no one
  const orphan = { ...c, rooms: c.rooms.map((r) => (r.id === three.roomId ? { ...r, zoneId: null } : r)) };
  assert.ok(S.upcoming(orphan, three, from).every((x) => x.personId === null));
});

test('tallyUpcoming: next 2N occurrences split by housemate', () => {
  const c = buildSeedConfig();
  const from = '2026-11-09';
  const N = c.people.length;
  for (const t of c.tasks) {
    const { people, nobody } = S.tallyUpcoming(c, t, from, 2 * N);
    assert.equal(people.reduce((a, p) => a + p.n, 0) + nobody, 2 * N);
    assert.equal(nobody, 0);
    // every 1, 3, 5 are coprime with 4 → each housemate exactly twice
    assert.deepEqual(people.map((p) => p.n), [2, 2, 2, 2], t.name);
  }
  // every 2 with 4 people → only two housemates ever, 4 each
  const two = { ...c.tasks[0], every: 2, offset: 0 };
  assert.deepEqual(S.tallyUpcoming(c, two, from, 8).people.map((p) => p.n).sort(), [0, 0, 4, 4]);
  // room not in a zone → all "nobody"
  const orphan = { ...c, rooms: c.rooms.map((r) => ({ ...r, zoneId: null })) };
  assert.equal(S.tallyUpcoming(orphan, c.tasks[0], from, 8).nobody, 8);
});

// ---------------------------------------------------------------------------
// Bins
// ---------------------------------------------------------------------------

const withBins = (bins = {}) => {
  const c = buildSeedConfig();
  c.bins = {
    recycling: ['2026-11-24', '2026-12-08'],
    general: ['2026-11-26', '2026-12-01', '2026-12-15'],
    exempt: [],
    shift: 0,
    ...bins,
  };
  return c;
};
const binPeople = (c, from = '2026-11-16', n = 4) => S.upcomingBins(c, from, n).map((b) => b.personId.replace('person_', ''));

test('bins go out the evening before collection', () => {
  assert.equal(S.binWeekOf('2026-11-24'), '2026-11-23'); // Tue → out Mon
  assert.equal(S.binWeekOf('2026-11-23'), '2026-11-16'); // Mon → out Sun, the week before
  assert.equal(S.binWeekOf('2026-11-22'), '2026-11-16'); // Sun → out Sat
  assert.equal(S.isValidDate('2026-02-28'), true);
  assert.equal(S.isValidDate('2026-02-30'), false);
  assert.equal(S.isValidDate('nope'), false);
});

test('bins: one entry per week with a collection, queue in housemate order', () => {
  const c = withBins();
  assert.deepEqual(S.binWeeks(c).map((b) => b.weekId), ['2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14']);
  const b = S.binsForWeek(c, '2026-11-23');
  assert.deepEqual(b.collections, [
    { type: 'recycling', date: '2026-11-24' },
    { type: 'general', date: '2026-11-26' },
  ]);
  assert.equal(S.binsForWeek(c, '2026-11-16'), null);
  assert.deepEqual(binPeople(c), ['ali', 'shauna', 'oliver', 'emmy']);
  assert.equal(S.assigneeOf(c, S.BINS_ID, '2026-11-30'), 'person_shauna');
});

test('bins: exempt housemates are skipped', () => {
  const c = withBins({ exempt: ['person_shauna'] });
  assert.deepEqual(binPeople(c), ['ali', 'oliver', 'emmy', 'ali']);
  assert.equal(S.binsForWeek(withBins({ exempt: c.people.map((p) => p.id) }), '2026-11-23').personId, null);
});

test('bins appear on the bin person\'s list, first, and count as a zone', () => {
  // 30 Nov 2026: Emmy zone_1, Ali zone_2, Shauna zone_3, Oliver off. shift 1 → Oliver on bins.
  const c = withBins({ shift: 1 });
  const oliver = S.allocate(c, '2026-11-30').people.find((p) => p.person.name === 'Oliver');
  assert.equal(oliver.weekOff, false);
  assert.deepEqual(oliver.zones.map((z) => z.id), ['bins']);
  assert.equal(oliver.rooms[0].room.id, 'bins');
  assert.equal(oliver.tasks[0].id, 'bins');
  assert.equal(oliver.tasks[0].collections[0].type, 'general');
  const ali = S.allocate(c, '2026-11-30').people.find((p) => p.person.name === 'Ali');
  assert.ok(!ali.tasks.some((t) => t.id === 'bins'));
});

test('stableBinShift: exempting the next person hands it to the one after; adding people or old dates keeps them', () => {
  const prev = withBins();
  assert.equal(S.binsForWeek(prev, '2026-11-23').personId, 'person_ali');

  const exempted = structuredClone(prev);
  exempted.bins.exempt = ['person_ali'];
  exempted.bins.shift = S.stableBinShift(prev, exempted, '2026-11-16');
  assert.deepEqual(binPeople(exempted), ['shauna', 'oliver', 'emmy', 'shauna']);

  const added = structuredClone(prev);
  added.people.push({ id: 'person_new', name: 'New' });
  added.bins.shift = S.stableBinShift(prev, added, '2026-11-16');
  assert.equal(S.binsForWeek(added, '2026-11-23').personId, 'person_ali');

  const older = structuredClone(prev);
  older.bins.general = ['2026-10-01', ...older.bins.general];
  older.bins.shift = S.stableBinShift(prev, older, '2026-11-16');
  assert.deepEqual(binPeople(older), ['ali', 'shauna', 'oliver', 'emmy']);
});

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

const allDue = (c, weekId) => S.allocate(c, weekId).people.flatMap((p) => p.tasks.map((t) => t.id)).sort();

test('exempt from one task: next person in line does it the same week', () => {
  // 16 Nov 2026: Shauna zone_1, Oliver zone_2 (kitchen), Emmy zone_3, Ali off.
  const c = buildSeedConfig();
  const before = allDue(c, '2026-11-16');
  const task = c.tasks.find((t) => t.roomId === 'room_kitchen' && t.every === 1);
  task.exempt = ['person_oliver'];
  assert.equal(S.assigneeOf(c, task.id, '2026-11-16'), 'person_shauna'); // next in line for zone_2 after Oliver
  const a = S.allocate(c, '2026-11-16').people;
  const by = (n) => a.find((p) => p.person.name === n);
  assert.ok(!by('Oliver').tasks.includes(task));
  assert.ok(by('Shauna').rooms.some((r) => r.room.id === 'room_kitchen' && r.tasks.includes(task)));
  assert.deepEqual(by('Oliver').zones.map((z) => z.id), ['zone_2']); // still holds the zone
  assert.deepEqual(allDue(c, '2026-11-16'), before); // nothing lost or doubled

  // Shauna exempt too → Ali, even though Ali is otherwise off
  task.exempt = ['person_oliver', 'person_shauna'];
  const ali = S.allocate(c, '2026-11-16').people.find((p) => p.person.name === 'Ali');
  assert.equal(ali.weekOff, false);
  assert.deepEqual(ali.tasks, [task]);
  assert.deepEqual(ali.zones, []);

  // weekly task never lands on an exempt person
  assert.ok(S.upcoming(c, task, '2026-11-16', 8).every((u) => !task.exempt.includes(u.personId)));
});

test('exempt from every task in a zone: the zone skips to the next person', () => {
  const c = buildSeedConfig();
  c.tasks.filter((t) => t.roomId === 'room_living').forEach((t) => (t.exempt = ['person_emmy']));
  assert.deepEqual(S.zoneSkips(c, 'zone_1').map((p) => p.name), ['Emmy']);
  // 30 Nov 2026 Emmy would have zone_1; it passes to Oliver (who'd otherwise be off)
  assert.deepEqual(zonesFor(c, '2026-11-30'), { Ali: 'zone_2', Shauna: 'zone_3', Oliver: 'zone_1', Emmy: 'off' });
  assert.equal(S.allocate(c, '2026-11-30').people.find((p) => p.person.name === 'Emmy').weekOff, true);
  assert.deepEqual(allDue(c, '2026-11-30'), allDue(buildSeedConfig(), '2026-11-30'));
});

test('reachablePeople and tallies apply exemptions', () => {
  const c = buildSeedConfig();
  const task = c.tasks.find((t) => t.roomId === 'room_living' && t.every === 1);
  task.exempt = ['person_ali'];
  assert.deepEqual(S.reachablePeople(c, task).map((p) => p.name), ['Shauna', 'Oliver', 'Emmy']);
  const t = S.tallyUpcoming(c, task, '2026-11-16', 8);
  assert.equal(t.people.find((x) => x.person.name === 'Ali').n, 0);
  assert.equal(t.nobody, 0);
  task.exempt = c.people.map((p) => p.id);
  assert.deepEqual(S.reachablePeople(c, task), []);
  assert.equal(S.tallyUpcoming(c, task, '2026-11-16', 8).nobody, 8);
});
