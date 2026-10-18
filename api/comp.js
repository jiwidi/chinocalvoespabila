// Shared raid comp API.
// GET  /api/comp           -> current comp { v, size, slots[40], signups[] }
// POST /api/comp {slots, size, signups} -> applies changes, returns the new comp
//
// Storage: Upstash Redis (Vercel Marketplace). Each slot is its own hash field,
// so two people editing different slots at the same time never overwrite each other.
//
// Signups (see guardSignups): a new signup waits for the admin's approval (p: 1), each visitor can have one signup
// at a time, and once someone has signed up only the admin can change, approve or remove that signup.
// The admin sends the header x-raidcomp-admin: <RAIDCOMP_ADMIN_KEY>.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";

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
const DEVICE_ID = /^[a-z0-9]{16,40}$/;
const ADMIN_KEY = process.env.RAIDCOMP_ADMIN_KEY || "";
const PREFIX = process.env.RAIDCOMP_PREFIX || "raidcomp";
const KEYS = {
  version: `${PREFIX}:v`, slots: `${PREFIX}:slots`, meta: `${PREFIX}:meta`, signups: `${PREFIX}:signups`,
  signers: `${PREFIX}:signers`, // visitor key -> id of the last signup made with it
};

class BadRequest extends Error {}

function cleanName(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, NAME_MAX);
}

const classOf = (spec) => spec.split("_")[0];

const FACTIONS = new Set(["a", "h", "d"]); // Alliance, Horde, don't mind (either side)

// A signup: a name, the specs that player can bring (best first), optionally their faction (f), and p: 1 while it
// waits for the admin's approval. Not linked to the raid groups. Keeps specs from the first MAX_CLASSES classes only.
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

function parseChanges(body) {
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { throw new BadRequest("Body must be JSON"); }
  }
  if (!body || typeof body !== "object") throw new BadRequest("Body must be an object");
  const out = { slots: {}, signups: {} };
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
  if (!Object.keys(out.slots).length && !Object.keys(out.signups).length && out.size === undefined) throw new BadRequest("Nothing to change");
  return out;
}

// Who is asking, without storing who they are: keyed hashes of IP + browser, and of the page's random device id.
// ponytail: a new network plus cleared browser storage counts as a new person; enough to stop a guildmate, not an attacker.
function visitorKeys(req) {
  const h = req.headers || {};
  const ip = String(h["x-real-ip"] || h["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "").split(",")[0].trim();
  const hash = (s) => createHmac("sha256", ADMIN_KEY || "raidcomp").update(s).digest("hex").slice(0, 24);
  const keys = ["net:" + hash(ip + "|" + (h["user-agent"] || ""))];
  const device = String(h["x-raidcomp-device"] || "");
  if (DEVICE_ID.test(device)) keys.push("dev:" + hash(device));
  return keys;
}

// One signup per visitor at a time: true while a signup made with any of these keys still exists.
async function hasSignup(store, keys) {
  const ids = (await store.signers(keys)).filter(Boolean);
  return ids.length > 0 && (await store.signups(ids)).some(Boolean);
}

function isAdmin(req) {
  const given = String((req.headers || {})["x-raidcomp-admin"] || "");
  if (!ADMIN_KEY || !given) return false;
  const digest = (s) => createHmac("sha256", "admin").update(s).digest(); // same length for a constant-time compare
  return timingSafeEqual(digest(given), digest(ADMIN_KEY));
}

// Without the admin key: a new signup waits for the admin's approval, and a visitor who already has a signup cannot
// make another. Once someone has signed up, a request can only fill in what is still missing (a first side, the
// first specs); the rest of the signup keeps its stored values, approval included. Other changes in the request
// still save, and the reply gets a warning. signers: the visitor keys to record for a new signup.
// ponytail: read-then-write, so two requests at the same instant can each make a signup; a Lua script would fix that.
async function guardSignups(store, req, changes) {
  const ids = Object.keys(changes.signups);
  if (!ids.length || isAdmin(req)) return {};
  const stored = await store.signups(ids);
  const keys = visitorKeys(req);
  let warning = null, signers = null;
  for (const [i, id] of ids.entries()) {
    const old = stored[i], u = changes.signups[id];
    if (!old) {
      if (!u) continue; // removing a signup that is not there
      if (signers || (await hasSignup(store, keys))) {
        delete changes.signups[id];
        warning = "You already signed up. Only one signup per person.";
        continue;
      }
      changes.signups[id] = { ...u, p: 1 };
      signers = Object.fromEntries(keys.map((k) => [k, id]));
      continue;
    }
    if (u === null) {
      delete changes.signups[id];
      warning = "Only the admin can remove a signup.";
      continue;
    }
    const c = old.c.length ? old.c : u.c;
    const f = old.f || u.f;
    const locked = u.n !== old.n || c.join() !== u.c.join() || (u.f !== undefined && u.f !== f);
    if (locked) warning = warning || "Only the admin can change a signup.";
    const keep = { n: old.n, c };
    if (f) keep.f = f; // a page that leaves f out keeps the side
    if (old.p) keep.p = 1;
    changes.signups[id] = keep;
  }
  return { warning, signers };
}

// HMGET without automatic deserialization gives an array in field order; accept an object too.
function inOrder(raw, fields) {
  return Array.isArray(raw) ? raw : fields.map((f) => (raw && raw[f] != null ? raw[f] : null));
}
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
    async write(changes, signers) {
      const tx = redis.multi();
      stageHash(tx, KEYS.slots, changes.slots);
      stageHash(tx, KEYS.signups, changes.signups);
      if (signers) tx.hset(KEYS.signers, signers);
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
    async write(changes, signers) {
      Object.assign(mem.signers, signers);
      for (const hash of ["slots", "signups"]) {
        for (const [field, value] of Object.entries(changes[hash])) {
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
    // GET ?me=1: is this browser's admin key valid (the page shows the signup edit controls only then), and does this
    // visitor already have a signup (then the page does not offer to join). Not cached: the answer is per visitor.
    if (req.method === "GET" && new URL(req.url || "/", "http://local").searchParams.has("me")) {
      const admin = isAdmin(req);
      return res.status(200).json({ admin, signedUp: !admin && (await hasSignup(store, visitorKeys(req))) });
    }
    if (req.method === "GET") {
      const state = await store.read();
      // Let Vercel's CDN answer repeat polls for one second, so 20 open tabs cost about one database read per second.
      res.setHeader("Vercel-CDN-Cache-Control", "max-age=1");
      return res.status(200).json(state);
    }
    if (req.method === "POST") {
      const changes = parseChanges(req.body);
      const { warning, signers } = await guardSignups(store, req, changes);
      const state = await store.write(changes, signers);
      return res.status(200).json(warning ? { ...state, warning } : state);
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: "bad_request", message: err.message });
    console.error("raidcomp api error", err);
    return res.status(500).json({ error: "server_error", message: "The database did not answer. Try again." });
  }
}
