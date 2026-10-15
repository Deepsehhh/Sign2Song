/* Sign2Song gesture math. Works in the browser (window.GestureMath) and Node (tests).
 *
 * Pipeline: MediaPipe landmarks -> pixel space (fixes aspect ratio) -> translate wrist to 0,
 * scale by wrist->middle-MCP length, rotate so that vector points up -> compare against a
 * template using (1) per-finger extension ratios, (2) joint angles, (3) landmark positions.
 * Translation, scale, distance to the camera and in-plane rotation are all removed.
 * Left/right hands: the user's pose is compared both as-is and mirrored, best score wins.
 */
(function (root) {
  'use strict';
  const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
  const CHAINS = { thumb: [0, 1, 2, 3, 4], index: [0, 5, 6, 7, 8], middle: [0, 9, 10, 11, 12],
                   ring: [0, 13, 14, 15, 16], pinky: [0, 17, 18, 19, 20] };
  const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
                       [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
  const W_EXT = 0.5, W_ANG = 0.15, W_POS = 0.35;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /** lm: [{x,y}] normalized MediaPipe coords. Returns 21 [x,y] in canonical hand space. */
  function normalize(lm, W, H) {
    const p = lm.map(l => [l.x * W, l.y * H]);
    const w = p[0];
    const q = p.map(a => [a[0] - w[0], a[1] - w[1]]);
    const m = q[9];
    const s = Math.hypot(m[0], m[1]) || 1e-6;
    const rot = -Math.PI / 2 - Math.atan2(m[1], m[0]);
    const c = Math.cos(rot), sn = Math.sin(rot);
    return q.map(([x, y]) => [(x * c - y * sn) / s, (x * sn + y * c) / s]);
  }
  const mirror = n => n.map(p => [-p[0], p[1]]);
  const dist = (n, a, b) => Math.hypot(n[a][0] - n[b][0], n[a][1] - n[b][1]);

  function angleAt(n, a, b, c) {
    const v1 = [n[a][0] - n[b][0], n[a][1] - n[b][1]], v2 = [n[c][0] - n[b][0], n[c][1] - n[b][1]];
    const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
    if (l1 < 1e-6 || l2 < 1e-6) return Math.PI;
    return Math.acos(clamp((v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2), -1, 1));
  }

  function fingerFeatures(n) {
    const ext = [dist(n, 4, 17),
      dist(n, 0, 8) / dist(n, 0, 5), dist(n, 0, 12) / dist(n, 0, 9),
      dist(n, 0, 16) / dist(n, 0, 13), dist(n, 0, 20) / dist(n, 0, 17)];
    const ang = FINGER_NAMES.map(f => { const c = CHAINS[f];
      return [angleAt(n, c[0], c[1], c[2]), angleAt(n, c[1], c[2], c[3]), angleAt(n, c[2], c[3], c[4])]; });
    return { ext, ang };
  }

  /** Similarity 0..100 between a normalized user hand and a template {landmarks, weights?}. */
  function compare(userN, tmpl) {
    const ft = tmpl._f || (tmpl._f = fingerFeatures(tmpl.landmarks));
    const fu = fingerFeatures(userN);
    const w = tmpl.weights || [1, 1, 1, 1, 1];
    let ext = 0, ang = 0, pos = 0, ws = 0;
    FINGER_NAMES.forEach((f, i) => {
      ext += w[i] * (1 - clamp(Math.abs(fu.ext[i] - ft.ext[i]) / 0.8, 0, 1));
      let ad = 0; for (let j = 0; j < 3; j++) ad += Math.abs(fu.ang[i][j] - ft.ang[i][j]);
      ang += w[i] * (1 - clamp(ad / 3 / 2.2, 0, 1));
      let pd = 0; const c = CHAINS[f];
      for (let j = 1; j < 5; j++) pd += Math.hypot(userN[c[j]][0] - tmpl.landmarks[c[j]][0], userN[c[j]][1] - tmpl.landmarks[c[j]][1]);
      pos += w[i] * (1 - clamp(pd / 4 / 0.8, 0, 1));
      ws += w[i];
    });
    return clamp((W_EXT * ext + W_ANG * ang + W_POS * pos) / ws, 0, 1) * 100;
  }

  /** Best of normal / mirrored (handles left vs right hand and mirrored templates). */
  function bestScore(userN, tmpl) {
    return Math.max(compare(userN, tmpl), compare(mirror(userN), tmpl));
  }

  // ---- Built-in starter templates for the 4 gesture labels of the original project ----
  const MCP = { index: [-0.38, -0.95], middle: [0, -1], ring: [0.34, -0.93], pinky: [0.64, -0.8] };
  const SEG = { index: [.45, .28, .25], middle: [.5, .32, .27], ring: [.45, .3, .25], pinky: [.35, .22, .2] };
  function buildHand(thumbExt, ext, fans) {
    const p = new Array(21); p[0] = [0, 0];
    if (thumbExt) { p[1] = [-.30, -.25]; p[2] = [-.58, -.48]; p[3] = [-.80, -.68]; p[4] = [-.98, -.85]; }
    else { p[1] = [-.30, -.25]; p[2] = [-.38, -.50]; p[3] = [-.12, -.58]; p[4] = [.12, -.52]; }
    ['index', 'middle', 'ring', 'pinky'].forEach((f, i) => {
      const base = 5 + i * 4, m = MCP[f], l = SEG[f], fan = fans[i];
      p[base] = m.slice();
      if (ext[i]) {
        const len = Math.hypot(fan, 1), d = [fan / len, -1 / len]; let c = m;
        for (let j = 0; j < 3; j++) { c = [c[0] + d[0] * l[j], c[1] + d[1] * l[j]]; p[base + 1 + j] = c; }
      } else {
        const pip = [m[0] + fan * .15, m[1] - l[0] * .5], dip = [pip[0] + fan * .05, pip[1] + l[1] * .7];
        p[base + 1] = pip; p[base + 2] = dip; p[base + 3] = [dip[0], dip[1] + l[2] * .6];
      }
    });
    return p;
  }
  function defaultTemplates() {
    return {
      'Open Palm': { landmarks: buildHand(true, [1, 1, 1, 1], [-.12, 0, .1, .22]), source: 'default' },
      'Fist':      { landmarks: buildHand(false, [0, 0, 0, 0], [-.12, 0, .1, .22]), source: 'default' },
      'Peace':     { landmarks: buildHand(false, [1, 1, 0, 0], [-.22, .18, .1, .22]), weights: [.3, 1, 1, 1, 1], source: 'default' },
      'Rock':      { landmarks: buildHand(false, [1, 0, 0, 1], [-.2, 0, .1, .3]), weights: [.3, 1, 1, 1, 1], source: 'default' }
    };
  }

  const api = { FINGER_NAMES, CHAINS, CONNECTIONS, normalize, mirror, compare, bestScore, defaultTemplates, clamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GestureMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
