const waConnection = require("./connection");
const logger = require("../utils/logger");

/**
 * Check a single normalized number object against WhatsApp.
 * Returns enriched object with waResult.
 */
async function checkNumber(normalizedNumber) {
  const sock = waConnection.getSocket();
  if (!sock || !waConnection.isConnected()) {
    throw new Error("WhatsApp not connected");
  }

  const jid = `${normalizedNumber.e164.replace("+", "")}@s.whatsapp.net`;

  try {
    const [result] = await sock.onWhatsApp(normalizedNumber.e164.replace("+", ""));

    if (!result || !result.exists) {
      return {
        ...normalizedNumber,
        waResult: { exists: false, name: null, bio: null, photo: null },
      };
    }

    // Fetch profile info
    let name = null; // Display names are generally private unless they message you or are a Business account
    let bio = null;
    let photo = null;

    try {
      const statusResult = await sock.fetchStatus(jid);
      bio = statusResult?.status || null;
    } catch { 
      /* non-critical */ 
    }

    try {
      photo = await sock.profilePictureUrl(jid, "image");
    } catch { 
      /* non-critical, many accounts restrict this to "My Contacts" */ 
    }

    return {
      ...normalizedNumber,
      waResult: {
        exists: true,
        name,
        bio,
        photo,
      },
    };
  } catch (err) {
    // If we hit a rate limit, throw it up so the Queue manager can trigger a cooldown
    if (
      err?.message?.includes("rate") ||
      err?.message?.includes("limit") ||
      err?.output?.statusCode === 429
    ) {
      throw err; 
    }
    
    logger.warn(`Check failed for ${normalizedNumber.e164}: ${err.message}`);
    
    return {
      ...normalizedNumber,
      waResult: null,
      error: err.message,
    };
  }
}

module.exports = { checkNumber };
