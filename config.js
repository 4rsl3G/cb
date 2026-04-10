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
    cooldownSeconds: 5, // 🚀 Diturunkan dari 30 ke 5 detik agar bisa cepat antre file baru
  },
  phone: {
    defaultRegion: process.env.DEFAULT_REGION || "ID",
  },
  queue: {
    concurrency: 15,       // 🚀 Bot akan mengecek 15 nomor secara serentak (paralel)
    batchSize: 100,        // 🚀 Bot baru akan istirahat setelah mengecek 100 nomor
    batchRestMin: 2000,    // 🚀 Istirahat antar batch hanya 2 detik
    batchRestMax: 4000,    // 🚀 Maksimal istirahat 4 detik
  },
  delay: {
    fast: 100,             // 🚀 Jeda super cepat (100ms) antar request
    normal: 300,           // 🚀 Jeda normal saat sedikit limit (300ms)
    slow: 1000,            // 🚀 Jeda lambat (1 detik)
    jitterMin: 50,         // 🚀 Acak tambahan waktu agar tidak terlalu robotik (sangat kecil)
    jitterMax: 200,
  },
  retry: {
    maxRetries: 2,
    backoff: [1000, 3000], // 🚀 Retry error dipercepat menjadi 1 dan 3 detik
  },
  log: {
    level: process.env.LOG_LEVEL || "info",
  },
};

module.exports = config;
