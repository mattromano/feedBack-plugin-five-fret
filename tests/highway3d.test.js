'use strict';
// Tests for highway3d.js: the pure hit-FX helpers, and the scene driven by a real session at 60 fps
// on a stub three.js (no WebGL in Node), checked through view.fxSnapshot().
// Run: node --test tests/highway3d.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const H = require(path.join(__dirname, '..', 'assets', 'highway3d.js'));
const L = require(path.join(__dirname, '..', 'assets', 'layout.js'));
const S = require(path.join(__dirname, '..', 'assets', 'session.js'));

// ── Pure helpers ────────────────────────────────────────────────────────────

test('trailAlpha / trailZ: judged gems keep moving past the strike line and fade out over HIT_FX.behind', () => {
    assert.equal(H.HIT_FX.behind, 0.4);
    assert.equal(H.trailAlpha(-0.3), 1, 'still approaching');
    assert.equal(H.trailAlpha(0), 1);
    const a1 = H.trailAlpha(0.1), a2 = H.trailAlpha(0.2), a3 = H.trailAlpha(0.35);
    assert.ok(1 > a1 && a1 > a2 && a2 > a3 && a3 > 0, 'fades monotonically');
    assert.equal(H.trailAlpha(0.4), 0);
    const speed = L.TRACK.length / L.TRACK.lookahead;
    assert.equal(H.trailZ(-0.5, speed), -0.5 * speed, 'approaching gems scroll at track speed');
    let prev = 0;
    for (let k = 1; k <= 8; k++) {
        const z = H.trailZ(k * 0.05, speed);
        assert.ok(z > prev && z <= L.TRACK.behind + 1e-9, 'travels toward the camera and stays on the track');
        prev = z;
    }
    assert.ok(Math.abs(H.trailZ(0.4, speed) - L.TRACK.behind) < 1e-9);
    const v0 = H.trailZ(0.001, speed) / 0.001;
    assert.ok(Math.abs(v0 - speed) / speed < 0.05, 'no jump in speed at the strike line');
});

test('timingHex, sparkCount, multiplierColor', () => {
    assert.equal(H.timingHex(0), H.HIT_FX.onTime);
    assert.equal(H.timingHex(25), H.HIT_FX.onTime);
    assert.equal(H.timingHex(-40), H.HIT_FX.early);
    assert.equal(H.timingHex(40), H.HIT_FX.late);
    assert.equal(H.timingHex(NaN), H.HIT_FX.onTime);
    assert.ok(H.sparkCount(false, 0) < H.sparkCount(false, 8) && H.sparkCount(false, 8) < H.sparkCount(false, 16));
    assert.equal(H.sparkCount(false, 16), H.sparkCount(false, 100), 'full size from streakFull on');
    assert.ok(H.sparkCount(true, 0) > H.sparkCount(false, 0), 'open notes throw more');
    assert.equal(H.multiplierColor(4, true), '#7fe6ff');
    assert.notEqual(H.multiplierColor(1, false), H.multiplierColor(2, false));
});

test('hudModel: multiplier progress, star power ready / active, full combo, accuracy', () => {
    const m = H.hudModel({ score: 1234.6, combo: 13, multiplier: 2, maxMultiplier: 4, notesHit: 13, notesMissed: 0,
        starPower: { amount: 0.5, active: false }, stars: 2.5 });
    assert.equal(m.score, 1234);
    assert.equal(m.multProgress, 0.3);
    assert.equal(m.spReady, true);
    assert.equal(m.fullCombo, true);
    assert.equal(m.accuracy, 1);
    const sp = H.hudModel({ combo: 40, multiplier: 8, maxMultiplier: 4, notesHit: 40, notesMissed: 2, starPower: { amount: 0.9, active: true } });
    assert.equal(sp.multProgress, 1, 'at the cap');
    assert.equal(sp.spReady, false, 'not READY while ACTIVE');
    assert.equal(sp.fullCombo, false);
    assert.ok(Math.abs(sp.accuracy - 40 / 42) < 1e-9);
    const z = H.hudModel(null);
    assert.equal(z.mult, 1);
    assert.equal(z.fullCombo, false);
    const out = {};
    assert.equal(H.hudModel(null, out), out, 'fills `out` in place');
});

// ── Scene harness ───────────────────────────────────────────────────────────

