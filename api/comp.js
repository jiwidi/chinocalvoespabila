// Shared raid comp API.
// GET  /api/comp           -> current comp { v, size, slots[40], signups[] }
// GET  /api/comp?log=1&page=N -> changelog, newest first: { entries, page, pages, total }
// GET  /api/comp?claims=1  -> (admin) a claim link token for every signup, and which Discord user claimed it
// POST /api/comp {claim: token} -> the signed-in Discord user claims that signup; {unclaim: id} (admin) undoes a claim
// POST /api/comp {ask: id} -> the signed-in Discord user asks the admin for that signup; {askOk|askNo: key} (admin) answers
// POST /api/comp {slots, size, signups} -> applies changes, returns the new comp
//
// Storage: Upstash Redis (Vercel Marketplace). Each slot is its own hash field,
// so two people editing different slots at the same time never overwrite each other.
//
// Signups (see guardSignups): a new signup waits for the admin's approval (p: 1), each visitor can sign up once
// (a removed signup still counts), and once someone has signed up only the admin can change, approve or remove it.
// A visitor can only fill in what is still missing on their own signup. The raid itself (slots, size) is the admin's.
// The admin sends the header x-raidcomp-admin: <RAIDCOMP_ADMIN_KEY>.
//
// Discord sign-in (lib/auth.js, api/discord.js): once the Discord app is set in the env, every POST needs a signed-in
// Discord account (header x-raidcomp-session) or the admin key. The account is the strongest visitor key, so one signup
// per person becomes one per Discord account. Players who signed up before claim their signup with a link from the admin,
// or ask for it and the admin confirms (handleAsks).
//
// Abuse limits: the free plans count every request and every database command, and the URL is public. So a GET reads
// the database at most once a second per instance, a POST must come from this site, and the counts below cap
// requests, new signups and admin key guesses per network.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import { CLAIM, DISCORD_ID, SIGN_IN, claimToken, claimedId, sessionUser } from "../lib/auth.js";

const SPECS = new Set([
  "druid_balance", "druid_feral", "druid_guardian", "druid_restoration",
  "hunter_beast_mastery", "hunter_marksmanship", "hunter_survival",
  "mage_arcane", "mage_fire", "mage_frost",
  "paladin_holy", "paladin_protection", "paladin_retribution",
  "priest_discipline", "priest_holy", "priest_shadow",
  "rogue_assassination", "rogue_combat", "rogue_subtlety",
  "shaman_elemental", "shaman_enhancement", "shaman_restoration",
  "warlock_affliction", "warlock_demonology", "warlock_destruction",
  "warrior_arms", "warrior_fury", "warrior_protection",
]);
const SIZES = new Set([10, 20, 40]);
const MAX_SLOTS = 40;
const NAME_MAX = 20;
const MAX_SIGNUPS = 100; // per request
const MAX_CLASSES = 3; // per signup; any number of specs within those classes
const SIGNUP_ID = /^[a-z0-9]{6,24}$/;
const ASK_KEY = /^dc:[0-9a-f]{24}$/; // a Discord account's visitor key (see visitorKeys)
const DEVICE_ID = /^[a-z0-9]{16,40}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/; // SHA-256 of the page's browser signals
const MAX_BODY = 64 * 1024; // bytes per POST; a page edit is a few KB
const READ_MS = 1000; // a GET reuses the comp this instance read less than this long ago
const REQUESTS_PER_MIN = 120; // POSTs and ?me=1 per network, in each function instance
const MAX_PENDING = 25; // signups that wait for approval at once
const MAX_ASKS = 50; // open claim requests at once
const NEW_SIGNUPS_PER_DAY = 3; // per network: an IPv4 address or an IPv6 /64
const LOG_MAX = 1000; // changelog entries kept
const LOG_PAGE = 20; // changelog entries per page
const ADMIN_TRIES = 10; // wrong admin keys per network (an IPv4 address or an IPv6 /48) in 15 minutes
const ADMIN_KEY = process.env.RAIDCOMP_ADMIN_KEY || "";
// Key for the visitor hashes. It is the admin key unless set, so the stored hashes keep matching. Before you change
// RAIDCOMP_ADMIN_KEY, set RAIDCOMP_VISITOR_SECRET to the old key, or every visitor can sign up once more.
const VISITOR_SECRET = process.env.RAIDCOMP_VISITOR_SECRET || ADMIN_KEY || "raidcomp";
const PREFIX = process.env.RAIDCOMP_PREFIX || "raidcomp";
// The deploy this code came with. Open pages reload when it changes, so everyone runs the latest version.
const BUILD = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "";
const KEYS = {
  version: `${PREFIX}:v`, slots: `${PREFIX}:slots`, meta: `${PREFIX}:meta`, signups: `${PREFIX}:signups`,
  signers: `${PREFIX}:signers`, // visitor key -> id of the last signup made with it
  limit: `${PREFIX}:limit:`, // + "signup:<network>" or "admin:<network>": counters that expire
  log: `${PREFIX}:log`, // changelog: JSON entries, newest first, at most LOG_MAX
  owners: `${PREFIX}:owners`, // signup id -> { k: the Discord account's visitor key, u: Discord username }: who owns it
  asks: `${PREFIX}:asks`, // Discord account's visitor key -> { id: signup id, u: username, d: display name, t }: claim requests
};

