# feedverse-bot

Discord bot that generates AU prompts and drops Feedverse scenarios join links.

## Setup

1. Install deps:

```bash
npm install
```

2. Create a `.env` (copy from `.env.example`) and fill:

- `DISCORD_TOKEN` (bot token)
- `DISCORD_CLIENT_ID` (application client id)
- (optional) `DISCORD_GUILD_ID` (dev guild id)
- (optional) `AU_DATA_PATH` (defaults to `./data/au_summaries_filled.json`)
- (optional) `FEEDVERSE_JOIN_URL_TEMPLATE` (used by `/drop`)
  - recommended: `https://feedverse.app/i/?code={CODE}` (works even without host rewrites)
  - alternative (requires rewrites): `https://feedverse.app/i/{CODE}` or `https://feedverse.com/join/{CODE}`
- (optional) `FEEDVERSE_WEB_BASE_URL` (alternative to template; `/drop` links to `{base}/join/{CODE}`)
- (optional) `FEEDVERSE_BRAND_ICON_URL` (embed thumbnail icon for `/drop`)
- (optional) `FEEDVERSE_API_BASE_URL` (used by `/drop` to show scenario name/cover)

Only the person hosting/running the bot needs the `.env` file. Users who invite the bot to their server do not.

3. Start:

```bash
npm start
```

## Commands

- `/generate`
  - optional `universe` (autocomplete)
  - optional `dynamic` (autocomplete)

- `/drop`
  - required `invite_code` (scenario invite code like `KPOP2024`)
  - posts an embed with scenario info if `FEEDVERSE_API_BASE_URL` is set
  - always includes the invite code (and optionally a join link if `FEEDVERSE_JOIN_URL_TEMPLATE` or `FEEDVERSE_WEB_BASE_URL` is set)

Behavior:
- both set: picks 1 of the 5 for that exact (universe, dynamic)
- only one set: picks randomly across all matching packs, then 1 of the 5
- none: picks randomly across all packs, then 1 of the 5

## Notes on command registration

On startup the bot registers slash commands:
- if `DISCORD_GUILD_ID` is set: guild commands only (appears almost immediately)
- otherwise: global commands (works anywhere the bot is added to; may take time to appear)

If you want the bot to work in any server it’s invited to, leave `DISCORD_GUILD_ID` unset.
