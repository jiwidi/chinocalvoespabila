# Supreme Forever · WoW Forever raid planner


A shared, live raid composition planner for World of Warcraft: Forever. Everyone with the link edits the same raid, and changes show up for everyone else within a couple of seconds.

- Signups (left): each player writes a name and the specs they can play, best first. Up to 3 classes per player, with any number of specs in those classes. One signup per person. A new signup waits, greyed out, in **Waiting for approval** until the admin approves it. Newest signups show first. The list is separate from the groups.
- Suggested comp (right): the best groups of five for the signups, recalculated as they change. Each group shows its tanks/healers/dps and its party buffs; players with no seat fill extra Bench groups, and a Bench panel lists them. A box lists who plays something other than their 1st choice, and why. With more signups than seats, tabs show several options so everyone plays in at least one. The hand-edited raid groups are gone; the slots stay in the API.
- Raid size 10 or 20 (the API still accepts 40).
- Suggested comp: the best comp for the signups, built from each player's specs in order of preference. For 20 it aims for at least 2 tanks, 3 healers plus 1 off-healer (a Druid, Paladin, Priest or Shaman in a dps spec, or else a 4th healer), 2–3 shamans, and one of each main buff. For 10: 2 tanks, 2 healers plus 1 off-healer, 1–2 shamans. It follows the WoW Forever beta notes of Oct 16, 2026: Battle Shout, Trueshot Aura, Moonkin Aura, Leader of the Pack and the Windfury, Grace of Air, Strength of Earth and Flametongue totems are raid wide. Windfury and Grace of Air are both air totems, so having both takes 2 shamans. Salvation is no longer a blessing, so any paladin gives it.
- Coverage panel (under the suggested comp): composition, raid buffs, totems, party buffs (per group), debuffs, resistances, dispels, for the option on screen. Hover or click a row to highlight which signups could bring it.
- Heads-up notes for blessing, totem and curse limits.
- Copy the option on screen as text for Discord.

## How it works

- `index.html`: the whole front end, with no build step. It polls `GET /api/comp` every 1.5 s while the tab is visible and sends edits with `POST /api/comp`.
- `api/comp.js`: a Vercel function backed by Upstash Redis. Each slot is its own hash field, so two people editing different slots never overwrite each other. GET responses are cached on Vercel's CDN for 1 second, so many open tabs cost roughly one database read per second.
- `vercel.json`: security headers for every response (Content-Security-Policy, `X-Content-Type-Options`, `Referrer-Policy`). If the page starts to load something from a new outside host, add that host to the CSP, or the browser blocks it. `npm test` checks this.
- Icons are loaded from Wowhead's image CDN (`wow.zamimg.com`).

## Deploy on Vercel

1. In Vercel, **Add New → Project**, import this repo. Framework preset: **Other**. No build command or env vars needed yet. Deploy.
2. In the project, open **Storage → Create Database → Upstash for Redis** (free plan is fine) and connect it to this project. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) to the project.
3. **Redeploy** so the function picks up the new variables.

Until a database is connected, the page shows a "No database" banner.

## Local development

```bash
npm i -g vercel
vercel link
vercel env pull .env.local   # pulls the Upstash credentials
vercel dev
```

Careful: `vercel env pull` copies the live database token and the admin key to your computer, and `vercel dev` then edits the live raid. Prefer the commands below.

