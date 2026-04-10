const fs = require("fs");
const path = require("path");
const readline = require("readline");
const config = require("../config");
const { normalizeNumber, deduplicateNumbers } = require("../whatsapp/normalize");
const logger = require("./logger");

/**
 * Stream-parse a TXT file of phone numbers.
 * Returns array of normalized number objects (valid + deduplicated).
 * Respects max limit.
 */
async function parseTxtFile(filePath, defaultRegion = config.phone.defaultRegion) {
  const max = config.limits.maxNumbersPerRequest;
  const raw = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    
    // Support comma or semicolon separated on same line
    const parts = trimmed.split(/[,;]+/);
    for (const part of parts) {
      raw.push(part.trim());
      if (raw.length >= max * 3) break; // early stop reading
    }
    if (raw.length >= max * 3) break;
  }

  logger.info(`Read ${raw.length} raw entries from file`);

  const normalized = raw
    .map((n) => normalizeNumber(n, defaultRegion))
    .filter((n) => n.valid);

  const deduped = deduplicateNumbers(normalized);
  logger.info(`After normalize+dedup: ${deduped.length} valid unique numbers`);

  return deduped.slice(0, max);
}

/**
 * Write hasil.txt output
 */
async function writeHasil(results, outputDir = config.output.dir) {
  ensureDir(outputDir);
  const filePath = path.join(outputDir, "hasil.txt");
  const lines = [];

  for (const r of results) {
    const wa = r.waResult;
    lines.push(`Nomor   : ${r.e164}`);
    lines.push(`Negara  : ${r.country || "-"}`);
    lines.push(`Kode    : ${r.countryCode || "-"}`);
    lines.push(`Nasional: ${r.national || "-"}`);
    if (wa) {
      lines.push(`Nama    : ${wa.name || "-"}`);
      lines.push(`Bio     : ${wa.bio || "-"}`);
      lines.push(`Foto    : ${wa.photo || "-"}`);
      lines.push(`WA      : ${wa.exists ? "Terdaftar" : "Tidak terdaftar"}`);
    } else {
      lines.push(`WA      : Error/Timeout`);
    }
    lines.push("-------------------------");
  }

  await fs.promises.writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

/**
 * Write nomor_valid.txt output (registered WA numbers only)
 */
async function writeNomorValid(results, outputDir = config.output.dir) {
  ensureDir(outputDir);
  const filePath = path.join(outputDir, "nomor_valid.txt");
  const lines = results
    .filter((r) => r.waResult?.exists)
    .map((r) => `${r.e164}|${r.country || "XX"}`);

  await fs.promises.writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { parseTxtFile, writeHasil, writeNomorValid, ensureDir };
