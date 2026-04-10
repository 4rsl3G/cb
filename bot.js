require("dotenv").config();
const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const TelegramBot = require("node-telegram-bot-api");
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const pino = require("pino");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = "https://www.ivasms.com";

// ==========================================
// 1. KELAS WA CHECKER (BAILEYS)
// ==========================================
class WAChecker {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.authDir = "./wa_session";
    this.bot = null; 
    this.ownerChatId = null; 
    this.pairingPhone = null;
  }

  async connect(bot = null, chatId = null, phoneNumber = null) {
    if (bot) this.bot = bot;
    if (chatId) this.ownerChatId = chatId;
    if (phoneNumber) this.pairingPhone = phoneNumber;

    if (this.sock) {
      this.sock.ev.removeAllListeners();
    }

    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();
    const silentLogger = pino({ level: "silent" });

    this.sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
      logger: silentLogger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on("creds.update", saveCreds);

    if (this.pairingPhone && !this.sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const formattedPhone = this.pairingPhone.replace(/\D/g, "");
          const code = await this.sock.requestPairingCode(formattedPhone);
          const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;

          if (this.bot && this.ownerChatId) {
            this.bot.sendMessage(
              this.ownerChatId, 
              `🔑 *Pairing Code WA:* \`${formattedCode}\`\n\nBuka WhatsApp di HP > Perangkat Tertaut > Tautkan dengan Nomor Telepon.`, 
              { parse_mode: "Markdown" }
            );
          }
        } catch (err) {
          console.error(`[ERROR] Gagal mendapatkan pairing code: ${err.message}`);
        }
      }, 3000); 
    }

    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        this.isConnected = true;
        if (this.bot && this.ownerChatId) {
          this.bot.sendMessage(this.ownerChatId, "✅ *WhatsApp Checker Online!*", { parse_mode: "Markdown" });
        }
      }

      if (connection === "close") {
        this.isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          if (fs.existsSync(this.authDir)) fs.rmSync(this.authDir, { recursive: true, force: true });
          if (this.bot && this.ownerChatId) {
            this.bot.sendMessage(this.ownerChatId, "❌ *Sesi WhatsApp Dikeluarkan.* Folder sesi dibersihkan. Silakan login ulang via menu.", { parse_mode: "Markdown" });
          }
        } else {
          setTimeout(() => this.connect(), 5000);
        }
      }
    });
  }

  async checkNumber(phone) {
    if (!this.isConnected || !this.sock) return { exists: false, error: "WA Disconnected" };
    const cleanNumber = phone.replace(/\D/g, "");
    const jid = `${cleanNumber}@s.whatsapp.net`;
    try {
      const [result] = await this.sock.onWhatsApp(cleanNumber);
      if (!result || !result.exists) return { exists: false };

      let bio = "-";
      try {
        const status = await this.sock.fetchStatus(jid);
        bio = status?.status || "-";
      } catch (err) {}

      return { exists: true, jid: result.jid, bio: bio };
    } catch (err) {
      return { exists: false, error: err.message };
    }
  }
}

// ==========================================
// 2. KELAS IVAS SMS SCRAPER
// ==========================================
class IVASSMSClient {
  constructor() {
    this.csrfToken = null;
    this.isLoggedIn = false;
    this.cookiePath = "./cookies.json";
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 20000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36" },
    });
    this.loadCookies();
  }

  loadCookies() {
    try {
      if (fs.existsSync(this.cookiePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.cookiePath, "utf8"));
        if (parsed.raw_cookie) {
          this.client.defaults.headers.common["Cookie"] = parsed.raw_cookie;
          return true;
        }
      }
    } catch (err) { return false; }
  }

  saveRawCookie(cookieString) {
    fs.writeFileSync(this.cookiePath, JSON.stringify({ raw_cookie: cookieString }));
    this.loadCookies();
  }

  async login() {
    try {
      const res = await this.client.get("/portal/sms/received");
      const $ = cheerio.load(res.data);
      this.csrfToken = $("input[name='_token']").val();
      this.isLoggedIn = !!this.csrfToken;
      return this.isLoggedIn;
    } catch (err) { return false; }
  }

  async getNumbers(date) {
    const data = new URLSearchParams({ from: date, to: date, _token: this.csrfToken });
    const res = await this.client.post("/portal/sms/received/getsms", data.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" }
    });
    const $ = cheerio.load(res.data);
    const numbers = [];
    $("div.item").each((i, el) => { numbers.push({ range: $(el).find(".col-sm-4").text().trim() }); });
    return numbers;
  }

  async getSpecificNumbers(range, date) {
    const data = new URLSearchParams({ _token: this.csrfToken, start: date, end: date, range });
    const res = await this.client.post("/portal/sms/received/getsms/number", data.toString());
    const $ = cheerio.load(res.data);
    const details = [];
    $("div.card.card-body").each((i, el) => { details.push({ phone: $(el).find(".col-sm-4").text().trim(), range }); });
    return details;
  }

  async getOtp(phone, range, date) {
    const data = new URLSearchParams({ _token: this.csrfToken, start: date, end: date, Number: phone, Range: range });
    const res = await this.client.post("/portal/sms/received/getsms/number/sms", data.toString());
    const $ = cheerio.load(res.data);
    return $(".col-9.col-sm-6 p").text().trim() || "Menunggu OTP / Kosong";
  }
}

