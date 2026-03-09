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

  return [generate];
}

module.exports = { buildCommands };