Without a database you can run `RAIDCOMP_MEMORY=1 vercel dev` to use a throwaway in-memory store (not shared between function instances, so don't use it in production).

Or, without Vercel: `npm run dev` serves the page and the API on http://localhost:3000 with the in-memory store, and `npm run dev:prod` starts from a read-only copy of the live raid (pending approvals included). Set `PORT` to use another port. The dev server sends the same headers as `vercel.json`. Locally the admin key is `dev`: open `http://localhost:3000/#admin=dev` to get the admin controls.

`npm test` runs `scripts/check-security.mjs` against the in-memory store.

## API

`GET /api/comp` → `{ v, size, slots, signups }`:

- `slots` has 40 entries of `null` or `{ s: "<class>_<spec>", n: "<name>" }`.
- `signups` is a list of `{ id, n: "<name>", c: ["<class>_<spec>", ...], f }` in signup order. `c` is ordered best first and holds specs from at most 3 classes. `f` is the faction: `"a"` (Alliance), `"h"` (Horde), `"d"` (doesn't mind which side), or missing if the player has not picked yet. `p: 1` means the signup waits for the admin's approval. Until then it counts for nothing: it is not in the signups count, the slot picker, the suggested comp or the Horde vs Alliance score, and its specs cannot be placed. `b: 1` means the admin put the player on the bench: the suggested comp leaves them out of every option, and the signup shows a **Bench** badge. Only the admin can set or clear it (the **Bench** button on the signup row); you can still place a benched player in the groups by hand. `r: 1` means the admin locked the player in: the suggested comp puts them in every option, and the signup shows a **Locked** badge (the **Lock** button). Bench and lock exclude each other.

`POST /api/comp` with any of:

```json
{
  "slots": { "3": { "s": "paladin_holy", "n": "Jaime" }, "7": null },
  "size": 20,
  "signups": { "mgx2k1a0abcd": { "n": "Jaime", "c": ["paladin_holy", "priest_discipline"] }, "mgx2k1a1efgh": null }
}
```

A signup id is 6–24 lowercase letters or digits. The page makes ids that start with a base-36 timestamp, so the list stays in signup order. `null` removes a slot or a signup. Returns the full updated comp. Names are trimmed to 20 characters.

Set `RAIDCOMP_PREFIX` to keep several independent raids in one database.

### Signup approval and lock

Anyone can sign up, one signup per person. The server knows a person by keyed hashes of three signals, and any one of them is enough:

- IP + browser string. An IPv6 address counts by its first 4 groups (its /64), because IPv6 privacy addresses change often.
- A random device id that the page keeps in the browser (header `X-Raidcomp-Device`).
- A browser fingerprint (header `X-Raidcomp-Fp`): a SHA-256 of canvas and WebGL drawing, audio processing, installed fonts, CPU and memory, timezone and language. It is the same in a private window and on another network. It leaves out what changes on one device (zoom, window and screen size, dark mode).

The server stores only the keyed hashes, in `raidcomp:signers`. Two people with the same device model and browser version can look the same; the admin can add the second one. After a person signs up once, a second signup from them is refused, also when the admin removed the first one. The admin can still add that person's signup.

A new signup gets `p: 1` and shows under **Waiting for approval**, for everyone. The admin approves it (✓), which moves it to the signups list. The admin can also move an approved signup back to waiting (↩). Signups that the admin makes are approved at once.

After someone signs up, only the admin can change or remove that signup: the name, the specs (add, remove, reorder), the side, and the approval. A player can still fill in what is missing: a first side, and the first specs if they skipped them when they joined.

Without the admin key, the server keeps the stored signup, still saves the other changes in the request, and the reply has a `warning`. The page shows it and plays `sounds/blocked.m4a`. For visitors who are not admin, the page shows the signups read-only; the spec icons still place players in the raid.

To fix data, use the admin key from the `RAIDCOMP_ADMIN_KEY` environment variable in Vercel:

- In the browser: open the site once with `#admin=<key>` at the end of the URL. The page shows an **Admin** badge and all the signup edit controls on that browser. Click the badge, or open `#admin=`, to turn it off.
- With curl: send the header `X-Raidcomp-Admin: <key>`.

`GET /api/comp?me=1` answers `{ "admin": true | false, "signedUp": true | false }` for the key and the visitor that send the request. `signedUp` is true when this visitor has signed up before. It is never cached.

### Limits and security

The URL is public, and the free Vercel and Upstash plans count every request and every database command. A "network" below is an IPv4 address or an IPv6 /64 (a /48 for admin keys). The server does this:

- A `GET /api/comp` reads the database at most once a second in each function instance. This is also true when a query string or an `Authorization` header skips the CDN cache.
- The server refuses a `POST` from another site (`403`). Browsers send `Origin` with every POST. The server accepts a request without it, for example from curl.
- The server refuses a `POST` body over 64 KB (`413`).
- More than 120 `POST` or `?me=1` requests a minute from one network get `429` in that function instance. The page waits and sends the edit again.
- New signups without the admin key: at most 3 per network a day, and at most 25 waiting for approval at once. The reply has a `warning`. The admin can still add anyone.
- After 10 wrong admin keys in 15 minutes from one network, that network gets no admin rights for 15 minutes. The right key does not help in that time.

Use a long random admin key, for example the output of `openssl rand -base64 32`. The visitor hashes use the admin key as their secret. To change the admin key and keep "one signup per person", do these steps in Vercel:

1. Set `RAIDCOMP_VISITOR_SECRET` to the old admin key.
2. Set `RAIDCOMP_ADMIN_KEY` to the new key.
3. Redeploy.

These limits slow down one person with a script. They do not stop a flood from many addresses. A slow script can also use up the Upstash free plan (500,000 commands a month) over some days. So:

- Add one Vercel WAF rate limit rule (Hobby includes one). It stops a flood before the function runs. Use these values: path equals `/api/comp`, method equals `POST`, action Rate Limit, fixed window 60 s, 60 requests, key IP, response 429.
- Watch the command count in the Upstash console. Polling alone costs about 4 commands a second while at least one tab is open.
- Under attack, turn on Attack Challenge Mode in the Vercel Firewall.

### Changelog

Every change that the server saves goes into a changelog (`raidcomp:log`, newest first, the last 1000), in the same transaction as the change. Edits that the signup rules block are not logged. Each entry is `{ t, w, a, n, x }`: the time, who made it, the action (`join`, `remove`, `rename`, `approve`, `wait`, `bench`, `unbench`, `lock`, `unlock`, `side`, `specs`, `size`, `slots`), the player it is about, and details (old and new side or specs, for example).

Who, without storing who they are:

- `{ "k": "admin" }` when the request has the admin key;
- `{ "k": "player", "n": "<name>" }` when the browser's own keys (fingerprint, device id) made a signup: the name of that signup. The network + browser key, which housemates can share, only counts for requests that send neither;
- `{ "k": "visitor", "tag": "3fa9" }` otherwise: 4 characters cut from the visitor's keyed hash, the same for that browser, not reversible.

`GET /api/comp?log=1&page=N` answers `{ entries, page, pages, total }`, 20 entries a page, page 0 the newest. It counts toward the per-network request limit. The **Changelog** button on the page opens it in a dialog. The admin sees it in the **Audit** view instead.

### Who can change what

Only the admin changes things after signup, directly: signups (name, specs, side, approval, bench, lock, remove) and the raid itself (slots and size). A player can only sign up, claim their own signup with a claim link, and fill in what is still missing on **their own** signup (a first side, the first specs). There are no change requests: a player who wants a change asks the admin, for example on Discord. `GET /api/comp?me=1` answers `mine`, the visitor's own signup id.

A visitor's edit to the raid gets the warning "Only the admin can change the raid." Older entries in the changelog can still show `request`, `request-approved`, `request-rejected` and `request-withdrawn` from when requests existed; the unused `raidcomp:requests` hash can be deleted.

### Discord sign-in and claim links

When the Discord app is set up, every change (signing up, claiming a signup, any edit) needs a signed-in Discord account. Viewing stays open to everyone, and the admin key still works without Discord. Until the three variables below are set, nothing changes.

How it works:

- **Sign in with Discord** sends the player to Discord's authorize page (scope `identify` only: Discord id and name, no email). Discord sends them back to `/api/discord`, which trades the code for their identity and sends the page a session token in the URL fragment. The page accepts it only when the `state` matches the one it made. The token is signed with `RAIDCOMP_SESSION_SECRET` and lasts 30 days. The server stores no token.
- The page sends the token as `X-Raidcomp-Session`. The Discord account is the strongest visitor key, so one signup per person becomes one signup per Discord account, and ownership and the changelog follow the account across browsers. The changelog never shows Discord names.
- On arrival, a visitor who is not signed in sees a **Sign in with Discord** popup with **Skip**, once per browser session (not with the admin key).
- A POST without a session (and without the admin key) gets `401 { error: "sign_in" }`. `GET /api/comp?me=1` adds `discord` (the client id, or "") and `user` (`{ name }` or null).

Claim requests, for signups made before Discord sign-in:

- After sign-in, a player with no signup sees **Already signed up?** (once per browser session) with the signups that have no Discord account yet. Picking one asks the admin. The signups panel then shows "Waiting for the admin to confirm that <name> is you", with **Change**, or "Already on the list? **Claim your signup**" when they skipped.
- The admin sees the open requests at the top of the **Audit** view, and their number on the **Audit** tab. **Confirm** does what a claim link does. **No** drops the request. Confirming drops the other requests for that signup.
- One open request per Discord account (a new one replaces it), at most 50 at once. API: `POST {ask: id}`, `POST {askOk: key}` / `POST {askNo: key}` (admin); `GET ?claims=1` adds `asks`; `GET ?me=1` adds `ask` and `taken` for a signed-in player, `asks` (a count) for the admin. Storage: `raidcomp:asks` (the account's visitor key → `{ id, u, d, t }`).

Claim links, the other way to do the same (send each player their own link):

- In admin mode, the header has **Roster | Audit**. The **Audit** view (`/#audit`) takes the place of the roster. It lists every signup, newest first, with side, specs, status, when they joined, its link (`/#claim=<signup id>.<HMAC>`), with **Copy link**, **Copy all unclaimed links** and who claimed each one (Discord username, only the admin sees it), and under it the changelog. Send each player their own link in a private message.
- The player opens the link. If they are not signed in, the page keeps the link in that tab, they sign in with Discord, and the claim goes through when they come back. Their Discord account then owns that signup.
- One owner per signup and one signup per account. **Undo** frees a signup so its link works again. API: `GET ?claims=1` (admin), `POST {claim: token}`, `POST {unclaim: id}` (admin). Storage: `raidcomp:owners` (signup id → `{ k, u }`).

Setup:

1. On https://discord.com/developers/applications create an application. Under **OAuth2**, copy the **Client ID**, reset and copy the **Client Secret**, and add a redirect: `https://<your site>/api/discord` (and `http://localhost:3000/api/discord` for local tests).
2. In Vercel, add `RAIDCOMP_DISCORD_CLIENT_ID`, `RAIDCOMP_DISCORD_CLIENT_SECRET` (sensitive) and `RAIDCOMP_SESSION_SECRET` (sensitive; a long random value such as `openssl rand -base64 32`, different for Production and Preview), then redeploy.
3. A preview shares the production database unless you also set `RAIDCOMP_PREFIX` (for example `raidcomp-preview`) for Preview.

### Poll: pick the faction by coin flip?

Under **Horde vs Alliance**, a poll asks "¿Elegimos facción a cara o cruz?" (yes: coin flip; no: the majority decides). Only a signed-in Discord account votes (`POST /api/comp {"vote": "y" | "n"}`); the admin key alone does not. Votes live in `raidcomp:poll` (Discord account's visitor key → `{ v, n: Discord display name, t, c: changes so far }`). `GET /api/comp` returns `poll: { y: [names], n: [names] }`, in the order people voted, so the page shows the share and who voted what.

Against flip-flopping, a vote can change at most 3 times, and not within 10 minutes of the last change (`MAX_VOTE_CHANGES`, `VOTE_COOLDOWN_MS`); the server answers with a warning otherwise. `GET /api/comp?me=1` gives the signed-in account's `vote: { v, left, next }` so the page shows what is left. The changelog logs each vote.
