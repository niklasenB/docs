// Magazin-/E-Paper-Ansicht: Doppelseiten, 3D-Umblättern, Miniaturleiste.
//
// Doppelseiten wie im gedruckten Heft: Titelseite allein (rechts),
// danach 2|3, 4|5, … – auf schmalen/hochkant Bildschirmen Einzelseiten.

const FLIP_MS = 650;
const CACHE_MAX = 10;

export class Magazine {
  constructor(root, { onChange, labelOf, titleOf }) {
    this.root = root;
    this.onChange = onChange;           // (page) => void
    this.labelOf = labelOf;             // (page) => Seitenlabel
    this.titleOf = titleOf;             // (page) => Artikeltitel oder ""
    this.zoom = 1;
    this.cache = new Map();             // page -> {w, canvas}
    this.spreadIdx = 0;
    this.busy = false;
    this.queue = null;
    root.innerHTML = `
      <div class="mag-stage">
        <div class="mag-book">
          <div class="leaf left"></div><div class="leaf right"></div>
        </div>
        <button class="mag-nav prev" title="Zurückblättern">‹</button>
        <button class="mag-nav next" title="Weiterblättern">›</button>
      </div>
      <div class="mag-strip"></div>`;
    this.stage = root.querySelector(".mag-stage");
    this.book = root.querySelector(".mag-book");
    this.slots = { left: root.querySelector(".leaf.left"), right: root.querySelector(".leaf.right") };
    this.strip = root.querySelector(".mag-strip");
    if (window.innerWidth < 860) this.strip.classList.add("hidden");
    root.querySelector(".mag-nav.prev").onclick = (e) => { e.stopPropagation(); this.prev(); };
    root.querySelector(".mag-nav.next").onclick = (e) => { e.stopPropagation(); this.next(); };
    this._bindGestures();
  }

  // ------------------------------------------------------------ Aufbau

  open(pdf, sizes) {
    this.pdf = pdf;
    this.sizes = sizes;
    this.cache.clear();
    this.zoom = 1;
    this.spreadIdx = 0;
    this.pageW = Math.max(...sizes.map((s) => s[0]));
    this.pageH = Math.max(...sizes.map((s) => s[1]));
    this._buildSpreads();
  }

  _buildSpreads() {
    const n = this.pdf.numPages;
    const avail = this._avail();
    // Doppelseite nur, wenn die Seiten dabei höchstens ~20 % kleiner werden als einzeln.
    const one = Math.min(avail.h / this.pageH, avail.w / this.pageW);
    const two = Math.min(avail.h / this.pageH, avail.w / (2 * this.pageW));
    this.single = two < one * 0.8 || avail.w < avail.h || n === 1;
    this.spreads = [];
    if (this.single) {
      for (let p = 1; p <= n; p++) this.spreads.push({ left: null, right: p });
    } else {
      this.spreads.push({ left: null, right: 1 });
      for (let p = 2; p <= n; p += 2) this.spreads.push({ left: p, right: p + 1 <= n ? p + 1 : null });
    }
    this.root.classList.toggle("single", this.single);
    this._buildStrip();
  }

  _avail() {
    const r = this.stage.getBoundingClientRect();
    const pad = r.width < 600 ? 16 : 96;
    return { w: Math.max(150, r.width - pad), h: Math.max(150, r.height - 24) };
  }

  spreadOf(page) {
    return Math.max(0, this.spreads.findIndex((s) => s.left === page || s.right === page));
  }

  firstPage(i = this.spreadIdx) {
    const s = this.spreads[i];
    return s.left ?? s.right;
  }

  layout() {
    if (!this.pdf) return;
    const keep = this.firstPage();
    const wasSingle = this.single;
    this._buildSpreads();
    if (wasSingle !== this.single) this.spreadIdx = this.spreadOf(keep);
    const avail = this._avail();
    const cols = this.single ? 1 : 2;
    const fit = Math.min(avail.h / this.pageH, avail.w / (cols * this.pageW));
    this.scale = fit * this.zoom;
    this.pw = Math.floor(this.pageW * this.scale);
    this.ph = Math.floor(this.pageH * this.scale);
    this.book.style.width = `${this.pw * cols}px`;
    this.book.style.height = `${this.ph}px`;
    for (const s of Object.values(this.slots)) {
      s.style.width = `${this.pw}px`;
      s.style.height = `${this.ph}px`;
    }
    this.slots.right.style.left = this.single ? "0px" : `${this.pw}px`;
    this.stage.classList.toggle("zoomed", this.zoom > 1);
    this.cache.clear();
    this._show(this.spreadIdx, 0);
  }

