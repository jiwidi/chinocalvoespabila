// Spec data and the suggested-comp solver, shared by the page (index.html) and the checks (scripts/check-comp.mjs).
// Plain data and pure functions: nothing here touches the page.

export const MAX = 40;

/* ---------- Game data (WoW Forever) ---------- */
export const DRUID = ["motw", "innervate", "armor2", "brez", "dcurse", "dpoison"];
export const HUNTER = ["hit", "natureres", "frenzy"], PET = ["ap", "tongues", "mortal"];
export const MAGE = ["int", "amp", "dcurse"];
export const PALADIN = ["kings", "wisdom", "aura", "might", "salv", "jol", "jow", "resaura", "dmagic", "ddisease", "dpoison"];
export const PRIEST = ["stam", "shadowres", "spirit", "purge", "dmagic", "ddisease"];
export const ROGUE = ["armor1", "mortal", "tongues"];
export const SHAMAN = ["wf", "goa", "ft", "soe", "mst", "hst", "ground", "tremor", "restotem", "purge", "ddisease", "dpoison"];
export const WARLOCK = ["bp", "coe", "armor2", "tongues", "brez", "purge", "dmagic"];
export const WARRIOR = ["ap", "armor1", "demo", "clap"];
// key, class, spec, role, armor, tier token, icon, tags, hunter-pet tags
export const SPEC_ROWS = [
  ["druid_balance", "druid", "Balance", "range", "leather_int", "vanquisher", "spell_nature_starfall", DRUID.concat("scrit", "hit")],
  ["druid_feral", "druid", "Feral", "melee", "leather_agi", "vanquisher", "ability_druid_catform", DRUID.concat("crit", "demo")],
  ["druid_guardian", "druid", "Guardian", "tank", "leather_agi", "vanquisher", "ability_racial_bearform", DRUID.concat("crit", "demo")],
  ["druid_restoration", "druid", "Restoration", "heal", "leather_int", "vanquisher", "spell_nature_healingtouch", DRUID],
  ["hunter_beast_mastery", "hunter", "Beast Mastery", "range", "mail_agi", "protector", "ability_hunter_beasttaming", HUNTER, PET],
  ["hunter_marksmanship", "hunter", "Marksmanship", "range", "mail_agi", "protector", "ability_marksmanship", HUNTER.concat("rap"), PET],
  ["hunter_survival", "hunter", "Survival", "melee", "mail_agi", "protector", "ability_hunter_swiftstrike", HUNTER, PET],
  ["mage_arcane", "mage", "Arcane", "range", "cloth", "vanquisher", "spell_holy_magicalsentry", MAGE],
  ["mage_fire", "mage", "Fire", "range", "cloth", "vanquisher", "spell_fire_firebolt02", MAGE],
  ["mage_frost", "mage", "Frost", "range", "cloth", "vanquisher", "spell_frost_frostbolt02", MAGE],
  ["paladin_holy", "paladin", "Holy", "heal", "plate_int", "conqueror", "spell_holy_holybolt", PALADIN],
  ["paladin_protection", "paladin", "Protection", "tank", "plate_str", "conqueror", "spell_holy_devotionaura", PALADIN],
  ["paladin_retribution", "paladin", "Retribution", "melee", "plate_str", "conqueror", "spell_holy_auraoflight", PALADIN.concat("demo")],
  ["priest_discipline", "priest", "Discipline", "heal", "cloth", "conqueror", "spell_holy_wordfortitude", PRIEST.concat("pi")],
  ["priest_holy", "priest", "Holy", "heal", "cloth", "conqueror", "spell_holy_guardianspirit", PRIEST],
  ["priest_shadow", "priest", "Shadow", "range", "cloth", "conqueror", "spell_shadow_shadowwordpain", PRIEST.concat("di", "ve")],
  ["rogue_assassination", "rogue", "Assassination", "melee", "leather_agi", "vanquisher", "ability_rogue_eviscerate", ROGUE],
  ["rogue_combat", "rogue", "Combat", "melee", "leather_agi", "vanquisher", "ability_backstab", ROGUE],
  ["rogue_subtlety", "rogue", "Subtlety", "melee", "leather_agi", "vanquisher", "ability_stealth", ROGUE],
  ["shaman_elemental", "shaman", "Elemental", "range", "mail_int", "protector", "spell_nature_lightning", SHAMAN],
  ["shaman_enhancement", "shaman", "Enhancement", "melee", "mail_agi", "protector", "spell_nature_lightningshield", SHAMAN],
  ["shaman_restoration", "shaman", "Restoration", "heal", "mail_int", "protector", "spell_nature_magicimmunity", SHAMAN.concat("tide")],
  ["warlock_affliction", "warlock", "Affliction", "range", "cloth", "conqueror", "spell_shadow_deathcoil", WARLOCK],
  ["warlock_demonology", "warlock", "Demonology", "range", "cloth", "conqueror", "spell_shadow_metamorphosis", WARLOCK],
  ["warlock_destruction", "warlock", "Destruction", "range", "cloth", "conqueror", "spell_shadow_rainoffire", WARLOCK],
  ["warrior_arms", "warrior", "Arms", "melee", "plate_str", "protector", "ability_warrior_savageblow", WARRIOR.concat("mortal")],
  ["warrior_fury", "warrior", "Fury", "melee", "plate_str", "protector", "ability_warrior_innerrage", WARRIOR],
  ["warrior_protection", "warrior", "Protection", "tank", "plate_str", "protector", "ability_warrior_defensivestance", WARRIOR]
];
export const SPEC = {};
SPEC_ROWS.forEach((r) => {
  SPEC[r[0]] = { key: r[0], cls: r[1], label: r[2], role: r[3], armor: r[4], token: r[5], icon: r[6], tags: r[7], pet: r[8] || [] };
});

