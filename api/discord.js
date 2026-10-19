// Discord sign-in, step 2. The page sends the player to Discord's authorize page with redirect_uri = <site>/api/discord
// and a random state. Discord sends them back here with a code. This trades the code for the player's Discord id and
// name (scope "identify" only), then sends the page back with a session token in the URL fragment, which never goes to
// a server. The page accepts the token only when the state matches the one it made (no forced sign-in from elsewhere).
import { DISCORD_ID, DISCORD_SECRET, SIGN_IN, signSession } from "../lib/auth.js";

const STATE = /^[A-Za-z0-9_-]{16,64}$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = new URL(req.url || "/", "http://local").searchParams, state = q.get("state") || "";
  const back = (fragment) => {
    res.statusCode = 302;
    res.setHeader("Location", "/#" + fragment);
    res.end();
  };
  if (!SIGN_IN || !STATE.test(state)) return back("signin=failed");
  if (!q.get("code")) return back("signin=cancelled&state=" + state); // the player pressed Cancel on Discord
  try {
    const h = req.headers || {};
    const proto = String(h["x-forwarded-proto"] || "http").split(",")[0];
    const token = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_ID, client_secret: DISCORD_SECRET, grant_type: "authorization_code",
        code: q.get("code"), redirect_uri: proto + "://" + h.host + "/api/discord", // the same as the page sent
      }),
    });
    if (!token.ok) return back("signin=failed&state=" + state);
    const { access_token: access } = await token.json();
    const me = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + access } });
    if (!me.ok) return back("signin=failed&state=" + state);
    const u = await me.json();
    if (!/^\d{5,25}$/.test(String(u.id))) return back("signin=failed&state=" + state);
    const name = String(u.global_name || u.username || "").slice(0, 32);
    const session = signSession({ id: String(u.id), name, username: String(u.username || "").slice(0, 32) });
    return back("session=" + encodeURIComponent(session) + "&state=" + state);
  } catch (err) {
    console.error("discord sign-in error", err);
    return back("signin=failed&state=" + state);
  }
}
