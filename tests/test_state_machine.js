// Integration test: runs the REAL static/app.js in jsdom with a fake webcam (MediaPipe stub) and fake audio.
// Usage: node tests/test_state_machine.js <index.html> <songs.json>   (jsdom must be installed)
const fs = require('fs'), path = require('path');
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');
const [htmlPath, songsPath] = process.argv.slice(2);
const html = fs.readFileSync(htmlPath, 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const songs = JSON.parse(fs.readFileSync(songsPath, 'utf8'));
const lrc = fs.readFileSync(path.join(__dirname, '../songs/demo/demo.lrc'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:5000/' });
const w = dom.window;
const noop = () => {}; const ctxStub = new Proxy({}, { get: (t, k) => k === 'canvas' ? {} : noop, set: () => true });
w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
w.Element.prototype.scrollTo = noop;
w.fetch = async (url) => { const ok = (b) => ({ ok: true, json: async () => b, text: async () => b });
  if (url === '/api/songs') return ok(songs); if (url === '/api/templates') return ok({ gestures: {} });
  if (url.endsWith('.lrc')) return ok(lrc); throw new Error('unexpected fetch ' + url); };
// fake audio: currentTime advances in real time only while playing
let audio; w.Audio = class { constructor() { audio = this; this.currentTime = 0; this.paused = true; this.duration = 48; this._l = {}; this._last = 0; this.plays = 0; this.pauses = 0; }
  addEventListener(e, f) { this._l[e] = f; } play() { this.paused = false; this.plays++; this._last = Date.now(); return Promise.resolve(); } pause() { this.paused = true; this.pauses++; }
  tick() { if (!this.paused) { const n = Date.now(); this.currentTime += (n - this._last) / 1000; this._last = n; } } };
setInterval(() => audio && audio.tick(), 20);
Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: async () => ({}) } });
let onResults; w.Hands = class { setOptions() {} onResults(f) { onResults = f; } send() {} };
w.Camera = class { constructor(v) { Object.defineProperty(v, 'videoWidth', { value: 1280 }); Object.defineProperty(v, 'videoHeight', { value: 720 }); } start() { return Promise.resolve(); } };
w.eval(fs.readFileSync(path.join(__dirname, '../static/gesture_math.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8'));
const GM = w.GestureMath, T = GM.defaultTemplates();
const lmFor = (g) => T[g].landmarks.map(([x, y]) => ({ x: (x * 130 + 640) / 1280, y: (y * 130 + 560) / 720 }));
let cur = null; const feeder = setInterval(() => { try { if (onResults) onResults({ image: {}, multiHandLandmarks: cur ? [cur] : [] }); } catch (e) { if (!feeder.warned) { feeder.warned = 1; console.log('onResults threw:', e.message); } } }, 33);
const sleep = ms => new Promise(r => setTimeout(r, ms)); const $ = id => w.document.getElementById(id);
let fail = 0; const check = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) fail++; };
(async () => {
  await sleep(100);
  check(w.document.querySelectorAll('.song').length === 1, 'song list rendered from /api/songs');
  w.document.querySelector('.song').click(); $('launch-btn').click(); await sleep(300);
  check(!$('app').hidden, 'app opened'); check(w.document.querySelectorAll('.ly').length === 12, '12 lyric lines parsed from LRC');
  check($('g-current').textContent === 'Open Palm', 'first target = Open Palm');
  check(audio.paused && audio.plays === 0, 'audio NOT playing before a match');
  cur = lmFor('Fist'); await sleep(900); check(audio.plays === 0, 'wrong gesture (Fist) does not start audio');
  cur = lmFor('Open Palm'); await sleep(300); check(audio.plays === 0, 'matching <500ms does not start audio yet');
  await sleep(500); check(audio.plays === 1 && !audio.paused, 'matched >=500ms -> audio plays');
  check($('badge-play').textContent === 'PLAYING', 'badge shows PLAYING');
  await sleep(1500); const lyricA = w.document.querySelector('.ly.active');
  check(lyricA && lyricA.textContent.startsWith('Raise an open palm'), 'lyric 1 highlighted at t~1.5s');
  // flicker tolerance: 300ms hand dropout < grace must NOT pause
  cur = null; await sleep(250); cur = lmFor('Open Palm'); await sleep(200); check(audio.pauses === 0, 'brief dropout (250ms) does not pause');
  // wrong gesture beyond grace -> pause, time and lyric freeze
  cur = lmFor('Fist'); await sleep(1300); check(audio.paused && audio.pauses === 1, 'wrong gesture beyond grace -> paused');
  check($('badge-play').textContent === 'PAUSED', 'badge shows PAUSED');
  const tFrozen = audio.currentTime, idx = $('lyrics').querySelector('.ly.active').textContent; await sleep(1000);
  check(audio.currentTime === tFrozen, 'currentTime frozen while paused'); check($('lyrics').querySelector('.ly.active').textContent === idx, 'lyric frozen while paused');
  // resume from exact paused time
  cur = lmFor('Open Palm'); await sleep(900); check(!audio.paused, 'correct gesture again -> resumed');
  check(audio.currentTime >= tFrozen && audio.currentTime - tFrozen < 0.6, `resumed from paused timestamp (${tFrozen.toFixed(2)} -> ${audio.currentTime.toFixed(2)})`);
  // hand disappears -> pause
  cur = null; await sleep(1200); check(audio.paused, 'hand lost beyond grace -> paused');
  // segment change: seek to 12.5s, target should switch to Peace, lyric to "Now show a peace sign"
  audio.currentTime = 12.5; await sleep(200);
  check($('g-current').textContent === 'Peace', 'target gesture follows currentTime -> Peace at 12.5s');
  check($('g-next').textContent === 'Fist', 'next preview = Fist'); check($('lyrics').querySelector('.ly.active').textContent === 'Now show a peace sign', 'lyric follows currentTime on seek');
  cur = lmFor('Open Palm'); await sleep(800); check(audio.paused, 'old gesture does not match new target');
  cur = lmFor('Peace'); await sleep(800); check(!audio.paused, 'new gesture Peace -> plays');
  // practice mode never touches audio
  $('btn-practice').click(); await sleep(150); check(audio.paused, 'entering practice pauses audio'); const p0 = audio.plays;
  cur = lmFor(Object.keys(T)[0]); await sleep(900); check(audio.plays === p0, 'practice-mode match does not start audio'); check($('badge-play').textContent === 'PRACTICE', 'PRACTICE badge');
  clearInterval(feeder); console.log(fail ? `\n${fail} FAILED` : '\nAll state-machine checks passed'); process.exit(fail ? 1 : 0);
})();
