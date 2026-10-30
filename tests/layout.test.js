'use strict';
// Tests for layout.js (the pure maths behind the tilted 5-fret highway) and the parts of
// highway3d.js that run without WebGL. The Three.js scene itself needs a browser.
// Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
// Run: node --test tests/layout.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const L = require(path.join(__dirname, '..', 'assets', 'layout.js'));
const H = require(path.join(__dirname, '..', 'assets', 'highway3d.js'));

test('colours follow the spec', () => {
    assert.deepEqual(Array.from(L.COLORS.frets), [0x2ecc40, 0xe5322d, 0xf7d117, 0x2f7de1, 0xf28c28]);
    assert.equal(L.COLORS.open, 0xb56cff);
    assert.equal(L.COLORS.overdrive, 0x4aa8ff);
});

test('laneX order and lefty mirror', () => {
    const xs = [0, 1, 2, 3, 4].map(i => L.laneX(i, false));
    for (let i = 1; i < 5; i++) assert.ok(xs[i] > xs[i - 1], 'green on the left, orange on the right');
    assert.equal(xs[2], 0, 'yellow in the middle');
    assert.ok(Math.abs(xs[0] + xs[4]) < 1e-9 && Math.abs(xs[1] + xs[3]) < 1e-9, 'centred');
    assert.ok(Math.abs((xs[1] - xs[0]) - L.TRACK.laneWidth) < 1e-9, 'one lane width apart');
    for (let i = 0; i < 5; i++) assert.equal(L.laneX(i, true), -xs[i], 'lefty mirrors lane ' + i);
    assert.ok(L.laneX(0, true) > L.laneX(4, true), 'lefty: green on the right');
});

test('noteZ: strike line at 0, ahead is negative z, behind is positive', () => {
    assert.equal(L.noteZ(10, 10, 8), 0);
    assert.equal(L.noteZ(11, 10, 8), -8);
    assert.equal(L.noteZ(9.5, 10, 8), 4);
    assert.equal(L.noteZ(10.25, 10, 4), -1);
});

test('gemKind', () => {
    assert.equal(L.gemKind({ t: 0, f: 1 }), 'strum');
    assert.equal(L.gemKind({ t: 0, f: 6 }), 'strum');
    assert.equal(L.gemKind({ t: 0, f: 4, h: true }), 'hopo');
    assert.equal(L.gemKind({ t: 0, f: 4, h: 1 }), 'hopo');
    assert.equal(L.gemKind({ t: 0, f: 8, tap: true }), 'tap');
    assert.equal(L.gemKind({ t: 0, f: 8, tap: true, h: true }), 'tap', 'tap wins over hopo');
    assert.equal(L.gemKind({ t: 0, f: 0 }), 'open');
    assert.equal(L.gemKind({ t: 0 }), 'open', 'missing mask = open');
    assert.equal(L.gemKind({ t: 0, f: 0, h: true }), 'open', 'an open hopo is still drawn as the open bar');
    assert.equal(L.gemKind({ t: 0, f: 32 }), 'open', 'bits above orange ignored');
});

test('visibleWindow binary search', () => {
    const notes = [0, 1, 2, 2, 3, 4, 5, 6, 7, 8].map(t => ({ t, f: 1 }));
    assert.deepEqual(L.visibleWindow(notes, 3, 2, 1), [2, 7], 't in [2, 5]: both chord notes at 2, and 5');
    assert.deepEqual(L.visibleWindow(notes, -10, 1, 1), [0, 0], 'before the chart');
    assert.deepEqual(L.visibleWindow(notes, 100, 1, 1), [10, 10], 'after the chart');
    assert.deepEqual(L.visibleWindow(notes, 4, 100, 100), [0, 10], 'everything');
    assert.deepEqual(L.visibleWindow([], 4, 1, 1), [0, 0]);
    assert.deepEqual(L.visibleWindow(null, 4, 1, 1), [0, 0]);
    // reuses an out array, reads another key (beats use `time`)
    const out = [9, 9];
    const beats = [0, 0.5, 1, 1.5, 2].map((time, i) => ({ time, measure: i % 4 === 0 ? i / 4 : -1 }));
    assert.equal(L.visibleWindow(beats, 1, 0.5, 0.5, out, 'time'), out);
    assert.deepEqual(out, [1, 4]);
    // agrees with a linear scan on a long random chart
    let x = 7;
    const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
    const big = [];
    for (let t = 0; big.length < 500; t += rnd() * 0.3) big.push({ t, f: 1 });
    for (let k = 0; k < 50; k++) {
        const now = rnd() * 80, ahead = rnd() * 3, behind = rnd();
        const lin = [big.findIndex(n => n.t >= now - behind), big.findIndex(n => n.t > now + ahead)]
            .map(i => (i < 0 ? big.length : i));
        assert.deepEqual(L.visibleWindow(big, now, ahead, behind), lin);
    }
});

