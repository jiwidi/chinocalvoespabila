// Checks the suggested-comp solver in raidcomp.js: the targets, the scoring, who plays what, and the groups.
// Usage: npm test  (or node scripts/check-comp.mjs). Pure functions: no server, no store.
import assert from "node:assert/strict";
import { MAX, SPEC, specTags, targets, compScore, solveComp, arrange } from "../raidcomp.js";

let n = 0;
// A signup: name, then the specs they listed in order (1st choice first).
const player = (name, ...c) => ({ id: "u" + ++n, n: name, c });
const solve = (players, size, forced = [], pets = true) => solveComp(players, size, targets(size), new Set(forced), pets);
const playing = (out, name) => out.raid.find((m) => m.n === name);
const groupsOf = (slots) => Array.from({ length: MAX / 5 }, (_, g) => slots.slice(g * 5, g * 5 + 5).filter(Boolean)).filter((g) => g.length);
// entries for compScore: everyone plays their only spec.
const entries = (...specs) => specs.map((k) => ({ k, c: [k] }));

// A sound 10-man core: 2 tanks, 2 healers, a shaman, then dps.
const core10 = () => [
  player("Tank1", "warrior_protection"), player("Tank2", "paladin_protection"),
  player("Heal1", "priest_holy"), player("Heal2", "druid_restoration"),
  player("Sham", "shaman_elemental"), player("Mage", "mage_frost"), player("Lock", "warlock_destruction"),
  player("Rogue", "rogue_combat"), player("Hunt", "hunter_marksmanship"),
];

// Targets for each raid size.
assert.deepEqual(targets(10), { tank: 2, heal: 2, off: 1, shaman: 1, shamanMax: 2, paladin: 1, kick: 2 });
assert.deepEqual(targets(20), { tank: 2, heal: 3, off: 1, shaman: 2, shamanMax: 4, paladin: 2, kick: 3 });

// Scoring: a third tank is a dps lost.
const t10 = targets(10);
assert.ok(compScore(entries("warrior_protection", "warrior_protection", "warrior_fury"), t10)
  > compScore(entries("warrior_protection", "warrior_protection", "warrior_protection"), t10), "a 3rd tank scores below a dps");

// Hunter pets: with pets off, the pet buffs (Furious Howl's attack power) no longer count.
const hunter = SPEC.hunter_marksmanship;
assert.ok(specTags(hunter).includes("ap") && !specTags(hunter, false).includes("ap"));
assert.ok(compScore(entries("hunter_marksmanship"), t10, true) > compScore(entries("hunter_marksmanship"), t10, false));

// Fewer players than seats: everyone plays, nobody is benched.
{
  const out = solve(core10(), 10);
  assert.equal(out.raid.length, 9);
  assert.equal(out.bench.length, 0);
}

// A missing healer is worth more than a player's preference: the mage who also listed Holy heals.
{
  const players = core10().filter((u) => u.n !== "Heal2").concat(player("Flex", "mage_fire", "priest_holy"));
  const flex = playing(solve(players, 10), "Flex");
  assert.equal(flex.s, "priest_holy");
  assert.equal(flex.rank, 1);
}

// More players than seats: forced players are never benched.
{
  const players = core10().concat(player("Extra1", "rogue_combat"), player("Extra2", "warrior_fury"), player("Extra3", "mage_frost"));
  const forced = [10, 11];
  const out = solve(players, 10, forced);
  assert.equal(out.raid.length, 10);
  for (const i of forced) assert.ok(out.raid.some((m) => m.i === i), players[i].n + " was forced in");
}

// With a bench, a seated player keeps their 1st choice when a benched player covers the need with theirs (#33).
{
  const players = core10().filter((u) => u.n !== "Heal2")
    .concat(player("Flex", "mage_fire", "priest_holy"), player("Late", "rogue_combat"), player("Healer", "paladin_holy"));
  const out = solve(players, 10);
  assert.equal(playing(out, "Flex").s, "mage_fire", "Flex stays on their 1st choice");
  assert.equal(playing(out, "Healer").s, "paladin_holy", "the benched healer plays instead");
  assert.ok(out.raid.every((m) => m.rank === 0), "everyone on their 1st choice");
}

// A 20-man with 4 shamans: one shaman per group, at most 5 per group, tanks first inside a group.
{
  const players = [
    player("T1", "warrior_protection"), player("T2", "druid_guardian"),
    player("H1", "priest_holy"), player("H2", "paladin_holy"), player("H3", "druid_restoration"),
    player("S1", "shaman_restoration"), player("S2", "shaman_elemental"), player("S3", "shaman_enhancement"), player("S4", "shaman_elemental"),
    player("M1", "mage_frost"), player("M2", "mage_fire"), player("L1", "warlock_destruction"), player("L2", "warlock_affliction"),
    player("R1", "rogue_combat"), player("R2", "rogue_assassination"), player("W1", "warrior_fury"), player("W2", "warrior_arms"),
    player("Hu1", "hunter_marksmanship"), player("Hu2", "hunter_beast_mastery"), player("P1", "priest_shadow"),
  ];
  const out = solve(players, 20);
  assert.equal(out.raid.length, 20);
  assert.equal(out.slots.length, MAX);
  const groups = groupsOf(out.slots);
  assert.equal(groups.length, 4);
  for (const g of groups) {
    assert.ok(g.length <= 5);
    assert.equal(g.filter((m) => SPEC[m.s].cls === "shaman").length, 1, "one shaman per group");
    const roles = g.map((m) => SPEC[m.s].role), firstOther = roles.findIndex((r) => r !== "tank");
    assert.ok(firstOther < 0 || roles.slice(firstOther).every((r) => r !== "tank"), "tanks first in the group");
  }
  // Same input, same comp.
  assert.deepEqual(solve(players, 20).slots.map((m) => m && m.n + ":" + m.s), out.slots.map((m) => m && m.n + ":" + m.s));
  // arrange alone keeps everyone and never fills a group past 5.
  const seated = arrange(out.raid, 20).filter(Boolean);
  assert.equal(seated.length, 20);
}

console.log("check-comp: all checks passed");
