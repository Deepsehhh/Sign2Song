"""Sign2Song - gesture-controlled music game (Flask backend).

The backend only serves the UI, discovers songs in ./songs and stores gesture
templates in ./data. All gesture recognition runs in the browser with
MediaPipe Hands (static/gesture_math.js + static/app.js).
"""
import json
import math
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
SONGS_DIR = BASE_DIR / "songs"
DATA_DIR = BASE_DIR / "data"
TEMPLATES_FILE = DATA_DIR / "gesture_templates.json"

AUDIO_EXT = {".mp3", ".wav", ".ogg", ".m4a", ".flac"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False


# --------------------------------------------------------------------------- #
# Song discovery
# --------------------------------------------------------------------------- #
def _first(folder: Path, exts, prefer=None):
    files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in exts)
    if prefer:
        for p in files:
            if p.stem.lower().startswith(prefer):
                return p
    return files[0] if files else None


def _file_url(song_id: str, name: str | None):
    return f"/songs/{song_id}/{name}" if name else None


def load_song(folder: Path):
    song_id = folder.name
    meta = {}
    meta_path = folder / "song.json"
    warnings = []
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            warnings.append(f"song.json is invalid: {exc}")

    def resolve(key, exts, prefer=None):
        name = meta.get(key)
        if name:
            if (folder / name).is_file():
                return name
            warnings.append(f"{key} file '{name}' not found in songs/{song_id}")
            return None
        found = _first(folder, exts, prefer)
        return found.name if found else None

    audio = resolve("audio", AUDIO_EXT)
    lyrics = resolve("lyrics", {".lrc"})
    cover = resolve("cover", IMAGE_EXT, prefer="cover")
    if not audio:
        warnings.append("No audio file found (put an .mp3/.wav/.ogg in this folder).")
    if not lyrics:
        warnings.append("No .lrc lyrics file found - the song will play without lyrics.")

    return {
        "id": song_id,
        "title": meta.get("title") or song_id.replace("_", " ").title(),
        "artist": meta.get("artist", ""),
        "audio_url": _file_url(song_id, audio),
        "lyrics_url": _file_url(song_id, lyrics),
        "cover_url": _file_url(song_id, cover),
        "gestures": meta.get("gestures"),            # explicit time segments (optional)
        "segment_seconds": meta.get("segment_seconds", 8),
        "auto_gestures": meta.get("auto_gestures"),  # order used when no explicit segments
        "warnings": warnings,
    }


@app.get("/api/songs")
def api_songs():
    songs = []
    if SONGS_DIR.is_dir():
        for folder in sorted(SONGS_DIR.iterdir()):
            if folder.is_dir():
                songs.append(load_song(folder))
    return jsonify({"songs": songs})


@app.get("/songs/<song_id>/<path:filename>")
def song_file(song_id, filename):
    # send_from_directory blocks path traversal and supports HTTP Range (seeking).
    return send_from_directory(SONGS_DIR, f"{song_id}/{filename}", conditional=True)


# --------------------------------------------------------------------------- #
# Gesture templates (captured from the user's own hand in the browser)
# --------------------------------------------------------------------------- #
def _read_templates():
    if not TEMPLATES_FILE.exists():
        return {}
    try:
        data = json.loads(TEMPLATES_FILE.read_text(encoding="utf-8"))
        return data.get("gestures", {}) if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_templates(gestures):
    DATA_DIR.mkdir(exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"gestures": gestures}, fh, indent=1)
    os.replace(tmp, TEMPLATES_FILE)  # atomic on Windows and POSIX


def _valid_landmarks(lm):
    return (
        isinstance(lm, list) and len(lm) == 21
        and all(isinstance(p, list) and len(p) >= 2
                and all(isinstance(v, (int, float)) and math.isfinite(v) for v in p[:2])
                for p in lm)
    )


_NAME_RE = re.compile(r"^[\w \-]{1,40}$")


@app.get("/api/templates")
def api_templates_get():
    return jsonify({"gestures": _read_templates()})


@app.post("/api/templates/<name>")
def api_templates_post(name):
    if not _NAME_RE.match(name):
        return jsonify({"error": "Invalid gesture name"}), 400
    body = request.get_json(silent=True) or {}
    lm = body.get("landmarks")
    if not _valid_landmarks(lm):
        return jsonify({"error": "landmarks must be 21 [x, y] pairs"}), 400
    entry = {
        "landmarks": [[float(p[0]), float(p[1])] for p in lm],
        "source": "captured",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    weights = body.get("weights")
    if isinstance(weights, list) and len(weights) == 5 and all(isinstance(w, (int, float)) for w in weights):
        entry["weights"] = [float(w) for w in weights]
    gestures = _read_templates()
    gestures[name] = entry
    _write_templates(gestures)
    return jsonify({"ok": True, "name": name})


@app.delete("/api/templates/<name>")
def api_templates_delete(name):
    gestures = _read_templates()
    if name in gestures:
        del gestures[name]
        _write_templates(gestures)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return render_template("index.html")


if __name__ == "__main__":
    SONGS_DIR.mkdir(exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)
    app.run(host="127.0.0.1", port=5000, debug=True)
