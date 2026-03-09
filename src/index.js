require('dotenv').config();

const {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  REST,
  Routes
} = require('discord.js');

const {
  loadAuData,
  resolveAuDataPath,
  choice,
  filterPacks,
  pickSummary
} = require('./auData');

const { buildCommands } = require('./commands');

function requireEnv(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error('Missing required env var: ' + name);
  }
  return v;
}

function normalizeOption(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v;
}

function startsWithFold(a, b) {
  return a.toLowerCase().startsWith(b.toLowerCase());
}

function toAutocompleteChoices(items, query, limit) {
  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? items.filter((x) => x && typeof x.name === 'string' && x.name.toLowerCase().includes(q))
    : items;

  const sorted = filtered.sort((x, y) => x.name.localeCompare(y.name));
  return sorted.slice(0, limit);
}

async function registerCommands(token, clientId, guildId, commands) {
  const rest = new REST({ version: '10' }).setToken(token);
  const body = commands.map((c) => c.toJSON());

  // Dev-friendly behavior:
  // - If DISCORD_GUILD_ID is set, register guild commands (near-instant updates).
  // - Otherwise, register global commands (works in any server; slower to propagate).
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body });
}

async function main() {
  const token = requireEnv('DISCORD_TOKEN');
  const clientId = requireEnv('DISCORD_CLIENT_ID');
  const guildId = normalizeOption(process.env.DISCORD_GUILD_ID);

  const auPath = resolveAuDataPath();
  const au = loadAuData(auPath);

  const commands = buildCommands();
  await registerCommands(token, clientId, guildId, commands);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.commands = new Collection();
  for (const cmd of commands) {
    client.commands.set(cmd.name, cmd);
  }

  client.once(Events.ClientReady, (c) => {
    process.stdout.write('Logged in as ' + c.user.tag + '\n');
    process.stdout.write('Loaded AU data: ' + au.packs.length + ' packs\n');
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused(true);
        const value = normalizeOption(focused.value) || '';

        if (focused.name === 'universe') {
          const items = au.universes.map((u) => ({
            name: (u.emoji ? u.emoji + ' ' : '') + u.label + ' (' + u.id + ')',
            value: u.id
          }));
          const choices = toAutocompleteChoices(items, value, 25);
          await interaction.respond(choices);
          return;
        }

        if (focused.name === 'dynamic') {
          const items = au.dynamics.map((d) => ({
            name: (d.emoji ? d.emoji + ' ' : '') + d.label + ' (' + d.id + ')',
            value: d.id
          }));
          const choices = toAutocompleteChoices(items, value, 25);
          await interaction.respond(choices);
          return;
        }

        await interaction.respond([]);
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== 'generate') return;

      const universeId = normalizeOption(interaction.options.getString('universe'));
      const dynamicId = normalizeOption(interaction.options.getString('dynamic'));

      const matching = filterPacks(au.packs, universeId, dynamicId);
      const pickedPack = choice(matching);

      if (!pickedPack) {
        await interaction.reply({
          content: 'No prompts found for that filter.',
          ephemeral: true
        });
        return;
      }

      const summary = pickSummary(pickedPack);
      if (!summary) {
        await interaction.reply({
          content: 'Found a matching pack, but it has no usable summaries.',
          ephemeral: true
        });
        return;
      }

      // If only one filter is set, this picks across all possibilities for the other dimension.
      // If neither is set, it picks from all packs.
      await interaction.reply({ content: summary });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (interaction.isRepliable()) {
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: 'Error: ' + msg, ephemeral: true });
          } else {
            await interaction.reply({ content: 'Error: ' + msg, ephemeral: true });
          }
        } catch (_) {
          // ignore
        }
      }
      process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    }
  });

  await client.login(token);
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 1;
});
