// Discord sign-in and claim links, shared by api/comp.js and api/discord.js.
//
// After Discord sign-in (api/discord.js) the server gives the page a session token: "<payload>.<HMAC>", where the
// payload is base64url JSON { i: Discord user id, n: display name, u: username, e: expiry in ms }. The page keeps it
// and sends it as the X-Raidcomp-Session header. The server never stores the token, only checks its HMAC.
// A claim link carries "<signup id>.<HMAC>": the admin sends it to the player who made that signup before sign-in.
import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_DAYS = 30;
// Signs sessions and claim links: a long random value of its own, different in each environment, so a token made in
// one place never works in another. Changing it signs everyone out and makes the old claim links stop working.
const SECRET = process.env.RAIDCOMP_SESSION_SECRET || "";
export const DISCORD_ID = process.env.RAIDCOMP_DISCORD_CLIENT_ID || "";
export const DISCORD_SECRET = process.env.RAIDCOMP_DISCORD_CLIENT_SECRET || "";
// Changes need a Discord account only once the Discord app and the session secret are set in the env. Until then
// nothing changes.
export const SIGN_IN = !!(DISCORD_ID && DISCORD_SECRET && SECRET);

const mac = (s) => createHmac("sha256", SECRET).update(s).digest("base64url");
function sameMac(given, want) {
  const a = Buffer.from(String(given)), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// user: { id, name, username } from Discord.
export function signSession(user) {
  const body = Buffer.from(JSON.stringify({ i: user.id, n: user.name, u: user.username, e: Date.now() + SESSION_DAYS * 864e5 })).toString("base64url");
  return body + "." + mac("session|" + body);
}

// The signed-in Discord user of this request, or null: { id, name, username }.
export function sessionUser(req) {
  if (!SECRET) return null;
  const [body, sig, extra] = String((req.headers || {})["x-raidcomp-session"] || "").split(".");
  if (!body || !sig || extra !== undefined || !sameMac(sig, mac("session|" + body))) return null;
  try {
    const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return v.e > Date.now() && /^\d{5,25}$/.test(v.i) ? { id: v.i, name: String(v.n || ""), username: String(v.u || "") } : null;
  } catch {
    return null;
  }
}

// Claim links: "<signup id>.<22 characters of HMAC>". Anyone with the link can claim that signup once.
export const CLAIM = /^([a-z0-9]{6,24})\.([A-Za-z0-9_-]{22})$/;
export const claimToken = (id) => id + "." + mac("claim|" + id).slice(0, 22);
export function claimedId(token) {
  const m = String(token || "").match(CLAIM);
  return m && SECRET && sameMac(m[2], mac("claim|" + m[1]).slice(0, 22)) ? m[1] : null;
}