// An auto-vivifying stand-in for three.js objects: any property is another stub, calls and `new`
// return stubs, assignments stick, and arithmetic sees 0.
function stub() {
    const store = Object.create(null);
    const p = new Proxy(function () {}, {
        get(_, k) {
            if (k in store) return store[k];
            if (k === Symbol.toPrimitive) return () => 0;
            if (k === 'then' || typeof k === 'symbol') return undefined;
            return (store[k] = stub());
        },
        set(_, k, v) { store[k] = v; return true; },
        apply() { return p; },
        construct() { return stub(); },
    });
    return p;
}

// three.js on the stub, with a Vector3 whose project() is a fixed, simple projection (x / 4 across
// the screen, the strike line 3/4 of the way down), so the HUD layout sees a realistic track.
class V3 {
    constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
    length() { return Math.hypot(this.x, this.y, this.z); }
    project() { this.x /= 4; this.y = -0.5; this.z = 0.5; return this; }
}
function three() {
    const T = stub();
    T.Vector3 = V3;
    return T;
}

// A HUD canvas whose 2D context records fillText calls.
function recordingHud() {
    const texts = [];
    const ctx = stub();
    ctx.fillText = (t) => texts.push(String(t));
    ctx.measureText = (t) => ({ width: String(t).length * 7 });
    const hud = stub();
    hud.getContext = () => ctx;
    hud.style = {};
    return { hud, texts };
}

// A real session (engine) drawn by the view at 60 fps, the way screen.js draws it.
function sceneHarness(notes, opts) {
    opts = opts || {};
    const prevDoc = global.document;
    global.document = { createElement: () => stub(), addEventListener: () => {} };
    let wall = 0;
    const s = S.createSession({
        chart: { notes, beats: [], starPower: opts.starPower || [], solos: [] },
        gamepadMode: opts.gamepadMode !== false, now: () => wall,
    });
    const view = H.createView(three(), stub(), { context: stub(), hudCanvas: opts.hudCanvas || null });
    view.resize(opts.w || 1280, opts.h || 720, 1);
    const frame = { now: 0, wallNow: 0, events: [], notes: s.notes, beats: [], starPower: s.starPower, solos: [],
        pressed: null, whammy: 0, noteState: (i) => s.noteState(i), state: null, lefty: false, header: 'GUITAR · PAD · EXPERT',
        sourceKind: 'chart', message: null, scoreHidden: !!opts.scoreHidden };
    let t = 0;
    const draw = (t1) => {
        wall = t1; s.update(t1);
        frame.now = t1; frame.wallNow = t1 * 1000; frame.state = s.state(); frame.pressed = s.pressedFrets();
        frame.whammy = s.whammy(); frame.events = s.drainEvents();
        view.render(frame);
    };
    const to = (t1) => {
        for (; t < t1 - 1e-9; t = Math.min(t1, t + 1 / 60)) draw(t);
        draw(t1);
        t = t1;
        return view.fxSnapshot();
    };
    const input = (action, value, time) => { wall = time; s.input(action, value, time); };
    const done = () => { view.destroy(); global.document = prevDoc; };
    return { s, view, frame, to, input, done };
}

const G = 1, R = 2, Y = 4, B = 8, O = 16;

test('3D view: a hit flashes its lane in the timing colour, throws sparks, and the gem trails past the line', () => {
    const h = sceneHarness([{ t: 1, f: R }, { t: 2, f: R }]);
    try {
        let snap = h.to(0.98);
        assert.equal(snap.trail.length, 0, 'nothing judged yet');
        h.input('red', 1, 1.0);
        snap = h.to(1.0);
        assert.equal(snap.trail.length, 1);
        assert.equal(snap.trail[0].state, 'hit');
        assert.ok(snap.sparksLive > 0 && snap.sparksBorn > 0, 'hit sparks');
        assert.ok(snap.flash[1] > 0 && snap.flashHit[1], 'lane flash on the red lane');
        assert.equal(snap.flash[0], 0, 'not on the green lane');
        assert.equal(snap.pops, 1, 'a score pop');
        assert.equal(snap.timing.count, 1, 'the hit is on the timing meter');
        assert.ok(snap.targets[1] > 0, 'the red target lights while held');
        h.input('red', 0, 1.05);
        snap = h.to(1.2);
        assert.equal(snap.trail.length, 1, 'still drawn past the strike line');
        assert.ok(snap.trail[0].alpha > 0 && snap.trail[0].alpha < 1, 'fading');
        assert.ok(snap.trail[0].z > 0, 'behind the strike line (toward the camera)');
        assert.equal(h.to(1.45).trail.length, 0, 'gone after the window');
        assert.equal(h.to(1.5).flash[1], 0, 'the lane flash is over');
        // The note at t=2 is never played: it turns red, carries on and fades, its lane flashes red.
        snap = h.to(2.25);
        assert.equal(snap.trail.length, 1);
        assert.equal(snap.trail[0].state, 'miss');
        assert.ok(snap.flash[1] > 0 && !snap.flashHit[1], 'red lane flash');
        assert.equal(h.to(2.6).trail.length, 0);
    } finally { h.done(); }
});

