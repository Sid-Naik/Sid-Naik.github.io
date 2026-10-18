// Model gallery: six small models, each computed in the browser and drawn into one SVG frame.
// Every module has the same interface (see DESIGN.md, "Model gallery"):
//   init(stage)    keep the <g> it draws into
//   reset(seed)    compute a fresh run, build its DOM and return its length in ms
//   render(t)      draw the run at t ms (0 to the length); a pure function of t
//   status(t)      the one-line mono status for t
//   destroy()      remove its DOM
//   onThemeChange  optional; colours come from CSS tokens, so none of the six needs it
// The gallery owns the only clock, so pausing, reduced motion and switching models never leave timers behind.
(function () {
  'use strict';
  var gallery = document.getElementById('gallery');
  if (!gallery || !document.createElementNS) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var narrowMq = window.matchMedia('(max-width: 560px)');
  var NS = 'http://www.w3.org/2000/svg';

  // ---- Shared timing (ms) ----
  // Every run lasts T.run: T.start of setup, then the model's own steps share the rest equally (stepLen).
  var T = { start: 800, run: 7200, morph: 450, hold: 1200, wipe: 600 };
  function stepLen(n) { return (T.run - T.start) / n; }

  // ---- Shared helpers ----
  function rng(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gaussFn(r) { return function () { var u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }; }
  function ease(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { return 0.5 - 0.5 * Math.cos(Math.PI * t); }
  function ramp(t, from, len) { return Math.max(0, Math.min(1, (t - from) / len)); }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function lerpPts(a, b, u) { return a.map(function (q, i) { return [lerp(q[0], b[i][0], u), lerp(q[1], b[i][1], u)]; }); }
  function d2(p, q) { return (p[0] - q[0]) * (p[0] - q[0]) + (p[1] - q[1]) * (p[1] - q[1]); }
  function el(name, attrs, parent) {
    var e = document.createElementNS(NS, name);
    Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    parent.appendChild(e);
    return e;
  }
  function clear(g) { while (g.firstChild) g.removeChild(g.firstChild); }
  function fmt(v) { return v.toFixed(2); }
  function polyAttr(poly) { return poly.map(function (p) { return fmt(p[0]) + ',' + fmt(p[1]); }).join(' '); }
  // Keep the part of a convex polygon where f(p) <= 0 (f affine): Sutherland–Hodgman against one half-plane.
  function clip(poly, f) {
    var out = [];
    poly.forEach(function (P, k) {
      var Q = poly[(k + 1) % poly.length], fp = f(P), fq = f(Q);
      if (fp <= 0) out.push(P);
      if ((fp <= 0) !== (fq <= 0)) { var t = fp / (fp - fq); out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]); }
    });
    return out;
  }
  var FRAME = [[0, 0], [100, 0], [100, 100], [0, 100]];
  var PAD = 6;

  // ---- Shared marks: red square, blue circle, yellow triangle, in that order everywhere ----
  // Every mark is a 24-vertex outline sampled at the same angles, so any shape can morph into any other.
  // Polygons are exact: the sample angles include every corner.
  var ANG = [];
  for (var v = 0; v < 24; v++) ANG.push(-Math.PI / 2 + v * Math.PI / 12);
  function regular(n, apothem, phi0) {
    return function (t) {
      var m = -1;
      for (var k = 0; k < n; k++) m = Math.max(m, Math.cos(t - phi0 - k * 2 * Math.PI / n));
      return apothem / m;
    };
  }
  function outline(radius, scale) {
    return ANG.map(function (t) { var r = radius(t) * (scale || 1); return [r * Math.cos(t), r * Math.sin(t)]; });
  }
  var DOT = outline(function () { return 0.95; });
  var MARKS = [
    regular(4, 1.3, 0),               // red square
    function () { return 1.45; },     // blue circle
    regular(3, 0.9, Math.PI / 2)      // yellow triangle, apex up
  ];
  var SHAPE = MARKS.map(function (m) { return outline(m); });
  function pointsAttr(o, at) { return o.map(function (q) { return fmt(at[0] + q[0]) + ',' + fmt(at[1] + q[1]); }).join(' '); }
  function mark(k, at, scale, parent) {
    return el('polygon', { 'class': 'viz-pt viz-k' + k, points: pointsAttr(outline(MARKS[k], scale), at) }, parent);
  }

  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
  function softmax(s) {
    var m = Math.max.apply(null, s), e = s.map(function (q) { return Math.exp(q - m); }), z = e.reduce(function (a, b) { return a + b; }, 0);
    return e.map(function (q) { return q / z; });
  }
  function dot(a, b) { return a.reduce(function (s, q, i) { return s + q * b[i]; }, 0); }
  function place(e, x, y, rot, sc) {
    e.setAttribute('transform', 'translate(' + fmt(x) + ' ' + fmt(y) + ')' + (rot ? ' rotate(' + fmt(rot) + ')' : '') + (sc === undefined ? '' : ' scale(' + fmt(sc) + ')'));
  }
  // display, not visibility: a child marked visible would show through a hidden parent.
  function vis(e, on) { e.setAttribute('display', on ? 'inline' : 'none'); }
  function fade(e, o) { vis(e, o > 0); if (o > 0) e.setAttribute('opacity', fmt(o)); }
  function label(parent, s, x, y, cls) {
    var e = el('text', { 'class': 'viz-label' + (cls ? ' ' + cls : ''), x: fmt(x), y: fmt(y) }, parent);
    e.textContent = s;
    return e;
  }
  // A yellow triangle marks what is active. It points up; rotate(90) points it right.
  function pointer(parent) { return el('polygon', { 'class': 'viz-pointer', points: pointsAttr(outline(MARKS[2], 1.1), [0, 0]), display: 'none' }, parent); }
  // An ink ring marks what matters.
  function ring(parent, at, r) { return el('circle', { 'class': 'viz-ring', cx: fmt(at[0]), cy: fmt(at[1]), r: r || 2.6, display: 'none' }, parent); }
  // Strength in three steps of line style at one fixed thickness: 1 weak (dotted), 2 medium (dashed), 3 strong
  // (solid). Line thickness never carries data.
  function tierClass(k) { return k === 1 ? ' viz-w1' : k === 2 ? ' viz-w2' : ''; }
  // Leaves take equal slots across [x0, x0 + w]; each split sits over the middle of its children. Returns every node
  // with its position and its parent's entry.
  function treeLayout(root, x0, w, ys) {
    var out = [], leaves = [];
    (function walk(n, p) { var a = { n: n, p: p, y: ys[n.depth] }; out.push(a); if (n.kids) { walk(n.kids[0], a); walk(n.kids[1], a); } else leaves.push(a); })(root, null);
    leaves.forEach(function (a, i) { a.x = x0 + (leaves.length === 1 ? w / 2 : i * w / (leaves.length - 1)); });
    (function at(a) {
      if (!a.n.kids) return a.x;
      var kids = out.filter(function (b) { return b.p === a; });
      a.x = (at(kids[0]) + at(kids[1])) / 2;
      return a.x;
    })(out[0]);
    return out;
  }

  // ---- 1. K-means: Lloyd's algorithm on three clusters of different sizes ----
  var kmeans = (function () {
    var K = 3, SIZES = [55, 30, 15], SDS = [8, 6, 4.5], MIN_GAP = 45, START_R = 8, MIN_ITER = 4, MAX_ITER = 6;
    // Each iteration takes an equal share of the run: 7/16 assigning, 7/16 moving the centroids, then a pause.
    var ITER, ASSIGN, MOVE;
    var g, pts, steps, last, pe, cells, cts, events, drawn;

    function clampP(v) { return Math.min(100 - PAD, Math.max(PAD, v)); }
    // Three well-separated elliptical blobs of 55, 30 and 15 points, each with its own spread, stretch and tilt.
    function sample(r) {
      var gauss = gaussFn(r), centres;
      do {
        centres = [0, 1, 2].map(function () { return [20 + r() * 60, 20 + r() * 60]; });
      } while (d2(centres[0], centres[1]) < MIN_GAP * MIN_GAP || d2(centres[0], centres[2]) < MIN_GAP * MIN_GAP || d2(centres[1], centres[2]) < MIN_GAP * MIN_GAP);
      var p = [], label = [];
      SIZES.forEach(function (n, k) {
        var stretch = 1 + r() * 0.6, tilt = r() * Math.PI, ct = Math.cos(tilt), st = Math.sin(tilt);
        for (var i = 0; i < n; i++) {
          var a = gauss() * SDS[k] * stretch, b = gauss() * SDS[k] / stretch;
          p.push([clampP(centres[k][0] + a * ct - b * st), clampP(centres[k][1] + a * st + b * ct)]);
          label.push(k);
        }
      });
      return { pts: p, label: label };
    }
    function nearest(p, c) {
      var best = 0;
      for (var j = 1; j < c.length; j++) if (d2(p, c[j]) < d2(p, c[best])) best = j;
      return best;
    }
    // steps[0] holds the starting centroids; steps[i] holds iteration i's assignment and the means it moved to.
    function lloyd(p, c) {
      var a = p.map(function () { return -1; });
      var out = [{ a: a, c: c }];
      for (var it = 0; it < 50; it++) {
        var next = p.map(function (q) { return nearest(q, c); });
        if (!next.some(function (x, i) { return x !== a[i]; })) break;
        a = next;
        c = c.map(function (q, j) {
          var m = p.filter(function (_, i) { return a[i] === j; });
          if (!m.length) return q;
          return [m.reduce(function (s, x) { return s + x[0]; }, 0) / m.length, m.reduce(function (s, x) { return s + x[1]; }, 0) / m.length];
        });
        out.push({ a: a, c: c });
      }
      return out;
    }
    // Share of points whose final cluster matches the blob they came from, under the best relabelling.
    function agreement(a, label) {
      var perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
      return Math.max.apply(null, perms.map(function (pm) {
        return a.filter(function (x, i) { return pm[x] === label[i]; }).length / a.length;
      }));
    }
    // Lloyd's algorithm can settle in a local optimum. The gallery skips seeds that do, and seeds that take
    // fewer than 4 or more than 6 iterations, so every run ends on the visible clusters within its time slot.
    function makeRun(seed) {
      var run;
      for (var tries = 0; tries < 300; tries++, seed++) {
        var r = rng(seed), d = sample(r), turn = r() * 2 * Math.PI;
        var start = [0, 1, 2].map(function (k) {
          return [50 + START_R * Math.cos(turn + k * 2 * Math.PI / 3), 50 + START_R * Math.sin(turn + k * 2 * Math.PI / 3)];
        });
        var s = lloyd(d.pts, start), n = s.length - 1;
        run = { pts: d.pts, steps: s };
        if (n >= MIN_ITER && n <= MAX_ITER && agreement(s[n].a, d.label) >= 0.97) break;
      }
      return run;
    }
    // The Voronoi cell of centroid j: the frame clipped by the half-plane nearer j than each other centroid.
    function cell(j, c) {
      var poly = FRAME;
      c.forEach(function (q, i) {
        if (i === j) return;
        var dx = q[0] - c[j][0], dy = q[1] - c[j][1], e = q[0] * q[0] + q[1] * q[1] - c[j][0] * c[j][0] - c[j][1] * c[j][1];
        poly = clip(poly, function (p) { return 2 * (p[0] * dx + p[1] * dy) - e; });
      });
      return polyAttr(poly);
    }
    function centroidsAt(t) {
      var c = steps[0].c;
      for (var i = 1; i <= last; i++) {
        var u = ramp(t, T.start + (i - 1) * ITER + ASSIGN, MOVE);
        if (u <= 0) break;
        c = lerpPts(steps[i - 1].c, steps[i].c, ease(u));
        if (u < 1) break;
      }
      return c;
    }
    return {
      id: 'kmeans', defaultSeed: 11,
      init: function (stage) { g = stage; },
      reset: function (seed) {
        clear(g);
        var run = makeRun(seed);
        pts = run.pts; steps = run.steps; last = steps.length - 1;
        ITER = stepLen(last); ASSIGN = MOVE = ITER * 7 / 16;
        var lc = el('g', {}, g), lp = el('g', {}, g), lt = el('g', {}, g);
        cells = []; cts = [];
        for (var j = 0; j < K; j++) {
          cells.push(el('polygon', { 'class': 'viz-region viz-cell viz-k' + j }, lc));
          var ct = el('g', { 'class': 'viz-ct' }, lt);
          el('circle', { r: 3.4 }, ct);
          el('polygon', { 'class': 'viz-k' + j, points: pointsAttr(outline(MARKS[j], 1.15), [0, 0]) }, ct);
          cts.push(ct);
        }
        pe = pts.map(function (p) { return el('polygon', { 'class': 'viz-pt', points: pointsAttr(DOT, p) }, lp); });
        // Each point's shape changes: when it joins a new cluster, it morphs from its old outline to the new one.
        var shape = pts.map(function () { return DOT; });
        events = pts.map(function () { return []; });
        for (var i = 1; i <= last; i++) {
          steps[i].a.forEach(function (k, n) {
            if (k === steps[i - 1].a[n]) return;
            events[n].push({ t: T.start + (i - 1) * ITER, from: shape[n], to: SHAPE[k], k: k });
            shape[n] = SHAPE[k];
          });
        }
        drawn = pts.map(function () { return { cls: 'viz-pt', key: '' }; });
        return T.run;
      },
      render: function (t) {
        // A point that changes cluster morphs its outline in place and takes the new colour halfway through,
        // so it never shows a blend of two class colours.
        pts.forEach(function (p, n) {
          var ev = events[n], e = -1;
          while (e + 1 < ev.length && ev[e + 1].t <= t) e++;
          var u = e < 0 ? 1 : ramp(t, ev[e].t, T.morph), key = e + ':' + u, was = drawn[n];
          if (was.key === key) return;
          var k = e < 0 ? -1 : u >= 0.5 ? ev[e].k : e > 0 ? ev[e - 1].k : -1;
          var cls = 'viz-pt' + (k < 0 ? '' : ' viz-k' + k);
          if (cls !== was.cls) pe[n].setAttribute('class', cls);
          pe[n].setAttribute('points', pointsAttr(e < 0 ? DOT : lerpPts(ev[e].from, ev[e].to, ease(u)), p));
          drawn[n] = { cls: cls, key: key };
        });
        var c = centroidsAt(t);
        c.forEach(function (q, j) {
          cells[j].setAttribute('points', cell(j, c));
          cts[j].setAttribute('transform', 'translate(' + fmt(q[0]) + ' ' + fmt(q[1]) + ')');
        });
      },
      status: function (t) {
        if (t < T.start) return 'iter 0 · start';
        var i = Math.floor((t - T.start) / ITER) + 1;
        if (i > last) return 'converged · ' + last + ' iter';
        return 'iter ' + i + (t - T.start - (i - 1) * ITER < ASSIGN ? ' · assign' : ' · update');
      },
      destroy: function () { if (g) clear(g); pts = pe = cells = cts = events = drawn = null; }
    };
  })();

  // ---- 2. Gradient boosting: small regression trees fitted one at a time to the log-loss gradient ----
  var boost = (function () {
    var ROUNDS = 6, DEPTH = 2, NU = 0.5, MIN_LEAF = 3, STEP = stepLen(ROUNDS), FADE = 0.2 * STEP;
    var g, data, F0, trees, accs, wrong, parts, rings, lines, icons, views, ptr;
    var P = { x: 0, y: 36, w: 100, h: 64 };

    // A blue blob ringed by red points: axis-aligned trees can only build it up as a staircase, so each new tree helps.
    function sample(r) {
      var gauss = gaussFn(r), c = [0.38 + r() * 0.24, 0.38 + r() * 0.24], s = [0.08 + r() * 0.03, 0.08 + r() * 0.03];
      var stretch = 0.85 + r() * 0.3, x = [], y = [];
      function inside(p) { return p[0] > 0.03 && p[0] < 0.97 && p[1] > 0.03 && p[1] < 0.97; }
      while (x.length < 28) { var p = [c[0] + gauss() * s[0], c[1] + gauss() * s[1]]; if (inside(p)) { x.push(p); y.push(1); } }
      while (x.length < 70) {
        var a = r() * 2 * Math.PI, rad = 0.31 + gauss() * 0.045, q = [c[0] + rad * Math.cos(a) * stretch, c[1] + rad * Math.sin(a) / stretch];
        if (inside(q)) { x.push(q); y.push(0); }
      }
      return { x: x, y: y };
    }
    // A depth-2 regression tree on the residuals r = y - p, splitting where the squared error drops most.
    // Each leaf takes a Newton step: sum(r) / sum(p(1 - p)).
    function fit(idx, r, h, depth, box) {
      var node = { box: box, depth: depth }, best = null;
      if (depth < DEPTH && idx.length >= 2 * MIN_LEAF) {
        [0, 1].forEach(function (f) {
          var s = idx.slice().sort(function (a, b) { return data.x[a][f] - data.x[b][f]; });
          var tot = s.reduce(function (q, i) { return q + r[i]; }, 0), left = 0;
          for (var k = 1; k < s.length; k++) {
            left += r[s[k - 1]];
            var lo = data.x[s[k - 1]][f], hi = data.x[s[k]][f];
            if (k < MIN_LEAF || s.length - k < MIN_LEAF || hi === lo) continue;
            var gain = left * left / k + (tot - left) * (tot - left) / (s.length - k);
            if (!best || gain > best.gain) best = { f: f, th: (lo + hi) / 2, gain: gain, L: s.slice(0, k), R: s.slice(k) };
          }
        });
      }
      if (!best) {
        var sr = 0, sh = 0;
        idx.forEach(function (i) { sr += r[i]; sh += h[i]; });
        node.v = Math.max(-4, Math.min(4, sr / Math.max(sh, 1e-6)));
        return node;
      }
      var lb = box.slice(), rb = box.slice();
      if (best.f === 0) { lb[2] = best.th; rb[0] = best.th; } else { lb[3] = best.th; rb[1] = best.th; }
      node.f = best.f; node.th = best.th;
      node.kids = [fit(best.L, r, h, depth + 1, lb), fit(best.R, r, h, depth + 1, rb)];
      return node;
    }
    function value(n, x) { while (n.kids) n = x[n.f] < n.th ? n.kids[0] : n.kids[1]; return n.v; }
    // The ensemble of the first k trees: the prior log-odds plus the shrunken tree outputs.
    function score(k, x) { var s = F0; for (var j = 0; j < k; j++) s += NU * value(trees[j], x); return s; }
    function train() {
      var n = data.x.length, pos = data.y.filter(Boolean).length, all = data.x.map(function (_, i) { return i; });
      F0 = Math.log(pos / (n - pos)); trees = [];
      var F = data.x.map(function () { return F0; });
      for (var k = 0; k < ROUNDS; k++) {
        var p = F.map(sigmoid), r = data.y.map(function (y, i) { return y - p[i]; }), h = p.map(function (q) { return q * (1 - q); });
        var t = fit(all, r, h, 0, [0, 0, 1, 1]);
        trees.push(t);
        F = F.map(function (f, i) { return f + NU * value(t, data.x[i]); });
      }
      wrong = []; accs = [];
      for (var k2 = 0; k2 <= ROUNDS; k2++) {
        var w = data.x.map(function (x, i) { return (score(k2, x) > 0 ? 1 : 0) !== data.y[i]; });
        wrong.push(w);
        accs.push(1 - w.filter(Boolean).length / w.length);
      }
    }
    // Skip seeds where one tree already does the job, or where six don't get there.
    function makeRun(seed) {
      for (var tries = 0; tries < 200; tries++, seed++) {
        data = sample(rng(seed)); train();
        if (accs[1] <= 0.9 && accs[ROUNDS] >= 0.96 && accs[ROUNDS] - accs[1] >= 0.08) return;
      }
    }
    // The ensemble's exact partition: every threshold of its trees cuts the space into cells, each takes the class
    // at its centre, cells merge into row runs, and the boundary is drawn where neighbouring cells disagree.
    function partition(k) {
      var cut = [[0, 1], [0, 1]];
      trees.slice(0, k).forEach(function (t) { (function walk(n) { if (n.kids) { cut[n.f].push(n.th); walk(n.kids[0]); walk(n.kids[1]); } })(t); });
      var xs = cut[0].sort(function (a, b) { return a - b; }), ys = cut[1].sort(function (a, b) { return a - b; });
      var cls = xs.slice(1).map(function (x1, a) {
        return ys.slice(1).map(function (y1, b) { return score(k, [(xs[a] + x1) / 2, (ys[b] + y1) / 2]) > 0 ? 1 : 0; });
      });
      var rects = [], d = '';
      for (var b = 0; b < ys.length - 1; b++) {
        for (var a = 0, a0 = 0; a < xs.length - 1; a++) {
          if (a + 1 < xs.length - 1 && cls[a + 1][b] === cls[a][b]) continue;
          rects.push({ x0: ex(xs[a0]), x1: ex(xs[a + 1]), y0: ey(ys[b + 1]), y1: ey(ys[b]), c: cls[a][b] });
          a0 = a + 1;
        }
      }
      for (var a2 = 1; a2 < xs.length - 1; a2++) for (var b2 = 0; b2 < ys.length - 1; b2++) {
        if (cls[a2 - 1][b2] !== cls[a2][b2]) d += 'M' + fmt(px(xs[a2])) + ' ' + fmt(ey(ys[b2])) + 'V' + fmt(ey(ys[b2 + 1]));
      }
      for (var b3 = 1; b3 < ys.length - 1; b3++) for (var a3 = 0; a3 < xs.length - 1; a3++) {
        if (cls[a3][b3 - 1] !== cls[a3][b3]) d += 'M' + fmt(ex(xs[a3])) + ' ' + fmt(py(ys[b3])) + 'H' + fmt(ex(xs[a3 + 1]));
      }
      return { rects: rects, d: d };
    }
    // The feature space: the lower two thirds of the frame. y points up.
    function px(u) { return P.x + PAD + u * (P.w - 2 * PAD); }
    function py(v) { return P.y + P.h - PAD - v * (P.h - 2 * PAD); }
    function ex(u) { return u <= 0 ? P.x : u >= 1 ? P.x + P.w : px(u); }
    function ey(v) { return v <= 0 ? P.y + P.h : v >= 1 ? P.y : py(v); }
    // Round k (1 to ROUNDS): the new tree appears, its splits draw across the space, then the ensemble's partition
    // and its mistakes update.
    function roundAt(k) { return T.start + (k - 1) * STEP; }
    function swapAt(k) { return roundAt(k) + 0.55 * STEP; }
    function ringsAt(k) { return k === 0 ? 300 : swapAt(k) + FADE; }
    function iconX(j) { return 14 + j * 13; }
    return {
      id: 'boost', defaultSeed: 1,
      init: function (stage) { g = stage; },
      reset: function (seed) {
        clear(g);
        makeRun(seed);
        var lr = el('g', {}, g), ll = el('g', {}, g), lp = el('g', {}, g), lk = el('g', {}, g), lt = el('g', {}, g);
        parts = [];
        for (var k = 0; k <= ROUNDS; k++) {
          var pg = el('g', { display: 'none' }, lr), part = partition(k);
          part.rects.forEach(function (q) {
            el('rect', { 'class': 'viz-region viz-k' + q.c, x: fmt(q.x0), y: fmt(q.y0), width: fmt(q.x1 - q.x0), height: fmt(q.y1 - q.y0) }, pg);
          });
          if (part.d) el('path', { 'class': 'viz-boundary', d: part.d }, pg);
          parts.push(pg);
        }
        // The newest tree's splits, each drawn across the region its node covers: the root first, then its children.
        lines = trees.map(function (t, j) {
          var out = [];
          (function walk(n) {
            if (!n.kids) return;
            var b = n.box, a = n.f === 0 ? [px(n.th), ey(b[1]), px(n.th), ey(b[3])] : [ex(b[0]), py(n.th), ex(b[2]), py(n.th)];
            out.push({ round: j + 1, depth: n.depth, a: a, e: el('line', { 'class': 'viz-split', display: 'none' }, ll) });
            walk(n.kids[0]); walk(n.kids[1]);
          })(t);
          return out;
        });
        data.x.forEach(function (x, i) { mark(data.y[i], [px(x[0]), py(x[1])], 1, lp); });
        // Rings a little tighter than elsewhere: the blob is dense, and at the start every blue point is wrong.
        rings = data.x.map(function (x) { return ring(lk, [px(x[0]), py(x[1])], 2.2); });
        icons = []; views = [];
        el('line', { 'class': 'viz-rule', x1: 0, y1: P.y, x2: 100, y2: P.y }, lt);
        trees.forEach(function (t, j) {
          // A small ink icon per tree in the top row...
          var ig = el('g', { display: 'none', transform: 'translate(' + fmt(iconX(j)) + ' 5)' }, lt);
          treeLayout(t, -3.5, 7, [-2.4, 0, 2.4]).forEach(function (a) {
            if (a.p) el('line', { 'class': 'viz-link viz-thin', x1: fmt(a.p.x), y1: fmt(a.p.y), x2: fmt(a.x), y2: fmt(a.y) }, ig);
            el('circle', { 'class': 'viz-dot', cx: fmt(a.x), cy: fmt(a.y), r: a.n.kids ? 0.75 : 0.5 }, ig);
          });
          icons.push(ig);
          // ...and the newest one drawn out below it: split boxes, and leaves marked with the class they push towards.
          var vg = el('g', { display: 'none' }, lt);
          treeLayout(t, 8, 84, [14, 22.5, 31]).forEach(function (a) {
            if (a.p) {
              var y0 = a.p.y + 2.7, mid = (y0 + a.y - 2.6) / 2;
              el('path', { 'class': 'viz-link', d: 'M' + fmt(a.p.x) + ' ' + fmt(y0) + 'V' + fmt(mid) + 'H' + fmt(a.x) + 'V' + fmt(a.y - (a.n.kids ? 2.7 : 2.4)) }, vg);
            }
            if (!a.n.kids) { mark(a.n.v > 0 ? 1 : 0, [a.x, a.y], 1.3, vg); return; }
            // A split box holds a short line across the axis it cuts: upright for x, level for y.
            var b = el('g', { 'class': 'viz-node', transform: 'translate(' + fmt(a.x) + ' ' + fmt(a.y) + ')' }, vg);
            el('rect', { x: -2.7, y: -2.7, width: 5.4, height: 5.4 }, b);
            el('line', a.n.f === 0 ? { x1: 0, y1: -1.6, x2: 0, y2: 1.6 } : { x1: -1.6, y1: 0, x2: 1.6, y2: 0 }, b);
          });
          views.push(vg);
        });
        ptr = pointer(lt);
        return T.run;
      },
      render: function (t) {
        // Each partition fades in over the last one, which hides once it's covered.
        parts.forEach(function (pg, k) {
          var u = k === 0 ? ramp(t, 100, 300) : ramp(t, swapAt(k), FADE), next = k < ROUNDS ? ramp(t, swapAt(k + 1), FADE) : 0;
          fade(pg, next < 1 ? u : 0);
        });
        lines.forEach(function (L) {
          L.forEach(function (ln) {
            var s = roundAt(ln.round) + (0.15 + 0.15 * ln.depth) * STEP, u = ease(ramp(t, s, 0.15 * STEP)), a = ln.a;
            var o = 1 - ramp(t, swapAt(ln.round) + FADE, 0.15 * STEP);
            fade(ln.e, u > 0 ? o : 0);
            ln.e.setAttribute('x1', fmt(a[0])); ln.e.setAttribute('y1', fmt(a[1]));
            ln.e.setAttribute('x2', fmt(lerp(a[0], a[2], u))); ln.e.setAttribute('y2', fmt(lerp(a[1], a[3], u)));
          });
        });
        // Rings mark the points the ensemble gets wrong; they update just after each partition does.
        var k = -1;
        while (k < ROUNDS && t >= ringsAt(k + 1)) k++;
        rings.forEach(function (e, i) {
          if (k < 0) { fade(e, 0); return; }
          var u = ramp(t, ringsAt(k), 200), was = k > 0 && wrong[k - 1][i] ? 1 : 0;
          fade(e, lerp(was, wrong[k][i] ? 1 : 0, u));
        });
        var j = t < T.start ? -1 : Math.min(ROUNDS - 1, Math.floor((t - T.start) / STEP));
        icons.forEach(function (ig, n) { fade(ig, n <= j ? ramp(t, roundAt(n + 1), 0.15 * STEP) : 0); });
        views.forEach(function (vg, n) { fade(vg, n === j ? ramp(t, roundAt(n + 1), 0.15 * STEP) : 0); });
        if (j < 0) { vis(ptr, false); return; }
        // The yellow triangle points at the newest tree's icon, sliding along as each one arrives.
        var x = lerp(iconX(Math.max(0, j - 1)), iconX(j), ease(ramp(t, roundAt(j + 1), 0.15 * STEP)));
        vis(ptr, true);
        place(ptr, x - 6.4, 5, 90);
      },
      status: function (t) {
        var k = 0;
        while (k < ROUNDS && t >= swapAt(k + 1) + FADE / 2) k++;
        return 'trees ' + k + ' · acc ' + Math.round(accs[k] * 100) + '%';
      },
      destroy: function () { if (g) clear(g); data = trees = parts = rings = lines = icons = views = ptr = null; }
    };
  })();

  // ---- 3. Logistic regression: full-batch gradient descent on the log loss, from w = 0 ----
  var logreg = (function () {
    var EPOCHS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512], LAMBDA = 0.001, ETA = 4, STEP = stepLen(EPOCHS.length), MOVE = 0.7 * STEP;
    // The band edges: p = 0.7 and p = 0.9 on each side, as log-odds.
    var L7 = Math.log(0.7 / 0.3), L9 = Math.log(0.9 / 0.1);
    var g, data, snaps, bands, edges, boundary;

    // Two elongated, tilted blobs that overlap a little; coordinates in [-0.9, 0.9], y up.
    function sample(r) {
      var gauss = gaussFn(r), x = [], y = [];
      var tilt = r() * Math.PI, ax = [Math.cos(tilt), Math.sin(tilt)], nrm = [-ax[1], ax[0]];
      var sep = 0.34 + r() * 0.12, shift = (r() - 0.5) * 0.6;
      [0, 1].forEach(function (k) {
        var s = 2 * k - 1, cx = nrm[0] * s * sep / 2 + ax[0] * s * shift, cy = nrm[1] * s * sep / 2 + ax[1] * s * shift;
        for (var i = 0; i < 25; i++) {
          var a = gauss() * 0.3, b = gauss() * 0.11;
          x.push([Math.max(-0.9, Math.min(0.9, cx + ax[0] * a + nrm[0] * b)), Math.max(-0.9, Math.min(0.9, cy + ax[1] * a + nrm[1] * b))]);
          y.push(k);
        }
      });
      return { x: x, y: y };
    }
    // The mean log loss, computed stably: log(1 + e^z) - y z.
    function loss(d, w, b) {
      return d.x.reduce(function (s, x, i) {
        var z = w[0] * x[0] + w[1] * x[1] + b;
        return s + Math.max(z, 0) + Math.log(1 + Math.exp(-Math.abs(z))) - d.y[i] * z;
      }, 0) / d.x.length;
    }
    function train(d) {
      var w = [0, 0], b = 0, n = d.x.length, out = [];
      for (var ep = 1; ep <= EPOCHS[EPOCHS.length - 1]; ep++) {
        var gw = [LAMBDA * w[0], LAMBDA * w[1]], gb = 0;
        d.x.forEach(function (x, i) {
          var e = sigmoid(w[0] * x[0] + w[1] * x[1] + b) - d.y[i];
          gw[0] += e * x[0] / n; gw[1] += e * x[1] / n; gb += e / n;
        });
        w = [w[0] - ETA * gw[0], w[1] - ETA * gw[1]]; b -= ETA * gb;
        if (EPOCHS.indexOf(ep) >= 0) out.push({ epoch: ep, w: w.slice(), b: b, loss: loss(d, w, b) });
      }
      return out;
    }
    function accuracy(d, s) { return d.x.filter(function (x, i) { return (s.w[0] * x[0] + s.w[1] * x[1] + s.b > 0 ? 1 : 0) === d.y[i]; }).length / d.x.length; }
    // Skip seeds that end below 90%, where the boundary barely turns, where the loss ever rises, or where the
    // final p = 0.9 band edges sit too close to the boundary or too far from it to read.
    function makeRun(seed) {
      for (var tries = 0; tries < 200; tries++, seed++) {
        data = sample(rng(seed)); snaps = train(data);
        var f = snaps[snaps.length - 1], first = snaps[0].w;
        var turn = Math.acos(Math.min(1, (first[0] * f.w[0] + first[1] * f.w[1]) / Math.hypot(first[0], first[1]) / Math.hypot(f.w[0], f.w[1])));
        var width = 50 * L9 / Math.hypot(f.w[0], f.w[1]);
        var falls = snaps.every(function (s, k) { return !k || s.loss <= snaps[k - 1].loss; });
        if (accuracy(data, f) >= 0.9 && turn >= 12 * Math.PI / 180 && falls && width >= 7 && width <= 20) return;
      }
    }
    function toFrame(p) { return [50 + 50 * p[0], 50 - 50 * p[1]]; }
    function modelAt(t) {
      var k = Math.min(snaps.length - 1, Math.floor((t - T.start) / STEP)), u = ease(ramp(t - T.start - k * STEP, 0, MOVE));
      var a = k > 0 ? snaps[k - 1] : snaps[0], b = snaps[k];
      return { k: k, w: [lerp(a.w[0], b.w[0], u), lerp(a.w[1], b.w[1], u)], b: lerp(a.b, b.b, u) };
    }
    // The line f = c across the frame, or null if it misses it. f is affine in frame coordinates.
    function lineAt(f, c) {
      var seg = clip(clip(FRAME, function (p) { return f(p) - c - 1e-9; }), function (p) { return c - f(p) - 1e-9; });
      if (seg.length < 2) return null;
      var a = seg[0], best = seg[1], dmax = -1;
      seg.forEach(function (p) { seg.forEach(function (q) { var dd = d2(p, q); if (dd > dmax) { dmax = dd; a = p; best = q; } }); });
      return [a, best];
    }
    function setLine(e, seg) {
      vis(e, !!seg);
      if (!seg) return;
      e.setAttribute('x1', fmt(seg[0][0])); e.setAttribute('y1', fmt(seg[0][1]));
      e.setAttribute('x2', fmt(seg[1][0])); e.setAttribute('y2', fmt(seg[1][1]));
    }
    return {
      id: 'logreg', defaultSeed: 1,
      init: function (stage) { g = stage; },
      reset: function (seed) {
        clear(g);
        makeRun(seed);
        // Stepped probability bands in each class's pattern: dense where p >= 0.9, sparse from 0.7 to 0.9, and
        // bare paper where the model is unsure. A thin ink line edges each band, at p = 0.7 and 0.9.
        bands = [
          { cls: 'viz-k1', lo: L9, hi: Infinity }, { cls: 'viz-k1 viz-lo', lo: L7, hi: L9 },
          { cls: 'viz-k0', lo: -Infinity, hi: -L9 }, { cls: 'viz-k0 viz-lo', lo: -L9, hi: -L7 }
        ].map(function (b) { b.e = el('polygon', { 'class': 'viz-region ' + b.cls, display: 'none' }, g); return b; });
        edges = [L9, L7, -L7, -L9].map(function (c) { return { c: c, e: el('line', { 'class': 'viz-contour', display: 'none' }, g) }; });
        boundary = el('line', { 'class': 'viz-boundary', display: 'none' }, g);
        data.x.forEach(function (x, i) { mark(data.y[i], toFrame(x), 1, g); });
        return T.run;
      },
      render: function (t) {
        if (t < T.start) {
          bands.forEach(function (b) { vis(b.e, false); });
          edges.forEach(function (c) { vis(c.e, false); });
          vis(boundary, false);
          return;
        }
        var m = modelAt(t), w = m.w, b = m.b, o = ramp(t, T.start, 300);
        var f = function (p) { return w[0] * (p[0] - 50) / 50 + w[1] * (50 - p[1]) / 50 + b; };
        bands.forEach(function (bd) {
          var poly = FRAME;
          if (bd.lo > -Infinity) poly = clip(poly, function (p) { return bd.lo - f(p); });
          if (bd.hi < Infinity) poly = clip(poly, function (p) { return f(p) - bd.hi; });
          fade(bd.e, poly.length > 2 ? o : 0);
          if (poly.length > 2) bd.e.setAttribute('points', polyAttr(poly));
        });
        edges.forEach(function (c) { setLine(c.e, lineAt(f, c.c)); });
        setLine(boundary, lineAt(f, 0));
      },
      status: function (t) {
        if (t < T.start) return 'epoch 0 · loss ' + Math.log(2).toFixed(2);
        var s = snaps[modelAt(t).k];
        return 'epoch ' + s.epoch + ' · loss ' + s.loss.toFixed(2);
      },
      destroy: function () { if (g) clear(g); data = snaps = bands = edges = boundary = null; }
    };
  })();

  // ---- 4. Neural network: a 2-4-4-2 network trained by gradient descent on two moons ----
  var network = (function () {
    var SIZES = [2, 4, 4, 2], EPOCHS = [0, 30, 300], NOISE = 0.18, LR = 0.1, MOMENTUM = 0.9;
    // One pass: the example morphs in at the input, the signal crosses one layer gap at a time (GAPS), then the
    // weights ease to the next epoch while nothing else moves. The parts keep their proportions of an 1800ms pass,
    // scaled to the shared step: three passes of about 2.1s, so the signal moves calmly.
    var PASS = stepLen(EPOCHS.length), S = PASS / 1800, X = [17, 39.5, 62, 84.5], R = 3.4;
    var INPUT = 300 * S, GAPS = [300, 650, 1000, 1350].map(function (q) { return q * S; }), GROW = 450 * S, WEIGHTS = 450 * S;
    var g, snaps, samples, edges, acts, pulses, inMark, outMarks, maxW, neuronXY;
    // A weight's step is its size as a share of the largest final weight: weak below 0.2, strong from 0.45.
    function weightTier(w) { var f = Math.abs(w) / maxW; return f >= 0.45 ? 3 : f >= 0.2 ? 2 : 1; }
    // Three settings far enough apart that none reads as a disc that almost fills its circle: empty, half and full.
    var RADII = [0, 0.5, 1];
    function snapRadius(m) { return RADII.reduce(function (b, r) { return Math.abs(r - m) < Math.abs(b - m) ? r : b; }, 0); }
    var IN_DOT = outline(function () { return 1.5; }), IN_SHAPE = MARKS.map(function (m) { return outline(m, 1.6); });
    // The neurons are blue circles, so the two classes are the red square and the yellow triangle (marks 0 and 2),
    // and the signal travels as small blue circles.
    var CLS = [0, 2];

    function rows(n) { return n === 2 ? [39, 61] : [17, 39, 61, 83]; }
    function moons(r, n) {
      var gauss = gaussFn(r), x = [], y = [];
      for (var i = 0; i < n; i++) {
        var k = i % 2, t = r() * Math.PI;
        var p = k ? [1 - Math.cos(t), 0.5 - Math.sin(t)] : [Math.cos(t), Math.sin(t)];
        x.push([(p[0] + gauss() * NOISE - 0.5) / 1.1, (p[1] + gauss() * NOISE - 0.25) / 0.7]);
        y.push(k);
      }
      return { x: x, y: y };
    }
    function forward(net, x) {
      var a = [x.slice()];
      for (var l = 0; l < 3; l++) {
        var z = net.W[l].map(function (row, j) { return row.reduce(function (s, w, i) { return s + w * a[l][i]; }, net.B[l][j]); });
        if (l < 2) a.push(z.map(Math.tanh));
        else {
          var m = Math.max(z[0], z[1]), e = z.map(function (q) { return Math.exp(q - m); });
          a.push([e[0] / (e[0] + e[1]), e[1] / (e[0] + e[1])]);
        }
      }
      return a;
    }
    function copyNet(net) { return { W: net.W.map(function (L) { return L.map(function (row) { return row.slice(); }); }), B: net.B.map(function (b) { return b.slice(); }) }; }
    function zeros(net) { return { W: net.W.map(function (L) { return L.map(function (row) { return row.map(function () { return 0; }); }); }), B: net.B.map(function (b) { return b.map(function () { return 0; }); }) }; }
    function predict(net, x) { var o = forward(net, x)[3]; return o[1] > o[0] ? 1 : 0; }
    function accuracy(net, d) { return d.x.filter(function (x, i) { return predict(net, x) === d.y[i]; }).length / d.x.length; }
    // Full-batch gradient descent with momentum on cross-entropy; snapshots at the epochs shown.
    function train(seed) {
      var r = rng(seed), gauss = gaussFn(r), d = moons(r, 80), net = { W: [], B: [] };
      for (var l = 0; l < 3; l++) {
        net.W.push([]); net.B.push([]);
        for (var j = 0; j < SIZES[l + 1]; j++) {
          net.W[l].push([]); net.B[l].push(0);
          for (var i = 0; i < SIZES[l]; i++) net.W[l][j].push(gauss() * Math.sqrt(1 / SIZES[l]));
        }
      }
      var vel = zeros(net), out = [];
      for (var ep = 0; ep <= EPOCHS[EPOCHS.length - 1]; ep++) {
        if (EPOCHS.indexOf(ep) >= 0) out.push({ epoch: ep, net: copyNet(net), acc: accuracy(net, d) });
        var grad = zeros(net);
        d.x.forEach(function (x, n) {
          var a = forward(net, x), delta = [a[3][0] - (d.y[n] === 0 ? 1 : 0), a[3][1] - (d.y[n] === 1 ? 1 : 0)];
          for (var L = 2; L >= 0; L--) {
            var prev = a[L], nd = prev.map(function () { return 0; });
            for (var J = 0; J < delta.length; J++) {
              grad.B[L][J] += delta[J];
              for (var I = 0; I < prev.length; I++) { grad.W[L][J][I] += delta[J] * prev[I]; nd[I] += delta[J] * net.W[L][J][I]; }
            }
            if (L > 0) delta = nd.map(function (q, I) { return q * (1 - prev[I] * prev[I]); });
          }
        });
        for (var L2 = 0; L2 < 3; L2++) for (var J2 = 0; J2 < net.W[L2].length; J2++) {
          vel.B[L2][J2] = MOMENTUM * vel.B[L2][J2] - LR * grad.B[L2][J2] / d.x.length; net.B[L2][J2] += vel.B[L2][J2];
          for (var I2 = 0; I2 < net.W[L2][J2].length; I2++) {
            vel.W[L2][J2][I2] = MOMENTUM * vel.W[L2][J2][I2] - LR * grad.W[L2][J2][I2] / d.x.length;
            net.W[L2][J2][I2] += vel.W[L2][J2][I2];
          }
        }
      }
      return { data: d, snaps: out, r: r };
    }
    // Skip seeds that start too good to show learning, or end below 95%.
    function makeRun(seed) {
      var run;
      for (var tries = 0; tries < 60; tries++, seed++) {
        run = train(seed);
        var s = run.snaps;
        if (s[0].acc <= 0.7 && s[s.length - 1].acc >= 0.95) break;
      }
      return run;
    }
    function weightsAt(t) {
      var k = passAt(t), tau = t - T.start - k * PASS;
      if (k < 0) return snaps[0].net;
      if (k >= snaps.length - 1 || tau < GAPS[3]) return snaps[k].net;
      var u = easeInOut(ramp(tau, GAPS[3], WEIGHTS)), a = snaps[k].net, b = snaps[k + 1].net;
      return { W: a.W.map(function (L, l) { return L.map(function (row, j) { return row.map(function (w, i) { return lerp(w, b.W[l][j][i], u); }); }); }) };
    }
    function passAt(t) { return t < T.start ? -1 : Math.min(snaps.length - 1, Math.floor((t - T.start) / PASS)); }
    function epochIndex(t) {
      var k = passAt(t);
      if (k < 0) return 0;
      return k < snaps.length - 1 && t - T.start - k * PASS >= GAPS[3] ? k + 1 : k;
    }
    return {
      id: 'network', defaultSeed: 1,
      init: function (stage) { g = stage; },
      reset: function (seed) {
        clear(g);
        var run = makeRun(seed);
        snaps = run.snaps;
        // One example per pass, alternating the two classes so both outputs get used. Each neuron's pulse comes
        // from its strongest incoming signal (largest |weight x activation|), so only the paths that matter move.
        samples = snaps.map(function (s, k) {
          var pool = run.data.x.map(function (_, i) { return i; }).filter(function (i) { return run.data.y[i] === k % 2; });
          var i = pool[Math.floor(run.r() * pool.length)], a = forward(s.net, run.data.x[i]);
          var from = s.net.W.map(function (L, l) {
            return L.map(function (row) {
              var best = 0;
              row.forEach(function (w, n) { if (Math.abs(w * a[l][n]) > Math.abs(row[best] * a[l][best])) best = n; });
              return best;
            });
          });
          // Activations keep their sign: inputs scaled into [-1, 1], tanh in [-1, 1], softmax outputs in [0, 1]. The
          // disc's radius is the size, snapped to the nearest of three settings: empty, half or full.
          var size = a.map(function (layer, l) {
            return layer.map(function (v) { var x = l === 0 ? Math.max(-1, Math.min(1, v / 1.5)) : v; return Math.sign(x) * snapRadius(Math.abs(x)); });
          });
          return { y: run.data.y[i], a: a, from: from, size: size, pred: a[3][1] > a[3][0] ? 1 : 0 };
        });
        maxW = 0;
        snaps[snaps.length - 1].net.W.forEach(function (L) { L.forEach(function (row) { row.forEach(function (w) { maxW = Math.max(maxW, Math.abs(w)); }); }); });
        neuronXY = SIZES.map(function (n, l) { return rows(n).map(function (y) { return [X[l], y]; }); });
        var le = el('g', {}, g), lp = el('g', {}, g), ln = el('g', {}, g);
        edges = []; pulses = [];
        for (var l = 0; l < 3; l++) {
          edges.push([]); pulses.push([]);
          for (var j = 0; j < SIZES[l + 1]; j++) for (var i = 0; i < SIZES[l]; i++) {
            var p = neuronXY[l][i], q = neuronXY[l + 1][j];
            edges[l].push({ l: l, j: j, i: i, e: el('line', { 'class': 'viz-edge', x1: p[0] + R, y1: p[1], x2: q[0] - R, y2: q[1] }, le) });
          }
          for (var t2 = 0; t2 < SIZES[l + 1]; t2++) {
            pulses[l].push(el('circle', { 'class': 'viz-signal', r: 1.1, display: 'none' }, lp));
          }
        }
        acts = neuronXY.map(function (layer) {
          return layer.map(function (p) {
            // Paper, then the activation disc, then the outline on top, so a full disc never thins the outline.
            el('circle', { 'class': 'viz-neuron-bg', cx: p[0], cy: p[1], r: R }, ln);
            var act = el('circle', { 'class': 'viz-act', cx: p[0], cy: p[1], r: 0 }, ln);
            el('circle', { 'class': 'viz-neuron', cx: p[0], cy: p[1], r: R }, ln);
            return act;
          });
        });
        inMark = el('polygon', { 'class': 'viz-pt', points: pointsAttr(IN_DOT, [5.5, 50]) }, ln);
        outMarks = [0, 1].map(function (k) { return mark(CLS[k], [95, rows(2)[k]], 1.6, ln); });
        return T.run;
      },
      render: function (t) {
        var net = weightsAt(t);
        edges.forEach(function (L) {
          L.forEach(function (ed) {
            var w = net.W[ed.l][ed.j][ed.i];
            ed.e.setAttribute('class', 'viz-edge' + (w < 0 ? ' viz-neg' : '') + tierClass(weightTier(w)));
          });
        });
        var k = passAt(t), tau = k < 0 ? -1 : t - T.start - k * PASS, s = k < 0 ? null : samples[k], prev = k > 0 ? samples[k - 1] : null;
        // The input mark morphs from the last example's shape (or a dot) to this one's, taking its colour halfway.
        var u = s ? easeInOut(ramp(tau, 0, INPUT)) : 0;
        var fromShape = prev ? IN_SHAPE[CLS[prev.y]] : IN_DOT, fromCls = prev ? CLS[prev.y] : -1;
        var cls = s && u >= 0.5 ? CLS[s.y] : fromCls;
        inMark.setAttribute('class', 'viz-pt' + (cls < 0 ? '' : ' viz-k' + cls));
        inMark.setAttribute('points', pointsAttr(s ? lerpPts(fromShape, IN_SHAPE[CLS[s.y]], u) : IN_DOT, [5.5, 50]));
        // Each neuron's disc eases from its last activation to the new one as the signal reaches its layer: its radius
        // is the activation's size on three settings (not shade, so it stays a palette colour), blue when positive and
        // concrete when negative, like the weights. A change of sign shrinks through zero. Nothing empties between
        // passes.
        acts.forEach(function (layer, l) {
          var arrive = l === 0 ? INPUT / 2 : GAPS[l], v = s ? easeInOut(ramp(tau, arrive - 80 * S, GROW)) : 0;
          layer.forEach(function (c, j) {
            var a = prev ? prev.size[l][j] : 0, b = s ? s.size[l][j] : 0;
            var x = lerp(a, b, v);
            c.setAttribute('r', fmt((R - 0.3) * Math.abs(x)));
            c.setAttribute('class', x < 0 ? 'viz-act viz-neg' : 'viz-act');
          });
        });
        // One small blue circle per receiving neuron, along its strongest incoming connection; it swells in and out.
        pulses.forEach(function (L, l) {
          var f = s ? (tau - GAPS[l]) / (GAPS[l + 1] - GAPS[l]) : -1;
          L.forEach(function (pu, j) {
            vis(pu, f > 0 && f < 1);
            if (f <= 0 || f >= 1) return;
            var p = neuronXY[l][s.from[l][j]], q = neuronXY[l + 1][j], e = easeInOut(f);
            place(pu, lerp(p[0] + R, q[0] - R, e), lerp(p[1], q[1], e), 0, Math.sqrt(Math.sin(Math.PI * f)));
          });
        });
        // The output keeps the last prediction until the new one arrives.
        var pred = s && tau >= GAPS[3] - 60 * S ? s.pred : prev ? prev.pred : -1;
        outMarks.forEach(function (m, c) { m.setAttribute('class', 'viz-pt viz-k' + CLS[c] + (pred === c ? '' : ' viz-off')); });
      },
      status: function (t) {
        var s = snaps[epochIndex(t)];
        return 'epoch ' + s.epoch + ' · acc ' + Math.round(s.acc * 100) + '%';
      },
      destroy: function () { if (g) clear(g); snaps = samples = edges = acts = pulses = inMark = outMarks = null; }
    };
  })();

  // ---- 5. Attention: dot-product attention over the tokens of a sentence, then over image patches ----
  // Nothing here is trained: the query and key projections are fixed by hand, so that head 1 looks at the previous
  // token (or nearby patches), head 2 at a related kind of word (or patches of the same colour), and head 3 at the
  // verb (or every patch with a shape in it). The weights are the real softmax(q · k / sqrt(d)) of those vectors.
  var attention = (function () {
    var WORDS = ['the', 'cat', 'stole', 'the', 'warm', 'seat'], KINDS = [0, 1, 2, 0, 3, 1], SHORT = [1, 2, 4, 5];
    // The two query tokens, in the full sentence and in the short one: the subject and the adjective, then the
    // adjective and its noun. Neither is a token whose heads mostly look at itself (the verb, the only one of its
    // kind, or the first token, with nothing before it), and together they give short and long arcs.
    var QUERIES = [1, 4], SHORT_QUERIES = [2, 3];
    // How much a query of each kind (det, noun, verb, adj) looks for a key of each kind.
    var RELATED = [[0, 1, 0, 0], [1, 0, 0, 1.5], [0, 0, 1.5, 0], [0, 1, 0, 0]], VERB = [[0, 0, 2, 0], [0, 0, 2, 0], [0, 1.2, 0, 0], [0, 0, 2, 0]];
    var B = stepLen(1), SEG = B * 3 / 32, MORPH = B * 7 / 64, FINAL = B * 9 / 64;
    var PS = 9, PG = 1.2, GW = 4 * PS + 3 * PG, GX = 50 - GW / 2, GY = 15;
    // The patches also lie flat as a sequence of 16, the way a vision transformer reads them, each marked with its class.
    var RS = 4.8, RG = 0.6, RX = 50 - (16 * RS + 15 * RG) / 2, RY = 85;
    var g, narrow, words, toks, patches, cells, cellMarks, comp, lifts, segs, legend, ptr, keys, n, TS, TY, tx, pc, rc, qPatch, MS;
    var LIFT = 1.5;

    function onehot(k, size) { var v = []; for (var i = 0; i < size; i++) v.push(i === k ? 1 : 0); return v; }
    function attend(qs, ks) {
      var d = qs[0].length;
      return qs.map(function (q) { return softmax(ks.map(function (k) { return dot(q, k) / Math.sqrt(d); })); });
    }
    // Text: each token is its kind (one-hot) plus a position on a circle; three heads, each a query and key projection.
    function textHeads(kinds) {
      var W = 0.9, W2 = 0.6;
      return [
        attend(kinds.map(function (_, i) { return [0, 0, 0, 0, 10 * Math.cos(W * (i - 1)), 10 * Math.sin(W * (i - 1))]; }),
               kinds.map(function (_, j) { return [0, 0, 0, 0, Math.cos(W * j), Math.sin(W * j)]; })),
        attend(kinds.map(function (k, i) { return RELATED[k].map(function (q) { return 7.5 * q; }).concat([3 * Math.cos(W2 * i), 3 * Math.sin(W2 * i)]); }),
               kinds.map(function (k, j) { return onehot(k, 4).concat([Math.cos(W2 * j), Math.sin(W2 * j)]); })),
        attend(kinds.map(function (k) { return VERB[k].map(function (q) { return 7.5 * q; }).concat([0, 0]); }),
               kinds.map(function (k) { return onehot(k, 4).concat([0, 0]); }))
      ];
    }
    // The image: a red square, a blue circle and a yellow triangle in grid units [0, 4], cut into 4 x 4 patches.
    // Each patch is the colour that covers at least 30% of it (sampled), or paper.
    function inside(s, u, v) {
      if (s === 1) return u >= 0.3 && u <= 1.9 && v >= 0.3 && v <= 1.9;
      if (s === 2) return (u - 2.9) * (u - 2.9) + (v - 1.2) * (v - 1.2) <= 0.9;
      var a = [0.4, 3.75], b = [2.6, 3.75], c = [1.5, 2.15];
      function side(p, q) { return (q[0] - p[0]) * (v - p[1]) - (q[1] - p[1]) * (u - p[0]); }
      var s1 = side(a, b), s2 = side(b, c), s3 = side(c, a);
      return (s1 <= 0 && s2 <= 0 && s3 <= 0) || (s1 >= 0 && s2 >= 0 && s3 >= 0);
    }
    function patchColours() {
      var out = [], cover = [];
      for (var i = 0; i < 16; i++) {
        var col = i % 4, row = Math.floor(i / 4), cnt = [0, 0, 0, 0];
        for (var a = 0; a < 8; a++) for (var b = 0; b < 8; b++) {
          for (var s = 1; s <= 3; s++) if (inside(s, col + (a + 0.5) / 8, row + (b + 0.5) / 8)) cnt[s]++;
        }
        var best = 1;
        for (var s2 = 2; s2 <= 3; s2++) if (cnt[s2] > cnt[best]) best = s2;
        out.push(cnt[best] >= 0.3 * 64 ? best : 0);
        cover.push(cnt);
      }
      return { colour: out, cover: cover };
    }
    function patchHeads(colour) {
      var W = 0.8, pos = function (i) { var x = i % 4, y = Math.floor(i / 4); return [Math.cos(W * x), Math.sin(W * x), Math.cos(W * y), Math.sin(W * y)]; };
      var ks = colour.map(function (c, j) { return onehot(c, 4).concat(pos(j)); });
      return [
        attend(colour.map(function (_, i) { return [0, 0, 0, 0].concat(pos(i).map(function (q) { return 8 * q; })); }), ks),
        attend(colour.map(function (c) { return onehot(c, 4).map(function (q) { return 9 * q; }).concat([0, 0, 0, 0]); }), ks),
        attend(colour.map(function () { return [0, 9, 9, 9, 0, 0, 0, 0]; }), ks)
      ];
    }
    // An arc's step compares its weight with an even share (1/n of n keys), so 6 tokens and 16 patches read alike:
    // strong from 2.5 shares, medium from 1.2, weak from 0.3, and below that no arc.
    function arcTier(w, n) { var r = w * n; return r >= 2.5 ? 3 : r >= 1.2 ? 2 : r >= 0.3 ? 1 : 0; }
    // Every arc is a semicircle rising above the row, from the query to a key.
    function arcPath(p, q) {
      var r = Math.abs(q[0] - p[0]) / 2;
      return 'M' + fmt(p[0]) + ' ' + fmt(p[1]) + 'A' + fmt(r) + ' ' + fmt(r) + ' 0 0 ' + (q[0] > p[0] ? 1 : 0) + ' ' + fmt(q[0]) + ' ' + fmt(q[1]);
    }
    // Arcs fade in, hold, and fade out before the next head; the last segment holds.
    function growth(s, t) {
      var u = easeInOut(ramp(t, s.start, 0.3 * s.len));
      return s.last ? u : u * (1 - easeInOut(ramp(t, s.start + 0.8 * s.len, 0.2 * s.len)));
    }
    function segAt(t) { var s = null; segs.forEach(function (q) { if (t >= q.start) s = q; }); return s; }
    return {
      id: 'attention', defaultSeed: 1, narrow: true,
      init: function (stage) { g = stage; },
      reset: function () {
        clear(g);
        narrow = narrowMq.matches;
        words = narrow ? SHORT.map(function (i) { return WORDS[i]; }) : WORDS;
        var kinds = narrow ? SHORT.map(function (i) { return KINDS[i]; }) : KINDS;
        n = words.length; TS = narrow ? 18 : 12; TY = narrow ? 58 : 60;
        var gap = narrow ? 4 : 2.5, x0 = 50 - (n * TS + (n - 1) * gap) / 2;
        tx = words.map(function (_, i) { return x0 + i * (TS + gap); });
        var tq = narrow ? SHORT_QUERIES : QUERIES, th = textHeads(kinds), pcl = patchColours(), ph = patchHeads(pcl.colour);
        pc = [];
        rc = [];
        for (var i = 0; i < 16; i++) {
          pc.push([GX + (i % 4) * (PS + PG) + PS / 2, GY + Math.floor(i / 4) * (PS + PG) + PS / 2]);
          rc.push([RX + i * (RS + RG) + RS / 2, RY + RS / 2]);
        }
        // The query patch: the blue patch nearest the middle, so its arcs spread both ways.
        qPatch = -1;
        pcl.colour.forEach(function (c, i) { if (c === 2 && (qPatch < 0 || d2(pc[i], [50, GY + GW / 2]) < d2(pc[qPatch], [50, GY + GW / 2]))) qPatch = i; });
        var lc = el('g', {}, g), lk = el('g', {}, g), la = el('g', {}, g), lt = el('g', {}, g);
        toks = words.map(function (w, i) {
          var r = el('rect', { 'class': 'viz-token', x: fmt(tx[i]), y: fmt(TY), width: TS, height: TS }, lk);
          return { r: r, l: label(lk, w, tx[i] + TS / 2, TY + TS / 2, narrow ? 'viz-lg' : '') };
        });
        // The image, clipped to the patches so the gaps between them cut it up.
        var cp = el('clipPath', { id: 'viz-clip-patches' }, lc);
        pc.forEach(function (c) { el('rect', { x: fmt(c[0] - PS / 2), y: fmt(c[1] - PS / 2), width: PS, height: PS }, cp); });
        comp = el('g', { 'clip-path': 'url(#viz-clip-patches)', display: 'none' }, lc);
        var u = GW / 4, at = function (q) { return [GX + q[0] * u, GY + q[1] * u]; };
        function image(parent) {
          var sq = at([0.3, 0.3]), cc = at([2.9, 1.2]);
          el('rect', { 'class': 'viz-k0', x: fmt(sq[0]), y: fmt(sq[1]), width: fmt(1.6 * u), height: fmt(1.6 * u) }, parent);
          el('circle', { 'class': 'viz-k1', cx: fmt(cc[0]), cy: fmt(cc[1]), r: fmt(Math.sqrt(0.9) * u) }, parent);
          el('polygon', { 'class': 'viz-k2', points: polyAttr([at([0.4, 3.75]), at([2.6, 3.75]), at([1.5, 2.15])]) }, parent);
        }
        image(comp);
        patches = pc.map(function () { return el('rect', { 'class': 'viz-patch', display: 'none' }, lk); });
        cells = rc.map(function () { return el('rect', { 'class': 'viz-patch', display: 'none' }, lk); });
        cellMarks = pcl.colour.map(function (c, i) { return c ? mark(c - 1, rc[i], 1, lk) : null; });
        cellMarks.forEach(function (m) { if (m) vis(m, false); });
        // The query patch lifts up and left off an ink shadow once the grid has landed, the way a card lifts on hover:
        // it is the one patch that weighs the others. The lifted copy is paper, its piece of the image, its outline.
        // In the row, the small cells are marked by the yellow triangle instead.
        function square(c, w, cls, parent) { return el('rect', { 'class': cls, x: fmt(c[0] - w / 2), y: fmt(c[1] - w / 2), width: fmt(w), height: fmt(w) }, parent); }
        var gq = pc[qPatch], qcp = el('clipPath', { id: 'viz-clip-qpatch' }, lc);
        square(gq, PS, '', qcp);
        lifts = [{ at: 0.55 * MORPH, sh: square(gq, PS, 'viz-shadow', lk), g: el('g', {}, lk) }];
        square(gq, PS, 'viz-paper', lifts[0].g);
        image(el('g', { 'clip-path': 'url(#viz-clip-qpatch)' }, lifts[0].g));
        square(gq, PS, 'viz-patch', lifts[0].g);
        vis(lifts[0].sh, false); vis(lifts[0].g, false);
        // Segments: two text queries through each head in turn, the morph into patches, then the three heads in turn
        // on one patch query, the last one holding.
        segs = [];
        var at0 = T.start, top = function (i) { return [tx[i] + TS / 2, TY - 0.6]; }, cellTop = function (i) { return [rc[i][0], RY - 0.4]; };
        tq.forEach(function (q) {
          [0, 1, 2].forEach(function (h) {
            var arcs = [];
            // A token's weight on itself isn't drawn: its loop would be a dot over its own square.
            words.forEach(function (_, j) { var k = arcTier(th[h][q][j], n); if (j !== q && k) arcs.push({ k: k, d: arcPath(top(q), top(j)) }); });
            segs.push({ kind: 'text', start: at0, len: SEG, heads: [h], q: q, arcs: arcs });
            at0 += SEG;
          });
        });
        MS = at0;
        segs.push({ kind: 'morph', start: MS, len: MORPH, heads: [] });
        at0 += MORPH;
        [[0], [1], [2]].forEach(function (hs, k) {
          var arcs = [];
          // The query patch's weight on itself is left out: in a row of 16 its loop would hide the arcs beside it.
          hs.forEach(function (h) { pc.forEach(function (c, j) { var t = arcTier(ph[h][qPatch][j], 16); if (j !== qPatch && t) arcs.push({ k: t, d: arcPath(cellTop(qPatch), cellTop(j)) }); }); });
          segs.push({ kind: 'patch', start: at0, len: k === 2 ? FINAL : SEG, heads: hs, q: qPatch, arcs: arcs, last: k === 2 });
          at0 += k === 2 ? FINAL : SEG;
        });
        segs.forEach(function (s) {
          (s.arcs || []).forEach(function (a) { a.e = el('path', { 'class': 'viz-arc' + tierClass(a.k), d: a.d, display: 'none' }, la); });
        });
        // Three small token boxes, one per head, top left; the head at work turns ink.
        legend = [0, 1, 2].map(function (h) {
          var b = narrow ? 5 : 4, x = 6 + h * (b + 1.6);
          return el('rect', { 'class': 'viz-token', x: fmt(x), y: fmt(7 - b / 2), width: b, height: b }, lt);
        });
        ptr = pointer(lt);
        // Where the yellow triangle points: under each text query, then under the query patch.
        keys = [{ t: T.start, p: [tx[tq[0]] + TS / 2, TY + TS + 3.4], len: 250 }, { t: T.start + 3 * SEG, p: [tx[tq[1]] + TS / 2, TY + TS + 3.4], len: 250 },
          { t: MS, p: [rc[qPatch][0], RY + RS + 2.6], len: MORPH }];
        return T.run;
      },
      render: function (t) {
        var s = segAt(t);
        var tq = t < T.start ? -1 : t < T.start + 3 * SEG ? segs[0].q : segs[3].q, to = 1 - ramp(t, MS, 200);
        toks.forEach(function (k, i) {
          fade(k.r, to); fade(k.l, to);
          var q = i === tq;
          k.r.setAttribute('class', q ? 'viz-token viz-q' : 'viz-token');
          k.l.setAttribute('class', 'viz-label' + (narrow ? ' viz-lg' : '') + (q ? ' viz-inv' : ''));
        });
        // Patches split off the tokens and settle into the grid, then drop out of it into the row; the image shows as
        // the grid lands, and the row's marks once it lands.
        var u = easeInOut(ramp(t, MS, 0.5 * MORPH));
        function square(e, c, w) {
          e.setAttribute('x', fmt(c[0] - w / 2)); e.setAttribute('y', fmt(c[1] - w / 2));
          e.setAttribute('width', fmt(w)); e.setAttribute('height', fmt(w));
        }
        patches.forEach(function (e, i) {
          vis(e, t >= MS);
          if (t < MS) return;
          var k = i % n;
          square(e, lerpPts([[tx[k] + TS / 2, TY + TS / 2]], [pc[i]], u)[0], lerp(TS, PS, u));
        });
        // The row fills in reading order, one patch after another, each showing its mark as it lands.
        cells.forEach(function (e, i) {
          var v = easeInOut(ramp(t, MS + (0.5 + 0.3 * i / 15) * MORPH, 0.2 * MORPH));
          vis(e, v > 0);
          if (cellMarks[i]) fade(cellMarks[i], v >= 1 ? 1 : 0);
          if (v <= 0) return;
          square(e, lerpPts([pc[i]], [rc[i]], v)[0], lerp(PS, RS, v));
        });
        fade(comp, ramp(t, MS + 0.3 * MORPH, 0.3 * MORPH));
        lifts.forEach(function (lf) {
          var l = ease(ramp(t, MS + lf.at, 200));
          vis(lf.sh, l > 0); vis(lf.g, l > 0);
          if (l > 0) place(lf.g, -LIFT * l, -LIFT * l);
        });
        segs.forEach(function (sg) {
          if (!sg.arcs) return;
          var gr = t < sg.start ? 0 : growth(sg, t);
          sg.arcs.forEach(function (a) { fade(a.e, gr); });
        });
        var active = s && s.heads.length ? s.heads : [0, 1, 2];
        legend.forEach(function (m, h) {
          var on = s && s.heads.length && active.indexOf(h) >= 0;
          m.setAttribute('class', on ? 'viz-token viz-q' : 'viz-token');
        });
        if (t < T.start) { vis(ptr, false); return; }
        var p = keys[0].p;
        keys.forEach(function (k, i) { if (i && t >= k.t) p = lerpPts([keys[i - 1].p], [k.p], easeInOut(ramp(t, k.t, k.len)))[0]; });
        vis(ptr, true);
        place(ptr, p[0], p[1]);
      },
      status: function (t) {
        var s = t < T.start ? null : segAt(t);
        if (!s) return n + ' tokens · 3 heads';
        if (s.kind === 'morph') return '16 patches · 3 heads';
        if (s.kind === 'text') return 'head ' + (s.heads[0] + 1) + ' · query ' + (s.q + 1) + '/' + n;
        return 'head ' + (s.heads[0] + 1) + ' · patch ' + (s.q + 1) + '/16';
      },
      destroy: function () { if (g) clear(g); toks = patches = cells = cellMarks = comp = lifts = segs = legend = ptr = keys = null; }
    };
  })();

  // ---- 6. Embedding retrieval: the five documents nearest a query, by Euclidean distance ----
  var retrieval = (function () {
    // Each query: it drops in (DROP), the search circle grows (GROW), then the query's ring travels to the nearest
    // document (FIND) and stays round it, and the query fades before the next (OUT).
    var SIZES = [13, 12, 11], K = 5, QUERIES = 3, Q = stepLen(QUERIES), DROP = 300, GROW = 900, LIT = 150, FIND = 350, OUT = 280;
    var P = { x: 0, y: 0, w: 100, h: 100 }, SD = 7, SEP = 34, HIT_GAP = 5.4;
    var g, docs, topic, queries;

    function clampTo(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    // Three loose topical clusters in the plot; each query lands near a different one. Distances are in frame units,
    // and the embedding's own units are a tenth of those.
    function sample(r) {
      var gauss = gaussFn(r), c, ok, tries = 0;
      do {
        c = [0, 1, 2].map(function () { return [P.x + 16 + r() * (P.w - 32), P.y + 14 + r() * (P.h - 28)]; });
        ok = d2(c[0], c[1]) >= SEP * SEP && d2(c[0], c[2]) >= SEP * SEP && d2(c[1], c[2]) >= SEP * SEP;
      } while (!ok && ++tries < 500);
      // Documents keep HIT_GAP apart, so no two marks, and no two hit rings, overlap.
      var x = [], y = [];
      SIZES.forEach(function (m, k) {
        var sx = SD + r() * 1.5, sy = SD + r() * 1.5;
        for (var i = 0, n = 0; i < m && n < 400; n++) {
          var p = [clampTo(c[k][0] + gauss() * sx, P.x + PAD, P.x + P.w - PAD), clampTo(c[k][1] + gauss() * sy, P.y + PAD, P.y + P.h - PAD)];
          if (x.some(function (q) { return d2(p, q) < HIT_GAP * HIT_GAP; })) continue;
          x.push(p); y.push(k); i++;
        }
      });
      var order = [0, 1, 2];
      for (var i = 2; i > 0; i--) { var j = Math.floor(r() * (i + 1)), tmp = order[i]; order[i] = order[j]; order[j] = tmp; }
      var qs = order.map(function (k) {
        // The query lands in a gap near the cluster, at least 5 units from every document.
        var q;
        for (var n = 0; n < 60; n++) {
          q = [clampTo(c[k][0] + gauss() * 4, P.x + 8, P.x + P.w - 8), clampTo(c[k][1] + gauss() * 4, P.y + 8, P.y + P.h - 8)];
          if (x.every(function (p) { return d2(p, q) >= 25; })) break;
        }
        var ranked = x.map(function (p, i) { return { i: i, d: Math.sqrt(d2(p, q)) }; }).sort(function (a, b) { return a.d - b.d; });
        // The search circle stops between the fifth and sixth documents, so it holds exactly the five hits.
        return { p: q, hits: ranked.slice(0, K), R: (ranked[K - 1].d + Math.min(ranked[K].d, 1.15 * ranked[K - 1].d)) / 2, gap: ranked[K].d - ranked[K - 1].d };
      });
      return { x: x, y: y, queries: qs };
    }
    // Skip seeds whose hits sit too far out for the circle, where the fifth and sixth documents nearly tie, or where
    // the query or its hits crowd each other so their rings and ranks would overlap.
    function readable(q, x) {
      if (q.hits[0].d < 5 || q.hits[K - 1].d > 20 || q.gap < 0.6) return false;
      return q.hits.every(function (a, i) { return q.hits.every(function (b, j) { return i >= j || d2(x[a.i], x[b.i]) >= HIT_GAP * HIT_GAP; }); });
    }
    function makeRun(seed) {
      var d;
      for (var tries = 0; tries < 300; tries++, seed++) {
        d = sample(rng(seed));
        if (d.queries.every(function (q) { return readable(q, d.x); })) break;
      }
      docs = d.x; topic = d.y; queries = d.queries;
    }
    return {
      id: 'retrieval', defaultSeed: 1,
      init: function (stage) { g = stage; },
      reset: function (seed) {
        clear(g);
        makeRun(seed);
        var lc = el('g', {}, g), ld = el('g', {}, g), lh = el('g', {}, g);
        docs.forEach(function (p, i) { mark(topic[i], p, 1, ld); });
        queries.forEach(function (q) {
          q.g = [el('g', { display: 'none' }, lc), el('g', { display: 'none' }, lh)];
          q.circle = el('circle', { 'class': 'viz-search', cx: fmt(q.p[0]), cy: fmt(q.p[1]), r: 0 }, q.g[0]);
          // Each hit: an ink ring and a connector from the query, solid for the nearest, dashed for the next two and
          // dotted for the last two, so the connectors read as the ranking.
          q.rows = q.hits.map(function (hit, k) {
            var p = docs[hit.i], row = { at: DROP + GROW * hit.d / q.R, to: p };
            row.link = el('line', { 'class': 'viz-hit' + tierClass(k === 0 ? 3 : k < 3 ? 2 : 1), x1: fmt(q.p[0]), y1: fmt(q.p[1]), x2: fmt(q.p[0]), y2: fmt(q.p[1]) }, q.g[0]);
            row.ring = ring(q.g[1], p);
            return row;
          });
          // The query: an ink ring round an ink dot (not a yellow triangle, which a document can be). Once the search
          // is done the ring travels to the nearest document, the answer, and stays round it; the dot stays put.
          q.dot = el('circle', { 'class': 'viz-dot', r: 0.9 }, q.g[1]);
          q.mark = el('circle', { 'class': 'viz-qring', r: 3.6 }, q.g[1]);
          q.found = docs[q.hits[0].i];
        });
        return T.run;
      },
      render: function (t) {
        queries.forEach(function (q, k) {
          var tau = t - T.start - k * Q, o = tau < 0 ? 0 : k < QUERIES - 1 ? 1 - ramp(tau, Q - OUT, OUT) : 1;
          q.g.forEach(function (e) { fade(e, o); });
          if (o <= 0) return;
          var u = ease(ramp(tau, 0, DROP)), r = q.R * ramp(tau, DROP, GROW), at = [q.p[0], q.p[1] - 8 * (1 - u)];
          place(q.dot, at[0], at[1]);
          q.dot.setAttribute('opacity', fmt(u));
          q.circle.setAttribute('r', fmt(r));
          vis(q.circle, r > 0);
          // A document lights up the moment the circle reaches it, so the order on screen is the ranking.
          q.rows.forEach(function (row) {
            var lit = ramp(tau, row.at, LIT), grow = ease(ramp(tau, row.at, 250));
            fade(row.ring, lit); fade(row.link, lit);
            row.link.setAttribute('x2', fmt(lerp(q.p[0], row.to[0], grow))); row.link.setAttribute('y2', fmt(lerp(q.p[1], row.to[1], grow)));
          });
          var f = easeInOut(ramp(tau, DROP + GROW + 100, FIND)), p = lerpPts([at], [q.found], f)[0];
          place(q.mark, p[0], p[1]);
          q.mark.setAttribute('opacity', fmt(u));
        });
      },
      status: function (t) {
        if (t < T.start) return docs.length + ' docs · top-5 · L2';
        return 'query ' + Math.min(QUERIES, Math.floor((t - T.start) / Q) + 1) + ' · top-5 · L2';
      },
      destroy: function () { if (g) clear(g); docs = topic = queries = null; }
    };
  })();

  // ---- The gallery: tabs, controls, the clock, the wipe between models ----
  var MODELS = [kmeans, boost, logreg, network, attention, retrieval];
  var tabs = Array.prototype.slice.call(gallery.querySelectorAll('[role="tab"]'));
  var caps = Array.prototype.slice.call(gallery.querySelectorAll('.g-cap'));
  var bars = tabs.map(function (b) { return b.querySelector('.g-prog'); });
  var panel = gallery.querySelector('[role="tabpanel"]');
  var stage = gallery.querySelector('.g-stage');
  var art = gallery.querySelector('.art');
  var statusEl = gallery.querySelector('.g-status');
  var wipeEl = gallery.querySelector('.g-wipe i');
  var live = gallery.querySelector('[aria-live]');
  var playBtn = gallery.querySelector('.g-play');
  var seen = MODELS.map(function () { return false; });
  var idx = 0, t = 0, dur = 0, seed = 0, lastStatus = '';
  var playing = !reduce, hovered = false, focused = false, onscreen = true;
  var raf = 0, lastNow = 0, wipeT = -1, wipeTo = -1, wipeUser = false, swapped = false;
  gallery.hidden = false;

  function active() { return playing && onscreen && !document.hidden && !reduce; }
  function say(text) { if (text !== lastStatus) { statusEl.textContent = text; lastStatus = text; } }
  function draw() {
    var m = MODELS[idx], tt = Math.min(t, dur);
    m.render(tt);
    say(m.status(tt));
    bars[idx].style.transform = 'scaleX(' + Math.min(1, t / (dur + T.hold)).toFixed(4) + ')';
  }
  // Show model i from its start (or its end state under reduced motion). First visits use the default seed.
  function show(i, announce) {
    MODELS[idx].destroy();
    bars[idx].style.transform = 'scaleX(0)';
    idx = i;
    var m = MODELS[i];
    seed = seen[i] && !reduce ? (Date.now() % 100000) + 1 : m.defaultSeed;
    seen[i] = true;
    m.init(stage);
    dur = m.reset(seed);
    t = reduce ? dur : 0;
    select(i);
    if (announce) live.textContent = caps[i].textContent;
    draw();
  }
  // The model being moved to during a wipe, else the one showing: arrows and keys count from it, so a quick
  // second press doesn't count from the model still under the wipe.
  function current() { return wipeT >= 0 ? wipeTo : idx; }
  // Narrow screens show only some of the tabs (the stylesheet hides the rest), and every move steps through the
  // ones shown. From a hidden model, the step lands on the nearest shown one in that direction.
  function shown() { return tabs.map(function (b, k) { return k; }).filter(function (k) { return getComputedStyle(tabs[k]).display !== 'none'; }); }
  function step(from, d) {
    var s = shown(), at = s.indexOf(from);
    if (at < 0) { at = 0; while (at < s.length && s[at] < from) at++; if (d > 0) at--; }
    return s[(at + d + s.length) % s.length];
  }
  function select(i) {
    tabs.forEach(function (b, k) {
      b.setAttribute('aria-selected', String(k === i));
      b.tabIndex = k === i ? 0 : -1;
    });
    caps.forEach(function (c, k) { c.hidden = k !== i; });
    panel.setAttribute('aria-labelledby', tabs[i].id);
  }
  // Move to model i: a red panel wipes across the frame, and the next model appears behind it.
  // A user's choice selects its tab at once; the drawing swaps when the panel covers the frame.
  function go(i, user) {
    if (user) { live.textContent = ''; select(i); }
    if (reduce) { show(i, user); return; }
    if (wipeT >= 0 && swapped) { wipeTo = i; show(i, user); return; }
    wipeTo = i; wipeUser = user;
    if (wipeT < 0) { wipeT = 0; swapped = false; }
    kick();
  }
  function frame(now) {
    raf = 0;
    var dt = Math.min(64, now - lastNow);
    lastNow = now;
    if (wipeT >= 0) {
      wipeT += dt;
      var half = T.wipe / 2;
      if (!swapped && wipeT >= half) { show(wipeTo, wipeUser); swapped = true; }
      var x = wipeT < half ? -101 + 101 * ease(wipeT / half) : 101 * ease(Math.min(1, (wipeT - half) / half));
      wipeEl.style.transform = 'translateX(' + x.toFixed(2) + '%)';
      if (wipeT >= T.wipe) { wipeT = -1; wipeEl.style.transform = ''; }
    } else if (active()) {
      var was = t;
      t += dt;
      // Hovering or focusing the gallery holds it on the end state instead of moving on.
      if ((hovered || focused) && t > dur) t = Math.max(was, dur);
      if (t !== was) draw();
      if (t >= dur + T.hold) go(step(idx, 1), false);
    }
    kick();
  }
  function kick() {
    if (raf || !(active() || wipeT >= 0)) return;
    lastNow = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function setPlaying(on) {
    playing = on;
    playBtn.classList.toggle('is-paused', !on);
    playBtn.setAttribute('aria-label', on ? 'Pause the gallery' : 'Play the gallery');
    kick();
  }

  tabs.forEach(function (b, k) {
    b.addEventListener('click', function () { if (k !== current() || wipeT >= 0) go(k, true); else { show(k, true); kick(); } });
  });
  gallery.querySelector('.g-prev').addEventListener('click', function () { go(step(current(), -1), true); });
  gallery.querySelector('.g-next').addEventListener('click', function () { go(step(current(), 1), true); });
  playBtn.addEventListener('click', function () { setPlaying(!playing); });
  gallery.addEventListener('keydown', function (e) {
    var to = e.key === 'ArrowRight' ? step(current(), 1) : e.key === 'ArrowLeft' ? step(current(), -1) : null;
    if (e.target.getAttribute('role') === 'tab') {
      if (e.key === 'Home') to = shown()[0];
      if (e.key === 'End') to = shown().pop();
    }
    if (to === null) return;
    e.preventDefault();
    var onTab = e.target.getAttribute('role') === 'tab';
    go(to, true);
    if (onTab) tabs[to].focus();
  });
  // The run holds on its end state while a mouse rests on the drawing, or while keyboard focus is in the gallery.
  // A click or tap on a tab also focuses it, and a tap leaves a hover that never ends, so neither counts: only a
  // real mouse over the frame, and only visible (keyboard) focus.
  function keyboardFocus(e) { try { return e.matches(':focus-visible'); } catch (x) { return false; } }
  art.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') hovered = true; });
  art.addEventListener('pointerleave', function () { hovered = false; });
  gallery.addEventListener('focusin', function (e) { focused = keyboardFocus(e.target); });
  gallery.addEventListener('focusout', function (e) { if (!gallery.contains(e.relatedTarget)) focused = false; });
  // Swipe: a mostly horizontal drag of 40px or more on the frame.
  var down = null;
  art.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY }; });
  art.addEventListener('pointercancel', function () { down = null; });
  art.addEventListener('pointerup', function (e) {
    if (!down) return;
    var dx = e.clientX - down.x, dy = e.clientY - down.y;
    down = null;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > 1.5 * Math.abs(dy)) go(step(current(), dx < 0 ? 1 : -1), true);
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      onscreen = entries[entries.length - 1].isIntersecting;
      kick();
    }).observe(gallery);
  }
  document.addEventListener('visibilitychange', kick);
  // Crossing the breakpoint: a model whose tab is now hidden moves on to the next shown one; models marked narrow lay
  // out differently on narrow screens, so the current one is rebuilt at the same seed and moment.
  narrowMq.addEventListener('change', function () {
    if (shown().indexOf(current()) < 0) { go(step(current(), 1), false); return; }
    var m = MODELS[idx];
    if (!m.narrow) return;
    m.destroy(); m.init(stage); dur = m.reset(seed); draw();
  });
  new MutationObserver(function () {
    var m = MODELS[idx];
    if (m.onThemeChange) m.onThemeChange();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  setPlaying(playing);
  show(0, false);
  kick();
})();
