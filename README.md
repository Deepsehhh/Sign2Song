# Sign2Song - gesture-controlled music game

Follow the translucent **shadow hand** over your webcam. Hold the pose for 500 ms and the song plays;
lose the pose and it pauses. Lyrics (from an `.lrc` file) follow `audio.currentTime`.

## Run on Windows (VS Code terminal)
```powershell
cd Sign2Song
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```
Open **http://127.0.0.1:5000** in Chrome/Edge and allow the camera. MediaPipe loads from the jsDelivr CDN
(same as the original project), so the first load needs internet. Use `http://127.0.0.1` or `localhost`,
never a `file://` path (browsers block the camera there).
If PowerShell blocks activation: `Set-ExecutionPolicy -Scope Process Bypass`.

## Project layout
```
app.py                  Flask: serves UI, discovers songs, stores gesture templates
templates/index.html    dashboard
static/style.css        dark theme
static/gesture_math.js  normalization + matching (unit-tested)
static/app.js           webcam, overlay, state machine, player, lyrics
songs/<song_id>/        one folder per song (audio + .lrc + optional cover + song.json)
data/gesture_templates.json   templates you capture in the app (created automatically)
tests/                  Node tests (math + browser-logic integration)
```

## Add a song (MP3 + LRC)
1. Create `songs/shape_of_you/` and copy in **your legally obtained** files, e.g. `shape_of_you.mp3`,
   `shape_of_you.lrc`, `cover.jpg`. Nothing copyrighted is bundled; the included *demo* song is original.
2. Optional `song.json` (without it, the first audio/.lrc/cover file in the folder is used, title from the folder name):
```json
{
  "title": "Shape of You",
  "artist": "Ed Sheeran",
  "audio": "shape_of_you.mp3",
  "lyrics": "shape_of_you.lrc",
  "cover": "cover.jpg",
  "gestures": [
    { "start": 0,  "gesture": "Open Palm" },
    { "start": 20, "gesture": "Peace" },
    { "start": 41, "gesture": "Fist" },
    { "start": 63, "gesture": "Rock" }
  ]
}
```
`gestures` = the gesture sequence; each entry is active from `start` (seconds) until the next entry.
Without it, gestures cycle through Open Palm, Peace, Fist, Rock every `segment_seconds` (default 8).
Gesture names must match a template name (see below); unknown names are skipped with a warning.
3. Reload the page - the song appears. Missing audio/lyrics show a warning instead of crashing.

## LRC format
```
[offset:0]
[00:12.50]First line
[00:17.00]Second line
[01:02.30][02:10.00]Repeated chorus line
```
Standard `[mm:ss.xx]` timestamps; `[offset:ms]` is honoured (positive = lyrics earlier).

## Gesture templates
* The 4 labels of the original project (**Open Palm, Fist, Peace, Rock**) ship with *starter* templates built
  from hand geometry. They are a fallback, not your dataset.
* For the best accuracy record real ones: open **Template studio** (right panel), make the pose, choose the
  gesture, press **Capture**. It averages 20 frames, saves to `data/gesture_templates.json` and uses it immediately.
  Captured templates override the starters; **Reset to default** removes them.
* A new name in the "or new name" box creates an extra gesture you can use in `song.json`.

## How matching works
Landmarks -> pixel space -> wrist to origin, scaled by wrist-to-middle-knuckle length, rotated upright
(removes position, distance, size, tilt). Score = 50 % finger-extension ratios + 15 % joint angles +
35 % landmark distances, 0-100 %. The pose is also tested mirrored and the best is kept (left/right hand
and mirror-safe). Starting needs score >= threshold (85 %) held for 500 ms; once playing, it only pauses
after the score stays below threshold-8 for 600 ms (hysteresis, so no flicker). The first 1.5 s after a
gesture change-over never pauses. All four values are sliders under **Settings**.

## Test checklist
**Webcam / tracking** - permission prompt appears; denying shows a clear message; skeleton sticks to your hand with no lag.
**Overlay alignment** - raise your right hand: it appears on the right of the mirrored preview; ghost and your skeleton are drawn on the same canvas (they cannot drift); resize the window and they stay aligned.
**Accuracy** - copy the ghost: % climbs above the white threshold tick and the frame turns green; a different pose turns it red and < 70 %; move closer/farther, tilt, use the other hand: still matches.
**500 ms hold** - the bottom bar fills; briefly touching the pose does not start the song.
**Audio** - starts on match; pauses ~0.6 s after a wrong pose or hand loss; resumes at the same second (watch the timer).
**Lyrics** - highlighted line changes at the LRC time, auto-scrolls, freezes while paused, jumps correctly when you click the progress bar.
**Sequence** - at each `start` time the target and "NEXT" preview change; wrong gesture pauses the song.
**Errors** - rename the MP3: the card shows "no audio"; delete the .lrc: "No lyrics file"; unplug the camera: message shown.

Automated checks (optional): `node tests/test_gesture_math.js`; the browser-logic test needs `npm i jsdom`
and the rendered page - see header of `tests/test_state_machine.js`.

## Removed from the original single-file app
Inline HTML string, hardcoded lyric timelines, WebAudio oscillator "chords" and the date-based lyric ticker
(replaced by real audio + `currentTime`), and the thumb-x-direction rule classifier (replaced by template matching).
Keep your original `app.py` as a backup before overwriting.