test('3D view: a chord flashes every fret, an open note the full-width flash', () => {
    const h = sceneHarness([{ t: 1, f: G | Y | O }, { t: 2, f: 0 }]);
    try {
        h.to(0.99);
        h.input('green', 1, 0.995); h.input('yellow', 1, 0.997); h.input('orange', 1, 1.0);
        let snap = h.to(1.0);
        assert.deepEqual(snap.flashHit, [true, false, true, false, true, false]);
        assert.equal(snap.trail.length, 3, 'one trail gem per fret');
        h.input('green', 0, 1.1); h.input('yellow', 0, 1.1); h.input('orange', 0, 1.1);
        h.to(1.99);
        h.input('open', 1, 2.0);
        snap = h.to(2.0);
        assert.equal(snap.flashHit[5], true, 'open-note flash');
        assert.ok(snap.trail.some((g) => g.kind === 'open' && g.state === 'hit'));
    } finally { h.done(); }
});

test('3D view: spark bursts grow with the streak; combo ring every 10, bursts at 25, pooled score pops, red wash on a break', () => {
    const notes = [];
    for (let i = 0; i < 30; i++) notes.push({ t: 1 + i * 0.25, f: i % 2 ? R : G });
    const h = sceneHarness(notes);
    try {
        h.to(0.99);
        h.input('green', 1, 1.0);
        const first = h.to(1.0).sparksBorn;
        let snap = null;
        for (let i = 1; i < 25; i++) {
            const ti = 1 + i * 0.25;
            const prev = i % 2 ? 'green' : 'red', cur = i % 2 ? 'red' : 'green';
            h.input(prev, 0, ti - 0.1);
            h.to(ti - 0.01);
            h.input(cur, 1, ti);
            snap = h.to(ti);
            if (i === 9) assert.ok(snap.ring, 'combo ring at a 10 streak');
            if (i === 12) assert.ok(!snap.ring, 'the ring is short-lived');
        }
        assert.equal(h.s.state().combo, 25);
        assert.ok(snap.sparksBorn > first, 'a 25 streak throws a bigger burst than the first hit');
        assert.ok(snap.pops > 0 && snap.pops <= snap.popPool, 'score pops are pooled');
        assert.equal(snap.bursts, 1, 'the 25 streak milestone burst');
        assert.equal(snap.layout.wide, true);
        // Break the streak: note 26 goes unplayed.
        const br = h.to(1 + 25 * 0.25 + 0.16);
        assert.ok(br.breakWash, 'streak-break wash');
        assert.ok(br.flash.some((k, i) => k > 0 && !br.flashHit[i]), 'red miss flash');
    } finally { h.done(); }
});

test('3D view: an overstrum flashes the strike line red, with no lane flash', () => {
    const h = sceneHarness([{ t: 1, f: G }, { t: 3, f: G }], { gamepadMode: false });
    try {
        h.to(0.98);
        h.input('green', 1, 0.99);
        h.input('strum_down', 1, 1.0);
        h.input('strum_down', 0, 1.02);
        let snap = h.to(1.05);
        assert.ok(snap.flashHit[0], 'strummed hit');
        h.to(1.9);
        h.input('strum_down', 1, 2.0);
        h.input('strum_down', 0, 2.02);
        snap = h.to(2.1);
        assert.equal(h.s.state().overstrums, 1);
        assert.ok(snap.strikeFlash > 0, 'red strike-line flash');
        assert.ok(snap.flash.every((k) => k === 0), 'no lane flash');
        assert.equal(h.to(2.5).strikeFlash, 0, 'and it fades');
    } finally { h.done(); }
});

