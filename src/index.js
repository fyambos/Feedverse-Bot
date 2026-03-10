require('dotenv').config();

const {
  Client,
  Collection,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
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

function safeCustomIdPart(value) {
  if (typeof value !== 'string') return '-';
  const v = value.trim();
  if (!v) return '-';
  if (v.length > 40) return '-';
  // Keep customId simple and parseable.
  if (!/^[A-Za-z0-9_]+$/.test(v)) return '-';
  return v;
}

function decodeCustomIdPart(part) {
  if (typeof part !== 'string') return null;
  return part === '-' ? null : part;
}

function formatUniverseLabel(au, universeId) {
  if (!universeId) return 'none';
  const u = au && au.universeById ? au.universeById.get(universeId) : null;
  if (!u) return universeId;
  const emoji = typeof u.emoji === 'string' && u.emoji.trim() ? u.emoji.trim() + ' ' : '';
  const label = typeof u.label === 'string' && u.label.trim() ? u.label.trim() : universeId;
  return emoji + label;
}

function formatDynamicLabel(au, dynamicId) {
  if (!dynamicId) return 'none';
  const d = au && au.dynamicById ? au.dynamicById.get(dynamicId) : null;
  if (!d) return dynamicId;
  const emoji = typeof d.emoji === 'string' && d.emoji.trim() ? d.emoji.trim() + ' ' : '';
  const label = typeof d.label === 'string' && d.label.trim() ? d.label.trim() : dynamicId;
  return emoji + label;
}

function buildGenerateMetaEmbed(au, universeId, dynamicId) {
  const hasUniverse = typeof universeId === 'string' && universeId.trim() !== '';
  const hasDynamic = typeof dynamicId === 'string' && dynamicId.trim() !== '';
  if (!hasUniverse && !hasDynamic) return null;

  const fields = [];
  if (hasUniverse) fields.push({ name: 'Universe', value: formatUniverseLabel(au, universeId), inline: true });
  if (hasDynamic) fields.push({ name: 'Dynamic', value: formatDynamicLabel(au, dynamicId), inline: true });

  // No title; keep this as purely metadata.
  return new EmbedBuilder().addFields(fields);
}

function buildGenerateComponents({ ownerUserId, universeId, dynamicId }) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        'gen:spin:' +
          String(ownerUserId) +
          ':' +
          safeCustomIdPart(universeId) +
          ':' +
          safeCustomIdPart(dynamicId)
      )
      .setLabel('Spin again')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(
        'gen:remix:' +
          String(ownerUserId) +
          ':' +
          safeCustomIdPart(universeId) +
          ':' +
          safeCustomIdPart(dynamicId)
      )
      .setLabel('Remix')
      .setStyle(ButtonStyle.Primary)
  );
  return [row];
}

function buildRemixChoiceComponents({ ownerUserId, universeId, dynamicId }) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        'gen:remixpick:' +
          String(ownerUserId) +
          ':dynamic:' +
          safeCustomIdPart(universeId) +
          ':' +
          safeCustomIdPart(dynamicId)
      )
      .setLabel('Swap dynamic')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(
        'gen:remixpick:' +
          String(ownerUserId) +
          ':universe:' +
          safeCustomIdPart(universeId) +
          ':' +
          safeCustomIdPart(dynamicId)
      )
      .setLabel('Swap universe')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(
        'gen:remixpick:' +
          String(ownerUserId) +
          ':both:' +
          safeCustomIdPart(universeId) +
          ':' +
          safeCustomIdPart(dynamicId)
      )
      .setLabel('Swap both')
      .setStyle(ButtonStyle.Primary)
  );
  return [row];
}

function extractPreviousPromptFromMessage(msg) {
  try {
    if (msg && Array.isArray(msg.embeds) && msg.embeds.length > 0) {
      const e = msg.embeds[0];
      const desc = e && typeof e.description === 'string' ? e.description : '';
      if (desc && desc.trim()) return desc.trim();
    }
  } catch {
    // ignore
  }
  const content = msg && typeof msg.content === 'string' ? msg.content : '';
  return content && content.trim() ? content.trim() : null;
}

