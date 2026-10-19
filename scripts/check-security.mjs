// Checks the abuse limits and the security headers against api/comp.js with the in-memory store.
// Usage: npm test  (or node scripts/check-security.mjs). It never touches a real database.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const KEY = "check-admin-key";
process.env.RAIDCOMP_MEMORY = "1";
process.env.RAIDCOMP_ADMIN_KEY = KEY;
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "RAIDCOMP_VISITOR_SECRET"]) delete process.env[k];
// Count database reads: the in-memory store reads `meta` once per read (and on a size change, which these checks skip).
let reads = 0;
globalThis.__raidcompMemory = new Proxy({ v: 0, slots: {}, meta: {}, signups: {} }, {
  get(t, k) { if (k === "meta") reads++; return t[k]; },
});
const { default: handler } = await import("../api/comp.js");

// who: { ip, ua, admin, headers }. Returns { code, out, headers }.
async function call(method, { url = "/api/comp", body, who = {} } = {}) {
  const headers = { "x-real-ip": who.ip || "192.0.2.1", "user-agent": who.ua || "Firefox", ...(who.admin ? { "x-raidcomp-admin": who.admin } : {}), ...who.headers };
  const res = { code: 0, out: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, json(o) { this.out = o; return this; } };
  await handler({ method, url, body, headers, socket: {} }, res);
  return res;
}
const post = (body, who) => call("POST", { body, who });
const me = async (who) => (await call("GET", { url: "/api/comp?me=1", who })).out;
let n = 0;
const newId = () => "sec" + String(++n).padStart(7, "0");
const join = (who, name = "P" + n) => { const id = newId(); return post({ signups: { [id]: { n: name, c: [] } } }, who).then((r) => ({ id, r, made: r.out.signups.some((u) => u.id === id) })); };
const pendingOf = (r) => r.out.signups.filter((u) => u.p).length;
let net = 0;
const freshNet = () => ({ ip: "198.18." + Math.floor(++net / 250) + "." + (net % 250) });

// GETs that skip the CDN cache (a query string, an Authorization header) read the database at most once a second.
await call("GET");
const before = reads;
for (let i = 0; i < 20; i++) assert.equal((await call("GET", { url: "/api/comp?x=" + i, who: { headers: { authorization: "x" } } })).code, 200);
assert.equal(reads - before, 0, "served from the last read");
await new Promise((r) => setTimeout(r, 1050));
await call("GET");
assert.equal(reads - before, 1, "one read after a second");
// A write puts its state there at once: the next GET shows it, without a read.
const w = await post({ slots: { 0: { s: "mage_fire", n: "Cache" } } });
const afterWrite = reads;
const g = await call("GET");
assert.equal(g.out.v, w.out.v);
assert.deepEqual(g.out.slots[0], { s: "mage_fire", n: "Cache" });
assert.equal(reads, afterWrite);

// A POST from another site is refused, so a page there cannot sign up its visitor (who then counts as signed up).
const victim = { ip: "192.0.2.10", ua: "VictimBrowser" };
const host = { host: "raid.example" };
for (const [what, headers, code] of [
  ["other site", { ...host, origin: "https://evil.example" }, 403],
  ["sandboxed frame", { ...host, origin: "null" }, 403],
  ["cross-site, no Origin", { ...host, "sec-fetch-site": "cross-site" }, 403],
  ["this site", { ...host, origin: "https://raid.example", "sec-fetch-site": "same-origin" }, 200],
  ["no browser (curl)", host, 200],
]) {
  const r = await call("POST", { body: JSON.stringify({ slots: { 5: { s: "mage_frost", n: what } } }), who: { ...victim, headers } });
  assert.equal(r.code, code, what);
}
const forged = await call("POST", { body: JSON.stringify({ signups: { [newId()]: { n: "Victim", c: [] } } }), who: { ...victim, headers: { ...host, origin: "https://evil.example" } } });
assert.equal(forged.code, 403);
assert.equal((await me(victim)).signedUp, false, "the victim can still sign up");

// Too large a body, and JSON that Vercel cannot parse.
assert.equal((await call("POST", { body: {}, who: { headers: { "content-length": String(64 * 1024 + 1) } } })).code, 413);
const res = { code: 0, out: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.out = o; return this; } };
const badJson = { method: "POST", url: "/api/comp", headers: { "x-real-ip": "192.0.2.11" }, socket: {} };
Object.defineProperty(badJson, "body", { get() { throw new Error("Invalid JSON"); } });
await handler(badJson, res);
assert.deepEqual([res.code, res.out.message], [400, "Body must be JSON"]);

// The visitor hashes still use the admin key unless RAIDCOMP_VISITOR_SECRET is set, so the live hashes keep matching.
assert.ok((await join({ ip: "192.0.2.77", ua: "Compat" })).made);
const hmac = (s) => createHmac("sha256", KEY).update(s).digest("hex").slice(0, 24);
assert.ok(globalThis.__raidcompMemory.signers["net:" + hmac("192.0.2.77|Compat")]);

