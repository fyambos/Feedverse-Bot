require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createHash } = require('node:crypto');
const http = require('node:http');

const {
  Client,
  Collection,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  REST,
  Routes
} = require('discord.js');

let sharp = null;
try {
  // Optional at runtime: if native bindings fail on a host, keep the bot online.
  // Moodboards will gracefully fall back to single-image renders.
  sharp = require('sharp');
} catch (e) {
  sharp = null;
  process.stderr.write('Warning: sharp failed to load; moodboards will not render as collages.\n');
}

function startOptionalHealthServer() {
  const rawPort = process.env.PORT;
  const port = rawPort != null ? Number(rawPort) : NaN;
  if (!Number.isFinite(port) || port <= 0) return;

  const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('ok');
  });

  server.listen(port, () => {
    process.stdout.write('Health server listening on :' + String(port) + '\n');
  });
}

const {
  loadAuData,
  resolveAuDataPath,
  choice,
  filterPacks,
  pickSummary
} = require('./auData');

const {
  loadTriviaData,
  resolveTriviaDataPath
} = require('./triviaData');

const { buildGlobalCommands, buildOfficialGuildCommands } = require('./commands');

function requireEnv(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error('Missing required env var: ' + name);
  }
  return v.trim();
}

function buildClientIntents(includeMessageContent) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  if (includeMessageContent) intents.push(GatewayIntentBits.MessageContent);
  return intents;
}

function isDisallowedIntentsError(err) {
  if (!err) return false;

  const code = Number(err.code ?? err.closeCode ?? err.status ?? 0);
  if (code === 4014) return true;

  const message = String(err.message || err).toLowerCase();
  return message.includes('disallowed intents');
}

function normalizeOption(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v;
}

function mergeEphemeralFlag(flags) {
  if (flags == null) return MessageFlags.Ephemeral;
  if (typeof flags === 'number') return flags | MessageFlags.Ephemeral;
  if (typeof flags === 'bigint') return flags | BigInt(MessageFlags.Ephemeral);
  return flags;
}

function normalizeInteractionResponseOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  if (!Object.prototype.hasOwnProperty.call(options, 'ephemeral')) return options;

  const normalized = { ...options };
  const ephemeral = Boolean(normalized.ephemeral);
  delete normalized.ephemeral;

  if (ephemeral) normalized.flags = mergeEphemeralFlag(normalized.flags);
  return normalized;
}

function installInteractionResponseCompat(interaction) {
  const methods = ['reply', 'followUp', 'deferReply'];
  for (const method of methods) {
    if (typeof interaction?.[method] !== 'function') continue;
    const original = interaction[method].bind(interaction);
    interaction[method] = (options) => original(normalizeInteractionResponseOptions(options));
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDateKey(d) {
  const dt = d instanceof Date ? d : new Date();
  return String(dt.getFullYear()) + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
}

function localMinutesOfDay(d) {
  const dt = d instanceof Date ? d : new Date();
  return dt.getHours() * 60 + dt.getMinutes();
}

const SUPPORTED_IANA_TIME_ZONES =
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone').filter((value) => typeof value === 'string' && value)
    : [];

function isValidTimeZone(tz) {
  if (typeof tz !== 'string') return false;
  const v = tz.trim();
  if (!v) return false;
  try {
    // Throws RangeError on invalid IANA timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: v }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function timeZoneDateKeyAndMinutes(d, timeZone) {
  const dt = d instanceof Date ? d : new Date();
  if (typeof timeZone !== 'string') return null;
  const normalizedTimeZone = timeZone.trim();
  if (!isValidTimeZone(normalizedTimeZone)) return null;

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizedTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  });

  const parts = fmt.formatToParts(dt);
  const map = {};
  for (const p of parts) {
    if (p && p.type && p.type !== 'literal') map[p.type] = p.value;
  }

  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  let hour = Number(map.hour);
  const minute = Number(map.minute);
  if (![year, month, day, hour, minute].every((n) => Number.isFinite(n))) return null;
  if (hour === 24) hour = 0;

  const dateKey = String(year) + '-' + pad2(month) + '-' + pad2(day);
  const minutes = hour * 60 + minute;
  return { dateKey, minutes };
}

function parseLocalTimeToMinutes(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;

  // 24h: H, HH, H:MM, HH:MM
  let m = v.match(/^([01]?\d|2[0-3])(?::([0-5]\d))?$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = m[2] != null ? Number(m[2]) : 0;
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return hh * 60 + mm;
  }

  // 12h: H(am|pm), H:MM(am|pm), with optional space.
  m = v.match(/^([1-9]|1[0-2])(?::([0-5]\d))?\s*(am|pm)$/i);
  if (m) {
    let hh = Number(m[1]);
    const mm = m[2] != null ? Number(m[2]) : 0;
    const ap = String(m[3] || '').toLowerCase();
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (ap === 'am') {
      if (hh === 12) hh = 0;
    } else if (ap === 'pm') {
      if (hh !== 12) hh += 12;
    } else {
      return null;
    }
    return hh * 60 + mm;
  }

  return null;
}

function normalizeSubmittedPromptText(raw) {
  const input = typeof raw === 'string' ? raw : '';
  if (!input) return '';

  const tokens = [];
  const re = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g;
  let last = 0;
  for (let m = re.exec(input); m; m = re.exec(input)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > last) tokens.push({ kind: 'sep', value: input.slice(last, start) });
    tokens.push({ kind: 'word', value: m[0] });
    last = end;
  }
  if (last < input.length) tokens.push({ kind: 'sep', value: input.slice(last) });

  const isAllCapsWord = (w) => {
    const letters = String(w || '').replace(/[^A-Za-z]/g, '');
    if (!letters) return { ok: false, lettersLen: 0 };
    const ok = letters === letters.toUpperCase() && letters !== letters.toLowerCase();
    return { ok, lettersLen: letters.length };
  };

  const wordIdx = [];
  for (let i = 0; i < tokens.length; i++) if (tokens[i].kind === 'word') wordIdx.push(i);

  for (let k = 0; k < wordIdx.length; k++) {
    const i = wordIdx[k];
    const word = tokens[i].value;

    const cur = isAllCapsWord(word);
    if (!cur.ok) {
      tokens[i].value = String(word).toLowerCase();
      continue;
    }

    // Preserve multi-letter ALLCAPS words always (e.g. LOT).
    // Also preserve single-letter ALLCAPS when it sits next to other ALLCAPS words
    // to avoid breaking phrases like "THIS IS A NIGHTMARE".
    const prevWord = k > 0 ? tokens[wordIdx[k - 1]].value : null;
    const nextWord = k + 1 < wordIdx.length ? tokens[wordIdx[k + 1]].value : null;
    const prevAll = prevWord ? isAllCapsWord(prevWord).ok : false;
    const nextAll = nextWord ? isAllCapsWord(nextWord).ok : false;

    const preserve = cur.lettersLen > 1 || prevAll || nextAll;
    tokens[i].value = preserve ? String(word) : String(word).toLowerCase();
  }

  return tokens.map((t) => t.value).join('');
}

const activeTriviaRounds = new Map();

function normalizeTriviaText(raw) {
  const input = typeof raw === 'string' ? raw : '';
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWithinOneEdit(a, b) {
  if (a === b) return true;
  const left = typeof a === 'string' ? a : '';
  const right = typeof b === 'string' ? b : '';
  const lenA = left.length;
  const lenB = right.length;

  if (Math.abs(lenA - lenB) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;

  while (i < lenA && j < lenB) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) return false;

    if (lenA > lenB) {
      i += 1;
    } else if (lenB > lenA) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }

  if (i < lenA || j < lenB) edits += 1;
  return edits <= 1;
}

function isTriviaAnswerMatch(input, acceptedAnswers) {
  const normalizedGuess = normalizeTriviaText(input);
  if (!normalizedGuess) return false;

  const answers = Array.isArray(acceptedAnswers) ? acceptedAnswers : [];
  for (const answer of answers) {
    const normalizedAnswer = normalizeTriviaText(answer);
    if (!normalizedAnswer) continue;
    if (normalizedGuess === normalizedAnswer) return true;

    const minLen = Math.min(normalizedGuess.length, normalizedAnswer.length);
    if (minLen >= 4 && isWithinOneEdit(normalizedGuess, normalizedAnswer)) return true;
  }

  return false;
}

function shuffleArray(list) {
  const out = Array.isArray(list) ? list.slice() : [];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = out[i];
    out[i] = out[j];
    out[j] = temp;
  }
  return out;
}

function splitTriviaWords(answer) {
  return String(answer || '').trim().split(/\s+/).filter(Boolean);
}

function pigLatinizeWord(word) {
  const clean = String(word || '').replace(/[^A-Za-z]/g, '');
  if (!clean) return String(word || '');

  const lower = clean.toLowerCase();
  const vowelIndex = lower.search(/[aeiou]/);
  if (vowelIndex === 0) return lower + 'yay';
  if (vowelIndex < 0) return lower + 'ay';
  return lower.slice(vowelIndex) + lower.slice(0, vowelIndex) + 'ay';
}

function buildTriviaHintPigLatin(answer) {
  const words = splitTriviaWords(answer);
  if (words.length === 0) return null;
  return 'Pig latin: ' + words.map((word) => pigLatinizeWord(word)).join(' ');
}

function buildTriviaHintLetterStats(answer) {
  const words = splitTriviaWords(answer);
  const lettersOnly = String(answer || '').replace(/[^A-Za-z]/g, '');
  if (!lettersOnly) return null;
  const vowels = (lettersOnly.match(/[aeiou]/gi) || []).length;
  const wordLengths = words
    .map((word) => String(word).replace(/[^A-Za-z0-9]/g, '').length)
    .filter((len) => len > 0);

  return (
    'Length: ' +
    String(lettersOnly.length) +
    ' letters, ' +
    String(vowels) +
    ' vowels, ' +
    String(words.length) +
    ' word' +
    (words.length === 1 ? '' : 's') +
    (wordLengths.length ? ' (' + wordLengths.join('-') + ')' : '')
  );
}

function buildTriviaHintFirstLast(answer) {
  const words = splitTriviaWords(answer);
  if (words.length === 0) return null;

  const masked = words.map((word) => {
    const clean = String(word).replace(/[^A-Za-z0-9]/g, '');
    if (!clean) return word;
    if (clean.length <= 2) return clean;
    return clean[0] + '#'.repeat(Math.max(0, clean.length - 2)) + clean[clean.length - 1];
  });

  return 'First and last letters: ' + masked.join(' / ');
}

function buildTriviaHintMasked(answer) {
  const chars = Array.from(String(answer || ''));
  const revealableIndexes = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (/[A-Za-z0-9]/.test(chars[i])) revealableIndexes.push(i);
  }
  if (revealableIndexes.length === 0) return null;

  const revealCount = Math.max(1, Math.ceil(revealableIndexes.length * 0.3));
  const picked = new Set(shuffleArray(revealableIndexes).slice(0, revealCount));
  const masked = chars.map((char, idx) => {
    if (!/[A-Za-z0-9]/.test(char)) return char;
    return picked.has(idx) ? char : '#';
  }).join('');

  return 'Masked: ' + masked;
}

function buildTriviaHintInitials(answer) {
  const words = splitTriviaWords(answer);
  if (words.length < 2) return null;

  const masked = words.map((word) => {
    const clean = String(word).replace(/[^A-Za-z0-9]/g, '');
    if (!clean) return word;
    return clean[0] + '#'.repeat(Math.max(0, clean.length - 1));
  });

  return 'Initials shape: ' + masked.join(' ');
}

function pickTriviaHints(answer) {
  const candidates = [
    buildTriviaHintPigLatin(answer),
    buildTriviaHintLetterStats(answer),
    buildTriviaHintFirstLast(answer),
    buildTriviaHintMasked(answer),
    buildTriviaHintInitials(answer)
  ]
    .filter((value) => typeof value === 'string' && value.trim() !== '');

  const seen = new Set();
  const unique = [];
  for (const value of candidates) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }

  return shuffleArray(unique).slice(0, 2);
}

function formatTriviaQuestionCount(count) {
  const n = Number.isFinite(Number(count)) ? Number(count) : 0;
  return String(n) + ' question' + (n === 1 ? '' : 's');
}

function buildTriviaCategoryComponents({ ownerUserId, page, totalPages }) {
  const safePage = Math.max(0, Number(page) || 0);
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  if (safeTotalPages <= 1) return [];

  const prevPage = Math.max(0, safePage - 1);
  const nextPage = Math.min(safeTotalPages - 1, safePage + 1);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('trivia:cats:' + String(ownerUserId) + ':' + String(prevPage))
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId('trivia:cats:' + String(ownerUserId) + ':' + String(nextPage))
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= safeTotalPages - 1)
  );

  return [row];
}

function buildTriviaCategoryPageMessage({ categories, ownerUserId, page }) {
  const items = Array.isArray(categories) ? categories : [];
  if (items.length === 0) {
    return {
      content: 'No trivia categories are loaded yet.',
      components: []
    };
  }

  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const visible = items.slice(start, start + PAGE_SIZE);

  const totalQuestions = items.reduce((sum, category) => {
    const questionCount = Array.isArray(category && category.questions) ? category.questions.length : 0;
    return sum + questionCount;
  }, 0);

  const lines = [
    'Available trivia categories',
    '```text',
    'category | questions',
    '-----------------------------------------'
  ];

  for (const category of visible) {
    const label = category && typeof category.label === 'string' ? category.label.trim() : '';
    if (!label) continue;

    const questionCount = Array.isArray(category.questions) ? category.questions.length : 0;
    const line = label + ' | ' + formatTriviaQuestionCount(questionCount);
    lines.push(line);
  }

  lines.push('```');
  lines.push('Categories: **' + String(items.length) + '** | Questions: **' + String(totalQuestions) + '** | Page **' + String(safePage + 1) + '/' + String(totalPages) + '**');

  return {
    content: lines.join('\n'),
    components: buildTriviaCategoryComponents({ ownerUserId, page: safePage, totalPages })
  };
}

const TRIVIA_POINTS_NO_HINT = 4;
const TRIVIA_POINTS_AFTER_FIRST_HINT = 2;
const TRIVIA_POINTS_AFTER_SECOND_HINT = 1;
const TRIVIA_XP_PER_CORRECT_ANSWER = 25;
const TRIVIA_XP_FINAL_WINNER_BONUS = 500;
const TRIVIA_EMBED_COLORS = {
  intro: 0x4f46e5,
  question: 0x2563eb,
  hint: 0xf59e0b,
  reveal: 0x10b981,
  timeout: 0xef4444,
  results: 0x8b5cf6,
};

function buildTriviaBaseEmbed({ title, description, color }) {
  const embed = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp();
  if (description) embed.setDescription(description);

  const icon = getBrandIconUrl();
  if (icon) embed.setThumbnail(icon);
  return embed;
}

function getTriviaPointsForHintsShown(hintsShown) {
  const shown = Number.isFinite(Number(hintsShown)) ? Number(hintsShown) : 0;
  if (shown <= 0) return TRIVIA_POINTS_NO_HINT;
  if (shown === 1) return TRIVIA_POINTS_AFTER_FIRST_HINT;
  return TRIVIA_POINTS_AFTER_SECOND_HINT;
}

function addTriviaCount(map, userId, delta) {
  if (!(map instanceof Map)) return;
  const safeUserId = String(userId || '').trim();
  const safeDelta = Number.isFinite(Number(delta)) ? Number(delta) : 0;
  if (!safeUserId || safeDelta === 0) return;
  map.set(safeUserId, (map.get(safeUserId) || 0) + safeDelta);
}

function getTriviaStandings(round) {
  const scores = round && round.scores instanceof Map ? round.scores : new Map();
  const correctCounts = round && round.correctCounts instanceof Map ? round.correctCounts : new Map();
  const xpAwards = round && round.xpAwards instanceof Map ? round.xpAwards : new Map();
  const userIds = new Set([...scores.keys(), ...correctCounts.keys(), ...xpAwards.keys()]);

  return Array.from(userIds)
    .map((userId) => ({
      userId: String(userId),
      points: Number(scores.get(userId) || 0),
      correctAnswers: Number(correctCounts.get(userId) || 0),
      xpAwarded: Number(xpAwards.get(userId) || 0),
    }))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.correctAnswers !== a.correctAnswers) return b.correctAnswers - a.correctAnswers;
      return a.userId.localeCompare(b.userId);
    });
}

