import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { recommended: new Set(), profile: null, doc: null, pdf: null, sizes: [], scale: 1, fit: true, current: 1, rendered: new Map(), observer: null };

// ------------------------------------------------------------------ Start / Upload

async function init() {
  const st = await fetch("/api/status").then((r) => r.json()).catch(() => null);
  const badge = $("#statusBadge");
  if (st) {
    badge.textContent = st.acsm_supported ? "ACSM aktiv" : "ACSM nicht verfügbar – nur PDF/EPUB";
    badge.classList.toggle("warn", !st.acsm_supported);
  }
  loadLibrary();
  route();
}

function route() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("doc")) openDoc(p.get("doc"), Number(p.get("page")) || 1);
  else showStart();
}
window.addEventListener("popstate", route);

function showStart() {
  $("#startView").classList.remove("hidden");
  $("#docView").classList.add("hidden");
  $("#docTitle").textContent = "";
  state.doc = null;
  loadLibrary();
}
$("#homeBtn").onclick = () => { history.pushState(null, "", location.pathname); showStart(); };

async function loadLibrary() {
  const docs = await fetch("/api/documents").then((r) => r.json()).catch(() => []);
  const ul = $("#library");
  if (!docs.length) { ul.innerHTML = '<li class="muted">Noch keine Dokumente.</li>'; return; }
  ul.innerHTML = docs.map((d) => `
    <li class="item" data-id="${esc(d.doc_id)}">
      <b>${esc(d.title)}</b>
      <span class="muted small">${d.page_count} Seiten · ${d.articles} Artikel</span>
    </li>`).join("");
  ul.querySelectorAll("li.item").forEach((li) => (li.onclick = () => navigate(li.dataset.id, 1)));
}

const dz = $("#dropzone");
["dragenter", "dragover"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((e) => dz.addEventListener(e, () => dz.classList.remove("over")));
dz.addEventListener("drop", (ev) => { ev.preventDefault(); if (ev.dataTransfer.files[0]) upload(ev.dataTransfer.files[0]); });
// Auch Dateien, die neben die Dropzone fallen, annehmen statt sie im Browser zu öffnen.
window.addEventListener("dragover", (ev) => ev.preventDefault());
window.addEventListener("drop", (ev) => { ev.preventDefault(); if (!$("#startView").classList.contains("hidden") && ev.dataTransfer.files[0]) upload(ev.dataTransfer.files[0]); });
$("#fileInput").onchange = (ev) => ev.target.files[0] && upload(ev.target.files[0]);
dz.addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("#fileInput").click(); });

async function upload(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["acsm", "pdf", "epub"].includes(ext)) return showProgress({ stage: "error", error: "Bitte eine .acsm-, .pdf- oder .epub-Datei verwenden." });
  showProgress({ stage: ext === "acsm" ? "convert" : "prepare", message: `${file.name} wird hochgeladen …` });
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showProgress({ stage: "error", error: data.detail || `Upload fehlgeschlagen (${res.status})` });
  pollJob(data.job_id);
}

async function pollJob(id) {
  const j = await fetch(`/api/jobs/${id}`).then((r) => r.json());
  showProgress(j);
  if (j.stage === "done") return setTimeout(() => navigate(j.doc_id, 1), 400);
  if (j.stage !== "error") setTimeout(() => pollJob(id), 1200);
}

const ORDER = ["convert", "prepare", "analyze", "done"];
function showProgress(j) {
  $("#startView").classList.remove("hidden");
  $("#docView").classList.add("hidden");
  const box = $("#progress");
  box.classList.remove("hidden");
  box.classList.toggle("finished", j.stage === "done" || j.stage === "error");
  const idx = ORDER.indexOf(j.stage);
  box.querySelectorAll(".steps li").forEach((li) => {
    const i = ORDER.indexOf(li.dataset.stage);
    li.classList.toggle("active", i === idx);
    li.classList.toggle("done", idx > -1 && i < idx);
  });
  $("#progressMsg").textContent = j.message || "";
  $("#progressErr").classList.toggle("hidden", !j.error);
  $("#progressErr").textContent = j.error || "";
}

// ------------------------------------------------------------------ Dokumentansicht

function navigate(id, page) {
  history.pushState(null, "", `#doc=${id}&page=${page}`);
  openDoc(id, page);
}

