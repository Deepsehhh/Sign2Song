const GM = require('../static/gesture_math.js');
const T = GM.defaultTemplates(); const names = Object.keys(T);
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
// Simulate a webcam hand: rotate, scale, translate, jitter, optional mirror, 1280x720 aspect
function simulate(n, {noise = .05, rot = 0, scale = 1, flip = false}) {
  const W = 1280, H = 720, c = Math.cos(rot), s = Math.sin(rot);
  return n.map(([x, y]) => { if (flip) x = -x; x += gauss() * noise; y += gauss() * noise;
    const px = (x * c - y * s) * scale * 150 + 700, py = (x * s + y * c) * scale * 150 + 500;
    return { x: px / W, y: py / H }; });
}
const test = (g, opts) => GM.bestScore(GM.normalize(simulate(T[g].landmarks, opts), 1280, 720), T[names.includes(opts.vs) ? opts.vs : g]);
let fail = 0; const check = (c, m) => { if (!c) { fail++; console.log('FAIL', m); } };
console.log('Same gesture (noise 0.03, rotated, scaled, mirrored) - 20 trials each');
for (const g of names) {
  const sc = []; for (let i = 0; i < 20; i++) sc.push(test(g, {noise: .03, rot: (rnd() - .5) * .5, scale: .6 + rnd() * 1.4, flip: i % 2 === 1}));
  const min = Math.min(...sc), avg = sc.reduce((a, b) => a + b) / sc.length;
  console.log(g.padEnd(10), 'min', min.toFixed(1), 'avg', avg.toFixed(1)); check(min >= 85, g + ' same-gesture min >= 85');
}
console.log('Cross gesture (noise-free) matrix, rows = performed, cols = target');
console.log(''.padEnd(10), names.map(n => n.padEnd(10)).join(''));
for (const a of names) { const row = names.map(b => { const v = test(a, {noise: 0, vs: b}); if (a !== b) check(v < 70, `${a} vs ${b} = ${v.toFixed(1)} should be < 70`); return v.toFixed(1).padEnd(10); });
  console.log(a.padEnd(10), row.join('')); }
check(Math.abs(test('Fist', {noise: 0}) - 100) < 0.01, 'self score = 100');
console.log(fail ? `\n${fail} FAILED` : '\nAll gesture-math checks passed'); process.exit(fail ? 1 : 0);
