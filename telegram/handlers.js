const fs = require("fs");
const path = require("path");
const axios = require("axios");
const os = require("os");
const QRCode = require("qrcode");

const config = require("../config");
const logger = require("../utils/logger");
const waConnection = require("../whatsapp/connection");
const { checkNumber } = require("../whatsapp/checker");
const { normalizeNumber } = require("../whatsapp/normalize");
const { parseTxtFile, writeHasil, writeNomorValid } = require("../utils/file");
const CheckerQueue = require("../utils/queue");
const { ensureDir } = require("../utils/file");

// Per-user state
const userSessions = new Map();
const userCooldowns = new Map();
const COOLDOWN_MS = config.limits.cooldownSeconds * 1000;

function getUserSession(chatId) {
  if (!userSessions.has(chatId)) {
    userSessions.set(chatId, {
      queue: null,
      mode: "normal",
      running: false,
      lastRequest: 0,
      awaitingLoginPhone: false,
      awaitingCek: false,
      promptMessageId: null, // Ditambahkan untuk melacak ID pesan pertanyaan bot agar bisa dihapus
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

// Helper Tombol Kembali
function getBackButton() {
  return [[{ text: "🔙 Kembali ke Menu", callback_data: "menu_back" }]];
}

function buildMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔍 Cek Nomor", callback_data: "menu_cek" },
          { text: "📦 Bulk Check", callback_data: "menu_bulk" },
        ],
        [
          { text: "⚡ Mode", callback_data: "menu_mode" },
          { text: "🔐 Login WA", callback_data: "menu_login" },
        ],
        [{ text: "📊 Status", callback_data: "menu_status" }],
      ],
    },
  };
}

function buildModeMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⚡ Fast (500ms)", callback_data: "mode_fast" },
          { text: "🚶 Normal (2s)", callback_data: "mode_normal" },
          { text: "🐢 Slow (5s)", callback_data: "mode_slow" },
        ],
        getBackButton()[0], // Sisipkan tombol kembali
      ],
    },
  };
}

/**
 * Register all bot handlers
 */
function registerHandlers(bot) {
  // Helper untuk menghapus pesan dengan aman (tidak crash jika pesan sudah hilang)
  const safeDelete = (chatId, messageId) => {
    if (messageId) bot.deleteMessage(chatId, messageId).catch(() => {});
  };

  // /start command
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    safeDelete(chatId, msg.message_id); // Hapus pesan /start dari user
    bot.sendMessage(
      chatId,
      `👋 *WA Bulk Checker*\n\nBot pengecekan nomor WhatsApp.\nPilih menu di bawah:`,
      { parse_mode: "Markdown", ...buildMainMenu() }
    );
  });

  // Callback query handler (inline keyboard)
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const session = getUserSession(chatId);
    const messageId = query.message.message_id;

    bot.answerCallbackQuery(query.id).catch(() => {});

    if (data === "menu_cek") {
      const prompt = await bot.sendMessage(chatId, "🔍 *Kirim nomor yang ingin dicek* (contoh: 081234567890):", { parse_mode: "Markdown" });
      session.awaitingCek = true;
      session.promptMessageId = prompt.message_id;
    } 
    
    else if (data === "menu_bulk") {
      const prompt = await bot.sendMessage(chatId, "📤 *Kirim file TXT* berisi daftar nomor (satu per baris).", { parse_mode: "Markdown" });
      session.promptMessageId = prompt.message_id;
    } 
    
    else if (data === "menu_mode") {
      bot.editMessageText("⚡ *Pilih mode delay:*\n\nSesuaikan kecepatan pengecekan.", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        ...buildModeMenu()
      });
    } 
    
    else if (data === "menu_login") {
      const prompt = await bot.sendMessage(chatId, "🔐 *Masukkan nomor WA kamu* (format E.164, contoh: +6281234567890):", { parse_mode: "Markdown" });
      session.awaitingLoginPhone = true;
      session.promptMessageId = prompt.message_id;
    } 
    
    else if (data === "menu_status") {
      const connected = waConnection.isConnected();
      bot.editMessageText(
        `📊 *Status Sistem*\n\nWhatsApp: ${connected ? "✅ Terhubung" : "❌ Terputus"}\nMode: *${session.mode}*\nRunning: ${session.running ? "Ya ⏳" : "Tidak 🟢"}`,
        { 
          chat_id: chatId, 
          message_id: messageId, 
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: getBackButton() }
        }
      );
    } 
    
    else if (data === "menu_back") {
      // Kembalikan pesan ke Menu Utama
      bot.editMessageText(`👋 *WA Bulk Checker*\n\nBot pengecekan nomor WhatsApp.\nPilih menu di bawah:`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        ...buildMainMenu()
      });
    } 
    
    else if (data.startsWith("mode_")) {
      const mode = data.replace("mode_", "");
      session.mode = mode;
      if (session.queue) session.queue.setMode(mode);
      
      bot.editMessageText(`✅ Kecepatan berhasil diubah ke mode *${mode}*.`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: getBackButton() }
      });
    }
  });

  // Text message handler (for awaited inputs)
  bot.on("message", async (msg) => {
    if (!msg.text && !msg.document) return;
    if (msg.text && msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const session = getUserSession(chatId);

    // 1. Hapus Pesan Input dari User agar chat bersih
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    
    // 2. Hapus Pesan Pertanyaan Bot sebelumnya (Prompt)
    if (session.promptMessageId) {
      bot.deleteMessage(chatId, session.promptMessageId).catch(() => {});
      session.promptMessageId = null;
    }

    // Handle login phone input
    if (session.awaitingLoginPhone && msg.text) {
      session.awaitingLoginPhone = false;
      await handleLogin(bot, chatId, msg.text.trim());
      return;
    }

    // Handle single cek input
    if (session.awaitingCek && msg.text) {
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
        const errPrompt = await bot.sendMessage(chatId, "⚠️ Hanya file .txt yang didukung.");
        setTimeout(() => bot.deleteMessage(chatId, errPrompt.message_id).catch(()=>{}), 3000);
      }
    }
  });
}

