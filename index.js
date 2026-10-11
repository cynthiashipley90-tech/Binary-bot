const express = require('express');
const cron = require('node-cron');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const config = require('./config');
const logger = require('./utils/logger');
const { handleBinaryCommand } = require('./commands/binary');
const { handleBinaryAccuracyCommand } = require('./commands/binaryAccuracy');
const { handleMarketCommand } = require('./commands/market');
const { handleSpotSignalCommand, handleSpotAccuracyCommand } = require('./commands/spotSignal');
const { handleFuturesCommand, handleFuturesAccuracyCommand } = require('./commands/futures');
const { handleStartTradingCommand } = require('./commands/startTrading');
const { handleStopTradingCommand } = require('./commands/stopTrading');
const { handleTradingStatusCommand } = require('./commands/tradingStatus');
const { handleShowPositionsCommand } = require('./commands/showPositions');
const { handlePauseTradingCommand } = require('./commands/pauseTrading');
const { handleResumeCommand } = require('./commands/resumeTrading');
const { handleListOrdersCommand } = require('./commands/listOrders');
const { handleCloseAllCommand } = require('./commands/closeAll');
const { runBinaryTrackerCycle } = require('./services/binaryTracker');
const { runSpotTrackerCycle } = require('./services/spotTracker');
const { runFuturesTrackerCycle } = require('./services/futuresTracker');
const { splitForDiscord } = require('./utils/marketFormatting');
const tradingMode = require('./services/tradingMode');
const binanceAuth = require('./services/binanceAuth');
const futuresEntryLoop = require('./services/futuresEntryLoop');
const { runExitLoopCycle } = require('./services/futuresExitLoop');

// The ONE message a user sees while a !market analysis runs. It is edited
// in place into the final report (see handleMessage).
const WAITING_TEXT = '⏳ WAITING...';

let clientInstance = null;

// `hooks.onWorkflowStart` is only used by !market (see commands/market.js).
// userId is passed for trading command authorization (only DISCORD_ADMIN_ID can control trading)
async function routeCommand(text, scopeId, hooks = {}, userId = null) {
  const trimmed = text.trim();
  if (/^!binaryaccuracy\b/i.test(trimmed)) {
    return handleBinaryAccuracyCommand();
  }
  if (/^!binary\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!binary\s*/i, '');
    return handleBinaryCommand(arg);
  }
  // !signal / !signalaccuracy: separate spot/futures-style crypto signal
  // (Entry/SL/TP, open-ended) - completely independent of !binary above,
  // see commands/spotSignal.js.
  if (/^!signalaccuracy\b/i.test(trimmed)) {
    return handleSpotAccuracyCommand();
  }
  if (/^!signal\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!signal\s*/i, '');
    return handleSpotSignalCommand(arg);
  }
  // !futures / !futuresaccuracy: separate leveraged-perpetual engine
  // (Binance public futures data, own store/tracker) - independent of both
  // !binary and !signal. See commands/futures.js.
  if (/^!futuresaccuracy\b/i.test(trimmed)) {
    return handleFuturesAccuracyCommand();
  }
  if (/^!futures\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!futures\s*/i, '');
    return handleFuturesCommand(arg);
  }
  // !market is the natural-language entry point (section N): everything
  // after the prefix is parsed by services/nlu.js, not matched against
  // more regexes here - "!market EURUSD analyse karo", "!market Roman
  // Urdu mein explain karo", "!market sirf differences batao" all route
  // here and get disambiguated by the parser.
  if (/^!market\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!market\s*/i, '');
    return handleMarketCommand(scopeId, arg, hooks);
  }
  // Trading mode commands (USDⓈ-M Futures automated trading)
  if (/^!starttrading\b/i.test(trimmed)) {
    const arg = trimmed.replace(/^!starttrading\s*/i, '').toLowerCase();
    return handleStartTradingCommand(arg, userId);
  }
  if (/^!stoptrading\b/i.test(trimmed)) {
    return handleStopTradingCommand(userId);
  }
  if (/^!status\b/i.test(trimmed)) {
    return handleTradingStatusCommand();
  }
  if (/^!positions\b/i.test(trimmed)) {
    return handleShowPositionsCommand();
  }
  if (/^!pausetrading\b/i.test(trimmed)) {
    return handlePauseTradingCommand(userId);
  }
  if (/^!resume\b/i.test(trimmed)) {
    return handleResumeCommand(userId);
  }
  if (/^!orders\b/i.test(trimmed)) {
    return handleListOrdersCommand();
  }
  if (/^!closeall\b/i.test(trimmed)) {
    return handleCloseAllCommand(userId);
  }
  return null;
}

// Delivers `text` to the user. If a WAITING message was posted it is EDITED
// into the (first chunk of the) reply; only text that doesn't fit in one
// Discord message continues in follow-up chunks - those are part of the
// final report, not progress messages. If the edit fails (message deleted,
// missing permission) it falls back to a normal reply so the result is never
// lost.
async function deliverReply(message, waiting, text) {
  const [first, ...rest] = splitForDiscord(text);
  let delivered = false;
  if (waiting) {
    try {
      await waiting.edit(first);
      delivered = true;
    } catch (err) {
      logger.warn(`Could not edit the waiting message (${err.message}); replying instead`);
    }
  }
  if (!delivered) await message.reply(first);
  for (const chunk of rest) {
    // eslint-disable-next-line no-await-in-loop
    await message.channel.send(chunk);
  }
}

