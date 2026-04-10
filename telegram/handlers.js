const fs = require(“fs”);
const path = require(“path”);
const axios = require(“axios”);
const os = require(“os”);

const config = require(”../config”);
const logger = require(”../utils/logger”);
const waConnection = require(”../whatsapp/connection”);
const { checkNumber } = require(”../whatsapp/checker”);
const { normalizeNumber } = require(”../whatsapp/normalize”);
const { parseTxtFile, writeHasil, writeNomorValid } = require(”../utils/file”);
const CheckerQueue = require(”../utils/queue”);
const { ensureDir } = require(”../utils/file”);

// Per-user state
const userSessions = new Map();
// Per-user cooldown timestamps
const userCooldowns = new Map();

const COOLDOWN_MS = config.limits.cooldownSeconds * 1000;

function getUserSession(chatId) {
if (!userSessions.has(chatId)) {
userSessions.set(chatId, {
queue: null,
mode: “normal”,
running: false,
lastRequest: 0,
});
}
return userSessions.get(chatId);
}

function isOnCooldown(chatId) {
const last = userCooldowns.get(chatId) || 0;
return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(chatId) {
userCooldowns.set(chatId, Date.now());
}

function buildMainMenu() {
return {
reply_markup: {
inline_keyboard: [
[
{ text: “🔍 Cek Nomor”, callback_data: “menu_cek” },
{ text: “📦 Bulk Check”, callback_data: “menu_bulk” },
],
[
{ text: “⚡ Mode”, callback_data: “menu_mode” },
{ text: “🔐 Login WA”, callback_data: “menu_login” },
],
[{ text: “📊 Status”, callback_data: “menu_status” }],
],
},
};
}

function buildModeMenu() {
return {
reply_markup: {
inline_keyboard: [
[
{ text: “⚡ Fast (500ms)”, callback_data: “mode_fast” },
{ text: “🚶 Normal (2s)”, callback_data: “mode_normal” },
{ text: “🐢 Slow (5s)”, callback_data: “mode_slow” },
],
[{ text: “🔙 Back”, callback_data: “menu_back” }],
],
},
};
}

/**

- Register all bot handlers
  */
  function registerHandlers(bot) {
  // /start command
  bot.onText(//start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
  chatId,
  `👋 *WA Bulk Checker*\n\nBot pengecekan nomor WhatsApp.\nPilih menu di bawah:`,
  { parse_mode: “Markdown”, …buildMainMenu() }
  );
  });

// /cek command
bot.onText(//cek (.+)/, async (msg, match) => {
const chatId = msg.chat.id;
const input = match[1].trim();
await handleSingleCheck(bot, chatId, input);
});

// /mode command
bot.onText(//mode/, (msg) => {
bot.sendMessage(msg.chat.id, “Pilih mode delay:”, buildModeMenu());
});

// /login command
bot.onText(//login/, (msg) => {
bot.sendMessage(
msg.chat.id,
“Masukkan nomor WA kamu (format E.164, contoh: +6281234567890):\n\nKirim nomor sekarang:”
);
const session = getUserSession(msg.chat.id);
session.awaitingLoginPhone = true;
});

// /bulk command
bot.onText(//bulk/, (msg) => {
bot.sendMessage(
msg.chat.id,
“📤 Kirim file TXT berisi daftar nomor (satu per baris, max 2000 nomor).”
);
});

// Callback query handler (inline keyboard)
bot.on(“callback_query”, async (query) => {
const chatId = query.message.chat.id;
const data = query.data;
bot.answerCallbackQuery(query.id);

```
if (data === "menu_cek") {
  bot.sendMessage(chatId, "Kirim nomor yang ingin dicek (contoh: 081234567890):");
  getUserSession(chatId).awaitingCek = true;
} else if (data === "menu_bulk") {
  bot.sendMessage(chatId, "📤 Kirim file TXT berisi daftar nomor.");
} else if (data === "menu_mode") {
  bot.sendMessage(chatId, "Pilih mode delay:", buildModeMenu());
} else if (data === "menu_login") {
  bot.sendMessage(chatId, "Masukkan nomor WA (E.164, contoh: +6281234567890):");
  getUserSession(chatId).awaitingLoginPhone = true;
} else if (data === "menu_status") {
  const connected = waConnection.isConnected();
  const session = getUserSession(chatId);
  bot.sendMessage(
    chatId,
    `📊 *Status*\n\nWhatsApp: ${connected ? "✅ Terhubung" : "❌ Terputus"}\nMode: ${session.mode}\nRunning: ${session.running ? "Ya" : "Tidak"}`,
    { parse_mode: "Markdown" }
  );
} else if (data === "menu_back") {
  bot.sendMessage(chatId, "Menu utama:", buildMainMenu());
} else if (data.startsWith("mode_")) {
  const mode = data.replace("mode_", "");
  const session = getUserSession(chatId);
  session.mode = mode;
  if (session.queue) session.queue.setMode(mode);
  bot.sendMessage(chatId, `✅ Mode diubah ke *${mode}*`, { parse_mode: "Markdown" });
}
```

});

