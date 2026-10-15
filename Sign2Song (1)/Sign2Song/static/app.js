/* Sign2Song - gesture-controlled music game (frontend).
 * SINGLE SOURCE OF TRUTH: audio.currentTime. Lyrics, target gesture and progress are all
 * derived from it every animation frame. Only Player.set() ever calls audio.play()/pause(),
 * and only the match state machine in frame() calls Player.set().
 */
(() => {
  'use strict';
  const GM = window.GestureMath;
  const $ = id => document.getElementById(id);
  const STD_ORDER = ['Open Palm', 'Peace', 'Fist', 'Rock'];   // gesture labels of the original project

  // ---------------- config (persisted) ----------------
  const CFG_KEY = 'sign2song.cfg';
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) {}
  const CFG = Object.assign({ threshold: 85, holdMs: 500, graceMs: 600, segmentGraceMs: 1500, hysteresis: 8 }, saved);
  const saveCfg = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } catch (e) {} };

  // ---------------- state ----------------
  const S = { songs: [], song: null, templates: {}, audio: null, lyrics: [], segments: null, autoOrder: [],
    mode: 'play', practiceIdx: 0, target: null, lastKey: null, segChangedAt: 0,
    ema: 0, handSeenAt: 0, holdStart: null, hold: 0, badSince: null, started: false, ended: false,
    matchState: 'idle', activeLyric: -1, running: false, capture: null, camOK: false };

  function toast(msg, ms = 3500) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }
  const fmt = s => !isFinite(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---------------- song list ----------------
  async function loadSongs() {
    const grid = $('song-grid');
    try {
      const r = await fetch('/api/songs'); S.songs = (await r.json()).songs;
    } catch (e) { grid.innerHTML = '<p class="error">Could not reach the Flask server.</p>'; return; }
    renderSongs('');
  }
  function renderSongs(q) {
    const grid = $('song-grid'); grid.innerHTML = '';
    const list = S.songs.filter(s => (s.title + ' ' + s.artist).toLowerCase().includes(q));
    if (!list.length) { grid.innerHTML = '<p class="muted">No songs found. Add a folder with an MP3 to <code>songs/</code>.</p>'; return; }
    list.forEach(s => {
      const d = document.createElement('div');
      d.className = 'song' + (s.audio_url ? '' : ' off') + (S.song && S.song.id === s.id ? ' sel' : '');
      const th = document.createElement('div'); th.className = 'thumb';
      if (s.cover_url) th.style.backgroundImage = `url("${s.cover_url}")`; else th.textContent = '\u266B';
      const m = document.createElement('div');
      const h = document.createElement('h3'); h.textContent = s.title;
      const p = document.createElement('p'); p.textContent = s.artist || '';
      m.append(h, p);
      if (s.warnings.length) { const w = document.createElement('p'); w.className = 'warn'; w.textContent = '\u26A0 ' + s.warnings[0]; m.append(w); }
      d.append(th, m);
      d.onclick = () => { if (!s.audio_url) { toast('This song has no audio file yet.'); return; } S.song = s; $('launch-btn').disabled = false; $('launch-btn').textContent = 'Play "' + s.title + '"'; renderSongs($('search').value.toLowerCase()); };
      grid.append(d);
    });
  }

  // ---------------- LRC ----------------
  function parseLRC(text) {
    const out = []; let offset = 0;
    for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      const meta = line.match(/^\[offset:\s*(-?\d+)\s*\]$/i);
      if (meta) { offset = parseInt(meta[1], 10) / 1000; continue; }
      const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
      if (!stamps.length) continue;
      const txt = line.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of stamps) {
        const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
        out.push({ t: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac, text: txt });
      }
    }
    out.forEach(l => { l.t = Math.max(0, l.t - offset); });   // LRC: positive offset = lyrics earlier
    return out.sort((a, b) => a.t - b.t);
  }
  function renderLyrics() {
    const box = $('lyrics'); box.innerHTML = ''; S.activeLyric = -1;
    if (!S.lyrics.length) { const d = document.createElement('div'); d.className = 'ly none'; d.textContent = 'No lyrics file (.lrc) for this song.'; box.append(d); return; }
    S.lyrics.forEach(l => { const d = document.createElement('div'); d.className = 'ly'; d.textContent = l.text || '\u266A'; box.append(d); });
  }
  function updateLyrics(t) {
    if (!S.lyrics.length) return;
    let lo = 0, hi = S.lyrics.length - 1, idx = -1;           // binary search: last line with time <= t
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (S.lyrics[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx === S.activeLyric) return;
    const nodes = $('lyrics').children; S.activeLyric = idx;
    for (let i = 0; i < nodes.length; i++) nodes[i].className = 'ly' + (i === idx ? ' active' : i < idx ? ' past' : '');
    if (idx >= 0) { const box = $('lyrics'), el = nodes[idx];
      box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' }); }
    else $('lyrics').scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------------- gesture timeline ----------------
  function buildTimeline(song) {
    const have = n => !!S.templates[n]; const warn = [];
    S.autoOrder = (Array.isArray(song.auto_gestures) ? song.auto_gestures : STD_ORDER).filter(have);
    if (Array.isArray(song.gestures) && song.gestures.length) {
      const segs = song.gestures.filter(g => { if (have(g.gesture) && isFinite(g.start)) return true; warn.push(`Gesture "${g.gesture}" has no template - segment skipped.`); return false; })
        .map(g => ({ start: +g.start, gesture: g.gesture })).sort((a, b) => a.start - b.start);
      if (segs.length) { segs[0].start = 0; S.segments = segs; }
    }
    if (!S.segments && !S.autoOrder.length) warn.push('No gesture templates available.');
    warn.forEach(w => toast(w, 6000));
  }
  function targetAt(t) {
    if (S.segments) {
      let i = 0; while (i + 1 < S.segments.length && S.segments[i + 1].start <= t) i++;
      const s = S.segments[i], n = S.segments[i + 1];
      return { gesture: s.gesture, start: s.start, end: n ? n.start : Infinity };
    }
    const len = Math.max(2, +S.song.segment_seconds || 8), i = Math.floor(t / len);
    return { gesture: S.autoOrder[i % S.autoOrder.length], start: i * len, end: (i + 1) * len };
  }
  function nextTarget(cur) {
    if (!isFinite(cur.end)) return null;
    const d = S.audio.duration; if (isFinite(d) && cur.end >= d - 0.05) return null;
    return targetAt(cur.end + 0.001);
  }

  // ---------------- playback (single authority) ----------------
  const Player = {
    desired: false,
    set(want) {
      const a = S.audio; if (!a) return; this.desired = want;
      if (want) { if (a.paused) { const p = a.play(); if (p && p.catch) p.catch(e => { this.desired = false; toast('Audio could not start: ' + e.message); }); S.started = true; } }
      else if (!a.paused) a.pause();
    }
  };

  // ---------------- drawing ----------------
  const view = $('view'), ctx = view.getContext('2d'), nctx = $('next-canvas').getContext('2d');
  function skeleton(c, pts, o) {
    c.save(); c.lineCap = 'round'; c.lineJoin = 'round'; c.globalAlpha = o.alpha;
    if (o.fill) { c.fillStyle = o.fill; c.beginPath(); [0, 1, 5, 9, 13, 17].forEach((i, k) => k ? c.lineTo(...pts[i]) : c.moveTo(...pts[i])); c.closePath(); c.fill(); }
    if (o.fat) { c.strokeStyle = o.color; c.lineWidth = o.fat; c.globalAlpha = o.alpha * 0.45;
      Object.values(GM.CHAINS).forEach(ch => { c.beginPath(); ch.forEach((i, k) => k ? c.lineTo(...pts[i]) : c.moveTo(...pts[i])); c.stroke(); }); c.globalAlpha = o.alpha; }
    c.strokeStyle = o.color; c.lineWidth = o.line;
    GM.CONNECTIONS.forEach(([a, b]) => { c.beginPath(); c.moveTo(...pts[a]); c.lineTo(...pts[b]); c.stroke(); });
    c.fillStyle = o.dot; pts.forEach(p => { c.beginPath(); c.arc(p[0], p[1], o.r, 0, 6.2832); c.fill(); });
    c.restore();
  }
  function drawGhost(c, W, H, tmpl, color, alpha) {
    const s = H * 0.30, ox = W / 2, oy = H * 0.78;
    const pts = tmpl.landmarks.map(p => [ox + p[0] * s, oy + p[1] * s]);
    skeleton(c, pts, { color, alpha, fill: color, fat: s * 0.16, line: Math.max(2, s * 0.02), dot: '#fff', r: Math.max(3, s * 0.03) });
  }
  const COL = { good: '#22e58b', bad: '#ff4d5e', idle: '#7aa2ff' };
  function drawNext(tmpl) {
    const c = nctx; c.clearRect(0, 0, 120, 120); if (!tmpl) return;
    const pts = tmpl.landmarks.map(p => [60 + p[0] * 36, 108 + p[1] * 36]);
    skeleton(c, pts, { color: '#9db4ff', alpha: 0.9, fill: '#9db4ff22', line: 2, dot: '#fff', r: 2 });
  }

  // ---------------- MediaPipe results ----------------
  function onResults(res) {
    const v = $('webcam'), W = v.videoWidth || 1280, H = v.videoHeight || 720, now = performance.now();
    if (view.width !== W || view.height !== H) { view.width = W; view.height = H; }
    ctx.drawImage(res.image, 0, 0, W, H);
    const tgt = S.target, tmpl = tgt && S.templates[tgt.gesture];
    if (tmpl) drawGhost(ctx, W, H, tmpl, COL[S.matchState], S.matchState === 'idle' ? 0.5 : 0.65);

    let best = null;
    (res.multiHandLandmarks || []).forEach(lm => {
      const n = GM.normalize(lm, W, H);
      const sc = tmpl ? GM.bestScore(n, tmpl) : 0;
      if (!best || sc > best.score) best = { score: sc, lm, n };
    });
    (res.multiHandLandmarks || []).forEach(lm => {
      const isBest = best && best.lm === lm;
      skeleton(ctx, lm.map(l => [l.x * W, l.y * H]), { color: isBest ? '#ffffff' : '#9aa4c7', alpha: isBest ? 0.95 : 0.5, line: 4, dot: isBest ? COL[S.matchState] : '#aab', r: 5 });
    });
    if (best) {
      S.handSeenAt = now; S.ema += 0.4 * (best.score - S.ema);   // light smoothing against flicker
      if (S.capture) captureFrame(best.n);
    }
  }

  // ---------------- template studio ----------------
  async function loadTemplates() {
    S.templates = GM.defaultTemplates();
    try { const r = await fetch('/api/templates'); const g = (await r.json()).gestures || {};
      Object.entries(g).forEach(([k, v]) => { if (v && v.landmarks && v.landmarks.length === 21) S.templates[k] = v; });
    } catch (e) { toast('Could not load saved templates; using defaults.'); }
    const sel = $('cap-name'); sel.innerHTML = '';
    Object.keys(S.templates).forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = `${k} (${S.templates[k].source === 'captured' ? 'captured' : 'default'})`; sel.append(o); });
  }
  function startCapture() {
    const name = ($('cap-custom').value.trim() || $('cap-name').value);
    if (!/^[\w \-]{1,40}$/.test(name)) { $('cap-status').textContent = 'Use letters, numbers, spaces, - or _ (max 40).'; return; }
    S.capture = { name, frames: [], need: 20, t0: performance.now() };
    $('cap-status').textContent = 'Hold the pose still...';
  }
  function captureFrame(n) {
    const c = S.capture; c.frames.push(n);
    if (c.frames.length < c.need) return;
    S.capture = null;
    const avg = c.frames[0].map((_, i) => [c.frames.reduce((a, f) => a + f[i][0], 0) / c.frames.length, c.frames.reduce((a, f) => a + f[i][1], 0) / c.frames.length]);
    const def = GM.defaultTemplates()[c.name];
    fetch('/api/templates/' + encodeURIComponent(c.name), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ landmarks: avg, weights: def && def.weights }) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('server rejected template')))
      .then(async () => { await loadTemplates(); S.lastKey = null; $('cap-status').textContent = `Saved "${c.name}".`; toast(`Template "${c.name}" saved`); })
      .catch(e => { $('cap-status').textContent = 'Save failed: ' + e.message; });
  }
  setInterval(() => { if (S.capture && performance.now() - S.capture.t0 > 6000) { S.capture = null; $('cap-status').textContent = 'No hand seen - try again.'; } }, 500);

  // ---------------- main loop ----------------
  function frame(now) {
    requestAnimationFrame(frame);
    if (!S.running) return;
    const a = S.audio, t = a.currentTime;

    // target gesture (derived from audio.currentTime, or chosen manually in practice mode)
    let tgt;
    if (S.mode === 'practice') {
      const names = Object.keys(S.templates); tgt = { gesture: names[S.practiceIdx % names.length], start: 0, end: Infinity };
    } else if (S.segments || S.autoOrder.length) tgt = targetAt(t);
    else tgt = null;
    const key = tgt ? tgt.gesture + '@' + tgt.start : null;
    if (key !== S.lastKey) {
      S.lastKey = key; S.target = tgt; S.segChangedAt = now; S.ema = 0; S.hold = 0; S.holdStart = null;
      const nx = tgt && S.mode === 'play' ? nextTarget(tgt) : null;
      $('g-current').textContent = tgt ? tgt.gesture : 'No gestures';
      $('g-next').textContent = S.mode === 'practice' ? 'free practice' : nx ? nx.gesture : 'final gesture';
      drawNext(nx ? S.templates[nx.gesture] : null);
    }
    $('g-time').textContent = tgt && S.mode === 'play' && isFinite(tgt.end) ? `${fmt(tgt.start)} \u2013 ${fmt(tgt.end)}` : '';

    // match evaluation
    const tmpl = tgt && S.templates[tgt.gesture];
    const handPresent = (now - S.handSeenAt) < 300;
    if (!handPresent) S.ema = 0;
    const score = handPresent ? S.ema : 0;
    const thr = CFG.threshold - (Player.desired ? CFG.hysteresis : 0);   // hysteresis: harder to start than to keep
    const good = !!tmpl && handPresent && score >= thr;
    S.matchState = !handPresent ? 'idle' : good ? 'good' : 'bad';

    if (S.mode === 'practice') {
      if (good) { if (S.holdStart == null) S.holdStart = now; S.hold = Math.min(1, (now - S.holdStart) / CFG.holdMs); } else { S.holdStart = null; S.hold = 0; }
    } else if (S.ended) { S.hold = 0; }
    else if (!Player.desired) {                       // waiting for a stable match to start/resume
      if (good) { if (S.holdStart == null) S.holdStart = now; S.hold = Math.min(1, (now - S.holdStart) / CFG.holdMs);
        if (S.hold >= 1) { Player.set(true); S.holdStart = null; S.badSince = null; S.hold = 0; } }
      else { S.holdStart = null; S.hold = 0; }
    } else {                                          // playing: pause if lost for longer than the grace period
      S.hold = 0;
      if (good || now - S.segChangedAt < CFG.segmentGraceMs) S.badSince = null;
      else { if (S.badSince == null) S.badSince = now; if (now - S.badSince >= CFG.graceMs) { Player.set(false); S.badSince = null; } }
    }

    // HUD
    const pct = Math.round(score);
    $('acc-value').textContent = pct + '%';
    const fill = $('acc-fill'); fill.style.width = pct + '%'; fill.style.background = good ? COL.good : handPresent ? COL.bad : '#4b5578';
    $('acc-thr').style.left = CFG.threshold + '%';
    $('stage').className = 'stage ' + S.matchState;
    $('hold-fill').style.width = (S.hold * 100) + '%';
    const playing = !a.paused;
    let bp = 'READY', cls = 'badge';
    if (S.mode === 'practice') { bp = 'PRACTICE'; cls += ' practice'; }
    else if (S.ended) bp = 'FINISHED';
    else if (playing) { bp = 'PLAYING'; cls += ' playing'; }
    else if (S.started) { bp = 'PAUSED'; cls += ' paused'; }
    $('badge-play').textContent = bp; $('badge-play').className = cls;
    let bm;
    if (S.ended && S.mode === 'play') bm = 'SONG COMPLETE';
    else if (!handPresent) bm = S.camOK ? 'SHOW YOUR HAND' : 'CAMERA OFF';
    else if (S.mode === 'practice') bm = good ? (S.hold >= 1 ? 'MATCHED \u2713' : 'HOLD IT...') : 'MATCH GESTURE';
    else if (playing) bm = good ? 'MATCHED \u2713' : 'KEEP MATCHING!';
    else bm = good ? 'HOLD IT...' : 'MATCH GESTURE';
    $('badge-match').textContent = bm;

    // progress + lyrics, always from audio.currentTime
    const d = a.duration;
    $('progress-fill').style.width = (isFinite(d) && d > 0 ? t / d * 100 : 0) + '%';
    $('t-cur').textContent = fmt(t); $('t-dur').textContent = fmt(d);
    updateLyrics(t);
  }

  // ---------------- camera ----------------
  async function startCamera() {
    const msg = $('cam-msg'); const fail = m => { msg.textContent = m; msg.classList.remove('hide'); S.camOK = false; };
    if (typeof Hands === 'undefined' || typeof Camera === 'undefined') return fail('MediaPipe scripts did not load.\nCheck your internet connection (they load from cdn.jsdelivr.net) and reload.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return fail('Camera API unavailable. Open the app at http://127.0.0.1:5000 (not a file:// path).');
    try {
      const hands = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
      hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
      hands.onResults(onResults);
      const cam = new Camera($('webcam'), { onFrame: async () => { await hands.send({ image: $('webcam') }); }, width: 1280, height: 720 });
      await cam.start(); S.camOK = true; msg.classList.add('hide');
    } catch (e) {
      const n = e && e.name;
      fail(n === 'NotAllowedError' ? 'Camera permission was denied.\nAllow camera access in the browser address bar, then reload.'
        : n === 'NotFoundError' ? 'No camera found. Plug one in and reload.'
        : n === 'NotReadableError' ? 'The camera is in use by another app. Close it and reload.'
        : 'Could not start the camera: ' + (e && e.message || e));
    }
  }

  // ---------------- launch ----------------
  async function launch() {
    const song = S.song; if (!song) return;
    $('launch-btn').disabled = true; $('launch-error').textContent = '';
    await loadTemplates();
    const audio = new Audio(); audio.preload = 'auto'; audio.src = song.audio_url;
    audio.addEventListener('error', () => { toast('The audio file could not be loaded: ' + song.audio_url, 8000); });
    audio.addEventListener('ended', () => { S.ended = true; Player.desired = false; });
    audio.addEventListener('seeked', () => { if (audio.currentTime < audio.duration - 0.1) S.ended = false; });
    S.audio = audio; S.segments = null;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gainNode = ctx.createGain();
    gainNode.gain.value = 3;   // 3 = about 3x louder, change as needed
    ctx.createMediaElementSource(audio).connect(gainNode).connect(ctx.destination);
    audio.addEventListener('play', () => ctx.resume());
    S.lyrics = [];
    if (song.lyrics_url) { try { const r = await fetch(song.lyrics_url); if (!r.ok) throw 0; S.lyrics = parseLRC(await r.text());
      if (!S.lyrics.length) toast('Lyrics file has no timestamps ([mm:ss.xx] lines).'); } catch (e) { toast('Could not load lyrics file.'); } }
    renderLyrics(); buildTimeline(song);
    $('top-title').textContent = song.title + (song.artist ? ' \u2013 ' + song.artist : '');
    $('np-title').textContent = song.title; $('np-artist').textContent = song.artist || '';
    $('cover').style.backgroundImage = song.cover_url ? `url("${song.cover_url}")` : '';
    $('launcher').hidden = true; $('app').hidden = false;
    S.running = true; startCamera();
  }

  function resetSong() { Player.set(false); if (S.audio) S.audio.currentTime = 0; S.started = false; S.ended = false; S.activeLyric = -1; S.lastKey = null; $('lyrics').scrollTo({ top: 0 }); }

  function bindUI() {
    $('search').oninput = e => renderSongs(e.target.value.toLowerCase());
    $('launch-btn').onclick = launch;
    $('btn-restart').onclick = resetSong;
    $('btn-back').onclick = () => location.reload();
    $('btn-practice').onclick = () => {
      S.mode = S.mode === 'play' ? 'practice' : 'play'; Player.set(false);
      $('btn-practice').textContent = 'Practice: ' + (S.mode === 'practice' ? 'on' : 'off');
      ['btn-prev', 'btn-nextg'].forEach(id => $(id).hidden = S.mode !== 'practice'); S.lastKey = null;
    };
    const step = d => { const n = Object.keys(S.templates).length; S.practiceIdx = (S.practiceIdx + d + n) % n; };
    $('btn-prev').onclick = () => step(-1); $('btn-nextg').onclick = () => step(1);
    $('progress').onclick = e => { const d = S.audio && S.audio.duration; if (!isFinite(d)) return;
      const r = e.currentTarget.getBoundingClientRect(); S.audio.currentTime = Math.max(0, Math.min(d, (e.clientX - r.left) / r.width * d)); };
    const sl = (id, vid, key) => { const el = $(id); el.value = CFG[key]; $(vid).textContent = CFG[key];
      el.oninput = () => { CFG[key] = +el.value; $(vid).textContent = el.value; saveCfg(); }; };
    sl('s-thr', 'v-thr', 'threshold'); sl('s-hold', 'v-hold', 'holdMs'); sl('s-grace', 'v-grace', 'graceMs'); sl('s-seg', 'v-seg', 'segmentGraceMs');
    $('cap-btn').onclick = startCapture;
    $('cap-reset').onclick = async () => { const n = $('cap-custom').value.trim() || $('cap-name').value;
      await fetch('/api/templates/' + encodeURIComponent(n), { method: 'DELETE' }); await loadTemplates(); S.lastKey = null; $('cap-status').textContent = `"${n}" reset.`; };
    document.addEventListener('visibilitychange', () => { if (document.hidden && S.mode === 'play') Player.set(false); });
  }

  bindUI(); loadSongs(); requestAnimationFrame(frame);
})();
