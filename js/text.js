// Text helpers for Russian: stress rendering, normalisation, transliteration, hints, word diff.
export const ACUTE = "́";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function stripStress(s) {
  return String(s ?? "").normalize("NFD").replace(/́/g, "").normalize("NFC");
}

// Render Russian with the stressed vowel highlighted (keeps the acute mark; ё is always stressed).
export function ru(s) {
  const t = String(s ?? "").normalize("NFC");
  let out = "";
  const chars = [...t];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (next === ACUTE) {
      out += `<span class="st">${esc(c)}${ACUTE}</span>`;
      i++;
    } else if (c === "ё" || c === "Ё") {
      out += `<span class="st">${esc(c)}</span>`;
    } else {
      out += esc(c);
    }
  }
  return out;
}

// For comparing answers: lower case, no stress, ё→е, no punctuation, single spaces.
export function norm(s) {
  return stripStress(s)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,!?;:«»"“”„()\-–—…]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TR = {
  а:"a", б:"b", в:"v", г:"g", д:"d", е:"e", ё:"yo", ж:"zh", з:"z", и:"i", й:"y", к:"k", л:"l", м:"m",
  н:"n", о:"o", п:"p", р:"r", с:"s", т:"t", у:"u", ф:"f", х:"kh", ц:"ts", ч:"ch", ш:"sh", щ:"shch",
  ъ:"ʺ", ы:"y", ь:"ʹ", э:"e", ю:"yu", я:"ya"
};
// Simple transliteration (spelling-based, not a phonetic transcription).
export function translit(s) {
  const t = stripStress(s);
  let out = "";
  const chars = [...t];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const lower = c.toLowerCase();
    let r = TR[lower];
    if (r === undefined) { out += c; continue; }
    // е at word start or after vowel/ъ/ь → ye
    if (lower === "е") {
      const prev = (chars[i - 1] || " ").toLowerCase();
      if (!/[а-яё]/.test(prev) || "аеёиоуыэюяъь".includes(prev)) r = "ye";
    }
    if (c !== lower) r = r.charAt(0).toUpperCase() + r.slice(1);
    out += r;
  }
  return out;
}

export function tokens(s) {
  return String(s ?? "").normalize("NFC").split(/(\s+)/);
}

function isWord(t) { return /[\p{L}]/u.test(t); }

function maskWord(w, keep) {
  // keep leading letters (stress marks count as part of the letter), mask the rest, keep trailing punctuation
  const m = w.match(/^([\p{L}́\-]+)(.*)$/u);
  if (!m) return esc(w);
  const letters = [...m[1].normalize("NFD")].filter(ch => ch !== ACUTE);
  const shown = letters.slice(0, keep).join("");
  const hidden = letters.length - keep;
  if (hidden <= 0) return esc(w);
  return `${esc(shown)}<span class="mask">${"_".repeat(hidden)}</span>${esc(m[2])}`;
}

// level 1: full sentence; level 2: hide ~1/3 of words (longest = key words first), keep 2–3 first letters;
// level 3: first letter of every word only.
export function hintLine(sentence, level) {
  if (level <= 1) return ru(sentence);
  const parts = tokens(sentence);
  const wordIdx = parts.map((t, i) => (isWord(t) ? i : -1)).filter(i => i >= 0);
  if (level === 2) {
    const ranked = [...wordIdx]
      .filter(i => [...stripStress(parts[i])].filter(ch => /\p{L}/u.test(ch)).length >= 3)
      .sort((a, b) => stripStress(parts[b]).length - stripStress(parts[a]).length);
    const n = Math.max(1, Math.round(wordIdx.length / 3));
    const hide = new Set(ranked.slice(0, n));
    return parts.map((t, i) => {
      if (!hide.has(i)) return isWord(t) ? ru(t) : esc(t);
      const len = [...stripStress(t)].filter(ch => /\p{L}/u.test(ch)).length;
      return maskWord(t, len >= 6 ? 3 : 2);
    }).join("");
  }
  return parts.map(t => (isWord(t) ? maskWord(t, 1) : esc(t))).join("");
}

// Word-level diff (LCS) between expected and given text, on normalised words.
export function wordDiff(expected, given) {
  const a = norm(expected).split(" ").filter(Boolean);
  const b = norm(given).split(" ").filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ t: "ok", w: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "miss", w: a[i] }); i++; }
    else { ops.push({ t: "extra", w: b[j] }); j++; }
  }
  while (i < a.length) ops.push({ t: "miss", w: a[i++] });
  while (j < b.length) ops.push({ t: "extra", w: b[j++] });
  const okCount = ops.filter(o => o.t === "ok").length;
  return { ops, score: a.length ? okCount / a.length : 0, exact: okCount === a.length && b.length === a.length };
}

export function diffHtml(ops) {
  return ops.map(o => {
    if (o.t === "ok") return `<span class="okw">${esc(o.w)}</span>`;
    if (o.t === "miss") return `<span class="miss">${esc(o.w)}</span>`;
    return `<span class="extra">${esc(o.w)}</span>`;
  }).join(" ");
}

// Tiny markdown: paragraphs, bullet lists, **bold**, *italic*, Russian in {ru:...} gets stress styling.
export function md(src) {
  const inline = s => esc(s)
    .replace(/\{ru:([^}]+)\}/g, (_, x) => `<span class="ru">${ru(x.replace(/&#39;/g, "'"))}</span>`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>");
  const blocks = String(src ?? "").trim().split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split("\n");
    if (lines.every(l => /^\s*[-•]\s+/.test(l))) {
      return "<ul>" + lines.map(l => `<li>${inline(l.replace(/^\s*[-•]\s+/, ""))}</li>`).join("") + "</ul>";
    }
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
