import { esc, ru, md, translit, hintLine, norm, wordDiff, diffHtml, shuffle } from "./text.js";
import * as store from "./store.js";
import { ensureCard, grade, exerciseResult, dueCards, stats } from "./srs.js";
import { speak, Recorder, russianVoices, ttsAvailable } from "./speech.js";

const APP_VERSION = "0.2.0";

// iOS Safari sometimes still zooms on fast double taps outside buttons; block that gesture only.
let lastTouchEnd = 0;
document.addEventListener("touchend", e => {
  const now = Date.now();
  if (now - lastTouchEnd < 350 && !e.target.closest("input, textarea, select")) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener("dblclick", e => e.preventDefault(), { passive: false });
const view = document.getElementById("view");
let course = null;
const topics = {};      // id -> topic json
const items = {};       // itemId -> item (with topic id)
let compare = {};
let cleanup = [];       // functions to run when leaving a view

/* ---------- boot ---------- */
async function loadJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`Không tải được ${url}`);
  return r.json();
}

async function boot() {
  applySettings();
  try {
    course = await loadJSON("content/course.json");
    compare = (await loadJSON("content/compare.json")).items;
    for (const t of course.topics) {
      if (!t.file) continue;
      const data = await loadJSON(t.file);
      topics[t.id] = data;
      for (const [id, it] of Object.entries(data.items || {})) items[id] = { ...it, id, topic: t.id };
    }
  } catch (e) {
    view.innerHTML = `<div class="banner"><b>Không tải được nội dung bài học.</b><br>${esc(e.message)}<br>Kiểm tra kết nối mạng rồi mở lại app.</div>`;
    return;
  }
  window.addEventListener("hashchange", route);
  route();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

function applySettings() {
  const s = store.get().settings;
  document.documentElement.classList.toggle("hide-translit", !s.translit);
  document.documentElement.classList.toggle("no-stress-color", !s.stressColor);
  if (s.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", s.theme);
}

/* ---------- small UI helpers ---------- */
function h(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function modal(contentEl, { onClose } = {}) {
  const root = document.getElementById("modal-root");
  const back = h(`<div class="modal-back" role="dialog" aria-modal="true"><div class="modal"><div class="stripe"></div></div></div>`);
  back.querySelector(".modal").append(contentEl);
  const close = () => { back.remove(); onClose?.(); };
  back.addEventListener("click", e => { if (e.target === back) close(); });
  root.append(back);
  const f = back.querySelector("button, textarea, input"); f?.focus();
  return close;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const ta = document.createElement("textarea"); ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (_) {}
    ta.remove(); return ok;
  }
}

function playBtn(text, { slow = false, label } = {}) {
  const b = h(`<button class="iconbtn${slow ? " slow" : ""}" type="button" aria-label="${slow ? "Nghe chậm" : "Nghe"}${label ? ": " + esc(label) : ""}">${slow ? "0.6×" : "▶"}</button>`);
  b.addEventListener("click", () => { if (!speak(text, { slow })) toast("Máy chưa có giọng đọc tiếng Nga. Xem hướng dẫn trong Cài đặt."); });
  return b;
}

function ruBlock(text, cls = "") {
  return `<span class="ru ${cls}">${ru(text)}</span>`;
}
function translitLine(text) { return `<div class="translit">${esc(translit(text))}</div>`; }

const LABELS = { same: "Giống", partial: "Giống một phần", diff: "Khác", trap: "Bẫy" };
function compareCard(id) {
  const c = compare[id];
  if (!c) return h(`<div class="cmp muted">Thiếu mục so sánh “${esc(id)}”.</div>`);
  const badge = (lang, l) => (l && l !== "na" ? `<span class="badge ${l}">${lang}: ${LABELS[l]}</span>` : "");
  return h(`<div class="cmp">
    <div class="cmp-ru">${ru(c.ru)}</div>
    <div class="badges">${badge("Đức", c.label_de)}${badge("Anh", c.label_en)}</div>
    <div class="md">${md(c.vi)}</div>
    <div class="ex"><b>Đức</b><span>${esc(c.de)}</span><b>Anh</b><span>${esc(c.en)}</span></div>
  </div>`);
}

function errorLabel(tag) {
  if (tag.startsWith("letter:")) return `Chữ ${tag.slice(7)}`;
  return ({ soft: "Phụ âm mềm / dấu mềm", "hard-sign": "Dấu cứng", devoice: "Phụ âm cuối từ", reduce: "Nhược hóa nguyên âm o", gender: "Giống của danh từ", typing: "Chính tả khi gõ" })[tag] || tag;
}

/* ---------- progress helpers ---------- */
function partKey(tid, pid) { return `${tid}.${pid}`; }
function topicDone(tid) { const t = topics[tid]; return !!t && t.parts.every(p => store.partDone(partKey(tid, p.id))); }
function nextPart() {
  for (const t of course.topics) {
    const data = topics[t.id]; if (!data) continue;
    for (const p of data.parts) if (!store.partDone(partKey(t.id, p.id))) return { meta: t, topic: data, part: p };
  }
  return null;
}
function firstOpenStep(tid, part) {
  const i = part.steps.findIndex((_, k) => !store.stepDone(`${tid}.${part.id}.${k}`));
  return i < 0 ? 0 : i;
}

/* ---------- router ---------- */
function setTab(name) {
  document.querySelectorAll(".tabbar a").forEach(a => {
    if (a.dataset.tab === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}

function route() {
  cleanup.forEach(f => { try { f(); } catch (_) {} }); cleanup = [];
  try { speechSynthesis?.cancel(); } catch (_) {}
  document.getElementById("modal-root").innerHTML = "";
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  document.body.classList.remove("lesson-mode");
  view.innerHTML = "";
  if (parts[0] === "l" && parts[1] && parts[2]) return renderLesson(parts[1], parts[2], parts[3] != null ? Number(parts[3]) : null);
  if (parts[0] === "review") { setTab("review"); return renderReview(); }
  if (parts[0] === "path") { setTab("path"); return renderPath(); }
  if (parts[0] === "settings") { setTab("settings"); return renderSettings(); }
  setTab("home"); renderHome();
}

/* ---------- home ---------- */
function lineColor(tid) { return course.topics.find(t => t.id === tid)?.color || "#1B3F8F"; }
function setLine(tid) { document.documentElement.style.setProperty("--lc", lineColor(tid)); }

function streak() {
  const days = new Set(store.get().days);
  const d = new Date();
  const key = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  if (!days.has(key(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(key(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function partsDone(tid) { const t = topics[tid]; return t ? t.parts.filter(p => store.partDone(partKey(tid, p.id))).length : 0; }

function band({ greet, title, pill, short = false }) {
  return h(`<header class="band${short ? " short" : ""}">
    ${greet ? `<div class="greet">${esc(greet)}</div>` : ""}
    <div class="title">${esc(title)}</div>
    ${pill ? `<div class="pill">${esc(pill)}</div>` : ""}
    <div class="stripe"></div>
  </header>`);
}

function stopEl(t, { current, withParts }) {
  const data = topics[t.id];
  const done = data && topicDone(t.id);
  const total = data ? data.parts.length : 3;
  const node = h(`<div class="stop ${done ? "done" : ""} ${current ? "current" : ""} ${data ? "" : "locked"}" style="--lc:${t.color}">
      <span class="dot"></span>
      <div class="t"><b>${t.n}. ${esc(t.title)}</b><span class="ru">${ru(t.hero)}</span><div class="parts"></div></div>
      <span class="pct">${data ? `${partsDone(t.id)}/${total}` : "sắp có"}</span>
    </div>`);
  const parts = node.querySelector(".parts");
  if (withParts && data) {
    for (const p of data.parts) {
      const pd = store.partDone(partKey(t.id, p.id));
      parts.append(h(`<a class="part-chip ${pd ? "done" : ""}" href="#/l/${t.id}/${p.id}"><span class="mark">${pd ? "✓" : p.id}</span>${esc(p.title)}</a>`));
    }
  } else parts.remove();
  return node;
}

function renderHome() {
  const np = nextPart();
  const st = stats();
  const s = store.get();
  const gap = store.daysSinceLastStudy();
  const sk = streak();
  const el = h(`<div></div>`);
  el.append(band({ greet: `Chào anh ${s.settings.name || ""}`.trim(), title: "Hôm nay học gì?", pill: sk ? `${sk} ngày liên tiếp` : "" }));
  const stack = h(`<div class="stack"></div>`);
  el.append(stack);

  if (np) {
    setLine(np.meta.id);
    const heroText = np.meta.hero;
    const long = [...heroText.replace(/́/g, "")].length > 10;
    const hero = h(`<section class="card raised hero">
      <div class="kick"><span class="lb">${np.meta.n}</span>Chủ đề ${np.meta.n} · ${esc(np.meta.title)}</div>
      <div class="word ru${long ? " long" : ""}">${ru(heroText)}</div>
      <div class="gloss">${esc(np.meta.gloss)}</div>
      <a class="cta" href="#/l/${np.meta.id}/${np.part.id}"><span>Học tiếp phần ${np.part.id}<small>${esc(np.part.title)} · ${np.part.minutes || 20} phút</small></span><span class="go" aria-hidden="true">▶</span></a>
    </section>`);
    stack.append(hero);
    if (gap != null && gap >= 7 && st.due > 0) {
      hero.before(h(`<div class="banner">Anh nghỉ ${gap} ngày rồi. Nên ôn nhanh ${Math.min(st.due, 10)} thẻ (khoảng 5 phút) trước khi học tiếp.</div>`));
    }
  } else {
    stack.append(h(`<section class="card raised hero"><div class="word ru">${ru("Молоде́ц!")}</div><div class="gloss">Anh đã xong các chủ đề hiện có. Nội dung mới sẽ được bổ sung.</div></section>`));
  }

  stack.append(st.due
    ? h(`<a class="review-card" href="#/review"><span><b>${st.due} thẻ cần ôn</b><span class="sub">khoảng ${Math.max(2, Math.ceil(st.due / 3))} phút</span></span><span class="act">Ôn ngay</span></a>`)
    : h(`<a class="review-card empty" href="#/review"><span><b>Chưa có thẻ cần ôn</b><span class="sub muted" style="color:var(--muted)">Học xong một phần để có thẻ ôn tập</span></span><span class="act">›</span></a>`));

  // metro map: current topic, one before, two after
  stack.append(h(`<div class="sec-title">Tuyến học của anh</div>`));
  const map = h(`<div class="map"></div>`);
  const ci = np ? course.topics.findIndex(t => t.id === np.meta.id) : course.topics.length - 1;
  const from = Math.max(0, ci - 1), to = Math.min(course.topics.length, from + 4);
  course.topics.slice(from, to).forEach(t => {
    const a = h(`<a href="#/path" style="text-decoration:none;color:inherit;display:block"></a>`);
    a.append(stopEl(t, { current: np && np.meta.id === t.id }));
    map.append(a);
  });
  stack.append(map);

  stack.append(h(`<div class="stats">
    <div class="stat"><b>${s.days.length}</b><span>ngày đã học</span></div>
    <div class="stat"><b>${st.learned}</b><span>câu/từ đã thuộc</span></div>
    <div class="stat"><b>${st.total}</b><span>câu/từ đã gặp</span></div>
  </div>`));

  const errs = Object.entries(s.errors).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (errs.length) {
    stack.append(h(`<div class="sec-title">Lỗi hay gặp</div>`));
    stack.append(h(`<div class="card">${errs.map(([t, n]) => `<div class="err-row"><span>${esc(errorLabel(t))}</span><span class="spacer"></span><span class="tag">${n} lần</span></div>`).join("")}<p class="small muted" style="margin-bottom:0">Phần ôn tập ưu tiên những chỗ này.</p></div>`));
  }
  if (!ttsAvailable() || !russianVoices().length) {
    stack.append(h(`<div class="banner info small">Nếu nút ▶ không đọc được tiếng Nga: Cài đặt iPhone → Trợ năng → Nội dung được đọc → Giọng nói → Tiếng Nga, tải một giọng (ví dụ Milena).</div>`));
  }
  view.append(el);
}

/* ---------- path ---------- */
function renderPath() {
  const np = nextPart();
  const doneCount = course.topics.filter(t => topics[t.id] && topicDone(t.id)).length;
  const el = h(`<div></div>`);
  el.append(band({ title: "Lộ trình", greet: "Học theo tiến độ", pill: `${doneCount}/12 chủ đề`, short: true }));
  const stack = h(`<div class="stack"></div>`);
  stack.append(h(`<p class="small muted">Có thể nhảy chủ đề — app chỉ nhắc nếu kiến thức nền còn thiếu.</p>`));
  const map = h(`<div class="map"></div>`);
  course.topics.forEach(t => map.append(stopEl(t, { current: np && np.meta.id === t.id, withParts: true })));
  stack.append(map);
  el.append(stack);
  view.append(el);
}

/* ---------- lesson ---------- */
function renderLesson(tid, pid, stepIdx) {
  const topic = topics[tid];
  const meta = course.topics.find(t => t.id === tid);
  const part = topic?.parts.find(p => p.id === pid);
  if (!part) { view.append(h(`<div class="banner">Không tìm thấy bài này. <a href="#/path">Về lộ trình</a></div>`)); return; }
  document.body.classList.add("lesson-mode");
  if (stepIdx == null || isNaN(stepIdx)) stepIdx = firstOpenStep(tid, part);
  stepIdx = Math.max(0, Math.min(stepIdx, part.steps.length - 1));
  const step = part.steps[stepIdx];
  const key = `${tid}.${pid}.${stepIdx}`;
  store.touch();

  // Missing-foundation hint when jumping ahead
  const idx = course.topics.findIndex(t => t.id === tid);
  const missing = course.topics.slice(0, idx).filter(t => topics[t.id] && !topicDone(t.id)).map(t => t.n);

  const top = h(`<div class="lesson-top"><div class="row">
      <a class="btn ghost small" href="#/path" aria-label="Thoát bài học">✕</a>
      <div class="progress" aria-label="Tiến độ phần học"><i style="width:${Math.round(((stepIdx) / part.steps.length) * 100)}%"></i></div>
      <button class="btn ghost small" type="button" data-report aria-label="Báo lỗi nội dung">⚑</button>
    </div></div>`);
  top.querySelector("[data-report]").addEventListener("click", () => reportModal(`Chủ đề ${meta.n} · Phần ${pid} · Bước ${stepIdx + 1}: ${step.title || step.type}`));
  view.append(top);
  if (missing.length && stepIdx === 0) view.append(h(`<div class="banner info small">Gợi ý: chủ đề ${missing.join(", ")} chưa xong. Học tiếp vẫn được — chỉ là có thể gặp kiến thức chưa học.</div>`));
  setLine(tid);
  view.append(h(`<div class="step-head"><span class="lb">${meta.n}</span><span class="step-kicker">Phần ${pid} · ${esc(part.title)} · bước ${stepIdx + 1}/${part.steps.length}</span></div>`));
  view.append(h(`<h2 class="step-title">${esc(step.title || "")}</h2>`));

  const body = h(`<div class="step-body"></div>`);
  view.append(body);
  const r = STEP[step.type];
  if (r) r(step, body, { tid, pid, key, topic });
  else body.append(h(`<div class="banner">Dạng bài “${esc(step.type)}” chưa được hỗ trợ.</div>`));

  const isLast = stepIdx === part.steps.length - 1;
  const bar = h(`<div class="step-actions"><div class="inner">
      ${stepIdx > 0 ? `<a class="btn" href="#/l/${tid}/${pid}/${stepIdx - 1}">Quay lại</a>` : ""}
      <button class="btn primary" type="button" data-next>${isLast ? "Xong phần " + pid : "Tiếp tục"}</button>
    </div></div>`);
  bar.querySelector("[data-next]").addEventListener("click", () => {
    store.markStep(key);
    store.logEvent("step_completed", key);
    if (isLast) {
      store.markPart(partKey(tid, pid));
      finishPart(meta, part);
    } else {
      location.hash = `#/l/${tid}/${pid}/${stepIdx + 1}`;
    }
  });
  view.append(bar);
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function finishPart(meta, part) {
  const np = nextPart();
  const el = h(`<div><h2>Xong phần ${part.id}: ${esc(part.title)}</h2>
    <p>Các câu và từ trong phần này đã vào thẻ ôn tập.</p>
    <div class="hero-actions"></div></div>`);
  const acts = el.querySelector(".hero-actions");
  if (np) acts.append(h(`<a class="btn primary block" href="#/l/${np.meta.id}/${np.part.id}">Học tiếp: chủ đề ${np.meta.n}, phần ${np.part.id}</a>`));
  acts.append(h(`<a class="btn block" href="#/review">Ôn tập</a>`));
  acts.append(h(`<a class="btn ghost block" href="#/">Về trang chính</a>`));
  const close = modal(el);
  el.querySelectorAll("a").forEach(a => a.addEventListener("click", () => close()));
}

function reportModal(where) {
  const el = h(`<div><h3>Báo lỗi nội dung</h3>
    <p class="small muted">${esc(where)}</p>
    <textarea class="field" rows="5" placeholder="Ví dụ: câu này sai trọng âm; thầy dạy câu … mà app chưa có" style="font-family:var(--sans);font-size:1rem"></textarea>
    <div class="row end" style="margin-top:10px"><button class="btn" type="button" data-cancel>Hủy</button><button class="btn primary" type="button" data-save>Lưu báo lỗi</button></div></div>`);
  const close = modal(el);
  el.querySelector("[data-cancel]").addEventListener("click", close);
  el.querySelector("[data-save]").addEventListener("click", () => {
    const t = el.querySelector("textarea").value.trim();
    if (!t) { toast("Anh ghi nội dung lỗi trước đã."); return; }
    store.addReport(where, t); close(); toast("Đã lưu. Gửi danh sách lỗi cho Claude từ Cài đặt.");
  });
}

/* ---------- step renderers ---------- */
const STEP = {};

STEP.note = (s, body) => { body.append(h(`<div class="panel md">${md(s.md)}</div>`)); };

STEP.video = (s, body) => {
  const params = new URLSearchParams({ rel: "0", playsinline: "1", modestbranding: "1" });
  if (s.start) params.set("start", String(s.start));
  if (s.end) params.set("end", String(s.end));
  const fmt = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  const range = s.end ? `${fmt(s.start || 0)}–${fmt(s.end)}` : (s.start ? `từ ${fmt(s.start)}` : "cả video");
  const wrap = h(`<div></div>`);
  if (navigator.onLine === false) {
    wrap.append(h(`<div class="video video-off">Cần kết nối mạng để xem video. Các bước khác vẫn học được khi không có mạng.</div>`));
  } else {
    wrap.append(h(`<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(s.videoId)}?${params}" title="${esc(s.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`));
  }
  wrap.append(h(`<p class="small muted">Đoạn: ${range} · <a href="https://www.youtube.com/watch?v=${encodeURIComponent(s.videoId)}${s.start ? `&t=${s.start}s` : ""}" target="_blank" rel="noopener">Mở trên YouTube</a></p>`));
  if (s.note) wrap.append(h(`<div class="panel md">${md(s.note)}</div>`));
  body.append(wrap);
};

STEP.compare = (s, body) => { s.ids.forEach(id => body.append(compareCard(id))); };

STEP.phrases = (s, body) => {
  if (s.intro) body.append(h(`<p class="muted">${esc(s.intro)}</p>`));
  const list = h(`<div class="panel"></div>`);
  for (const id of s.items) {
    const it = items[id]; if (!it) continue;
    ensureCard(id);
    const row = h(`<div class="phrase"><div class="txt">
        <div>${ruBlock(it.ru)}</div>${translitLine(it.ru)}
        ${it.ipa ? `<div class="small muted">[${esc(it.ipa)}]</div>` : ""}
        <div class="vi">${esc(it.vi)}</div>
        ${it.de || it.en ? `<div class="de">${it.de ? "DE: " + esc(it.de) : ""}${it.de && it.en ? " · " : ""}${it.en ? "EN: " + esc(it.en) : ""}</div>` : ""}
        ${it.note ? `<div class="note">${esc(it.note)}</div>` : ""}
      </div><div class="btns" style="display:flex;flex-direction:column;gap:6px"></div></div>`);
    row.querySelector(".btns").append(playBtn(it.ru, { label: it.ru }), playBtn(it.ru, { slow: true, label: it.ru }));
    list.append(row);
  }
  body.append(list);
};

STEP.letters = (s, body) => {
  if (s.intro) body.append(h(`<p class="muted">${esc(s.intro)}</p>`));
  const grid = h(`<div class="letters"></div>`);
  let openDetail = null;
  s.letters.forEach(L => {
    L.words.forEach(w => ensureCard(w));
    const btn = h(`<button class="letter" type="button" aria-expanded="false"><div class="big">${esc(L.ch)}</div><div class="snd">${esc(L.snd)}</div></button>`);
    btn.addEventListener("click", () => {
      const was = btn.getAttribute("aria-expanded") === "true";
      grid.querySelectorAll(".letter").forEach(b => b.setAttribute("aria-expanded", "false"));
      openDetail?.remove(); openDetail = null;
      if (was) return;
      btn.setAttribute("aria-expanded", "true");
      const d = h(`<div class="letter-detail"><div class="md">${md(L.hint)}</div><div class="words"></div></div>`);
      const wbox = d.querySelector(".words");
      L.words.forEach(w => {
        const it = items[w]; if (!it) return;
        const chip = h(`<span class="word-chip">${ruBlock(it.ru)}<span class="small muted">${esc(it.vi)}</span></span>`);
        chip.append(playBtn(it.ru, { label: it.ru }));
        wbox.append(chip);
      });
      if (L.cmp) {
        const more = h(`<button class="btn ghost small" type="button">So sánh với tiếng Đức/Anh</button>`);
        more.addEventListener("click", () => { const c = h(`<div></div>`); c.append(compareCard(L.cmp)); const cl = h(`<button class="btn block" type="button">Đóng</button>`); c.append(cl); const close = modal(c); cl.addEventListener("click", close); });
        d.append(more);
      }
      // insert after the last letter of the current row
      const all = [...grid.querySelectorAll(".letter")];
      const myTop = btn.offsetTop;
      const rowEnd = all.filter(b => b.offsetTop === myTop).pop();
      rowEnd.after(d);
      openDetail = d;
      const first = L.words.map(w => items[w]).find(Boolean);
      if (first) speak(first.ru);
    });
    grid.append(btn);
  });
  body.append(grid);
  body.append(h(`<p class="small muted">Bấm vào chữ để xem từ ví dụ và nghe.</p>`));
};

function quizRunner(s, body, { renderQ, onAnswer }) {
  const qs = s.questions;
  let i = 0, right = 0;
  const box = h(`<div></div>`);
  body.append(box);
  const show = () => {
    box.innerHTML = "";
    if (i >= qs.length) {
      box.append(h(`<div class="card result"><div class="score">${right}/${qs.length}</div><p><b>${right === qs.length ? "Đúng hết — rất tốt." : "câu đúng"}</b></p><p class="muted small">${right === qs.length ? "Bấm Tiếp tục để sang bước sau." : "Câu sai đã được đưa vào phần ôn tập."}</p></div>`));
      const again = h(`<button class="btn block" type="button">Làm lại</button>`);
      again.addEventListener("click", () => { i = 0; right = 0; show(); });
      box.append(again);
      store.logEvent("quiz_completed", s.title, { right, total: qs.length });
      return;
    }
    const q = qs[i];
    box.append(h(`<div class="q-count" aria-label="Câu ${i + 1}/${qs.length}">${qs.map((_, k) => `<i class="${k < i ? "done" : k === i ? "now" : ""}"></i>`).join("")}</div>`));
    renderQ(q, box, ok => {
      if (ok) right++;
      onAnswer?.(q, ok);
      const nx = h(`<button class="btn primary block" type="button" style="margin-top:12px">${i + 1 < qs.length ? "Câu tiếp" : "Xem kết quả"}</button>`);
      nx.addEventListener("click", () => { i++; show(); });
      box.append(nx);
      nx.focus();
    });
  };
  show();
}

function optionLabel(o) { return /[а-яё]/i.test(o) ? ruBlock(o) : esc(o); }

function choiceUI(q, box, done, { options, answer, explain, correctText }) {
  const opts = h(`<div class="options"></div>`);
  const order = shuffle(options.map((o, k) => k));
  order.forEach(k => {
    const b = h(`<button class="opt" type="button">${optionLabel(options[k])}</button>`);
    b.addEventListener("click", () => {
      opts.querySelectorAll(".opt").forEach(x => (x.disabled = true));
      const ok = k === answer;
      b.classList.add(ok ? "correct" : "wrong");
      if (!ok) [...opts.children][order.indexOf(answer)].classList.add("correct");
      box.append(h(`<div class="feedback ${ok ? "ok" : "bad"}">${ok ? "Đúng." : `Chưa đúng. Đáp án: ${correctText || optionLabel(options[answer])}`}${explain ? `<div class="md" style="margin-top:6px;color:var(--ink)">${md(explain)}</div>` : ""}</div>`));
      done(ok);
    });
    opts.append(b);
  });
  box.append(opts);
}

STEP.quiz = (s, body) => {
  quizRunner(s, body, {
    renderQ: (q, box, done) => {
      if (q.kind === "listen") {
        const p = h(`<div class="q-prompt"><p>Nghe và chọn từ đúng:</p></div>`);
        const big = playBtn(q.say); big.style.width = "64px"; big.style.height = "64px"; big.style.fontSize = "24px";
        const row = h(`<div class="row"></div>`); row.append(big, playBtn(q.say, { slow: true }));
        p.append(row); box.append(p);
        setTimeout(() => speak(q.say), 250);
      } else if (q.kind === "read") {
        box.append(h(`<div class="q-prompt">${ruBlock(q.show)}${translitLine(q.show)}</div>`));
      } else {
        box.append(h(`<div class="q-prompt md">${md(q.prompt)}</div>`));
      }
      choiceUI(q, box, done, { options: q.options, answer: q.answer, explain: q.explain });
    },
    onAnswer: (q, ok) => {
      if (q.item) exerciseResult(q.item, ok);
      if (!ok) store.addError(q.tag || "");
      store.logEvent("answered", q.item || q.prompt || q.show || q.say, { ok });
    }
  });
};

STEP.situation = (s, body) => {
  quizRunner(s, body, {
    renderQ: (q, box, done) => {
      box.append(h(`<div class="q-prompt"><p>${esc(q.prompt)}</p></div>`));
      choiceUI(q, box, done, { options: q.options, answer: q.answer, explain: q.explain });
    },
    onAnswer: (q, ok) => store.logEvent("answered", q.prompt, { ok })
  });
};

STEP.type = (s, body) => {
  if (s.intro) body.append(h(`<div class="banner info small">${esc(s.intro)}</div>`));
  quizRunner(s, body, {
    renderQ: (q, box, done) => {
      const p = h(`<div class="q-prompt"><p>Nghe rồi gõ lại bằng chữ Kirin. Gợi ý nghĩa: <b>${esc(q.vi)}</b></p></div>`);
      const row = h(`<div class="row"></div>`); row.append(playBtn(q.say), playBtn(q.say, { slow: true }));
      p.append(row); box.append(p);
      const inp = h(`<input class="field" lang="ru" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Gõ ở đây…" aria-label="Câu trả lời">`);
      const check = h(`<button class="btn primary block" type="button" style="margin-top:10px">Kiểm tra</button>`);
      box.append(inp, check);
      setTimeout(() => speak(q.say), 250);
      const go = () => {
        if (!inp.value.trim()) { toast("Anh gõ câu trả lời trước đã."); return; }
        if (/[a-z]/i.test(inp.value) && !/[а-яё]/i.test(inp.value)) { toast("Đang là bàn phím Latinh — đổi sang bàn phím tiếng Nga (quả địa cầu)."); return; }
        const d = wordDiff(q.answer, inp.value);
        const ok = d.exact;
        inp.disabled = true; check.remove();
        box.append(h(`<div class="feedback ${ok ? "ok" : "bad"}">${ok ? "Đúng." : "Chưa đúng."}<div style="margin-top:6px;color:var(--ink)">Đáp án: ${ruBlock(q.answer)}</div>${ok ? "" : `<div class="diff small" style="margin-top:4px;color:var(--ink)">So sánh: ${diffHtml(d.ops)}</div>`}</div>`));
        done(ok);
      };
      check.addEventListener("click", go);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
      inp.focus();
    },
    onAnswer: (q, ok) => { if (q.item) exerciseResult(q.item, ok); if (!ok) store.addError("typing"); store.logEvent("typed", q.item, { ok }); }
  });
};

function recorderUI(onDone) {
  const wrap = h(`<div class="rec-bar"></div>`);
  if (!Recorder.supported()) { wrap.append(h(`<span class="small muted">Thiết bị này chưa hỗ trợ ghi âm trong app.</span>`)); return wrap; }
  const recBtn = h(`<button class="iconbtn rec" type="button" aria-label="Ghi âm">●</button>`);
  const time = h(`<span class="rec-time">0:00</span>`);
  const playMe = h(`<button class="btn small" type="button" disabled>Nghe lại mình</button>`);
  let rec = null;
  recBtn.addEventListener("click", async () => {
    if (rec && rec.recording) { rec.stop(); return; }
    rec = new Recorder({
      max: 60,
      onTick: sec => { time.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; },
      onStop: r => { recBtn.classList.remove("on"); recBtn.textContent = "●"; recBtn.setAttribute("aria-label", "Ghi âm lại"); playMe.disabled = false; onDone?.(r); }
    });
    try {
      await rec.start();
      recBtn.classList.add("on"); recBtn.textContent = "■"; recBtn.setAttribute("aria-label", "Dừng ghi âm"); time.textContent = "0:00";
    } catch (e) { toast("Chưa có quyền dùng micro. Cho phép micro cho app trong Cài đặt iPhone."); }
  });
  playMe.addEventListener("click", () => rec?.play());
  cleanup.push(() => rec?.stop());
  wrap.append(recBtn, time, playMe, h(`<span class="small muted">Tự bấm dừng · tối đa 60 giây</span>`));
  return wrap;
}

STEP.shadow = (s, body) => {
  let i = 0, level = 1;
  const box = h(`<div></div>`);
  body.append(h(`<p class="muted">Mỗi câu 3 bước: đọc theo cả câu → đọc khi bị ẩn bớt từ khóa → gần như tự nói. Nghe mẫu, ghi âm, nghe lại mình để so.</p>`));
  body.append(box);
  const LEVELS = ["Đọc theo", "Có gợi ý", "Tự nói"];
  const show = () => {
    box.innerHTML = "";
    if (i >= s.items.length) {
      box.append(h(`<div class="card result"><div class="score">${s.items.length}</div><p><b>câu đã luyện</b></p><p class="muted small">Chấm phát âm bằng AI sẽ có ở bản sau. Hiện tại: tự so bản ghi âm của mình với giọng mẫu.</p></div>`));
      const again = h(`<button class="btn block" type="button">Luyện lại</button>`); again.addEventListener("click", () => { i = 0; level = 1; show(); }); box.append(again);
      return;
    }
    const it = items[s.items[i]];
    box.append(h(`<div class="q-count" aria-label="Câu ${i + 1}/${s.items.length}">${s.items.map((_, k) => `<i class="${k < i ? "done" : k === i ? "now" : ""}"></i>`).join("")}</div>`));
    const card = h(`<div class="shadow-card"></div>`);
    box.append(card);
    card.append(h(`<div class="steps3">${LEVELS.map((l, k) => `<span class="${k + 1 === level ? "on" : k + 1 < level ? "past" : ""}">${k + 1} · ${l}</span>`).join("")}</div>`));
    card.append(h(`<div class="shadow-line">${hintLine(it.ru, level)}</div>`));
    if (level === 1) card.append(h(translitLine(it.ru)));
    card.append(h(`<div class="small muted" style="margin-top:4px">${esc(it.vi)}</div>`));
    const r = h(`<div class="row" style="margin-top:14px"></div>`); r.append(playBtn(it.ru), playBtn(it.ru, { slow: true })); card.append(r);
    card.append(recorderUI());
    const nav = h(`<div class="row" style="margin-top:12px"></div>`);
    if (level < 3) {
      const nx = h(`<button class="btn primary" type="button">Bước ${level + 1}</button>`);
      nx.addEventListener("click", () => { level++; show(); });
      nav.append(nx);
    } else {
      const reveal = h(`<button class="btn" type="button">Hiện cả câu</button>`);
      reveal.addEventListener("click", () => { box.querySelector(".shadow-line").innerHTML = ru(it.ru); reveal.remove(); });
      const good = h(`<button class="btn primary" type="button">Nói được</button>`);
      const bad = h(`<button class="btn" type="button">Chưa được</button>`);
      good.addEventListener("click", () => { exerciseResult(it.id, true); store.logEvent("shadowed", it.id, { ok: true }); i++; level = 1; show(); });
      bad.addEventListener("click", () => { exerciseResult(it.id, false); store.logEvent("shadowed", it.id, { ok: false }); i++; level = 1; show(); });
      nav.append(reveal, bad, good);
    }
    box.append(nav);
  };
  show();
};

STEP.readcheck = (s, body) => {
  body.append(h(`<p class="muted">${esc(s.intro)}</p>`));
  const marks = {};
  const list = h(`<div class="panel"></div>`);
  const score = h(`<div class="panel"><b class="sc">0</b>/${s.items.length} đúng · <span class="left">${s.items.length}</span> từ chưa chấm</div>`);
  const upd = () => {
    const vals = Object.values(marks);
    score.querySelector(".sc").textContent = vals.filter(Boolean).length;
    score.querySelector(".left").textContent = s.items.length - vals.length;
    if (vals.length === s.items.length) {
      const n = vals.filter(Boolean).length;
      store.logEvent("readcheck", s.title, { right: n, total: s.items.length });
      score.append(h(`<p class="${n >= Math.round(s.items.length * 0.9) ? "" : "muted"}">${n >= Math.round(s.items.length * 0.9) ? "Đạt mốc — sẵn sàng sang chủ đề tiếp theo." : "Chưa đạt 90% — nên xem lại các từ bị sai, nhưng vẫn có thể học tiếp."}</p>`));
    }
  };
  s.items.forEach(id => {
    const it = items[id]; if (!it) return;
    const row = h(`<div class="phrase"><div class="txt"><div>${ruBlock(it.ru)}</div><div class="hidden-info" hidden>${translitLine(it.ru)}<div class="small">${esc(it.vi)}</div></div></div><div class="btns row" style="flex-wrap:nowrap"></div></div>`);
    const listen = h(`<button class="btn small" type="button">Nghe mẫu</button>`);
    listen.addEventListener("click", () => { speak(it.ru); row.querySelector(".hidden-info").hidden = false; });
    const ok = h(`<button class="iconbtn" type="button" aria-label="Đọc đúng">✓</button>`);
    const no = h(`<button class="iconbtn" type="button" aria-label="Đọc sai" style="color:var(--bad)">✗</button>`);
    const set = v => { marks[id] = v; ok.style.background = v ? "var(--ok-soft)" : ""; no.style.background = v ? "" : "var(--bad-soft)"; exerciseResult(id, v); upd(); };
    ok.addEventListener("click", () => set(true));
    no.addEventListener("click", () => set(false));
    row.querySelector(".btns").append(listen, no, ok);
    list.append(row);
  });
  body.append(list, score);
};

STEP.pattern = (s, body) => {
  body.append(h(`<div class="banner info">${esc(s.intro)}</div>`));
  s.prompts.forEach((p, k) => {
    const card = h(`<div class="panel"><div class="small muted">Câu hỏi ${k + 1}</div><div class="row" style="flex-wrap:nowrap"><div style="flex:1">${ruBlock(p.q, "")}<div class="small">Mẫu: ${ruBlock(p.pattern)}</div></div></div></div>`);
    card.querySelector(".row").append(playBtn(p.q));
    card.append(recorderUI());
    const ex = h(`<button class="btn ghost small" type="button">Xem ví dụ</button>`);
    ex.addEventListener("click", () => { ex.replaceWith(h(`<div class="row">${ruBlock(p.example)}</div>`)); });
    card.append(ex);
    body.append(card);
  });
  body.append(h(`<div class="panel"><h3>Tự kiểm tra</h3><ul class="checklist">${s.checklist.map((c, k) => `<li><input type="checkbox" id="pc${k}"><label for="pc${k}">${esc(c)}</label></li>`).join("")}</ul><p class="small muted">Chấm nói bằng AI (chấm đúng mẫu câu, không chấm khớp từng chữ) sẽ có ở bản sau.</p></div>`));
};

function claudePrompt(s, text) {
  return `Bạn là giáo viên tiếng Nga, chấm bài viết trình độ ${s.level || "A1"} của một người Việt đã biết tiếng Đức và tiếng Anh.

Đề bài: ${s.prompt}

Bài làm:
«${text}»

Yêu cầu:
1. Liệt kê từng lỗi theo dạng: câu gốc → câu sửa · loại lỗi (cách, giống, chia động từ, trật tự từ, từ vựng, chính tả) · giải thích ngắn bằng tiếng Việt. Chỉ so sánh với tiếng Đức hoặc tiếng Anh khi phép so sánh thật sự đúng, và nói rõ giới hạn của nó.
2. Chấm 3 tiêu chí, mỗi tiêu chí 0–5 điểm: hoàn thành nhiệm vụ, ngữ pháp, từ vựng.
3. Viết lại toàn bài cho đúng và tự nhiên, có đánh dấu trọng âm.
4. Điều gì không chắc chắn thì ghi "cần kiểm tra lại", không đoán. Không khen chung chung.`;
}

STEP.write = (s, body, ctx) => {
  const st = store.get();
  st.drafts = st.drafts || {};
  body.append(h(`<p>${esc(s.prompt)}</p>`));
  const ta = h(`<textarea class="field" lang="ru" autocapitalize="sentences" spellcheck="false" placeholder="Viết bằng chữ Kirin…" aria-label="Bài viết"></textarea>`);
  ta.value = st.drafts[ctx.key] || "";
  const count = h(`<div class="small muted"></div>`);
  const upd = () => { const n = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0; count.textContent = `${n} từ (gợi ý tối thiểu ${s.minWords})`; };
  ta.addEventListener("input", () => { st.drafts[ctx.key] = ta.value; store.save(); upd(); });
  upd();
  body.append(ta, count);
  const acts = h(`<div class="row" style="margin-top:10px"></div>`);
  const cmpBtn = h(`<button class="btn" type="button">So với bài mẫu</button>`);
  const claude = h(`<button class="btn primary" type="button">Sao chép để hỏi Claude</button>`);
  const ai = h(`<button class="btn" type="button" disabled title="Sẽ có ở bước tiếp theo">Chấm bằng AI (sắp có)</button>`);
  acts.append(cmpBtn, claude, ai);
  body.append(acts);
  const out = h(`<div></div>`); body.append(out);
  cmpBtn.addEventListener("click", () => {
    out.innerHTML = "";
    out.append(h(`<div class="panel"><h3>Tự kiểm tra</h3><ul class="checklist">${s.checklist.map((c, k) => `<li><input type="checkbox" id="wc${k}"><label for="wc${k}">${esc(c)}</label></li>`).join("")}</ul></div>`));
    out.append(h(`<div class="panel"><h3>Bài mẫu</h3><p class="ru" style="font-size:1.15rem;line-height:1.6">${ru(s.model)}</p></div>`));
    store.logEvent("writing_submitted", ctx.key, { words: ta.value.trim().split(/\s+/).length });
  });
  claude.addEventListener("click", async () => {
    if (ta.value.trim().length < 5) { toast("Anh viết bài trước đã."); return; }
    const ok = await copyText(claudePrompt(s, ta.value.trim()));
    toast(ok ? "Đã sao chép. Mở app Claude và dán vào." : "Không sao chép được — thử lại.");
  });
};

/* ---------- review ---------- */
function renderReview() {
  let queue = dueCards(20).filter(id => items[id]);
  const el = h(`<div></div>`);
  el.append(band({ title: "Ôn tập", greet: "Ưu tiên chỗ hay sai", pill: queue.length ? `${queue.length} thẻ` : "", short: true }));
  const box = h(`<div class="stack rv"></div>`);
  el.append(box);
  view.append(el);
  let done = 0;
  const show = () => {
    box.innerHTML = "";
    if (!queue.length) {
      const st = stats();
      document.documentElement.style.setProperty("--lc", "#2E9E4F");
      box.append(h(`<div class="card result"><div class="score">${done || "0"}</div><p><b>${done ? "thẻ đã ôn hôm nay" : "Không có thẻ nào cần ôn lúc này"}</b></p><p class="muted small">${st.total ? `Đã gặp ${st.total} câu/từ, thuộc ${st.learned}.` : "Học xong một phần bài để có thẻ ôn tập."}</p></div>`));
      box.append(h(`<a class="btn primary block" href="#/">Về trang chính</a>`));
      return;
    }
    const id = queue[0];
    const it = items[id];
    setLine(it.topic);
    const c = store.get().srs[id];
    const reverse = c && c.box >= 2 && Math.random() < 0.5;
    box.append(h(`<div class="small muted">Còn ${queue.length} thẻ · chủ đề ${course.topics.find(t => t.id === it.topic)?.n || ""}</div>`));
    const card = h(`<div class="card raised flash"></div>`);
    if (reverse) {
      card.append(h(`<div><div class="small muted">Nói hoặc nghĩ câu tiếng Nga:</div><h2 style="margin:10px 0">${esc(it.vi)}</h2></div>`));
    } else {
      card.append(h(`<div>${ruBlock(it.ru)}${translitLine(it.ru)}</div>`));
      const pr = h(`<div class="row" style="justify-content:center;margin-top:10px"></div>`); pr.append(playBtn(it.ru)); card.append(pr);
      setTimeout(() => speak(it.ru), 200);
    }
    const ans = h(`<div class="answer" hidden style="margin-top:14px"></div>`);
    if (reverse) {
      ans.append(h(`<div>${ruBlock(it.ru)}${translitLine(it.ru)}</div>`));
      const pr = h(`<div class="row" style="justify-content:center;margin-top:8px"></div>`); pr.append(playBtn(it.ru)); ans.append(pr);
    } else {
      ans.append(h(`<div><b>${esc(it.vi)}</b></div>`));
      if (it.de || it.en) ans.append(h(`<div class="small muted">${it.de ? "DE: " + esc(it.de) : ""}${it.de && it.en ? " · " : ""}${it.en ? "EN: " + esc(it.en) : ""}</div>`));
    }
    if (it.note) ans.append(h(`<div class="small muted" style="margin-top:6px">${esc(it.note)}</div>`));
    card.append(ans);
    box.append(card);
    const showBtn = h(`<button class="btn primary block" type="button">Hiện đáp án</button>`);
    const grades = h(`<div class="grade" hidden><button class="btn g0" type="button" data-g="0">Quên</button><button class="btn" type="button" data-g="1">Khó</button><button class="btn primary" type="button" data-g="2">Nhớ</button></div>`);
    showBtn.addEventListener("click", () => { ans.hidden = false; showBtn.hidden = true; grades.hidden = false; if (reverse) speak(it.ru); });
    grades.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      const g = Number(b.dataset.g);
      grade(id, g); store.logEvent("reviewed", id, { grade: g });
      queue.shift(); if (g === 0) queue.push(id); done++;
      show();
    }));
    box.append(showBtn, grades);
  };
  show();
}

/* ---------- settings ---------- */
function renderSettings() {
  const s = store.get().settings;
  const el = h(`<div>
    <header class="band short"><div class="greet">Áp dụng cho máy này</div><div class="title">Cài đặt</div><div class="stripe"></div></header>
    <div class="stack">
    <div class="sec-title">Hiển thị và giọng đọc</div>
    <div class="panel">
      <label class="setting"><span class="lbl">Tên hiển thị</span><input class="field sans" data-k="name" value="${esc(s.name || "")}" style="width:50%" autocomplete="off"></label>
      <label class="setting"><span class="lbl">Hiện chuyển tự Latinh<div class="small muted">Nên tắt sau khoảng tuần thứ 3.</div></span><input class="switch" type="checkbox" data-k="translit" ${s.translit ? "checked" : ""}></label>
      <label class="setting"><span class="lbl">Tô đỏ nguyên âm mang trọng âm</span><input class="switch" type="checkbox" data-k="stressColor" ${s.stressColor ? "checked" : ""}></label>
      <label class="setting"><span class="lbl">Tốc độ đọc</span><select class="field" data-k="rate" style="width:auto">
        ${[0.7, 0.8, 0.9, 1].map(v => `<option value="${v}" ${Number(s.rate) === v ? "selected" : ""}>${v === 1 ? "Bình thường" : v + "×"}</option>`).join("")}
      </select></label>
      <label class="setting"><span class="lbl">Giọng đọc</span><select class="field" data-k="voiceURI" style="width:auto;max-width:55%"></select></label>
      <label class="setting"><span class="lbl">Giao diện</span><select class="field" data-k="theme" style="width:auto">
        <option value="auto" ${s.theme === "auto" ? "selected" : ""}>Theo máy</option><option value="light" ${s.theme === "light" ? "selected" : ""}>Sáng</option><option value="dark" ${s.theme === "dark" ? "selected" : ""}>Tối</option>
      </select></label>
    </div>
    <div class="sec-title">Báo lỗi nội dung</div>
    <div class="panel reports"></div>
    <div class="sec-title">Sao lưu</div>
    <div class="panel">
      <p class="small muted">Tiến độ chỉ lưu trên máy này. Thỉnh thoảng sao lưu ra file (lưu vào Tệp/iCloud).</p>
      <div class="row"><button class="btn" type="button" data-export>Tải file sao lưu</button><label class="btn" style="cursor:pointer">Khôi phục từ file<input type="file" accept="application/json,.json" data-import hidden></label></div>
    </div>
    <div class="panel">
      <button class="btn danger" type="button" data-reset>Xóa toàn bộ tiến độ</button>
    </div>
    <p class="small muted">Phiên bản ${APP_VERSION}. Video thuộc về các kênh: Russki with Andrei, Easy Russian with Tony, Wossow — app chỉ nhúng, không lưu video.</p>
  </div></div>`);
  // voices
  const vs = el.querySelector('[data-k="voiceURI"]');
  const fillVoices = () => {
    const list = russianVoices();
    vs.innerHTML = list.length ? list.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === s.voiceURI ? "selected" : ""}>${esc(v.name)}</option>`).join("") : `<option value="">Chưa có giọng tiếng Nga</option>`;
  };
  fillVoices(); setTimeout(fillVoices, 600);
  el.querySelectorAll("[data-k]").forEach(inp => inp.addEventListener("change", () => {
    const k = inp.dataset.k;
    const v = inp.type === "checkbox" ? inp.checked : (k === "rate" ? Number(inp.value) : inp.value);
    store.setSetting(k, v); applySettings();
    if (k === "voiceURI" || k === "rate") speak("Здра́вствуйте!");
  }));
  // reports
  const rep = el.querySelector(".reports");
  const reps = store.get().reports;
  if (!reps.length) rep.append(h(`<p class="muted small">Chưa có báo lỗi. Trong bài học, bấm ⚑ để báo.</p>`));
  else {
    reps.slice().reverse().forEach(r => rep.append(h(`<div class="setting" style="display:block"><div class="small muted">${esc(r.where)}</div><div>${esc(r.text)}</div></div>`)));
    const cp = h(`<button class="btn primary" type="button" style="margin-top:10px">Sao chép tất cả để gửi Claude</button>`);
    cp.addEventListener("click", async () => {
      const txt = "Báo lỗi nội dung app tiếng Nga:\n\n" + reps.map((r, i) => `${i + 1}. [${r.where}] ${r.text}`).join("\n");
      toast((await copyText(txt)) ? "Đã sao chép." : "Không sao chép được.");
    });
    const clr = h(`<button class="btn ghost" type="button" style="margin-top:10px">Xóa danh sách</button>`);
    clr.addEventListener("click", () => { store.get().reports = []; store.save(); route(); });
    rep.append(cp, clr);
  }
  el.querySelector("[data-export]").addEventListener("click", () => {
    const blob = new Blob([store.exportJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `tieng-nga-sao-luu-${store.today()}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  el.querySelector("[data-import]").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    try { store.importJSON(await f.text()); applySettings(); toast("Đã khôi phục tiến độ."); route(); }
    catch (err) { toast(err.message || "File không hợp lệ."); }
  });
  el.querySelector("[data-reset]").addEventListener("click", () => {
    const c = h(`<div><h3>Xóa toàn bộ tiến độ?</h3><p>Không hoàn tác được. Nên tải file sao lưu trước.</p><div class="row end"><button class="btn" type="button" data-no>Hủy</button><button class="btn danger" type="button" data-yes>Xóa</button></div></div>`);
    const close = modal(c);
    c.querySelector("[data-no]").addEventListener("click", close);
    c.querySelector("[data-yes]").addEventListener("click", () => { store.resetAll(); applySettings(); close(); toast("Đã xóa."); route(); });
  });
  view.append(el);
}

boot();