// A script can change its browser keys, not its network: 3 new signups per network a day.
for (const [what, ips] of [["IPv4", ["203.0.113.50"]], ["IPv6 /64", ["2001:db8:5:5::1", "2001:db8:5:5::2", "2001:db8:5:5:a::3", "2001:db8:5:5::4"]]]) {
  for (let i = 0; i < 4; i++) {
    const { r, made } = await join({ ip: ips[i % ips.length], ua: what + " browser " + i });
    assert.equal(made, i < 3, what + " signup " + (i + 1));
    if (i === 3) assert.equal(r.out.warning, "Too many new signups from your network today. Ask the admin to add you.");
  }
}
assert.ok((await join({ ip: "2001:db8:5:6::1", ua: "IPv6 /64 browser 9" })).made, "another /64");
assert.ok((await join({ ip: "203.0.113.50", admin: KEY })).made, "the admin can still add that person");

// At most 25 signups wait for approval. Then new ones wait until the admin approves or removes some.
let last = await join(freshNet());
while (pendingOf(last.r) < 25) last = await join(freshNet());
const full = await join(freshNet());
assert.equal(full.made, false);
assert.equal(full.r.out.warning, "Too many signups wait for approval. Try again later, or ask the admin to add you.");
assert.ok((await join({ ...freshNet(), admin: KEY })).made, "the admin can still add");
const approve = (u, who) => post({ signups: { [u.id]: { n: u.n, c: u.c } } }, who); // sent without p: 1
const oldest = last.r.out.signups.find((u) => u.p);
assert.equal((await approve(oldest, { admin: KEY })).out.signups.find((u) => u.id === oldest.id).p, undefined);
last = await join(freshNet());
assert.ok(last.made, "room again after an approval");

// Admin key guesses: after 10 wrong keys in 15 minutes, that network gets no admin rights, even with the right key.
const guesser = { ip: "198.51.100.7" };
for (let i = 0; i < 10; i++) assert.equal((await me({ ...guesser, admin: "guess" + i })).admin, false);
assert.equal((await me({ ...guesser, admin: KEY })).admin, false, "locked");
assert.equal((await me({ ip: "198.51.100.8", admin: KEY })).admin, true, "another network");
const waiting = last.r.out.signups.find((u) => u.p);
const r = await approve(waiting, { ...guesser, admin: KEY });
assert.equal(r.out.signups.find((u) => u.id === waiting.id).p, 1, "a locked network cannot approve");
// IPv6 counts by its /48 here: a server gets a /48 and can use a new /64 for every guess.
for (let i = 0; i < 10; i++) await me({ ip: "2001:db8:aa:" + i + "::1", admin: "guess" });
assert.equal((await me({ ip: "2001:db8:aa:ff::1", admin: KEY })).admin, false, "same /48");
assert.equal((await me({ ip: "2001:db8:ab::1", admin: KEY })).admin, true, "another /48");

// A flood from one network: 120 POSTs or ?me=1 a minute in this instance, then 429. Plain GETs stay cheap and open.
const flood = { ip: "203.0.113.200" };
for (let i = 0; i < 120; i++) assert.equal((await call("GET", { url: "/api/comp?me=1", who: flood })).code, 200);
const over = await post({ slots: { 7: { s: "rogue_combat", n: "Flood" } } }, flood);
assert.equal(over.code, 429);
assert.equal(over.headers["retry-after"], "60");
assert.equal((await call("GET", { url: "/api/comp?me=1", who: flood })).code, 429);
assert.equal((await call("GET", { who: flood })).code, 200);
assert.equal((await post({ slots: { 7: { s: "rogue_combat", n: "Other" } } }, { ip: "203.0.113.201" })).code, 200);