async function openDoc(id, page = 1) {
  if (state.doc?.doc_id === id) return goTo(page);
  const res = await fetch(`/api/documents/${id}`);
  if (!res.ok) { history.replaceState(null, "", location.pathname); return showStart(); }
  const doc = await res.json();
  state.doc = doc;
  $("#startView").classList.add("hidden");
  $("#progress").classList.add("hidden");
  $("#docView").classList.remove("hidden");
  $("#docTitle").textContent = doc.title;
  document.title = `${doc.title} – ACSM Reader`;
  renderOverview(doc);
  renderThemes(doc);
  state.recommended = new Set();
  renderArticles(doc);
  showTab("foryou");
  loadPersonal();
  closePlayer();
  loadPodcasts();
  $("#searchResults").innerHTML = "";
  $("#searchInput").value = "";
  await loadPdf(`/api/documents/${id}/pdf`);
  goTo(page, false);
}

const pageLabel = (n) => state.doc?.page_labels?.[n - 1] ?? String(n);
const range = (a) => a.start_page === a.end_page ? `S. ${pageLabel(a.start_page)}` : `S. ${pageLabel(a.start_page)}–${pageLabel(a.end_page)}`;

function renderOverview(doc) {
  $("#ovTitle").textContent = doc.title;
  $("#ovMeta").textContent = [doc.author, `${doc.page_count} Seiten`, `${doc.articles.length} Artikel`, `${doc.themes.length} Themen`].filter(Boolean).join(" · ");
  $("#ovSummary").innerHTML = doc.summary.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join("");
  $("#ovPoints").innerHTML = doc.key_points.map((k) => `<li>${esc(k)}</li>`).join("");
  $("#ovModel").textContent = doc.model || "Claude";
}

function articleItem(a, i, compact = false, extra = "") {
  const star = state.recommended.has(i) ? '<span class="star" title="Passt zu deinem Profil">★</span> ' : "";
  return `<li class="art${compact ? " compact" : ""}" data-i="${i}" data-page="${a.start_page}">
    <div class="t"><span>${star}${esc(a.title)}</span><span class="pg">${range(a)}</span></div>${extra}
    <div class="s">${esc(a.summary)}</div>
    ${compact ? "" : `<div class="chips"><span class="chip btn pod" data-i="${i}" title="Diesen Artikel als Podcast">🎧 anhören</span>${a.keywords.map((k) => `<span class="chip btn kw" data-kw="${esc(k)}" title="Als Interesse ins Profil übernehmen">${esc(k)}</span>`).join("")}</div>`}
  </li>`;
}

function bindArticleClicks(root) {
  root.querySelectorAll(".art").forEach((li) => (li.onclick = () => openArticle(Number(li.dataset.i))));
  root.querySelectorAll(".pod").forEach((c) => (c.onclick = (e) => {
    e.stopPropagation();
    const i = Number(c.dataset.i);
    openAudio("article", i, `Artikel: ${state.doc.articles[i].title}`);
  }));
  root.querySelectorAll(".kw").forEach((c) => (c.onclick = (e) => { e.stopPropagation(); addInterest(c.dataset.kw); }));
}

function renderThemes(doc) {
  const el = $("#themes");
  el.innerHTML = doc.themes.map((t, ti) => `
    <details class="theme" ${ti < 3 ? "open" : ""}>
      <summary>${esc(t.name)}<span class="count">${t.article_indices.length}</span>
        <button class="podbtn small" data-theme="${ti}" title="Thema als Podcast">🎧</button></summary>
      <p class="desc">${esc(t.description)}</p>
      <ul>${t.article_indices.map((i) => articleItem(doc.articles[i], i, true)).join("")}</ul>
    </details>`).join("") || '<p class="muted">Keine Themen erkannt.</p>';
  bindArticleClicks(el);
  el.querySelectorAll("[data-theme]").forEach((b) => (b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const t = doc.themes[Number(b.dataset.theme)];
    openAudio("theme", Number(b.dataset.theme), `Thema: ${t.name}`);
  }));
}

function renderArticles(doc, filter = "") {
  const f = filter.trim().toLowerCase();
  const items = doc.articles
    .map((a, i) => [a, i])
    .filter(([a]) => !f || [a.title, a.summary, ...a.keywords].join(" ").toLowerCase().includes(f));
  const el = $("#articles");
  el.innerHTML = items.map(([a, i]) => articleItem(a, i)).join("") || '<li class="muted">Keine Treffer.</li>';
  bindArticleClicks(el);
  markCurrentArticle();
}
$("#articleFilter").oninput = (e) => renderArticles(state.doc, e.target.value);