function formatTriviaScores(round) {
  const standings = getTriviaStandings(round);
  if (standings.length === 0) return 'No correct answers this round.';

  return standings
    .map((entry, idx) => {
      const xpPart = entry.xpAwarded > 0 ? ' | +' + String(entry.xpAwarded) + ' XP' : '';
      return (
        String(idx + 1) +
        '. <@' + String(entry.userId) + '> — ' +
        String(entry.points) + ' pts | ' +
        String(entry.correctAnswers) + ' correct' +
        xpPart
      );
    })
    .join('\n');
}

function getTriviaFinalWinners(round) {
  const standings = getTriviaStandings(round);
  if (standings.length === 0) return [];

  const top = standings[0];
  return standings.filter((entry) => entry.points === top.points && entry.correctAnswers === top.correctAnswers);
}

function buildTriviaRoundIntroEmbed(round) {
  return buildTriviaBaseEmbed({
    title: 'Trivia Round Started',
    description: 'Answer in chat. Small typos still count.',
    color: TRIVIA_EMBED_COLORS.intro,
  })
    .addFields(
      { name: 'Category', value: String(round.categoryLabel || 'Unknown'), inline: true },
      { name: 'Questions', value: String(round.questions.length || 0), inline: true },
      {
        name: 'Scoring',
        value:
          '4 points before hints\n' +
          '2 points after hint 1\n' +
          '1 point after hint 2',
        inline: true,
      },
      {
        name: 'XP rewards',
        value:
          '+' + String(TRIVIA_XP_PER_CORRECT_ANSWER) + ' XP per correct answer\n' +
          '+' + String(TRIVIA_XP_FINAL_WINNER_BONUS) + ' XP to the final winner',
        inline: true,
      },
    )
    .setFooter({ text: 'Hints arrive at 25s and 45s. Answer window: 60s.' });
}

function buildTriviaQuestionEmbed(round, state) {
  const questionNumber = Number(round.currentIndex || 0) + 1;
  return buildTriviaBaseEmbed({
    title: 'Question ' + String(questionNumber) + '/' + String(round.questions.length),
    description: String(state.question.prompt || 'No prompt available.'),
    color: TRIVIA_EMBED_COLORS.question,
  })
    .addFields(
      { name: 'Category', value: String(round.categoryLabel || 'Unknown'), inline: true },
      { name: 'Current value', value: String(TRIVIA_POINTS_NO_HINT) + ' points', inline: true },
    )
    .setFooter({ text: 'Answer in chat before the first hint drops.' });
}

function buildTriviaHintEmbed(round, hint, hintIndex) {
  const nextValue = getTriviaPointsForHintsShown(hintIndex + 1);
  return buildTriviaBaseEmbed({
    title: 'Hint ' + String(hintIndex + 1) + '/2',
    description: String(hint || 'No hint available.'),
    color: TRIVIA_EMBED_COLORS.hint,
  }).addFields(
    { name: 'Question', value: String(Number(round.currentIndex || 0) + 1) + '/' + String(round.questions.length), inline: true },
    { name: 'Current value', value: String(nextValue) + ' point' + (nextValue === 1 ? '' : 's'), inline: true },
  );
}

function buildTriviaRevealLine(question) {
  const answer = question && question.canonicalAnswer ? String(question.canonicalAnswer) : 'unknown';
  const explanation = question && question.explanation ? String(question.explanation).trim() : '';
  return { answer, explanation };
}

function buildTriviaResolutionEmbed(round, state, { winnerUser, awardedPoints, awardedXp, isLastQuestion }) {
  const reveal = buildTriviaRevealLine(state.question);
  const standings = formatTriviaScores(round);
  const gotIt = Boolean(winnerUser && winnerUser.id);
  const embed = buildTriviaBaseEmbed({
    title: gotIt ? 'Correct Answer' : 'Time\'s Up',
    description: gotIt
      ? '<@' + String(winnerUser.id) + '> got it and earned ' + String(awardedPoints) + ' point' + (awardedPoints === 1 ? '' : 's') + '.'
      : 'Nobody got this one in time. The answer was **' + reveal.answer + '**.',
    color: gotIt ? TRIVIA_EMBED_COLORS.reveal : TRIVIA_EMBED_COLORS.timeout,
  }).addFields(
    { name: 'Answer', value: reveal.answer, inline: false },
    {
      name: 'Reward',
      value: gotIt
        ? '+' + String(awardedPoints) + ' point' + (awardedPoints === 1 ? '' : 's') + ' | +' + String(awardedXp) + ' XP'
        : 'No points awarded',
      inline: false,
    },
    { name: 'Standings', value: standings.slice(0, 1024), inline: false },
  );

  if (reveal.explanation) {
    embed.addFields({ name: 'Why', value: reveal.explanation.slice(0, 1024), inline: false });
  }

  if (!isLastQuestion) {
    embed.setFooter({ text: 'Next question in 10 seconds.' });
  }

  return embed;
}

function buildTriviaResultsEmbed(round, winnerIds) {
  const standings = formatTriviaScores(round);
  const winners = Array.isArray(winnerIds) ? winnerIds.filter(Boolean).map((id) => '<@' + String(id) + '>') : [];
  const winnerLabel = winners.length === 0
    ? 'No winner'
    : winners.length === 1
      ? winners[0]
      : winners.join(', ');

  return buildTriviaBaseEmbed({
    title: 'Trivia Round Finished',
    description: winners.length <= 1 ? 'Final winner: ' + winnerLabel : 'Co-winners: ' + winnerLabel,
    color: TRIVIA_EMBED_COLORS.results,
  }).addFields(
    { name: 'Category', value: String(round.categoryLabel || 'Unknown'), inline: true },
    { name: 'Questions played', value: String(round.questions.length || 0), inline: true },
    {
      name: 'Winner bonus',
      value: winners.length > 0
        ? '+' + String(TRIVIA_XP_FINAL_WINNER_BONUS) + ' XP awarded'
        : 'No winner bonus awarded',
      inline: true,
    },
    { name: 'Final scores', value: standings.slice(0, 1024), inline: false },
  );
}

async function recordTriviaReward(userId, guildId, { pointsDelta = 0, correctAnswersDelta = 0, roundWinsDelta = 0, xpDelta = 0 } = {}) {
  const safeUserId = String(userId || '').trim();
  const safeGuildId = String(guildId || '').trim();
  const safePointsDelta = Number.isFinite(Number(pointsDelta)) ? Math.max(0, Math.floor(Number(pointsDelta))) : 0;
  const safeCorrectAnswersDelta = Number.isFinite(Number(correctAnswersDelta)) ? Math.max(0, Math.floor(Number(correctAnswersDelta))) : 0;
  const safeRoundWinsDelta = Number.isFinite(Number(roundWinsDelta)) ? Math.max(0, Math.floor(Number(roundWinsDelta))) : 0;
  const safeXpDelta = Number.isFinite(Number(xpDelta)) ? Math.max(0, Math.floor(Number(xpDelta))) : 0;
  if (!safeUserId || !safeGuildId) return { ok: true, skipped: true };
  if (safePointsDelta <= 0 && safeCorrectAnswersDelta <= 0 && safeRoundWinsDelta <= 0 && safeXpDelta <= 0) {
    return { ok: true, skipped: true };
  }

  const result = await botApiPostJsonNoThrow('/v1/au/trivia/stats', {
    userDiscordUserId: safeUserId,
    guildId: safeGuildId,
    pointsDelta: safePointsDelta,
    correctAnswersDelta: safeCorrectAnswersDelta,
    roundWinsDelta: safeRoundWinsDelta,
    xpDelta: safeXpDelta,
  });

  if (!result.ok) {
    process.stderr.write('Trivia stat update failed for ' + safeUserId + ': ' + String(result.error || 'unknown error') + '\n');
  }

  return result;
}

function buildTriviaStatsEmbed({ userId, stats, guildId }) {
  const safe = stats && typeof stats === 'object' ? stats : {};
  const global = safe.global && typeof safe.global === 'object' ? safe.global : {};
  const guild = safe.guild && typeof safe.guild === 'object' ? safe.guild : null;

  const embed = buildTriviaBaseEmbed({
    title: 'Trivia Stats',
    description: '👤 <@' + String(userId) + '>',
    color: TRIVIA_EMBED_COLORS.results,
  }).addFields(
    { name: 'Global points', value: String(Number(global.points ?? 0)), inline: true },
    { name: 'Global wins', value: String(Number(global.roundWins ?? 0)), inline: true },
    { name: 'Global correct', value: String(Number(global.correctAnswers ?? 0)), inline: true },
    { name: 'Trivia XP earned', value: String(Number(global.xpEarned ?? 0)), inline: true },
  );

  if (guildId) {
    embed.addFields({
      name: 'This server',
      value: guild
        ? 'Points: ' + String(Number(guild.points ?? 0)) + '\n' +
          'Wins: ' + String(Number(guild.roundWins ?? 0)) + '\n' +
          'Correct: ' + String(Number(guild.correctAnswers ?? 0)) + '\n' +
          'Trivia XP: ' + String(Number(guild.xpEarned ?? 0))
        : 'No trivia stats for this server yet.',
      inline: false,
    });
  }

  return embed;
}

function clearTriviaQuestionTimers(round) {
  if (!round || !round.currentQuestionState) return;
  const state = round.currentQuestionState;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
  if (Array.isArray(state.hintTimers)) {
    for (const timer of state.hintTimers) clearTimeout(timer);
    state.hintTimers = [];
  }
}

function clearTriviaRoundTimers(round) {
  clearTriviaQuestionTimers(round);
  if (round && round.nextQuestionTimerId) {
    clearTimeout(round.nextQuestionTimerId);
    round.nextQuestionTimerId = null;
  }
}

async function finishTriviaRound(round) {
  if (!round || round.finished) return;
  round.finished = true;
  clearTriviaRoundTimers(round);
  activeTriviaRounds.delete(round.channelId);

  const winners = getTriviaFinalWinners(round);
  for (const winner of winners) {
    addTriviaCount(round.xpAwards, winner.userId, TRIVIA_XP_FINAL_WINNER_BONUS);
    await recordTriviaReward(winner.userId, round.guildId, {
      roundWinsDelta: 1,
      xpDelta: TRIVIA_XP_FINAL_WINNER_BONUS,
    });
  }

  await round.channel.send({ embeds: [buildTriviaResultsEmbed(round, winners.map((winner) => winner.userId))] });
}

async function postTriviaQuestion(round) {
  if (!round || round.finished) return;
  if (activeTriviaRounds.get(round.channelId) !== round) return;

  const question = round.questions[round.currentIndex];
  if (!question) {
    await finishTriviaRound(round);
    return;
  }

  const hints = pickTriviaHints(question.canonicalAnswer);
  const state = {
    question,
    closed: false,
    hintTimers: [],
    timeoutId: null,
    hints,
    hintsShown: 0,
  };
  round.currentQuestionState = state;

  await round.channel.send({ embeds: [buildTriviaQuestionEmbed(round, state)] });

  const hintOffsets = [25 * 1000, 45 * 1000];
  hints.forEach((hint, idx) => {
    const delay = hintOffsets[idx];
    if (!delay) return;
    const timer = setTimeout(() => {
      if (round.finished) return;
      if (round.currentQuestionState !== state || state.closed) return;
      state.hintsShown = Math.max(state.hintsShown, idx + 1);
      round.channel.send({ embeds: [buildTriviaHintEmbed(round, hint, idx)] }).catch((err) => {
        process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
      });
    }, delay);
    state.hintTimers.push(timer);
  });

  state.timeoutId = setTimeout(() => {
    settleTriviaQuestion(round, null).catch((err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    });
  }, 60 * 1000);
}

async function settleTriviaQuestion(round, winnerUser) {
  if (!round || round.finished) return false;
  const state = round.currentQuestionState;
  if (!state || state.closed) return false;

  state.closed = true;
  clearTriviaQuestionTimers(round);
  round.currentQuestionState = null;

  const awardedPoints = winnerUser && winnerUser.id ? getTriviaPointsForHintsShown(state.hintsShown) : 0;
  const awardedXp = winnerUser && winnerUser.id ? TRIVIA_XP_PER_CORRECT_ANSWER : 0;

  if (winnerUser && winnerUser.id) {
    addTriviaCount(round.scores, String(winnerUser.id), awardedPoints);
    addTriviaCount(round.correctCounts, String(winnerUser.id), 1);
    addTriviaCount(round.xpAwards, String(winnerUser.id), awardedXp);
    await recordTriviaReward(String(winnerUser.id), round.guildId, {
      pointsDelta: awardedPoints,
      correctAnswersDelta: 1,
      xpDelta: awardedXp,
    });
  }

  const isLastQuestion = round.currentIndex >= round.questions.length - 1;
  await round.channel.send({
    embeds: [buildTriviaResolutionEmbed(round, state, { winnerUser, awardedPoints, awardedXp, isLastQuestion })],
  });

  if (isLastQuestion) {
    await finishTriviaRound(round);
    return true;
  }

  round.currentIndex += 1;
  round.nextQuestionTimerId = setTimeout(() => {
    round.nextQuestionTimerId = null;
    postTriviaQuestion(round).catch((err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    });
  }, 10 * 1000);

  return true;
}

function formatMinutesAsTime(mins) {
  const m = Number(mins);
  if (!Number.isFinite(m) || m < 0) return null;
  const hh = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return pad2(hh) + ':' + pad2(mm);
}

function makeThreadNameFromPrompt(promptText) {
  const raw = typeof promptText === 'string' ? promptText : '';
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const base = cleaned || 'daily prompt';
  const maxLen = 100;
  if (base.length <= maxLen) return base;
  return base.slice(0, maxLen - 1).trimEnd() + '…';
}

function normalizePromptForKey(promptText) {
  const raw = typeof promptText === 'string' ? promptText : '';
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function computePromptKey({ settingId, dynamicId, promptText }) {
  const s = settingId ? String(settingId).trim() : '';
  const d = dynamicId ? String(dynamicId).trim() : '';
  const p = normalizePromptForKey(promptText);
  return createHash('sha256').update(s + '\n' + d + '\n' + p, 'utf8').digest('hex');
}

function trunc(text, max) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function encodeCursorBase36(n) {
  if (n == null) return '0';
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  return Math.floor(v).toString(36);
}

function decodeCursorBase36(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!s || s === '0') return 0;
  const v = parseInt(s, 36);
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

function encodeCursorHistory(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (const n of arr) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) continue;
    out.push(encodeCursorBase36(v));
  }
  // Bound size so customId stays under Discord limits.
  const MAX = 12;
  const trimmed = out.length > MAX ? out.slice(out.length - MAX) : out;
  return trimmed.length ? trimmed.join('.') : '-';
}

function decodeCursorHistory(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s === '-') return [];
  return s
    .split('.')
    .map((p) => decodeCursorBase36(p))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