test('rangeIndexAt finds star power / solo phrases', () => {
    const r = [{ start_time: 1, end_time: 2 }, { start_time: 4, end_time: 6 }];
    assert.equal(L.rangeIndexAt(r, 0.5), -1);
    assert.equal(L.rangeIndexAt(r, 1), 0, 'start inclusive');
    assert.equal(L.rangeIndexAt(r, 1.99), 0);
    assert.equal(L.rangeIndexAt(r, 2), -1, 'end exclusive');
    assert.equal(L.rangeIndexAt(r, 5), 1);
    assert.equal(L.rangeIndexAt(r, 7), -1);
    assert.equal(L.rangeIndexAt([], 1), -1);
    assert.equal(L.rangeIndexAt(undefined, 1), -1);
});

test('isDownbeat: measure >= 0', () => {
    assert.equal(L.isDownbeat({ time: 0, measure: 0 }), true);
    assert.equal(L.isDownbeat({ time: 0, measure: 3 }), true);
    assert.equal(L.isDownbeat({ time: 0, measure: -1 }), false);
    assert.equal(L.isDownbeat({ time: 0 }), false);
    assert.equal(L.isDownbeat({ time: 0, measure: null }), false);
});

test('wobbleX: still without whammy, bounded, moves with time', () => {
    assert.equal(L.wobbleX(-3, 1.2, 0), 0);
    let moved = false;
    for (let z = -10; z <= 0; z += 0.37) {
        const w = L.wobbleX(z, 2, 1);
        assert.ok(Math.abs(w) <= L.TRACK.wobble + 1e-9);
        if (Math.abs(w - L.wobbleX(z, 2.05, 1)) > 1e-6) moved = true;
        assert.ok(Math.abs(L.wobbleX(z, 2, 0.5)) <= L.TRACK.wobble / 2 + 1e-9, 'scales with whammy');
    }
    assert.ok(moved);
    assert.equal(L.wobbleX(-3, 1, 5), L.wobbleX(-3, 1, 1), 'whammy clamped to 1');
});

test('tailSegments: count and length cover the tail', () => {
    assert.deepEqual(L.tailSegments(0), { n: 0, len: 0 });
    const a = L.tailSegments(1);
    assert.ok(a.n >= 1 && Math.abs(a.n * a.len - 1) < 1e-9);
    const b = L.tailSegments(1000);
    assert.equal(b.n, L.TRACK.maxTailSegments, 'capped');
    assert.ok(Math.abs(b.n * b.len - 1000) < 1e-6);
    const out = { n: 0, len: 0 };
    assert.equal(L.tailSegments(2, out), out);
});

test('starFill: 0..5 stars with a fraction, 6 = gold', () => {
    assert.deepEqual(L.starFill(0), { full: 0, frac: 0, gold: false });
    assert.deepEqual(L.starFill(2.5), { full: 2, frac: 0.5, gold: false });
    assert.deepEqual(L.starFill(5), { full: 5, frac: 0, gold: false });
    assert.deepEqual(L.starFill(5.7), { full: 5, frac: 0, gold: false }, 'no sixth star until gold');
    assert.deepEqual(L.starFill(6), { full: 5, frac: 0, gold: true });
    assert.deepEqual(L.starFill(-1), { full: 0, frac: 0, gold: false });
    assert.deepEqual(L.starFill(NaN), { full: 0, frac: 0, gold: false });
});

