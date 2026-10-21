'use strict';
// Tests for session.js (the scoring session the renderer drives, plus the screen's pure helpers).
// Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
// Run: node --test tests/session.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const E = require(path.join(__dirname, '..', 'assets', 'engine.js'));
const P = require(path.join(__dirname, '..', 'assets', 'profiles.js'));
const S = require(path.join(__dirname, '..', 'assets', 'session.js'));

// Fret bits of the wire format (`f`): bit0 green .. bit4 orange, 0 = open.
const G = 1, R = 2, Y = 4, B = 8, O = 16;
const FRET_NAMES = ['green', 'red', 'yellow', 'blue', 'orange'];
const FRAME = 1 / 60;

// A wall clock the test moves by hand (seconds).
function fakeClock() {
    const c = { t: 100 };
    c.now = () => c.t;
    return c;
}
function session(chart, opts) {
    const clock = fakeClock();
    const s = S.createSession(Object.assign({ chart, instrument: 'guitar', difficulty: 'expert', gamepadMode: false, offsetMs: 0, now: clock.now }, opts));
    return { s, clock };
}
// Advance song and wall time together, frame by frame, from `from` to `to`.
function play(s, clock, from, to) {
    for (let t = from; t <= to + 1e-9; t += FRAME) {
        s.update(t);
        clock.t += FRAME;
    }
}
function singles(times, frets) {
    return times.map((t, i) => ({ t, f: frets ? frets[i % frets.length] : G }));
}
function chartOf(notes, extra) {
    return Object.assign({ notes, levels: {}, starPower: [], solos: [], beats: [] }, extra);
}

// ── Session ──────────────────────────────────────────────────────────────────

test('difficulty picks the level notes', () => {
    const chart = chartOf(singles([1, 2, 3, 4]), {
        levels: { hard: { notes: singles([1, 3]), generated: false }, easy: { notes: [], generated: true } },
    });
    const hard = session(chart, { difficulty: 'hard' }).s;
    assert.equal(hard.difficulty, 'hard');
    assert.equal(hard.notes.length, 2);
    assert.equal(hard.state().totalNotes, 2);
    const expert = session(chart, { difficulty: 'expert' }).s;
    assert.equal(expert.difficulty, 'expert');
    assert.equal(expert.notes.length, 4);
    assert.equal(expert.state().totalNotes, 4);
    // A level the part does not have falls back to the top-level (expert) notes.
    const medium = session(chart, { difficulty: 'medium' }).s;
    assert.equal(medium.difficulty, 'expert');
    assert.equal(medium.notes.length, 4);
});

test('notes are sorted by time once and noteState indexes the sorted list', () => {
    const chart = chartOf([{ t: 2, f: R }, { t: 1, f: G }]);
    const { s, clock } = session(chart);
    assert.deepEqual(s.notes.map((n) => n.t), [1, 2]);
    play(s, clock, 0, 0.9);
    s.input('green', 1, 0.9);
    s.input('strum_down', 1, 1.0);
    s.input('strum_down', 0, 1.0);
    play(s, clock, 0.9 + FRAME, 1.1);
    assert.equal(s.noteState(0), 'hit');
    assert.equal(s.noteState(1), null);
});

test('input offset shifts judgment time', () => {
    // Note at 1.0 s; hit window 70 ms each side. Inputs arrive at highway time 1.15 s.
    const chart = chartOf(singles([1, 3]));
    function strumAt(offsetMs) {
        const { s, clock } = session(chart, { offsetMs });
        play(s, clock, 0, 1.1);
        s.input('green', 1, 1.12);
        s.input('strum_down', 1, 1.15);
        s.input('strum_down', 0, 1.15);
        play(s, clock, 1.12, 1.4);
        return s;
    }
    // No offset: 150 ms late, outside the window.
    const late = strumAt(0);
    assert.equal(late.noteState(0), 'miss');
    // +100 ms (inputs register earlier): judged at 1.05 s, a hit. The offset applies to the
    // clock too, so the note is not missed at highway 1.07 before the input arrives.
    const shifted = strumAt(100);
    assert.equal(shifted.noteState(0), 'hit');
    assert.equal(shifted.state().notesHit, 1);
    assert.equal(shifted.offsetMs, 100);
});

test('seek backwards resets without misses', () => {
    const chart = chartOf(singles([1, 2, 3, 4, 5, 6, 7, 8]));
    const { s, clock } = session(chart);
    play(s, clock, 0, 5.5);
    assert.equal(s.state().notesMissed, 5);
    const resets = s.resets;
    s.update(2.5);   // loop back
    clock.t += FRAME;
    assert.equal(s.resets, resets + 1);
    assert.equal(s.state().notesMissed, 0);
    assert.equal(s.state().combo, 0);
    // Notes from the new position on are live again.
    assert.equal(s.noteState(2), null);
    play(s, clock, 2.5 + FRAME, 3.2);
    assert.equal(s.noteState(2), 'miss');
    assert.equal(s.state().notesMissed, 1);
});

