/**
 * script.js — guarantee every lyric line is readable as Hindi or English.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * LRCLIB files are crowd-contributed, and a single file frequently mixes
 * writing systems. Measured on the real "Chaleya" record (id duration 200s):
 * 38 lines total — 30 Devanagari and **8 Gurmukhi**. Every Chaleya variant on
 * LRCLIB has the same 30/8 split, so there is no "clean" file to pick instead.
 * That is why the app showed lines in a script the user cannot read: it was
 * choosing the best available file, and the best available file is mixed.
 *
 * Rejecting those files would leave popular songs with no lyrics at all, so
 * instead we TRANSLITERATE the foreign script into Devanagari. The Brahmic
 * blocks are positionally aligned (Gurmukhi U+0A00 ↔ Devanagari U+0900), so
 * this is a lossless letter-for-letter mapping, not machine translation.
 *
 * SCOPE (per the product decision): the app targets readers of Hindi and
 * English. Devanagari and Latin pass through untouched. Gurmukhi, Bengali,
 * Gujarati and Odia are mapped to Devanagari. Scripts with no phonetic
 * correspondence (Tamil, Telugu, CJK, Cyrillic, Arabic…) are treated as
 * "unreadable" and cause the whole file to be rejected upstream.
 */

/** Devanagari consonants, used to place matras correctly. */
const CONS_S = '[\\u0915-\\u0939\\u0958-\\u095F]';
/** Devanagari dependent vowel signs (matras). */
const MATRA_S = '[\\u093E-\\u094C\\u0962\\u0963]';
const CONS_RE = new RegExp(CONS_S);

export const RE_DEVA = /[\u0900-\u097F]/;
export const RE_LATIN = /[A-Za-z]/;

/**
 * Scripts we can faithfully render as Devanagari, with the offset that maps
 * each block onto the Devanagari block.
 */
const CONVERTIBLE = [
  { name: 'gurmukhi', lo: 0x0a00, hi: 0x0a7f, delta: -0x100 },
  { name: 'bengali', lo: 0x0980, hi: 0x09ff, delta: -0x80 },
  { name: 'gujarati', lo: 0x0a80, hi: 0x0aff, delta: -0x180 },
  { name: 'odia', lo: 0x0b00, hi: 0x0b7f, delta: -0x200 },
];

/** Scripts a Hindi/English reader cannot read and that we cannot map. */
const UNREADABLE = [
  { name: 'tamil', re: /[\u0B80-\u0BFF]/g },
  { name: 'telugu', re: /[\u0C00-\u0C7F]/g },
  { name: 'kannada', re: /[\u0C80-\u0CFF]/g },
  { name: 'malayalam', re: /[\u0D00-\u0D7F]/g },
  { name: 'sinhala', re: /[\u0D80-\u0DFF]/g },
  { name: 'thai', re: /[\u0E00-\u0E7F]/g },
  { name: 'arabic', re: /[\u0600-\u06FF\u0750-\u077F]/g },
  { name: 'hebrew', re: /[\u0590-\u05FF]/g },
  { name: 'cyrillic', re: /[\u0400-\u04FF]/g },
  { name: 'greek', re: /[\u0370-\u03FF]/g },
  { name: 'cjk', re: /[\u4E00-\u9FFF\u3400-\u4DBF]/g },
  { name: 'hangul', re: /[\uAC00-\uD7AF\u1100-\u11FF]/g },
  { name: 'kana', re: /[\u3040-\u30FF]/g },
];

/** Letters whose position does not line up and must be mapped explicitly. */
const DIRECT = {
  0x0a59: 0x0959, // ਖ਼ → ख़
  0x0a5a: 0x095a, // ਗ਼ → ग़
  0x0a5b: 0x095b, // ਜ਼ → ज़
  0x0a5c: 0x095c, // ੜ → ड़
  0x0a5e: 0x095e, // ਫ਼ → फ़
  0x0a72: 0x0905, // ਇੜੀ (bearer) → अ
  0x0a73: 0x0905, // ਊੜਾ (bearer) → अ
  0x0a74: 0x0950, // ੴ → ॐ
};

const ADDAK = '\u0A71'; // ੱ — geminates the FOLLOWING consonant
const TIPPI = '\u0A70'; // ੰ — nasalisation
const ANUSVARA = '\u0902'; // ं

/**
 * Transliterate one string into Devanagari.
 *
 * Two passes are required because Gurmukhi's addak marks the consonant that
 * comes AFTER it, whereas Devanagari expresses gemination as an explicit
 * conjunct (क + ् + क), so the character has to be rewritten in place.
 */