// One Discord message in, one reply out. Never throws.
async function handleMessage(message, deps = {}) {
  if (message.author.bot) return;
  const text = message.content || '';
  if (!text.trim().startsWith('!')) return;

  logger.info(`Command from ${message.author.tag}: ${text}`);

  let waiting = null;
  const hooks = {
    onWorkflowStart: async () => {
      waiting = await message.reply(WAITING_TEXT);
    },
  };

  try {
    // scopeId scopes the in-process follow-up memory (commands/market.js)
    // to this Discord channel - a follow-up like "explain in Roman Urdu" in
    // the same channel reuses that channel's last analysis.
    // userId is used for trading command authorization
    const reply = await (deps.routeCommand || routeCommand)(text, message.channel.id, hooks, message.author.id);
    if (reply) {
      await deliverReply(message, waiting, reply);
    } else if (waiting) {
      await deliverReply(message, waiting, 'Error: no result was produced for that request.');
    }
  } catch (err) {
    logger.error('Command handling error:', err.message);
    // Never leave the user staring at a WAITING message.
    await deliverReply(message, waiting, `Error: ${err.message}`).catch(() => {});
  }
}

function startDiscordBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
  clientInstance = client;

  client.once('ready', () => {
    logger.info(`Discord bot logged in as ${client.user.tag}`);
  });

  client.on('messageCreate', (message) => {
    handleMessage(message).catch((err) => logger.error('Unhandled message error:', err.message));
  });

  client.login(config.discord.token);
  return client;
}

// Plain HTTP endpoint for the hosting platform's own uptime/health checks
// (e.g. Railway) - separate from any Discord command.
function startHealthServer() {
  const app = express();
  app.get('/', (req, res) => res.send('Binary Signal Bot (Discord) is running.'));
  app.get('/health', (req, res) => res.json({ ok: true, connected: !!clientInstance?.isReady() }));
  app.listen(config.server.port, () => {
    logger.info(`Health server listening on port ${config.server.port}`);
  });
}

async function initializeTradingServices() {
  // Initialize trading mode to DISABLED by default (safe startup)
  tradingMode.init({ mode: 'disabled', authorizedIds: [] });
  
  // Add Discord admin to authorized list for trading control
  const adminId = process.env.DISCORD_ADMIN_ID;
  if (adminId) {
    tradingMode.addAuthorizedUser(adminId);
    logger.info(`Trading authorized for Discord user: ${adminId}`);
  } else {
    logger.warn('DISCORD_ADMIN_ID not set - trading commands will be rejected');
  }
  
  // Initialize entry loop (restore positions from previous session)
  await futuresEntryLoop.initializeEntryLoop();
  
  // Initialize Binance auth to disabled (safe default)
  binanceAuth.setTradingMode('disabled');
  logger.info('Trading mode initialized: DISABLED (safe startup)');
}

function startTrackerCron() {
  // Binary trades expire in minutes, so this needs to be tight.
  cron.schedule('*/1 * * * *', () => {
    runBinaryTrackerCycle().catch((err) => logger.error('Binary tracker cycle failed:', err.message));
  });
  logger.info('Binary signal tracker cron scheduled (every 1 minute).');

  // Spot signals are open-ended (SL/TP, no fixed expiry) - independent
  // cron, does not touch or depend on the binary tracker above.
  cron.schedule('*/1 * * * *', () => {
    runSpotTrackerCycle().catch((err) => logger.error('Spot tracker cycle failed:', err.message));
  });
  logger.info('Spot signal tracker cron scheduled (every 1 minute).');

  // Futures signals: own tracker + own store, independent of both above.
  cron.schedule('*/1 * * * *', () => {
    runFuturesTrackerCycle().catch((err) => logger.error('Futures tracker cycle failed:', err.message));
  });
  logger.info('Futures signal tracker cron scheduled (every 1 minute).');

  // Futures automated entry loop: submits orders when signals + risk checks pass
  cron.schedule('*/1 * * * *', () => {
    futuresEntryLoop.runEntryLoopCycle().catch((err) => logger.error('Futures entry loop failed:', err.message));
  });
  logger.info('Futures automated entry loop scheduled (every 1 minute).');

  // Futures automated exit loop: closes positions on SL/TP, reconciles with exchange
  // Note: cron does not support fractional minutes (*/0.5), use setInterval for 30 seconds
  setInterval(() => {
    runExitLoopCycle().catch((err) => logger.error('Futures exit loop failed:', err.message));
  }, 30000);
  logger.info('Futures automated exit loop scheduled (every 30 seconds).');
}

async function main() {
  initializeTradingServices();
  startHealthServer();
  startDiscordBot();
  startTrackerCron();
}

// Graceful shutdown handlers
function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    logger.info(`\n🛑 Received ${signal}, shutting down gracefully...`);
    
    try {
      // Stop new trades
      tradingMode.setTradingMode('disabled');
      logger.info('Trading disabled');
      
      // Wait for in-flight operations
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      logger.info('✅ Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Shutdown error:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    logger.error('❌ Uncaught Exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}

// Only auto-start when run directly (`npm start` -> node src/index.js);
// requiring this file (tests) must not open a Discord connection, an HTTP
// port or a cron job.
if (require.main === module) {
  setupGracefulShutdown();
  main().catch((err) => {
    logger.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { routeCommand, handleMessage, WAITING_TEXT };