function showTab(name) {
  document.querySelector(`.tabs button[data-tab="${name}"]`).click();
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${b.dataset.tab}`));
  if (b.dataset.tab === "search") $("#searchInput").focus();
}));

$("#searchForm").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("#searchInput").value.trim();
  if (!q) return;
  const hits = await fetch(`/api/documents/${state.doc.doc_id}/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  $("#searchResults").innerHTML = hits.map((h) => `
    <li data-page="${h.page}"><b>S. ${esc(h.label)}</b> <span class="muted small">(${h.count}×)</span><br>
    ${esc(h.snippet).replace(rx, (m) => `<mark>${m}</mark>`)}</li>`).join("") || '<li class="muted">Keine Treffer.</li>';
  $("#searchResults").querySelectorAll("li[data-page]").forEach((li) => (li.onclick = () => goTo(Number(li.dataset.page))));
};

$("#reanalyzeBtn").onclick = async () => {
  if (!confirm("Dokument erneut von Claude analysieren lassen? (verursacht erneut API-Kosten)")) return;
  const { job_id } = await fetch(`/api/documents/${state.doc.doc_id}/reanalyze`, { method: "POST" }).then((r) => r.json());
  state.doc = null;
  history.pushState(null, "", location.pathname);
  pollJob(job_id);
};
$("#deleteBtn").onclick = async () => {
  if (!confirm("Dokument und Analyse löschen?")) return;
  await fetch(`/api/documents/${state.doc.doc_id}`, { method: "DELETE" });
  history.pushState(null, "", location.pathname);
  showStart();
};

// ------------------------------------------------------------------ PDF-Viewer

const pagesEl = $("#pages");

async function loadPdf(url) {
  state.pdf?.destroy();
  state.rendered.clear();
  pagesEl.innerHTML = "";
  state.pdf = await pdfjsLib.getDocument(url).promise;
  const n = state.pdf.numPages;
  state.sizes = [];
  for (let i = 1; i <= n; i += 25) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(25, n - i + 1) }, (_, k) =>
        state.pdf.getPage(i + k).then((p) => { const v = p.getViewport({ scale: 1 }); return [v.width, v.height]; })));
    state.sizes.push(...batch);
  }
  $("#pageTotal").textContent = `/ ${n}`;
  $("#pageInput").max = n;
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= n; i++) {
    const d = document.createElement("div");
    d.className = "page";
    d.dataset.page = i;
    frag.appendChild(d);
  }
  pagesEl.appendChild(frag);
  state.observer?.disconnect();
  state.observer = new IntersectionObserver((entries) => {
    entries.forEach((e) => e.isIntersecting && renderPage(Number(e.target.dataset.page)));
  }, { root: pagesEl, rootMargin: "1200px 0px" });
  pagesEl.querySelectorAll(".page").forEach((d) => state.observer.observe(d));
  state.fit = true;
  layout();
}

function fitScale() {
  const maxW = Math.max(...state.sizes.map((s) => s[0]));
  return Math.max(0.3, (pagesEl.clientWidth - 48) / maxW);
}

function layout() {
  if (!state.pdf) return;
  const keep = state.current;
  if (state.fit) state.scale = fitScale();
  $("#zoomLabel").textContent = `${Math.round(state.scale * 100)} %`;
  pagesEl.querySelectorAll(".page").forEach((d, i) => {
    const [w, h] = state.sizes[i];
    d.style.width = `${w * state.scale}px`;
    d.style.height = `${h * state.scale}px`;
    d.innerHTML = `<span class="num">${esc(pageLabel(i + 1))}</span>`;
  });
  state.rendered.clear();
  goTo(keep, false);
  // Sichtbare Seiten nach Größenänderung neu zeichnen.
  pagesEl.querySelectorAll(".page").forEach((d) => { state.observer.unobserve(d); state.observer.observe(d); });
}

async function renderPage(n) {
  const scale = state.scale;
  if (state.rendered.get(n) === scale) return;
  state.rendered.set(n, scale);
  const page = await state.pdf.getPage(n);
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: scale * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  if (state.rendered.get(n) !== scale) return; // inzwischen gezoomt
  const holder = pagesEl.querySelector(`.page[data-page="${n}"]`);
  holder.querySelector("canvas")?.remove();
  holder.prepend(canvas);
}

