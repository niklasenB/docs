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

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import acsm, ai, audio, config, pdftools
from . import profile as prof

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
        analysis = {**meta, **result}
        (target / "analysis.json").write_text(json.dumps(analysis, ensure_ascii=False, indent=1))
        p = prof.load()
        if not prof.is_empty(p):
            progress("Persönliche Auswertung für dein Profil …")
            try:
                _personal(target, analysis, p)
            except ai.AnalysisError:
                pass  # kann später im Reiter "Für dich" nachgeholt werden
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


def _personal(d: Path, analysis: dict, p: dict) -> dict:
    res = ai.personalize(analysis, p, prof.history())
    res["profile_hash"] = prof.fingerprint(p)
    (d / f"personal-{res['profile_hash']}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    return res


@app.get("/api/profile")
def get_profile():
    return prof.load()


@app.put("/api/profile")
def put_profile(data: dict = Body(...)):
    return prof.save(data)


@app.get("/api/history")
def get_history():
    return prof.history()[::-1]


@app.delete("/api/history")
def delete_history():
    prof.clear_history()
    return {"ok": True}


@app.post("/api/history")
def post_history(data: dict = Body(...)):
    d = _doc_dir(str(data.get("doc_id", "")))
    a = json.loads((d / "analysis.json").read_text())
    i = int(data.get("article_index", -1))
    if not 0 <= i < len(a["articles"]):
        raise HTTPException(400, "ungültiger Artikel")
    art = a["articles"][i]
    prof.add_history({"doc_id": d.name, "doc_title": a["title"], "title": art["title"],
                      "keywords": art["keywords"]})
    return {"ok": True}


@app.get("/api/documents/{doc_id}/personal")
def get_personal(doc_id: str):
    d = _doc_dir(doc_id)
    p = prof.load()
    if prof.is_empty(p):
        return {"status": "no_profile"}
    f = d / f"personal-{prof.fingerprint(p)}.json"
    if f.exists():
        return {"status": "ok", **json.loads(f.read_text())}
    return {"status": "missing"}


@app.post("/api/documents/{doc_id}/personal")
def post_personal(doc_id: str):
    d = _doc_dir(doc_id)
    p = prof.load()
    if prof.is_empty(p):
        raise HTTPException(400, "Bitte zuerst ein Profil anlegen.")
    analysis = json.loads((d / "analysis.json").read_text())
    try:
        return {"status": "ok", **_personal(d, analysis, p)}
    except ai.AnalysisError as e:
        raise HTTPException(502, str(e)) from e


# --------------------------------------------------------------------------- Podcast

def _audio_plan(d: Path, analysis: dict, kind: str, index: int) -> tuple[list[int], str, str]:
    """Welche Artikel, welcher Fokus, welcher Cache-Schlüssel."""
    arts, n = analysis["articles"], len(analysis["articles"])
    if kind == "article":
        if not 0 <= index < n:
            raise HTTPException(400, "ungültiger Artikel")
        return [index], f'Der Artikel „{arts[index]["title"]}“ ausführlich.', f"article-{index}"
    if kind == "theme":
        if not 0 <= index < len(analysis["themes"]):
            raise HTTPException(400, "ungültiges Thema")
        t = analysis["themes"][index]
        return t["article_indices"], f'Das Thema „{t["name"]}“: {t["description"]}', f"theme-{index}"
    if kind == "document":
        return list(range(n)), "Überblick über die ganze Ausgabe; Wichtigstes zuerst, Rest kurz streifen.", "document"
    if kind == "briefing":
        p = prof.load()
        if prof.is_empty(p):
            raise HTTPException(400, "Für das persönliche Briefing bitte zuerst ein Profil anlegen.")
        f = d / f"personal-{prof.fingerprint(p)}.json"
        personal = json.loads(f.read_text()) if f.exists() else _personal(d, analysis, p)
        rec = [r["article_index"] for r in personal["recommendations"] if r["score"] >= 2]
        disc = [x["article_index"] for x in personal["discoveries"][:2]]
        idx = list(dict.fromkeys(rec[:6] + disc))
        if not idx:
            raise HTTPException(400, "In diesem Dokument wurde nichts Passendes für dein Profil gefunden.")
        focus = ("Persönliches Briefing: zuerst die Artikel, die zu den Interessen passen; am Ende "
                 f"{len(disc)} Artikel 'über den Tellerrand' mit ihrer Brücke zu den Interessen: "
                 + "; ".join(f'{x["article_index"]}: {x["bridge"]}' for x in personal["discoveries"][:2]))
        return idx, focus, f"briefing-{prof.fingerprint(p)}"
    raise HTTPException(400, "unbekannte Art")


def _make_audio(job_id: str, d: Path, analysis: dict, indices: list[int], focus: str, length: str,
                key: str, with_profile: bool) -> None:
    progress = lambda msg: _update(job_id, message=msg)
    try:
        _update(job_id, stage="script", message="Claude schreibt das Gesprächsskript …")
        pages = json.loads((d / "pages.json").read_text())
        script = audio.write_script(analysis, pages, indices, focus, length,
                                    prof.load() if with_profile else None)
        _update(job_id, stage="tts", message="Stimmen werden lokal erzeugt …")
        out = d / "audio"
        out.mkdir(exist_ok=True)
        meta = audio.render(script, out / key, progress)
        meta["key"] = key
        (out / f"{key}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
        _update(job_id, stage="done", message="Fertig.", audio_key=key)
    except (audio.AudioError, ai.AnalysisError) as e:
        _update(job_id, stage="error", error=str(e))
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        _update(job_id, stage="error", error=f"Unerwarteter Fehler: {e}")


@app.post("/api/documents/{doc_id}/audio")
def create_audio(doc_id: str, data: dict = Body(...)):
    d = _doc_dir(doc_id)
    analysis = json.loads((d / "analysis.json").read_text())
    kind, length = str(data.get("kind")), str(data.get("length", "mittel"))
    if length not in audio.LENGTHS:
        raise HTTPException(400, "Länge: kurz, mittel oder lang")
    indices, focus, key = _audio_plan(d, analysis, kind, int(data.get("index", -1)))
    key = f"{key}-{length}"
    job_id = _new_job(key)
    if (d / "audio" / f"{key}.json").exists() and not data.get("regenerate"):
        _update(job_id, stage="done", message="Bereits vorhanden.", audio_key=key)
    else:
        executor.submit(_make_audio, job_id, d, analysis, indices, focus, length, key,
                        kind in ("briefing", "document", "theme"))
    return {"job_id": job_id, "key": key}


@app.get("/api/documents/{doc_id}/audio")
def list_audio(doc_id: str):
    out = _doc_dir(doc_id) / "audio"
    if not out.is_dir():
        return []
    items = [json.loads(f.read_text()) for f in out.glob("*.json")]
    return sorted(items, key=lambda m: m["key"])


@app.get("/api/documents/{doc_id}/audio/{key}")
def get_audio(doc_id: str, key: str):
    if not all(c.isalnum() or c == "-" for c in key):
        raise HTTPException(400, "ungültiger Schlüssel")
    f = _doc_dir(doc_id) / "audio" / f"{key}.json"
    if not f.exists():
        raise HTTPException(404, "nicht gefunden")
    return json.loads(f.read_text())


@app.get("/api/documents/{doc_id}/audio/{key}/file")
def get_audio_file(doc_id: str, key: str):
    meta = get_audio(doc_id, key)
    f = _doc_dir(doc_id) / "audio" / meta["file"]
    return FileResponse(f, media_type="audio/mpeg" if f.suffix == ".mp3" else "audio/wav")


@app.delete("/api/documents/{doc_id}/audio/{key}")
def delete_audio(doc_id: str, key: str):
    meta = get_audio(doc_id, key)
    out = _doc_dir(doc_id) / "audio"
    (out / meta["file"]).unlink(missing_ok=True)
    (out / f"{key}.json").unlink(missing_ok=True)
    return {"ok": True}


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