function buildFavoritesPageMessage({ au, items, cursorBeforeId, nextBeforeId, selectedId, mode, history }) {
  const safeItems = Array.isArray(items) ? items.filter((x) => x && typeof x === 'object') : [];
  const cursorEnc = encodeCursorBase36(cursorBeforeId);
  const histEnc = encodeCursorHistory(history);
  const sel = selectedId != null ? String(selectedId) : null;
  const pageMode = mode === 'confirm' ? 'confirm' : 'normal';

  const selected = sel ? safeItems.find((x) => x && String(x.id) === sel) : null;
  const selectedPrompt = selected && selected.promptText != null ? String(selected.promptText) : null;

  const embed = new EmbedBuilder()
    .setTitle('Your favorites')
    .setDescription(safeItems.length ? ' ' : 'No favorites yet.');

  if (safeItems.length) {
    const maxEach = 300;
    for (let i = 0; i < safeItems.length; i++) {
      const it = safeItems[i];
      const settingId = it.settingId != null ? String(it.settingId) : null;
      const dynamicId = it.dynamicId != null ? String(it.dynamicId) : null;
      const meta =
        settingId || dynamicId
          ? (settingId ? formatUniverseLabel(au, settingId) : 'unknown') + ' + ' + (dynamicId ? formatDynamicLabel(au, dynamicId) : 'unknown')
          : 'unknown';
      const promptText = it.promptText != null ? String(it.promptText) : '';
      const prefix = sel && String(it.id) === sel ? '→ ' : '';
      const value = '```\n' + trunc(promptText, maxEach) + '\n```';
      embed.addFields({ name: prefix + '#' + String(i + 1) + ' ' + trunc(meta, 200), value });
    }
  }

  if (selectedPrompt) {
    // Keep it copyable; constrain to Discord limits.
    const maxPrompt = 1800;
    const promptBlock = '```\n' + trunc(selectedPrompt, maxPrompt) + '\n```';
    embed.addFields({ name: 'Selected', value: promptBlock });
  }

  if (safeItems.length === 0) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fav:refresh:0').setStyle(ButtonStyle.Secondary).setLabel('Refresh')
    );
    return { embeds: [embed], components: [row] };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('fav:pick:' + cursorEnc + ':' + histEnc)
    .setPlaceholder('Select to remove…')
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(pageMode === 'confirm');

  const opts = safeItems
    .slice(0, 25)
    .filter((it) => it && it.id != null && String(it.id))
    .map((it, idx) => {
    const id = String(it.id);
    const settingId = it.settingId != null ? String(it.settingId) : null;
    const dynamicId = it.dynamicId != null ? String(it.dynamicId) : null;
    const meta =
      settingId || dynamicId
        ? (settingId ? formatUniverseLabel(au, settingId) : 'unknown') + ' + ' + (dynamicId ? formatDynamicLabel(au, dynamicId) : 'unknown')
        : 'unknown';
    const promptText = it.promptText != null ? String(it.promptText) : '';
    return new StringSelectMenuOptionBuilder()
      .setLabel(trunc(String(idx + 1) + '. ' + meta, 100))
      .setDescription(trunc(promptText.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim(), 100) || ' ') // description cannot be empty
      .setValue(id);
  });

  if (opts.length === 0) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fav:refresh:0').setStyle(ButtonStyle.Secondary).setLabel('Refresh')
    );
    return { embeds: [embed], components: [row] };
  }

  select.addOptions(opts);

  const removeDisabled = !sel;
  const removeIdPart = sel ? sel : 'none';

  const row1 = new ActionRowBuilder().addComponents(select);
  const hasPrev = Array.isArray(history) && history.length > 0;
  const row2 =
    pageMode === 'confirm'
      ? new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('fav:confirm:' + removeIdPart + ':' + cursorEnc + ':' + histEnc)
            .setStyle(ButtonStyle.Danger)
            .setLabel('Confirm remove')
            .setDisabled(removeDisabled),
          new ButtonBuilder()
            .setCustomId('fav:cancel:' + removeIdPart + ':' + cursorEnc + ':' + histEnc)
            .setStyle(ButtonStyle.Secondary)
            .setLabel('Cancel')
        )
      : new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('fav:rm:' + removeIdPart + ':' + cursorEnc + ':' + histEnc)
            .setStyle(ButtonStyle.Danger)
            .setLabel('Remove')
            .setDisabled(removeDisabled),
          new ButtonBuilder()
            .setCustomId('fav:prev:' + cursorEnc + ':' + histEnc)
            .setStyle(ButtonStyle.Secondary)
            .setLabel('Prev')
            .setDisabled(!hasPrev),
          new ButtonBuilder()
            .setCustomId(
              'fav:next:' + (nextBeforeId != null ? encodeCursorBase36(nextBeforeId) : '0') + ':' + cursorEnc + ':' + histEnc
            )
            .setStyle(ButtonStyle.Secondary)
            .setLabel('Next')
            .setDisabled(nextBeforeId == null),
          new ButtonBuilder().setCustomId('fav:refresh:0').setStyle(ButtonStyle.Secondary).setLabel('Refresh')
        );

  return { embeds: [embed], components: [row1, row2] };
}

async function fetchFavoritesPage(userId, { beforeId, limit }) {
  const qs = [];
  qs.push('userDiscordUserId=' + encodeURIComponent(String(userId)));
  qs.push('limit=' + encodeURIComponent(String(limit || 10)));
  if (beforeId != null) qs.push('beforeId=' + encodeURIComponent(String(beforeId)));
  const r = await botApiGetJson('/v1/au/favorites?' + qs.join('&'));
  if (!r.ok) return r;
  const items = r.json && Array.isArray(r.json.items) ? r.json.items : [];
  const nextBeforeId = r.json && r.json.nextBeforeId != null ? Number(r.json.nextBeforeId) : null;
  return { ok: true, status: r.status, json: { items, nextBeforeId } };
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

function withFavoriteButton(components, { source, settingId, dynamicId }) {
  const row = components && components[0] ? components[0] : new ActionRowBuilder();
  const s = safeCustomIdPart(settingId);
  const d = safeCustomIdPart(dynamicId);
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('fav:add:' + safeCustomIdPart(source) + ':' + s + ':' + d)
      .setLabel('Favorite')
      .setStyle(ButtonStyle.Success)
  );
  return [row];
}

function extractPromptTextFromFavoriteMessage(message) {
  const content = message && typeof message.content === 'string' ? message.content : '';
  if (!content || !content.trim()) return null;
  const trimmed = content.trim();

  // Daily posts are: "<setting> + <dynamic>\n<prompt>".
  const lines = trimmed.split('\n');
  if (lines.length >= 2 && lines[0].includes(' + ')) {
    const rest = lines.slice(1).join('\n').trim();
    return rest ? rest : null;
  }

  // Generate posts are just the prompt text.
  return trimmed;
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

function compactUuid(uuid) {
  const raw = typeof uuid === 'string' ? uuid : '';
  const out = raw.replace(/-/g, '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(out) ? out : null;
}

function buildOcTabComponents({ tabKey, inviteCode, profileIdCompact }) {
  const code = normalizeInviteCode(inviteCode);
  const pid = compactUuid(profileIdCompact);
  if (!code || !pid) return [];

  const mk = (k) => 'oc:tab:' + String(k) + ':' + safeCustomIdPart(code) + ':' + safeCustomIdPart(pid);
  const current = typeof tabKey === 'string' ? tabKey : 'ov';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(mk('ov')).setLabel('Overview').setStyle(ButtonStyle.Secondary).setDisabled(current === 'ov'),
    new ButtonBuilder().setCustomId(mk('prof')).setLabel('Profile').setStyle(ButtonStyle.Secondary).setDisabled(current === 'prof'),
    new ButtonBuilder().setCustomId(mk('desc')).setLabel('Description').setStyle(ButtonStyle.Secondary).setDisabled(current === 'desc'),
    new ButtonBuilder().setCustomId(mk('pics')).setLabel('Pictures').setStyle(ButtonStyle.Secondary).setDisabled(current === 'pics'),
    new ButtonBuilder().setCustomId(mk('moods')).setLabel('Moodboards').setStyle(ButtonStyle.Secondary).setDisabled(current === 'moods')
  );

  return [row];
}

const __ocMoodboardCollageCache = new Map();

function ocMoodboardGridCols(n) {
  const count = Number(n);
  if (!Number.isFinite(count) || count <= 1) return 1;
  if (count === 2 || count === 4) return 2;
  return 3;
}

function ocSafeUrlList(urls, max) {
  const list = Array.isArray(urls) ? urls : [];
  const safe = list.map((u) => String(u || '').trim()).filter(Boolean);
  const lim = Number.isFinite(Number(max)) ? Math.max(0, Number(max)) : safe.length;
  return safe.slice(0, lim);
}

function ocHashUrls(urls) {
  const h = createHash('sha256');
  for (const u of Array.isArray(urls) ? urls : []) h.update(String(u || ''), 'utf8').update('\n', 'utf8');
  return h.digest('hex').slice(0, 16);
}

async function ocFetchImageBuffer(url) {
  const u = String(url || '').trim();
  if (!u) throw new Error('empty url');

  const timeoutMs = 10_000;
  if (typeof fetch === 'function') {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(u, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          // Helps some hosts return an actual image instead of HTML.
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        }
      });
      if (!res.ok) throw new Error('http ' + String(res.status));
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty response');
      return buf;
    } finally {
      clearTimeout(t);
    }
  }

  // Very old Node fallback (should rarely happen).
  const { request } = u.startsWith('https:') ? require('node:https') : require('node:http');
  return await new Promise((resolve, reject) => {
    const req = request(u, { method: 'GET', headers: { Accept: 'image/*,*/*;q=0.8' } }, (res) => {
      if (!res || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error('http ' + String(res && res.statusCode)));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new Error('timeout'));
      } catch {}
    });
    req.end();
  });
}

