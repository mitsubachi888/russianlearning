// Local, per-device state. Everything lives in localStorage (wrapped in try/catch) and can be
// exported/imported as a JSON backup from Settings.
const KEY = "ru-learning-v1";

const DEFAULT = () => ({
  version: 1,
  settings: { translit: true, stressColor: true, rate: 0.9, voiceURI: "", theme: "auto" },
  steps: {},      // "t01.A.3": ISO date when completed
  parts: {},      // "t01.A": ISO date when completed
  srs: {},        // itemId: { box, due, wrong, right, last }
  errors: {},     // tag: count  (e.g. "letter:В", "gender", "stress")
  reports: [],    // { at, where, text }
  days: [],       // "2026-10-30" days with activity
  log: [],        // learning events, xAPI-like: { at, verb, object, result }
  lastStudy: null
});

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT();
    const s = JSON.parse(raw);
    const d = DEFAULT();
    return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
  } catch (e) {
    return DEFAULT();
  }
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
  catch (e) { return false; }
}

export function get() { return state; }

export function setSetting(k, v) { state.settings[k] = v; save(); }

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function touch() {
  const t = today();
  if (!state.days.includes(t)) state.days.push(t);
  state.lastStudy = new Date().toISOString();
  save();
}

export function logEvent(verb, object, result) {
  state.log.push({ at: new Date().toISOString(), verb, object, result });
  if (state.log.length > 3000) state.log = state.log.slice(-3000);
  touch();
}

export function markStep(key) { if (!state.steps[key]) { state.steps[key] = new Date().toISOString(); save(); } }
export function stepDone(key) { return !!state.steps[key]; }
export function markPart(key) { if (!state.parts[key]) { state.parts[key] = new Date().toISOString(); logEvent("part_completed", key); } }
export function partDone(key) { return !!state.parts[key]; }

export function addError(tag) { if (!tag) return; state.errors[tag] = (state.errors[tag] || 0) + 1; save(); }

export function addReport(where, text) {
  state.reports.push({ at: new Date().toISOString(), where, text });
  save();
}

export function exportJSON() { return JSON.stringify(state, null, 2); }

export function importJSON(text) {
  const s = JSON.parse(text);
  if (!s || typeof s !== "object" || !s.settings) throw new Error("File không đúng định dạng sao lưu.");
  const d = DEFAULT();
  state = { ...d, ...s, settings: { ...d.settings, ...s.settings } };
  save();
}

export function resetAll() { state = DEFAULT(); save(); }

export function daysSinceLastStudy() {
  if (!state.lastStudy) return null;
  return Math.floor((Date.now() - new Date(state.lastStudy).getTime()) / 86400000);
}
