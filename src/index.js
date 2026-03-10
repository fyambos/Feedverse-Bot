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
  PermissionFlagsBits,
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

const { buildGlobalCommands, buildOfficialGuildCommands } = require('./commands');

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

const UUID_LIKE_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractUuidLike(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(UUID_LIKE_REGEX);
  return m && m[0] ? String(m[0]).trim() : null;
}

function isHexPrefix(text) {
  return typeof text === 'string' && /^[0-9a-f]{6,32}$/i.test(text.trim());
}

function shortSubmissionId(id) {
  if (typeof id !== 'string') return '';
  const v = id.trim();
  return v.length >= 8 ? v.slice(0, 8) : v;
}

async function resolveSubmissionIdFromInput(inputRaw) {
  const raw = typeof inputRaw === 'string' ? inputRaw.trim() : '';
  if (!raw) return { ok: false, error: 'submission_id is required.' };

  // If the user pasted a whole line from /prompt-queue, extract the UUID.
  const extracted = extractUuidLike(raw);
  if (extracted) return { ok: true, id: extracted };

  // Allow using the queue index (1..N) for convenience.
  if (/^\d{1,2}$/.test(raw)) {
    const idx = Number(raw);
    if (!Number.isFinite(idx) || idx <= 0) return { ok: false, error: 'Invalid submission id.' };
    const q = await botApiGetJson('/v1/au/prompt-submissions?status=pending&limit=50');
    if (!q.ok) return { ok: false, error: 'Error loading queue: ' + q.error };
    const items = q.json && Array.isArray(q.json.items) ? q.json.items : [];
    if (idx > items.length) return { ok: false, error: 'Queue index out of range (1..' + String(items.length) + ').' };
    const item = items[idx - 1];
    const id = item && item.id ? String(item.id).trim() : '';
    if (!id) return { ok: false, error: 'Invalid queue item id.' };
    return { ok: true, id };
  }

  // Allow using a short hex prefix (e.g. first 8 chars).
  if (isHexPrefix(raw)) {
    const id = raw.toLowerCase();
    const q = await botApiGetJson('/v1/au/prompt-submissions?status=pending&limit=50');
    if (!q.ok) return { ok: false, error: 'Error loading queue: ' + q.error };
    const items = q.json && Array.isArray(q.json.items) ? q.json.items : [];
    const matches = items
      .map((it) => (it && it.id ? String(it.id).trim() : ''))
      .filter((fullId) => fullId && fullId.toLowerCase().startsWith(id));
    if (matches.length === 1) return { ok: true, id: matches[0] };
    if (matches.length === 0) return { ok: false, error: 'No pending submission matches that id.' };
    return { ok: false, error: 'That id matches multiple submissions; paste the full UUID.' };
  }

  return { ok: false, error: 'Invalid submission id. Use the id from /prompt-queue.' };
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

async function fetchJsonWithInit(url, init) {
  const hasFetch = typeof globalThis.fetch === 'function';
  const method = (init && init.method ? String(init.method) : 'GET').toUpperCase();
  const headers = (init && init.headers && typeof init.headers === 'object') ? init.headers : {};
  const body = init && init.body !== undefined ? init.body : undefined;

  if (hasFetch) {
    const res = await globalThis.fetch(url, {
      method,
      headers,
      body
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
        method,
        headers
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (out += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = out ? JSON.parse(out) : null;
          } catch {
            json = null;
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text: out });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
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

function botApiBaseUrl() {
  const base = normalizeOption(process.env.FEEDVERSE_API_BASE_URL);
  if (!base) return null;
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function botApiSecret() {
  const v = normalizeOption(process.env.FEEDVERSE_BOT_API_SECRET);
  return v || null;
}

function formatBackendError(res) {
  const baseMsg =
    res.json && typeof res.json.error === 'string'
      ? String(res.json.error)
      : res.text && String(res.text).trim()
        ? String(res.text).slice(0, 300)
        : 'Request failed (HTTP ' + String(res.status) + ')';

  const issues =
    res.json &&
    res.json.details &&
    Array.isArray(res.json.details.issues)
      ? res.json.details.issues
      : null;

  if (!issues || issues.length === 0) return baseMsg;

  const first = issues[0];
  const path = first && typeof first.path === 'string' && first.path.trim() ? first.path.trim() : '';
  const message = first && typeof first.message === 'string' && first.message.trim() ? first.message.trim() : '';
  const detail = message ? (path ? path + ': ' + message : message) : '';
  return detail ? baseMsg + ' (' + detail + ')' : baseMsg;
}

async function botApiPostJson(path, bodyObj) {
  const base = botApiBaseUrl();
  const secret = botApiSecret();
  if (!base) return { ok: false, status: 0, error: 'FEEDVERSE_API_BASE_URL is not set' };
  if (!secret) return { ok: false, status: 0, error: 'Bot API secret is not set' };

  const url = base + path;
  const res = await fetchJsonWithInit(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'content-type': 'application/json',
      'x-bot-secret': secret
    },
    body: JSON.stringify(bodyObj || {})
  });

  if (!res.ok) {
    const msg = formatBackendError(res);
    return { ok: false, status: Number(res.status || 0), error: msg };
  }

  return { ok: true, status: Number(res.status || 200), json: res.json };
}

async function botApiGetJson(pathWithQuery) {
  const base = botApiBaseUrl();
  const secret = botApiSecret();
  if (!base) return { ok: false, status: 0, error: 'FEEDVERSE_API_BASE_URL is not set' };
  if (!secret) return { ok: false, status: 0, error: 'Bot API secret is not set' };

  const url = base + pathWithQuery;
  const res = await fetchJsonWithInit(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'x-bot-secret': secret
    }
  });

  if (!res.ok) {
    const msg = formatBackendError(res);
    return { ok: false, status: Number(res.status || 0), error: msg };
  }

  return { ok: true, status: Number(res.status || 200), json: res.json };
}

async function tryDmSubmitter(client, submission, statusLabel, modNote) {
  try {
    const submitterId = submission && submission.submitterDiscordUserId ? String(submission.submitterDiscordUserId) : '';
    if (!submitterId) return false;

    const settingId = submission && submission.settingId ? String(submission.settingId) : '';
    const dynamicId = submission && submission.dynamicId ? String(submission.dynamicId) : '';
    const promptText = submission && submission.promptText ? String(submission.promptText) : '';

    const user = await client.users.fetch(submitterId);
    if (!user) return false;

    const lines = [];
    lines.push('Your AU prompt submission was ' + statusLabel + '.');
    if (settingId || dynamicId) {
      lines.push('');
      lines.push('Setting: ' + formatUniverseLabel(globalThis.__auDataForDM, settingId));
      lines.push('Dynamic: ' + formatDynamicLabel(globalThis.__auDataForDM, dynamicId));
    }
    if (promptText) {
      lines.push('');
      lines.push(promptText.length > 800 ? promptText.slice(0, 797) + '…' : promptText);
    }
    if (modNote) {
      lines.push('');
      lines.push('Moderator note: ' + String(modNote).slice(0, 800));
    }

    await user.send({ content: lines.join('\n') });
    return true;
  } catch {
    return false;
  }
}

function toAutocompleteChoices(items, query, limit) {
  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? items.filter((x) => x && typeof x.name === 'string' && x.name.toLowerCase().includes(q))
    : items;

  const sorted = filtered.sort((x, y) => x.name.localeCompare(y.name));
  return sorted.slice(0, limit);
}

async function registerCommands(token, clientId, devGuildId, officialGuildId, globalCommands, officialGuildCommands) {
  const rest = new REST({ version: '10' }).setToken(token);

  const globalBody = (globalCommands || []).map((c) => c.toJSON());
  const officialBody = (officialGuildCommands || []).map((c) => c.toJSON());

  // Dev override: register everything to a single guild for fast iteration.
  if (devGuildId) {
    const body = [...globalBody, ...officialBody];
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body });
    return;
  }

  // Prod behavior:
  // - Global: public commands that can be used anywhere (including DMs).
  // - Official guild: moderation commands ONLY.
  await rest.put(Routes.applicationCommands(clientId), { body: globalBody });
  if (officialGuildId && officialBody.length > 0) {
    await rest.put(Routes.applicationGuildCommands(clientId, officialGuildId), { body: officialBody });
  }
}