// pets: whether hunter pets count (the page's "Hunter pets" toggle).
export function specTags(sp, pets = true) { return pets ? sp.tags.concat(sp.pet) : sp.tags; }

/* ---------- Suggested comp ---------- */
// What a raid wants, as points. The solver trades these against how far down each player's list it has to go.
// The guild's targets: at least 2 tanks, 3 healers plus 1 off-healer, 2-3 shamans, and one of each main buff
// (for 10: 2 healers plus 1 off-healer, 1-2 shamans). Ranged (healers count as ranged) should match or outnumber melee.
// WoW Forever beta notes (Oct 16, 2026): Battle Shout, Trueshot Aura, Moonkin Aura (spell crit), Leader of the Pack
// (melee and ranged crit), and the Windfury, Grace of Air, Strength of Earth and Flametongue totems are raid wide, so
// one provider covers everyone and a second adds nothing. Windfury and Flametongue exclude each other. Windfury and
// Grace of Air are both air totems, so having both takes 2 shamans. Salvation is no longer a blessing: any paladin
// gives it on top of one blessing. Still per group: paladin auras and the water totems (Mana Spring, Mana Tide).
// The guild plays totems as group-wide (what a shaman drops reaches their group), so the comp wants one shaman per
// group: each one up to that is worth a lot, and arrange() seats them one per group.
// Earlier notes: Curse of the Elements covers all magic; Expose Armor replaces Sunder stacking; Druids and Hunters
// have no interrupt.
// Kept modest so a player moves to a lower choice when the raid clearly gains (a missing healer, a missing buff).
export const PREF_COST = (r) => 6.5 * r - 0.5 * r * r; // 1st 0, 2nd 6, 3rd 11, 4th 15, 5th 18
// Hybrid dps specs are brought for their one-of-a-kind buff; a second copy adds little over a pure dps class.
export const HYBRID_DPS = new Set(["druid_balance", "druid_feral", "paladin_retribution", "priest_shadow", "shaman_elemental", "shaman_enhancement"]);
export const HYBRID_DUP_COST = 10; // per extra copy of the same hybrid spec
export const FIRST_WARLOCK = 20;
export const BLESSINGS = [["kings", 25], ["wisdom", 15], ["might", 12]]; // each paladin covers one blessing (Greater Blessing of Light is not in this version)
// Raid totems by how many shamans they take: one drops Windfury and Strength of Earth; Grace of Air is a second air totem.
export const TOTEMS = [["wf", 1], ["soe", 1], ["goa", 2]];
// Interrupts: Pummel/Shield Bash, Kick, Counterspell, Earth Shock, Spell Lock (felhunter), Silence (Shadow).
export const canKick = (k) => ["warrior", "rogue", "mage", "shaman", "warlock"].includes(SPEC[k].cls) || k === "priest_shadow";
// An off-healer: a player in a dps spec whose signup also lists a healing spec of that same class, so they can
// switch and heal when the healers need help (a Balance druid who also put Restoration, for example).
// A dps player whose signup also lists a tank spec: can off-tank if a fight asks for it.
export const isOffTank = (k, c) => SPEC[k].role !== "tank" && (c || []).some((x) => SPEC[x].role === "tank");
export const isOffHeal = (k, c) => (SPEC[k].role === "melee" || SPEC[k].role === "range") && (c || []).some((x) => SPEC[x].role === "heal" && SPEC[x].cls === SPEC[k].cls);
export const NEEDS = [ // [tag, points]: raid-wide, so one provider is enough and a second adds nothing
  // Main buffs and debuffs: the raid wants one of each.
  ["stam", 22], ["motw", 22], ["int", 20], ["ap", 18], ["crit", 18], ["armor1", 18], ["coe", 16], ["scrit", 14], ["rap", 12],
  ["armor2", 12], ["salv", 10],
  // Dispels, tools and smaller buffs.
  ["dmagic", 14], ["dcurse", 12], ["brez", 10], ["ddisease", 6], ["dpoison", 6], ["frenzy", 6], ["demo", 6], ["purge", 5],
  ["hit", 3], ["spirit", 3], ["shadowres", 3], ["tongues", 3], ["natureres", 2], ["mortal", 2]
];
// heal: healers wanted; off: one more who can heal (an off-healer, or one extra healer); shaman to shamanMax shamans.
export function targets(size) {
  return size <= 10
    ? { tank: 2, heal: 2, off: 1, shaman: 1, shamanMax: 2, paladin: 1, kick: 2 }
    : { tank: 2, heal: 3, off: 1, shaman: 2, shamanMax: 4, paladin: 2, kick: 3 }; // up to one shaman per group of 5
}
// entries: [{ k: chosen spec, c: that player's signup specs }]
export function compScore(entries, t, pets = true) {
  const cls = {}, role = { tank: 0, heal: 0, melee: 0, range: 0 }, tags = new Set(), seen = {};
  let off = 0, dup = 0, kick = 0, offTank = 0;
  entries.forEach(({ k, c }) => {
    const sp = SPEC[k];
    if (HYBRID_DPS.has(k) && seen[k]) dup++;
    seen[k] = true;
    cls[sp.cls] = (cls[sp.cls] || 0) + 1;
    role[sp.role]++;
    if (isOffHeal(k, c)) off++;
    if (isOffTank(k, c)) offTank++;
    if (canKick(k)) kick++;
    specTags(sp, pets).forEach((x) => tags.add(x));
  });
  const groups = Math.max(1, Math.ceil(entries.length / 5));
  // Exactly t.tank tanks (2): a third tank is a dps lost, so a player who listed tank first plays their dps spec.
  // One off-tank (a dps who also signed up as tank) is a small plus: how much it matters in Forever is not clear yet.
  let s = 40 * Math.min(role.tank, t.tank) - 30 * Math.max(0, role.tank - t.tank) + (offTank ? 4 : 0);
  // Healers, then one off-healer: a dps who can switch to healing (see isOffHeal). A 4th real healer covers that
  // slot only half as well (it is a dps seat lost for good); beyond healers + off-healer each healer costs.
  const extraHeal = Math.max(0, role.heal - t.heal);
  s += 30 * Math.min(role.heal, t.heal) + 16 * Math.min(t.off, off) + 8 * Math.min(Math.max(0, t.off - off), extraHeal);
  s -= 9 * Math.max(0, extraHeal - t.off);
  s -= HYBRID_DUP_COST * dup;
  // Melee against ranged, healers counted as ranged: lose points for every melee too many, gain a little for extra ranged.
  const ranged = role.range + role.heal;
  s -= 10 * Math.max(0, role.melee - ranged);
  s += 3 * Math.min(2, Math.max(0, ranged - role.melee));
  // Shamans: the first ones bring the raid totems (see TOTEMS); one more adds water totems for a group; more, no gain.
  const sham = cls.shaman || 0;
  s += 26 * Math.min(sham, t.shaman) + 16 * Math.max(0, Math.min(sham, t.shamanMax, groups) - t.shaman) - 12 * Math.max(0, sham - Math.min(t.shamanMax, groups));
  const pal = cls.paladin || 0;
  BLESSINGS.slice(0, pal).forEach(([, w]) => { s += w; });
  s += 10 * Math.min(pal, t.paladin);
  if (pal) s += 4 + 3 * (Math.min(pal, groups) - 1); // a paladin aura reaches one group
  s += 8 * Math.min(kick, t.kick);
  // The first warlock brings utility no tag covers (Healthstones, summoning, Soulstone on top of a curse): worth a lot.
  // More warlocks add only a second curse.
  if (cls.warlock) s += FIRST_WARLOCK + (cls.warlock >= 2 ? 5 : 0);
  NEEDS.forEach(([tag, w]) => { if (tags.has(tag)) s += w; });
  return s;
}