// Changelog: who made each change (admin, the player by their signup, or a visitor tag) and only what really changed.
const queued = (await call("GET")).out.signups.filter((u) => u.p); // the checks above filled the approval queue
await post({ signups: Object.fromEntries(queued.map((u) => [u.id, { n: u.n, c: u.c }])) }, { ip: "192.0.2.152", admin: KEY });
const logPage = async (page = 0) => (await call("GET", { url: "/api/comp?log=1&page=" + page, who: freshNet() })).out;
const player = { ip: "192.0.2.150", ua: "LogBrowser", headers: { "x-raidcomp-fp": "a".repeat(64) } };
const mine = await join(player, "Logger");
assert.ok(mine.made);
let top = (await logPage()).entries[0];
assert.deepEqual([top.a, top.n, top.w], ["join", "Logger", { k: "player", n: "Logger" }]);
const stranger = { ip: "192.0.2.151", ua: "Other" };
await post({ slots: { 9: { s: "mage_frost", n: "Logger" } } }, stranger);
top = (await logPage()).entries[0];
assert.equal(top.a, "slots");
assert.equal(top.w.k, "visitor");
assert.match(top.w.tag, /^[a-f0-9]{4}$/);
// A housemate: same network and browser, but their own fingerprint, so not named as the player.
await post({ slots: { 8: { s: "mage_fire", n: "x" } } }, { ...player, headers: { "x-raidcomp-fp": "b".repeat(64) } });
assert.equal((await logPage()).entries[0].w.k, "visitor", "same network, other browser fingerprint");
await post({ slots: { 8: null } }, player);
assert.deepEqual((await logPage()).entries[0].w, { k: "player", n: "Logger" }, "same fingerprint");
const stored = (await call("GET")).out.signups.find((u) => u.id === mine.id);
await post({ signups: { [mine.id]: { ...stored, n: "Hacked" } } }, stranger); // blocked by the signup lock
assert.notEqual((await logPage()).entries[0].a, "rename", "a blocked edit logs nothing");
await post({ signups: { [mine.id]: { n: "Logger", c: ["mage_frost"], f: "h", p: 1 } } }, { ip: "192.0.2.152", admin: KEY });
const adminRows = (await logPage()).entries.slice(0, 2).map((e) => [e.a, e.w.k]);
assert.deepEqual(adminRows.sort(), [["side", "admin"], ["specs", "admin"]]);
const p0 = await logPage(0), p1 = await logPage(1);
assert.equal(p0.entries.length, 20);
assert.ok(p0.pages >= 2 && p0.total > 20);
assert.notDeepEqual(p0.entries[0], p1.entries[0]);
assert.equal((await logPage(99999)).page, 49, "page is clamped");

// Change requests: a player asks to change their own signup; only the admin answers; the player can withdraw theirs.
const reqOf = async (id) => (await call("GET")).out.requests.find((q) => q.id === id);
await new Promise((r) => setTimeout(r, 1050)); // past the 1-second read cache, so the next reads see the last writes
assert.equal((await me(player)).mine, mine.id, "me=1 names the player's own signup");
let asked = await post({ request: { c: ["priest_holy", "priest_shadow"], f: "a" } }, player);
assert.equal(asked.code, 200);
assert.equal(asked.out.warning, undefined);
assert.deepEqual((await reqOf(mine.id)) && [(await reqOf(mine.id)).c, (await reqOf(mine.id)).f], [["priest_holy", "priest_shadow"], "a"]);
assert.equal((await logPage()).entries[0].a, "request");
assert.equal((await post({ request: { c: ["priest_holy"] } }, stranger)).out.warning, "Sign up first: you can only ask to change your own signup.");
assert.equal((await post({ request: { c: ["mage_fire", "rogue_combat", "druid_feral", "warrior_arms"] } }, player)).code, 400, "4 classes");
assert.equal((await post({ requests: { [mine.id]: null } }, stranger)).out.warning, "Only the admin can answer a change request.");
assert.ok(await reqOf(mine.id), "a stranger cannot remove it");
// The admin approves: applies the change and closes the request in one POST.
const cur = (await call("GET")).out.signups.find((u) => u.id === mine.id), q = await reqOf(mine.id);
await post({ signups: { [mine.id]: { ...cur, c: q.c, f: q.f } }, requests: { [mine.id]: null } }, { ip: "192.0.2.152", admin: KEY });
await new Promise((r) => setTimeout(r, 1050));
const after = (await call("GET")).out;
assert.deepEqual([after.signups.find((u) => u.id === mine.id).c, after.signups.find((u) => u.id === mine.id).f], [["priest_holy", "priest_shadow"], "a"]);
assert.equal(after.requests.find((r) => r.id === mine.id), undefined);
assert.ok((await logPage()).entries.some((e) => e.a === "request-approved"));
// Asking for what you already have is refused; the player can withdraw a request.
assert.equal((await post({ request: { f: "a" } }, player)).out.warning, "That is what you already have.");
await post({ request: { f: "h" } }, player);
await new Promise((r) => setTimeout(r, 1050));
await post({ requests: { [mine.id]: null } }, player);
await new Promise((r) => setTimeout(r, 1050));
assert.equal(await reqOf(mine.id), undefined, "withdrawn");
assert.equal((await logPage()).entries[0].a, "request-withdrawn");

// Security headers. The CSP allows every outside host the page loads from, and no page can frame this one.
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const all = vercel.headers.find((rule) => rule.source === "/(.*)").headers;
const header = (k) => (all.find((h) => h.key.toLowerCase() === k.toLowerCase()) || {}).value || "";
const csp = header("Content-Security-Policy");
const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
const hosts = [...new Set([...page.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]))];
assert.ok(hosts.length >= 3, hosts.join());
for (const h of hosts) assert.ok(csp.includes("https://" + h), h + " is not in the CSP");
for (const d of ["default-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
assert.equal(header("X-Content-Type-Options"), "nosniff");
assert.equal(header("Referrer-Policy"), "strict-origin-when-cross-origin");

console.log("security checks passed: cached reads, same-site POSTs, body limits, signup limits, admin key guesses, flood limit, changelog, change requests, headers");