async function main() {
  const token = requireEnv('DISCORD_TOKEN');
  const clientId = requireEnv('DISCORD_CLIENT_ID');
  const devGuildId = normalizeOption(process.env.DISCORD_GUILD_ID);
  const officialGuildId = normalizeOption(process.env.OFFICIAL_GUILD_ID);

  const auPath = resolveAuDataPath();
  const au = loadAuData(auPath);
  // Store for DM formatting helper (avoids threading au everywhere).
  globalThis.__auDataForDM = au;

  const globalCommands = buildGlobalCommands();
  const officialGuildCommands = buildOfficialGuildCommands();
  await registerCommands(token, clientId, devGuildId, officialGuildId, globalCommands, officialGuildCommands);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.commands = new Collection();
  for (const cmd of [...globalCommands, ...officialGuildCommands]) {
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

        if (focused.name === 'universe' || focused.name === 'setting') {
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

      if (interaction.commandName === 'prompt') {
        const settingId = normalizeOption(interaction.options.getString('setting'));
        const dynamicId = normalizeOption(interaction.options.getString('dynamic'));
        const promptText = String(interaction.options.getString('prompt') || '').trim();

        if (!settingId || !au.universeById || !au.universeById.has(settingId)) {
          await interaction.reply({
            content: 'Unknown setting. Use the autocomplete picker.',
            ephemeral: interaction.inGuild()
          });
          return;
        }

        if (!dynamicId || !au.dynamicById || !au.dynamicById.has(dynamicId)) {
          await interaction.reply({
            content: 'Unknown dynamic. Use the autocomplete picker.',
            ephemeral: interaction.inGuild()
          });
          return;
        }

        if (!promptText) {
          await interaction.reply({
            content: 'Prompt text is required.',
            ephemeral: interaction.inGuild()
          });
          return;
        }

        if (promptText.length > 2000) {
          await interaction.reply({
            content: 'Prompt is too long (max 2000 chars).',
            ephemeral: interaction.inGuild()
          });
          return;
        }

        const submitter = interaction.user;
        const submitterName = submitter && typeof submitter.tag === 'string' ? submitter.tag : submitter.username;

        const res = await botApiPostJson('/v1/au/prompt-submissions', {
          settingId,
          dynamicId,
          promptText,
          submitterDiscordUserId: String(submitter.id),
          submitterDiscordUsername: String(submitterName || ''),
          sourceGuildId: interaction.guildId ? String(interaction.guildId) : null,
          sourceChannelId: interaction.channelId ? String(interaction.channelId) : null,
          sourceMessageId: null
        });

        if (!res.ok) {
          await interaction.reply({
            content: 'Error submitting prompt: ' + res.error,
            ephemeral: interaction.inGuild()
          });
          return;
        }

        const sub = res.json && res.json.submission ? res.json.submission : null;
        const id = sub && sub.id ? String(sub.id) : '(unknown id)';

        await interaction.reply({
          content: 'Submitted for review. id: ' + id,
          ephemeral: interaction.inGuild()
        });
        return;
      }

      if (interaction.commandName === 'share') {
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

      if (
        interaction.commandName === 'prompt-queue' ||
        interaction.commandName === 'prompt-approve' ||
        interaction.commandName === 'prompt-reject'
      ) {
        const officialGuild = normalizeOption(process.env.OFFICIAL_GUILD_ID);
        if (!officialGuild || String(interaction.guildId || '') !== String(officialGuild)) {
          await interaction.reply({ content: 'This command can only be used in the official guild.', ephemeral: true });
          return;
        }

        const perms = interaction.memberPermissions;
        const allowed =
          perms &&
          (perms.has(PermissionFlagsBits.Administrator) ||
            perms.has(PermissionFlagsBits.ManageMessages) ||
            perms.has(PermissionFlagsBits.BanMembers));
        if (!allowed) {
          await interaction.reply({ content: 'Not allowed.', ephemeral: true });
          return;
        }

        if (interaction.commandName === 'prompt-queue') {
          const q = await botApiGetJson('/v1/au/prompt-submissions?status=pending&limit=15');
          if (!q.ok) {
            await interaction.reply({ content: 'Error: ' + q.error, ephemeral: true });
            return;
          }

          const items = q.json && Array.isArray(q.json.items) ? q.json.items : [];
          if (items.length === 0) {
            await interaction.reply({ content: 'No pending submissions.', ephemeral: true });
            return;
          }

          const lines = [];
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const id = it && it.id ? String(it.id) : '';
            const settingId = it && it.settingId ? String(it.settingId) : '';
            const dynamicId = it && it.dynamicId ? String(it.dynamicId) : '';
            const promptText = it && it.promptText ? String(it.promptText) : '';
            const submitterName = it && it.submitterDiscordUsername ? String(it.submitterDiscordUsername) : '';
            const settingLabel = formatUniverseLabel(au, settingId);
            const dynamicLabel = formatDynamicLabel(au, dynamicId);
            const snippet = promptText.length > 180 ? promptText.slice(0, 177) + '…' : promptText;
            const shortId = shortSubmissionId(id);
            lines.push('#' + String(i + 1) + ' ' + shortId + ' — ' + settingLabel + ' + ' + dynamicLabel + (submitterName ? ' — by ' + submitterName : ''));
            lines.push(snippet);
            lines.push('');
          }

          await interaction.reply({
            content: lines.join('\n').trim(),
            ephemeral: true
          });
          return;
        }

        if (interaction.commandName === 'prompt-approve') {
          const submissionIdRaw = String(interaction.options.getString('submission_id') || '').trim();
          const note = normalizeOption(interaction.options.getString('note'));
          const resolvedId = await resolveSubmissionIdFromInput(submissionIdRaw);
          if (!resolvedId.ok) {
            await interaction.reply({ content: resolvedId.error, ephemeral: true });
            return;
          }
          const submissionId = resolvedId.id;

          const mod = interaction.user;
          const modName = mod && typeof mod.tag === 'string' ? mod.tag : mod.username;

          const r = await botApiPostJson(
            '/v1/au/prompt-submissions/' + encodeURIComponent(submissionId) + '/approve',
            {
              moderatorDiscordUserId: String(mod.id),
              moderatorDiscordUsername: String(modName || ''),
              note: note || null
            }
          );
          if (!r.ok) {
            await interaction.reply({ content: 'Error: ' + r.error, ephemeral: true });
            return;
          }

          const promptId = r.json && r.json.promptId ? String(r.json.promptId) : null;
          const submission = r.json && r.json.submission ? r.json.submission : null;
          await tryDmSubmitter(client, submission, 'approved', note);
          await interaction.reply({ content: 'Approved. ' + (promptId ? 'prompt id: ' + promptId : ''), ephemeral: true });
          return;
        }

        if (interaction.commandName === 'prompt-reject') {
          const submissionIdRaw = String(interaction.options.getString('submission_id') || '').trim();
          const note = normalizeOption(interaction.options.getString('note'));
          const resolvedId = await resolveSubmissionIdFromInput(submissionIdRaw);
          if (!resolvedId.ok) {
            await interaction.reply({ content: resolvedId.error, ephemeral: true });
            return;
          }
          const submissionId = resolvedId.id;

          const mod = interaction.user;
          const modName = mod && typeof mod.tag === 'string' ? mod.tag : mod.username;

          const r = await botApiPostJson(
            '/v1/au/prompt-submissions/' + encodeURIComponent(submissionId) + '/reject',
            {
              moderatorDiscordUserId: String(mod.id),
              moderatorDiscordUsername: String(modName || ''),
              note: note || null
            }
          );
          if (!r.ok) {
            await interaction.reply({ content: 'Error: ' + r.error, ephemeral: true });
            return;
          }

          const submission = r.json && r.json.submission ? r.json.submission : null;
          await tryDmSubmitter(client, submission, 'rejected', note);
          await interaction.reply({ content: 'Rejected.', ephemeral: true });
          return;
        }
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