function goTo(n, flash = true) {
  if (!state.pdf) return;
  n = Math.min(Math.max(1, Math.round(n)), state.pdf.numPages);
  const el = pagesEl.querySelector(`.page[data-page="${n}"]`);
  pagesEl.scrollTop = el.offsetTop - 8;
  setCurrent(n);
  if (flash) { el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 900); }
}

function setCurrent(n) {
  state.current = n;
  $("#pageInput").value = n;
  if (state.doc) history.replaceState(null, "", `#doc=${state.doc.doc_id}&page=${n}`);
  markCurrentArticle();
}

function articleAt(n) {
  // Spezifischsten (kürzesten) Artikel wählen, der die Seite enthält.
  let best = -1;
  state.doc?.articles.forEach((a, i) => {
    if (a.start_page <= n && n <= a.end_page) {
      const b = state.doc.articles[best];
      if (best < 0 || a.end_page - a.start_page < b.end_page - b.start_page) best = i;
    }
  });
  return best;
}

function markCurrentArticle() {
  const i = articleAt(state.current);
  document.querySelectorAll(".art").forEach((li) => li.classList.toggle("current", Number(li.dataset.i) === i));
  $("#currentArticle").textContent = i >= 0 ? state.doc.articles[i].title : "";
}

let scrollTimer;
pagesEl.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const top = pagesEl.scrollTop + pagesEl.clientHeight * 0.3;
    const pages = pagesEl.children;
    let lo = 0, hi = pages.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pages[mid].offsetTop <= top) lo = mid; else hi = mid - 1; }
    if (lo + 1 !== state.current) setCurrent(lo + 1);
  }, 80);
});

$("#prevBtn").onclick = () => goTo(state.current - 1, false);
$("#nextBtn").onclick = () => goTo(state.current + 1, false);
$("#pageInput").onchange = (e) => goTo(Number(e.target.value));
$("#zoomIn").onclick = () => { state.fit = false; state.scale = Math.min(4, state.scale * 1.2); layout(); };
$("#zoomOut").onclick = () => { state.fit = false; state.scale = Math.max(0.3, state.scale / 1.2); layout(); };
$("#fitBtn").onclick = () => { state.fit = true; layout(); };
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state.fit && layout(), 200); });
document.addEventListener("keydown", (e) => {
  if ($("#docView").classList.contains("hidden") || e.target.matches("input, textarea")) return;
  if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); goTo(state.current + 1, false); }
  if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); goTo(state.current - 1, false); }
});

// ------------------------------------------------------------------ Für dich / Profil

function openArticle(i) {
  const a = state.doc.articles[i];
  goTo(a.start_page);
  fetch("/api/history", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doc_id: state.doc.doc_id, article_index: i }) });
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2500);
}

async function loadProfile() {
  state.profile = await fetch("/api/profile").then((r) => r.json());
  return state.profile;
}

async function saveProfile(p) {
  state.profile = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p) }).then((r) => r.json());
  return state.profile;
}

async function addInterest(name) {
  const p = state.profile || await loadProfile();
  if (p.interests.some((x) => x.toLowerCase() === name.toLowerCase())) return toast(`„${name}“ ist schon in deinem Profil.`);
  await saveProfile({ ...p, interests: [...p.interests, name] });
  toast(`„${name}“ zum Profil hinzugefügt.`);
  return true;
}

const stars = (n) => `<span class="stars" title="Relevanz">${"★".repeat(n)}${"☆".repeat(3 - n)}</span>`;

async function loadPersonal(force = false) {
  const box = $("#foryou");
  const docId = state.doc.doc_id;
  let res = force ? { status: "missing" } : await fetch(`/api/documents/${docId}/personal`).then((r) => r.json());
  if (res.status === "no_profile") {
    box.innerHTML = `<div class="cta"><h2>Was interessiert dich?</h2>
      <p class="muted">Lege ein Leseprofil an. Dann zeigt dir Claude, welche Artikel zu dir passen,
      was du Neues entdecken könntest und wie du ein Thema vertiefst.</p>
      <button class="primary" id="ctaProfile">Profil anlegen</button></div>`;
    $("#ctaProfile").onclick = openProfile;
    return;
  }
  if (res.status === "missing") {
    box.innerHTML = '<div class="inline-spinner"></div><p class="muted" style="text-align:center">Claude wertet das Dokument für dein Profil aus …</p>';
    const r = await fetch(`/api/documents/${docId}/personal`, { method: "POST" });
    res = await r.json().catch(() => ({}));
    if (state.doc?.doc_id !== docId) return;
    if (!r.ok) {
      box.innerHTML = `<p class="error">${esc(res.detail || "Persönliche Auswertung fehlgeschlagen.")}</p>
        <button class="linkbtn" id="retryPersonal">Erneut versuchen</button>`;
      $("#retryPersonal").onclick = () => loadPersonal(true);
      return;
    }
  }
  if (state.doc?.doc_id !== docId) return;
  renderForYou(res);
}

