const { SlashCommandBuilder } = require('discord.js');

function buildGlobalCommands() {
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

  const share = new SlashCommandBuilder()
    .setName('share')
    .setDescription('Share a Feedverse scenario invite code')
    .addStringOption((opt) =>
      opt
        .setName('invite_code')
        .setDescription('Scenario invite code (e.g. KPOP2024)')
        .setRequired(true)
    );

  const prompt = new SlashCommandBuilder()
    .setName('prompt')
    .setDescription('Submit an AU prompt for moderator review')
    .addStringOption((opt) =>
      opt
        .setName('setting')
        .setDescription('Setting (AU universe)')
        .setAutocomplete(true)
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('dynamic')
        .setDescription('Dynamic')
        .setAutocomplete(true)
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('prompt')
        .setDescription('The prompt text to add')
        .setRequired(true)
    );

  return [generate, share, prompt];
}

function buildOfficialGuildCommands() {
  const queue = new SlashCommandBuilder()
    .setName('prompt-queue')
    .setDescription('List pending AU prompt submissions');

  const approve = new SlashCommandBuilder()
    .setName('prompt-approve')
    .setDescription('Approve a prompt submission by id')
    .addStringOption((opt) =>
      opt
        .setName('submission_id')
        .setDescription('Submission id (UUID), short prefix, or queue index')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('note')
        .setDescription('Optional moderator note')
        .setRequired(false)
    );

  const reject = new SlashCommandBuilder()
    .setName('prompt-reject')
    .setDescription('Reject a prompt submission by id')
    .addStringOption((opt) =>
      opt
        .setName('submission_id')
        .setDescription('Submission id (UUID), short prefix, or queue index')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('note')
        .setDescription('Optional moderator note')
        .setRequired(false)
    );

  return [queue, approve, reject];
}

module.exports = { buildGlobalCommands, buildOfficialGuildCommands };