async function buildOcMoodboardCollageBuffer(urls) {
  if (!sharp) return null;
  const list = ocSafeUrlList(urls, 9);
  if (!list.length) return null;

  const cacheKey = ocHashUrls(list);
  const cached = __ocMoodboardCollageCache.get(cacheKey);
  if (cached && cached.buffer && Buffer.isBuffer(cached.buffer)) return cached.buffer;

  const cols = ocMoodboardGridCols(list.length);
  const rows = Math.ceil(list.length / cols);

  const cell = 320;
  const width = cols * cell;
  const height = rows * cell;
  const background = { r: 18, g: 18, b: 18 };

  const composites = [];
  for (let i = 0; i < list.length; i++) {
    const left = (i % cols) * cell;
    const top = Math.floor(i / cols) * cell;

    let tile;
    try {
      const buf = await ocFetchImageBuffer(list[i]);
      tile = await sharp(buf)
        .resize(cell, cell, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch {
      tile = await sharp({ create: { width: cell, height: cell, channels: 3, background } })
        .jpeg({ quality: 82 })
        .toBuffer();
    }
    composites.push({ input: tile, left, top });
  }

  const out = await sharp({ create: { width, height, channels: 3, background } })
    .composite(composites)
    .jpeg({ quality: 82 })
    .toBuffer();

  __ocMoodboardCollageCache.set(cacheKey, { buffer: out, at: Date.now() });
  // Simple bound to avoid unbounded growth.
  if (__ocMoodboardCollageCache.size > 40) {
    const first = __ocMoodboardCollageCache.keys().next().value;
    if (first) __ocMoodboardCollageCache.delete(first);
  }

  return out;
}

async function buildOcMoodboardAttachment(urls, nameHint) {
  const buf = await buildOcMoodboardCollageBuffer(urls);
  if (!buf) return null;
  const safeHint = String(nameHint || 'moodboard').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const filename = 'oc-' + safeHint + '-' + ocHashUrls(ocSafeUrlList(urls, 9)) + '.jpg';
  const file = new AttachmentBuilder(buf, { name: filename });
  return { file, filename, embedUrl: 'attachment://' + filename };
}

// Ported from mobile/lib/ocs/ocCharacterProfile.ts (authoritative formatting)
function getOcCharacterProfileStyle(profile) {
  const raw = String((profile && profile.style) || '').trim().toLowerCase();
  if (raw === 'normal') return 'normal';
  if (raw === 'dark') return 'dark';
  return 'cutesy';
}

function normalizeOcCharacterProfile(v) {
  const raw = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const out = {};
  for (const [k, val] of Object.entries(raw)) {
    const key = String(k || '').trim();
    if (!key) continue;
    const value = String(val || '').trim();
    if (!value) continue;
    out[key] = value;
  }

  if (!out.zodiac && out.overall_vibe) out.zodiac = out.overall_vibe;
  if (!out.moral_alignment && out.how_others_describe) out.moral_alignment = out.how_others_describe;
  delete out.overall_vibe;
  delete out.how_others_describe;

  if (!out.style) out.style = 'cutesy';
  return out;
}

function ocFormatValue(value, style) {
  const v = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!v) return '';
  const lines = v
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  if (style === 'normal' || style === 'dark') return lines.map((l) => '  ' + l).join('\n');
  return lines.map((l) => '   ┊ ' + l).join('\n');
}

function ocDisplayLabelForField(profile, field) {
  const lc = field && field.labelChoice;
  if (!lc) return field.displayLabel;
  const raw = String((profile && profile[lc.key]) || '').trim();
  const selected = raw || lc.defaultValue;
  const opt = Array.isArray(lc.options) ? lc.options.find((o) => o && o.value === selected) : null;
  return (opt && opt.displayLabel) || field.displayLabel;
}

function ocNormalLabelForField(profile, field) {
  const lc = field && field.labelChoice;
  if (lc) {
    const raw = String((profile && profile[lc.key]) || '').trim();
    const selected = raw || lc.defaultValue;
    return selected;
  }
  return String(field.editorLabel || field.key);
}

function buildOcCharacterProfileSectionText(profile, section, styleOverride) {
  const p = profile || {};
  const style = styleOverride || getOcCharacterProfileStyle(p);
  const filled = (Array.isArray(section.fields) ? section.fields : [])
    .map((f) => ({ field: f, value: String((p && p[f.key]) || '').trim() }))
    .filter((x) => x.value.length);

  if (!filled.length) return null;

  function darkSectionHeader(key, fallbackTitle) {
    switch (key) {
      case 'character_profile':
        return '╭─ ♱ ─ profile ─ ♱ ─╮';
      case 'appearance':
        return '╭─ ♱ appearance ♱ ─╮';
      case 'personality':
        return '╭─ ♱ personality ♱ ─╮';
      case 'background':
        return '╭─ ♱ background ♱ ─╮';
      case 'relationships':
        return '╭─ ♱ relationships ♱ ─╮';
      case 'school_career':
        return '╭─ ♱ career ♱ ─╮';
      case 'abilities':
        return '╭─ ♱ abilities ♱ ─╮';
      case 'extras':
        return '╭─ ♱ extras ♱ ─╮';
      default: {
        const t = String(fallbackTitle || key).trim().toLowerCase() || 'section';
        return '╭─ ♱ ' + t + ' ♱ ─╮';
      }
    }
  }

  function darkSectionFooter(key) {
    switch (key) {
      case 'school_career':
        return '╰─ ♱ ─── ♱ ─╯';
      case 'extras':
        return '╰─ ⛧ ── ⛧ ─╯';
      default:
        return '╰─ ♱ ──── ♱ ─╯';
    }
  }

  function darkLabelForField(sectionKey, fieldKey) {
    if (sectionKey === 'character_profile') {
      const map = {
        name: '♱ name',
        preferred_name: '♱ nickname',
        age: '♱ age',
        pronouns: '♱ pronouns',
        ethnicity_nationality: '♱ nationality',
        species_type: '♱ species',
        occupation_role: '♱ occupation',
        birthplace: '♱ birthplace',
        current_residence: '♱ current residence',
        representative_emoji: '♱ representative emoji',
        aesthetic_vibe: '♱ aesthetic',
        favorite_quote: '♱ quote'
      };
      return map[fieldKey] || ('♱ ' + String(fieldKey || '').replace(/_/g, ' '));
    }

    if (sectionKey === 'appearance') {
      const map = {
        height: '⛧ height',
        build_body_type: '⛧ body type',
        skin_tone: '⛧ skin tone',
        hair: '⛧ hair',
        eyes: '⛧ eyes',
        clothing_style: '⛧ clothing',
        accessories: '⛧ accessories',
        scent: '⛧ scent',
        scars: '⛧ scars',
        tattoos: '⛧ tattoos',
        piercings: '⛧ piercings',
        distinguishing_traits: '⛧ traits'
      };
      return map[fieldKey] || ('⛧ ' + String(fieldKey || '').replace(/_/g, ' '));
    }

    if (sectionKey === 'personality') {
      const map = {
        mbti: '⛧ mbti',
        zodiac: '⛧ zodiac',
        moral_alignment: '⛧ alignment',
        strengths: '♱ strengths',
        flaws: '♱ flaws',
        insecurities: '♱ insecurities',
        fears: '♱ fears',
        soft_spot: '♱ soft spot',
        pet_peeves: '♱ pet peeves',
        love_language: '♱ love language',
        attachment_style: '♱ attachment',
        hobbies: '♱ hobbies',
        quirks: '♱ quirks',
        likes: '♱ likes',
        dislikes: '♱ dislikes',
        talents: '♱ talents'
      };
      return map[fieldKey] || ('♱ ' + String(fieldKey || '').replace(/_/g, ' '));
    }

    if (sectionKey === 'background') {
      const map = {
        hometown: '⛧ hometown',
        upbringing: '⛧ upbringing',
        social_class: '⛧ social class',
        parent_guardian: '♱ parent',
        siblings: '♱ siblings',
        important_people: '♱ important people',
        goals: '♱ goals',
        long_term_dream: '♱ dream',
        secret: '♱ secret',
        rumor: '♱ rumor'
      };
      return map[fieldKey] || ('♱ ' + String(fieldKey || '').replace(/_/g, ' '));
    }

    if (sectionKey === 'relationships') {
      const map = {
        relationship_status: '⛧ status',
        crush: '⛧ crush',
        partner: '⛧ partner',
        exes: '⛧ ex',
        best_friends: '⛧ friends',
        friends: '⛧ friends',
        rivals: '⛧ rivals',
        enemies: '⛧ enemies',
        mentor: '⛧ mentor',
        pets: '⛧ pets'
      };
      return map[fieldKey] || ('⛧ ' + String(fieldKey || '').replace(/_/g, ' '));
    }

    if (sectionKey === 'school_career') {
      const map = {
        school_workplace: '⛧ school',
        year_grade: '⛧ year',
        major_field: '⛧ major',
        reputation: '⛧ reputation',
        clubs_teams: '⛧ clubs',
        part_time_job: '⛧ part-time',
        achievements: '⛧ achievements',
        dream_career: '⛧ dream career'
      };
      return map[fieldKey] || ('⛧ ' + String(fieldKey || '').replace(/_/g, ' '));
    }

    if (sectionKey === 'abilities') {
      const map = {
        strongest_skill: '⛧ strongest skill',
        weakest_skill: '⛧ weakest skill',
        intelligence_style: '⛧ intelligence'
      };
      return map[fieldKey] || ('⛧ ' + String(fieldKey || '').replace(/_/g, ' '));
    }

    if (sectionKey === 'extras') {
      const map = {
        theme_songs: '⛧ theme song(s)',
        favorite_food: '⛧ food',
        favorite_place: '⛧ place',
        comfort_item: '⛧ comfort item',
        color_palette: '⛧ colors',
        face_claim: '⛧ face claim',
        voice_claim: '⛧ voice claim',
        headcanon_1: '♱',
        headcanon_2: '♱',
        headcanon_3: '♱'
      };
      return map[fieldKey] || ('♱ ' + String(fieldKey || '').replace(/_/g, ' '));
    }

    return '♱ ' + String(fieldKey || '').replace(/_/g, ' ');
  }

  function darkShouldAddSpacerBefore(sectionKey, fieldKey) {
    if (sectionKey === 'personality' && fieldKey === 'strengths') return true;
    if (sectionKey === 'background' && fieldKey === 'parent_guardian') return true;
    if (sectionKey === 'extras' && fieldKey === 'headcanon_1') return true;
    return false;
  }

  const lines =
    style === 'normal'
      ? [String(section.editorTitle || ''), '']
      : style === 'dark'
        ? [darkSectionHeader(section.key, section.editorTitle), '']
        : [String(section.displayHeader || ''), ''];
  for (const { field, value } of filled) {
    const formatted = ocFormatValue(value, style);
    if (!formatted) continue;
    if (style === 'dark' && darkShouldAddSpacerBefore(section.key, field.key) && lines.length > 2) lines.push('');
    lines.push(
      style === 'normal'
        ? ocNormalLabelForField(p, field)
        : style === 'dark'
          ? darkLabelForField(section.key, field.key)
          : ocDisplayLabelForField(p, field)
    );
    lines.push(formatted);
  }
  if (style === 'cutesy') lines.push(String(section.displayFooter || ''));
  if (style === 'dark') lines.push('', darkSectionFooter(section.key));
  return lines.join('\n');
}

const OC_CHARACTER_PROFILE_SECTIONS = [
  {
    key: 'character_profile',
    editorTitle: 'Character profile',
    displayHeader: '╭─ ⋆｡˚ ୨୧ ⋆｡˚ ✦ profile ✦ ⋆｡˚ ୨୧ ⋆｡˚ ─╮',
    displayFooter: '╰─ ⋆｡˚ ୨୧ ⋆｡˚ ✦ ─── ✦ ⋆｡˚ ୨୧ ⋆｡˚ ─╯',
    fields: [
      { key: 'name', editorLabel: 'name', displayLabel: '˚₊‧꒰ა ✦ name ໒꒱ ‧₊˚', maxLen: 80 },
      { key: 'preferred_name', editorLabel: 'nickname', displayLabel: '˚₊‧꒰ა ✦ nickname ໒꒱ ‧₊˚', maxLen: 80 },
      { key: 'age', editorLabel: 'age', displayLabel: '˚₊‧꒰ა ✦ age ໒꒱ ‧₊˚', maxLen: 80 },
      { key: 'pronouns', editorLabel: 'pronouns', displayLabel: '˚₊‧꒰ა ✦ pronouns ໒꒱ ‧₊˚', maxLen: 80 },
      { key: 'ethnicity_nationality', editorLabel: 'nationality', displayLabel: '˚₊‧꒰ა ✦ nationality ໒꒱ ‧₊˚', maxLen: 160 },
      {
        key: 'species_type',
        editorLabel: 'species / type',
        displayLabel: '˚₊‧꒰ა ✦ species / type ໒꒱ ‧₊˚',
        maxLen: 80,
        labelChoice: {
          key: 'species_type_label',
          defaultValue: 'species',
          options: [
            { value: 'species', displayLabel: '˚₊‧꒰ა ✦ species ໒꒱ ‧₊˚' },
            { value: 'type', displayLabel: '˚₊‧꒰ა ✦ type ໒꒱ ‧₊˚' }
          ]
        }
      },
      {
        key: 'occupation_role',
        editorLabel: 'occupation / role',
        displayLabel: '˚₊‧꒰ა ✦ occupation / role ໒꒱ ‧₊˚',
        maxLen: 80,
        labelChoice: {
          key: 'occupation_role_label',
          defaultValue: 'occupation',
          options: [
            { value: 'occupation', displayLabel: '˚₊‧꒰ა ✦ occupation ໒꒱ ‧₊˚' },
            { value: 'role', displayLabel: '˚₊‧꒰ა ✦ role ໒꒱ ‧₊˚' }
          ]
        }
      },
      { key: 'birthplace', editorLabel: 'birthplace', displayLabel: '˚₊‧꒰ა ✦ birthplace ໒꒱ ‧₊˚', maxLen: 160 },
      {
        key: 'current_residence',
        editorLabel: 'current residence',
        displayLabel: '˚₊‧꒰ა ✦ current residence ໒꒱ ‧₊˚',
        maxLen: 160
      },
      {
        key: 'representative_emoji',
        editorLabel: 'representative emoji',
        displayLabel: '˚₊‧꒰ა ✦ representative emoji ໒꒱ ‧₊˚',
        maxLen: 80
      },
      { key: 'aesthetic_vibe', editorLabel: 'aesthetic', displayLabel: '˚₊‧꒰ა ✦ aesthetic ໒꒱ ‧₊˚', maxLen: 160 },
      { key: 'favorite_quote', editorLabel: 'favorite quote', displayLabel: '˚₊‧꒰ა ✦ favorite quote ໒꒱ ‧₊˚', maxLen: 160 }
    ]
  },
  {
    key: 'appearance',
    editorTitle: 'Appearance',
    displayHeader: '╭─ ♡₊˚ 𖤐・₊✧ appearance ✧₊・𖤐 ₊˚♡ ─╮',
    displayFooter: '╰─ ♡₊˚ 𖤐・₊✧ ────── ✧₊・𖤐 ₊˚♡ ─╯',
    fields: [
      { key: 'height', editorLabel: 'height', displayLabel: '⋆ ˚｡⋆ 🌷 height', maxLen: 80 },
      { key: 'build_body_type', editorLabel: 'body type', displayLabel: '⋆ ˚｡⋆ 🌷 body type', maxLen: 80 },
      { key: 'skin_tone', editorLabel: 'skin tone', displayLabel: '⋆ ˚｡⋆ 🌷 skin tone', maxLen: 80 },
      { key: 'hair', editorLabel: 'hair', displayLabel: '⋆ ˚｡⋆ 🌷 hair', maxLen: 160 },
      { key: 'eyes', editorLabel: 'eyes', displayLabel: '⋆ ˚｡⋆ 🌷 eyes', maxLen: 160 },
      { key: 'clothing_style', editorLabel: 'clothing style', displayLabel: '⋆ ˚｡⋆ 🎀 clothing style', maxLen: 160 },
      { key: 'accessories', editorLabel: 'accessories', displayLabel: '⋆ ˚｡⋆ 💍 accessories', maxLen: 160 },
      { key: 'scent', editorLabel: 'scent / perfume', displayLabel: '⋆ ˚｡⋆ 🌸 scent / perfume', maxLen: 160 },
      { key: 'scars', editorLabel: 'scars', displayLabel: '⋆ ˚｡⋆ 🩹 scars', maxLen: 160 },
      { key: 'tattoos', editorLabel: 'tattoos', displayLabel: '⋆ ˚｡⋆ 🖋 tattoos', maxLen: 160 },
      { key: 'piercings', editorLabel: 'piercings', displayLabel: '⋆ ˚｡⋆ ✨ piercings', maxLen: 160 },
      {
        key: 'distinguishing_traits',
        editorLabel: 'other distinguishing traits',
        displayLabel: '⋆ ˚｡⋆ 🦋 other distinguishing traits',
        maxLen: 400,
        multiline: true
      }
    ]
  },
  {
    key: 'personality',
    editorTitle: 'Personality',
    displayHeader: '╭─ ⋆｡°✩ personality ⋆｡°✩ ─╮',
    displayFooter: '╰─ ⋆｡°✩ ───── ⋆｡°✩ ─╯',
    fields: [
      { key: 'mbti', editorLabel: 'mbti', displayLabel: '✦ mbti', maxLen: 80 },
      { key: 'zodiac', editorLabel: 'zodiac', displayLabel: '✦ zodiac', maxLen: 80 },
      { key: 'moral_alignment', editorLabel: 'moral alignment', displayLabel: '✦ moral alignment', maxLen: 80 },
      { key: 'strengths', editorLabel: 'strengths', displayLabel: '🌟 strengths', maxLen: 400, multiline: true },
      { key: 'flaws', editorLabel: 'flaws', displayLabel: '🌧 flaws', maxLen: 400, multiline: true },
      { key: 'insecurities', editorLabel: 'insecurities', displayLabel: '🌙 insecurities', maxLen: 400, multiline: true },
      { key: 'fears', editorLabel: 'fears', displayLabel: '🌫 fears', maxLen: 400, multiline: true },
      { key: 'soft_spot', editorLabel: 'soft spot', displayLabel: '🧸 soft spot', maxLen: 400, multiline: true },
      { key: 'pet_peeves', editorLabel: 'pet peeves', displayLabel: '⚡ pet peeves', maxLen: 400, multiline: true },
      { key: 'love_language', editorLabel: 'love language', displayLabel: '💌 love language', maxLen: 160 },
      { key: 'attachment_style', editorLabel: 'attachment style', displayLabel: '🫧 attachment style', maxLen: 160 },
      { key: 'hobbies', editorLabel: 'hobbies', displayLabel: '🎨 hobbies', maxLen: 400, multiline: true },
      { key: 'quirks', editorLabel: 'quirks', displayLabel: '🎭 quirks', maxLen: 400, multiline: true },
      { key: 'likes', editorLabel: 'likes', displayLabel: '🍓 likes', maxLen: 400, multiline: true },
      { key: 'dislikes', editorLabel: 'dislikes', displayLabel: '🍋 dislikes', maxLen: 400, multiline: true },
      { key: 'talents', editorLabel: 'talents', displayLabel: '🏆 talents', maxLen: 400, multiline: true }
    ]
  },
  {
    key: 'background',
    editorTitle: 'Background',
    displayHeader: '╭─ ˚₊‧꒰ა 📖 background ໒꒱ ‧₊˚ ─╮',
    displayFooter: '╰─ ˚₊‧꒰ა ────── ໒꒱ ‧₊˚ ─╯',
    fields: [
      { key: 'hometown', editorLabel: 'hometown', displayLabel: '⋆ ˚｡⋆ 🏡 hometown', maxLen: 160 },
      { key: 'upbringing', editorLabel: 'upbringing', displayLabel: '⋆ ˚｡⋆ 🏠 upbringing', maxLen: 400, multiline: true },
      { key: 'social_class', editorLabel: 'social class', displayLabel: '⋆ ˚｡⋆ 💸 social class', maxLen: 400, multiline: true },
      {
        key: 'parent_guardian',
        editorLabel: 'parent / guardian',
        displayLabel: '👩 parent / guardian',
        maxLen: 400,
        multiline: true,
        labelChoice: {
          key: 'parent_guardian_label',
          defaultValue: 'parent',
          options: [
            { value: 'parent', displayLabel: '👩 parent' },
            { value: 'guardian', displayLabel: '👩 guardian' }
          ]
        }
      },
      { key: 'siblings', editorLabel: 'siblings', displayLabel: '🫂 siblings', maxLen: 400, multiline: true },
      { key: 'important_people', editorLabel: 'important people', displayLabel: '🌟 important people', maxLen: 400, multiline: true },
      { key: 'goals', editorLabel: 'goals', displayLabel: '✦ goals', maxLen: 400, multiline: true },
      { key: 'long_term_dream', editorLabel: 'long-term dream', displayLabel: '✦ long-term dream', maxLen: 400, multiline: true },
      { key: 'secret', editorLabel: 'secret', displayLabel: '✦ secret', maxLen: 400, multiline: true },
      { key: 'rumor', editorLabel: 'rumor about them', displayLabel: '✦ rumor about them', maxLen: 400, multiline: true }
    ]
  },
  {
    key: 'relationships',
    editorTitle: 'Relationships',
    displayHeader: '╭─ ⋆｡˚ 💌 relationships ⋆｡˚ ─╮',
    displayFooter: '╰─ ⋆｡˚ ────── 💌 ⋆｡˚ ─╯',
    fields: [
      { key: 'relationship_status', editorLabel: 'relationship status', displayLabel: '˚₊‧꒰ა ✦ relationship status ໒꒱ ‧₊˚', maxLen: 160 },
      { key: 'crush', editorLabel: 'crush', displayLabel: '˚₊‧꒰ა ✦ crush ໒꒱ ‧₊˚', maxLen: 160 },
      { key: 'partner', editorLabel: 'partner', displayLabel: '˚₊‧꒰ა ✦ partner ໒꒱ ‧₊˚', maxLen: 160 },
      { key: 'exes', editorLabel: 'ex(es)', displayLabel: '˚₊‧꒰ა ✦ ex(es) ໒꒱ ‧₊˚', maxLen: 400, multiline: true },
      { key: 'best_friends', editorLabel: 'best friend(s)', displayLabel: '˚₊‧꒰ა ✦ best friend(s) ໒꒱ ‧₊˚', maxLen: 400, multiline: true },
      { key: 'friends', editorLabel: 'friends', displayLabel: '˚₊‧꒰ა ✦ friends ໒꒱ ‧₊˚', maxLen: 400, multiline: true },
      { key: 'rivals', editorLabel: 'rivals', displayLabel: '˚₊‧꒰ა ✦ rivals ໒꒱ ‧₊˚', maxLen: 400, multiline: true },
      { key: 'enemies', editorLabel: 'enemies', displayLabel: '˚₊‧꒰ა ✦ enemies ໒꒱ ‧₊˚', maxLen: 400, multiline: true },
      {
        key: 'mentor',
        editorLabel: 'mentor / mentee',
        displayLabel: '₊‧꒰ა ✦ mentor / mentee ໒꒱ ‧₊˚',
        maxLen: 400,
        multiline: true,
        labelChoice: {
          key: 'mentor_label',
          defaultValue: 'mentor',
          options: [
            { value: 'mentor', displayLabel: '₊‧꒰ა ✦ mentor ໒꒱ ‧₊˚' },
            { value: 'mentee', displayLabel: '₊‧꒰ა ✦ mentee ໒꒱ ‧₊˚' }
          ]
        }
      },
      { key: 'pets', editorLabel: 'pets / companions', displayLabel: '🐾 pets / companions', maxLen: 400, multiline: true }
    ]
  },
  {
    key: 'school_career',
    editorTitle: 'School / career',
    displayHeader: '╭─ ♡₊˚ 𖤐・₊✧ career ✧₊・𖤐 ₊˚♡ ─╮',
    displayFooter: '╰─ ♡₊˚ 𖤐・₊✧ ─── ✧₊・𖤐 ₊˚♡ ─╯',
    fields: [
      {
        key: 'school_workplace',
        editorLabel: 'school / university / workplace',
        displayLabel: '⋆ ˚｡⋆ 🎓 school / university / workplace',
        maxLen: 400,
        multiline: true,
        labelChoice: {
          key: 'school_workplace_label',
          defaultValue: 'school',
          options: [
            { value: 'school', displayLabel: '⋆ ˚｡⋆ 🎓 school' },
            { value: 'university', displayLabel: '⋆ ˚｡⋆ 🎓 university' },
            { value: 'workplace', displayLabel: '⋆ ˚｡⋆ 🎓 workplace' }
          ]
        }
      },
      {
        key: 'year_grade',
        editorLabel: 'year / grade / education',
        displayLabel: '⋆ ˚｡⋆ 📚 year / grade / education',
        maxLen: 160,
        labelChoice: {
          key: 'year_grade_label',
          defaultValue: 'year',
          options: [
            { value: 'year', displayLabel: '⋆ ˚｡⋆ 📚 year' },
            { value: 'grade', displayLabel: '⋆ ˚｡⋆ 📚 grade' },
            { value: 'education', displayLabel: '⋆ ˚｡⋆ 📚 education' }
          ]
        }
      },
      {
        key: 'major_field',
        editorLabel: 'major / field',
        displayLabel: '⋆ ˚｡⋆ 🖋 major / field',
        maxLen: 160,
        labelChoice: {
          key: 'major_field_label',
          defaultValue: 'major',
          options: [
            { value: 'major', displayLabel: '⋆ ˚｡⋆ 🖋 major' },
            { value: 'field', displayLabel: '⋆ ˚｡⋆ 🖋 field' }
          ]
        }
      },
      { key: 'reputation', editorLabel: 'reputation there', displayLabel: '⋆ ˚｡⋆ 🌟 reputation there', maxLen: 400, multiline: true },
      {
        key: 'clubs_teams',
        editorLabel: 'clubs / teams',
        displayLabel: '🎭 clubs / teams',
        maxLen: 400,
        multiline: true,
        labelChoice: {
          key: 'clubs_teams_label',
          defaultValue: 'clubs',
          options: [
            { value: 'clubs', displayLabel: '🎭 clubs' },
            { value: 'teams', displayLabel: '🎭 teams' }
          ]
        }
      },
      {
        key: 'part_time_job',
        editorLabel: 'part-time / job',
        displayLabel: '💼 part-time / job',
        maxLen: 400,
        multiline: true,
        labelChoice: {
          key: 'part_time_job_label',
          defaultValue: 'part-time',
          options: [
            { value: 'part-time', displayLabel: '💼 part-time' },
            { value: 'job', displayLabel: '💼 job' }
          ]
        }
      },
      { key: 'achievements', editorLabel: 'achievements', displayLabel: '🏆 achievements', maxLen: 400, multiline: true },
      { key: 'dream_career', editorLabel: 'dream career', displayLabel: '🌠 dream career', maxLen: 400, multiline: true }
    ]
  },
  {
    key: 'abilities',
    editorTitle: 'Abilities',
    displayHeader: '╭─ ⋆｡°✩ abilities ⋆｡°✩ ─╮',
    displayFooter: '╰─ ⋆｡°✩ ────── ⋆｡°✩ ─╯',
    fields: [
      { key: 'strongest_skill', editorLabel: 'strongest skill', displayLabel: '✦ strongest skill', maxLen: 160 },
      { key: 'weakest_skill', editorLabel: 'weakest skill', displayLabel: '✦ weakest skill', maxLen: 160 },
      { key: 'intelligence_style', editorLabel: 'intelligence style', displayLabel: '✦ intelligence style', maxLen: 400, multiline: true }
    ]
  },
  {
    key: 'extras',
    editorTitle: 'Extras',
    displayHeader: '╭─ ♡₊˚ 𖤐・₊✧ extras ✧₊・𖤐 ₊˚♡ ─╮',
    displayFooter: '╰─ ⋆｡˚ ୨୧ ⋆｡˚ ──── ⋆｡˚ ୨୧ ⋆｡˚ ─╯',
    fields: [
      { key: 'theme_songs', editorLabel: 'theme song(s)', displayLabel: '🎶 theme song(s)', maxLen: 400, multiline: true },
      { key: 'favorite_food', editorLabel: 'favorite food', displayLabel: '🍓 favorite food', maxLen: 160 },
      { key: 'favorite_place', editorLabel: 'favorite place', displayLabel: '🏡 favorite place', maxLen: 160 },
      { key: 'comfort_item', editorLabel: 'comfort item', displayLabel: '🧸 comfort item', maxLen: 160 },
      { key: 'color_palette', editorLabel: 'color palette', displayLabel: '🎨 color palette', maxLen: 400, multiline: true },
      { key: 'face_claim', editorLabel: 'face claim', displayLabel: '🎭 face claim', maxLen: 160 },
      { key: 'voice_claim', editorLabel: 'voice claim', displayLabel: '🎤 voice claim', maxLen: 160 },
      { key: 'headcanon_1', editorLabel: 'headcanon 1', displayLabel: '🌸', maxLen: 400, multiline: true },
      { key: 'headcanon_2', editorLabel: 'headcanon 2', displayLabel: '🌸', maxLen: 400, multiline: true },
      { key: 'headcanon_3', editorLabel: 'headcanon 3', displayLabel: '🌸', maxLen: 400, multiline: true }
    ]
  }
];

function chunkTextForEmbeds(text, maxLen, maxChunks) {
  const raw = typeof text === 'string' ? text : '';
  const cleaned = raw.replace(/\r\n/g, '\n');
  const out = [];
  const lim = Number.isFinite(Number(maxLen)) ? Math.max(50, Number(maxLen)) : 3500;
  const maxC = Number.isFinite(Number(maxChunks)) ? Math.max(1, Number(maxChunks)) : 1;

  let i = 0;
  while (i < cleaned.length && out.length < maxC) {
    const slice = cleaned.slice(i, i + lim);
    out.push(slice);
    i += lim;
  }
  return { chunks: out, truncated: i < cleaned.length };
}

function formatUrlListAsMarkdownLinks(urls) {
  const list = Array.isArray(urls) ? urls : [];
  const safe = list.map((u) => String(u || '').trim()).filter(Boolean);
  if (safe.length === 0) return null;
  const parts = [];
  for (let i = 0; i < safe.length; i++) {
    const u = safe[i];
    parts.push('[' + String(i + 1) + '](' + u + ')');
  }
  return parts.join(' ');
}

async function buildOcShareMessage(payload, tabKey) {
  const safe = payload && typeof payload === 'object' ? payload : {};
  const scenario = safe.scenario && typeof safe.scenario === 'object' ? safe.scenario : {};
  const profile = safe.profile && typeof safe.profile === 'object' ? safe.profile : {};
  const details = safe.details && typeof safe.details === 'object' ? safe.details : {};

  const inviteCode = scenario.inviteCode != null ? String(scenario.inviteCode) : '';
  const scenarioName = scenario.name != null ? String(scenario.name).trim() : '';

  const displayName = profile.displayName != null ? String(profile.displayName).trim() : '';
  const handle = profile.handle != null ? String(profile.handle).trim() : '';
  const avatarUrl = profile.avatarUrl != null ? String(profile.avatarUrl).trim() : '';
  const headerUrl = profile.headerUrl != null ? String(profile.headerUrl).trim() : '';
  const bio = profile.bio != null ? String(profile.bio).trim() : '';

  const titleBase = displayName || (handle ? '@' + handle : 'Character');
  const title = handle ? titleBase + ' (@' + handle + ')' : titleBase;

  const moodboardUrls = Array.isArray(details.moodboardUrls) ? details.moodboardUrls : [];
  const imageUrls = Array.isArray(details.imageUrls) ? details.imageUrls : [];
  const extraMoodboards = Array.isArray(details.extraMoodboards) ? details.extraMoodboards : [];
  const longText = details.longText != null ? String(details.longText) : '';
  const characterProfile = details.characterProfile && typeof details.characterProfile === 'object' ? details.characterProfile : null;

  const tab = typeof tabKey === 'string' ? tabKey : 'ov';

  const out = { embeds: [], files: [], attachments: [] };

  if (tab === 'pics') {
    if (!imageUrls.length) {
      const e = new EmbedBuilder().setTitle(title).setDescription('No pictures yet.');
      if (avatarUrl) e.setThumbnail(avatarUrl);
      out.embeds = [e];
      return out;
    }

    const urls = imageUrls.map((u) => String(u || '').trim()).filter(Boolean).slice(0, 10);
    const embeds = [];
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      const e = new EmbedBuilder();
      if (i === 0) e.setTitle(title);
      e.setImage(u);
      embeds.push(e);
    }
    out.embeds = embeds;
    return out;
  }

  if (tab === 'moods') {
    const boards = extraMoodboards
      .filter((b) => Array.isArray(b))
      .map((b) => b.map((u) => String(u || '').trim()).filter(Boolean).slice(0, 9))
      .filter((b) => b.length > 0)
      .slice(0, 4);

    const main = ocSafeUrlList(moodboardUrls, 9);
    if (!main.length && boards.length === 0) {
      const e = new EmbedBuilder().setTitle(title).setDescription('No moodboards yet.');
      out.embeds = [e];
      return out;
    }

    const embeds = [];
    // Main moodboard first.
    if (main.length) {
      const att = await buildOcMoodboardAttachment(main, 'main');
      const e = new EmbedBuilder().setTitle(title + ' — Moodboard');
      if (att) {
        out.files.push(att.file);
        e.setImage(att.embedUrl);
      } else if (main[0]) {
        e.setImage(main[0]);
      }
      embeds.push(e);
    }

    for (let i = 0; i < boards.length; i++) {
      const urls = boards[i];
      const att = await buildOcMoodboardAttachment(urls, 'extra-' + String(i + 1));
      const e = new EmbedBuilder().setTitle('Extra moodboard ' + String(i + 1));
      if (att) {
        out.files.push(att.file);
        e.setImage(att.embedUrl);
      } else if (urls[0]) {
        e.setImage(urls[0]);
      }
      embeds.push(e);
    }

    out.embeds = embeds;
    return out;
  }

  if (tab === 'desc') {
    const text = String(longText || '').trim();
    if (!text) {
      const e = new EmbedBuilder().setTitle(title).setDescription('No description yet.');
      if (avatarUrl) e.setThumbnail(avatarUrl);
      out.embeds = [e];
      return out;
    }

    // Discord limits: 6000 chars across embeds/message.
    const { chunks, truncated } = chunkTextForEmbeds(text, 2700, 2);
    const embeds = chunks.map((c, idx) => {
      const e = new EmbedBuilder().setTitle(idx === 0 ? title : 'Description (cont.)').setDescription(c);
      if (idx === 0) {
        if (avatarUrl) e.setThumbnail(avatarUrl);
      }
      return e;
    });
    out.embeds = embeds;
    return out;
  }

  if (tab === 'prof') {
    const p = normalizeOcCharacterProfile(characterProfile);
    const sectionTexts = OC_CHARACTER_PROFILE_SECTIONS.map((s) => buildOcCharacterProfileSectionText(p, s)).filter(Boolean);
    if (sectionTexts.length === 0) {
      const e = new EmbedBuilder().setTitle(title).setDescription('No profile sheet yet.');
      if (avatarUrl) e.setThumbnail(avatarUrl);
      out.embeds = [e];
      return out;
    }

    const embeds = [];
    for (let i = 0; i < sectionTexts.length; i++) {
      const t = sectionTexts[i];
      // Keep each section in its own embed to preserve formatting.
      const e = new EmbedBuilder().setDescription(trunc(String(t), 4096) || ' ');
      if (i === 0) {
        e.setTitle(title);
        if (avatarUrl) e.setThumbnail(avatarUrl);
      }
      embeds.push(e);
      if (embeds.length >= 10) break;
    }

    out.embeds = embeds;
    return out;
  }

  // Overview (default): bio + main moodboard collage
  const e = new EmbedBuilder().setTitle(title);
  if (bio) e.setDescription(trunc(bio, 2000));
  if (avatarUrl) e.setThumbnail(avatarUrl);
  if (handle) e.addFields([{ name: 'Username', value: '@' + handle, inline: true }]);

  const main = ocSafeUrlList(moodboardUrls, 9);
  if (main.length) {
    const att = await buildOcMoodboardAttachment(main, 'overview');
    if (att) {
      out.files.push(att.file);
      e.setImage(att.embedUrl);
    } else if (main[0]) {
      e.setImage(main[0]);
    }
  }

  out.embeds = [e];
  return out;
}