class BadRequest extends Error {}

function cleanName(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, NAME_MAX);
}

const classOf = (spec) => spec.split("_")[0];

const FACTIONS = new Set(["a", "h", "d"]); // Alliance, Horde, don't mind (either side)

// A signup: a name, the specs that player can bring (best first), optionally their faction (f), p: 1 while it
// waits for the admin's approval, b: 1 when the admin put the player on the bench (left out of the suggested comp),
// or r: 1 when the admin locked the player into the suggested comp (in every option). Not both b and r.
// Not linked to the raid groups. Keeps specs from the first MAX_CLASSES classes only.
function cleanSignup(v) {
  if (!v || typeof v !== "object") return null;
  const n = cleanName(v.n);
  const f = FACTIONS.has(v.f) ? v.f : undefined;
  const c = [];
  const classes = new Set();
  for (const k of Array.isArray(v.c) ? v.c : []) {
    if (!SPECS.has(k) || c.includes(k)) continue;
    if (!classes.has(classOf(k)) && classes.size >= MAX_CLASSES) continue;
    classes.add(classOf(k));
    c.push(k);
  }
  if (!n && !c.length) return null;
  const out = { n, c };
  if (f) out.f = f;
  if (v.p) out.p = 1;
  if (v.b) out.b = 1;
  else if (v.r) out.r = 1;
  return out;
}

// HGETALL comes back as a flat [field, value, ...] array when automatic deserialization is off.
function hashToObject(hash) {
  if (!Array.isArray(hash)) return hash || {};
  const out = {};
  for (let i = 0; i + 1 < hash.length; i += 2) out[hash[i]] = hash[i + 1];
  return out;
}

function toState(version, slotsHash, metaHash, signupsHash) {
  const slots = Array(MAX_SLOTS).fill(null);
  metaHash = hashToObject(metaHash);
  for (const [field, raw] of Object.entries(hashToObject(slotsHash))) {
    const i = Number(field);
    if (!Number.isInteger(i) || i < 0 || i >= MAX_SLOTS) continue;
    try {
      const v = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (v && SPECS.has(v.s)) slots[i] = { s: v.s, n: cleanName(v.n) };
    } catch {
      /* ignore a corrupt field */
    }
  }
  const signups = [];
  for (const [id, raw] of Object.entries(hashToObject(signupsHash))) {
    if (!SIGNUP_ID.test(id)) continue;
    try {
      const u = cleanSignup(typeof raw === "string" ? JSON.parse(raw) : raw);
      if (u) signups.push({ id, ...u });
    } catch {
      /* ignore a corrupt field */
    }
  }
  signups.sort((a, b) => (a.id < b.id ? -1 : 1)); // ids start with a timestamp, so this is signup order
  const size = Number(metaHash && metaHash.size);
  return { v: Number(version) || 0, size: SIZES.has(size) ? size : 20, slots, signups };
}

// Vercel parses a JSON body when the code first reads req.body, and throws when it cannot.
function bodyOf(req) {
  try { return req.body; } catch { throw new BadRequest("Body must be JSON"); }
}

