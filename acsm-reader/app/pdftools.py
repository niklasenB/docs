"""PDF-Aufbereitung: EPUB->PDF, Text pro Seite, Inhaltsverzeichnis, Suche."""
from __future__ import annotations

import re
from pathlib import Path

import pymupdf


def to_pdf(path: Path, out: Path) -> Path:
    """Konvertiert EPUB (oder andere von MuPDF lesbare Formate) nach PDF."""
    if path.suffix.lower() == ".pdf":
        return path
    with pymupdf.open(path) as doc:
        if doc.is_reflowable:
            doc.layout(width=595, height=842, fontsize=11)  # A4
        pdf_bytes = doc.convert_to_pdf()
    with pymupdf.open("pdf", pdf_bytes) as pdf:
        # Inhaltsverzeichnis aus dem EPUB übernehmen, damit es im PDF erhalten bleibt.
        with pymupdf.open(path) as src:
            if src.is_reflowable:
                src.layout(width=595, height=842, fontsize=11)
            toc = src.get_toc(simple=True)
        if toc:
            try:
                pdf.set_toc(toc)
            except Exception:
                pass
        pdf.save(out, garbage=3, deflate=True)
    return out


def extract(pdf_path: Path) -> dict:
    with pymupdf.open(pdf_path) as doc:
        if doc.needs_pass:
            raise ValueError("Das PDF ist passwortgeschützt bzw. noch DRM-verschlüsselt.")
        pages = []
        for i, page in enumerate(doc):
            text = page.get_text("text")
            text = re.sub(r"[ \t]+", " ", text)
            text = re.sub(r"\n{3,}", "\n\n", text).strip()
            pages.append({"index": i + 1, "label": page.get_label() or str(i + 1), "text": text})
        meta = doc.metadata or {}
        toc = [{"level": l, "title": t, "page": p} for l, t, p in doc.get_toc(simple=True) if p > 0]
    return {
        "title": (meta.get("title") or "").strip(),
        "author": (meta.get("author") or "").strip(),
        "page_count": len(pages),
        "pages": pages,
        "toc": toc,
    }


def search(pages: list[dict], query: str, limit: int = 50) -> list[dict]:
    q = query.strip()
    if not q:
        return []
    rx = re.compile(re.escape(q), re.IGNORECASE)
    hits = []
    for p in pages:
        text = p["text"]
        matches = list(rx.finditer(text))
        if not matches:
            continue
        m = matches[0]
        start, end = max(0, m.start() - 80), min(len(text), m.end() + 80)
        snippet = text[start:end].replace("\n", " ")
        hits.append({"page": p["index"], "label": p["label"], "count": len(matches),
                     "snippet": ("…" if start else "") + snippet + ("…" if end < len(text) else "")})
        if len(hits) >= limit:
            break
    return hits