export function toDevanagari(input) {
  const str = String(input || '');
  if (!str) return '';

  // Pass 1 — block-shift every convertible codepoint.
  let s = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);

    if (c === TIPPI.codePointAt(0) || c === 0x0a02) { s += ANUSVARA; continue; }
    if (c === ADDAK.codePointAt(0)) { s += ADDAK; continue; } // resolved in pass 2
    if (DIRECT[c]) { s += String.fromCodePoint(DIRECT[c]); continue; }

    const block = CONVERTIBLE.find((b) => c >= b.lo && c <= b.hi);
    if (block) {
      const mapped = c + block.delta;
      s += mapped >= 0x0900 && mapped <= 0x097f ? String.fromCodePoint(mapped) : ch;
      continue;
    }
    s += ch;
  }

  // Pass 2 — expand addak into a proper conjunct.
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === ADDAK) {
      const next = s[i + 1];
      if (next && CONS_RE.test(next)) out += `${next}\u094D`;
      continue;
    }
    out += s[i];
  }

  // Pass 3 — an independent vowel cannot follow a matra in Devanagari
  // orthography; Punjabi ਲਿਆ is Hindi लिया, not लिा. Two-vowel sequences are
  // handled before single ones so ੋਇਆ collapses to ोया rather than ोयिआ.
  const m = (pattern, repl) => { out = out.replace(new RegExp(pattern, 'g'), repl); };
  m(`(${MATRA_S})\u0907\u0906`, '$1\u092F\u093E');
  m(`(${MATRA_S})\u0908\u0906`, '$1\u092F\u093E');
  m(`(${MATRA_S})\u0906`, '$1\u092F\u093E');
  m(`(${MATRA_S})\u0907`, '$1\u092F\u093F');
  m(`(${MATRA_S})\u0908`, '$1\u092F\u0940');
  m(`(${MATRA_S})\u090F`, '$1\u092F\u0947');
  m(`(${CONS_S})\u0906`, '$1\u093E');

  return out;
}

/**
 * Describe the scripts present in a set of lyric lines.
 * @returns {{deva:number, latin:number, convertible:number, unreadable:number,
 *            unreadableName:string|null}} ratios of non-empty lines
 */
export function analyseScripts(lines) {
  const texts = (lines || []).map((l) => String(l?.text || '').trim()).filter(Boolean);
  if (!texts.length) {
    return { deva: 0, latin: 0, convertible: 0, unreadable: 0, unreadableName: null };
  }

  let deva = 0;
  let latin = 0;
  let convertible = 0;
  let unreadable = 0;
  const badNames = new Map();

  for (const t of texts) {
    if (RE_DEVA.test(t)) deva += 1;

    const conv = CONVERTIBLE.some((b) => {
      for (const ch of t) {
        const c = ch.codePointAt(0);
        if (c >= b.lo && c <= b.hi) return true;
      }
      return false;
    });
    if (conv) convertible += 1;

    let bad = false;
    for (const u of UNREADABLE) {
      u.re.lastIndex = 0;
      if (u.re.test(t)) {
        bad = true;
        badNames.set(u.name, (badNames.get(u.name) || 0) + 1);
        break;
      }
    }
    if (bad) unreadable += 1;
    else if (!RE_DEVA.test(t) && !conv && RE_LATIN.test(t)) latin += 1;
  }

  const n = texts.length;
  let worst = null;
  let worstN = 0;
  for (const [name, count] of badNames) if (count > worstN) { worstN = count; worst = name; }

  return {
    deva: deva / n,
    latin: latin / n,
    convertible: convertible / n,
    unreadable: unreadable / n,
    unreadableName: worst,
  };
}

/**
 * Normalise a whole lyric line list for a Hindi/English audience.
 *
 * @param {Array<{time:number,text:string}>} lines
 * @param {boolean} wantHindi  true when the song is Hindi/Punjabi/Urdu
 * @returns {{lines:Array, ok:boolean, reason:string|null, converted:number,
 *            script:'devanagari'|'latin'|'mixed'}}
 */