// Best comp for these players. forced: indexes of players who must be in the raid. pets: as in specTags.
export function solveComp(players, size, t, forced, pets = true) {
  const n = players.length, cap = Math.min(n, size);
  // pick[i] is an index into players[i].c, or -1 when benched. Forced players first, then earlier signups.
  const order = players.map((u, i) => i).sort((a, b) => (forced.has(b) - forced.has(a)) || a - b);
  const pick = players.map(() => -1);
  order.slice(0, cap).forEach((i) => { pick[i] = 0; });
  // With more players than seats, everyone's 1st choice counts as if they played: rather than moving a seated
  // player off their 1st choice, the comp takes someone from the bench who covers it with theirs.
  const offFirst = n > size ? 14 : 0;
  const value = (p) => {
    let s = 0;
    const entries = [];
    p.forEach((r, i) => {
      if (r < 0) { s -= 0.1 * (n - i); return; }
      entries.push({ k: players[i].c[r], c: players[i].c });
      s -= PREF_COST(r) + (r > 0 ? offFirst : 0);
    });
    return s + compScore(entries, t, pets);
  };
  // Hill climbing: take the best single change (or swap with the bench) until nothing improves,
  // then try changing two players at once to get past spots where one change alone does not pay off.
  let best = value(pick);
  const tryMove = (p) => { const v = value(p); if (v > best + 1e-9) { best = v; return true; } return false; };
  const options = players.reduce((s, u) => s + u.c.length, 0);
  for (let guard = 0; guard < 200; guard++) {
    let improved = null;
    for (let i = 0; i < n; i++) {
      for (let r = 0; r < players[i].c.length; r++) {
        if (r === pick[i]) continue;
        if (pick[i] >= 0) {
          const p = pick.slice(); p[i] = r;
          if (tryMove(p)) improved = p;
        } else {
          for (let j = 0; j < n; j++) {
            if (pick[j] < 0 || forced.has(j)) continue;
            const p = pick.slice(); p[i] = r; p[j] = -1;
            if (tryMove(p)) improved = p;
          }
        }
      }
    }
    if (!improved && options <= 80) {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        if (pick[i] < 0 || pick[j] < 0) continue;
        for (let a = 0; a < players[i].c.length; a++) for (let b = 0; b < players[j].c.length; b++) {
          if (a === pick[i] && b === pick[j]) continue;
          const p = pick.slice(); p[i] = a; p[j] = b;
          if (tryMove(p)) improved = p;
        }
      }
    }
    if (!improved) break;
    improved.forEach((r, i) => { pick[i] = r; });
  }
  const raid = [], bench = [];
  players.forEach((u, i) => { if (pick[i] < 0) bench.push(u); else raid.push({ u, i, n: u.n, s: u.c[pick[i]], rank: pick[i] }); });
  return { raid, bench, slots: arrange(raid, size), adds: [] };
}

