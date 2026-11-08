"""ACSM -> PDF/EPUB über die libgourou-Kommandozeilenwerkzeuge.

Benötigt `adept_activate`, `acsmdownloader` und `adept_remove` im PATH
(im Docker-Image enthalten).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from . import config

TOOLS = ("adept_activate", "acsmdownloader", "adept_remove")
CRED_FILES = ("device.xml", "activation.xml", "devicesalt")


class AcsmError(RuntimeError):
    pass


# Bekannte Fehlercodes mit verständlicher Erklärung.
KNOWN_ERRORS = {
    "E_LIC_ALREADY_FULFILLED_BY_ANOTHER_USER": (
        "Diese ACSM-Datei wurde bereits mit einem anderen Gerät/Konto eingelöst. "
        "Lade beim Händler eine frische ACSM-Datei herunter."
    ),
    "E_ADEPT_REQUEST_EXPIRED": (
        "Die ACSM-Datei ist abgelaufen. Lade sie beim Händler erneut herunter."
    ),
    "E_GOOGLE_DEVICE_LIMIT_REACHED": (
        "Google Play Books: Gerätelimit erreicht. Entferne alte Geräte im Google-Konto."
    ),
}


def available() -> bool:
    return all(shutil.which(t) for t in TOOLS)


def _run(cmd: list[str], timeout: int, cwd: Path | None = None) -> str:
    try:
        res = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL
        )
    except subprocess.TimeoutExpired as e:
        raise AcsmError(f"Zeitüberschreitung bei {cmd[0]} (>{timeout}s).") from e
    out = (res.stdout or "") + (res.stderr or "")
    if res.returncode != 0:
        for code, hint in KNOWN_ERRORS.items():
            if code in out:
                raise AcsmError(f"{code}: {hint}")
        tail = "\n".join(out.strip().splitlines()[-8:])
        raise AcsmError(f"{cmd[0]} fehlgeschlagen (rc={res.returncode}):\n{tail}")
    return out


def _ensure_device() -> Path:
    adept = config.ADEPT_DIR
    if all((adept / f).exists() for f in CRED_FILES):
        return adept
    # adept_activate fragt interaktiv nach, wenn das Verzeichnis existiert.
    if adept.exists():
        shutil.rmtree(adept)
    adept.parent.mkdir(parents=True, exist_ok=True)
    _run(["adept_activate", "--anonymous", "--output-dir", str(adept)], config.ACTIVATE_TIMEOUT)
    return adept


def convert(acsm_path: Path, work_dir: Path, progress=lambda msg: None) -> Path:
    """Löst die ACSM-Datei ein und liefert den Pfad zur entschlüsselten PDF/EPUB."""
    if not available():
        raise AcsmError(
            "libgourou-Werkzeuge nicht gefunden. Starte die App per Docker "
            "(siehe README) oder lade direkt eine PDF/EPUB hoch."
        )
    progress("Adobe-Gerät wird vorbereitet …")
    adept = _ensure_device()

    dl_dir = work_dir / "download"
    dl_dir.mkdir(parents=True, exist_ok=True)
    progress("Buch wird beim Anbieter abgerufen …")
    _run(
        ["acsmdownloader", "--adept-directory", str(adept), "--output-dir", str(dl_dir), str(acsm_path)],
        config.DOWNLOAD_TIMEOUT,
        cwd=dl_dir,
    )
    files = [p for p in dl_dir.iterdir() if p.suffix.lower() in (".pdf", ".epub")]
    if not files:
        raise AcsmError("acsmdownloader hat keine PDF/EPUB-Datei erzeugt.")
    encrypted = max(files, key=lambda p: p.stat().st_size)

    progress("Datei wird für die Analyse aufbereitet …")
    out = work_dir / f"book{encrypted.suffix.lower()}"
    _run(
        ["adept_remove", "--adept-directory", str(adept), "--output-file", str(out), str(encrypted)],
        config.DECRYPT_TIMEOUT,
    )
    return out