test('seek forwards resets without misses', () => {
    const chart = chartOf(singles([1, 2, 3, 4, 5, 6, 7, 8]));
    const { s, clock } = session(chart);
    play(s, clock, 0, 0.5);
    const resets = s.resets;
    s.update(5.5);   // jump ahead
    clock.t += FRAME;
    assert.equal(s.resets, resets + 1);
    assert.equal(s.state().notesMissed, 0);
    for (let i = 0; i < 5; i++) assert.equal(s.noteState(i), null, 'skipped note ' + i);
    // The note at 6 s is still playable.
    s.input('green', 1, 5.9);
    s.input('strum_down', 1, 6);
    s.input('strum_down', 0, 6);
    play(s, clock, 5.5 + FRAME, 6.2);
    assert.equal(s.noteState(5), 'hit');
    assert.equal(s.state().notesMissed, 0);
});

test('normal frame-to-frame advance does not reset', () => {
    const chart = chartOf(singles([1, 2, 3]));
    const { s, clock } = session(chart);
    play(s, clock, 0, 2.5);
    const resets = s.resets;
    assert.equal(s.state().notesMissed, 2);
    // Paused: the song clock stands still while the wall clock runs.
    clock.t += 3;
    s.update(2.5);
    // A slow frame: 0.4 s of song in 0.4 s of wall time.
    clock.t += 0.4;
    s.update(2.9);
    // Small jitter backwards (a timer sample a few ms behind).
    clock.t += FRAME;
    s.update(2.89);
    assert.equal(s.resets, resets);
    assert.equal(s.state().notesMissed, 2);
});

test('the first update starting mid-song does not miss the notes behind it', () => {
    const chart = chartOf(singles([1, 2, 3, 4]));
    const { s, clock } = session(chart);
    s.update(3.5);
    clock.t += FRAME;
    s.update(3.5 + FRAME);
    assert.equal(s.state().notesMissed, 0);
    assert.equal(s.noteState(0), null);
});

test('forward play through a chart: all hit with perfect inputs scores full combo', () => {
    const frets = [G, R, Y, B, O, G | R, R | Y | B];
    const times = [1, 1.5, 2, 2.5, 3, 3.5, 4];
    const chart = chartOf(times.map((t, i) => ({ t, f: frets[i] })));
    const { s, clock } = session(chart);
    let held = 0;
    let t = 0;
    for (let i = 0; i < times.length; i++) {
        play(s, clock, t, times[i] - 0.2);
        // Change frets between notes, then strum on the note.
        for (let k = 0; k < 5; k++) {
            const want = (frets[i] >> k) & 1, has = (held >> k) & 1;
            if (want !== has) s.input(FRET_NAMES[k], want, times[i] - 0.1);
        }
        held = frets[i];
        assert.deepEqual(s.pressedFrets(), [0, 1, 2, 3, 4].map((k) => !!((held >> k) & 1)));
        s.input('strum_down', 1, times[i]);
        s.input('strum_down', 0, times[i] + 0.02);
        t = times[i] - 0.2 + FRAME;
    }
    play(s, clock, t, 5);
    const st = s.state();
    assert.equal(st.notesHit, times.length);
    assert.equal(st.notesMissed, 0);
    assert.equal(st.maxCombo, times.length);
    assert.equal(st.overstrums, 0);
    for (let i = 0; i < times.length; i++) assert.equal(s.noteState(i), 'hit');
    const hits = s.drainEvents().filter((e) => e.type === 'hit');
    assert.equal(hits.length, times.length);
    assert.equal(hits[0].noteType, 'strum');
    assert.deepEqual(s.drainEvents(), []);
});

test('whammy and pressed frets follow the inputs; unknown actions are ignored', () => {
    const { s } = session(chartOf(singles([1])));
    s.update(0);
    s.input('whammy', 0.6, 0.1);
    s.input('pause', 1, 0.1);
    s.input('blue', 1, 0.1);
    assert.equal(s.whammy(), 0.6);
    assert.deepEqual(s.pressedFrets(), [false, false, false, true, false]);
});

test('gamepad mode hits on fret presses', () => {
    const { s, clock } = session(chartOf(singles([1, 2], [G, R])), { gamepadMode: true });
    play(s, clock, 0, 0.9);
    s.input('green', 1, 1.0);
    s.input('green', 0, 1.2);
    play(s, clock, 0.9 + FRAME, 1.9);
    s.input('red', 1, 2.0);
    play(s, clock, 1.9 + FRAME, 2.5);
    assert.equal(s.state().notesHit, 2);
});