async function handleLogin(bot, chatId, phoneInput) {
  const normalized = normalizeNumber(phoneInput, config.phone.defaultRegion);
  if (!normalized.valid) {
    const err = await bot.sendMessage(chatId, "❌ Nomor tidak valid. Coba lagi dengan format +6281234567890");
    setTimeout(() => bot.deleteMessage(chatId, err.message_id).catch(()=>{}), 3000);
    return;
  }

  const statusMsg = await bot.sendMessage(chatId, `🔐 Meminta pairing code untuk ${normalized.e164}...`);

  waConnection.onPairingCode((code) => {
    bot.editMessageText(
      `🔑 *Pairing Code:* \`${code}\`\n\nMasukkan kode ini di WhatsApp > Tautkan perangkat > Tautkan dengan nomor telepon`,
      { 
        chat_id: chatId, 
        message_id: statusMsg.message_id, 
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🔙 Batal / Menu", callback_data: "menu_back" }]] }
      }
    );
  });

  waConnection.onQr(async (qr) => {
    try {
      bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
      const qrBuffer = await QRCode.toBuffer(qr, { type: "png", width: 512 });
      bot.sendPhoto(chatId, qrBuffer, { 
        caption: "📱 Scan QR ini untuk login WhatsApp",
        reply_markup: { inline_keyboard: [[{ text: "🔙 Batal / Menu", callback_data: "menu_back" }]] }
      });
    } catch (err) {
      logger.error("QR generation error:", err.message);
    }
  });

  waConnection.onReady(() => {
    bot.sendMessage(chatId, "✅ WhatsApp berhasil terhubung!", {
      reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali ke Menu", callback_data: "menu_back" }]] }
    });
  });

  waConnection.onDisconnect((reason) => {
    bot.sendMessage(chatId, `⚠️ WhatsApp terputus (kode: ${reason}). Mencoba reconnect...`);
  });

  try {
    await waConnection.connect(normalized.e164);
  } catch (err) {
    logger.error("WA connect error:", err.message);
    bot.editMessageText(`❌ Gagal connect: ${err.message}`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali ke Menu", callback_data: "menu_back" }]] }
    });
  }
}

async function handleSingleCheck(bot, chatId, input) {
  if (!waConnection.isConnected()) {
    const err = await bot.sendMessage(chatId, "❌ WhatsApp belum terhubung. Gunakan menu Login terlebih dahulu.");
    setTimeout(() => bot.deleteMessage(chatId, err.message_id).catch(()=>{}), 3000);
    return;
  }

  const normalized = normalizeNumber(input, config.phone.defaultRegion);
  if (!normalized.valid) {
    const err = await bot.sendMessage(chatId, `❌ Nomor tidak valid: \`${input}\``, { parse_mode: "Markdown" });
    setTimeout(() => bot.deleteMessage(chatId, err.message_id).catch(()=>{}), 3000);
    return;
  }

  const msg = await bot.sendMessage(chatId, `🔍 Mengecek ${normalized.e164}...`);

  try {
    const result = await checkNumber(normalized);
    const wa = result.waResult;
    const text = wa?.exists
      ? `✅ *Terdaftar di WhatsApp*\n\nNomor   : ${result.e164}\nNegara  : ${result.country}\nKode    : ${result.countryCode}\nNasional: ${result.national}\nNama    : ${wa.name || "-"}\nBio     : ${wa.bio || "-"}`
      : `❌ *Tidak terdaftar di WhatsApp*\n\nNomor   : ${result.e164}\nNegara  : ${result.country}`;

    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: getBackButton() } // Tambahkan tombol kembali
    });
  } catch (err) {
    bot.editMessageText(`❌ Error: ${err.message}`, {
      chat_id: chatId,
      message_id: msg.message_id,
      reply_markup: { inline_keyboard: getBackButton() }
    });
  }
}

