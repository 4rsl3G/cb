require("dotenv").config();
const logger = require("./utils/logger");
const { startBot } = require("./telegram/bot");
const { ensureDir } = require("./utils/file");
const config = require("./config");

async function main() {
  logger.info("Starting WA Bulk Checker...");

  // Ensure required directories exist
  // Note: Add 'await' here if ensureDir is an asynchronous function
  ensureDir(config.whatsapp.sessionDir);
  ensureDir(config.output.dir);

  // Start Telegram bot
  try {
    // Note: Add 'await' here if startBot returns a Promise
    startBot(); 
    logger.info("System ready. Use /start in Telegram to begin.");
  } catch (err) {
    logger.error("Failed to start Telegram bot:", err.message);
    process.exit(1);
  }

  // Graceful shutdown
  process.on("SIGINT", () => {
    logger.info("Shutting down... (Add logic here to close bot/DB connections)");
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception:", err.message);
    // It's usually best practice to restart the process after an uncaught exception
    process.exit(1); 
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection:", reason?.message || reason);
  });
}

main();