export function normaliseLines(lines, wantHindi) {
  const stats = analyseScripts(lines);

  // A file with a meaningful amount of unmappable script is unusable — showing
  // Tamil or Korean to a Hindi/English reader is worse than showing nothing.
  if (stats.unreadable > 0.15) {
    return {
      lines,
      ok: false,
      reason: `contains ${stats.unreadableName} text`,
      converted: 0,
      script: 'mixed',
    };
  }

  let converted = 0;
  const out = (lines || []).map((l) => {
    const text = String(l?.text || '');
    const fixed = toDevanagari(text);
    if (fixed !== text) converted += 1;
    return { ...l, text: fixed };
  });

  const after = analyseScripts(out);

  // A Hindi song must not be served as romanised Latin — that was an explicit
  // product requirement. Mixed Devanagari + a few Latin ad-libs ("ohh", "oh")
  // is fine and normal.
  if (wantHindi && after.deva < 0.5 && after.latin > 0.5) {
    return { lines: out, ok: false, reason: 'romanised, not Devanagari', converted, script: 'latin' };
  }

  return {
    lines: out,
    ok: true,
    reason: null,
    converted,
    script: after.deva >= 0.5 ? 'devanagari' : 'latin',
  };
}

/* ── Devanagari → Latin (for SEARCH ONLY, never for display) ───────── */

/**
 * Many Indian uploads title the video in Hindi ("तुम ही हो आशिकी 2 पूरा गाना").
 * LRCLIB and iTunes index those songs under romanised names, so a Devanagari
 * title finds nothing and the app then latches onto whatever unrelated record
 * the fuzzy search returns — this is how "Tum Hi Ho" ended up matched to
 * "Yehai Asliyat". Romanising the title gives the lookup something it can
 * actually match.
 *
 * This is used purely to build QUERIES. Displayed lyrics stay in Devanagari.
 */
const R_VOWEL = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
  'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
};
const R_MATRA = {
  '\u093E': 'aa', '\u093F': 'i', '\u0940': 'ee', '\u0941': 'u', '\u0942': 'oo',
  '\u0943': 'ri', '\u0947': 'e', '\u0948': 'ai', '\u094B': 'o', '\u094C': 'au',
};
const R_CONS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'ऱ': 'r',
};
const VIRAMA = '\u094D';
const isDeva = (c) => c >= '\u0900' && c <= '\u097F';

function romanizeWord(word) {
  const a = [...word];
  let o = '';
  for (let i = 0; i < a.length; i += 1) {
    const ch = a[i];
    if (R_CONS[ch]) {
      o += R_CONS[ch];
      const nx = a[i + 1];
      if (nx === VIRAMA) { i += 1; continue; }
      if (nx && R_MATRA[nx]) {
        o += R_MATRA[nx];
        i += 1;
        const n2 = a[i + 1];
        if (n2 === '\u0902' || n2 === '\u0901') { o += 'n'; i += 1; }
        continue;
      }
      if (nx === '\u0902' || nx === '\u0901') { o += 'an'; i += 1; continue; }
      // Hindi deletes the inherent schwa at the end of a word: तुम = "tum".
      const isFinal = !a.slice(i + 1).some(isDeva);
      if (!isFinal) o += 'a';
      continue;
    }
    if (R_VOWEL[ch]) { o += R_VOWEL[ch]; continue; }
    if (R_MATRA[ch]) { o += R_MATRA[ch]; continue; }
    if (ch === '\u0902' || ch === '\u0901') { o += 'n'; continue; }
    if (ch === '\u093D' || ch === '\u0964') continue;
    o += ch;
  }
  return o;
}

/** Romanise any Devanagari in a string; leaves Latin text untouched. */
export function romanize(input) {
  return String(input || '')
    .split(/(\s+)/)
    .map((w) => (RE_DEVA.test(w) ? romanizeWord(w) : w))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strict romanisation is phonetically right but does NOT match how songs are
 * actually spelled in music databases. Measured against LRCLIB:
 *   "tum hee ho" → 0 results,   "tum hi ho"  → 20
 *   "kesariyaa"  → 0 results,   "kesariya"   → 20
 *   "satarangaa" → 0 results,   "satranga"   → 20
 * Bollywood titles use a loose convention: long vowels are written short and
 * trailing 'aa' is dropped. This produces that popular spelling so lookups hit.
 */
export function popularSpelling(input) {
  return String(input || '')
    .replace(/aa\b/g, 'a')   // kesariyaa -> kesariya
    .replace(/ee/g, 'i')      // tum hee ho -> tum hi ho
    .replace(/oo/g, 'u')
    .replace(/aa/g, 'a')      // satarangaa -> satranga
    .replace(/\s+/g, ' ')
    .trim();
}

/** Both spellings of a Devanagari string, best-guess first. */
export function romanVariants(input) {
  const strict = romanize(input);
  if (!strict) return [];
  const popular = popularSpelling(strict);
  return [...new Set([popular, strict].filter(Boolean))];
}
