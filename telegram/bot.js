const TelegramBot = require(“node-telegram-bot-api”);
const config = require(”../config”);
const logger = require(”../utils/logger”);
const { registerHandlers } = require(”./handlers”);

let bot = null;

function startBot() {
if (!config.telegram.token) {
throw new Error(“TELEGRAM_BOT_TOKEN is not set in .env”);
}

bot = new TelegramBot(config.telegram.token, { polling: true });

bot.on(“polling_error”, (err) => {
logger.error(`Telegram polling error: ${err.message}`);
});

registerHandlers(bot);

logger.info(“Telegram bot started”);
return bot;
}

function getBot() {
return bot;
}

module.exports = { startBot, getBot };
