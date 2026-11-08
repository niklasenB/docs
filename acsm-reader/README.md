# ACSM Reader – KI-Zusammenfassung & Navigation für E-Books/Magazine

Ziehe eine `.acsm`-Datei in die Dropzone. Die App

1. **löst die ACSM-Datei ein** (über [libgourou](https://forge.soutade.fr/soutade/libgourou), wie
   [chrisvariety/acsm-converter](https://github.com/chrisvariety/acsm-converter)) und erzeugt ein PDF
   (EPUBs werden automatisch in PDF umgewandelt),
2. **analysiert das Dokument mit Claude**: erkennt die einzelnen Artikel/Kapitel mit Seitenbereich und
   erstellt eine Gesamtzusammenfassung, Kernaussagen und eine **thematische Übersicht**,
3. zeigt alles neben einem **PDF-Viewer**: Ein Klick auf einen Artikel oder ein Thema springt direkt
   zur richtigen Seite.

PDF- und EPUB-Dateien ohne DRM kannst du auch direkt hochladen.

## Funktionen

| Bereich | Inhalt |
|---|---|
| **Dropzone** | `.acsm`, `.pdf`, `.epub` per Drag & Drop oder Dateiauswahl, Fortschritt in Schritten |
| **Profil** | Interessen, „Über mich“, Ausschlüsse und Entdeckungsmodus (Fokus / Ausgewogen / Neugierig) |
| **Für dich** | Was im Heft für dich relevant ist (mit Begründung und Relevanz-Sternen), Artikel „über den Tellerrand“ mit Anknüpfungspunkt an deine Interessen, Leitfragen und Suchbegriffe zum Vertiefen sowie neue Interessen zum Übernehmen per Klick |
| **Podcast** 🎧 | Dialog zwischen Moderatorin und Experte, wahlweise als persönliches Briefing, pro Thema, pro Artikel oder für die ganze Ausgabe, in drei Längen. Claude schreibt das Skript, Piper erzeugt die Stimmen **lokal**. Im Player läuft das Skript mit, ein Klick auf eine Zeile springt an diese Stelle, und das PDF blättert automatisch zum gerade besprochenen Artikel |
| **Überblick** | Titel, Gesamtzusammenfassung, Kernaussagen |
| **Themen** | Themenblöcke mit Beschreibung und den zugehörigen Artikeln |
| **Artikel** | Alle Artikel mit Seitenbereich, Kurzfassung, Schlagworten und Filter |
| **Suche** | Volltextsuche im PDF mit Trefferstellen |
| **Magazin-Ansicht** | E-Paper-Darstellung: Titelseite allein, danach Doppelseiten wie im gedruckten Heft. Umblättern mit 3D-Animation per Pfeil, Klick auf den Seitenrand, Wischen oder Tastatur. Miniaturleiste aller Doppelseiten, Vollbild, Doppelklick zum Zoomen. Auf schmalen Bildschirmen und im Hochformat Einzelseiten |
| **Scroll-Ansicht** | Alternative per Umschalter: Endlos-Scrollen, Zoom, Seiteneingabe |
| **Navigation** | Artikel-, Themen- und Suchtreffer-Klicks sowie der Podcast blättern in beiden Ansichten zur richtigen (Doppel-)Seite. Die Zielseite wird kurz markiert, der aktuelle Artikel hervorgehoben, die Position bleibt in der URL (`#doc=…&page=…`) erhalten |
| **Bibliothek** | Analysierte Dokumente werden gespeichert. Das gleiche PDF wird nicht doppelt analysiert |

## Start mit Docker (empfohlen, inklusive ACSM-Unterstützung)

```bash
cd acsm-reader
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

Danach <http://localhost:8080> öffnen.

Im Ordner `./data` liegen die Bibliothek und die **anonyme Adobe-Geräteaktivierung**. Lösche ihn nicht:
Eine ACSM-Datei lässt sich nur einmal pro Gerät einlösen.

## Start ohne Docker (nur PDF/EPUB)

```bash
cd acsm-reader
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
uvicorn app.main:app --port 8080
```

Für ACSM-Dateien müssen zusätzlich `adept_activate`, `acsmdownloader` und `adept_remove` (libgourou)
im `PATH` liegen. Oben rechts zeigt die App an, ob ACSM verfügbar ist.

## Podcast (lokale Sprachsynthese)

Die Stimmen erzeugt [Piper](https://github.com/OHF-Voice/piper1-gpl) auf deinem Rechner. Es fallen
keine Kosten an, und der Skripttext verlässt den Rechner für die Sprachausgabe nicht. Claude wird nur
für das Schreiben des Skripts verwendet. Standardstimmen:

- Moderatorin „Lena“: `de_DE-kerstin-low`
- Experte „Jonas“: `de_DE-thorsten-medium`

Im Docker-Image sind beide Stimmen schon enthalten. Ohne Docker werden sie beim ersten Podcast von
Hugging Face (`rhasspy/piper-voices`) nach `data/voices/` geladen. Alternativ legst du die Dateien
`<stimme>.onnx` und `<stimme>.onnx.json` selbst dort ab. Andere Stimmen findest du unter
<https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE>. Mit `ffmpeg` im PATH wird MP3
erzeugt, sonst WAV.

Die Erzeugung braucht etwas Rechenzeit: Ein 6-Minuten-Podcast dauert auf einer normalen CPU grob
eine Minute für das Skript und etwa ein bis zwei Minuten für die Stimmen. Fertige Podcasts werden gespeichert.

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | API-Schlüssel für Claude |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Modell, z. B. `claude-sonnet-5-5` (günstiger) |
| `CLAUDE_EFFORT` | `medium` | `low` … `max`: Gründlichkeit gegen Kosten |
| `CLAUDE_FALLBACK` | `1` | Serverseitiger Ausweich-Modus bei Ablehnung (nur Claude API) |
| `SUMMARY_LANGUAGE` | `Deutsch` | Sprache der Zusammenfassungen |
| `CHUNK_CHARS` | `300000` | Zeichen pro Analyse-Abschnitt. Größere Dokumente werden abschnittsweise analysiert und dann zusammengeführt |
| `PIPER_VOICE_A` / `PIPER_VOICE_B` | `de_DE-kerstin-low` / `de_DE-thorsten-medium` | Piper-Stimmen für Moderatorin / Experte |
| `SPEAKER_A_NAME` / `SPEAKER_B_NAME` | `Lena` / `Jonas` | Namen im Gespräch |
| `VOICES_DIR` | `data/voices` | Ablage der Stimmen |
| `DATA_DIR` | `./data` | Speicherort für Bibliothek und Adobe-Aktivierung |
| `MAX_UPLOAD_MB` | `200` | Upload-Limit |

## So funktioniert die Analyse

- PyMuPDF extrahiert den Text Seite für Seite. Jede Seite wird als `<seite nr="N">` an Claude übergeben.
  So bekommt jeder erkannte Artikel exakte PDF-Seiten für die Navigation. Gedruckte Seitenzahlen
  (Seitenlabels) werden in der Oberfläche angezeigt.
- Vorhandene PDF-Lesezeichen gehen als Hinweis auf die Artikelgrenzen mit ein.
- Die Antworten nutzen *Structured Outputs* (JSON-Schema). Dadurch ist das Ergebnis immer maschinenlesbar.
- Kleine Dokumente brauchen einen API-Aufruf. Große Dokumente brauchen einen pro Abschnitt und einen
  für die Synthese. Die Ergebnisse landen in `data/documents/<hash>/analysis.json`.
- **Personalisierung:** Die Auswertung „Für dich“ nutzt nur die fertige Artikelliste (Titel,
  Kurzfassung, Schlagworte), nicht den Volltext. Dazu kommen dein Profil und dein Leseverlauf
  (angeklickte Artikel). Das ist ein kleiner, günstiger Aufruf mit `effort: low`. Ergebnisse werden je
  Profilstand gespeichert (`personal-<hash>.json`). Änderst du das Profil, wird beim nächsten Öffnen
  neu ausgewertet, ohne den Volltext erneut zu analysieren. Profil und Verlauf liegen in
  `data/profile.json` und `data/history.json`.
- Gescannte PDFs ohne Textebene müssen vorher per OCR aufbereitet werden (z. B. mit `ocrmypdf`).

## Projektstruktur

```
app/main.py       FastAPI-Server: Upload, Jobs, Bibliothek, PDF-Auslieferung, Suche
app/acsm.py       libgourou-Aufrufe (Aktivierung, Download, Aufbereitung)
app/pdftools.py   EPUB→PDF, Text/Inhaltsverzeichnis je Seite, Volltextsuche
app/ai.py         Claude-Analyse (Artikel, Zusammenfassung, Themen) und Personalisierung
app/profile.py    Leseprofil und Leseverlauf
app/audio.py      Podcast: Dialog-Skript (Claude) + lokale Sprachsynthese (Piper)
app/static/       Oberfläche (Dropzone, Übersicht, PDF-Viewer mit pdf.js; magazine.js = E-Paper-Ansicht)
Dockerfile        baut libgourou + App
```

## Rechtlicher Hinweis

Beim Einlösen einer ACSM-Datei wird der Adobe-Kopierschutz (ADEPT) des Buchs entfernt, damit der Text
analysiert werden kann. In Deutschland verbietet **§ 95a UrhG** das Umgehen wirksamer technischer
Schutzmaßnahmen grundsätzlich, auch für die private Nutzung. Prüfe, ob das in deinem Fall zulässig ist.
Verwende nur Inhalte, die du selbst rechtmäßig erworben hast, und gib die erzeugten Dateien nicht weiter.
Alternativ kannst du ein PDF/EPUB ohne DRM direkt hochladen; dafür wird libgourou nicht gebraucht.

Beachte außerdem: Der Text des Dokuments wird zur Analyse an die Claude-API von Anthropic gesendet.

## Lizenzen

- pdf.js (Mozilla, Apache-2.0) liegt unter `app/static/vendor/pdfjs/`.
- libgourou/uPDFParser (LGPL-3.0) werden beim Docker-Build aus den Quellen gebaut.
- piper-tts (GPL-3.0) wird als Python-Paket installiert. Für die Stimmen gelten die Lizenzangaben in
  ihren `MODEL_CARD`-Dateien bei rhasspy/piper-voices.
