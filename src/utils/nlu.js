// ---- Deterministic natural-language command parser ----
// Maps free-form text ("EURUSD analyse karo", "Roman Urdu mein samjhao",
// "reasoning batao") to a safe, fully deterministic internal request
// object - this project has no AI/LLM call anywhere, so intent parsing has
// always had to be, and remains, plain regex/keyword matching, not a
// language model.
// This is regex/keyword-based, not a language model, so it will miss
// unusual phrasings - documented as a known limitation in the README
// rather than hidden. It supports English, Roman Urdu, and mixed input
// for the specific patterns this bot actually needs (symbol, horizon,
// language preference, and a handful of intents), not general chat.
//
// Returns:
//   {
//     intent: 'analyze' | 'explain-last' | 'compare' | 'differences-only'
//             | 'dataquality' | 'reasoning',
//     symbol: string | null,     // e.g. "EURUSD", null if none found
//     horizonMinutes: number | null,
//     language: 'en' | 'roman-urdu' | 'urdu',
//     compact: boolean,
//   }

const { parseDurationToMinutes } = require('../commands/binary');

// Whitelist approach (deliberately NOT a stopword blacklist - a blacklist
// keeps missing words and matching them as false-positive "symbols", e.g.
// "dikhao"/"batao"/"check" in earlier testing). A token only counts as a
// symbol if it decomposes into two known currency/crypto codes - this is
// necessarily a small, incomplete list (documented limitation in the
// README), but it means a random Roman-Urdu verb never gets mistaken for
// a ticker, which matters more than covering every possible pair.
const CURRENCY_CODES = ['EUR', 'USD', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'CNY', 'CNH', 'SGD', 'HKD', 'MXN', 'ZAR', 'TRY', 'SEK', 'NOK', 'INR', 'PKR'];
const CRYPTO_CODES = ['BTC', 'ETH', 'XRP', 'LTC', 'SOL', 'DOGE', 'ADA', 'BNB', 'DOT', 'MATIC', 'AVAX', 'TRX', 'LINK', 'USDT', 'USDC'];
const ALL_CODES = new Set([...CURRENCY_CODES, ...CRYPTO_CODES]);

function isKnownPair(token) {
  for (let i = 3; i <= token.length - 3; i++) {
    if (ALL_CODES.has(token.slice(0, i)) && ALL_CODES.has(token.slice(i))) return true;
  }
  return false;
}

function findSymbol(text) {
  const slashMatch = text.match(/\b([A-Za-z]{2,5})\s*\/\s*([A-Za-z]{2,5})\b/);
  if (slashMatch) {
    const combined = (slashMatch[1] + slashMatch[2]).toUpperCase();
    if (isKnownPair(combined)) return combined;
  }
  const tokens = text.match(/\b[A-Za-z]{5,9}\b/g) || [];
  for (const t of tokens) {
    const upper = t.toUpperCase();
    if (isKnownPair(upper)) return upper;
  }
  return null;
}

function findHorizonMinutes(text) {
  // Reuse the exact same s/m/h duration parser the !binary command uses,
  // scanning word-by-word-ish chunks for the first one that parses.
  const matches = text.match(/\d+(?:\.\d+)?\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|din)\b/gi) || [];
  for (const m of matches) {
    const normalized = m.replace(/days?|din/i, 'h').replace(/(\d+(?:\.\d+)?)\s*h(ours?|rs?)?/i, (full, num) => `${Number(num) * (/days?|din/i.test(m) ? 24 : 1)}h`);
    const mins = parseDurationToMinutes(normalized.trim());
    if (mins != null) return mins;
  }
  return null;
}

function detectLanguage(text) {
  // Real Urdu script (Arabic-range characters) present -> 'urdu'.
  if (/[\u0600-\u06FF]/.test(text)) return 'urdu';
  if (/roman\s*urdu/i.test(text)) return 'roman-urdu';
  // If the message itself is written in common Roman-Urdu vocabulary,
  // default the RESPONSE to Roman Urdu too, matching how the user is
  // already talking rather than switching them to English.
  const romanUrduWords = /\b(bhai|kya|samjhao|kyun|karo|dikhao|batao|hai|nahi|mein|farak|pichl[ae]|is)\b/i;
  if (romanUrduWords.test(text)) return 'roman-urdu';
  return 'en';
}

function detectIntent(text) {
  const lower = text.toLowerCase();
  const wantsCompareWord = /\b(compare|comparisons?|farak|differences?)\b/i.test(lower);
  const onlyWord = /\b(only|sirf|just)\b/i.test(lower);
  if (wantsCompareWord && onlyWord) return 'differences-only';
  if (wantsCompareWord) return 'compare';
  if (/\b(data\s*quality|data\s*check)\b/i.test(lower)) return 'dataquality';
  if (/\b(reasoning|kyun|why|wajah|reason)\b/i.test(lower) && !/analy[sz]e/i.test(lower)) return 'reasoning';
  const referencesLast = /\b(last|pichl[ae]|isko|is analysis|ye analysis)\b/i.test(lower);
  const explainWord = /\b(explain|samjhao|samjhaye)\b/i.test(lower);
  if (explainWord && referencesLast && !findSymbol(text)) return 'explain-last';
  return 'analyze';
}

function parseMarketRequest(text) {
  const trimmed = (text || '').trim();
  return {
    intent: detectIntent(trimmed),
    symbol: findSymbol(trimmed),
    horizonMinutes: findHorizonMinutes(trimmed),
    language: detectLanguage(trimmed),
    compact: /\b(compact|short|brief|mukhtasar)\b/i.test(trimmed),
    raw: trimmed,
  };
}

module.exports = { parseMarketRequest, findSymbol, findHorizonMinutes, detectLanguage, detectIntent };