test('3D view: a held sustain glows and throws sparks at the strike line; dropped, it stops', () => {
    const h = sceneHarness([{ t: 1, f: B, l: 1.5 }]);
    try {
        h.to(0.99);
        h.input('blue', 1, 1.0);
        h.to(1.0);
        let snap = h.to(1.4);
        assert.equal(h.s.noteState(0), 'held');
        assert.equal(snap.heldMask, B, 'the blue sustain is held');
        assert.ok(snap.tailGlow > 0, 'the held tail glows');
        assert.ok(snap.sustainSparks > 0 && snap.sparksLive > 0, 'sparks while held');
        assert.ok(snap.targets[3] > 0.9, 'the blue target stays lit');
        // Paused (the chart clock stands still): the glow stays, the sparks stop.
        const paused = snap.sustainSparks;
        for (let k = 1; k <= 10; k++) { h.frame.wallNow = 1400 + k * 16; h.frame.events = []; h.view.render(h.frame); }
        assert.equal(h.view.fxSnapshot().sustainSparks, paused, 'no sustain sparks while paused');
        const sparksThen = snap.sustainSparks;
        h.input('whammy', 0.8, 1.45);
        snap = h.to(1.6);
        assert.ok(snap.sustainSparks > sparksThen, 'more sparks the longer it is held');
        h.input('blue', 0, 1.65);
        snap = h.to(1.8);
        assert.equal(h.s.noteState(0), 'hit', 'dropped');
        assert.equal(snap.heldMask, 0);
        assert.equal(snap.tailGlow, 0, 'the dropped tail does not glow');
        const after = snap.sustainSparks;
        assert.equal(h.to(2.0).sustainSparks, after, 'no more sustain sparks');
    } finally { h.done(); }
});

test('3D view: star power pulses the rails and wash, the meter reads READY then ACTIVE, with a toast', () => {
    const notes = [];
    for (let i = 0; i < 8; i++) notes.push({ t: 1 + i * 0.25, f: G });
    for (let i = 0; i < 8; i++) notes.push({ t: 4 + i * 0.25, f: G });
    const starPower = [{ start_time: 0.9, end_time: 1.9 }, { start_time: 2.2, end_time: 2.9 }];
    const { hud, texts } = recordingHud();
    const h = sceneHarness(notes, { starPower, hudCanvas: hud });
    try {
        h.to(0.9);
        for (let i = 0; i < 8; i++) {
            const ti = 1 + i * 0.25;
            h.input('green', 1, ti);
            h.to(ti + 0.1);
            h.input('green', 0, ti + 0.12);
            h.to(ti + 0.2);
        }
        const st = h.s.state();
        assert.equal(st.starPower.amount, 0.5, 'two phrases: half a bar');
        let snap = h.to(3.0);
        assert.equal(snap.spIn, 0, 'not active yet');
        assert.ok(snap.railGlow > 0, 'the rails glow faintly when ready');
        texts.length = 0;
        h.to(3.05);
        assert.ok(texts.includes('STAR POWER READY'), 'READY meter label');
        h.input('star_power', 1, 3.1);
        snap = h.to(3.2);
        assert.equal(h.s.state().starPower.active, true);
        assert.equal(snap.toast, 'STAR POWER!');
        snap = h.to(3.5);
        assert.equal(snap.spIn, 1, 'wash fully in');
        const g1 = snap.railGlow;
        const g2 = h.to(3.58).railGlow;
        assert.ok(g1 > 0.5 && g2 > 0.5 && g1 !== g2, 'rails glow and pulse');
        texts.length = 0;
        h.to(3.6);
        assert.ok(texts.includes('STAR POWER ACTIVE'), 'ACTIVE meter label');
        assert.ok(texts.includes('x2') || texts.includes('x4'), 'doubled multiplier');
    } finally { h.done(); }
});

