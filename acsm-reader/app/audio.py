"""Podcast-Dialog: Claude schreibt das Skript, Piper spricht es lokal ein.

Zwei Sprecher:
  A = Moderatorin (führt durchs Gespräch, stellt Fragen)
  B = Experte (erklärt, ordnet ein)

Die Stimmen (ONNX-Modelle von rhasspy/piper-voices) werden beim ersten
Gebrauch nach DATA_DIR/voices geladen – im Docker-Image sind sie schon enthalten.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import urllib.request
import wave
from pathlib import Path

import numpy as np

from . import ai, config

VOICES_DIR = config.VOICES_DIR
SAMPLE_RATE = 22050
PAUSE_SPEAKER = 0.45   # Sekunden Pause bei Sprecherwechsel
PAUSE_SAME = 0.2

SPEAKERS = {
    "A": {"name": config.SPEAKER_A_NAME, "voice": config.PIPER_VOICE_A, "role": "Moderatorin"},
    "B": {"name": config.SPEAKER_B_NAME, "voice": config.PIPER_VOICE_B, "role": "Experte"},
}

LENGTHS = {
    "kurz": ("ca. 3 Minuten", 450),
    "mittel": ("ca. 6 Minuten", 900),
    "lang": ("ca. 10 Minuten", 1500),
}

_voice_cache: dict[str, object] = {}
_voice_lock = threading.Lock()


class AudioError(RuntimeError):
    pass


# --------------------------------------------------------------------------- Skript

SCRIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Kurzer Titel der Folge"},
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "speaker": {"type": "string", "enum": ["A", "B"]},
                    "text": {"type": "string", "description": "Gesprochener Text, 1-4 Sätze"},
                    "article_index": {
                        "type": "integer",
                        "description": "Index des Artikels, über den gerade gesprochen wird, sonst -1",
                    },
                },
                "required": ["speaker", "text", "article_index"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "segments"],
    "additionalProperties": False,
}


def _article_text(pages: list[dict], a: dict, limit: int = 24000) -> str:
    text = "\n".join(p["text"] for p in pages[a["start_page"] - 1 : a["end_page"]])
    if len(text) > limit:
        text = text[:limit] + "\n[… Artikel gekürzt, Rest siehe Zusammenfassung …]"
    return text


def write_script(analysis: dict, pages: list[dict], indices: list[int], focus: str,
                 length: str, profile: dict | None) -> dict:
    duration, words = LENGTHS.get(length, LENGTHS["mittel"])
    a, b = SPEAKERS["A"], SPEAKERS["B"]
    arts = analysis["articles"]
    # Bei vielen Artikeln nur Zusammenfassungen, sonst wird das Material zu groß.
    full_text = len(indices) <= 8

    def block(i: int) -> str:
        head = (f'<artikel index="{i}" titel="{arts[i]["title"]}" '
                f'seiten="{arts[i]["start_page"]}-{arts[i]["end_page"]}">\n'
                f'Zusammenfassung: {arts[i]["summary"]}\nSchlagworte: {", ".join(arts[i]["keywords"])}\n')
        if full_text:
            head += ("Volltext der Seiten (kann Teile anderer Artikel auf denselben Seiten enthalten – "
                     f"konzentriere dich auf diesen Artikel):\n{_article_text(pages, arts[i])}\n")
        return head + "</artikel>"

    material = "\n\n".join(block(i) for i in indices)
    listener = ""
    if profile and (profile.get("interests") or profile.get("about")):
        listener = (
            "\n<hoerer>\n"
            f"Interessen: {', '.join(profile.get('interests', []))}\n"
            f"Über die Person: {profile.get('about', '')}\n"
            "</hoerer>\nRichte Schwerpunkte und Beispiele an dieser Person aus und sprich "
            "sie gelegentlich mit 'du' an, wo es natürlich wirkt.\n"
        )
    system = (
        "Du schreibst Skripte für einen deutschsprachigen Zwei-Personen-Podcast, der Zeitungs- "
        "und Magazinartikel verständlich und lebendig aufbereitet. Der Text wird von einer "
        "Sprachsynthese vorgelesen. Deshalb gilt: nur ganze, gut sprechbare Sätze; keine "
        "Abkürzungen (schreibe 'zum Beispiel', 'Prozent', 'Euro'); Zahlen so, wie man sie sagt; "
        "keine Aufzählungszeichen, Klammern, Emojis, Regieanweisungen oder Lautmalerei; keine "
        "URLs. Bleib bei den Fakten aus dem Material und erfinde nichts dazu; kennzeichne "
        "Meinungen der Autoren als solche."
    )
    user = (
        f"Sprecherin A heißt {a['name']} und moderiert: sie führt ein, stellt neugierige "
        f"Fragen, fasst zusammen und leitet zwischen den Artikeln über. Sprecher B heißt "
        f"{b['name']} und erklärt: Hintergründe, Zusammenhänge, was daraus folgt.\n"
        "Die beiden reden natürlich miteinander, mit kurzen Rückfragen und Reaktionen, ohne "
        "Floskeln. Wechsle die Sprecher häufig. Beginne mit einer kurzen Begrüßung und einem "
        "Überblick und ende mit einem Fazit und einer Frage zum Weiterdenken.\n"
        f"Länge: {duration}, also etwa {words} Wörter insgesamt.\n"
        f"Inhaltlicher Fokus: {focus}\n"
        f"Dokument: {analysis.get('title')}\n{listener}\n"
        "Setze bei jedem Segment article_index auf den Index des besprochenen Artikels "
        "(oder -1 bei Begrüßung, Übergang, Fazit).\n\n"
        f"<material>\n{material}\n</material>"
    )
    res = ai._call(user, SCRIPT_SCHEMA, max_tokens=16000, system=system)
    valid = set(indices)
    segs = []
    for s in res["segments"]:
        text = " ".join(s["text"].split())
        if not text:
            continue
        segs.append({"speaker": s["speaker"] if s["speaker"] in SPEAKERS else "A", "text": text,
                     "article_index": s["article_index"] if s["article_index"] in valid else -1})
    if not segs:
        raise AudioError("Claude hat kein Skript geliefert.")
    return {"title": res["title"], "segments": segs}


# --------------------------------------------------------------------------- Sprachsynthese

def _voice_files(name: str) -> tuple[Path, Path]:
    return VOICES_DIR / f"{name}.onnx", VOICES_DIR / f"{name}.onnx.json"


def _download_voice(name: str) -> None:
    # Name wie de_DE-thorsten-medium -> de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx
    try:
        locale, speaker, quality = name.split("-")
    except ValueError as e:
        raise AudioError(f"Ungültiger Stimmenname: {name}") from e
    base = f"{config.PIPER_VOICES_URL}/{locale.split('_')[0]}/{locale}/{speaker}/{quality}/{name}"
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    for suffix in (".onnx.json", ".onnx"):
        dest = VOICES_DIR / f"{name}{suffix}"
        tmp = dest.with_suffix(dest.suffix + ".part")
        try:
            with urllib.request.urlopen(base + suffix, timeout=60) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
        except Exception as e:  # noqa: BLE001
            tmp.unlink(missing_ok=True)
            raise AudioError(
                f"Stimme {name} konnte nicht geladen werden ({e}). Lege {name}.onnx und "
                f"{name}.onnx.json manuell in {VOICES_DIR} ab."
            ) from e
        tmp.rename(dest)


def _voice(name: str):
    with _voice_lock:
        if name in _voice_cache:
            return _voice_cache[name]
        try:
            from piper import PiperVoice
        except ImportError as e:
            raise AudioError("piper-tts ist nicht installiert (pip install piper-tts).") from e
        model, cfg = _voice_files(name)
        if not (model.exists() and cfg.exists()):
            _download_voice(name)
        v = PiperVoice.load(model, config_path=cfg)
        _voice_cache[name] = v
        return v


def _resample(x: np.ndarray, sr: int) -> np.ndarray:
    if sr == SAMPLE_RATE or len(x) == 0:
        return x
    n = int(round(len(x) * SAMPLE_RATE / sr))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def synthesize_segment(text: str, speaker: str) -> np.ndarray:
    """Liefert float32-Audio in [-1, 1] mit SAMPLE_RATE."""
    voice = _voice(SPEAKERS[speaker]["voice"])
    parts = []
    for chunk in voice.synthesize(text):
        audio = np.asarray(chunk.audio_float_array, dtype=np.float32).reshape(-1)
        parts.append(_resample(audio, chunk.sample_rate))
        parts.append(np.zeros(int(0.12 * SAMPLE_RATE), dtype=np.float32))  # Satzpause
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def render(script: dict, out_base: Path, progress=lambda msg: None) -> dict:
    """Spricht alle Segmente ein, schreibt MP3 (oder WAV) und Zeitmarken."""
    pieces, t, prev = [], 0.0, None
    segs = script["segments"]
    for i, seg in enumerate(segs):
        if i % 5 == 0:
            progress(f"Stimmen werden erzeugt … {i}/{len(segs)}")
        if prev is not None:
            pause = PAUSE_SPEAKER if seg["speaker"] != prev else PAUSE_SAME
            pieces.append(np.zeros(int(pause * SAMPLE_RATE), dtype=np.float32))
            t += pause
        audio = synthesize_segment(seg["text"], seg["speaker"])
        seg["start"] = round(t, 2)
        t += len(audio) / SAMPLE_RATE
        seg["end"] = round(t, 2)
        pieces.append(audio)
        prev = seg["speaker"]

    pcm = (np.clip(np.concatenate(pieces), -1, 1) * 32767).astype("<i2")
    wav = out_base.with_suffix(".wav")
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())

    file = wav
    if shutil.which("ffmpeg"):
        mp3 = out_base.with_suffix(".mp3")
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-codec:a", "libmp3lame",
                            "-q:a", "5", str(mp3)], capture_output=True)
        if r.returncode == 0:
            wav.unlink()
            file = mp3
    meta = {**script, "duration": round(t, 1), "file": file.name,
            "speakers": {k: v["name"] for k, v in SPEAKERS.items()}}
    out_base.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    return meta
