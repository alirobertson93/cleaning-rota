// Starting data imported from the original "Cleaning Rota" Google Sheet
// (tab "All tasks"). Used once, when the database is empty.
// Monday the sheet's rotation started. Keeping it means the rotation carries
// on exactly where the sheet would have been.
export const SHEET_ANCHOR = '2025-01-20';

export const PERSON_COLORS = ['#2f7d6d', '#c2562f', '#5b5bd6', '#b5418a', '#8a6a12', '#1f7aa8', '#7a4fc2', '#4c8a2b'];

const ZONES = [
  { id: 'zone_1', name: 'Living Room' },
  { id: 'zone_2', name: 'Kitchen & Downstairs Bathroom' },
  { id: 'zone_3', name: 'Hall & Upstairs Shower' },
];

const ROOMS = [
  { id: 'room_living', name: 'Living Room/Dining Room', zoneId: 'zone_1' },
  { id: 'room_kitchen', name: 'Kitchen', zoneId: 'zone_2' },
  { id: 'room_downbath', name: 'Downstairs Bathroom/Utility room', zoneId: 'zone_2' },
  { id: 'room_hall', name: 'Entrance hall/stairs/landing', zoneId: 'zone_3' },
  { id: 'room_upshower', name: 'Upstairs shower/toilet', zoneId: 'zone_3' },
];

// [roomId, task, every x weeks]
const TASKS = [
  ['room_living', 'Hoover Living Room/Dining Room (incl. rugs)', 1],
  ['room_living', 'Clean/wipe down dining table', 1],
  ['room_living', 'Clean/dust kallax', 1],
  ['room_living', 'Clean/dust little dividing wall', 1],
  ['room_living', 'Clean/dust TV/TV unit', 1],
  ['room_living', 'Clean/dust mantle piece', 1],
  ['room_living', 'Clean/dust both windowsills', 1],
  ['room_living', 'Clean/dust piano', 1],
  ['room_living', 'Clean/wipe down hanging pictures/mirrors', 3],
  ['room_living', 'Sweep out fireplace', 1],
  ['room_living', 'Hoover and/or wipe down skirting boards', 5],

  ['room_kitchen', 'Clean/wipe down surfaces incl. sink/taps/draining board', 1],
  ['room_kitchen', 'Clean hob (incl. removable metal grates)', 1],
  ['room_kitchen', 'Sweep/hoover, and clean the floor', 1],
  ['room_kitchen', 'Clean the bin (inside and outside)', 1],
  ['room_kitchen', 'Clean the microwave (inside and outside)', 1],
  ['room_kitchen', 'Go through the fridge – clean and remove out of date (check with others)', 1],
  ['room_kitchen', 'Wipe down outside of cupboards', 1],
  ['room_kitchen', 'Clean inside of cupboards', 5],
  ['room_kitchen', 'Deep clean inside of oven', 3],
  ['room_kitchen', 'Hoover and/or wipe down skirting boards', 5],
  ['room_kitchen', 'Clean/wipe down hanging pictures', 3],
  ['room_kitchen', 'Clean/dust windowsill', 1],
  ['room_kitchen', 'Clean/dust shelf above door to bathroom', 5],

  ['room_downbath', 'Sweep/hoover, and clean the floor', 1],
  ['room_downbath', 'Clean/wipe down bath/shower/taps/screen/panels', 1],
  ['room_downbath', 'Clean/wipe down toilet', 1],
  ['room_downbath', 'Descale shower head', 3],
  ['room_downbath', 'Clean/wipe down basin and shelves behind', 1],
  ['room_downbath', 'Clean/replace bath mat', 1],
  ['room_downbath', 'Hoover and/or wipe down skirting boards', 3],
  ['room_downbath', 'Clean the bin (inside and outside)', 1],
  ['room_downbath', 'Clean/wipe down hanging pictures/mirrors', 3],
  ['room_downbath', 'Clean/wipe down the light pull', 1],
  ['room_downbath', 'Clean/dust windowsill', 1],

  ['room_hall', 'Hoover', 1],
  ['room_hall', 'Clean/wipe down hanging pictures', 3],
  ['room_hall', 'Clean/wipe down bannister', 3],
  ['room_hall', 'Clean/wipe down mirror', 3],
  ['room_hall', 'Hoover and/or wipe down skirting boards', 3],
  ['room_hall', 'Empty hoover and make sure the rotating brushes/intake are clear', 1],

  ['room_upshower', 'Sweep, and clean the floors', 1],
  ['room_upshower', 'Clean/wipe down toilet', 1],
  ['room_upshower', 'Clean/wipe down basin', 1],
  ['room_upshower', 'Hoover and/or wipe down skirting boards', 3],
  ['room_upshower', 'Clean/replace shower mat', 1],
  ['room_upshower', 'Clean caddies above sink', 1],
  ['room_upshower', 'Clean the bin (inside and outside)', 1],
  ['room_upshower', 'Clean inside and outside of shower', 1],
  ['room_upshower', 'Descale shower head', 3],
  ['room_upshower', 'Clean/wipe down mirror', 3],
  ['room_upshower', 'Clean/wipe down the light pulls', 3],
];

// Rotation order matters: it's the order the sheet used, so this week's
// allocation matches what the sheet would have shown.
const PEOPLE = ['Ali', 'Shauna', 'Oliver', 'Emmy'];

export function buildSeedConfig() {
  const config = {
    version: 1,
    houseName: 'Cleaning Rota',
    anchor: SHEET_ANCHOR,
    people: PEOPLE.map((name, i) => ({ id: `person_${name.toLowerCase()}`, name, color: PERSON_COLORS[i] })),
    zones: ZONES.map((z) => ({ ...z })),
    rooms: ROOMS.map((r) => ({ ...r })),
    tasks: [],
  };
  // offset 0 = the sheet's timing: every occasional task is due in the
  // anchor week (20 Jan 2025) and every `every` weeks after that.
  config.tasks = TASKS.map(([roomId, name, every], i) => ({
    id: `task_${String(i + 1).padStart(2, '0')}`,
    roomId,
    name,
    every,
    offset: 0,
  }));
  return config;
}
