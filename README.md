# feedverse-bot

Discord bot that generates AU prompts and shares Feedverse scenarios join links.

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
- (optional) `OFFICIAL_GUILD_ID` (guild where moderation commands are registered)
- (optional) `FEEDVERSE_JOIN_URL_TEMPLATE` (used by `/share`)
  - recommended: `https://feedverse.app/i/?code={CODE}` (works even without host rewrites)
  - alternative (requires rewrites): `https://feedverse.app/i/{CODE}` or `https://feedverse.com/join/{CODE}`
- (optional) `FEEDVERSE_WEB_BASE_URL` (alternative to template; `/share` links to `{base}/join/{CODE}`)
- (optional) `FEEDVERSE_BRAND_ICON_URL` (embed thumbnail icon for `/share`)
- (optional) `FEEDVERSE_API_BASE_URL`
  - required for `/prompt` + moderation commands and for pulling approved prompts into `/generate` + daily
  - also used by `/share` to show scenario name/cover (if set)
- (required) `FEEDVERSE_BOT_API_SECRET` (sent as `x-bot-secret` to the backend)

Only the person hosting/running the bot needs the `.env` file. Users who invite the bot to their server do not.

3. Start:

```bash
npm start
```

## Commands

- `/generate`
  - optional `universe` (autocomplete)
  - optional `dynamic` (autocomplete)

- `/share`
  - required `invite_code` (scenario invite code like `KPOP2024`)
  - posts an embed with scenario info if `FEEDVERSE_API_BASE_URL` is set
  - always includes the invite code (and optionally a join link if `FEEDVERSE_JOIN_URL_TEMPLATE` or `FEEDVERSE_WEB_BASE_URL` is set)

- `/prompt`
  - required `setting` (autocomplete)
  - required `dynamic` (autocomplete)
  - required `prompt` (text)
  - submits a prompt for moderator review (works in DMs or any server)

- `/setup daily`
  - required `channel`
  - optional `time` (interpreted in the bot host's local timezone)
    - examples: `21:30`, `9pm`, `9:30pm`
  - posts 1 random prompt per day in that channel, and starts a thread for discussion (thread name is the prompt text, shortened if needed)

Moderation (official guild only):
- `/prompt-queue`
- `/prompt-approve submission_id [note]`
- `/prompt-reject submission_id [note]`

`submission_id` can be any of:
- a queue index like `3`
- a short hex prefix like `a1b2c3d4`
- a full UUID

Behavior:
- both set: picks 1 of the 5 for that exact (universe, dynamic)
- only one set: picks randomly across all matching packs, then 1 of the 5
- none: picks randomly across all packs, then 1 of the 5

If `FEEDVERSE_API_BASE_URL` is set, `/generate` and daily will also include approved prompts from the backend (merged with the local JSON packs).

## Notes on command registration

On startup the bot registers slash commands:

- If `DISCORD_GUILD_ID` is set (dev mode): registers ALL commands into that guild only (appears almost immediately).
- Otherwise:
  - registers public commands globally (`/generate`, `/share`, `/prompt`)
  - registers moderation commands ONLY into `OFFICIAL_GUILD_ID` (`/prompt-queue`, `/prompt-approve`, `/prompt-reject`)

If you want the bot to work in any server it’s invited to, leave `DISCORD_GUILD_ID` unset.