async function fetchOcSharePayload({ inviteCode, handle, profileIdCompact }) {
  const code = normalizeInviteCode(inviteCode);
  if (!code) return { ok: false, status: 0, error: 'Invalid invite code.' };

  const qs = [];
  qs.push('inviteCode=' + encodeURIComponent(code));
  if (handle) qs.push('handle=' + encodeURIComponent(String(handle)));
  if (profileIdCompact) qs.push('profileId=' + encodeURIComponent(String(profileIdCompact)));

  const r = await botApiGetJson('/v1/bot/oc/share?' + qs.join('&'));
  if (!r.ok) return r;
  return { ok: true, status: r.status, json: r.json };
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

function getBotVersionString() {
  try {
    // index.js lives in src/, package.json at repo root.
    const pkg = require('../package.json');
    const v = pkg && typeof pkg.version === 'string' ? pkg.version.trim() : '';
    return v ? v : null;
  } catch {
    return null;
  }
}

function buildHelpMessage() {
  const version = getBotVersionString();
  const title = 'Feedverse' + (version ? ' (v' + version + ')' : '');
  const tagline = 'AU prompts, daily threads, and easy sharing.';

  const embed = new EmbedBuilder().setTitle(title).setDescription(tagline);

  const cmds = [];
  cmds.push('• `/' + 'profile` — view XP, level, and prompt history (optionally for another user)');
  cmds.push('• `/' + 'leaderboard` — see this server ranked by server XP');
  cmds.push('• `/' + 'generate` — generate one AU prompt (includes Favorite button)');
  cmds.push('• `/' + 'share` — share a Feedverse character (OC page)');
  cmds.push('• `/' + 'prompt` — submit a prompt for moderator review');
  cmds.push('• `/' + 'trivia categories` — list trivia categories and page through them');
  cmds.push('• `/' + 'trivia stats` — view trivia points, wins, and correct answers');
  cmds.push('• `/' + 'trivia leaderboard` — see this server ranked by trivia points');
  cmds.push('• `/' + 'trivia start` — start a timed trivia round in this channel');
  cmds.push('• `/' + 'setup daily` — post a daily prompt in a channel');
  cmds.push('• `/' + 'view favorites` — view your favorited prompts');

  embed.addFields({ name: 'Commands', value: cmds.join('\n') });
  embed.addFields({
    name: 'Tip',
    value:
      'Use `/' +
      'setup daily` (example: `/' +
        'setup daily #channel 9:30pm`). Optional: add timezone like `America/New_York`.'
  });

  const invite = "https://discord.com/invite/pR8HbSDQdn"; // default to official support server
  const components = [];
  if (invite) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join Discord').setURL(invite)
    );
    components.push(row);
  }

  return { embeds: [embed], components };
}

