// Checks Discord sign-in and claim links against api/comp.js and api/discord.js with the in-memory store.
// Discord is stubbed: no network, no real app. Usage: npm test (or node scripts/check-auth.mjs).
import assert from "node:assert/strict";

const KEY = "check-admin-key";
process.env.RAIDCOMP_MEMORY = "1";
process.env.RAIDCOMP_ADMIN_KEY = KEY;
process.env.RAIDCOMP_DISCORD_CLIENT_ID = "123456789012345678";
process.env.RAIDCOMP_DISCORD_CLIENT_SECRET = "check-discord-secret";
process.env.RAIDCOMP_SESSION_SECRET = "check-session-secret";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "RAIDCOMP_VISITOR_SECRET"]) delete process.env[k];
globalThis.__raidcompMemory = { v: 0, slots: {}, meta: {}, signups: {} };

// Discord stub: the code "code-<id>" signs in the Discord user <id>. It checks what the callback sends.
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  sent.push(String(url));
  if (String(url) === "https://discord.com/api/oauth2/token") {
    const f = new URLSearchParams(String(opts.body));
    assert.equal(f.get("client_secret"), "check-discord-secret");
    assert.equal(f.get("redirect_uri"), "https://raid.example/api/discord");
    const m = f.get("code").match(/^code-(\d+)$/);
    return m ? new Response(JSON.stringify({ access_token: "tok-" + m[1] })) : new Response("{}", { status: 400 });
  }
  if (String(url) === "https://discord.com/api/users/@me") {
    const id = String(opts.headers.Authorization).replace("Bearer tok-", "");
    return new Response(JSON.stringify({ id, username: "user" + id, global_name: "Name " + id }));
  }
  throw new Error("unexpected fetch " + url);
};
const { default: handler } = await import("../api/comp.js");
const { default: discord } = await import("../api/discord.js");

function res() {
  return { code: 0, statusCode: 0, out: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; },
    json(o) { this.out = o; return this; }, end() {} };
}
async function call(method, { url = "/api/comp", body, who = {} } = {}) {
  const headers = { "x-real-ip": who.ip || "192.0.2.1", "user-agent": who.ua || "Firefox", ...(who.admin ? { "x-raidcomp-admin": who.admin } : {}),
    ...(who.session ? { "x-raidcomp-session": who.session } : {}), ...(who.fp ? { "x-raidcomp-fp": who.fp } : {}) };
  const r = res();
  await handler({ method, url, body, headers, socket: {} }, r);
  return r;
}
// Signs in through the callback, like the browser after Discord. Returns the session token.
async function signIn(id) {
  const r = res();
  await discord({ url: "/api/discord?code=code-" + id + "&state=abcdefghijklmnop1234", headers: { host: "raid.example", "x-forwarded-proto": "https" } }, r);
  assert.equal(r.statusCode, 302);
  const m = r.headers.location.match(/^\/#session=([^&]+)&state=abcdefghijklmnop1234$/);
  assert.ok(m, r.headers.location);
  return decodeURIComponent(m[1]);
}
const admin = { admin: KEY };
let n = 0, ip = 0;
const fresh = (extra) => ({ ip: "198.18.0." + ++ip, fp: (ip.toString(16).padStart(2, "0")).repeat(32), ...extra });
const join = async (who, name) => { const id = "dsc" + String(++n).padStart(7, "0"); const r = await call("POST", { body: { signups: { [id]: { n: name, c: [] } } }, who }); return { id, r }; };

// The callback: a bad state or a refused code sends the page back without a session.
{
  const r = res();
  await discord({ url: "/api/discord?code=code-1&state=short", headers: { host: "raid.example" } }, r);
  assert.equal(r.headers.location, "/#signin=failed");
  const c = res();
  await discord({ url: "/api/discord?error=access_denied&state=abcdefghijklmnop1234", headers: { host: "raid.example" } }, c);
  assert.equal(c.headers.location, "/#signin=cancelled&state=abcdefghijklmnop1234");
  const bad = res();
  await discord({ url: "/api/discord?code=nope&state=abcdefghijklmnop1234", headers: { host: "raid.example", "x-forwarded-proto": "https" } }, bad);
  assert.equal(bad.headers.location, "/#signin=failed&state=abcdefghijklmnop1234");
}

// Sign-in is on: a POST without a session gets 401; the admin key still works alone; ?me tells the page.
const ana = await signIn("100000000000000001"), bo = await signIn("100000000000000002");
assert.equal((await call("POST", { body: { size: 10 }, who: fresh() })).code, 401);
assert.equal((await call("POST", { body: { size: 10 }, who: fresh(admin) })).code, 200);
const meAna = (await call("GET", { url: "/api/comp?me=1", who: fresh({ session: ana }) })).out;
assert.deepEqual([meAna.discord, meAna.user], ["123456789012345678", { name: "Name 100000000000000001" }]);
assert.equal((await call("GET", { url: "/api/comp?me=1", who: fresh() })).out.user, null);
// A changed or expired token counts as signed out.
const [body, sig] = ana.split(".");
const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), i: "100000000000000099" })).toString("base64url") + "." + sig;
assert.equal((await call("POST", { body: { size: 10 }, who: fresh({ session: forged }) })).code, 401);

