const { SlashCommandBuilder } = require('discord.js');

function buildCommands() {
  const generate = new SlashCommandBuilder()
    .setName('generate')
    .setDescription('Generate one AU prompt')
    .addStringOption((opt) =>
      opt
        .setName('universe')
        .setDescription('Filter by universe')
        .setAutocomplete(true)
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('dynamic')
        .setDescription('Filter by dynamic')
        .setAutocomplete(true)
        .setRequired(false)
    );

  const drop = new SlashCommandBuilder()
    .setName('drop')
    .setDescription('Share a Feedverse scenario invite code')
    .addStringOption((opt) =>
      opt
        .setName('invite_code')
        .setDescription('Scenario invite code (e.g. KPOP2024)')
        .setRequired(true)
    );

  return [generate, drop];
}

module.exports = { buildCommands };
