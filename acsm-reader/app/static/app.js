import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { doc: null, pdf: null, sizes: [], scale: 1, fit: true, current: 1, rendered: new Map(), observer: null };

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
  renderArticles(doc);
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

function articleItem(a, i, compact = false) {
  return `<li class="art${compact ? " compact" : ""}" data-i="${i}" data-page="${a.start_page}">
    <div class="t"><span>${esc(a.title)}</span><span class="pg">${range(a)}</span></div>
    <div class="s">${esc(a.summary)}</div>
    ${compact ? "" : `<div class="chips">${a.keywords.map((k) => `<span class="chip">${esc(k)}</span>`).join("")}</div>`}
  </li>`;
}

function bindArticleClicks(root) {
  root.querySelectorAll(".art").forEach((li) => (li.onclick = () => goTo(Number(li.dataset.page))));
}

function renderThemes(doc) {
  const el = $("#themes");
  el.innerHTML = doc.themes.map((t, ti) => `
    <details class="theme" ${ti < 3 ? "open" : ""}>
      <summary>${esc(t.name)}<span class="count">${t.article_indices.length}</span></summary>
      <p class="desc">${esc(t.description)}</p>
      <ul>${t.article_indices.map((i) => articleItem(doc.articles[i], i, true)).join("")}</ul>
    </details>`).join("") || '<p class="muted">Keine Themen erkannt.</p>';
  bindArticleClicks(el);
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

init();
