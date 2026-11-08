"""Web-Server: Dropzone -> (ACSM einlösen) -> PDF -> Claude-Analyse -> Navigation."""
from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import acsm, ai, config, pdftools

STATIC = Path(__file__).parent / "static"
DOCS = config.DATA_DIR / "documents"
DOCS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="ACSM Reader")
executor = ThreadPoolExecutor(max_workers=2)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()

ALLOWED = {".acsm", ".pdf", ".epub"}


def _update(job_id: str, **kw) -> None:
    with jobs_lock:
        jobs[job_id].update(kw, updated=time.time())


def _doc_dir(doc_id: str) -> Path:
    if not doc_id.isalnum():
        raise HTTPException(400, "ungültige Dokument-ID")
    d = DOCS / doc_id
    if not d.is_dir():
        raise HTTPException(404, "Dokument nicht gefunden")
    return d


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()[:24]


def _process(job_id: str, upload: Path, original_name: str, reanalyze: bool = False) -> None:
    progress = lambda msg: _update(job_id, message=msg)
    work = upload.parent
    try:
        src = upload
        if upload.suffix.lower() == ".acsm":
            _update(job_id, stage="convert")
            src = acsm.convert(upload, work, progress)

        _update(job_id, stage="prepare", message="PDF wird vorbereitet …")
        pdf = pdftools.to_pdf(src, work / "book.pdf")
        doc_id = _sha256(pdf)
        target = DOCS / doc_id
        target.mkdir(exist_ok=True)
        if not (target / "book.pdf").exists():
            shutil.copy(pdf, target / "book.pdf")

        if (target / "analysis.json").exists() and not reanalyze:
            _update(job_id, stage="done", doc_id=doc_id, message="Bereits analysiert – aus dem Cache geladen.")
            return

        progress("Text wird extrahiert …")
        doc = pdftools.extract(target / "book.pdf")
        (target / "pages.json").write_text(json.dumps(doc["pages"], ensure_ascii=False))

        _update(job_id, stage="analyze")
        result = ai.analyze(doc, progress)
        meta = {
            "doc_id": doc_id,
            "file_name": Path(original_name).stem,
            "title": result.get("title") or doc["title"] or Path(original_name).stem,
            "author": doc["author"],
            "page_count": doc["page_count"],
            "page_labels": [p["label"] for p in doc["pages"]],
            "toc": doc["toc"],
            "created": time.time(),
        }
        (target / "analysis.json").write_text(json.dumps({**meta, **result}, ensure_ascii=False, indent=1))
        _update(job_id, stage="done", doc_id=doc_id, message="Fertig.")
    except (acsm.AcsmError, ai.AnalysisError, ValueError) as e:
        _update(job_id, stage="error", error=str(e))
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        _update(job_id, stage="error", error=f"Unerwarteter Fehler: {e}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _new_job(name: str) -> str:
    job_id = uuid.uuid4().hex
    with jobs_lock:
        jobs[job_id] = {"id": job_id, "file": name, "stage": "queued", "message": "In Warteschlange …",
                        "error": None, "doc_id": None, "updated": time.time()}
    return job_id


# --------------------------------------------------------------------------- API

@app.get("/api/status")
def status():
    return {"acsm_supported": acsm.available(), "model": config.CLAUDE_MODEL}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    name = file.filename or "upload"
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED:
        raise HTTPException(400, "Bitte eine .acsm-, .pdf- oder .epub-Datei hochladen.")
    work = Path(tempfile.mkdtemp(prefix="acsm-"))
    dest = work / f"upload{ext}"
    size, limit = 0, config.MAX_UPLOAD_MB * 1024 * 1024
    with open(dest, "wb") as f:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > limit:
                shutil.rmtree(work, ignore_errors=True)
                raise HTTPException(413, f"Datei größer als {config.MAX_UPLOAD_MB} MB.")
            f.write(chunk)
    job_id = _new_job(name)
    executor.submit(_process, job_id, dest, name)
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    with jobs_lock:
        j = jobs.get(job_id)
        if not j:
            raise HTTPException(404, "Job nicht gefunden")
        return dict(j)


@app.get("/api/documents")
def documents():
    out = []
    for d in DOCS.iterdir():
        f = d / "analysis.json"
        if f.exists():
            a = json.loads(f.read_text())
            out.append({k: a.get(k) for k in ("doc_id", "title", "author", "page_count", "created")}
                       | {"articles": len(a.get("articles", []))})
    return sorted(out, key=lambda x: x["created"] or 0, reverse=True)


@app.get("/api/documents/{doc_id}")
def document(doc_id: str):
    f = _doc_dir(doc_id) / "analysis.json"
    if not f.exists():
        raise HTTPException(404, "Analyse noch nicht vorhanden")
    return json.loads(f.read_text())


@app.get("/api/documents/{doc_id}/pdf")
def document_pdf(doc_id: str):
    return FileResponse(_doc_dir(doc_id) / "book.pdf", media_type="application/pdf")


@app.get("/api/documents/{doc_id}/search")
def document_search(doc_id: str, q: str):
    f = _doc_dir(doc_id) / "pages.json"
    if not f.exists():
        return []
    return pdftools.search(json.loads(f.read_text()), q)


@app.post("/api/documents/{doc_id}/reanalyze")
def document_reanalyze(doc_id: str):
    d = _doc_dir(doc_id)
    work = Path(tempfile.mkdtemp(prefix="acsm-"))
    shutil.copy(d / "book.pdf", work / "upload.pdf")
    job_id = _new_job(doc_id)
    executor.submit(_process, job_id, work / "upload.pdf", doc_id, True)
    return {"job_id": job_id}


@app.delete("/api/documents/{doc_id}")
def document_delete(doc_id: str):
    shutil.rmtree(_doc_dir(doc_id))
    return {"ok": True}


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
