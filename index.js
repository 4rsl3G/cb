require(“dotenv”).config();
const logger = require(”./utils/logger”);
const { startBot } = require(”./telegram/bot”);
const { ensureDir } = require(”./utils/file”);
const config = require(”./config”);

async function main() {
logger.info(“Starting WA Bulk Checker…”);

// Ensure required directories exist
ensureDir(config.whatsapp.sessionDir);
ensureDir(config.output.dir);

// Start Telegram bot
try {
startBot();
logger.info(“System ready. Use /start in Telegram to begin.”);
} catch (err) {
logger.error(“Failed to start Telegram bot:”, err.message);
process.exit(1);
}

// Graceful shutdown
process.on(“SIGINT”, () => {
logger.info(“Shutting down…”);
process.exit(0);
});

process.on(“uncaughtException”, (err) => {
logger.error(“Uncaught exception:”, err.message);
});

process.on(“unhandledRejection”, (reason) => {
logger.error(“Unhandled rejection:”, reason?.message || reason);
});
}

main();
