require('dotenv').config();

const {
  loadAuData,
  resolveAuDataPath,
  filterPacks,
  pickSummary
} = require('./auData');

function main() {
  const auPath = resolveAuDataPath();
  const au = loadAuData(auPath);

  if (au.universes.length === 0) throw new Error('No universes loaded');
  if (au.dynamics.length === 0) throw new Error('No dynamics loaded');
  if (au.packs.length === 0) throw new Error('No packs loaded');

  const oneU = au.universes[0].id;
  const oneD = au.dynamics[0].id;

  const both = filterPacks(au.packs, oneU, oneD);
  const justU = filterPacks(au.packs, oneU, null);
  const justD = filterPacks(au.packs, null, oneD);

  const sBoth = both[0] ? pickSummary(both[0]) : null;
  const sJustU = justU[0] ? pickSummary(justU[0]) : null;
  const sJustD = justD[0] ? pickSummary(justD[0]) : null;

  console.log(
    JSON.stringify(
      {
        filePath: auPath,
        universes: au.universes.length,
        dynamics: au.dynamics.length,
        packs: au.packs.length,
        sample: {
          bothCount: both.length,
          justUniverseCount: justU.length,
          justDynamicCount: justD.length,
          bothSummary: sBoth,
          justUniverseSummary: sJustU,
          justDynamicSummary: sJustD
        }
      },
      null,
      2
    )
  );
}

main();
