const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers, // Ditambahkan: Wajib untuk fix Pairing Code
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const config = require("../config");
const logger = require("../utils/logger");
const { ensureDir } = require("../utils/file");

class WhatsAppConnection {
  constructor() {
    this.sock = null;
    this.state = null; // "connecting" | "open" | "closed"
    this.authDir = config.whatsapp.sessionDir;
    this.pairingCode = null;
    this._onPairingCode = null; // callback(code)
    this._onQr = null;         // callback(qr)
    this._onReady = null;      // callback()
    this._onDisconnect = null; // callback(reason)
    this._reconnectTimer = null;
    this._pairingPhone = null;
  }

  onPairingCode(cb) { this._onPairingCode = cb; }
  onQr(cb) { this._onQr = cb; }
  onReady(cb) { this._onReady = cb; }
  onDisconnect(cb) { this._onDisconnect = cb; }

  async connect(phoneNumber = null) {
    ensureDir(this.authDir);
    this._pairingPhone = phoneNumber;

    // FIX MEMORY LEAK: Bersihkan socket & listener lama jika ini adalah proses reconnect
    if (this.sock) {
      this.sock.ev.removeAllListeners();
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    
    // MENGAMBIL VERSI TERBARU: Otomatis dari endpoint WhatsApp Web
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

    const silentLogger = pino({ level: "silent" });

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      printQRInTerminal: false,
      logger: silentLogger,
      // FIX PAIRING CODE: WA menolak nama kustom. Gunakan standar resmi Baileys.
      browser: Browsers.ubuntu("Chrome"), 
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreviews: false, // Mempercepat koneksi
    });

    this.sock.ev.on("creds.update", saveCreds);

    // FIX PAIRING CODE REQUEST: Berikan jeda agar handshake socket selesai
    if (phoneNumber && !this.sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const formattedPhone = phoneNumber.replace(/\D/g, "");
          const code = await this.sock.requestPairingCode(formattedPhone);
          
          const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
          this.pairingCode = formattedCode;
          
          logger.info(`Pairing code generated: ${formattedCode}`);
          if (this._onPairingCode) this._onPairingCode(formattedCode);
        } catch (err) {
          logger.error(`Failed to get pairing code: ${err.message}`);
        }
      }, 3000);
    }

    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !phoneNumber && !this.sock.authState.creds.registered) {
        if (this._onQr) this._onQr(qr);
      }

      if (connection === "open") {
        this.state = "open";
        logger.info("WhatsApp connected successfully!");
        if (this._onReady) this._onReady();
      }

      if (connection === "close") {
        this.state = "closed";
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        
        // Klasifikasi disconnect
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;
        const shouldReconnect = !isLoggedOut;

        logger.warn(`WA disconnected, reason: ${statusCode}, reconnect: ${shouldReconnect}`);

        if (this._onDisconnect) this._onDisconnect(statusCode);

        if (shouldReconnect) {
          // Jika hanya butuh restart internal Baileys, reconnect langsung
          const delay = isRestartRequired ? 1000 : 5000;
          this._scheduleReconnect(delay);
        } else {
          logger.info("Session logged out explicitly. Clearing local session folder...");
          this._clearSession();
        }
      }
    });
  }

  _scheduleReconnect(delay = 5000) {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      logger.info("Attempting WA auto-reconnect...");
      this.connect(this._pairingPhone).catch((err) => {
        logger.error(`Reconnect failed: ${err.message}`);
        this._scheduleReconnect(10000); // Backoff pelan-pelan jika server down
      });
    }, delay);
  }

  _clearSession() {
    try {
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
        logger.info("Session folder cleared successfully.");
      }
    } catch (err) {
      logger.error(`Failed to clear session folder: ${err.message}`);
    }
  }

  isConnected() {
    return this.state === "open" && !!this.sock;
  }

  getSocket() {
    return this.sock;
  }

  async logout() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (err) {
        logger.error(`Error during logout: ${err.message}`);
      }
      this.sock = null;
      this.state = "closed";
      this._clearSession();
    }
  }
}

// Singleton
const waConnection = new WhatsAppConnection();
module.exports = waConnection;