  // ------------------------------------------------------------ Rendern

  async _canvas(page) {
    if (!page) return null;
    const hit = this.cache.get(page);
    if (hit && hit.w === this.pw) {
      this.cache.delete(page); this.cache.set(page, hit);   // LRU
      return hit.canvas;
    }
    const p = await this.pdf.getPage(page);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const base = p.getViewport({ scale: 1 });
    // Seite in die Seitenbox einpassen (Seiten können unterschiedlich groß sein).
    const s = Math.min(this.pw / base.width, this.ph / base.height) * dpr;
    const vp = p.getViewport({ scale: s });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await p.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    this.cache.set(page, { w: this.pw, canvas: c });
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    return c;
  }

  _clone(src) {
    const c = document.createElement("canvas");
    if (!src) return c;
    c.width = src.width; c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  }

  async _fill(slot, page) {
    const el = this.slots[slot];
    el.dataset.page = page ?? "";
    el.classList.toggle("empty", !page);
    const c = this._clone(await this._canvas(page));
    if (el.dataset.page !== String(page ?? "")) return;     // inzwischen anders belegt
    el.replaceChildren(c);
    if (page) {
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = this.labelOf(page);
      el.appendChild(num);
    }
  }

  _prefetch(i) {
    for (const j of [i + 1, i - 1, i + 2]) {
      const s = this.spreads[j];
      if (s) { this._canvas(s.left); this._canvas(s.right); }
    }
  }

  // ------------------------------------------------------------ Navigation

  /** Zur Doppelseite mit `page` (optional Seite kurz hervorheben). */
  show(page, { flash = false, animate = true } = {}) {
    const i = this.spreadOf(page);
    this._go(i, animate, flash ? page : null);
  }

  // Während eine Animation läuft, zählen weitere Klicks vom bereits vorgemerkten Ziel aus.
  _target() { return this.queue ? this.queue[0] : this.spreadIdx; }
  next() { this._go(Math.min(this._target() + 1, this.spreads.length - 1), true); }
  prev() { this._go(Math.max(this._target() - 1, 0), true); }

  _go(i, animate, flashPage = null) {
    if (!this.spreads || i < 0 || i >= this.spreads.length) return;
    if (this.busy) { this.queue = [i, animate, flashPage]; return; }
    const dir = Math.sign(i - this.spreadIdx);
    this._show(i, animate && dir && this.zoom === 1 ? dir : 0, flashPage);
  }

  async _show(i, dir, flashPage = null) {
    const from = this.spreads[this.spreadIdx];
    const to = this.spreads[i];
    this.spreadIdx = i;
    this.onChange(flashPage ?? this.firstPage(i));
    this._markStrip();
    this.busy = true;
    try {
      if (!dir) {
        await Promise.all([this._fill("left", to.left), this._fill("right", to.right)]);
      } else if (this.single) {
        await this._slide(to.right, dir);
      } else {
        await this._flip(from, to, dir);
      }
    } finally {
      this.busy = false;
    }
    if (flashPage) {
      const el = Object.values(this.slots).find((s) => s.dataset.page === String(flashPage));
      el?.classList.add("flash");
      setTimeout(() => el?.classList.remove("flash"), 900);
    }
    this._prefetch(i);
    if (this.queue) { const q = this.queue; this.queue = null; this._go(...q); }
  }

  async _flip(from, to, dir) {
    // Vorwärts: rechte Seite klappt nach links. Unter ihr erscheint die neue
    // rechte Seite, ihre Rückseite ist die neue linke Seite. Rückwärts gespiegelt.
    const [frontPage, backPage, under, land] = dir > 0
      ? [from.right, to.left, "right", "left"]
      : [from.left, to.right, "left", "right"];
    const [front, back] = await Promise.all([this._canvas(frontPage), this._canvas(backPage)]);
    await this._fill(under, dir > 0 ? to.right : to.left);

    const flipper = document.createElement("div");
    flipper.className = `flipper ${dir > 0 ? "fwd" : "back"}`;
    flipper.style.width = `${this.pw}px`;
    flipper.style.height = `${this.ph}px`;
    flipper.style.left = dir > 0 ? `${this.pw}px` : "0px";
    flipper.innerHTML = '<div class="face front"></div><div class="face backface"></div>';
    flipper.querySelector(".front").append(this._clone(front));
    flipper.querySelector(".backface").append(this._clone(back));
    flipper.querySelector(".front").classList.toggle("empty", !frontPage);
    flipper.querySelector(".backface").classList.toggle("empty", !backPage);
    this.book.appendChild(flipper);
    // Ursprüngliche Seite unter dem Blatt ausblenden, sonst scheint sie durch.
    const cover = this.slots[under];
    const shade = document.createElement("div");
    shade.className = `shade ${under}`;
    cover.appendChild(shade);

    const anim = flipper.animate(
      [{ transform: "rotateY(0deg)" }, { transform: `rotateY(${dir > 0 ? -180 : 180}deg)` }],
      { duration: FLIP_MS, easing: "cubic-bezier(.45,.05,.35,1)" });
    shade.animate([{ opacity: 0.35 }, { opacity: 0 }], { duration: FLIP_MS });
    await anim.finished.catch(() => {});
    await this._fill(land, dir > 0 ? to.left : to.right);
    flipper.remove();
    shade.remove();
  }