function buildProfileEmbed({ au, userId, profile, page, pageSize }) {
  const safe = profile && typeof profile === 'object' ? profile : {};
  const level = Number.isFinite(Number(safe.level)) ? Number(safe.level) : 1;
  const xp = Number.isFinite(Number(safe.xp)) ? Number(safe.xp) : 0;
  const accepted = Number.isFinite(Number(safe.acceptedCount)) ? Number(safe.acceptedCount) : 0;
  const trivia = safe.trivia && typeof safe.trivia === 'object' ? safe.trivia : {};
  const xpInto = Number.isFinite(Number(safe.xpIntoLevel)) ? Number(safe.xpIntoLevel) : 0;
  const xpForNext = Number.isFinite(Number(safe.xpForNextLevel)) ? Number(safe.xpForNextLevel) : 0;
  const pageNum = Number.isFinite(Number(page)) ? Number(page) : 0;
  const perPage = Number.isFinite(Number(pageSize)) ? Number(pageSize) : null;

  const embed = new EmbedBuilder()
    .setTitle('🧾 Profile')
    .setDescription('👤 <@' + String(userId) + '>');

  if (pageNum > 0 || perPage) {
    const label = 'Page ' + String(pageNum + 1) + (perPage ? ' • ' + String(perPage) + '/page' : '');
    embed.setFooter({ text: label });
  }

  embed.addFields(
    { name: '🎖️ Level', value: String(level), inline: true },
    { name: '⚡ XP', value: String(xp), inline: true },
    { name: '✅ Accepted', value: String(accepted), inline: true }
  );

  if (xpForNext > 0) {
    embed.addFields({
      name: '📈 Progress',
      value: String(xpInto) + ' / ' + String(xpForNext) + ' XP to next level',
      inline: false
    });
  }

  embed.addFields({
    name: '🎮 Trivia summary',
    value:
      'Points: ' + String(Number(trivia.points ?? 0)) + '\n' +
      'Wins: ' + String(Number(trivia.roundWins ?? 0)) + '\n' +
      'Correct: ' + String(Number(trivia.correctAnswers ?? 0)) + '\n' +
      'Trivia XP: ' + String(Number(trivia.xpEarned ?? 0)),
    inline: false,
  });

  const submissions = safe.submissions && Array.isArray(safe.submissions) ? safe.submissions : [];
  if (submissions.length === 0) {
    embed.addFields({ name: '📝 Recent prompts', value: 'No submissions yet.' });
    return embed;
  }

  const shown = submissions.slice(0, 10);
  const maxEach = 240;
  for (let i = 0; i < shown.length; i++) {
    const it = shown[i] || {};
    const status = String(it.status || 'pending');
    const badge = status === 'approved' ? '✅' : status === 'rejected' ? '❌' : '⏳';
    const settingId = it.settingId != null ? String(it.settingId) : null;
    const dynamicId = it.dynamicId != null ? String(it.dynamicId) : null;
    const meta =
      settingId || dynamicId
        ? (settingId ? formatUniverseLabel(au, settingId) : 'unknown') + ' + ' + (dynamicId ? formatDynamicLabel(au, dynamicId) : 'unknown')
        : 'unknown';
    const promptText = it.promptText != null ? String(it.promptText) : '';
    embed.addFields({
      name: badge + ' #' + String(i + 1) + ' ' + trunc(meta, 200),
      value: '```\n' + trunc(promptText, maxEach) + '\n```'
    });
  }

  return embed;
}

function buildProfileComponents({ ownerUserId, targetUserId, page, hasMore }) {
  const p = Number.isFinite(Number(page)) ? Math.max(0, Number(page)) : 0;
  const olderDisabled = !hasMore;
  const newerDisabled = p <= 0;

  const newerId = 'prof:page:' + String(ownerUserId) + ':' + String(targetUserId) + ':' + String(Math.max(0, p - 1));
  const olderId = 'prof:page:' + String(ownerUserId) + ':' + String(targetUserId) + ':' + String(p + 1);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(newerId).setLabel('Newer').setStyle(ButtonStyle.Secondary).setDisabled(newerDisabled),
    new ButtonBuilder().setCustomId(olderId).setLabel('Older').setStyle(ButtonStyle.Secondary).setDisabled(olderDisabled)
  );
  return [row];
}

function buildLeaderboardEmbed({ items }) {
  const rows = Array.isArray(items) ? items.filter((x) => x && typeof x === 'object') : [];
  const embed = new EmbedBuilder().setTitle('🏆 Leaderboard').setDescription(rows.length ? 'ranked by server XP' : 'No data yet.');

  if (!rows.length) return embed;

  const lines = [];
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const it = rows[i];
    const userId = it.userDiscordUserId != null ? String(it.userDiscordUserId) : '';
    const accepted = Number.isFinite(Number(it.acceptedCount)) ? Number(it.acceptedCount) : 0;
    const level = Number.isFinite(Number(it.level)) ? Number(it.level) : 1;
    const xp = Number.isFinite(Number(it.xp)) ? Number(it.xp) : 0;
    const triviaPoints = Number.isFinite(Number(it.triviaPoints)) ? Number(it.triviaPoints) : 0;
    const triviaWins = Number.isFinite(Number(it.triviaRoundWins)) ? Number(it.triviaRoundWins) : 0;
    const triviaXp = Number.isFinite(Number(it.triviaXpEarned)) ? Number(it.triviaXpEarned) : 0;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
    lines.push(
      medal + ' ' + String(i + 1) + '. <@' + userId + '> — ⚡ ' + String(xp) + ' xp | LV🎖️ ' + String(level) +
      ' | ✅ ' + String(accepted) + ' prompts | 🎯 ' + String(triviaPoints) + ' trivia pts | 🏆 ' + String(triviaWins) + ' wins | 🧠 ' + String(triviaXp) + ' trivia xp'
    );
  }

  embed.addFields({ name: 'Rankings', value: lines.join('\n').slice(0, 1024) || ' ' });
  return embed;
}

function buildTriviaLeaderboardEmbed({ items }) {
  const rows = Array.isArray(items) ? items.filter((x) => x && typeof x === 'object') : [];
  const embed = new EmbedBuilder().setTitle('🎯 Trivia Leaderboard').setDescription(rows.length ? 'ranked by trivia points in this server' : 'No trivia data yet.');

  if (!rows.length) return embed;

  const lines = [];
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const it = rows[i];
    const userId = it.userDiscordUserId != null ? String(it.userDiscordUserId) : '';
    const points = Number.isFinite(Number(it.points)) ? Number(it.points) : 0;
    const wins = Number.isFinite(Number(it.roundWins)) ? Number(it.roundWins) : 0;
    const correct = Number.isFinite(Number(it.correctAnswers)) ? Number(it.correctAnswers) : 0;
    const xp = Number.isFinite(Number(it.xpEarned)) ? Number(it.xpEarned) : 0;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
    lines.push(
      medal + ' ' + String(i + 1) + '. <@' + userId + '> — 🎯 ' + String(points) + ' pts | 🏆 ' + String(wins) + ' wins | ✅ ' + String(correct) + ' correct | ⚡ ' + String(xp) + ' xp'
    );
  }

  embed.addFields({ name: 'Rankings', value: lines.join('\n').slice(0, 1024) || ' ' });
  return embed;
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

async function publicApiGetJson(pathWithQuery) {
  const base = botApiBaseUrl();
  if (!base) return { ok: false, status: 0, error: 'FEEDVERSE_API_BASE_URL is not set' };

  const url = base + pathWithQuery;
  const res = await fetchJsonWithInit(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!res.ok) {
    const msg =
      res.json && typeof res.json.error === 'string'
        ? res.json.error
        : res.text && String(res.text).trim()
          ? String(res.text).slice(0, 300)
          : 'Request failed (HTTP ' + String(res.status) + ')';
    return { ok: false, status: Number(res.status || 0), error: msg };
  }

  return { ok: true, status: Number(res.status || 200), json: res.json };
}

let __approvedPromptPacksCache = { atMs: 0, packs: [] };

async function getApprovedPromptPacksCached() {
  const ttlMs = 5 * 60 * 1000;
  const now = Date.now();
  if (__approvedPromptPacksCache.packs.length > 0 && now - __approvedPromptPacksCache.atMs < ttlMs) {
    return __approvedPromptPacksCache.packs;
  }

  const r = await publicApiGetJson('/v1/au/prompts?limit=500');
  if (!r.ok) return __approvedPromptPacksCache.packs;

  const items = r.json && Array.isArray(r.json.items) ? r.json.items : [];
  const packs = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const universeId = it.settingId != null ? String(it.settingId) : '';
    const dynamicId = it.dynamicId != null ? String(it.dynamicId) : '';
    const promptText = it.promptText != null ? String(it.promptText) : '';
    if (!universeId || !dynamicId || !promptText) continue;
    packs.push({ universeId, dynamicId, summaries: [promptText] });
  }

  __approvedPromptPacksCache = { atMs: now, packs };
  return packs;
}

async function getMergedPacksForGenerate(au, universeId, dynamicId) {
  const basePacks = au && Array.isArray(au.packs) ? au.packs : [];
  const approvedPacks = await getApprovedPromptPacksCached();
  const merged = approvedPacks.length > 0 ? basePacks.concat(approvedPacks) : basePacks;
  return filterPacks(merged, universeId, dynamicId);
}

function botApiSecret() {
  const v = normalizeOption(process.env.FEEDVERSE_BOT_API_SECRET);
  return v || null;
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
    const msg =
      res.json && typeof res.json.error === 'string'
        ? res.json.error
        : res.text && String(res.text).trim()
          ? String(res.text).slice(0, 300)
          : 'Request failed (HTTP ' + String(res.status) + ')';
    return { ok: false, status: Number(res.status || 0), error: msg };
  }

  return { ok: true, status: Number(res.status || 200), json: res.json };
}

async function botApiPostJsonNoThrow(path, bodyObj) {
  try {
    return await botApiPostJson(path, bodyObj);
  } catch (e) {
    return { ok: false, status: 0, error: e && e.message ? String(e.message) : 'Request failed' };
  }
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
    const msg =
      res.json && typeof res.json.error === 'string'
        ? res.json.error
        : res.text && String(res.text).trim()
          ? String(res.text).slice(0, 300)
          : 'Request failed (HTTP ' + String(res.status) + ')';
    return { ok: false, status: Number(res.status || 0), error: msg };
  }

  return { ok: true, status: Number(res.status || 200), json: res.json };
}

