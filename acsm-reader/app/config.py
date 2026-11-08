"""Zentrale Konfiguration über Umgebungsvariablen."""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
# Persistentes Adobe-Geräteverzeichnis: Eine ACSM-Datei kann nur einmal pro Gerät
# eingelöst werden, deshalb wird die anonyme Aktivierung wiederverwendet.
ADEPT_DIR = Path(os.environ.get("ADEPT_DIR", DATA_DIR / "adept"))

CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
CLAUDE_EFFORT = os.environ.get("CLAUDE_EFFORT", "medium")  # low | medium | high | xhigh | max
# Serverseitiger Refusal-Fallback (nur Claude API / Claude Platform on AWS).
CLAUDE_FALLBACK = os.environ.get("CLAUDE_FALLBACK", "1") not in ("0", "false", "no")
SUMMARY_LANGUAGE = os.environ.get("SUMMARY_LANGUAGE", "Deutsch")

# Zeichenbudget pro Analyse-Abschnitt. Größere Dokumente werden in Abschnitte
# zerlegt (Artikel je Abschnitt erkennen, danach Gesamt-Synthese).
CHUNK_CHARS = int(os.environ.get("CHUNK_CHARS", "300000"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "200"))

ACTIVATE_TIMEOUT = 120
DOWNLOAD_TIMEOUT = 900
DECRYPT_TIMEOUT = 600

# Lokale Sprachsynthese (Piper) für den Podcast-Dialog
VOICES_DIR = Path(os.environ.get("VOICES_DIR", DATA_DIR / "voices"))
PIPER_VOICES_URL = os.environ.get("PIPER_VOICES_URL", "https://huggingface.co/rhasspy/piper-voices/resolve/main")
PIPER_VOICE_A = os.environ.get("PIPER_VOICE_A", "de_DE-kerstin-low")      # Moderatorin
PIPER_VOICE_B = os.environ.get("PIPER_VOICE_B", "de_DE-thorsten-medium")  # Experte
SPEAKER_A_NAME = os.environ.get("SPEAKER_A_NAME", "Lena")
SPEAKER_B_NAME = os.environ.get("SPEAKER_B_NAME", "Jonas")