function pickSummaryNotEqual(pack, previous) {
  if (!pack) return null;
  const prev = typeof previous === 'string' ? previous.trim() : '';
  let out = null;
  for (let i = 0; i < 7; i++) {
    const s = pickSummary(pack);
    if (!s) continue;
    if (!prev) return s;
    if (s.trim() !== prev) return s;
    out = s;
  }
  return out;
}

function pickAlternateDynamicId(au, packs, universeId, currentDynamicId) {
  // Prefer choosing among dynamics that actually exist for the selected universe.
  const current = typeof currentDynamicId === 'string' ? currentDynamicId : null;

  const available = new Set();
  for (const p of Array.isArray(packs) ? packs : []) {
    if (!p || typeof p !== 'object') continue;
    if (universeId && p.universeId !== universeId) continue;
    if (typeof p.dynamicId !== 'string' || !p.dynamicId) continue;
    available.add(p.dynamicId);
  }

  const candidates = Array.from(available).filter((id) => (current ? id !== current : true));
  if (candidates.length > 0) return choice(candidates);

  const all = Array.isArray(au && au.dynamics) ? au.dynamics.map((d) => (d ? d.id : null)).filter(Boolean) : [];
  const fallback = all.filter((id) => (current ? id !== current : true));
  if (fallback.length === 0) return current;
  return choice(fallback);
}

function pickAlternateUniverseId(au, packs, dynamicId, currentUniverseId) {
  const current = typeof currentUniverseId === 'string' ? currentUniverseId : null;

  const available = new Set();
  for (const p of Array.isArray(packs) ? packs : []) {
    if (!p || typeof p !== 'object') continue;
    if (dynamicId && p.dynamicId !== dynamicId) continue;
    if (typeof p.universeId !== 'string' || !p.universeId) continue;
    available.add(p.universeId);
  }

  const candidates = Array.from(available).filter((id) => (current ? id !== current : true));
  if (candidates.length > 0) return choice(candidates);

  const all = Array.isArray(au && au.universes) ? au.universes.map((u) => (u ? u.id : null)).filter(Boolean) : [];
  const fallback = all.filter((id) => (current ? id !== current : true));
  if (fallback.length === 0) return current;
  return choice(fallback);
}

function pickAlternateUniverseAndDynamic(au, packs, universeId, dynamicId) {
  const u = typeof universeId === 'string' ? universeId : null;
  const d = typeof dynamicId === 'string' ? dynamicId : null;

  const candidates = (Array.isArray(packs) ? packs : []).filter((p) => {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.universeId !== 'string' || typeof p.dynamicId !== 'string') return false;
    // Exclude the exact same combo (if one/both are null, this still excludes only when equal).
    if (u && d) return !(p.universeId === u && p.dynamicId === d);
    if (u) return p.universeId !== u;
    if (d) return p.dynamicId !== d;
    return true;
  });

  const picked = choice(candidates.length ? candidates : packs);
  if (!picked) return { universeId: u, dynamicId: d };
  return {
    universeId: typeof picked.universeId === 'string' ? picked.universeId : u,
    dynamicId: typeof picked.dynamicId === 'string' ? picked.dynamicId : d
  };
}

function normalizeInviteCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(code)) return null;
  return code;
}

function buildJoinLink(inviteCode) {
  const tpl = normalizeOption(process.env.FEEDVERSE_JOIN_URL_TEMPLATE);
  if (tpl) {
    if (!tpl.includes('{CODE}')) return null;
    return tpl.replaceAll('{CODE}', encodeURIComponent(inviteCode));
  }

  const webBase = normalizeOption(process.env.FEEDVERSE_WEB_BASE_URL);
  if (!webBase) return null;
  const base = webBase.endsWith('/') ? webBase.slice(0, -1) : webBase;
  return base + '/join/' + encodeURIComponent(inviteCode);
}

function getBrandIconUrl() {
  const explicit = normalizeOption(process.env.FEEDVERSE_BRAND_ICON_URL);
  if (explicit) return explicit;

  const webBase = normalizeOption(process.env.FEEDVERSE_WEB_BASE_URL);
  if (webBase) {
    const base = webBase.endsWith('/') ? webBase.slice(0, -1) : webBase;
    return base + '/feedverse-icon-full.png';
  }

  return 'https://feedverse.app/feedverse-icon-full.png';
}