// ==========================================
// 3. TELEGRAM BOT LOGIC
// ==========================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const ivas = new IVASSMSClient();
const waClient = new WAChecker();

// Manajer Status Pengguna (Untuk Pagination & Input Interaktif)
const userState = new Map();

// Helper untuk mendapatkan/membuat state pengguna
function getUserState(chatId) {
  if (!userState.has(chatId)) {
    userState.set(chatId, { allNumbers: [], date: null, lastUsedIndex: -1, inputMode: "idle" });
  }
  return userState.get(chatId);
}

waClient.connect(); 

// Menu Utama dengan Tombol
function sendMainMenu(chatId) {
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔑 Set Cookie IVAS", callback_data: "input_cookie" },
          { text: "📱 Login WA", callback_data: "input_wa" }
        ],
        [{ text: "📥 Fetch Nomor Terbaru", callback_data: "fetch_latest" }],
        [{ text: "📊 Status Sistem", callback_data: "bot_status" }]
      ]
    },
    parse_mode: "Markdown"
  };
  bot.sendMessage(
    chatId, 
    "🎛️ *Menu Utama Panel Otomatisasi*\n\nPilih aksi di bawah ini:", 
    opts
  );
}

// Fungsi Membangun Markup Pesan Nomor
function buildNumberMessageOpts(item) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Cek OTP (IVAS)", callback_data: `otp_${item.phone}_${item.range}` }],
        [{ text: "♻️ Ganti Nomor", callback_data: "change_number" }]
      ]
    },
    parse_mode: "Markdown"
  };
}

// Fungsi Mengirim Batch
async function sendNumberBatch(chatId, count = 3) {
  const state = getUserState(chatId);
  
  if (state.lastUsedIndex >= state.allNumbers.length - 1) {
    return bot.sendMessage(chatId, "⚠️ Daftar nomor sudah habis. Silakan kembali besok.");
  }

  for (let i = 0; i < count; i++) {
    state.lastUsedIndex++;
    if (state.lastUsedIndex >= state.allNumbers.length) break;

    const item = state.allNumbers[state.lastUsedIndex];
    
    const wa = await waClient.checkNumber(item.phone);
    let waText = wa.exists 
      ? `✅ *Terdaftar di WA*\n📝 Bio: _${wa.bio}_` 
      : `❌ *Tidak Terdaftar di WA*`;

    const msgText = `📱 Nomor: \`${item.phone}\`\n${waText}\n\n📨 Status: Menunggu OTP...`;
    await bot.sendMessage(chatId, msgText, buildNumberMessageOpts(item));
  }

  if (state.lastUsedIndex < state.allNumbers.length - 1) {
    bot.sendMessage(chatId, "Tampilkan nomor selanjutnya?", {
      reply_markup: {
        inline_keyboard: [[{ text: "⏭️ 3 Nomor Lagi", callback_data: "load_more" }]]
      }
    });
  }
}

// ==========================================
// HANDLERS
// ==========================================

bot.onText(/\/(start|menu)/, (msg) => {
  getUserState(msg.chat.id).inputMode = "idle"; // Reset mode input
  sendMainMenu(msg.chat.id);
});

// Menangkap balasan teks untuk input interaktif
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  
  const chatId = msg.chat.id;
  const state = getUserState(chatId);

  // Jika sedang mode input Cookie
  if (state.inputMode === "cookie") {
    state.inputMode = "idle"; // Matikan mode input
    ivas.saveRawCookie(msg.text);
    const loginOk = await ivas.login();
    if (loginOk) {
      bot.sendMessage(chatId, "✅ *Cookie berhasil disimpan & Login IVAS Sukses!*", { parse_mode: "Markdown" });
    } else {
      bot.sendMessage(chatId, "❌ *Gagal Login.* Pastikan teks cookie sudah lengkap.", { parse_mode: "Markdown" });
    }
    return sendMainMenu(chatId);
  }

  // Jika sedang mode input Nomor WA
  if (state.inputMode === "wa") {
    state.inputMode = "idle"; // Matikan mode input
    const phoneNumber = msg.text.trim();
    bot.sendMessage(chatId, `⏳ Meminta Pairing Code untuk nomor ${phoneNumber}...`);
    waClient.connect(bot, chatId, phoneNumber);
    return;
  }
});

