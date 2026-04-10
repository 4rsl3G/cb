const {
  parsePhoneNumberFromString,
  parsePhoneNumber,
  isValidPhoneNumber,
  isPossiblePhoneNumber,
  getNumberType,
} = require("libphonenumber-js");

/**
 * Cleans raw input: removes spaces, dashes, parens, letters
 * Keeps only digits and leading +
 */
function cleanInput(input) {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  // Keep leading + if present, then strip all non-digits
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Maps libphonenumber-js number types to readable strings
 */
function resolveType(parsed) {
  try {
    const t = getNumberType(parsed);
    const map = {
      MOBILE: "mobile",
      FIXED_LINE: "fixed",
      FIXED_LINE_OR_MOBILE: "mobile/fixed",
      VOIP: "voip",
      PAGER: "pager",
      TOLL_FREE: "toll_free",
      PREMIUM_RATE: "premium",
      SHARED_COST: "shared_cost",
      PERSONAL_NUMBER: "personal",
      UAN: "uan",
      VOICEMAIL: "voicemail",
      UNKNOWN: "unknown",
    };
    return map[t] || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Normalize a phone number input to a standard object.
 * @param {string} input - Raw phone number string
 * @param {string} defaultRegion - ISO 3166-1 alpha-2 country code fallback
 * @returns {object}
 */
function normalizeNumber(input, defaultRegion = "ID") {
  const base = {
    original: input,
    e164: null,
    country: null,
    countryCode: null,
    national: null,
    type: null,
    valid: false,
    possible: false,
  };

  const cleaned = cleanInput(input);
  if (!cleaned || cleaned.replace(/\D/g, "").length < 6) return base;

  let parsed = null;

  // Attempt 1: parse with default region
  try {
    parsed = parsePhoneNumberFromString(cleaned, defaultRegion);
  } catch {
    parsed = null;
  }

  // Attempt 2: try with E.164 guess (prepend +)
  if (!parsed || !parsed.isValid()) {
    const digitsOnly = cleaned.replace(/\D/g, "");
    if (digitsOnly.length >= 7) {
      try {
        parsed = parsePhoneNumberFromString(`+${digitsOnly}`, defaultRegion);
      } catch {
        parsed = null;
      }
    }
  }

  if (!parsed) return base;

  const possible = isPossiblePhoneNumber(parsed.number, defaultRegion);
  const valid = parsed.isValid();
  const e164 = parsed.format("E.164");
  const country = parsed.country || null;
  const callingCode = parsed.countryCallingCode
    ? `+${parsed.countryCallingCode}`
    : null;
  const national = parsed.nationalNumber || null;
  const type = resolveType(parsed);

  return {
    original: input,
    e164,
    country,
    countryCode: callingCode,
    national,
    type,
    valid,
    possible,
  };
}

/**
 * Deduplicate array of normalized number objects by e164
 */
function deduplicateNumbers(numbers) {
  const seen = new Set();
  return numbers.filter((n) => {
    if (!n.valid || !n.e164) return false;
    if (seen.has(n.e164)) return false;
    seen.add(n.e164);
    return true;
  });
}

module.exports = { normalizeNumber, deduplicateNumbers, cleanInput };