async function handleBulkFile(bot, chatId, document) {
  if (isOnCooldown(chatId)) {
    const err = await bot.sendMessage(chatId, `⏳ Cooldown aktif. Tunggu ${config.limits.cooldownSeconds} detik.`);
    setTimeout(() => bot.deleteMessage(chatId, err.message_id).catch(()=>{}), 3000);
    return;
  }

  if (!waConnection.isConnected()) {
    const err = await bot.sendMessage(chatId, "❌ WhatsApp belum terhubung.");
    setTimeout(() => bot.deleteMessage(chatId, err.message_id).catch(()=>{}), 3000);
    return;
  }

  const session = getUserSession(chatId);
  if (session.running) return;

  setCooldown(chatId);

  const fileLink = await bot.getFileLink(document.file_id);
  const tmpPath = path.join(os.tmpdir(), `wa_bulk_${chatId}_${Date.now()}.txt`);

  try {
    const response = await axios.get(fileLink, { responseType: "arraybuffer" });
    fs.writeFileSync(tmpPath, response.data);
  } catch (err) {
    return bot.sendMessage(chatId, `❌ Gagal download file: ${err.message}`);
  }

  const progressMsg = await bot.sendMessage(chatId, "📂 File diterima. Memproses nomor...");

  let numbers;
  try {
    numbers = await parseTxtFile(tmpPath, config.phone.defaultRegion);
    fs.unlinkSync(tmpPath);
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    return bot.editMessageText(`❌ Gagal parse file: ${err.message}`, { chat_id: chatId, message_id: progressMsg.message_id });
  }

  if (numbers.length === 0) {
    return bot.editMessageText("⚠️ Tidak ada nomor valid ditemukan dalam file.", { chat_id: chatId, message_id: progressMsg.message_id });
  }

  bot.editMessageText(`🚀 Mulai cek *${numbers.length}* nomor...\n\nChecking 0/${numbers.length} (0%)`, { 
    chat_id: chatId, 
    message_id: progressMsg.message_id,
    parse_mode: "Markdown" 
  });

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

      bot.editMessageText(
        `⏳ Checking ${done}/${total} (${pct}%)\n\n✅ Valid: ${valid}\n❌ Tidak: ${invalid}\n⚠️ Error: ${errors}`,
        {
          chat_id: chatId,
          message_id: progressMsg.message_id,
          parse_mode: "Markdown",
        }
      ).catch(() => {});
      lastProgressUpdate = now;
    }
  };

  try {
    const results = await session.queue.run(checkNumber);
    session.running = false;

    ensureDir(config.output.dir);
    const hasilPath = await writeHasil(results, config.output.dir);
    const validPath = await writeNomorValid(results, config.output.dir);

    const totalValid = results.filter((r) => r.waResult?.exists).length;
    const totalInvalid = results.filter((r) => r.waResult && !r.waResult.exists).length;
    const totalError = results.filter((r) => r.error).length;

    bot.editMessageText(
      `✅ *Selesai!*\n\n📊 Total     : ${results.length}\n✅ Terdaftar : ${totalValid}\n❌ Tidak     : ${totalInvalid}\n⚠️ Error     : ${totalError}`,
      {
        chat_id: chatId,
        message_id: progressMsg.message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: getBackButton() } // Tombol kembali di akhir bulk check
      }
    );

    if (fs.existsSync(hasilPath)) {
      await bot.sendDocument(chatId, hasilPath, { caption: "📄 hasil.txt" });
    }
    if (fs.existsSync(validPath) && totalValid > 0) {
      await bot.sendDocument(chatId, validPath, { caption: "✅ nomor_valid.txt" });
    }
  } catch (err) {
    session.running = false;
    bot.editMessageText(`❌ Proses gagal: ${err.message}`, { chat_id: chatId, message_id: progressMsg.message_id });
  }
}

module.exports = { registerHandlers };
