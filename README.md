# feedverse-bot

Discord bot that generates AU prompts from `data/au_summaries_filled.json`.

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

Only the person hosting/running the bot needs the `.env` file. Users who invite the bot to their server do not.

3. Start:

```bash
npm start
```

## Commands

- `/generate`
  - optional `universe` (autocomplete)
  - optional `dynamic` (autocomplete)

Behavior:
- both set: picks 1 of the 5 for that exact (universe, dynamic)
- only one set: picks randomly across all matching packs, then 1 of the 5
- none: picks randomly across all packs, then 1 of the 5

## Notes on command registration

On startup the bot registers slash commands:
- if `DISCORD_GUILD_ID` is set: guild commands only (appears almost immediately)
- otherwise: global commands (works anywhere the bot is added to; may take time to appear)

If you want the bot to work in any server it’s invited to, leave `DISCORD_GUILD_ID` unset.