// One signup per Discord account, on any device and network.
const a1 = await join(fresh({ session: ana }), "Ana");
assert.ok(a1.r.out.signups.some((u) => u.id === a1.id && u.p), "a signed-in player signs up, waiting for approval");
const a2 = await join(fresh({ session: ana }), "Ana2");
assert.equal(a2.r.out.warning, "You already signed up. Only one signup per person.");
assert.equal((await call("GET", { url: "/api/comp?me=1", who: fresh({ session: ana }) })).out.mine, a1.id, "the account finds its signup anywhere");

// Claim links: the admin made signups before sign-in; each player claims theirs with the link.
const old1 = await join(fresh(admin), "Old1"), old2 = await join(fresh(admin), "Old2");
assert.equal((await call("GET", { url: "/api/comp?claims=1", who: fresh() })).code, 403, "only the admin sees claim links");
const links = (await call("GET", { url: "/api/comp?claims=1", who: fresh(admin) })).out.claims;
const link = (id) => links.find((c) => c.id === id).token;
assert.equal(links.find((c) => c.id === a1.id).by, "user100000000000000001", "a signup made while signed in is owned by that account");
assert.equal(links.find((c) => c.id === old1.id).by, null);
const claim = (token, who) => call("POST", { body: { claim: token }, who });
// A made-up or changed link does nothing.
assert.match((await claim(old1.id + "." + "A".repeat(22), fresh({ session: bo }))).out.warning, /not valid/);
assert.equal((await claim(link(old1.id), fresh())).code, 401, "claiming needs Discord sign-in");
// Bo claims Old1: it becomes Bo's, and Bo's account counts as signed up.
let r = await claim(link(old1.id), fresh({ session: bo }));
assert.equal(r.out.warning, undefined);
assert.equal((await call("GET", { url: "/api/comp?me=1", who: fresh({ session: bo }) })).out.mine, old1.id);
assert.equal((await join(fresh({ session: bo }), "Bo2")).r.out.warning, "You already signed up. Only one signup per person.");
assert.equal((await claim(link(old1.id), fresh({ session: bo }))).out.warning, undefined, "claiming again is fine");
// Nobody else can claim Old1, and Bo cannot claim a second signup.
const cy = await signIn("100000000000000003");
assert.match((await claim(link(old1.id), fresh({ session: cy }))).out.warning, /Another Discord account already claimed Old1/);
assert.match((await claim(link(old2.id), fresh({ session: bo }))).out.warning, /already has a signup/);
assert.equal((await call("GET", { url: "/api/comp?claims=1", who: fresh(admin) })).out.claims.find((c) => c.id === old1.id).by, "user100000000000000002");
// The admin undoes the claim: Cy can claim it now, and Bo is free again.
assert.match((await call("POST", { body: { unclaim: old1.id }, who: fresh({ session: bo }) })).out.warning, /Only the admin/);
await call("POST", { body: { unclaim: old1.id }, who: fresh(admin) });
assert.equal((await claim(link(old1.id), fresh({ session: cy }))).out.warning, undefined);
assert.equal((await call("GET", { url: "/api/comp?me=1", who: fresh({ session: cy }) })).out.mine, old1.id);
assert.equal((await call("GET", { url: "/api/comp?me=1", who: fresh({ session: bo }) })).out.mine, null);
// Claim requests: a signed-in player asks for an earlier signup, and the admin confirms it or says no.
const di = await signIn("100000000000000004");
const ask = (id, who) => call("POST", { body: { ask: id }, who });
const meDi = (await call("GET", { url: "/api/comp?me=1", who: fresh({ session: di }) })).out;
assert.equal(meDi.ask, null);
assert.ok(meDi.taken.includes(old1.id) && meDi.taken.includes(a1.id) && !meDi.taken.includes(old2.id), "taken lists the owned signups");
assert.equal((await ask(old2.id, fresh())).code, 401, "asking needs Discord sign-in");
assert.equal((await ask(old2.id, fresh({ session: di }))).out.warning, undefined);
assert.deepEqual((await call("GET", { url: "/api/comp?me=1", who: fresh({ session: di }) })).out.ask, { id: old2.id });
assert.match((await ask(old2.id, fresh({ session: ana }))).out.warning, /already has a signup/);
assert.match((await ask(old1.id, fresh({ session: bo }))).out.warning, /Another Discord account already has Old1/);
assert.equal((await ask(old2.id, fresh({ session: bo }))).out.warning, undefined, "two players can ask for the same signup");
let asks = (await call("GET", { url: "/api/comp?claims=1", who: fresh(admin) })).out.asks;
assert.deepEqual(asks.map((a) => [a.id, a.u, a.d]), [[old2.id, "user100000000000000004", "Name 100000000000000004"], [old2.id, "user100000000000000002", "Name 100000000000000002"]]);
assert.equal((await call("GET", { url: "/api/comp?me=1", who: fresh(admin) })).out.asks, 2);
assert.equal((await call("POST", { body: { askOk: "dc:nothex" }, who: fresh(admin) })).code, 400);
assert.match((await call("POST", { body: { askOk: asks[0].k }, who: fresh({ session: bo }) })).out.warning, /Only the admin/);
// The admin confirms Di: Old2 is Di's, and Bo's request for it goes away.
assert.equal((await call("POST", { body: { askOk: asks[0].k }, who: fresh(admin) })).out.warning, undefined);
assert.equal((await call("GET", { url: "/api/comp?me=1", who: fresh({ session: di }) })).out.mine, old2.id);
assert.deepEqual((await call("GET", { url: "/api/comp?claims=1", who: fresh(admin) })).out.asks, []);
assert.match((await call("POST", { body: { askOk: asks[1].k }, who: fresh(admin) })).out.warning, /gone/);
// The admin says no: the request goes, the signup stays free.
const old3 = await join(fresh(admin), "Old3");
await ask(old3.id, fresh({ session: bo }));
asks = (await call("GET", { url: "/api/comp?claims=1", who: fresh(admin) })).out.asks;
await call("POST", { body: { askNo: asks[0].k }, who: fresh(admin) });
const after = (await call("GET", { url: "/api/comp?claims=1", who: fresh(admin) })).out;
assert.deepEqual([after.asks, after.claims.find((c) => c.id === old3.id).by], [[], null]);
// A claim link also ends the account's open request.
await ask(old3.id, fresh({ session: bo }));
await claim(link(old2.id), fresh({ session: bo })); // owned by Di: refused, request stays
assert.equal((await call("GET", { url: "/api/comp?claims=1", who: fresh(admin) })).out.asks.length, 1);
const old3link = (await call("GET", { url: "/api/comp?claims=1", who: fresh(admin) })).out.claims.find((c) => c.id === old3.id).token;
await claim(old3link, fresh({ session: bo }));
assert.deepEqual((await call("GET", { url: "/api/comp?claims=1", who: fresh(admin) })).out.asks, []);

// The changelog shows the claims.
const log = (await call("GET", { url: "/api/comp?log=1", who: fresh() })).out.entries.map((e) => e.a);
assert.ok(log.includes("claim") && log.includes("unclaim"), log.join());
assert.ok(!sent.some((u) => !u.startsWith("https://discord.com/")), "only Discord was called");
console.log("auth checks passed: Discord sign-in, 401 without it, one signup per account, claim links, unclaim, claim requests");
