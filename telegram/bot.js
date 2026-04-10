const TelegramBot = require("node-telegram-bot-api");
const config = require("../config");
const logger = require("../utils/logger");
const { registerHandlers } = require("./handlers");

let bot = null;

function startBot() {
  if (!config.telegram.token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
  }

  bot = new TelegramBot(config.telegram.token, { polling: true });

  bot.on("polling_error", (err) => {
    // Filter error jaringan agar tidak memenuhi console, 
    // TelegramBot akan otomatis mencoba reconnect di latar belakang.
    if (err.message.includes("ECONNABORTED") || err.message.includes("EFATAL")) {
      logger.warn("Jaringan Telegram tidak stabil (ECONNABORTED). Auto-recovering...");
    } else {
      logger.error(`Telegram polling error: ${err.message}`);
    }
  });

  registerHandlers(bot);

  logger.info("Telegram bot started");
  return bot;
}

function getBot() {
  return bot;
}

module.exports = { startBot, getBot };