test('soloPercent', () => {
    assert.equal(L.soloPercent({ active: true, hit: 17, total: 20 }), 85);
    assert.equal(L.soloPercent({ active: true, hit: 2, total: 3 }), 66, 'floors');
    assert.equal(L.soloPercent({ active: true, hit: 0, total: 0 }), 0);
    assert.equal(L.soloPercent(null), 0);
});

test('createView throws a clear error without WebGL2', () => {
    assert.equal(typeof H.createView, 'function');
    assert.throws(() => H.createView({}, { getContext: () => null }), /WebGL2/);
    assert.throws(() => H.createView({}, { getContext: () => null }, { hudCanvas: null }), /WebGL2 is not available/);
    assert.throws(() => H.createView({}, null), /canvas/);
});

test('hudLayout: wide canvases put the score column right of the track and the multiplier left of it', () => {
    const lay = H.hudLayout(1280, 720, { scoreHidden: false, trackLeft: 450, trackRight: 830, strikeY: 620 });
    assert.equal(lay.wide, true);
    assert.equal(lay.showHeader, true);
    assert.ok(lay.header.y > 720 * 0.9 && lay.header.x < 100, 'header tag bottom-left');
    assert.ok(lay.col.x >= 830, 'score column right of the track');
    assert.ok(lay.col.x + lay.col.w <= 1280, 'and on the canvas');
    assert.ok(lay.mult.x + lay.mult.r <= 450, 'multiplier ring left of the track');
    assert.ok(lay.mult.x - lay.mult.r >= 0);
    assert.ok(lay.col.y >= 64 && lay.streakY - 30 * lay.scale >= 64, 'clear of the player chrome along the top');
    assert.ok(lay.meterY < lay.scoreY && lay.scoreY < lay.starsY && lay.starsY < lay.accY && lay.accY < lay.timingY, 'column order');
    assert.ok(lay.timingY + 40 * lay.scale <= 720, 'timing meter on the canvas');
    assert.ok(lay.streakY < lay.streakLabelY && lay.streakLabelY < lay.mult.y && lay.mult.y < lay.fullComboY);
    assert.ok(lay.auto.y + 13 < lay.header.y - 10, 'AUTO CHART box sits above the header text');
});

test('hudLayout: narrow lanes get a compact, scaled HUD in the bottom corners', () => {
    const lay = H.hudLayout(360, 640, { trackLeft: 10, trackRight: 350, strikeY: 560 });
    assert.equal(lay.wide, false);
    assert.equal(lay.compact, true);
    assert.equal(lay.timingY, null, 'no timing meter');
    assert.ok(lay.scale < 1);
    assert.ok(lay.col.x >= 0 && lay.col.x + lay.col.w <= 360);
    assert.ok(lay.col.y + lay.col.h <= 640 && lay.col.y > 320, 'bottom-right');
    assert.ok(lay.mult.x - lay.mult.r >= 0 && lay.mult.x < 180, 'bottom-left');
    assert.ok(lay.fullComboY < lay.auto.y, 'clear of AUTO CHART and the header');
    // Tiny canvases still keep everything on screen.
    const s = H.hudLayout(320, 200, {});
    assert.ok(s.col.y >= 0 && s.starsY + 11 * s.scale <= 200);
    assert.ok(s.streakY - 30 * s.scale >= 0);
});

test("hudLayout: without the score (mode 'score') the timing meter moves up under the star power meter", () => {
    const lay = H.hudLayout(1280, 720, { trackLeft: 450, trackRight: 830, strikeY: 620 });
    assert.ok(lay.timingNoScoreY > lay.meterY + lay.meterH, 'below the meter');
    assert.ok(lay.timingNoScoreY < lay.scoreY, 'where the score was');
    assert.equal(H.hudLayout(360, 640, { trackLeft: 10, trackRight: 350, strikeY: 560 }).timingNoScoreY, null, 'compact: no timing meter');
});

test('hudLayout drops the header tag in a band lane and keeps AUTO CHART at the bottom-left', () => {
    const lay = H.hudLayout(1000, 600, { scoreHidden: true });
    assert.equal(lay.showHeader, false);
    assert.ok(lay.autoSolo.y > 600 * 0.9 && lay.autoSolo.x < 100);
    assert.ok(lay.autoSolo.y + 13 <= 600);
});