function parseChanges(body) {
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { throw new BadRequest("Body must be JSON"); }
  }
  if (!body || typeof body !== "object") throw new BadRequest("Body must be an object");
  const out = { slots: {}, signups: {}, owners: {} };
  if (body.slots !== undefined) {
    if (!body.slots || typeof body.slots !== "object") throw new BadRequest("slots must be an object");
    const entries = Object.entries(body.slots);
    if (entries.length > MAX_SLOTS) throw new BadRequest("Too many slots");
    for (const [key, value] of entries) {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i >= MAX_SLOTS) throw new BadRequest(`Bad slot index ${key}`);
      if (value === null) out.slots[i] = null;
      else if (value && typeof value === "object" && SPECS.has(value.s)) out.slots[i] = { s: value.s, n: cleanName(value.n) };
      else throw new BadRequest(`Bad value for slot ${key}`);
    }
  }
  if (body.signups !== undefined) {
    if (!body.signups || typeof body.signups !== "object") throw new BadRequest("signups must be an object");
    const entries = Object.entries(body.signups);
    if (entries.length > MAX_SIGNUPS) throw new BadRequest("Too many signups");
    for (const [id, value] of entries) {
      if (!SIGNUP_ID.test(id)) throw new BadRequest(`Bad signup id ${id}`);
      if (value === null) { out.signups[id] = null; continue; }
      const u = cleanSignup(value);
      const c = value && value.c;
      const badSpecs = c !== undefined && !(Array.isArray(c) && c.length <= SPECS.size && c.every((k) => SPECS.has(k)) &&
        new Set(c.map(classOf)).size <= MAX_CLASSES);
      if (!u || badSpecs) throw new BadRequest(`Bad value for signup ${id}`);
      out.signups[id] = u;
    }
  }
  if (body.size !== undefined) {
    if (!SIZES.has(body.size)) throw new BadRequest("size must be 10, 20 or 40");
    out.size = body.size;
  }
  if (body.claim !== undefined) {
    if (!CLAIM.test(String(body.claim))) throw new BadRequest("That is not a claim link");
    out.claim = String(body.claim);
  }
  if (body.unclaim !== undefined) {
    if (typeof body.unclaim !== "string" || !SIGNUP_ID.test(body.unclaim)) throw new BadRequest("unclaim takes a signup id");
    out.unclaim = body.unclaim;
  }
  if (body.ask !== undefined) {
    if (typeof body.ask !== "string" || !SIGNUP_ID.test(body.ask)) throw new BadRequest("ask takes a signup id");
    out.ask = body.ask;
  }
  for (const f of ["askOk", "askNo"]) {
    if (body[f] === undefined) continue;
    if (typeof body[f] !== "string" || !ASK_KEY.test(body[f])) throw new BadRequest(f + " takes a claim request key");
    out[f] = body[f];
  }
  if (!Object.keys(out.slots).length && !Object.keys(out.signups).length && out.size === undefined && !out.claim && !out.unclaim &&
    !out.ask && !out.askOk && !out.askNo) {
    throw new BadRequest("Nothing to change");
  }
  return out;
}