test('disconnect leaves session running', () => {
    const chart = chartOf(singles([1, 2, 3, 4]));
    const { s, clock } = session(chart);
    play(s, clock, 0, 1.5);
    s.input('green', 1, 1.5);   // then the controller unplugs: no more input (release never comes)
    assert.doesNotThrow(() => play(s, clock, 1.5 + FRAME, 6));
    const st = s.state();
    assert.equal(st.notesMissed, 4);
    assert.equal(st.notesHit, 0);
    assert.ok(s.drainEvents().some((e) => e.type === 'miss'));
});

test('a session with no notes runs and reports nothing', () => {
    const { s, clock } = session(chartOf([]));
    assert.doesNotThrow(() => play(s, clock, 0, 1));
    assert.equal(s.notes.length, 0);
    assert.equal(s.state().totalNotes, 0);
    assert.equal(s.noteState(0), null);
});

// ── Pure helpers ───────────────────────────────────────────────────────────────

function parts() {
    // Object key order = manifest order.
    return {
        lead: { partId: 'lead', name: 'Lead', instrument: 'guitar', notes: [] },
        rhy: { partId: 'rhy', name: 'Rhythm', instrument: 'rhythm', notes: [] },
        low: { partId: 'low', name: 'Bass', instrument: 'bass', notes: [] },
    };
}

test('pickPart by instrument setting', () => {
    const p = parts();
    assert.equal(S.pickPart(p, 'Lead', 'guitar'), 'lead');
    assert.equal(S.pickPart(p, 'Lead', 'rhythm'), 'rhy');
    assert.equal(S.pickPart(p, 'Lead', 'bass'), 'low');
});

test('pickPart auto: bass for a bass arrangement, else guitar, else the first part', () => {
    const p = parts();
    assert.equal(S.pickPart(p, 'Bass', 'auto'), 'low');
    assert.equal(S.pickPart(p, 'Alt. bass 2', 'auto'), 'low');
    assert.equal(S.pickPart(p, 'Lead', 'auto'), 'lead');
    assert.equal(S.pickPart(p, '', 'auto'), 'lead');
    assert.equal(S.pickPart(p, undefined, undefined), 'lead');
    // No guitar part: the first part.
    const noGuitar = { rhy: p.rhy, low: p.low };
    assert.equal(S.pickPart(noGuitar, 'Lead', 'auto'), 'rhy');
    // A bass arrangement but no bass part: guitar.
    const noBass = { lead: p.lead, rhy: p.rhy };
    assert.equal(S.pickPart(noBass, 'Bass', 'auto'), 'lead');
});

test('pickPart: a missing instrument falls back to auto; no parts gives null', () => {
    const p = parts();
    assert.equal(S.pickPart({ lead: p.lead }, 'Bass', 'bass'), 'lead');
    assert.equal(S.pickPart({ low: p.low }, 'Lead', 'guitar'), 'low');
    assert.equal(S.pickPart({}, 'Bass', 'auto'), null);
    assert.equal(S.pickPart(null, 'Bass', 'auto'), null);
    assert.equal(S.pickPart(undefined, '', 'guitar'), null);
});

test('pickPart opts.exact returns null for a missing instrument', () => {
    const p = parts();
    const exact = { exact: true };
    assert.equal(S.pickPart({ lead: p.lead, low: p.low }, 'Lead', 'rhythm', exact), null);
    assert.equal(S.pickPart({ lead: p.lead }, 'Bass', 'bass', exact), null);
    assert.equal(S.pickPart(p, 'Lead', 'rhythm', exact), 'rhy');
    assert.equal(S.pickPart(p, 'Lead', 'bass', { exact: true, showAuto: false }), 'low');
    // exact only pins an instrument: 'auto' still picks from the song.
    assert.equal(S.pickPart(p, 'Bass', 'auto', exact), 'low');
    // No opts, or exact off: the old fallback.
    assert.equal(S.pickPart({ lead: p.lead }, 'Bass', 'bass', {}), 'lead');
    assert.equal(S.pickPart({ lead: p.lead }, 'Bass', 'bass', null), 'lead');
});

test('session starThresholds: the full-chart thresholds, unchanged by a seek', () => {
    const chart = chartOf(singles([1, 2, 3, 4, 5, 6]));
    const { s, clock } = session(chart);
    const want = E.create({ notes: chart.notes, beats: [], starPower: [], solos: [] }, { instrument: 'guitar' }).starThresholds;
    assert.ok(Array.isArray(s.starThresholds) && s.starThresholds.length > 0);
    assert.deepEqual(s.starThresholds, want);
    const before = s.starThresholds.slice();
    play(s, clock, 0, 4);
    s.update(0.5);   // seek back
    assert.equal(s.resets, 2);
    assert.deepEqual(s.starThresholds, before);
});