// Text message handler (for awaited inputs)
bot.on(“message”, async (msg) => {
const chatId = msg.chat.id;
const session = getUserSession(chatId);

```
// Handle login phone input
if (session.awaitingLoginPhone && msg.text && !msg.text.startsWith("/")) {
  session.awaitingLoginPhone = false;
  await handleLogin(bot, chatId, msg.text.trim());
  return;
}

// Handle single cek input
if (session.awaitingCek && msg.text && !msg.text.startsWith("/")) {
  session.awaitingCek = false;
  await handleSingleCheck(bot, chatId, msg.text.trim());
  return;
}

// Handle TXT file upload
if (msg.document) {
  const fileName = msg.document.file_name || "";
  if (fileName.endsWith(".txt")) {
    await handleBulkFile(bot, chatId, msg.document);
  } else {
    bot.sendMessage(chatId, "⚠️ Hanya file .txt yang didukung.");
  }
}
```

});
}

async function handleLogin(bot, chatId, phoneInput) {
const normalized = normalizeNumber(phoneInput, config.phone.defaultRegion);
if (!normalized.valid) {
return bot.sendMessage(chatId, “❌ Nomor tidak valid. Coba lagi dengan format +6281234567890”);
}

bot.sendMessage(chatId, `🔐 Meminta pairing code untuk ${normalized.e164}...`);

waConnection.onPairingCode((code) => {
bot.sendMessage(
chatId,
`🔑 *Pairing Code:* \`${code}`\n\nMasukkan kode ini di WhatsApp > Terhubungkan perangkat > Tautkan dengan nomor telepon`,
{ parse_mode: “Markdown” }
);
});

waConnection.onQr(async (qr) => {
try {
const QRCode = require(“qrcode”);
const qrBuffer = await QRCode.toBuffer(qr, { type: “png”, width: 512 });
bot.sendPhoto(chatId, qrBuffer, { caption: “📱 Scan QR ini untuk login WhatsApp” });
} catch (err) {
logger.error(“QR generation error:”, err.message);
bot.sendMessage(chatId, “⚠️ Gagal membuat QR. Coba pairing code.”);
}
});

waConnection.onReady(() => {
bot.sendMessage(chatId, “✅ WhatsApp berhasil terhubung!”);
});

waConnection.onDisconnect((reason) => {
bot.sendMessage(chatId, `⚠️ WhatsApp terputus (kode: ${reason}). Mencoba reconnect...`);
});

try {
await waConnection.connect(normalized.e164);
} catch (err) {
logger.error(“WA connect error:”, err.message);
bot.sendMessage(chatId, `❌ Gagal connect: ${err.message}`);
}
}

async function handleSingleCheck(bot, chatId, input) {
if (!waConnection.isConnected()) {
return bot.sendMessage(chatId, “❌ WhatsApp belum terhubung. Gunakan /login terlebih dahulu.”);
}

const normalized = normalizeNumber(input, config.phone.defaultRegion);
if (!normalized.valid) {
return bot.sendMessage(chatId, `❌ Nomor tidak valid: \`${input}``, { parse_mode: “Markdown” });
}

const msg = await bot.sendMessage(chatId, `🔍 Mengecek ${normalized.e164}...`);

try {
const result = await checkNumber(normalized);
const wa = result.waResult;
const text = wa?.exists
? `✅ *Terdaftar di WhatsApp*\n\nNomor   : ${result.e164}\nNegara  : ${result.country}\nKode    : ${result.countryCode}\nNasional: ${result.national}\nNama    : ${wa.name || "-"}\nBio     : ${wa.bio || "-"}`
: `❌ *Tidak terdaftar di WhatsApp*\n\nNomor   : ${result.e164}\nNegara  : ${result.country}`;

```
bot.editMessageText(text, {
  chat_id: chatId,
  message_id: msg.message_id,
  parse_mode: "Markdown",
});
```

} catch (err) {
bot.editMessageText(`❌ Error: ${err.message}`, {
chat_id: chatId,
message_id: msg.message_id,
});
}
}

async function handleBulkFile(bot, chatId, document) {
if (isOnCooldown(chatId)) {
return bot.sendMessage(chatId, `⏳ Cooldown aktif. Tunggu ${config.limits.cooldownSeconds} detik.`);
}

if (!waConnection.isConnected()) {
return bot.sendMessage(chatId, “❌ WhatsApp belum terhubung. Gunakan /login terlebih dahulu.”);
}

const session = getUserSession(chatId);
if (session.running) {
return bot.sendMessage(chatId, “⚠️ Proses bulk sedang berjalan.”);
}

setCooldown(chatId);

// Download file
const fileLink = await bot.getFileLink(document.file_id);
const tmpPath = path.join(os.tmpdir(), `wa_bulk_${chatId}_${Date.now()}.txt`);

try {
const response = await axios.get(fileLink, { responseType: “arraybuffer” });
fs.writeFileSync(tmpPath, response.data);
} catch (err) {
return bot.sendMessage(chatId, `❌ Gagal download file: ${err.message}`);
}

bot.sendMessage(chatId, “📂 File diterima. Memproses nomor…”);

let numbers;
try {
numbers = await parseTxtFile(tmpPath, config.phone.defaultRegion);
fs.unlinkSync(tmpPath);
} catch (err) {
fs.unlinkSync(tmpPath);
return bot.sendMessage(chatId, `❌ Gagal parse file: ${err.message}`);
}

if (numbers.length === 0) {
return bot.sendMessage(chatId, “⚠️ Tidak ada nomor valid ditemukan dalam file.”);
}

const progressMsg = await bot.sendMessage(
chatId,
`🚀 Mulai cek *${numbers.length}* nomor...\n\nChecking 0/${numbers.length} (0%)`,
{ parse_mode: “Markdown” }
);

session.running = true;
session.queue = new CheckerQueue();
session.queue.setMode(session.mode);
session.queue.enqueue(numbers);

let lastProgressUpdate = Date.now();
const UPDATE_INTERVAL = 3000;

session.queue.onProgress = (done, total, result) => {
const now = Date.now();
if (now - lastProgressUpdate > UPDATE_INTERVAL || done === total) {
const pct = Math.floor((done / total) * 100);
const valid = session.queue.results.filter((r) => r.waResult?.exists).length;
const invalid = session.queue.results.filter((r) => r.waResult && !r.waResult.exists).length;
const errors = session.queue.results.filter((r) => r.error).length;

```
  bot
    .editMessageText(
      `⏳ Checking ${done}/${total} (${pct}%)\n\n✅ Valid: ${valid}\n❌ Tidak: ${invalid}\n⚠️ Error: ${errors}`,
      {
        chat_id: chatId,
        message_id: progressMsg.message_id,
        parse_mode: "Markdown",
      }
    )
    .catch(() => {});
  lastProgressUpdate = now;
}
```

};

try {
const results = await session.queue.run(checkNumber);
session.running = false;

```
// Write output files
ensureDir(config.output.dir);
const hasilPath = await writeHasil(results, config.output.dir);
const validPath = await writeNomorValid(results, config.output.dir);

const totalValid = results.filter((r) => r.waResult?.exists).length;
const totalInvalid = results.filter((r) => r.waResult && !r.waResult.exists).length;
const totalError = results.filter((r) => r.error).length;

bot.editMessageText(
  `✅ *Selesai!*\n\n📊 Total     : ${results.length}\n✅ Terdaftar : ${totalValid}\n❌ Tidak     : ${totalInvalid}\n⚠️ Error    : ${totalError}`,
  {
    chat_id: chatId,
    message_id: progressMsg.message_id,
    parse_mode: "Markdown",
  }
);

// Send result files
if (fs.existsSync(hasilPath)) {
  await bot.sendDocument(chatId, hasilPath, { caption: "📄 hasil.txt — Semua hasil" });
}
if (fs.existsSync(validPath) && totalValid > 0) {
  await bot.sendDocument(chatId, validPath, { caption: "✅ nomor_valid.txt — Nomor terdaftar WA" });
}
```

} catch (err) {
session.running = false;
logger.error(“Bulk check error:”, err.message);
bot.sendMessage(chatId, `❌ Proses gagal: ${err.message}`);
}
}

module.exports = { registerHandlers };
