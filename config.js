require("dotenv").config();
const path = require("path");

const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
  },
  whatsapp: {
    sessionDir: path.resolve(process.env.SESSION_DIR || "./session"),
  },
  output: {
    dir: path.resolve(process.env.OUTPUT_DIR || "./output"),
  },
  limits: {
    maxNumbersPerRequest: parseInt(process.env.MAX_NUMBERS_PER_REQUEST) || 2000,
    cooldownSeconds: 30,
  },
  phone: {
    defaultRegion: process.env.DEFAULT_REGION || "ID",
  },
  queue: {
    concurrency: 2,
    batchSize: 20,
    batchRestMin: 10000,
    batchRestMax: 30000,
  },
  delay: {
    fast: 500,
    normal: 2000,
    slow: 5000,
    jitterMin: 200,
    jitterMax: 1000,
  },
  retry: {
    maxRetries: 2,
    backoff: [2000, 5000],
  },
  log: {
    level: process.env.LOG_LEVEL || "info",
  },
};

module.exports = config;