// The client's address. On Vercel the platform sets x-real-ip and x-forwarded-for, so a client cannot fake them.
function clientIp(req) {
  const h = req.headers || {};
  return String(h["x-real-ip"] || h["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "").split(",")[0].trim();
}

// IPv6 privacy addresses change often inside the home's /64, so an IPv6 address counts by its first 4 groups.
// groups = 3 gives the /48, the block a home or a rented server usually gets.
function netOf(ip, groups = 4) {
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1); // IPv4, also when written as ::ffff:1.2.3.4
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t].slice(0, groups).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

// Keyed hash, so the database never holds an address, a device id or a fingerprint.
const keyed = (s) => createHmac("sha256", VISITOR_SECRET).update(s).digest("hex").slice(0, 24);

// Who is asking, without storing who they are: keyed hashes of the signed-in Discord account (first, when there is
// one), of IP + browser, of the page's random device id, and of the page's browser fingerprint (the same in a private
// window and on another network). Any one of them is enough.
// ponytail: a different device on a different network is a new person; enough to stop a guildmate, not an attacker.
function visitorKeys(req) {
  const h = req.headers || {}, user = sessionUser(req);
  const keys = ["net:" + keyed(netOf(clientIp(req)) + "|" + (h["user-agent"] || ""))];
  const device = String(h["x-raidcomp-device"] || ""), fp = String(h["x-raidcomp-fp"] || "");
  if (DEVICE_ID.test(device)) keys.push("dev:" + keyed(device));
  if (FINGERPRINT.test(fp)) keys.push("fp:" + keyed(fp));
  if (user) keys.unshift("dc:" + keyed("discord|" + user.id));
  return keys;
}
// The key that names this visitor best: the Discord account, then the fingerprint, the device id, the network.
const bestKey = (keys) => ["dc:", "fp:", "dev:"].map((p) => keys.find((k) => k.startsWith(p))).find(Boolean) || keys[0];

// One signup per visitor, for good: true once any of these keys has made a signup, even if the admin removed it.
// ponytail: IP + browser can match two people (same house, mobile carrier NAT); the admin adds the second one.
async function hasSignup(store, keys) {
  return (await store.signers(keys)).some(Boolean);
}

// The admin key. After ADMIN_TRIES wrong keys from one network in 15 minutes, that network gets no admin rights, not
// even with the right key, until the count expires. This slows down guessing. A short key is still weak.
async function isAdmin(store, req) {
  const given = String((req.headers || {})["x-raidcomp-admin"] || "");
  if (!ADMIN_KEY || !given) return false;
  const tries = "admin:" + keyed(netOf(clientIp(req), 3));
  if ((await store.count(tries)) >= ADMIN_TRIES) return false;
  const digest = (s) => createHmac("sha256", "admin").update(s).digest(); // same length for a constant-time compare
  if (timingSafeEqual(digest(given), digest(ADMIN_KEY))) return true;
  await store.bump(tries, 15 * 60);
  return false;
}

// Requests per network in this function instance: a first line against floods that costs no database command.
// ponytail: per instance, so a flood spread over many instances or networks gets more; a Vercel WAF rate limit rule
// (see the README) stops it before the function runs.
const hits = new Map(); // network -> { at, n }
function flooding(net) {
  const now = Date.now(), hit = hits.get(net);
  if (hit && now - hit.at < 60_000) return ++hit.n > REQUESTS_PER_MIN;
  if (hits.size >= 10_000) hits.clear(); // a flood from many networks: start over instead of growing
  hits.set(net, { at: now, n: 1 });
  return false;
}

// Browsers send Origin with every POST. Refuse a POST from another site: a page there could otherwise sign up its
// visitor without asking (and that visitor then counts as signed up, for good).
function fromOtherSite(req) {
  const h = req.headers || {};
  if (h["sec-fetch-site"] === "cross-site") return true;
  if (!h.origin) return false; // not a browser, for example curl
  try { return new URL(h.origin).host !== h.host; } catch { return true; } // "null" from a sandboxed frame, too
}

// GET reuses the comp this instance read less than READ_MS ago. The CDN cache does the same for plain polls, but a
// query string or an Authorization header skips the CDN, and each such GET would cost 4 database commands.
let lastRead = null; // { at, state: Promise }
function readState(store) {
  if (!lastRead || Date.now() - lastRead.at >= READ_MS) lastRead = { at: Date.now(), state: store.read() };
  return lastRead.state;
}

// Why the server refuses a new signup from this visitor, or null. One signup per person, MAX_PENDING signups at most
// waiting for approval, and NEW_SIGNUPS_PER_DAY per network (a script can change the browser keys, not its network).
async function refuseNew(store, req, keys, madeOne) {
  if (madeOne || (await hasSignup(store, keys))) return "You already signed up. Only one signup per person.";
  if ((await store.pending()) >= MAX_PENDING) return "Too many signups wait for approval. Try again later, or ask the admin to add you.";
  if ((await store.bump("signup:" + keyed(netOf(clientIp(req))), 24 * 3600)) > NEW_SIGNUPS_PER_DAY) {
    return "Too many new signups from your network today. Ask the admin to add you.";
  }
  return null;
}

// Without the admin key: a new signup waits for the admin's approval, and a visitor who already has a signup cannot
// make another (see refuseNew). Once someone has signed up, only that visitor can fill in what is still missing on it
// (a first side, the first specs); the rest of the signup keeps its stored values, approval included. Other changes in the
// request still save, and the reply gets a warning. signers: the visitor keys to record for a new signup.
// ponytail: read-then-write, so two requests at the same instant can each make a signup; a Lua script would fix that.
// stored: the signups as they are now, in the order of Object.keys(changes.signups).
async function guardSignups(store, req, changes, stored) {
  const ids = Object.keys(changes.signups);
  const keys = visitorKeys(req);
  const mine = stored.some(Boolean) ? await ownSignupId(store, req) : null; // the one signup this visitor may fill in
  let warning = null, signers = null;
  for (const [i, id] of ids.entries()) {
    const old = stored[i], u = changes.signups[id];
    if (!old) {
      if (!u) continue; // removing a signup that is not there
      const refused = await refuseNew(store, req, keys, !!signers);
      if (refused) {
        delete changes.signups[id];
        warning = refused;
        continue;
      }
      const { b, r, ...fresh } = u; // only the admin benches or locks in
      changes.signups[id] = { ...fresh, p: 1 };
      signers = Object.fromEntries(keys.map((k) => [k, id]));
      const user = sessionUser(req);
      if (user) changes.owners[id] = { k: keys[0], u: user.username }; // keys[0] is the Discord account
      continue;
    }
    if (u === null) {
      delete changes.signups[id];
      warning = "Only the admin can remove a signup.";
      continue;
    }
    const own = id === mine; // only your own signup: the first specs and the first side
    const c = old.c.length || !own ? old.c : u.c;
    const f = old.f || (own ? u.f : undefined);
    const locked = u.n !== old.n || c.join() !== u.c.join() || (u.f !== undefined && u.f !== f);
    if (locked) warning = warning || "Only the admin can change a signup.";
    const keep = { n: old.n, c };
    if (f) keep.f = f; // a page that leaves f out keeps the side
    if (old.p) keep.p = 1;
    if (old.b) keep.b = 1;
    if (old.r) keep.r = 1;
    changes.signups[id] = keep;
  }
  return { warning, signers };
}

// Changelog. Who made a change, without storing who they are:
// - the admin, when the request has the admin key;
// - the player, when this visitor's keys made a signup (the one-signup-per-person record), by that signup's name;
// - else "visitor" with a 4-character tag cut from the visitor's keyed hash: stable for that browser, not reversible.
// ponytail: the page always sends its device id and fingerprint, so the shared "net:" key only names requests without
// them (scripts, curl); a player who cleared storage on a new device shows as a visitor.
// The signup this visitor made, by the browser's own keys (fingerprint, device id). The network + browser key, which a
// housemate can share, only counts when the request has neither. null when this visitor has not signed up.
async function ownSignupId(store, req) {
  const keys = visitorKeys(req), own = keys.filter((k) => !k.startsWith("net:"));
  return (await store.signers(own.length ? own : keys)).find(Boolean) || null;
}

async function actorOf(store, req, admin, changes, signers, before) {
  if (admin) return { k: "admin" };
  if (signers) { // signed up in this very request
    const id = Object.values(signers)[0], u = changes.signups[id];
    if (u && u.n) return { k: "player", n: u.n };
  }
  const keys = visitorKeys(req), id = await ownSignupId(store, req);
  if (id) {
    const u = id in before ? before[id] : (await store.signups([id]))[0];
    if (u && u.n) return { k: "player", n: u.n };
  }
  return { k: "visitor", tag: bestKey(keys).split(":")[1].slice(0, 4) };
}

// What changed, as changelog entries { t, w: actor, a: action, n: player name, x: details }, oldest first.
// before: id -> the signup as it was (or null). Runs after guardSignups, so blocked edits log nothing.
function describe(changes, before, w, sizeBefore) {
  const t = Date.now(), out = [];
  const add = (a, n, x) => out.push(x ? { t, w, a, n, x } : { t, w, a, n });
  for (const [id, u] of Object.entries(changes.signups)) {
    const old = before[id] || null;
    if (!old && !u) continue;
    if (!old) { add("join", u.n, { c: u.c, f: u.f || "", p: u.p ? 1 : 0 }); continue; }
    if (!u) { add("remove", old.n); continue; }
    if (u.n !== old.n) add("rename", u.n, { from: old.n });
    if (!!u.p !== !!old.p) add(u.p ? "wait" : "approve", u.n);
    if (!!u.b !== !!old.b) add(u.b ? "bench" : "unbench", u.n);
    if (!!u.r !== !!old.r) add(u.r ? "lock" : "unlock", u.n);
    if ((u.f || "") !== (old.f || "")) add("side", u.n, { from: old.f || "", to: u.f || "" });
    if (u.c.join() !== old.c.join()) add("specs", u.n, { from: old.c, to: u.c });
  }
  if (changes.size !== undefined && changes.size !== sizeBefore) add("size", "", { from: sizeBefore, to: changes.size });
  const slots = Object.keys(changes.slots).length;
  if (slots) add("slots", "", { n: slots });
  return out;
}

// Claim links. A player who signed up before Discord sign-in opens the admin's link while signed in: their Discord
// account then owns that signup (the page shows it as theirs, and the account counts as signed up). Each signup has at
// most one owner and each account owns one signup. The admin can undo a claim, so the link works again.
// Returns { warning, signers }: signers to add for the claim.
async function handleClaims(store, req, admin, user, changes, actor, entries) {
  const t = Date.now();
  if (changes.unclaim) {
    if (!admin) return { warning: "Only the admin can undo a claim." };
    const id = changes.unclaim, [[owner], [u]] = await Promise.all([store.owners([id]), store.signups([id])]);
    if (owner) {
      changes.owners[id] = null;
      changes.unsign = [owner.k]; // the account no longer counts as signed up
      entries.push({ t, w: actor, a: "unclaim", n: u ? u.n : "" }); // the changelog is public: no Discord username
    }
  }
  if (!changes.claim) return {};
  if (!user) return { warning: "Sign in with Discord to claim your signup." };
  const id = claimedId(changes.claim);
  if (!id) return { warning: "This claim link is not valid. Ask the admin for a new one." };
  const key = visitorKeys(req)[0]; // the Discord account
  const [[u], [owner], [has]] = await Promise.all([store.signups([id]), store.owners([id]), store.signers([key])]);
  if (!u) return { warning: "That signup is gone. Ask the admin." };
  if (owner && owner.k !== key) return { warning: "Another Discord account already claimed " + u.n + ". Ask the admin." };
  if (owner) return {}; // already yours
  if (has && has !== id && (await store.signups([has]))[0]) return { warning: "Your Discord account already has a signup. Ask the admin." };
  changes.owners[id] = { k: key, u: user.username };
  changes.asks = { [key]: null }; // an open claim request from this account is done too
  entries.push({ t, w: { k: "player", n: u.n }, a: "claim", n: u.n });
  return { signers: { [key]: id } };
}

// Claim requests: a signed-in player says which earlier signup is theirs, and the admin confirms it (or says no) in the
// Audit view. Confirming does what a claim link does. One open request per Discord account; a new one replaces it.
// Returns { warning, signers }, like handleClaims.
async function handleAsks(store, req, admin, user, changes, entries) {
  if (changes.ask) {
    if (!user) return { warning: "Sign in with Discord to claim your signup." };
    const key = visitorKeys(req)[0], id = changes.ask; // the Discord account
    const [[u], [owner], [has], asks] = await Promise.all([store.signups([id]), store.owners([id]), store.signers([key]), store.asks()]);
    if (!u) return { warning: "That signup is gone. Ask the admin." };
    if (owner) return { warning: owner.k === key ? u.n + " is already yours." : "Another Discord account already has " + u.n + ". Ask the admin." };
    if (has && (await store.signups([has]))[0]) return { warning: "Your Discord account already has a signup." };
    if (!asks[key] && Object.keys(asks).length >= MAX_ASKS) return { warning: "Too many open claim requests. Ask the admin." };
    changes.asks = { [key]: { id, u: user.username, d: user.name, t: Date.now() } };
    return {};
  }
  const key = changes.askOk || changes.askNo;
  if (!key) return {};
  if (!admin) return { warning: "Only the admin can answer claim requests." };
  const asks = await store.asks(), ask = asks[key];
  if (!ask) return { warning: "That claim request is gone." };
  changes.asks = { [key]: null };
  if (changes.askNo) return {};
  const [[u], [owner], [has]] = await Promise.all([store.signups([ask.id]), store.owners([ask.id]), store.signers([key])]);
  if (!u) return { warning: "That signup is gone." };
  if (owner) return { warning: u.n + " already has a Discord account. Undo that claim first." };
  if (has && has !== ask.id && (await store.signups([has]))[0]) return { warning: "That Discord account already has a signup." };
  changes.owners[ask.id] = { k: key, u: ask.u };
  for (const [k, a] of Object.entries(asks)) if (a.id === ask.id) changes.asks[k] = null; // the others asking for it
  entries.push({ t: Date.now(), w: { k: "admin" }, a: "claim", n: u.n });
  return { signers: { [key]: ask.id } };
}

// HMGET without automatic deserialization gives an array in field order; accept an object too.
function inOrder(raw, fields) {
  return Array.isArray(raw) ? raw : fields.map((f) => (raw && raw[f] != null ? raw[f] : null));
}
const parseEntry = (raw) => {
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
};
const parseSignup = (raw) => {
  try { return cleanSignup(typeof raw === "string" ? JSON.parse(raw) : raw); } catch { return null; }
};

// Queue HSET for new values and HDEL for nulls on one hash.
function stageHash(tx, key, changes) {
  const set = {};
  const del = [];
  for (const [field, value] of Object.entries(changes)) {
    if (value) set[field] = JSON.stringify(value);
    else del.push(field);
  }
  if (Object.keys(set).length) tx.hset(key, set);
  if (del.length) tx.hdel(key, ...del);
}

function redisStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token, automaticDeserialization: false });
  return {
    async read() {
      const [v, slots, meta, signups] = await redis.pipeline().get(KEYS.version).hgetall(KEYS.slots).hgetall(KEYS.meta).hgetall(KEYS.signups).exec();
      return toState(v, slots, meta, signups);
    },
    async signups(ids) {
      return inOrder(await redis.hmget(KEYS.signups, ...ids), ids).map(parseSignup);
    },
    async signers(keys) {
      return inOrder(await redis.hmget(KEYS.signers, ...keys), keys);
    },
    async owners(ids) {
      return inOrder(await redis.hmget(KEYS.owners, ...ids), ids).map(parseEntry);
    },
    async ownedIds() {
      return (await redis.hkeys(KEYS.owners)) || [];
    },
    // Open claim requests: { key: request }.
    async asks() {
      const all = hashToObject(await redis.hgetall(KEYS.asks)); // a flat [field, value, ...] list without deserialization
      return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, parseEntry(v)]).filter(([, v]) => v));
    },
    async pending() {
      return ((await redis.hvals(KEYS.signups)) || []).map(parseSignup).filter((u) => u && u.p).length;
    },
    async count(name) {
      return Number(await redis.get(KEYS.limit + name)) || 0;
    },
    // Adds one to a counter and (re)starts its expiry, in one transaction so a counter never stays without one.
    async bump(name, seconds) {
      const [n] = await redis.multi().incr(KEYS.limit + name).expire(KEYS.limit + name, seconds).exec();
      return Number(n);
    },
    // A page of the changelog, newest first.
    async log(page) {
      const start = page * LOG_PAGE;
      const [rows, total] = await redis.pipeline().lrange(KEYS.log, start, start + LOG_PAGE - 1).llen(KEYS.log).exec();
      return { rows: (rows || []).map(parseEntry).filter(Boolean), total: Number(total) || 0 };
    },
    // log: changelog entries for this write, oldest first. They go in with the write, in the same transaction.
    async write(changes, signers, log = []) {
      const tx = redis.multi();
      stageHash(tx, KEYS.slots, changes.slots);
      stageHash(tx, KEYS.signups, changes.signups);
      stageHash(tx, KEYS.owners, changes.owners || {});
      stageHash(tx, KEYS.asks, changes.asks || {});
      if (changes.unsign) tx.hdel(KEYS.signers, ...changes.unsign);
      if (signers) tx.hset(KEYS.signers, signers);
      if (log.length) { tx.lpush(KEYS.log, ...log.map((e) => JSON.stringify(e))); tx.ltrim(KEYS.log, 0, LOG_MAX - 1); }
      if (changes.size !== undefined) tx.hset(KEYS.meta, { size: String(changes.size) });
      tx.incr(KEYS.version);
      tx.hgetall(KEYS.slots);
      tx.hgetall(KEYS.meta);
      tx.hgetall(KEYS.signups);
      const out = await tx.exec();
      const n = out.length;
      return toState(out[n - 4], out[n - 3], out[n - 2], out[n - 1]);
    },
  };
}

