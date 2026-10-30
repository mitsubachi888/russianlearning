// Text-to-speech (device voices) and microphone recording.
import { stripStress } from "./text.js";
import { get } from "./store.js";

let voices = [];
function loadVoices() {
  try { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; } catch (e) { voices = []; }
}
if (typeof window !== "undefined" && window.speechSynthesis) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

export function russianVoices() {
  loadVoices();
  return voices.filter(v => /^ru(-|_|$)/i.test(v.lang));
}

export function ttsAvailable() { return !!window.speechSynthesis; }

export function speak(text, { slow = false, onend, queue = false } = {}) {
  if (!window.speechSynthesis) { onend?.(); return false; }
  try {
    if (!queue) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(stripStress(text));
    u.lang = "ru-RU";
    const pref = get().settings.voiceURI;
    const list = russianVoices();
    const v = list.find(x => x.voiceURI === pref) || list[0];
    if (v) u.voice = v;
    const base = Number(get().settings.rate) || 0.9;
    u.rate = slow ? Math.max(0.4, base * 0.6) : base;
    if (onend) { u.onend = () => onend(); u.onerror = () => onend(); }
    speechSynthesis.speak(u);
    return true;
  } catch (e) { return false; }
}

// Recorder: manual stop, hard limit 60 s.
export class Recorder {
  constructor({ max = 60, onTick, onStop } = {}) {
    this.max = max; this.onTick = onTick; this.onStop = onStop;
    this.chunks = []; this.url = null; this.blob = null; this.timer = null; this.secs = 0;
  }
  static supported() { return !!(navigator.mediaDevices && window.MediaRecorder); }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(t => MediaRecorder.isTypeSupported?.(t)) || "";
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => {
      this.blob = new Blob(this.chunks, { type: this.rec.mimeType || "audio/mp4" });
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(this.blob);
      this.stream.getTracks().forEach(t => t.stop());
      clearInterval(this.timer);
      this.onStop?.(this);
    };
    this.secs = 0;
    this.rec.start();
    this.timer = setInterval(() => {
      this.secs++;
      this.onTick?.(this.secs);
      if (this.secs >= this.max) this.stop();
    }, 1000);
  }
  stop() { if (this.rec && this.rec.state === "recording") this.rec.stop(); }
  get recording() { return this.rec?.state === "recording"; }
  play() { if (this.url) { const a = new Audio(this.url); a.play().catch(() => {}); return a; } }
}
