# Supreme Forever · WoW Forever raid planner


A shared, live raid composition planner for World of Warcraft: Forever. Everyone with the link edits the same raid, and changes show up for everyone else within a couple of seconds.

- Signups (left): each player writes a name and the specs they can play, best first. Up to 3 classes per player, with any number of specs in those classes. One signup per person. A new signup waits, greyed out, in **Waiting for approval** until the admin approves it. Newest signups show first. The list is separate from the groups.
- Groups of five (right), built from the signups: click an empty slot and pick from the signups not in the raid yet, click a spec in the signups to put that player in the next empty slot, or drag a spec onto a slot. A player is in the raid only once; clicking another of their specs switches it. Signups already in the raid show their group. Each slot shows the player's name; the icon and class color show the spec.
- Raid size 10 or 20 (the API still accepts 40). **Clear groups** empties the groups and keeps the signups.
- Coverage panel (under the groups): composition, raid buffs, totems, party buffs (per group), debuffs, resistances, dispels. Hover or click a row to highlight who brings it and which signups could.
- Heads-up notes for blessing, totem and curse limits.
- Copy roster as text for Discord.

## How it works

- `index.html`: the whole front end, with no build step. It polls `GET /api/comp` every 1.5 s while the tab is visible and sends edits with `POST /api/comp`.
- `api/comp.js`: a Vercel function backed by Upstash Redis. Each slot is its own hash field, so two people editing different slots never overwrite each other. GET responses are cached on Vercel's CDN for 1 second, so many open tabs cost roughly one database read per second.
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

Without a database you can run `RAIDCOMP_MEMORY=1 vercel dev` to use a throwaway in-memory store (not shared between function instances, so don't use it in production).

Or, without Vercel: `npm run dev` serves the page and the API on http://localhost:3000 with the in-memory store, and `npm run dev:prod` starts from a read-only copy of the live raid (pending approvals included). Locally the admin key is `dev`: open `http://localhost:3000/#admin=dev` to get the admin controls.

## API

`GET /api/comp` → `{ v, size, slots, signups }`:

- `slots` has 40 entries of `null` or `{ s: "<class>_<spec>", n: "<name>" }`.
- `signups` is a list of `{ id, n: "<name>", c: ["<class>_<spec>", ...], f }` in signup order. `c` is ordered best first and holds specs from at most 3 classes. `f` is the faction: `"a"` (Alliance), `"h"` (Horde), `"d"` (doesn't mind which side), or missing if the player has not picked yet. `p: 1` means the signup waits for the admin's approval. Until then it counts for nothing: it is not in the signups count, the slot picker, the suggested comp or the Horde vs Alliance score, and its specs cannot be placed.

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

Without the admin key, the server keeps the stored signup, still saves the other changes in the request (for example raid slots), and the reply has a `warning`. The page shows it and plays `sounds/blocked.m4a`. For visitors who are not admin, the page shows the signups read-only; the spec icons still place players in the raid.

To fix data, use the admin key from the `RAIDCOMP_ADMIN_KEY` environment variable in Vercel:

- In the browser: open the site once with `#admin=<key>` at the end of the URL. The page shows an **Admin** badge and all the signup edit controls on that browser. Click the badge, or open `#admin=`, to turn it off.
- With curl: send the header `X-Raidcomp-Admin: <key>`.

`GET /api/comp?me=1` answers `{ "admin": true | false, "signedUp": true | false }` for the key and the visitor that send the request. `signedUp` is true when this visitor has signed up before. It is never cached.