function renderForYou(r) {
  const doc = state.doc;
  state.recommended = new Set(r.recommendations.filter((x) => x.score >= 2).map((x) => x.article_index));
  renderArticles(doc, $("#articleFilter").value);
  renderThemes(doc);
  const rec = r.recommendations.map((x) => articleItem(doc.articles[x.article_index], x.article_index, true,
    `<div class="reason">${stars(x.score)} <span class="chip">${esc(x.interest)}</span> ${esc(x.reason)}</div>`)).join("");
  const disc = r.discoveries.map((x) => articleItem(doc.articles[x.article_index], x.article_index, true,
    `<div class="bridge">↔ knüpft an: ${esc(x.bridge)}</div><div class="reason">${esc(x.reason)}</div>`)).join("");
  const deepen = r.deepen.map((d) => `<div class="deepen"><b>${esc(d.interest)}</b>
      <ul>${d.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
      <div class="chips">${d.search_terms.map((t) => `<span class="chip btn term" data-term="${esc(t)}" title="Im Dokument suchen">🔍 ${esc(t)}</span>`).join("")}</div>
      <div class="next">➜ ${esc(d.next_step)}</div></div>`).join("");
  const sugg = r.suggested_interests.map((s) => `<div class="sugg">
      <span class="chip btn add" data-name="${esc(s.name)}">${esc(s.name)}</span>
      <span class="muted">${esc(s.reason)}</span></div>`).join("");
  $("#foryou").innerHTML = `
    <div class="summary"><p>${esc(r.personal_summary)}</p></div>
    <button class="podbtn" id="briefingBtn">🎧 Mein Briefing als Podcast</button>
    <h3 class="fy-section">🎯 Passt zu dir <span class="muted">${r.recommendations.length}</span></h3>
    <ul class="articles">${rec || '<li class="muted">Diesmal nichts direkt Passendes.</li>'}</ul>
    <h3 class="fy-section">🧭 Über den Tellerrand <span class="muted">Neues mit Anknüpfungspunkt</span></h3>
    <ul class="articles">${disc || '<li class="muted">Keine Vorschläge.</li>'}</ul>
    ${deepen ? `<h3 class="fy-section">💡 Weiterdenken</h3>${deepen}` : ""}
    ${sugg ? `<h3 class="fy-section">🌱 Neue Interessen? <span class="muted">antippen zum Übernehmen</span></h3>${sugg}` : ""}
    <p class="muted small" style="margin-top:20px">Ausgewertet für dein aktuelles Profil ·
      <button class="linkbtn" id="profileEdit2">Profil bearbeiten</button> ·
      <button class="linkbtn" id="refreshPersonal">neu auswerten</button></p>`;
  const box = $("#foryou");
  bindArticleClicks(box);
  box.querySelectorAll(".term").forEach((c) => (c.onclick = () => {
    showTab("search");
    $("#searchInput").value = c.dataset.term;
    $("#searchForm").requestSubmit();
  }));
  box.querySelectorAll(".add").forEach((c) => (c.onclick = async () => {
    if (await addInterest(c.dataset.name)) { c.classList.remove("add"); c.classList.add("added"); }
  }));
  $("#profileEdit2").onclick = openProfile;
  $("#briefingBtn").onclick = () => openAudio("briefing", -1, "Dein persönliches Briefing – deine Themen plus Entdeckungen");
  $("#refreshPersonal").onclick = () => loadPersonal(true);
}