function formatMode(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!v) return null;
  if (v === 'story') return 'Story';
  if (v === 'campaign') return 'Campaign';
  return v[0].toUpperCase() + v.slice(1);
}

function formatPlayers(scenario) {
  const count = Number(scenario && scenario.player_count);
  const capRaw = scenario && scenario.player_cap;
  const cap = capRaw == null ? null : Number(capRaw);

  if (!Number.isFinite(count) || count < 0) return null;
  if (cap == null) return String(count) + '/∞';
  if (!Number.isFinite(cap) || cap <= 0) return String(count);
  return String(count) + '/' + String(cap);
}

function formatTags(scenario) {
  const raw = scenario && scenario.tags;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const names = raw
    .map((t) => (t && typeof t.name === 'string' ? t.name.trim() : ''))
    .filter(Boolean);
  if (names.length === 0) return null;

  const MAX = 8;
  const shown = names.slice(0, MAX);
  const more = names.length - shown.length;
  return shown.join(' • ') + (more > 0 ? ' • +' + String(more) : '');
}

async function fetchJson(url) {
  const hasFetch = typeof globalThis.fetch === 'function';
  if (hasFetch) {
    const res = await globalThis.fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  }

  const https = require('node:https');
  return await new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' }
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text: body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function resolveScenarioByInviteCode(inviteCode) {
  const base = normalizeOption(process.env.FEEDVERSE_API_BASE_URL);
  if (!base) return { ok: true, status: 0, scenario: null };

  const baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
  const url = baseUrl + '/v1/scenarios/resolve?inviteCode=' + encodeURIComponent(inviteCode);
  const res = await fetchJson(url);

  if (res.status === 404) return { ok: true, status: 404, scenario: null };
  if (!res.ok) {
    const msg =
      res.json && typeof res.json.error === 'string'
        ? res.json.error
        : res.text && String(res.text).trim()
          ? String(res.text).slice(0, 300)
          : 'Resolve failed (HTTP ' + String(res.status) + ')';
    return { ok: false, status: Number(res.status || 0), scenario: null, error: msg };
  }

  const scenario = res.json && res.json.scenario ? res.json.scenario : null;
  if (!scenario || typeof scenario !== 'object') {
    return { ok: false, status: Number(res.status || 0), scenario: null, error: 'Invalid API response' };
  }

  return { ok: true, status: Number(res.status || 200), scenario };
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

      if (interaction.isButton()) {
        const id = String(interaction.customId || '');
        if (!id.startsWith('gen:')) return;

        const parts = id.split(':');
        const action = parts[1] || '';
        const ownerUserId = parts[2] || '';

        // gen:spin:<owner>:<universe>:<dynamic>
        // gen:remix:<owner>:<universe>:<dynamic>
        // gen:remixpick:<owner>:<mode>:<universe>:<dynamic>
        const remixMode = action === 'remixpick' ? (parts[3] || '') : '';
        const universeId = decodeCustomIdPart((action === 'remixpick' ? parts[4] : parts[3]) || '-');
        const dynamicId = decodeCustomIdPart((action === 'remixpick' ? parts[5] : parts[4]) || '-');

        if (ownerUserId && String(interaction.user.id) !== String(ownerUserId)) {
          await interaction.reply({
            content: 'Run /generate to get your own remix buttons.',
            ephemeral: true
          });
          return;
        }

        if (action === 'remix') {
          const components = buildRemixChoiceComponents({
            ownerUserId: interaction.user.id,
            universeId,
            dynamicId
          });

          await interaction.reply({
            content: 'What do you want to swap?',
            ephemeral: true,
            components
          });
          return;
        }

        let nextUniverseId = universeId;
        let nextDynamicId = dynamicId;

        if (action === 'remixpick') {
          if (remixMode === 'dynamic') {
            nextDynamicId = pickAlternateDynamicId(au, au.packs, nextUniverseId, nextDynamicId);
          } else if (remixMode === 'universe') {
            nextUniverseId = pickAlternateUniverseId(au, au.packs, nextDynamicId, nextUniverseId);
          } else {
            const out = pickAlternateUniverseAndDynamic(au, au.packs, nextUniverseId, nextDynamicId);
            nextUniverseId = out.universeId;
            nextDynamicId = out.dynamicId;
          }
        }

        const matching = filterPacks(au.packs, nextUniverseId, nextDynamicId);
        const pickedPack = choice(matching);
        if (!pickedPack) {
          await interaction.reply({
            content: 'No prompts found for that filter.',
            ephemeral: true
          });
          return;
        }

        const prev = action === 'spin' ? extractPreviousPromptFromMessage(interaction.message) : null;
        const summary = pickSummaryNotEqual(pickedPack, prev);
        if (!summary) {
          await interaction.reply({
            content: 'Found a matching pack, but it has no usable summaries.',
            ephemeral: true
          });
          return;
        }

        const embed = buildGenerateMetaEmbed(au, nextUniverseId, nextDynamicId);

        const components = buildGenerateComponents({
          ownerUserId: interaction.user.id,
          universeId: nextUniverseId,
          dynamicId: nextDynamicId
        });

        if (action === 'spin') {
          await interaction.update({
            content: summary,
            embeds: embed ? [embed] : [],
            components
          });
          return;
        }

        // Remix always posts a new message (keeps the original prompt intact).
        await interaction.reply({
          content: summary,
          embeds: embed ? [embed] : [],
          components
        });
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === 'generate') {
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
        const embed = buildGenerateMetaEmbed(au, universeId, dynamicId);

        const components = buildGenerateComponents({
          ownerUserId: interaction.user.id,
          universeId,
          dynamicId
        });

        await interaction.reply({
          content: summary,
          embeds: embed ? [embed] : [],
          components
        });
        return;
      }

      if (interaction.commandName === 'drop') {
        const rawCode = interaction.options.getString('invite_code');
        const code = normalizeInviteCode(rawCode || '');
        if (!code) {
          await interaction.reply({
            content: 'Invalid invite code. Use 6–20 chars: A–Z and 0–9 (example: KPOP2024).',
            ephemeral: true
          });
          return;
        }

        const joinLink = buildJoinLink(code);
        const brandIcon = getBrandIconUrl();

        const resolved = await resolveScenarioByInviteCode(code);
        if (resolved.ok && resolved.status === 0) {
          const embed = new EmbedBuilder().setTitle('Feedverse').setThumbnail(brandIcon);
          embed.addFields([{ name: 'Invite code', value: code, inline: true }]);

          const components = [];
          if (joinLink) {
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel('Join')
                .setURL(joinLink)
            );
            components.push(row);
          }

          await interaction.reply({ embeds: [embed], components });
          return;
        }
        if (resolved.ok && resolved.status === 404) {
          await interaction.reply({
            content: 'Unknown invite code: ' + code,
            ephemeral: true
          });
          return;
        }

        if (!resolved.ok) {
          await interaction.reply({
            content: resolved.error ? 'Error: ' + resolved.error : 'Error: could not resolve invite code.',
            ephemeral: true
          });
          return;
        }

        const scenario = resolved.scenario;
        const name = scenario && typeof scenario.name === 'string' ? scenario.name : 'Feedverse scenario';
        const cover = scenario && typeof scenario.cover === 'string' ? scenario.cover : '';
        const description = scenario && typeof scenario.description === 'string' ? scenario.description : '';

        const players = formatPlayers(scenario);
        const mode = formatMode(scenario && scenario.mode);
        const tags = formatTags(scenario);

        const embed = new EmbedBuilder().setTitle(name).setThumbnail(brandIcon);
        if (description) embed.setDescription(description.slice(0, 300));
        if (cover) embed.setImage(cover);

        const fields = [{ name: 'Invite code', value: code, inline: true }];
        if (players) fields.push({ name: 'Players', value: players, inline: true });
        if (mode) fields.push({ name: 'Mode', value: mode, inline: true });
        if (tags) fields.push({ name: 'Tags', value: tags, inline: false });
        embed.addFields(fields);

        const components = [];
        if (joinLink) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setLabel('Join')
              .setURL(joinLink)
          );
          components.push(row);
        }

        await interaction.reply({ embeds: [embed], components });
        return;
      }
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
