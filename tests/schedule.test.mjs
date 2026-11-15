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