// Tag-Eingabe für Interessen / Ausschlüsse
function tagInput(el) {
  const input = el.querySelector("input");
  let tags = [];
  const render = () => {
    el.querySelectorAll(".tag").forEach((t) => t.remove());
    tags.forEach((t, i) => {
      const span = document.createElement("span");
      span.className = "tag";
      span.innerHTML = `${esc(t)}<button type="button" title="Entfernen">×</button>`;
      span.querySelector("button").onclick = () => { tags.splice(i, 1); render(); };
      el.insertBefore(span, input);
    });
  };
  const commit = () => {
    input.value.split(",").map((x) => x.trim()).filter(Boolean).forEach((v) => {
      if (!tags.some((t) => t.toLowerCase() === v.toLowerCase())) tags.push(v);
    });
    input.value = "";
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
    if (e.key === "Backspace" && !input.value && tags.length) { tags.pop(); render(); }
  });
  input.addEventListener("blur", commit);
  el.onclick = () => input.focus();
  return { get: () => { commit(); return tags; }, set: (v) => { tags = [...v]; render(); } };
}
const interestsTI = tagInput($("#interestsInput"));
const avoidTI = tagInput($("#avoidInput"));

async function openProfile() {
  const p = await loadProfile();
  interestsTI.set(p.interests);
  avoidTI.set(p.avoid);
  $("#aboutInput").value = p.about;
  document.querySelector(`input[name=exploration][value="${p.exploration}"]`).checked = true;
  const h = await fetch("/api/history").then((r) => r.json());
  $("#historyInfo").textContent = h.length
    ? `Dein Leseverlauf (${h.length} Artikel) fließt als zusätzliches Signal ein.`
    : "Angeklickte Artikel werden als Leseverlauf berücksichtigt.";
  $("#profileDlg").returnValue = "";
  $("#profileDlg").showModal();
}
$("#profileBtn").onclick = openProfile;
$("#clearHistoryBtn").onclick = async () => {
  await fetch("/api/history", { method: "DELETE" });
  $("#historyInfo").textContent = "Leseverlauf gelöscht.";
};
$("#profileDlg").addEventListener("close", async () => {
  if ($("#profileDlg").returnValue !== "save") return;
  await saveProfile({
    interests: interestsTI.get(),
    avoid: avoidTI.get(),
    about: $("#aboutInput").value,
    exploration: Number(document.querySelector("input[name=exploration]:checked")?.value ?? 1),
  });
  toast("Profil gespeichert.");
  if (state.doc) loadPersonal();
});

// ------------------------------------------------------------------ Podcast

const audioEl = $("#plAudio");
const player = { meta: null, seg: -1, article: -1 };

function keyPrefix(kind, index) {
  return kind === "document" ? "document-" : kind === "briefing" ? "briefing-" : `${kind}-${index}-`;
}

async function openAudio(kind, index, subject) {
  state.audioReq = { kind, index };
  $("#audioSubject").textContent = subject;
  $("#audioErr").classList.add("hidden");
  $("#audioProgress").classList.add("hidden");
  $("#audioCreate").disabled = false;
  const existing = (state.podcasts || []).filter((m) => m.key.startsWith(keyPrefix(kind, index)));
  $("#audioExisting").innerHTML = existing.length
    ? `<label class="fl">Schon erzeugt</label>${existing.map(podItem).join("")}` : "";
  bindPodItems($("#audioExisting"), true);
  $("#audioDlg").showModal();
}

$("#audioCreate").onclick = async () => {
  const { kind, index } = state.audioReq;
  const length = document.querySelector("input[name=length]:checked").value;
  $("#audioCreate").disabled = true;
  $("#audioErr").classList.add("hidden");
  $("#audioProgress").classList.remove("hidden");
  $("#audioMsg").textContent = "Wird gestartet …";
  const docId = state.doc.doc_id;
  const r = await fetch(`/api/documents/${docId}/audio`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, index, length }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return audioFail(data.detail || "Fehler beim Starten.");
  const poll = async () => {
    const j = await fetch(`/api/jobs/${data.job_id}`).then((x) => x.json());
    $("#audioMsg").textContent = j.message || "";
    if (j.stage === "error") return audioFail(j.error);
    if (j.stage !== "done") return setTimeout(poll, 1500);
    $("#audioDlg").close();
    await loadPodcasts();
    if (state.doc?.doc_id === docId) playPodcast(j.audio_key);
  };
  poll();
};

