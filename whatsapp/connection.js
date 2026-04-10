const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs"); // Ditambahkan untuk hapus session
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

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const silentLogger = pino({ level: "silent" });

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      printQRInTerminal: false,
      logger: silentLogger,
      browser: ["WA-Checker", "Chrome", "10.0"], // Browser ident untuk WA Web
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on("creds.update", saveCreds);

    // FIX PAIRING CODE: Panggil sekali saja setelah socket dibuat (delay 3 detik agar stabil)
    if (phoneNumber && !this.sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const formattedPhone = phoneNumber.replace(/\D/g, "");
          const code = await this.sock.requestPairingCode(formattedPhone);
          
          // Format kode menjadi balok (XXXX-XXXX) agar mudah dibaca jika mau
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

      // FIX QR: Hanya emit QR jika TIDAK sedang request pairing code menggunakan nomor telepon
      if (qr && !phoneNumber && !this.sock.authState.creds.registered) {
        if (this._onQr) this._onQr(qr);
      }

      if (connection === "open") {
        this.state = "open";
        logger.info("WhatsApp connected");
        if (this._onReady) this._onReady();
      }

      if (connection === "close") {
        this.state = "closed";
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        
        // Cek apakah disconnect karena dilogout secara manual
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isLoggedOut;

        logger.warn(`WA disconnected, reason: ${statusCode}, reconnect: ${shouldReconnect}`);

        if (this._onDisconnect) this._onDisconnect(statusCode);

        if (shouldReconnect) {
          this._scheduleReconnect();
        } else {
          // FIX AUTO RECONNECT: Bersihkan folder session jika akun dilogout paksa
          logger.info("Session logged out. Clearing local session folder...");
          this._clearSession();
        }
      }
    });
  }

  _scheduleReconnect(delay = 5000) {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      logger.info("Attempting WA reconnect...");
      this.connect(this._pairingPhone).catch((err) => {
        logger.error("Reconnect failed:", err.message);
        // Exponential backoff pelan-pelan
        this._scheduleReconnect(10000); 
      });
    }, delay);
  }

  // Utility tambahan untuk menghapus folder session
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
