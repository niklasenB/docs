"""KI-Analyse mit Claude: Artikel erkennen, Zusammenfassung, thematische Übersicht.

Ablauf:
  * Der Text wird seitenweise mit Seitenmarkern an Claude gegeben, damit jeder
    erkannte Artikel eine exakte Start-/Endseite bekommt (für die Navigation).
  * Passt das Dokument in einen Abschnitt (CHUNK_CHARS), erledigt ein Aufruf alles.
  * Größere Dokumente: pro Abschnitt Artikel erkennen, danach eine Synthese
    (Gesamtzusammenfassung + Themen) über die Artikelliste.
"""
from __future__ import annotations

import json

import anthropic

from . import config

_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


class AnalysisError(RuntimeError):
    pass


# --------------------------------------------------------------------------- Schemas

_ARTICLE = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Titel des Artikels/Kapitels"},
        "start_page": {"type": "integer", "description": "Seitennummer laut <seite nr=...>, wo der Artikel beginnt"},
        "end_page": {"type": "integer", "description": "Seitennummer laut <seite nr=...>, wo der Artikel endet"},
        "summary": {"type": "string", "description": "Zusammenfassung in 2-4 Sätzen"},
        "keywords": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "start_page", "end_page", "summary", "keywords"],
    "additionalProperties": False,
}

_THEME = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "description": {"type": "string", "description": "1-2 Sätze, worum es in diesem Themenblock geht"},
        "article_indices": {
            "type": "array",
            "items": {"type": "integer"},
            "description": "0-basierte Indizes der zugehörigen Artikel",
        },
    },
    "required": ["name", "description", "article_indices"],
    "additionalProperties": False,
}

_OVERVIEW_PROPS = {
    "title": {"type": "string", "description": "Titel des Dokuments"},
    "summary": {"type": "string", "description": "Gesamtzusammenfassung, 1-3 Absätze"},
    "key_points": {"type": "array", "items": {"type": "string"}, "description": "5-10 Kernaussagen"},
    "themes": {"type": "array", "items": _THEME},
}

FULL_SCHEMA = {
    "type": "object",
    "properties": {"articles": {"type": "array", "items": _ARTICLE}, **_OVERVIEW_PROPS},
    "required": ["articles", "title", "summary", "key_points", "themes"],
    "additionalProperties": False,
}

ARTICLES_SCHEMA = {
    "type": "object",
    "properties": {"articles": {"type": "array", "items": _ARTICLE}},
    "required": ["articles"],
    "additionalProperties": False,
}

SYNTHESIS_SCHEMA = {
    "type": "object",
    "properties": _OVERVIEW_PROPS,
    "required": ["title", "summary", "key_points", "themes"],
    "additionalProperties": False,
}


# --------------------------------------------------------------------------- Prompts

def _system() -> str:
    return (
        "Du analysierst Dokumente (Zeitschriften, Magazine, Fachbücher, Sammelbände), "
        "damit ein Leser schnell versteht, was drinsteht, und gezielt zu einzelnen "
        f"Artikeln springen kann. Antworte immer auf {config.SUMMARY_LANGUAGE}.\n\n"
        "Der Text ist seitenweise in <seite nr=\"N\" label=\"…\">…</seite> verpackt. "
        "Seitenangaben in deiner Antwort beziehen sich immer auf das Attribut nr "
        "(physische Seite im PDF), nicht auf gedruckte Seitenzahlen im Text.\n\n"
        "Ein 'Artikel' ist eine inhaltlich abgeschlossene Einheit: ein Zeitschriftenartikel, "
        "ein Kapitel oder ein klar abgegrenzter Abschnitt. Werbung, Impressum, leere Seiten "
        "und reine Bildseiten sind keine Artikel. Ist das Dokument ein durchgehendes Buch, "
        "nimm die Kapitel als Artikel. Fasse sachlich und konkret zusammen – nenne Thesen, "
        "Ergebnisse und Zahlen statt allgemeiner Floskeln."
    )


