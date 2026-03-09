const fs = require('node:fs');
const path = require('node:path');

function loadAuData(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);

  const universes = (data.definitions && data.definitions.universes) || [];
  const dynamics = (data.definitions && data.definitions.dynamics) || [];
  const packs = Array.isArray(data.packs) ? data.packs : [];

  const universeById = new Map();
  for (const u of universes) {
    if (!u || typeof u !== 'object') continue;
    if (typeof u.id !== 'string') continue;
    universeById.set(u.id, u);
  }

  const dynamicById = new Map();
  for (const d of dynamics) {
    if (!d || typeof d !== 'object') continue;
    if (typeof d.id !== 'string') continue;
    dynamicById.set(d.id, d);
  }

  return {
    filePath,
    data,
    universes,
    dynamics,
    packs,
    universeById,
    dynamicById
  };
}

function resolveAuDataPath() {
  const envPath = process.env.AU_DATA_PATH;
  if (typeof envPath === 'string' && envPath.trim() !== '') {
    return path.resolve(process.cwd(), envPath);
  }

  return path.resolve(process.cwd(), 'data', 'au_summaries_filled.json');
}

function choice(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickSummary(pack) {
  if (!pack || typeof pack !== 'object') return null;
  const summaries = pack.summaries;
  if (!Array.isArray(summaries) || summaries.length === 0) return null;
  const s = choice(summaries);
  if (typeof s !== 'string' || s.trim() === '') return null;
  return s;
}

function filterPacks(packs, universeId, dynamicId) {
  let result = packs;

  if (typeof universeId === 'string' && universeId.trim() !== '') {
    result = result.filter((p) => p && p.universeId === universeId);
  }

  if (typeof dynamicId === 'string' && dynamicId.trim() !== '') {
    result = result.filter((p) => p && p.dynamicId === dynamicId);
  }

  return result;
}

module.exports = {
  loadAuData,
  resolveAuDataPath,
  choice,
  pickSummary,
  filterPacks
};
