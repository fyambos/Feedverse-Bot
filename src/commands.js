const { SlashCommandBuilder } = require('discord.js');

function buildGlobalCommands() {
  const help = new SlashCommandBuilder().setName('help').setDescription('Show bot commands and usage');

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

  const setup = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setup commands')
    .addSubcommand((sc) =>
      sc
        .setName('daily')
        .setDescription('Send a random AU prompt every day in a channel')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Channel to post the daily prompt in')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('time')
            .setDescription('Optional time (e.g. 21:30 or 9:30pm)')
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('timezone')
            .setDescription('Your timezone (IANA), e.g. America/New_York')
            .setRequired(true)
        )
    );

  const view = new SlashCommandBuilder()
    .setName('view')
    .setDescription('View things')
    .addSubcommand((sc) => sc.setName('favorites').setDescription('View your favorited prompts'));

  return [help, generate, share, prompt, setup, view];
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
        .setDescription('Submission id (from /prompt-queue)')
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
        .setDescription('Submission id (from /prompt-queue)')
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
