// Spaced repetition (Leitner-style boxes). Box 0 = new/forgotten.
import { get, save } from "./store.js";

const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];
const DAY = 86400000;

export function ensureCard(id) {
  const s = get();
  if (!s.srs[id]) { s.srs[id] = { box: 0, due: Date.now(), wrong: 0, right: 0, last: null }; save(); }
  return s.srs[id];
}

// grade: 0 = quên, 1 = khó, 2 = nhớ
export function grade(id, g) {
  const c = ensureCard(id);
  if (g === 0) { c.box = 0; c.wrong++; c.due = Date.now() + 10 * 60 * 1000; }
  else if (g === 1) { c.box = Math.max(1, c.box); c.right++; c.due = Date.now() + Math.max(1, INTERVAL_DAYS[c.box]) * DAY * 0.5; }
  else { c.box = Math.min(INTERVAL_DAYS.length - 1, c.box + 1); c.right++; c.due = Date.now() + INTERVAL_DAYS[c.box] * DAY; }
  c.last = Date.now();
  save();
}

// Record an exercise outcome without the learner grading a flashcard.
export function exerciseResult(id, ok) {
  const c = ensureCard(id);
  if (ok) { c.right++; if (c.box === 0) { c.box = 1; c.due = Date.now() + DAY; } }
  else { c.wrong++; c.box = 0; c.due = Date.now(); }
  c.last = Date.now();
  save();
}

// Due cards, weakest first (more mistakes, lower box, most overdue).
export function dueCards(limit = 30) {
  const s = get();
  const now = Date.now();
  return Object.entries(s.srs)
    .filter(([, c]) => c.due <= now)
    .sort(([, a], [, b]) => (b.wrong - b.right * 0.3) - (a.wrong - a.right * 0.3) || a.box - b.box || a.due - b.due)
    .slice(0, limit)
    .map(([id]) => id);
}

export function stats() {
  const cards = Object.values(get().srs);
  return {
    total: cards.length,
    learned: cards.filter(c => c.box >= 3).length,
    due: cards.filter(c => c.due <= Date.now()).length
  };
}