// In-memory store for local development only (RAIDCOMP_MEMORY=1). Not shared between instances.
function memoryStore() {
  const mem = (globalThis.__raidcompMemory ||= { v: 0, slots: {}, meta: {}, signups: {} });
  mem.signers ||= {};
  mem.owners ||= {};
  mem.asks ||= {};
  mem.limits ||= {}; // name -> { n, until }
  return {
    async read() {
      return toState(mem.v, { ...mem.slots }, { ...mem.meta }, { ...mem.signups });
    },
    async signups(ids) {
      return ids.map((id) => parseSignup(mem.signups[id]));
    },
    async signers(keys) {
      return keys.map((k) => mem.signers[k] || null);
    },
    async owners(ids) {
      return ids.map((id) => parseEntry(mem.owners[id] || null));
    },
    async ownedIds() {
      return Object.keys(mem.owners);
    },
    async asks() {
      return Object.fromEntries(Object.entries(mem.asks).map(([k, v]) => [k, parseEntry(v)]));
    },
    async pending() {
      return Object.values(mem.signups).map(parseSignup).filter((u) => u && u.p).length;
    },
    async count(name) {
      const l = mem.limits[name];
      return l && l.until > Date.now() ? l.n : 0;
    },
    async bump(name, seconds) {
      const n = (await this.count(name)) + 1;
      mem.limits[name] = { n, until: Date.now() + seconds * 1000 };
      return n;
    },
    async log(page) {
      const all = mem.log || [];
      return { rows: all.slice(page * LOG_PAGE, (page + 1) * LOG_PAGE).map(parseEntry).filter(Boolean), total: all.length };
    },
    async write(changes, signers, log = []) {
      Object.assign(mem.signers, signers);
      for (const k of changes.unsign || []) delete mem.signers[k];
      if (log.length) mem.log = log.slice().reverse().map((e) => JSON.stringify(e)).concat(mem.log || []).slice(0, LOG_MAX);
      for (const hash of ["slots", "signups", "owners", "asks"]) {
        for (const [field, value] of Object.entries(changes[hash] || {})) {
          if (value) mem[hash][field] = JSON.stringify(value);
          else delete mem[hash][field];
        }
      }
      if (changes.size !== undefined) mem.meta.size = String(changes.size);
      mem.v += 1;
      return this.read();
    },
  };
}