test('inputChartTime: chart clock plus wall time since the frame, minus the offset', () => {
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(S.inputChartTime(10, 500, 500.02), 10.02));
    assert.ok(near(S.inputChartTime(10, 500, 500.02, 30), 9.99));
    // Clamped to 0..60 ms past the frame (drums estimateTime): a stalled highway, an early event.
    assert.ok(near(S.inputChartTime(10, 500, 502, 0), 10.06));
    assert.ok(near(S.inputChartTime(10, 500, 499.99, 0), 10));
    // Paused: the raw chart time of the last frame.
    assert.ok(near(S.inputChartTime(10, 500, 500.02, 0, false), 10));
    assert.ok(near(S.inputChartTime(10, 500, 500.02, 0, true), 10.02));
    // No frame yet, or a bad event time: NaN (the screen drops the input).
    assert.ok(Number.isNaN(S.inputChartTime(NaN, 500, 500.02, 0)));
    assert.ok(Number.isNaN(S.inputChartTime(10, NaN, 500.02, 0)));
    assert.ok(Number.isNaN(S.inputChartTime(10, 500, undefined, 0)));
    // A bad offset counts as 0.
    assert.ok(near(S.inputChartTime(10, 500, 500.02, 'x'), 10.02));
});

test('drainEvents returns one shared frozen array when empty', () => {
    const { s } = session(chartOf(singles([1])));
    const a = s.drainEvents(), b = s.drainEvents();
    assert.equal(a, b);
    assert.ok(Object.isFrozen(a));
    assert.equal(a.length, 0);
});

test('a rebuilt session starts with the frets still held', () => {
    // Green is held across a rebuild; the next note is a green HOPO-free strum at 1 s.
    const { s, clock } = session(chartOf(singles([1])), { pressed: [true, false, false, false, false] });
    assert.deepEqual(s.pressedFrets(), [true, false, false, false, false]);
    play(s, clock, 0.5, 0.9);
    s.input('strum_down', 1, 1.0);
    play(s, clock, 0.9 + FRAME, 1.2);
    assert.equal(s.noteState(0), 'hit');
    assert.equal(s.state().notesHit, 1);
});

test('releaseAll lets go of held frets', () => {
    const { s, clock } = session(chartOf(singles([1])));
    play(s, clock, 0, 0.5);
    s.input('green', 1, 0.6);
    s.input('red', 1, 0.6);
    s.releaseAll(0.7);
    assert.deepEqual(s.pressedFrets(), [false, false, false, false, false]);
    // Strumming now plays no frets: the green note is not hit.
    s.input('strum_down', 1, 1.0);
    play(s, clock, 0.5 + FRAME, 1.2);
    assert.notEqual(s.noteState(0), 'hit');
});

test('statusMessage for the HUD', () => {
    assert.equal(S.statusMessage({ hasParts: false, hasController: true, connected: true }), 'No 5-fret chart for this song');
    assert.equal(S.statusMessage({ hasParts: false, hasController: false, connected: false }), 'No 5-fret chart for this song');
    assert.equal(S.statusMessage({ hasParts: true, hasController: false, connected: false }), 'Connect a controller and press any button');
    assert.equal(S.statusMessage({ hasParts: true, hasController: true, connected: false }), 'Controller disconnected');
    assert.equal(S.statusMessage({ hasParts: true, hasController: true, connected: true }), null);
});

test('isJump: more than 0.25 s off the expected advance, a pause is not a jump', () => {
    assert.equal(S.isJump(10, 10 + FRAME, FRAME), false);
    assert.equal(S.isJump(10, 10, 5), false);           // paused
    assert.equal(S.isJump(10, 10.4, 0.4), false);       // slow frame
    assert.equal(S.isJump(10, 9.7, FRAME), true);       // back
    assert.equal(S.isJump(10, 10.3, FRAME), true);      // forward
    assert.equal(S.isJump(10, 9.8, FRAME), false);
    assert.equal(S.isJump(NaN, 10, FRAME), false);
});

test('session.js works with the profiles mapper output', () => {
    // The mapper emits 1/0 values for buttons; the session takes them as pressed/released.
    const m = P.createMapper(P.STANDARD_GAMEPAD);
    const { s, clock } = session(chartOf(singles([1])));
    play(s, clock, 0, 0.9);
    for (const a of m.map({ type: 'button', index: 6, value: 1, pressed: true, t: 1 })) s.input(a.action, a.value, 0.95);
    for (const a of m.map({ type: 'button', index: 13, value: 1, pressed: true, t: 1 })) s.input(a.action, a.value, 1.0);
    play(s, clock, 0.9 + FRAME, 1.3);
    assert.equal(s.noteState(0), 'hit');
    assert.ok(E.ACTIONS.length > 0);
});
