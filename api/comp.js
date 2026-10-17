// Shared raid comp API.
// GET  /api/comp           -> current comp { v, size, slots[40] }
// POST /api/comp {slots, size} -> applies changes, returns the new comp
//
// Storage: Upstash Redis (Vercel Marketplace). Each slot is its own hash field,
// so two people editing different slots at the same time never overwrite each other.
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
const PREFIX = process.env.RAIDCOMP_PREFIX || "raidcomp";
const KEYS = { version: `${PREFIX}:v`, slots: `${PREFIX}:slots`, meta: `${PREFIX}:meta` };

class BadRequest extends Error {}

function cleanName(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, NAME_MAX);
}

// HGETALL comes back as a flat [field, value, ...] array when automatic deserialization is off.
function hashToObject(hash) {
  if (!Array.isArray(hash)) return hash || {};
  const out = {};
  for (let i = 0; i + 1 < hash.length; i += 2) out[hash[i]] = hash[i + 1];
  return out;
}

function toState(version, slotsHash, metaHash) {
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
  const size = Number(metaHash && metaHash.size);
  return { v: Number(version) || 0, size: SIZES.has(size) ? size : 20, slots };
}

function parseChanges(body) {
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { throw new BadRequest("Body must be JSON"); }
  }
  if (!body || typeof body !== "object") throw new BadRequest("Body must be an object");
  const out = { slots: {} };
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
  if (body.size !== undefined) {
    if (!SIZES.has(body.size)) throw new BadRequest("size must be 10, 20 or 40");
    out.size = body.size;
  }
  if (!Object.keys(out.slots).length && out.size === undefined) throw new BadRequest("Nothing to change");
  return out;
}

function redisStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token, automaticDeserialization: false });
  return {
    async read() {
      const [v, slots, meta] = await redis.pipeline().get(KEYS.version).hgetall(KEYS.slots).hgetall(KEYS.meta).exec();
      return toState(v, slots, meta);
    },
    async write(changes) {
      const tx = redis.multi();
      const set = {};
      const del = [];
      for (const [i, value] of Object.entries(changes.slots)) {
        if (value) set[i] = JSON.stringify(value);
        else del.push(i);
      }
      if (Object.keys(set).length) tx.hset(KEYS.slots, set);
      if (del.length) tx.hdel(KEYS.slots, ...del);
      if (changes.size !== undefined) tx.hset(KEYS.meta, { size: String(changes.size) });
      tx.incr(KEYS.version);
      tx.hgetall(KEYS.slots);
      tx.hgetall(KEYS.meta);
      const out = await tx.exec();
      const n = out.length;
      return toState(out[n - 3], out[n - 2], out[n - 1]);
    },
  };
}

// In-memory store for local development only (RAIDCOMP_MEMORY=1). Not shared between instances.
function memoryStore() {
  const mem = (globalThis.__raidcompMemory ||= { v: 0, slots: {}, meta: {} });
  return {
    async read() {
      return toState(mem.v, { ...mem.slots }, { ...mem.meta });
    },
    async write(changes) {
      for (const [i, value] of Object.entries(changes.slots)) {
        if (value) mem.slots[i] = JSON.stringify(value);
        else delete mem.slots[i];
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
    if (req.method === "GET") {
      const state = await store.read();
      // Let Vercel's CDN answer repeat polls for one second, so 20 open tabs cost about one database read per second.
      res.setHeader("Vercel-CDN-Cache-Control", "max-age=1");
      return res.status(200).json(state);
    }
    if (req.method === "POST") {
      const changes = parseChanges(req.body);
      const state = await store.write(changes);
      return res.status(200).json(state);
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: "bad_request", message: err.message });
    console.error("raidcomp api error", err);
    return res.status(500).json({ error: "server_error", message: "The database did not answer. Try again." });
  }
}