def _pages_block(pages: list[dict]) -> str:
    return "\n".join(
        f'<seite nr="{p["index"]}" label="{p["label"]}">\n{p["text"]}\n</seite>' for p in pages
    )


def _toc_block(toc: list[dict]) -> str:
    if not toc:
        return ""
    lines = "\n".join(f'{"  " * (t["level"] - 1)}- {t["title"]} (nr {t["page"]})' for t in toc)
    return (
        "Das PDF enthält dieses Inhaltsverzeichnis (Lesezeichen). Nutze es als Hinweis "
        f"für die Artikelgrenzen, prüfe es aber am Text:\n<inhaltsverzeichnis>\n{lines}\n</inhaltsverzeichnis>\n\n"
    )


# --------------------------------------------------------------------------- API-Aufruf

def _call(user_text: str, schema: dict, max_tokens: int = 64000) -> dict:
    kwargs = dict(
        model=config.CLAUDE_MODEL,
        max_tokens=max_tokens,
        system=_system(),
        messages=[{"role": "user", "content": user_text}],
        output_config={"effort": config.CLAUDE_EFFORT, "format": {"type": "json_schema", "schema": schema}},
    )
    if config.CLAUDE_FALLBACK:
        kwargs.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    try:
        with client().beta.messages.stream(**kwargs) as stream:
            msg = stream.get_final_message()
    except anthropic.AuthenticationError as e:
        raise AnalysisError("Claude-API: Anmeldung fehlgeschlagen – ist ANTHROPIC_API_KEY gesetzt?") from e
    except anthropic.RateLimitError as e:
        raise AnalysisError("Claude-API: Rate-Limit erreicht, bitte später erneut versuchen.") from e
    except anthropic.APIStatusError as e:
        raise AnalysisError(f"Claude-API-Fehler {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise AnalysisError("Claude-API nicht erreichbar.") from e

    if msg.stop_reason == "refusal":
        raise AnalysisError("Claude hat die Analyse dieses Inhalts abgelehnt.")
    if msg.stop_reason == "max_tokens":
        raise AnalysisError("Antwort zu lang – CHUNK_CHARS verkleinern.")
    text = "".join(b.text for b in msg.content if b.type == "text")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise AnalysisError("Claude hat kein gültiges JSON geliefert.") from e


# --------------------------------------------------------------------------- Ablauf

def _chunks(pages: list[dict]) -> list[list[dict]]:
    chunks, cur, size = [], [], 0
    for p in pages:
        n = len(p["text"]) + 40
        if cur and size + n > config.CHUNK_CHARS:
            chunks.append(cur)
            cur, size = [], 0
        cur.append(p)
        size += n
    if cur:
        chunks.append(cur)
    return chunks


def _clean_articles(articles: list[dict], page_count: int) -> list[dict]:
    out = []
    for i, a in enumerate(articles):
        s = min(max(int(a["start_page"]), 1), page_count)
        e = min(max(int(a["end_page"]), s), page_count)
        out.append({**a, "start_page": s, "end_page": e, "_orig": [i]})
    out.sort(key=lambda a: (a["start_page"], a["end_page"]))
    # Dubletten an Abschnittsgrenzen zusammenführen (gleicher Titel, überlappend).
    merged: list[dict] = []
    for a in out:
        prev = merged[-1] if merged else None
        if prev and prev["title"].strip().lower() == a["title"].strip().lower() and a["start_page"] <= prev["end_page"] + 1:
            prev["end_page"] = max(prev["end_page"], a["end_page"])
            prev["keywords"] = list(dict.fromkeys(prev["keywords"] + a["keywords"]))
            prev["_orig"] += a["_orig"]
            continue
        merged.append(a)
    return merged


def _clean_themes(themes: list[dict], n_articles: int) -> list[dict]:
    return [
        {**t, "article_indices": sorted({i for i in t["article_indices"] if 0 <= i < n_articles})}
        for t in themes
    ]


def analyze(doc: dict, progress=lambda msg: None) -> dict:
    pages = [p for p in doc["pages"]]
    total_chars = sum(len(p["text"]) for p in pages)
    if total_chars < 200:
        raise AnalysisError(
            "Im PDF wurde kaum Text gefunden (gescannte Bilder?). Bitte zuerst eine OCR durchführen."
        )
    meta = (
        f"Metadaten: Titel={doc.get('title') or 'unbekannt'}, Autor={doc.get('author') or 'unbekannt'}, "
        f"Seiten={doc['page_count']}\n\n"
    )
    chunks = _chunks(pages)

    if len(chunks) == 1:
        progress("Claude analysiert das Dokument …")
        res = _call(
            meta + _toc_block(doc["toc"]) +
            "Erkenne alle Artikel mit Seitenbereich, fasse jeden zusammen, erstelle eine "
            "Gesamtzusammenfassung, Kernaussagen und eine thematische Übersicht, die die "
            "Artikel (per Index in der Artikelliste) Themenblöcken zuordnet. Jeder Artikel "
            "soll mindestens einem Thema zugeordnet sein.\n\n" + _pages_block(pages),
            FULL_SCHEMA,
        )
        articles = _clean_articles(res["articles"], doc["page_count"])
        # Themen-Indizes beziehen sich auf die ursprüngliche Reihenfolge -> umrechnen.
        remap = {o: new for new, a in enumerate(articles) for o in a["_orig"]}
        for t in res["themes"]:
            t["article_indices"] = [remap[i] for i in t["article_indices"] if i in remap]
        res["articles"] = articles
    else:
        articles: list[dict] = []
        for i, chunk in enumerate(chunks, 1):
            progress(f"Claude erkennt Artikel – Abschnitt {i}/{len(chunks)} "
                     f"(Seiten {chunk[0]['index']}–{chunk[-1]['index']}) …")
            part = _call(
                meta + _toc_block([t for t in doc["toc"] if chunk[0]["index"] <= t["page"] <= chunk[-1]["index"]]) +
                f"Dies ist Abschnitt {i} von {len(chunks)} des Dokuments. Erkenne alle Artikel "
                "in diesem Abschnitt mit Seitenbereich und fasse jeden zusammen. Beginnt ein "
                "Artikel schon vor dem Abschnitt oder läuft darüber hinaus, gib den sichtbaren "
                "Teil mit seinem Titel an.\n\n" + _pages_block(chunk),
                ARTICLES_SCHEMA,
            )
            articles.extend(part["articles"])
        articles = _clean_articles(articles, doc["page_count"])
        res = {"articles": articles, **_synthesize(meta, articles, progress)}

    for a in res["articles"]:
        a.pop("_orig", None)
    res["themes"] = _clean_themes(res["themes"], len(res["articles"]))
    res["model"] = config.CLAUDE_MODEL
    return res


def _synthesize(meta: str, articles: list[dict], progress) -> dict:
    progress("Claude erstellt Gesamtzusammenfassung und Themenübersicht …")
    articles = [{k: v for k, v in a.items() if k != "_orig"} for a in articles]
    listing = "\n".join(
        f'[{i}] {a["title"]} (Seiten {a["start_page"]}–{a["end_page"]}): {a["summary"]} '
        f'Schlagworte: {", ".join(a["keywords"])}'
        for i, a in enumerate(articles)
    )
    return _call(
        meta + "Hier sind alle erkannten Artikel des Dokuments mit Index, Seitenbereich und "
        "Zusammenfassung. Erstelle daraus eine Gesamtzusammenfassung, Kernaussagen und eine "
        "thematische Übersicht, die die Artikel per Index Themenblöcken zuordnet. Jeder "
        "Artikel soll mindestens einem Thema zugeordnet sein.\n\n<artikel>\n" + listing + "\n</artikel>",
        SYNTHESIS_SCHEMA,
        max_tokens=32000,
    )
