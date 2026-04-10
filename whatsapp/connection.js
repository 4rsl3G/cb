const {
default: makeWASocket,
useMultiFileAuthState,
DisconnectReason,
fetchLatestBaileysVersion,
makeCacheableSignalKeyStore,
} = require(”@whiskeysockets/baileys”);
const pino = require(“pino”);
const path = require(“path”);
const config = require(”../config”);
const logger = require(”../utils/logger”);
const { ensureDir } = require(”../utils/file”);

class WhatsAppConnection {
constructor() {
this.sock = null;
this.state = null; // “connecting” | “open” | “closed”
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

```
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
  browser: ["WA-Checker", "Chrome", "10.0"],
  syncFullHistory: false,
  markOnlineOnConnect: false,
});

this.sock.ev.on("creds.update", saveCreds);

this.sock.ev.on("connection.update", async (update) => {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    if (phoneNumber && !this.sock.authState.creds.registered) {
      // Use pairing code instead of QR
      try {
        const code = await this.sock.requestPairingCode(
          phoneNumber.replace(/\D/g, "")
        );
        this.pairingCode = code;
        logger.info(`Pairing code generated: ${code}`);
        if (this._onPairingCode) this._onPairingCode(code);
      } catch (err) {
        logger.error("Failed to get pairing code, falling back to QR");
        if (this._onQr) this._onQr(qr);
      }
    } else {
      if (this._onQr) this._onQr(qr);
    }
  }

  if (connection === "open") {
    this.state = "open";
    logger.info("WhatsApp connected");
    if (this._onReady) this._onReady();
  }

  if (connection === "close") {
    this.state = "closed";
    const reason = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = reason !== DisconnectReason.loggedOut;

    logger.warn(`WA disconnected, reason: ${reason}, reconnect: ${shouldReconnect}`);

    if (this._onDisconnect) this._onDisconnect(reason);

    if (shouldReconnect) {
      this._scheduleReconnect();
    }
  }
});
```

}

_scheduleReconnect(delay = 5000) {
if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
this._reconnectTimer = setTimeout(() => {
logger.info(“Attempting WA reconnect…”);
this.connect(this._pairingPhone).catch((err) => {
logger.error(“Reconnect failed:”, err.message);
this._scheduleReconnect(10000);
});
}, delay);
}

isConnected() {
return this.state === “open” && !!this.sock;
}

getSocket() {
return this.sock;
}

async logout() {
if (this.sock) {
await this.sock.logout();
this.sock = null;
this.state = “closed”;
}
}
}

// Singleton
const waConnection = new WhatsAppConnection();
module.exports = waConnection;