function getStore() {
  return redisStore() || (process.env.RAIDCOMP_MEMORY === "1" ? memoryStore() : null);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const store = getStore();
  if (!store) {
    return res.status(503).json({
      error: "storage_not_connected",
      message: "No database is connected. In Vercel, add Upstash for Redis to this project (Storage tab), then redeploy.",
    });
  }
  try {
    const query = new URL(req.url || "/", "http://local").searchParams;
    const me = req.method === "GET" && query.has("me"), log = req.method === "GET" && query.has("log");
    const claims = req.method === "GET" && query.has("claims");
    if (req.method === "GET" && !me && !log && !claims) {
      const state = await readState(store);
      // Let Vercel's CDN answer repeat polls for one second, so 20 open tabs cost about one database read per second.
      res.setHeader("Vercel-CDN-Cache-Control", "max-age=1");
      return res.status(200).json(BUILD ? { ...state, build: BUILD } : state);
    }
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "method_not_allowed" });
    }
    if (flooding(netOf(clientIp(req)))) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "too_many_requests", message: "Too many requests. Wait a minute, then try again." });
    }
    // GET ?me=1: is this browser's admin key valid (the page shows the signup edit controls only then), and does this
    // visitor already have a signup (then the page does not offer to join). Not cached: the answer is per visitor.
    if (me) {
      const admin = await isAdmin(store, req);
      // mine: the id of this visitor's own signup, so the page can offer "Request change" on that row.
      const mine = admin ? null : await ownSignupId(store, req);
      // discord: the Discord app's client id when sign-in is on (the page needs it for the authorize URL).
      // user: the signed-in Discord account, or null (an expired or bad session token).
      const user = sessionUser(req);
      const signedUp = !admin && (!!mine || (await hasSignup(store, visitorKeys(req))));
      // asks: for the admin, how many claim requests wait. ask: this player's open claim request ({ id } or null), and
      // taken: the signups that already have a Discord account, so the page offers only the others.
      const more = {};
      if (admin) more.asks = Object.keys(await store.asks()).length;
      else if (user && !signedUp) {
        const [asks, taken] = await Promise.all([store.asks(), store.ownedIds()]), ask = asks[visitorKeys(req)[0]];
        Object.assign(more, { ask: ask ? { id: ask.id } : null, taken });
      }
      return res.status(200).json({ admin, signedUp, mine, discord: SIGN_IN ? DISCORD_ID : "", user: user ? { name: user.name } : null, ...more });
    }
    // GET ?claims=1 (admin): a claim link token for every signup, and the Discord username that claimed it (or null).
    if (claims) {
      if (!(await isAdmin(store, req))) return res.status(403).json({ error: "forbidden", message: "Only the admin can see claim links." });
      const { signups } = await readState(store), owners = signups.length ? await store.owners(signups.map((u) => u.id)) : [];
      const asks = Object.entries(await store.asks()).map(([k, a]) => ({ k, ...a })).sort((a, b) => a.t - b.t);
      return res.status(200).json({ claims: signups.map((u, i) => ({ id: u.id, n: u.n, p: u.p ? 1 : 0, token: claimToken(u.id), by: owners[i] ? owners[i].u || "?" : null })), asks });
    }
    // GET ?log=1&page=N: one page of the changelog (page 0 is the newest). Counted by the flood limit above.
    if (log) {
      const page = Math.max(0, Math.min(Math.floor(Number(query.get("page")) || 0), Math.ceil(LOG_MAX / LOG_PAGE) - 1));
      const { rows, total } = await store.log(page);
      return res.status(200).json({ entries: rows, page, pages: Math.max(1, Math.ceil(total / LOG_PAGE)), total });
    }
    if (fromOtherSite(req)) return res.status(403).json({ error: "forbidden", message: "Edits must come from the raid planner page." });
    if (Number((req.headers || {})["content-length"]) > MAX_BODY) {
      return res.status(413).json({ error: "too_large", message: "The request is too large." });
    }
    const changes = parseChanges(bodyOf(req));
    const ids = Object.keys(changes.signups);
    const admin = await isAdmin(store, req); // costs a database command only when the request sends a key
    const user = sessionUser(req);
    if (SIGN_IN && !admin && !user) return res.status(401).json({ error: "sign_in", message: "Sign in with Discord to make changes or ask for one." });
    // The raid itself (slots, size) is the admin's: a visitor's edits to it are dropped, with a warning.
    let raidNote = null;
    if (!admin && (Object.keys(changes.slots).length || changes.size !== undefined)) {
      changes.slots = {};
      delete changes.size;
      raidNote = "Only the admin can change the raid.";
    }
    const stored = ids.length ? await store.signups(ids) : [];
    const { warning, signers } = ids.length && !admin ? await guardSignups(store, req, changes, stored) : {};
    // Changelog: who, and what changed after the signup rules. Nothing that the rules blocked shows up.
    const before = Object.fromEntries(ids.map((id, i) => [id, stored[i]]));
    const sizeBefore = changes.size !== undefined ? (await readState(store)).size : undefined;
    const actor = await actorOf(store, req, admin, changes, signers, before);
    const entries = describe(changes, before, actor, sizeBefore);
    for (const [id, u] of Object.entries(changes.signups)) if (u === null) changes.owners[id] = null; // a removed signup has no owner
    const claim = await handleClaims(store, req, admin, user, changes, actor, entries);
    const ask = await handleAsks(store, req, admin, user, changes, entries);
    const note = warning || raidNote || claim.warning || ask.warning;
    const added = { ...signers, ...claim.signers, ...ask.signers };
    const state = await store.write(changes, Object.keys(added).length ? added : null, entries);
    lastRead = { at: Date.now(), state: Promise.resolve(state) }; // this instance's next GETs show the write at once
    return res.status(200).json(note ? { ...state, warning: note } : state);
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: "bad_request", message: err.message });
    console.error("raidcomp api error", err);
    return res.status(500).json({ error: "server_error", message: "The database did not answer. Try again." });
  }
}