  async _slide(page, dir) {
    const old = this.slots.right.querySelector("canvas");
    const ghost = old ? this._clone(old) : null;
    await this._fill("right", page);
    if (!ghost) return;
    ghost.className = "ghost";
    this.slots.right.appendChild(ghost);
    const a = ghost.animate([{ transform: "translateX(0)", opacity: 1 },
                             { transform: `translateX(${dir > 0 ? -40 : 40}%)`, opacity: 0 }],
                            { duration: 300, easing: "ease-out" });
    this.slots.right.querySelector("canvas:not(.ghost)")?.animate(
      [{ transform: `translateX(${dir > 0 ? 30 : -30}%)`, opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 300, easing: "ease-out" });
    await a.finished.catch(() => {});
    ghost.remove();
  }

  setZoom(z) {
    this.zoom = Math.min(4, Math.max(1, z));
    this.layout();
  }

  // ------------------------------------------------------------ Gesten

  _bindGestures() {
    let x0 = null, y0 = null;
    this.stage.addEventListener("pointerdown", (e) => { x0 = e.clientX; y0 = e.clientY; });
    this.stage.addEventListener("pointerup", (e) => {
      if (x0 === null || this.zoom > 1) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        dx < 0 ? this.next() : this.prev();
      } else if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && e.target.closest(".mag-book")) {
        // Klick auf die äußeren Ränder blättert, Klick in die Mitte nicht.
        const r = this.book.getBoundingClientRect();
        const rel = (e.clientX - r.left) / r.width;
        if (rel > 0.8) this.next();
        else if (rel < 0.2) this.prev();
      }
    });
    this.stage.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this.setZoom(this.zoom > 1 ? 1 : 2);
    });
  }

  // ------------------------------------------------------------ Miniaturen

  _buildStrip() {
    this.thumbObs?.disconnect();
    this.strip.innerHTML = this.spreads.map((s, i) => {
      const pages = [s.left, s.right].filter(Boolean);
      const title = pages.map((p) => this.titleOf(p)).filter(Boolean)[0] || "";
      return `<button class="thumb" data-i="${i}" title="${title.replace(/"/g, "&quot;")}">
        <span class="tp">${pages.map((p) => `<span class="tc" data-p="${p}"></span>`).join("")}</span>
        <span class="tl">${pages.map((p) => this.labelOf(p)).join("–")}</span></button>`;
    }).join("");
    const th = 72;
    this.strip.querySelectorAll(".tc").forEach((el) => {
      const [w, h] = this.sizes[Number(el.dataset.p) - 1];
      el.style.width = `${Math.round(th * w / h)}px`;
      el.style.height = `${th}px`;
    });
    this.strip.querySelectorAll(".thumb").forEach((b) => (b.onclick = () => this._go(Number(b.dataset.i), true)));
    this.thumbObs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        this.thumbObs.unobserve(e.target);
        e.target.querySelectorAll(".tc").forEach((el) => this._thumb(el));
      });
    }, { root: this.strip, rootMargin: "0px 400px" });
    this.strip.querySelectorAll(".thumb").forEach((b) => this.thumbObs.observe(b));
    this._markStrip();
  }

  async _thumb(el) {
    const p = await this.pdf.getPage(Number(el.dataset.p));
    const base = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: (72 * 2) / base.height });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await p.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    el.replaceChildren(c);
  }

  _markStrip() {
    const cur = this.strip.querySelector(`.thumb[data-i="${this.spreadIdx}"]`);
    this.strip.querySelectorAll(".thumb.cur").forEach((t) => t !== cur && t.classList.remove("cur"));
    if (cur && !cur.classList.contains("cur")) {
      cur.classList.add("cur");
      cur.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
  }
}