function startDailyScheduler(client, au) {
  async function tick() {
    try {
      const now = new Date();

      const list = await botApiGetJson('/v1/au/daily-configs?limit=5000');
      if (!list.ok) return;
      const items = list.json && Array.isArray(list.json.items) ? list.json.items : [];

      for (const it of items) {
        if (!it || typeof it !== 'object') continue;

        const guildId = it.guildId ? String(it.guildId) : '';
        const channelId = it.channelId ? String(it.channelId) : '';
        const sendAt = Number.isFinite(Number(it.sendAtMinutesLocal)) ? Number(it.sendAtMinutesLocal) : 0;
        const timeZone = it.timeZone != null ? String(it.timeZone) : null;
        const lastSentDate = it.lastSentLocalDate != null ? String(it.lastSentLocalDate) : null;

        if (!guildId || !channelId) continue;

        const zoned = timeZone ? timeZoneDateKeyAndMinutes(now, timeZone) : null;
        const today = zoned ? zoned.dateKey : localDateKey(now);
        const nowMin = zoned ? zoned.minutes : localMinutesOfDay(now);
        if (lastSentDate === today) continue;
        if (nowMin < sendAt) continue;

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || typeof channel.send !== 'function') continue;

        const matching = await getMergedPacksForGenerate(au, null, null);
        const pickedPack = choice(matching);
        if (!pickedPack) continue;
        const summary = pickSummary(pickedPack);
        if (!summary) continue;

        const settingId = pickedPack && pickedPack.universeId ? String(pickedPack.universeId) : '';
        const dynamicId = pickedPack && pickedPack.dynamicId ? String(pickedPack.dynamicId) : '';
        const settingLabel = formatUniverseLabel(au, settingId);
        const dynamicLabel = formatDynamicLabel(au, dynamicId);
        const lines = [];
        lines.push(settingLabel + ' + ' + dynamicLabel);
        lines.push(summary);
        const dailyComponents = withFavoriteButton([], { source: 'daily', settingId, dynamicId });
        const msg = await channel.send({ content: lines.join('\n'), components: dailyComponents });

        // Best-effort: start a thread for discussion.
        try {
          if (msg && typeof msg.startThread === 'function') {
            await msg.startThread({
              name: makeThreadNameFromPrompt(summary),
              autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
            });
          }
        } catch {
          // ignore thread creation errors (missing perms / channel type)
        }

        await botApiPostJsonNoThrow('/v1/au/daily-configs/mark-sent', { guildId, localDate: today });
      }
    } catch {
      // ignore
    }
  }

  // Run once shortly after boot, then every minute.
  setTimeout(tick, 10 * 1000);
  setInterval(tick, 60 * 1000);
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
  const clientId = normalizeOption(process.env.DISCORD_CLIENT_ID);
  const devGuildId = normalizeOption(process.env.DISCORD_GUILD_ID);
  const officialGuildId = normalizeOption(process.env.OFFICIAL_GUILD_ID);
  let triviaMessageContentEnabled = true;

  const auPath = resolveAuDataPath();
  const au = loadAuData(auPath);
  const triviaPath = resolveTriviaDataPath();
  const trivia = loadTriviaData(triviaPath);
  // Store for DM formatting helper (avoids threading au everywhere).
  globalThis.__auDataForDM = au;

  const globalCommands = buildGlobalCommands();
  const officialGuildCommands = buildOfficialGuildCommands();
  if (!clientId) {
    process.stderr.write('Warning: DISCORD_CLIENT_ID is missing; skipping slash-command registration.\n');
  } else {
    try {
      await registerCommands(token, clientId, devGuildId, officialGuildId, globalCommands, officialGuildCommands);
    } catch (e) {
      process.stderr.write('Warning: failed to register slash commands; continuing to run bot.\n');
      process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
    }
  }

  function createConfiguredClient(includeMessageContent) {
    const nextClient = new Client({ intents: buildClientIntents(includeMessageContent) });
    nextClient.commands = new Collection();
    for (const cmd of [...globalCommands, ...officialGuildCommands]) {
      nextClient.commands.set(cmd.name, cmd);
    }
    return nextClient;
  }

  let client = createConfiguredClient(triviaMessageContentEnabled);

  const handleClientReady = (c) => {
    process.stdout.write('Logged in as ' + c.user.tag + '\n');
    process.stdout.write('Loaded AU data: ' + au.packs.length + ' packs\n');
    process.stdout.write(
      'Loaded trivia data: ' + String(trivia.categories.length) + ' categories' + (trivia.exists ? '' : ' (file not found)') + '\n'
    );
    if (!triviaMessageContentEnabled) {
      process.stdout.write(
        'Trivia answer matching is disabled because this Discord application does not have Message Content intent enabled. Enable it in the Discord developer portal and redeploy to use /trivia start.\n'
      );
    }

    startDailyScheduler(client, au);
  };

  const handleInteractionCreate = async (interaction) => {
    installInteractionResponseCompat(interaction);
    try {
      if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused(true);
        const value = normalizeOption(focused.value) || '';

        if (focused.name === 'universe' || focused.name === 'setting') {
          const items = au.universes.map((u) => ({
            name: (u.emoji ? u.emoji + ' ' : '') + u.label,
            value: u.id
          }));
          const choices = toAutocompleteChoices(items, value, 25);
          await interaction.respond(choices);
          return;
        }

        if (focused.name === 'dynamic') {
          const items = au.dynamics.map((d) => ({
            name: (d.emoji ? d.emoji + ' ' : '') + d.label,
            value: d.id
          }));
          const choices = toAutocompleteChoices(items, value, 25);
          await interaction.respond(choices);
          return;
        }

        if (focused.name === 'category') {
          const items = trivia.categories.map((category) => ({
            name: trunc(category.label + ' (' + String(category.questions.length) + ')', 100),
            value: category.id
          }));
          const choices = toAutocompleteChoices(items, value, 25);
          await interaction.respond(choices);
          return;
        }

        if (focused.name === 'timezone') {
          const query = value.toLowerCase();
          const choices = (query
            ? SUPPORTED_IANA_TIME_ZONES.filter((tz) => tz.toLowerCase().includes(query))
            : SUPPORTED_IANA_TIME_ZONES
          )
            .slice(0, 25)
            .map((tz) => ({ name: tz, value: tz }));

          await interaction.respond(choices);
          return;
        }

        if (focused.name === 'character') {
          const codeRaw = interaction.options.getString('code');
          const code = normalizeInviteCode(codeRaw || '');
          if (!code) {
            await interaction.respond([]);
            return;
          }

          const r = await botApiGetJson(
            '/v1/bot/oc/characters?inviteCode=' + encodeURIComponent(code) + '&q=' + encodeURIComponent(value) + '&limit=25'
          );
          if (!r.ok) {
            await interaction.respond([]);
            return;
          }

          const items = r.json && Array.isArray(r.json.items) ? r.json.items : [];
          const choices = items
            .map((it) => {
              const handle = it && it.handle != null ? String(it.handle) : '';
              const displayName = it && it.displayName != null ? String(it.displayName) : '';
              const name = trunc((displayName || handle || 'Character') + (handle ? ' (@' + handle + ')' : ''), 100);
              return { name, value: handle };
            })
            .filter((c) => c && c.value)
            .slice(0, 25);

          await interaction.respond(choices);
          return;
        }

        await interaction.respond([]);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        const id = String(interaction.customId || '');
        if (!id.startsWith('fav:pick:')) return;

        const cursorEnc = id.split(':')[2] || '0';
        const histEnc = id.split(':')[3] || '-';
        const picked = Array.isArray(interaction.values) && interaction.values[0] ? String(interaction.values[0]) : null;
        const beforeIdNum = decodeCursorBase36(cursorEnc);
        const beforeId = beforeIdNum > 0 ? beforeIdNum : null;
        const history = decodeCursorHistory(histEnc);

        const page = await fetchFavoritesPage(interaction.user.id, { beforeId, limit: 10 });
        if (!page.ok) {
          await interaction.reply({ content: 'Error loading favorites: ' + page.error, ephemeral: interaction.inGuild() });
          return;
        }

        const items = page.json.items;
        const msg = buildFavoritesPageMessage({
          au,
          items,
          cursorBeforeId: beforeId,
          nextBeforeId: page.json.nextBeforeId,
          selectedId: picked,
          mode: 'normal',
          history
        });
        await interaction.update({ embeds: msg.embeds, components: msg.components });
        return;
      }

      if (interaction.isButton()) {
        const id = String(interaction.customId || '');

        if (id.startsWith('trivia:cats:')) {
          const parts = id.split(':');
          const ownerUserId = parts[2] || '';
          const page = Math.max(0, parseInt(parts[3] || '0', 10) || 0);

          if (!ownerUserId || String(interaction.user.id) !== String(ownerUserId)) {
            await interaction.reply({
              content: 'Run /trivia categories to get your own pagination buttons.',
              ephemeral: true
            });
            return;
          }

          const msg = buildTriviaCategoryPageMessage({
            categories: trivia.categories,
            ownerUserId: interaction.user.id,
            page
          });
          await interaction.update({ content: msg.content, components: msg.components });
          return;
        }

        if (id.startsWith('oc:tab:')) {
          const parts = id.split(':');
          const tabKey = parts[2] || 'ov';
          const inviteCode = parts[3] || '';
          const profileIdCompact = parts[4] || '';

          await interaction.deferUpdate();

          const r = await fetchOcSharePayload({ inviteCode, profileIdCompact });
          if (!r.ok) {
            await interaction.followUp({ content: 'Error loading character: ' + r.error, ephemeral: true });
            return;
          }

          const payload = r.json;
          const profileId = payload && payload.profile && payload.profile.id ? String(payload.profile.id) : '';
          const pidCompact = compactUuid(profileId) || compactUuid(profileIdCompact) || profileIdCompact;
          const msg = await buildOcShareMessage(payload, tabKey);
          const components = buildOcTabComponents({ tabKey, inviteCode, profileIdCompact: pidCompact });

          await interaction.editReply({ embeds: msg.embeds, files: msg.files, attachments: msg.attachments, components });
          return;
        }

        if (id.startsWith('fav:')) {
          const parts = id.split(':');
          const action = parts[1] || '';

          if (action === 'refresh') {
            const page = await fetchFavoritesPage(interaction.user.id, { beforeId: null, limit: 10 });
            if (!page.ok) {
              await interaction.reply({ content: 'Error loading favorites: ' + page.error, ephemeral: interaction.inGuild() });
              return;
            }

            const items = page.json.items;
            const nextBeforeId = page.json.nextBeforeId;
            const msg = buildFavoritesPageMessage({
              au,
              items,
              cursorBeforeId: null,
              nextBeforeId,
              selectedId: null,
              mode: 'normal',
              history: []
            });
            await interaction.update({ embeds: msg.embeds, components: msg.components });
            return;
          }

          if (action === 'next') {
            const nextEnc = parts[2] || '0';
            const cursorEnc = parts[3] || '0';
            const histEnc = parts[4] || '-';

            const nextCursorBeforeId = decodeCursorBase36(nextEnc);
            if (!nextCursorBeforeId) return;
            const currentBeforeId = decodeCursorBase36(cursorEnc);
            const history = decodeCursorHistory(histEnc);
            const newHistory = history.concat([currentBeforeId]);

            const beforeId = nextCursorBeforeId > 0 ? nextCursorBeforeId : null;
            const page = await fetchFavoritesPage(interaction.user.id, { beforeId, limit: 10 });
            if (!page.ok) {
              await interaction.reply({ content: 'Error loading favorites: ' + page.error, ephemeral: interaction.inGuild() });
              return;
            }

            const items = page.json.items;
            const msg = buildFavoritesPageMessage({
              au,
              items,
              cursorBeforeId: beforeId,
              nextBeforeId: page.json.nextBeforeId,
              selectedId: null,
              mode: 'normal',
              history: newHistory
            });
            await interaction.update({ embeds: msg.embeds, components: msg.components });
            return;
          }

          if (action === 'prev') {
            const cursorEnc = parts[2] || '0';
            const histEnc = parts[3] || '-';

            const history = decodeCursorHistory(histEnc);
            if (history.length === 0) return;
            const prevBeforeId = history[history.length - 1];
            const newHistory = history.slice(0, Math.max(0, history.length - 1));

            const beforeId = prevBeforeId > 0 ? prevBeforeId : null;
            const page = await fetchFavoritesPage(interaction.user.id, { beforeId, limit: 10 });
            if (!page.ok) {
              await interaction.reply({ content: 'Error loading favorites: ' + page.error, ephemeral: interaction.inGuild() });
              return;
            }

            const msg = buildFavoritesPageMessage({
              au,
              items: page.json.items,
              cursorBeforeId: beforeId,
              nextBeforeId: page.json.nextBeforeId,
              selectedId: null,
              mode: 'normal',
              history: newHistory
            });

            await interaction.update({ embeds: msg.embeds, components: msg.components });
            return;
          }

          if (action === 'rm') {
            const favId = parts[2] || 'none';
            const cursorEnc = parts[3] || '0';
            const histEnc = parts[4] || '-';
            if (!favId || favId === 'none') return;

            const beforeIdNum = decodeCursorBase36(cursorEnc);
            const beforeId = beforeIdNum > 0 ? beforeIdNum : null;
            const history = decodeCursorHistory(histEnc);
            const page = await fetchFavoritesPage(interaction.user.id, { beforeId, limit: 10 });
            if (!page.ok) {
              await interaction.reply({ content: 'Error loading favorites: ' + page.error, ephemeral: interaction.inGuild() });
              return;
            }

            const msg = buildFavoritesPageMessage({
              au,
              items: page.json.items,
              cursorBeforeId: beforeId,
              nextBeforeId: page.json.nextBeforeId,
              selectedId: favId,
              mode: 'confirm',
              history
            });

            await interaction.update({
              content: 'Remove this favorite? This cannot be undone.',
              embeds: msg.embeds,
              components: msg.components
            });
            return;
          }

          if (action === 'confirm') {
            const favId = parts[2] || 'none';
            const cursorEnc = parts[3] || '0';
            const histEnc = parts[4] || '-';
            if (!favId || favId === 'none') return;

            const del = await botApiPostJson('/v1/au/favorites/delete', {
              userDiscordUserId: String(interaction.user.id),
              id: favId
            });

            if (!del.ok || !(del.json && del.json.ok)) {
              await interaction.update({
                content: 'Failed to remove favorite: ' + (del.ok ? 'Not found.' : del.error),
                components: []
              });
              return;
            }

            const beforeIdNum = decodeCursorBase36(cursorEnc);
            const beforeId = beforeIdNum > 0 ? beforeIdNum : null;
            const history = decodeCursorHistory(histEnc);
            const page = await fetchFavoritesPage(interaction.user.id, { beforeId, limit: 10 });
            if (!page.ok) {
              await interaction.update({ content: 'Removed, but failed to reload list: ' + page.error, components: [] });
              return;
            }

            const items = page.json.items;
            const nextBeforeId = page.json.nextBeforeId;
            const msg = buildFavoritesPageMessage({
              au,
              items,
              cursorBeforeId: beforeId,
              nextBeforeId,
              selectedId: null,
              mode: 'normal',
              history
            });

            await interaction.update({ content: null, embeds: msg.embeds, components: msg.components });
            return;
          }

          if (action === 'cancel') {
            const favId = parts[2] || 'none';
            const cursorEnc = parts[3] || '0';
            const histEnc = parts[4] || '-';

            const beforeIdNum = decodeCursorBase36(cursorEnc);
            const beforeId = beforeIdNum > 0 ? beforeIdNum : null;
            const history = decodeCursorHistory(histEnc);
            const page = await fetchFavoritesPage(interaction.user.id, { beforeId, limit: 10 });
            if (!page.ok) {
              await interaction.update({ content: 'Error loading favorites: ' + page.error, components: [] });
              return;
            }

            const msg = buildFavoritesPageMessage({
              au,
              items: page.json.items,
              cursorBeforeId: beforeId,
              nextBeforeId: page.json.nextBeforeId,
              selectedId: favId !== 'none' ? favId : null,
              mode: 'normal',
              history
            });

            await interaction.update({ content: null, embeds: msg.embeds, components: msg.components });
            return;
          }

          const source = decodeCustomIdPart(parts[2] || '-') || 'generate';
          const settingId = decodeCustomIdPart(parts[3] || '-') || null;
          const dynamicId = decodeCustomIdPart(parts[4] || '-') || null;

          if (action !== 'add') return;

          const promptText = extractPromptTextFromFavoriteMessage(interaction.message);
          if (!promptText) {
            await interaction.reply({ content: 'Could not read prompt text from this message.', ephemeral: true });
            return;
          }

          const normalizedPrompt = normalizePromptForKey(promptText).slice(0, 2000);
          const res = await botApiPostJson('/v1/au/favorites', {
            userDiscordUserId: String(interaction.user.id),
            settingId,
            dynamicId,
            promptText: normalizedPrompt,
            source
          });

          if (!res.ok) {
            await interaction.reply({ content: 'Error saving favorite: ' + res.error, ephemeral: true });
            return;
          }

          const created = Boolean(res.json && res.json.created);
          await interaction.reply({ content: created ? 'Saved to your favorites.' : 'Already in your favorites.', ephemeral: true });
          return;
        }

        if (id.startsWith('prof:page:')) {
          const parts = id.split(':');
          const ownerUserId = parts[2] || '';
          const targetUserId = parts[3] || '';
          const pageRaw = parts[4] || '0';
          const page = Math.max(0, parseInt(pageRaw, 10) || 0);

          if (!ownerUserId || String(interaction.user.id) !== String(ownerUserId)) {
            await interaction.reply({
              content: 'Run /profile to get your own pagination buttons.',
              ephemeral: true
            });
            return;
          }

          const PAGE_SIZE = 10;
          const offset = page * PAGE_SIZE;
          const r = await botApiGetJson(
            '/v1/au/profile?userDiscordUserId=' + encodeURIComponent(String(targetUserId)) + '&limit=' + String(PAGE_SIZE) + '&offset=' + String(offset)
          );
          if (!r.ok) {
            await interaction.reply({ content: 'Error loading profile: ' + r.error, ephemeral: true });
            return;
          }

          const hasMore = Boolean(r.json && r.json.pagination && r.json.pagination.hasMore);
          const embed = buildProfileEmbed({ au, userId: targetUserId, profile: r.json, page, pageSize: PAGE_SIZE });
          const components = buildProfileComponents({
            ownerUserId: interaction.user.id,
            targetUserId,
            page,
            hasMore
          });

          await interaction.update({ embeds: [embed], components });
          return;
        }

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

        // Use the same merged pool as /generate (local JSON + approved DB prompts).
        const mergedAllPacks = await getMergedPacksForGenerate(au, null, null);

        if (action === 'remixpick') {
          if (remixMode === 'dynamic') {
            nextDynamicId = pickAlternateDynamicId(au, mergedAllPacks, nextUniverseId, nextDynamicId);
          } else if (remixMode === 'universe') {
            nextUniverseId = pickAlternateUniverseId(au, mergedAllPacks, nextDynamicId, nextUniverseId);
          } else {
            const out = pickAlternateUniverseAndDynamic(au, mergedAllPacks, nextUniverseId, nextDynamicId);
            nextUniverseId = out.universeId;
            nextDynamicId = out.dynamicId;
          }
        }

        const matching = await getMergedPacksForGenerate(au, nextUniverseId, nextDynamicId);
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

        const pickedUniverseId = pickedPack && pickedPack.universeId ? String(pickedPack.universeId) : null;
        const pickedDynamicId = pickedPack && pickedPack.dynamicId ? String(pickedPack.dynamicId) : null;
        const embed = buildGenerateMetaEmbed(au, pickedUniverseId, pickedDynamicId);

        const components = withFavoriteButton(
          buildGenerateComponents({
            ownerUserId: interaction.user.id,
            universeId: nextUniverseId,
            dynamicId: nextDynamicId
          }),
          {
            source: 'generate',
            settingId: pickedPack && pickedPack.universeId ? String(pickedPack.universeId) : null,
            dynamicId: pickedPack && pickedPack.dynamicId ? String(pickedPack.dynamicId) : null
          }
        );

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

      if (interaction.commandName === 'help') {
        const msg = buildHelpMessage();
        await interaction.reply({ embeds: msg.embeds, components: msg.components });
        return;
      }

      if (interaction.commandName === 'profile') {
        const optUser = interaction.options.getUser('user');
        const userId = optUser && optUser.id ? String(optUser.id) : interaction.user && interaction.user.id ? String(interaction.user.id) : '';

        const PAGE_SIZE = 10;
        const page = 0;
        const r = await botApiGetJson(
          '/v1/au/profile?userDiscordUserId=' + encodeURIComponent(userId) + '&limit=' + String(PAGE_SIZE) + '&offset=0'
        );
        if (!r.ok) {
          await interaction.reply({ content: 'Error loading profile: ' + r.error, ephemeral: interaction.inGuild() });
          return;
        }

        const hasMore = Boolean(r.json && r.json.pagination && r.json.pagination.hasMore);
        const embed = buildProfileEmbed({ au, userId, profile: r.json, page, pageSize: PAGE_SIZE });
        const components = buildProfileComponents({
          ownerUserId: interaction.user.id,
          targetUserId: userId,
          page,
          hasMore
        });
        await interaction.reply({ embeds: [embed], components });
        return;
      }

      if (interaction.commandName === 'leaderboard') {
        if (!interaction.inGuild() || !interaction.guildId) {
          await interaction.reply({
            content: 'This leaderboard is per-server. Run `/' + 'leaderboard` in a server.',
            ephemeral: interaction.inGuild()
          });
          return;
        }

        const r = await botApiGetJson(
          '/v1/au/leaderboard?guildId=' + encodeURIComponent(String(interaction.guildId)) + '&limit=10'
        );
        if (!r.ok) {
          await interaction.reply({ content: 'Error loading leaderboard: ' + r.error, ephemeral: interaction.inGuild() });
          return;
        }

        const items = r.json && Array.isArray(r.json.items) ? r.json.items : [];
        const embed = buildLeaderboardEmbed({ items });
        await interaction.reply({ embeds: [embed] });
        return;
      }

      if (interaction.commandName === 'generate') {
        const universeId = normalizeOption(interaction.options.getString('universe'));
        const dynamicId = normalizeOption(interaction.options.getString('dynamic'));

        const matching = await getMergedPacksForGenerate(au, universeId, dynamicId);
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

        // Always display the picked prompt's universe + dynamic.
        const pickedUniverseId = pickedPack && pickedPack.universeId ? String(pickedPack.universeId) : null;
        const pickedDynamicId = pickedPack && pickedPack.dynamicId ? String(pickedPack.dynamicId) : null;
        const embed = buildGenerateMetaEmbed(au, pickedUniverseId, pickedDynamicId);

        const components = withFavoriteButton(
          buildGenerateComponents({
            ownerUserId: interaction.user.id,
            universeId,
            dynamicId
          }),
          {
            source: 'generate',
            settingId: pickedPack && pickedPack.universeId ? String(pickedPack.universeId) : null,
            dynamicId: pickedPack && pickedPack.dynamicId ? String(pickedPack.dynamicId) : null
          }
        );

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

        const normalizedPromptText = normalizeSubmittedPromptText(promptText);

        const submitter = interaction.user;
        const submitterName = submitter && typeof submitter.tag === 'string' ? submitter.tag : submitter.username;

        const res = await botApiPostJson('/v1/au/prompt-submissions', {
          settingId,
          dynamicId,
          promptText: normalizedPromptText,
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
          content: 'Submitted for review.',
          ephemeral: interaction.inGuild()
        });
        return;
      }

      if (interaction.commandName === 'trivia') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'categories') {
          const msg = buildTriviaCategoryPageMessage({
            categories: trivia.categories,
            ownerUserId: interaction.user.id,
            page: 0
          });
          await interaction.reply({
            content: msg.content,
            components: msg.components
          });
          return;
        }

        if (sub === 'leaderboard') {
          if (!interaction.inGuild() || !interaction.guildId) {
            await interaction.reply({ content: 'This trivia leaderboard is per-server. Run `/' + 'trivia leaderboard` in a server.', ephemeral: interaction.inGuild() });
            return;
          }

          const r = await botApiGetJson('/v1/au/trivia/leaderboard?guildId=' + encodeURIComponent(String(interaction.guildId)) + '&limit=10');
          if (!r.ok) {
            await interaction.reply({ content: 'Error loading trivia leaderboard: ' + r.error, ephemeral: interaction.inGuild() });
            return;
          }

          const items = r.json && Array.isArray(r.json.items) ? r.json.items : [];
          await interaction.reply({ embeds: [buildTriviaLeaderboardEmbed({ items })] });
          return;
        }

        if (sub === 'stats') {
          const optUser = interaction.options.getUser('user');
          const userId = optUser && optUser.id ? String(optUser.id) : String(interaction.user.id);
          const guildId = interaction.inGuild() && interaction.guildId ? String(interaction.guildId) : null;
          const query = '/v1/au/trivia/profile?userDiscordUserId=' + encodeURIComponent(userId) + (guildId ? '&guildId=' + encodeURIComponent(guildId) : '');
          const r = await botApiGetJson(query);
          if (!r.ok) {
            await interaction.reply({ content: 'Error loading trivia stats: ' + r.error, ephemeral: interaction.inGuild() });
            return;
          }

          await interaction.reply({ embeds: [buildTriviaStatsEmbed({ userId, stats: r.json, guildId })] });
          return;
        }

        if (sub !== 'start') {
          await interaction.reply({ content: 'Unknown trivia command.', ephemeral: true });
          return;
        }

        if (!triviaMessageContentEnabled) {
          await interaction.reply({
            content:
              'Trivia rounds are disabled on this deployment because Discord rejected Message Content intent for this bot. Enable Message Content in the Discord developer portal and redeploy to use /trivia start.',
            ephemeral: true
          });
          return;
        }

        if (!interaction.inGuild() || !interaction.guildId || !interaction.channelId || !interaction.channel) {
          await interaction.reply({ content: 'Trivia rounds can only run in a server channel.', ephemeral: true });
          return;
        }

        const categoryId = normalizeOption(interaction.options.getString('category'));
        const requestedCount = interaction.options.getInteger('questions') || 10;
        const category = categoryId ? trivia.categoryById.get(categoryId) : null;

        if (!category) {
          await interaction.reply({ content: 'Unknown trivia category. Use the autocomplete picker.', ephemeral: true });
          return;
        }

        if (!Array.isArray(category.questions) || category.questions.length === 0) {
          await interaction.reply({ content: 'That category has no questions yet.', ephemeral: true });
          return;
        }

        const existingRound = activeTriviaRounds.get(String(interaction.channelId));
        if (existingRound && !existingRound.finished) {
          await interaction.reply({ content: 'A trivia round is already running in this channel.', ephemeral: true });
          return;
        }

        const pickedQuestions = shuffleArray(category.questions).slice(0, Math.min(requestedCount, category.questions.length));
        const round = {
          channelId: String(interaction.channelId),
          guildId: String(interaction.guildId),
          channel: interaction.channel,
          startedByUserId: String(interaction.user.id),
          categoryId: category.id,
          categoryLabel: category.label,
          questions: pickedQuestions,
          currentIndex: 0,
          currentQuestionState: null,
          nextQuestionTimerId: null,
          scores: new Map(),
          correctCounts: new Map(),
          xpAwards: new Map(),
          finished: false
        };

        activeTriviaRounds.set(round.channelId, round);

        await interaction.reply({ embeds: [buildTriviaRoundIntroEmbed(round)] });

        try {
          await postTriviaQuestion(round);
        } catch (err) {
          activeTriviaRounds.delete(round.channelId);
          clearTriviaRoundTimers(round);
          throw err;
        }
        return;
      }

      if (interaction.commandName === 'setup') {
        if (!interaction.inGuild() || !interaction.guildId) {
          await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
          return;
        }

        const perms = interaction.memberPermissions;
        if (!perms || !perms.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: 'You need Administrator permission to use this command.', ephemeral: true });
          return;
        }

        const sub = interaction.options.getSubcommand();
        if (sub !== 'daily') {
          await interaction.reply({ content: 'Unknown setup command.', ephemeral: true });
          return;
        }

        const channel = interaction.options.getChannel('channel', true);
        const channelId = channel && channel.id ? String(channel.id) : '';
        if (!channelId) {
          await interaction.reply({ content: 'Invalid channel.', ephemeral: true });
          return;
        }

        const timeRaw = normalizeOption(interaction.options.getString('time'));
        const parsedMinutes = timeRaw ? parseLocalTimeToMinutes(timeRaw) : null;
        if (timeRaw && parsedMinutes == null) {
          await interaction.reply({ content: 'Invalid time. Examples: 21:30 or 9:30pm.', ephemeral: true });
          return;
        }

        const timeZoneRaw = normalizeOption(interaction.options.getString('timezone'));
        const timeZoneToStore = timeZoneRaw ? String(timeZoneRaw).trim() : null;
        if (timeZoneToStore && !isValidTimeZone(timeZoneToStore)) {
          await interaction.reply({
            content: 'Invalid timezone. Use an IANA timezone like America/New_York, Europe/London, or Asia/Tokyo.',
            ephemeral: true
          });
          return;
        }

        const now = new Date();
        const zonedNow = timeZoneToStore ? timeZoneDateKeyAndMinutes(now, timeZoneToStore) : null;
        const sendAt = parsedMinutes != null ? parsedMinutes : zonedNow ? zonedNow.minutes : localMinutesOfDay(now);

        const up = await botApiPostJson('/v1/au/daily-configs', {
          guildId: String(interaction.guildId),
          channelId,
          sendAtMinutesLocal: sendAt,
          timeZone: timeZoneToStore
        });
        if (!up.ok) {
          await interaction.reply({ content: 'Failed to save daily config: ' + up.error, ephemeral: true });
          return;
        }

        const t = formatMinutesAsTime(sendAt);
        await interaction.reply({
          content:
            'Daily prompt enabled for ' +
            String(channel) +
            (t ? ' at ' + t + (timeZoneToStore ? ' (' + timeZoneToStore + ').' : '.') : timeZoneToStore ? ' (' + timeZoneToStore + ').' : '.') +
            ' Time examples: 21:30 or 9:30pm.',
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === 'view') {
        const sub = interaction.options.getSubcommand();
        if (sub !== 'favorites') {
          await interaction.reply({ content: 'Unknown view command.', ephemeral: true });
          return;
        }

        const r = await fetchFavoritesPage(interaction.user.id, { beforeId: null, limit: 10 });
        if (!r.ok) {
          await interaction.reply({ content: 'Error loading favorites: ' + r.error, ephemeral: interaction.inGuild() });
          return;
        }

        const items = r.json.items;
        if (items.length === 0) {
          await interaction.reply({ content: 'No favorites yet. Use the Favorite button on a prompt.' });
          return;
        }

        const msg = buildFavoritesPageMessage({
          au,
          items,
          cursorBeforeId: null,
          nextBeforeId: r.json.nextBeforeId,
          selectedId: null,
          mode: 'normal',
          history: []
        });
        await interaction.reply({
          embeds: msg.embeds,
          components: msg.components
        });
        return;
      }

      if (interaction.commandName === 'share') {
        const rawCode = interaction.options.getString('code');
        const rawCharacter = interaction.options.getString('character');
        const code = normalizeInviteCode(rawCode || '');
        const character = typeof rawCharacter === 'string' ? rawCharacter.trim() : '';

        if (!code) {
          await interaction.reply({
            content: 'Invalid invite code. Use 6–20 chars: A–Z and 0–9 (example: KPOP2024).',
            ephemeral: true
          });
          return;
        }
        // If character is provided, share the OC viewer.
        if (character) {
          await interaction.deferReply();

          const r = await fetchOcSharePayload({ inviteCode: code, handle: character });
          if (!r.ok) {
            await interaction.editReply('Error loading character: ' + r.error);
            return;
          }

          const payload = r.json;
          const profileId = payload && payload.profile && payload.profile.id ? String(payload.profile.id) : '';
          const pidCompact = compactUuid(profileId) || null;
          if (!pidCompact) {
            await interaction.editReply('Error: invalid character profile id from API.');
            return;
          }

          const tabKey = 'ov';
          const msg = await buildOcShareMessage(payload, tabKey);
          const components = buildOcTabComponents({ tabKey, inviteCode: code, profileIdCompact: pidCompact });
          await interaction.editReply({ embeds: msg.embeds, files: msg.files, attachments: msg.attachments, components });
          return;
        }

        // Default: share the scenario from invite code (previous behavior).
        const joinLink = buildJoinLink(code);
        const brandIcon = getBrandIconUrl();

        const resolved = await resolveScenarioByInviteCode(code);
        if (resolved.ok && resolved.status === 0) {
          const embed = new EmbedBuilder().setTitle('Feedverse').setThumbnail(brandIcon);
          embed.addFields([{ name: 'Invite code', value: code, inline: true }]);

          const components = [];
          if (joinLink) {
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join').setURL(joinLink)
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
        const name = scenario && typeof scenario.name === 'string' ? scenario.name : 'Feedverse universe';
        const cover = scenario && typeof scenario.cover === 'string' ? scenario.cover : '';
        const description = scenario && typeof scenario.description === 'string' ? scenario.description : '';

        const players = formatPlayers(scenario);
        const mode = formatMode(scenario && scenario.mode);
        const tags = formatTags(scenario);
        const faceClaims = Array.isArray(scenario && scenario.face_claims)
          ? scenario.face_claims.map((value) => String(value ?? '').trim()).filter(Boolean)
          : [];

        const embed = new EmbedBuilder().setTitle(name).setThumbnail(brandIcon);
        if (description) embed.setDescription(description.slice(0, 300));
        if (cover) embed.setImage(cover);

        const fields = [{ name: 'Invite code', value: code, inline: true }];
        if (players) fields.push({ name: 'Players', value: players, inline: true });
        if (mode) fields.push({ name: 'Mode', value: mode, inline: true });
        if (tags) fields.push({ name: 'Tags', value: tags, inline: false });
        if (faceClaims.length) fields.push({ name: 'Face claims', value: faceClaims.join(', '), inline: false });
        embed.addFields(fields);

        const components = [];
        if (joinLink) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join').setURL(joinLink)
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
            await interaction.reply({ content: 'Error: ' + q.error, ephemeral: false });
            return;
          }

          const items = q.json && Array.isArray(q.json.items) ? q.json.items : [];
          if (items.length === 0) {
            await interaction.reply({ content: 'No pending submissions.', ephemeral: false });
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
            ephemeral: false
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

          const body = {
            moderatorDiscordUserId: String(mod.id),
            moderatorDiscordUsername: String(modName || '')
          };
          if (note) body.note = note;

          const r = await botApiPostJson(
            '/v1/au/prompt-submissions/' + encodeURIComponent(submissionId) + '/approve',
            body
          );
          if (!r.ok) {
            await interaction.reply({ content: 'Error: ' + r.error, ephemeral: false });
            return;
          }

          const promptId = r.json && r.json.promptId ? String(r.json.promptId) : null;
          const submission = r.json && r.json.submission ? r.json.submission : null;
          await tryDmSubmitter(client, submission, 'approved', note);
          await interaction.reply({ content: 'Approved. ' + (promptId ? 'prompt id: ' + promptId : ''), ephemeral: false });
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

          const body = {
            moderatorDiscordUserId: String(mod.id),
            moderatorDiscordUsername: String(modName || '')
          };
          if (note) body.note = note;

          const r = await botApiPostJson(
            '/v1/au/prompt-submissions/' + encodeURIComponent(submissionId) + '/reject',
            body
          );
          if (!r.ok) {
            await interaction.reply({ content: 'Error: ' + r.error, ephemeral: false });
            return;
          }

          const submission = r.json && r.json.submission ? r.json.submission : null;
          await tryDmSubmitter(client, submission, 'rejected', note);
          await interaction.reply({ content: 'Rejected.', ephemeral: false });
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
  };

  const handleMessageCreate = async (message) => {
    try {
      if (!triviaMessageContentEnabled) return;
      if (!message || !message.inGuild() || !message.author || message.author.bot) return;

      const round = activeTriviaRounds.get(String(message.channelId || ''));
      if (!round || round.finished) return;

      const current = round.currentQuestionState;
      if (!current || current.closed) return;

      if (!isTriviaAnswerMatch(message.content, current.question && current.question.acceptedAnswers)) return;

      await settleTriviaQuestion(round, message.author);
    } catch (err) {
      process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    }
  };

  function attachClientEventHandlers(targetClient) {
    targetClient.once(Events.ClientReady, handleClientReady);
    targetClient.on(Events.InteractionCreate, handleInteractionCreate);
    targetClient.on(Events.MessageCreate, handleMessageCreate);
  }

  attachClientEventHandlers(client);

  try {
    await client.login(token);
  } catch (err) {
    if (!triviaMessageContentEnabled || !isDisallowedIntentsError(err)) throw err;

    process.stderr.write(
      'Warning: Message Content intent is not enabled for this Discord application. Falling back to slash-command-only mode; /trivia start will be unavailable until the intent is enabled in the Discord developer portal.\n'
    );

    try {
      client.destroy();
    } catch (_) {
      // ignore cleanup errors on fallback
    }

    triviaMessageContentEnabled = false;
    client = createConfiguredClient(false);
    attachClientEventHandlers(client);
    await client.login(token);
  }

  startOptionalHealthServer();
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 1;
});
