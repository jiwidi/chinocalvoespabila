# Raid Comp · WoW Forever

A shared, live raid composition planner for World of Warcraft: Forever. Everyone with the link edits the same raid, and changes show up for everyone else within a couple of seconds.

- Spec palette (Tank / Heal / Caster-Range / Melee) with real spell icons.
- Groups of five. Each slot shows the player's name; the icon and class color show the spec.
- Raid size 10, 20 or 40.
- Buff coverage panel: raid buffs, totems, party buffs (per group), debuffs, resistances, dispels. Hover or click a row to highlight who brings it and which specs could.
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

## API

`GET /api/comp` → `{ v, size, slots }`, where `slots` has 40 entries of `null` or `{ s: "<class>_<spec>", n: "<name>" }`.

`POST /api/comp` with any of:

```json
{ "slots": { "3": { "s": "paladin_holy", "n": "Jaime" }, "7": null }, "size": 20 }
```

Returns the full updated comp. Names are trimmed to 20 characters.

Set `RAIDCOMP_PREFIX` to keep several independent raids in one database.