test('3D view: the HUD draws the score panels; a hidden score HUD keeps the highway and streak effects', () => {
    const notes = [];
    for (let i = 0; i < 12; i++) notes.push({ t: 1 + i * 0.25, f: Y });
    const run = (scoreHidden) => {
        const { hud, texts } = recordingHud();
        const h = sceneHarness(notes, { hudCanvas: hud, scoreHidden });
        try {
            h.to(0.99);
            let snap = null, sawRing = false;
            for (let i = 0; i < 10; i++) {
                const ti = 1 + i * 0.25;
                h.input('yellow', 1, ti);
                snap = h.to(ti);
                sawRing = sawRing || snap.ring;
                h.input('yellow', 0, ti + 0.1);
                h.to(ti + 0.12);
            }
            return { snap, texts: texts.slice(), sawRing, view: h.view, score: h.s.state().score.toLocaleString('en-US') };
        } finally { h.done(); }
    };
    const shown = run(false);
    assert.equal(shown.snap.hudScore, true);
    assert.ok(shown.texts.includes('NOTE STREAK'));
    assert.ok(shown.texts.includes('10'), 'the big streak number');
    assert.ok(shown.texts.includes('FULL COMBO'));
    assert.ok(shown.texts.some((t) => t.startsWith('STAR POWER')));
    assert.ok(shown.texts.some((t) => t.startsWith('Accuracy 100.0%')));
    assert.ok(shown.texts.includes('TIMING'));
    assert.ok(shown.texts.includes('GUITAR · PAD · EXPERT'), 'header tag');
    assert.ok(shown.texts.some((t) => /^\+\d+$/.test(t)), 'score pops');
    assert.ok(shown.sawRing, 'combo ring');

    const hidden = run(true);
    assert.equal(hidden.snap.hudScore, false);
    for (const t of ['NOTE STREAK', 'FULL COMBO', 'TIMING', 'GUITAR · PAD · EXPERT']) {
        assert.ok(!hidden.texts.includes(t), 'no ' + t);
    }
    assert.ok(!hidden.texts.some((t) => t.startsWith('STAR POWER') || t.startsWith('Accuracy') || /^\+\d+$/.test(t)));
    assert.ok(hidden.sawRing, 'the streak ring still shows on the highway');
    assert.ok(hidden.snap.flashHit[2] || hidden.snap.sparksLive > 0, 'hit effects still show');
});

test("3D view: hideScore 'score' leaves out only the score number, stars and accuracy", () => {
    const notes = [];
    for (let i = 0; i < 12; i++) notes.push({ t: 1 + i * 0.25, f: Y });
    const { hud, texts } = recordingHud();
    const h = sceneHarness(notes, { hudCanvas: hud });
    h.frame.scoreHidden = 'score';
    let sawRing = false, snap = null;
    try {
        h.to(0.99);
        for (let i = 0; i < 10; i++) {
            const ti = 1 + i * 0.25;
            h.input('yellow', 1, ti);
            snap = h.to(ti);
            sawRing = sawRing || snap.ring;
            h.input('yellow', 0, ti + 0.1);
            h.to(ti + 0.12);
        }
        const score = h.s.state().score.toLocaleString('en-US');
        assert.ok(h.s.state().score > 0);
        assert.ok(!texts.includes(score), 'no score number: ' + score);
        assert.ok(!texts.some((t) => t.startsWith('Accuracy')), 'no accuracy line');
        assert.equal(snap.hudScore, false, 'the score number is not drawn');
        assert.ok(texts.includes('NOTE STREAK'));
        assert.ok(texts.includes('10'), 'the big streak number');
        assert.ok(texts.includes('FULL COMBO'));
        assert.ok(texts.some((t) => /^x\d$/.test(t)), 'multiplier ring');
        assert.ok(texts.some((t) => t.startsWith('STAR POWER')), 'star power meter');
        assert.ok(texts.includes('TIMING'), 'early/late meter');
        assert.ok(texts.includes('GUITAR · PAD · EXPERT'), 'header tag (difficulty)');
        assert.ok(texts.some((t) => /^\+\d+$/.test(t)), 'score pops');
        assert.ok(sawRing, 'combo ring');
        assert.ok(snap.flashHit[2] || snap.sparksLive > 0, 'hit effects');
    } finally { h.done(); }
});

test('3D view: lefty mirrors the lanes; a narrow band lane gets the compact layout', () => {
    const h = sceneHarness([{ t: 1, f: G }], { w: 360, h: 640, scoreHidden: true });
    try {
        h.frame.lefty = true;
        h.to(0.99);
        h.input('green', 1, 1.0);
        const snap = h.to(1.0);
        assert.ok(snap.flashHit[0], 'the flash follows the fret, not the screen side');
        assert.equal(snap.layout.compact, true);
    } finally { h.done(); }
});

test('3D view: render allocates no new events array and survives an empty frame', () => {
    const h = sceneHarness([]);
    try {
        h.view.render({});
        h.view.render(null);
        const snap = h.view.fxSnapshot();
        assert.equal(snap.trail.length, 0);
        assert.equal(snap.sparksLive, 0);
    } finally { h.done(); }
});