function audioFail(msg) {
  $("#audioProgress").classList.add("hidden");
  $("#audioErr").textContent = msg;
  $("#audioErr").classList.remove("hidden");
  $("#audioCreate").disabled = false;
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const LEN = { kurz: "kurz", mittel: "mittel", lang: "lang" };

function podItem(m) {
  const len = m.key.split("-").pop();
  return `<div class="pod-item" data-key="${esc(m.key)}"><b>${esc(m.title)}</b>
    <span class="muted small">${fmtTime(m.duration)} · ${esc(LEN[len] || "")}</span>
    <button data-act="play">▶</button><button data-act="del" title="Löschen">🗑</button></div>`;
}

function bindPodItems(root, closeDialog = false) {
  root.querySelectorAll(".pod-item").forEach((it) => {
    it.querySelector("[data-act=play]").onclick = () => { if (closeDialog) $("#audioDlg").close(); playPodcast(it.dataset.key); };
    it.querySelector("[data-act=del]").onclick = async () => {
      if (!confirm("Podcast löschen?")) return;
      await fetch(`/api/documents/${state.doc.doc_id}/audio/${it.dataset.key}`, { method: "DELETE" });
      if (player.meta?.key === it.dataset.key) closePlayer();
      it.remove();
      loadPodcasts();
    };
  });
}

async function loadPodcasts() {
  const docId = state.doc.doc_id;
  const list = await fetch(`/api/documents/${docId}/audio`).then((r) => r.json()).catch(() => []);
  if (state.doc?.doc_id !== docId) return;
  state.podcasts = list;
  $("#podcasts").innerHTML = `<h2>Podcasts</h2>
    <p class="muted small">Erzeuge Podcasts über 🎧 bei einem Thema, einem Artikel, im Reiter „Für dich“ oder hier für die ganze Ausgabe.</p>
    ${list.map(podItem).join("") || '<p class="muted">Noch keine Podcasts für dieses Dokument.</p>'}
    <button class="podbtn" id="docPodcastBtn2">🎧 Ganze Ausgabe als Podcast</button>`;
  bindPodItems($("#podcasts"));
  $("#docPodcastBtn2").onclick = () => openAudio("document", -1, "Die ganze Ausgabe im Überblick");
}
$("#docPodcastBtn").onclick = () => openAudio("document", -1, "Die ganze Ausgabe im Überblick");

async function playPodcast(key) {
  const meta = await fetch(`/api/documents/${state.doc.doc_id}/audio/${key}`).then((r) => r.json());
  player.meta = meta; player.seg = -1; player.article = -1;
  $("#plTitle").textContent = meta.title;
  $("#plScript").innerHTML = meta.segments.map((s, i) =>
    `<li data-i="${i}"><span class="sp ${s.speaker}">${esc(meta.speakers[s.speaker])}:</span>${esc(s.text)}</li>`).join("");
  $("#plScript").querySelectorAll("li").forEach((li) => (li.onclick = () => {
    audioEl.currentTime = meta.segments[Number(li.dataset.i)].start + 0.01;
    audioEl.play();
  }));
  $("#plNow").innerHTML = "";
  $("#player").classList.remove("hidden");
  audioEl.src = `/api/documents/${state.doc.doc_id}/audio/${key}/file`;
  audioEl.play().catch(() => {});
}

function closePlayer() {
  audioEl.pause();
  audioEl.removeAttribute("src");
  player.meta = null;
  $("#player").classList.add("hidden");
}
$("#plClose").onclick = closePlayer;
$("#plScriptBtn").onclick = () => $("#plScript").classList.toggle("hidden");

audioEl.addEventListener("timeupdate", () => {
  const m = player.meta;
  if (!m) return;
  const t = audioEl.currentTime;
  let i = m.segments.findIndex((s) => t < s.end + 0.3);
  if (i < 0) i = m.segments.length - 1;
  if (i === player.seg) return;
  player.seg = i;
  const lis = $("#plScript").querySelectorAll("li");
  lis.forEach((li, k) => li.classList.toggle("cur", k === i));
  if (!$("#plScript").classList.contains("hidden")) lis[i]?.scrollIntoView({ block: "nearest" });
  const ai = m.segments[i].article_index;
  if (ai >= 0 && ai !== player.article) {
    player.article = ai;
    const a = state.doc.articles[ai];
    $("#plNow").innerHTML = `📄 ${esc(a.title)} · <button id="plGo">${range(a)}</button>`;
    $("#plGo").onclick = () => goTo(a.start_page);
    if ($("#plFollow").checked) goTo(a.start_page, false);
  }
});

init();
