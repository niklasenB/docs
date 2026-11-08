"""Leseprofil und Leseverlauf (eine Person pro Installation, als JSON gespeichert)."""
from __future__ import annotations

import hashlib
import json
import threading
import time

from . import config

PROFILE = config.DATA_DIR / "profile.json"
HISTORY = config.DATA_DIR / "history.json"
_lock = threading.Lock()

DEFAULT = {"interests": [], "about": "", "avoid": [], "exploration": 1}


def _clean_list(v) -> list[str]:
    seen, out = set(), []
    for x in v or []:
        x = str(x).strip()[:80]
        if x and x.lower() not in seen:
            seen.add(x.lower())
            out.append(x)
    return out[:50]


def load() -> dict:
    if PROFILE.exists():
        return {**DEFAULT, **json.loads(PROFILE.read_text())}
    return dict(DEFAULT)


def save(data: dict) -> dict:
    p = {
        "interests": _clean_list(data.get("interests")),
        "avoid": _clean_list(data.get("avoid")),
        "about": str(data.get("about", ""))[:2000].strip(),
        "exploration": min(max(int(data.get("exploration", 1)), 0), 2),
    }
    with _lock:
        PROFILE.parent.mkdir(parents=True, exist_ok=True)
        PROFILE.write_text(json.dumps(p, ensure_ascii=False, indent=1))
    return p


def is_empty(p: dict) -> bool:
    return not (p["interests"] or p["about"])


def fingerprint(p: dict) -> str:
    """Hash des Profils: Persönliche Auswertungen werden je Profilstand zwischengespeichert."""
    return hashlib.sha256(json.dumps(p, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


def history() -> list[dict]:
    return json.loads(HISTORY.read_text()) if HISTORY.exists() else []


def add_history(entry: dict) -> None:
    with _lock:
        h = history()
        # Gleichen Artikel nicht mehrfach hintereinander zählen.
        h = [x for x in h if not (x["doc_id"] == entry["doc_id"] and x["title"] == entry["title"])]
        h.append({**entry, "at": time.time()})
        HISTORY.parent.mkdir(parents=True, exist_ok=True)
        HISTORY.write_text(json.dumps(h[-200:], ensure_ascii=False))


def clear_history() -> None:
    with _lock:
        HISTORY.unlink(missing_ok=True)
