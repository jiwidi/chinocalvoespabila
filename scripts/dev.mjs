// Local dev server: serves index.html and runs api/comp.js with the in-memory store.
// Usage: npm run dev  (then open http://localhost:3000)
// npm run dev:prod starts from a copy of the live comp (or RAIDCOMP_SEED_URL). Edits stay local.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.env.RAIDCOMP_MEMORY ??= "1";

// Copy a live comp into the in-memory store that api/comp.js reads (globalThis.__raidcompMemory).
async function seedFrom(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const { v, size, slots, signups } = await res.json();
  const mem = { v: Number(v) || 0, slots: {}, meta: { size: String(size) }, signups: {} };
  slots.forEach((slot, i) => { if (slot) mem.slots[i] = JSON.stringify(slot); });
  for (const { id, n, c, f } of signups) mem.signups[id] = JSON.stringify({ n, c, f });
  globalThis.__raidcompMemory = mem;
  console.log(`Seeded ${Object.keys(mem.slots).length} slots and ${signups.length} signups from ${url}`);
}

const LIVE_URL = "https://chinocalvoespabila.vercel.app/api/comp";
const seedUrl = process.env.RAIDCOMP_SEED_URL || (process.argv.includes("--seed") ? LIVE_URL : "");
if (seedUrl) await seedFrom(seedUrl);
const { default: handler } = await import("../api/comp.js");

const PORT = Number(process.env.PORT) || 3000;
const INDEX = fileURLToPath(new URL("../index.html", import.meta.url));
// Static files the page loads from the repo (Vercel serves these on its own).
const STATIC = { "/img/": "../img/", "/sounds/": "../sounds/" };
const TYPES = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".mp3": "audio/mpeg", ".ogg": "audio/ogg" };

function wrapRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
    return res;
  };
  return res;
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  if (!data) return undefined;
  try { return JSON.parse(data); } catch { return data; }
}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname === "/api/comp") {
      req.body = await readBody(req);
      return await handler(req, wrapRes(res));
    }
    if (pathname === "/" || pathname === "/index.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.end(await readFile(INDEX));
    }
    const dir = Object.keys(STATIC).find((p) => pathname.startsWith(p));
    const name = dir && pathname.slice(dir.length);
    const type = name && TYPES[name.slice(name.lastIndexOf(".")).toLowerCase()];
    if (type && /^[\w.-]+$/.test(name)) {
      try {
        const body = await readFile(fileURLToPath(new URL(STATIC[dir] + name, import.meta.url)));
        res.setHeader("Content-Type", type);
        return res.end(body);
      } catch { /* fall through to 404 */ }
    }
    res.statusCode = 404;
    res.end("Not found");
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end("Server error");
  }
}).listen(PORT, () => console.log(`Raid comp dev server on http://localhost:${PORT}`));