// Spread players over groups of five: tanks and melee together, casters together, and one healer, shaman, paladin
// and warlock per group where possible. Shamans lean to casters and healers, who use their water totems most.
// How good one group of five is, as party buffs and habits go:
// - one shaman per group (Mana Spring and the group totems); a second one in a group only if every group has one;
// - one healer per group, healers spread evenly;
// - the shadow priest with healers, for the mana;
// - one paladin per group (auras) and one warlock per group (Blood Pact), when there are enough to go around;
// - tanks together with a paladin (Devotion Aura); melee with melee, casters with casters.
export function groupScore(g, groups, n) {
  const ms = g.map((x) => SPEC[x.s]), count = (f) => ms.filter(f).length, G = groups.length;
  const all = (f) => groups.reduce((s, gr) => s + gr.filter((x) => f(SPEC[x.s])).length, 0);
  const spread = (f, w) => { // w for having one; minus w for each extra while some group has none
    const here = count(f), total = all(f);
    return (here ? w : 0) - (here > 1 && total < G * here ? (here - 1) * w : 0);
  };
  let v = 0;
  v += spread((sp) => sp.cls === "shaman", 20);
  v += spread((sp) => sp.role === "heal", 14);
  v += spread((sp) => sp.cls === "paladin", 8);
  v += spread((sp) => sp.cls === "warlock", 4);
  const heals = count((sp) => sp.role === "heal"), shadow = count((sp) => sp.key === "priest_shadow");
  if (shadow && heals) v += 12; // Vampiric Embrace's mana and health go to the group
  if (count((sp) => sp.role === "tank") && count((sp) => sp.cls === "paladin")) v += 4;
  const phys = count((sp) => sp.role === "tank" || sp.role === "melee"), casters = count((sp) => sp.role === "range");
  v += 1.5 * (phys * (phys - 1) / 2 + casters * (casters - 1) / 2) - 1 * phys * casters;
  v -= 0.01 * Math.abs(g.length - n / G); // even group sizes on ties
  return v;
}
export function arrange(raid, size) {
  const G = Math.min(size / 5, Math.max(1, Math.ceil(raid.length / 5)));
  const groups = Array.from({ length: G }, () => []);
  const phys = (sp) => sp.role === "tank" || sp.role === "melee" || sp.cls === "hunter";
  const caster = (sp) => sp.role === "range" && sp.cls !== "hunter";
  const order = (m) => { const sp = SPEC[m.s]; return sp.role === "tank" ? 0 : sp.cls === "shaman" || sp.cls === "paladin" ? 1 : sp.role === "heal" ? 4 : phys(sp) ? 2 : 3; };
  raid.slice().sort((a, b) => order(a) - order(b)).forEach((m) => {
    const sp = SPEC[m.s];
    let bestG = 0, bestV = -Infinity;
    groups.forEach((g, gi) => {
      if (g.length >= 5) return;
      const ms = g.map((x) => SPEC[x.s]), count = (f) => ms.filter(f).length;
      let v = -0.5 * g.length;
      if (phys(sp)) v += 4 * count(phys) - 3 * count(caster);
      if (caster(sp)) v += 4 * count(caster) - 3 * count(phys);
      if (sp.role === "heal") v -= 10 * count((x) => x.role === "heal");
      if (sp.cls === "shaman") v += 2 * count((x) => caster(x) || x.role === "heal") - 15 * count((x) => x.cls === "shaman");
      if (sp.cls === "paladin") v -= 12 * count((x) => x.cls === "paladin");
      if (sp.cls === "warlock") v -= 4 * count((x) => x.cls === "warlock");
      if (v > bestV) { bestV = v; bestG = gi; }
    });
    groups[bestG].push(m);
  });
  // Then swap players between groups (or move one into a free seat) while the whole raid scores better.
  const total = () => groups.reduce((s, g) => s + groupScore(g, groups, raid.length), 0);
  let best = total();
  for (let guard = 0; guard < 60; guard++) {
    let improved = false;
    for (let a = 0; a < G; a++) for (let b = a + 1; b < G; b++) {
      const A = groups[a], B = groups[b];
      for (let i = 0; i <= A.length; i++) for (let j = 0; j <= B.length; j++) {
        if (i === A.length && j === B.length) continue;
        if (i === A.length && A.length >= 5) continue; // B[j] cannot move into a full group
        if (j === B.length && B.length >= 5) continue;
        const x = A[i], y = B[j];
        if (x) A.splice(i, 1); if (y) B.splice(j, 1);
        if (y) A.splice(i, 0, y); if (x) B.splice(j, 0, x);
        const v = total();
        if (v > best + 1e-9) { best = v; improved = true; continue; }
        if (y) A.splice(i, 1); if (x) B.splice(j, 1); // undo
        if (x) A.splice(i, 0, x); if (y) B.splice(j, 0, y);
      }
    }
    if (!improved) break;
  }
  // Inside a group: tanks first, then melee, ranged, healers.
  const inGroup = { tank: 0, melee: 1, range: 2, heal: 3 };
  groups.forEach((g) => g.sort((a, b) => inGroup[SPEC[a.s].role] - inGroup[SPEC[b.s].role]));
  const slots = Array(MAX).fill(null);
  groups.forEach((g, gi) => g.forEach((m, k) => { slots[gi * 5 + k] = m; }));
  return slots;
}