// Handler Tombol Inline
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = getUserState(chatId);

  // TOMBOL: INPUT WA
  if (data === "input_wa") {
    bot.answerCallbackQuery(query.id);
    state.inputMode = "wa";
    bot.sendMessage(chatId, "📱 *Kirimkan nomor WhatsApp kamu* (Gunakan awalan kode negara, misal: `6281234567890`):", { parse_mode: "Markdown" });
  }

  // TOMBOL: INPUT COOKIE
  else if (data === "input_cookie") {
    bot.answerCallbackQuery(query.id);
    state.inputMode = "cookie";
    bot.sendMessage(chatId, "🔑 *Paste/Kirimkan raw cookie IVAS kamu* di sini:", { parse_mode: "Markdown" });
  }

  // TOMBOL: FETCH TERBARU
  else if (data === "fetch_latest") {
    if (!waClient.isConnected) {
      return bot.answerCallbackQuery(query.id, { text: "❌ WA belum siap! Login WA dulu.", show_alert: true });
    }
    if (!ivas.isLoggedIn) await ivas.login();
    if (!ivas.isLoggedIn) return bot.answerCallbackQuery(query.id, { text: "❌ Sesi IVAS mati. Set Cookie dulu!", show_alert: true });

    const today = new Date();
    const dateStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

    const waitMsg = await bot.sendMessage(chatId, `⏳ Mengambil daftar nomor untuk *${dateStr}*...`, { parse_mode: "Markdown" });
    
    const ranges = await ivas.getNumbers(dateStr);
    let allNumbers = [];
    
    for (const r of ranges) {
      const details = await ivas.getSpecificNumbers(r.range, dateStr);
      allNumbers = allNumbers.concat(details);
    }

    if (allNumbers.length === 0) {
      return bot.editMessageText(`⚠️ Tidak ada nomor tersedia untuk tanggal ${dateStr}.`, { chat_id: chatId, message_id: waitMsg.message_id });
    }

    state.allNumbers = allNumbers;
    state.date = dateStr;
    state.lastUsedIndex = -1;
    
    bot.deleteMessage(chatId, waitMsg.message_id);
    await sendNumberBatch(chatId, 3);
  }

  // TOMBOL: LOAD MORE
  else if (data === "load_more") {
    bot.answerCallbackQuery(query.id);
    await sendNumberBatch(chatId, 3);
  } 

  // TOMBOL: GANTI NOMOR
  else if (data === "change_number") {
    if (state.lastUsedIndex >= state.allNumbers.length - 1) {
      return bot.answerCallbackQuery(query.id, { text: "⚠️ Stok nomor dari IVAS sudah habis!", show_alert: true });
    }

    bot.answerCallbackQuery(query.id, { text: "♻️ Mengganti nomor..." });
    state.lastUsedIndex++;
    const newItem = state.allNumbers[state.lastUsedIndex];

    const wa = await waClient.checkNumber(newItem.phone);
    let waText = wa.exists 
      ? `✅ *Terdaftar di WA*\n📝 Bio: _${wa.bio}_` 
      : `❌ *Tidak Terdaftar di WA*`;

    const msgText = `📱 Nomor: \`${newItem.phone}\`\n${waText}\n\n📨 Status: Menunggu OTP...`;

    bot.editMessageText(msgText, {
      chat_id: chatId,
      message_id: query.message.message_id,
      ...buildNumberMessageOpts(newItem)
    });
  }

  // TOMBOL: CEK OTP
  else if (data.startsWith("otp_")) {
    const [_, phone, range] = data.split("_");
    
    bot.answerCallbackQuery(query.id, { text: "Memeriksa OTP ke IVAS..." });
    const otp = await ivas.getOtp(phone, range, state.date);
    
    const oldText = query.message.text.split("📨 Status:")[0].split("📨 OTP:")[0].trim(); 
    
    bot.editMessageText(`${oldText}\n\n📨 OTP: *${otp}*`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "Markdown",
      reply_markup: query.message.reply_markup
    });
  }

  // TOMBOL: STATUS BOT
  else if (data === "bot_status") {
    const waStatus = waClient.isConnected ? "✅ Online" : "❌ Disconnected";
    const ivasStatus = ivas.isLoggedIn ? "✅ Logged In" : "❌ No Session";
    bot.sendMessage(chatId, `📊 *Status Sistem*\n\nWhatsApp: ${waStatus}\nIVAS Scraper: ${ivasStatus}`, { parse_mode: "Markdown" });
    bot.answerCallbackQuery(query.id);
  }
});

console.log("[INFO] Telegram Bot berjalan...");
