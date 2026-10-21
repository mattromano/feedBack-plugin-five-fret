'use strict';
// Tests for engine.js (the LGPL-3.0 port of YARG.Core's five-fret guitar engine).
// Copyright (c) YARC (YARG) contributors
// Licensed under the GNU Lesser General Public License v3.0
// (see https://github.com/YARC-Official/YARG.Core/blob/master/LICENSE and ../LICENSE.LGPL-3.0).
// Written in JavaScript (node:test) for the feedBack five-fret plugin.
// Run: node --test tests/engine.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const E = require(path.join(__dirname, '..', 'assets', 'engine.js'));

// Fret bits of the wire format (`f`): bit0 green .. bit4 orange, 0 = open.
const G = 1, R = 2, Y = 4, B = 8, O = 16, OPEN = 0;

function engine(notes, opts) {
    return E.create({ notes, starPower: [], solos: [], beats: [] }, opts || { instrument: 'guitar' });
}
function strum(e, t) {
    e.input(t, 'strum_down', true);
    e.input(t, 'strum_down', false);
}
function press(e, t, fret) { e.input(t, fret, true); }
function release(e, t, fret) { e.input(t, fret, false); }
function collect(e, names) {
    const log = [];
    for (const n of names) e.on(n, (p) => log.push([n, p]));
    return log;
}

// ── Strummed notes ───────────────────────────────────────────────────────────

test('strummed note hit inside window', () => {
    const e = engine([{ t: 1, f: G }]);
    const log = collect(e, ['hit']);
    press(e, 0.9, 'green');
    strum(e, 1.05); // 50 ms late, inside the 70 ms back end
    assert.equal(e.noteState(0), 'hit');
    assert.equal(log.length, 1);
    assert.equal(log[0][1].index, 0);
    const s = e.getState();
    assert.equal(s.score, 50);
    assert.equal(s.combo, 1);
    assert.equal(s.notesHit, 1);
});

test('strum too early for the window does not hit the note', () => {
    const e = engine([{ t: 1, f: G }]);
    press(e, 0.8, 'green');
    // 100 ms early: the front end is at 0.93 and the small strum leniency (25 ms) ends at 0.925.
    strum(e, 0.9);
    e.update(1);
    assert.equal(e.noteState(0), null);
});

test('strum just before the front end hits through the small strum leniency', () => {
    // YARG: a strum with no note in the window starts the 25 ms small leniency, and the note's
    // front-end update (0.93) then hits it while that leniency is still running.
    const e = engine([{ t: 1, f: G }]);
    press(e, 0.8, 'green');
    strum(e, 0.92);
    e.update(0.95);
    assert.equal(e.noteState(0), 'hit');
});

test('note missed after window', () => {
    const e = engine([{ t: 1, f: G }, { t: 2, f: G }]);
    const log = collect(e, ['miss']);
    e.update(1.07); // exactly at the back end: still hittable
    assert.equal(e.noteState(0), null);
    e.update(1.2);
    assert.equal(e.noteState(0), 'miss');
    assert.equal(log.length, 1);
    assert.equal(log[0][1].index, 0);
    assert.equal(e.getState().notesMissed, 1);
    assert.equal(e.noteState(1), null);
});

test('a late strum after the window cannot hit the missed note', () => {
    const e = engine([{ t: 1, f: G }]);
    press(e, 0.9, 'green');
    strum(e, 1.2);
    assert.equal(e.noteState(0), 'miss');
    assert.equal(e.getState().notesHit, 0);
});

test('overstrum with no note breaks combo', () => {
    const e = engine([{ t: 1, f: G }, { t: 5, f: G }]);
    press(e, 0.9, 'green');
    strum(e, 1);
    assert.equal(e.getState().combo, 1);
    const log = collect(e, ['overstrum', 'combo-reset']);
    strum(e, 2); // no note in the window: small strum leniency (25 ms), then an overstrum
    e.update(2.01);
    assert.equal(e.getState().combo, 1, 'not yet: still inside the small strum leniency');
    e.update(2.1);
    const s = e.getState();
    assert.equal(s.combo, 0);
    assert.equal(s.overstrums, 1);
    assert.deepEqual(log.map(x => x[0]), ['combo-reset', 'overstrum']);
});

test('no overstrum before the first note is resolved', () => {
    const e = engine([{ t: 5, f: G }]);
    strum(e, 1);
    e.update(2);
    assert.equal(e.getState().overstrums, 0);
});

test('no overstrum during a wait countdown (gap of 9 s or more)', () => {
    const e = engine([{ t: 1, f: G }, { t: 12, f: G }, { t: 14, f: G }]);
    press(e, 0.9, 'green');
    strum(e, 1);
    strum(e, 5); // inside the 1 s .. 12 s countdown
    e.update(6);
    assert.equal(e.getState().overstrums, 0);
    assert.equal(e.getState().combo, 1);
    strum(e, 12);
    strum(e, 13); // 12 -> 14 is no countdown
    e.update(13.5);
    assert.equal(e.getState().overstrums, 1);
});

test('double strum overstrums immediately', () => {
    const e = engine([{ t: 1, f: G }, { t: 2, f: R }]);
    press(e, 0.9, 'green');
    strum(e, 1);
    strum(e, 1.95); // red note in window, green held: cannot hit, leniency starts
    strum(e, 1.96); // strum again inside the leniency
    assert.equal(e.getState().overstrums, 1);
    assert.equal(e.getState().combo, 0);
});

test('wrong fret on a strum overstrums when the strum leniency runs out', () => {
    const e = engine([{ t: 1, f: G }, { t: 2, f: R }]);
    press(e, 0.9, 'green');
    strum(e, 1);
    strum(e, 2); // green held for a red note
    e.update(2.04);
    assert.equal(e.getState().overstrums, 0);
    e.update(2.06); // 50 ms strum leniency over
    assert.equal(e.getState().overstrums, 1);
    assert.equal(e.noteState(1), null, 'note is still hittable until its window passes');
});

// ── HOPOs and taps ───────────────────────────────────────────────────────────

test('HOPO hit by fret change without strum after a hit', () => {
    const e = engine([{ t: 1, f: G }, { t: 1.2, f: R, h: true }]);
    press(e, 0.9, 'green');
    strum(e, 1);
    press(e, 1.2, 'red'); // green stays down as an anchor
    assert.equal(e.noteState(1), 'hit');
    assert.equal(e.getState().combo, 2);
});

test('HOPO strummed right after it was tapped eats the strum (HOPO leniency)', () => {
    const e = engine([{ t: 1, f: G }, { t: 1.2, f: R, h: true }, { t: 3, f: R }]);
    press(e, 0.9, 'green');
    strum(e, 1);
    press(e, 1.2, 'red');
    strum(e, 1.25); // within the 80 ms HOPO leniency: eaten, no overstrum
    e.update(1.5);
    assert.equal(e.getState().overstrums, 0);
    assert.equal(e.getState().combo, 2);
});

test('HOPO not hittable after a miss until strummed', () => {
    const e = engine([{ t: 1, f: G }, { t: 1.5, f: R, h: true }]);
    e.update(1.2); // first note missed: combo 0
    assert.equal(e.noteState(0), 'miss');
    press(e, 1.5, 'red');
    assert.equal(e.noteState(1), null, 'a HOPO needs combo > 0 to be tapped');
    strum(e, 1.52);
    assert.equal(e.noteState(1), 'hit');
});

test('first note as a HOPO can be tapped', () => {
    const e = engine([{ t: 1, f: R, h: true }]);
    press(e, 1, 'red');
    assert.equal(e.noteState(0), 'hit');
});

test('tap hittable without strum', () => {
    const e = engine([{ t: 1, f: G }, { t: 1.5, f: R, tap: true }]);
    e.update(1.2); // miss the first note: combo 0, a HOPO would now need a strum
    press(e, 1.5, 'red');
    assert.equal(e.noteState(1), 'hit');
});

test('ghost input breaks HOPO chain', () => {
    const notes = [{ t: 1, f: G }, { t: 1.1, f: R, h: true }];
    const e = engine(notes);
    press(e, 0.9, 'green');
    strum(e, 1);
    press(e, 1.07, 'yellow'); // hammer-on to a fret the HOPO does not have, inside its window
    release(e, 1.08, 'yellow');
    press(e, 1.1, 'red');
    assert.equal(e.noteState(1), null, 'ghosted HOPO cannot be tapped');
    assert.equal(e.getState().ghostInputs, 1);
    strum(e, 1.12);
    assert.equal(e.noteState(1), 'hit', 'it can still be strummed');

    // Same inputs with anti-ghosting off: the ghost is counted but the HOPO taps.
    const e2 = engine(notes, { instrument: 'guitar', params: { antiGhosting: false } });
    press(e2, 0.9, 'green');
    strum(e2, 1);
    press(e2, 1.07, 'yellow');
    release(e2, 1.08, 'yellow');
    press(e2, 1.1, 'red');
    assert.equal(e2.noteState(1), 'hit');
    assert.equal(e2.getState().ghostInputs, 1);
});

// ── Chords and opens ─────────────────────────────────────────────────────────

test('chord needs exact frets', () => {
    // Lower frets may be held for single notes, not for strummed chords.
    const e = engine([{ t: 1, f: R | Y }, { t: 2, f: Y }]);
    press(e, 0.8, 'green');
    press(e, 0.8, 'red');
    press(e, 0.8, 'yellow');
    strum(e, 1);
    e.update(1.2);
    assert.equal(e.noteState(0), 'miss', 'green anchor is not allowed on a strummed chord');
    strum(e, 2);
    assert.equal(e.noteState(1), 'hit', 'green and red may anchor a single yellow');

    const e2 = engine([{ t: 1, f: R | Y }]);
    press(e2, 0.8, 'red');
    press(e2, 0.8, 'yellow');
    strum(e2, 1);
    assert.equal(e2.noteState(0), 'hit');
    assert.equal(e2.getState().score, 100, '50 points per fret in the chord');
});

test('single note: a fret above the note is not an anchor', () => {
    const e = engine([{ t: 1, f: R }]);
    press(e, 0.8, 'red');
    press(e, 0.8, 'yellow');
    strum(e, 1);
    e.update(1.2);
    assert.equal(e.noteState(0), 'miss');
});

test('HOPO chord may be anchored below its lowest fret', () => {
    const e = engine([{ t: 1, f: G }, { t: 1.2, f: R | Y, h: true }]);
    press(e, 0.9, 'green');
    strum(e, 1);
    press(e, 1.19, 'red');
    press(e, 1.2, 'yellow');
    assert.equal(e.noteState(1), 'hit');
});

test('open note hit by strum with no frets', () => {
    const e = engine([{ t: 1, f: OPEN }, { t: 2, f: OPEN }]);
    strum(e, 1);
    assert.equal(e.noteState(0), 'hit');
    press(e, 1.9, 'green');
    strum(e, 2);
    e.update(2.2);
    assert.equal(e.noteState(1), 'miss', 'a held fret blocks an open note');
});

test('strum leniency: fret pressed just after strum still hits', () => {
    const e = engine([{ t: 1, f: G }, { t: 2, f: R }]);
    press(e, 0.9, 'green');
    strum(e, 1);
    release(e, 1.5, 'green');
    strum(e, 2);       // nothing held yet
    press(e, 2.03, 'red'); // inside the 50 ms strum leniency
    e.update(2.2);
    assert.equal(e.noteState(1), 'hit');
    assert.equal(e.getState().overstrums, 0);
});

// ── Scoring ──────────────────────────────────────────────────────────────────

function openRun(n) {
    const notes = [];
    for (let i = 0; i < n; i++) notes.push({ t: 1 + i * 0.5, f: OPEN });
    return notes;
}
function strumAll(e, notes, upTo) {
    const states = [];
    for (let i = 0; i < upTo; i++) {
        strum(e, notes[i].t);
        states.push(e.getState());
    }
    return states;
}

test('scoring and multiplier steps at 10/20/30 combo', () => {
    const notes = openRun(45);
    const e = engine(notes);
    const st = strumAll(e, notes, 45);
    assert.equal(st[8].multiplier, 1);   // combo 9
    assert.equal(st[9].multiplier, 2);   // combo 10
    assert.equal(st[19].multiplier, 3);  // combo 20
    assert.equal(st[29].multiplier, 4);  // combo 30
    assert.equal(st[44].multiplier, 4);  // capped at 4 for guitar
    // The multiplier updates before the note scores, so the 10th note already scores 2x.
    assert.equal(st[8].score, 9 * 50);
    assert.equal(st[9].score, 9 * 50 + 100);
    assert.equal(st[44].score, 9 * 50 + 10 * 100 + 10 * 150 + 16 * 200);
});

test('bass max multiplier 6', () => {
    const notes = openRun(65);
    const e = engine(notes, { instrument: 'bass' });
    const st = strumAll(e, notes, 65);
    assert.equal(st[39].multiplier, 5);
    assert.equal(st[49].multiplier, 6);
    assert.equal(st[64].multiplier, 6);
});

test('a miss resets combo and multiplier', () => {
    const notes = openRun(12);
    const e = engine(notes);
    strumAll(e, notes, 11);
    assert.equal(e.getState().multiplier, 2);
    const log = collect(e, ['combo-reset']);
    e.update(notes[11].t + 0.2);
    const s = e.getState();
    assert.equal(s.combo, 0);
    assert.equal(s.multiplier, 1);
    assert.equal(log.length, 1);
});

// ── Gamepad mode (Deviation 1) ───────────────────────────────────────────────

const GP = { instrument: 'guitar', gamepadMode: true };

test('gamepad mode: held frets matching a strummed note hit it with no strum', () => {
    const e = engine([{ t: 1, f: G }], GP);
    press(e, 0.98, 'green');
    assert.equal(e.noteState(0), 'hit');
    assert.equal(e.getState().score, 50);
});

test('gamepad mode: chord hit when the last fret of the chord goes down, no overstrum on the way', () => {
    const e = engine([{ t: 1, f: G }, { t: 2, f: G | R | Y }], GP);
    press(e, 1, 'green');
    assert.equal(e.noteState(0), 'hit');
    press(e, 1.96, 'red');    // green + red: not the chord yet
    assert.equal(e.noteState(1), null);
    press(e, 1.98, 'yellow'); // green + red + yellow
    assert.equal(e.noteState(1), 'hit');
    const s = e.getState();
    assert.equal(s.overstrums, 0);
    assert.equal(s.combo, 2);
});

test('gamepad mode: wrong press is ignored, note missed when its window passes', () => {
    const e = engine([{ t: 1, f: G }, { t: 2, f: G }], GP);
    press(e, 1, 'green');
    release(e, 1.5, 'green');
    press(e, 2, 'red');
    strum(e, 2); // strums are not used in gamepad mode
    let s = e.getState();
    assert.equal(e.noteState(1), null);
    assert.equal(s.combo, 1);
    assert.equal(s.overstrums, 0);
    e.update(2.2);
    s = e.getState();
    assert.equal(e.noteState(1), 'miss');
    assert.equal(s.combo, 0);
    assert.equal(s.overstrums, 0);
});

test('gamepad mode: open button hits an open note', () => {
    const e = engine([{ t: 1, f: OPEN }, { t: 2, f: OPEN }], GP);
    e.input(1, 'open', true);
    assert.equal(e.noteState(0), 'hit');
    e.input(1.1, 'open', false);
    press(e, 1.95, 'green');
    release(e, 2, 'green'); // releasing every fret is not the open button
    assert.equal(e.noteState(1), null);
    e.input(2.01, 'open', true);
    assert.equal(e.noteState(1), 'hit');
});

test('gamepad mode: release to a lower fret does not hit a single note', () => {
    const e = engine([{ t: 1, f: R }], GP);
    press(e, 0.5, 'red');
    press(e, 0.5, 'yellow');
    release(e, 1, 'yellow'); // red + nothing above: matches, but a release never hits
    assert.equal(e.noteState(0), null);
    release(e, 1.01, 'red');
    press(e, 1.02, 'red');   // pressing again does
    assert.equal(e.noteState(0), 'hit');
});

test('gamepad mode: releasing an extra fret does not hit a chord', () => {
    const e = engine([{ t: 1, f: G | R | Y }], GP);
    for (const f of ['green', 'red', 'yellow', 'blue']) press(e, 0.5, f);
    release(e, 1, 'blue'); // exactly the chord now, by a release
    assert.equal(e.noteState(0), null);
    release(e, 1.01, 'yellow');
    press(e, 1.02, 'yellow'); // the last chord fret goes down
    assert.equal(e.noteState(0), 'hit');
});

test('gamepad mode: open button hits an open note only with no frets held', () => {
    const e = engine([{ t: 1, f: OPEN }], GP);
    press(e, 0.9, 'red');
    e.input(1, 'open', true);
    assert.equal(e.noteState(0), null);
    e.input(1.01, 'open', false);
    release(e, 1.02, 'red');
    e.input(1.03, 'open', true);
    assert.equal(e.noteState(0), 'hit');
});

// ── Sustains, whammy, star power, solos, stars (Task 5) ─────────────────────

// chart.beats at a steady tempo: one entry per beat, `measure` >= 0 on each downbeat (-1 otherwise).
function steadyBeats(secondsPerBeat, beatsPerMeasure, count) {
    const beats = [];
    for (let i = 0; i < count; i++) {
        beats.push({ time: i * secondsPerBeat, measure: i % beatsPerMeasure === 0 ? i / beatsPerMeasure : -1 });
    }
    return beats;
}
const BEATS_120 = steadyBeats(0.5, 4, 200); // 120 BPM 4/4: a beat is 0.5 s, a measure 2 s

function chart5(notes, extra) {
    return Object.assign({ notes, starPower: [], solos: [], beats: BEATS_120 }, extra || {});
}
function engine5(notes, extra, opts) {
    return E.create(chart5(notes, extra), opts || { instrument: 'guitar' });
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-6), (msg || '') + ` ${a} != ${b}`);

test('sustain scores per beat while held', () => {
    // 2 s at 120 BPM = 4 beats = 100 sustain points (25 per beat).
    const e = engine5([{ t: 1, f: G, l: 2 }]);
    const log = collect(e, ['sustain-start', 'sustain-end']);
    press(e, 0.9, 'green');
    strum(e, 1);
    assert.equal(e.getState().score, 50);
    assert.deepEqual(log.map(x => x[0]), ['sustain-start']);
    e.update(2); // 2 beats held: 50 points pending, shown in the score
    assert.equal(e.getState().score, 100);
    e.update(3.5);
    assert.equal(e.getState().score, 150);
    assert.deepEqual(log.map(x => x[0]), ['sustain-start', 'sustain-end']);
    assert.equal(log[1][1].finished, true);
    assert.equal(log[1][1].index, 0);

    // A sustain is scored in full once it reaches the burst point, a quarter beat before its end.
    const e2 = engine5([{ t: 1, f: G, l: 2 }]);
    press(e2, 0.9, 'green');
    strum(e2, 1);
    release(e2, 2.9, 'green'); // burst at 2.875
    e2.update(3.5);
    assert.equal(e2.getState().score, 150);
});

test('sustain drop ends sustain early', () => {
    const e = engine5([{ t: 1, f: G, l: 2 }]);
    const log = collect(e, ['sustain-end']);
    press(e, 0.9, 'green');
    strum(e, 1);
    release(e, 2, 'green');
    e.update(2.02);
    assert.equal(log.length, 0, 'still held by the 25 ms drop leniency');
    e.update(2.1);
    assert.equal(log.length, 1);
    assert.equal(log[0][1].finished, false);
    near(log[0][1].time, 2.025, 1e-9);
    // Scored up to the drop: 2.05 beats -> ceil(51.25) = 52.
    assert.equal(e.getState().score, 50 + 52);
    e.update(3.5);
    assert.equal(e.getState().score, 50 + 52);

    // Pressing the fret again inside the leniency keeps the sustain.
    const e2 = engine5([{ t: 1, f: G, l: 2 }]);
    press(e2, 0.9, 'green');
    strum(e2, 1);
    release(e2, 2, 'green');
    press(e2, 2.01, 'green');
    e2.update(3.5);
    assert.equal(e2.getState().score, 150);
});

test('extended sustain: its fret is masked out for the next note and keeps scoring', () => {
    // Yellow sustains from 1 to 3 over a green note at 2: holding yellow above green would block a
    // single green note, but the extended sustain's fret is ignored when matching.
    const e = engine5([{ t: 1, f: Y, l: 2 }, { t: 2, f: G }]);
    const log = collect(e, ['sustain-end']);
    press(e, 0.9, 'yellow');
    strum(e, 1);
    press(e, 1.9, 'green');
    strum(e, 2);
    assert.equal(e.noteState(1), 'hit');
    e.update(3.5);
    assert.equal(log.length, 1);
    assert.equal(log[0][1].finished, true);
    assert.equal(e.getState().score, 50 + 50 + 100);
});

test('hitting a note on a sustain\'s fret ends that sustain unscored', () => {
    const e = engine5([{ t: 1, f: G, l: 2 }, { t: 2, f: G }]);
    const log = collect(e, ['sustain-end']);
    press(e, 0.9, 'green');
    strum(e, 1);
    strum(e, 2);
    assert.equal(log.length, 1);
    assert.equal(log[0][1].finished, false);
    e.update(3.5);
    assert.equal(e.getState().score, 100, 'the held part is not scored');
});

test('extended sustain only needs its own frets (backwards overlap)', () => {
    // Red starts while green still sustains, so red's own sustain is extended: a fret held above it
    // does not drop it. A plain sustain is dropped by the same fret.
    const e = engine5([{ t: 1, f: G, l: 0.5 }, { t: 1.2, f: R, l: 1 }]);
    const log = collect(e, ['sustain-end']);
    press(e, 0.9, 'green');
    strum(e, 1);
    press(e, 1.2, 'red');
    strum(e, 1.2);
    press(e, 1.4, 'yellow');
    e.update(3);
    assert.deepEqual(log.map(x => x[1].finished), [true, true]);

    const e2 = engine5([{ t: 1.2, f: R, l: 1 }]);
    const log2 = collect(e2, ['sustain-end']);
    press(e2, 0.9, 'red');
    strum(e2, 1.2);
    press(e2, 1.4, 'yellow');
    e2.update(3);
    assert.deepEqual(log2.map(x => x[1].finished), [false]);
});

test('overstrum breaks an active sustain', () => {
    const e = engine5([{ t: 1, f: G, l: 2 }, { t: 5, f: G }]);
    const log = collect(e, ['sustain-end']);
    press(e, 0.9, 'green');
    strum(e, 1);
    strum(e, 2); // nothing in the window: small leniency, then an overstrum at 2.025
    e.update(2.1);
    assert.equal(e.getState().overstrums, 1);
    assert.equal(log.length, 1);
    assert.equal(log[0][1].finished, false);
    // YARG adds the points held so far (2.05 beats -> 52) without the multiplier.
    assert.equal(e.getState().score, 50 + 52);
});

test('SP phrase completed adds a quarter', () => {
    const e = engine5([{ t: 1, f: G }, { t: 1.5, f: G }, { t: 3, f: G }],
        { starPower: [{ start_time: 0.9, end_time: 2 }] });
    const log = collect(e, ['sp-phrase', 'sp-phrase-miss']);
    press(e, 0.5, 'green');
    strum(e, 1);
    assert.equal(e.getState().starPower.amount, 0);
    strum(e, 1.5);
    assert.deepEqual(log.map(x => x[0]), ['sp-phrase']);
    assert.equal(e.getState().starPower.amount, 0.25);
    assert.equal(e.getState().starPower.active, false);
});

test('SP phrase broken by a miss gives nothing', () => {
    const e = engine5([{ t: 1, f: G }, { t: 1.5, f: G }, { t: 3, f: G }],
        { starPower: [{ start_time: 0.9, end_time: 2 }] });
    const log = collect(e, ['sp-phrase', 'sp-phrase-miss']);
    press(e, 0.5, 'green');
    e.update(1.2); // first note of the phrase missed
    assert.deepEqual(log.map(x => x[0]), ['sp-phrase-miss']);
    strum(e, 1.5);
    assert.equal(e.noteState(1), 'hit');
    assert.deepEqual(log.map(x => x[0]), ['sp-phrase-miss']);
    assert.equal(e.getState().starPower.amount, 0);
});

test('overstrum fails the phrase unless on its first note', () => {
    const e = engine5([{ t: 1, f: G }, { t: 2, f: G }, { t: 2.5, f: G }, { t: 4, f: G }],
        { starPower: [{ start_time: 1.9, end_time: 2.6 }] });
    const log = collect(e, ['sp-phrase', 'sp-phrase-miss', 'overstrum']);
    press(e, 0.5, 'green');
    strum(e, 1);
    strum(e, 1.5); // overstrum while the phrase's first note is next: the phrase survives
    e.update(1.6);
    assert.deepEqual(log.map(x => x[0]), ['overstrum']);
    strum(e, 2);
    strum(e, 2.2); // overstrum inside the phrase: it fails
    e.update(2.3);
    assert.deepEqual(log.map(x => x[0]), ['overstrum', 'sp-phrase-miss', 'overstrum']);
    strum(e, 2.5);
    assert.equal(e.noteState(2), 'hit');
    assert.equal(e.getState().starPower.amount, 0);
});

// One single-note phrase per note, so each hit fills a quarter of the bar.
function spChart(phraseNotes, laterNotes) {
    const notes = phraseNotes.map(t => ({ t, f: G })).concat((laterNotes || []).map(t => ({ t, f: G })));
    const starPower = phraseNotes.map(t => ({ start_time: t - 0.1, end_time: t + 0.1 }));
    return { notes, starPower };
}

test('activate at half, refused below half', () => {
    const c = spChart([1, 2], [6]);
    const e = engine5(c.notes, { starPower: c.starPower });
    const log = collect(e, ['sp-ready', 'sp-activate']);
    press(e, 0.5, 'green');
    strum(e, 1);
    e.input(1.2, 'star_power', true);
    e.input(1.3, 'star_power', false);
    assert.equal(e.getState().starPower.active, false, 'a quarter bar is not enough');
    assert.equal(e.getState().starPower.amount, 0.25);
    strum(e, 2);
    assert.deepEqual(log.map(x => x[0]), ['sp-ready']);
    e.input(2.5, 'star_power', true);
    e.input(2.6, 'star_power', false);
    assert.equal(e.getState().starPower.active, true);
    assert.deepEqual(log.map(x => x[0]), ['sp-ready', 'sp-activate']);
});

test('SP drains over 8 measures and doubles multiplier', () => {
    const c = spChart([1, 2, 3, 4], [6, 30]);
    const e = engine5(c.notes, { starPower: c.starPower });
    const log = collect(e, ['sp-end']);
    press(e, 0.5, 'green');
    for (const t of [1, 2, 3, 4]) strum(e, t);
    assert.equal(e.getState().starPower.amount, 1);
    e.input(5, 'star_power', true);
    e.input(5, 'star_power', false);
    let s = e.getState();
    assert.equal(s.starPower.active, true);
    assert.equal(s.multiplier, 2, 'combo 4 = 1x, doubled');
    const before = s.score;
    strum(e, 6);
    assert.equal(e.getState().score - before, 100, 'a note scores 50 x 2');
    e.update(13); // 4 measures (8 s) in: half the bar left
    near(e.getState().starPower.amount, 0.5, 1e-9);
    e.update(20.9);
    assert.equal(e.getState().starPower.active, true);
    e.update(21.1); // 8 measures = 16 s after 5
    s = e.getState();
    assert.equal(s.starPower.active, false);
    assert.equal(s.starPower.amount, 0);
    assert.equal(s.multiplier, 1);
    assert.equal(log.length, 1);
    near(log[0][1].time, 21, 1e-6);
});

test('SP drain follows the measures of chart.beats (3/4 at 60 BPM)', () => {
    // A measure is 3 s, so half a bar (4 measures) lasts 12 s.
    const c = spChart([1, 2], [30]);
    const e = E.create({ notes: c.notes, starPower: c.starPower, solos: [], beats: steadyBeats(1, 3, 60) },
        { instrument: 'guitar' });
    const log = collect(e, ['sp-end']);
    press(e, 0.5, 'green');
    strum(e, 1);
    strum(e, 2);
    e.input(3, 'star_power', true);
    e.update(14.9);
    assert.equal(e.getState().starPower.active, true);
    e.update(15.1);
    assert.equal(log.length, 1);
    near(log[0][1].time, 15, 1e-6);
});

test('whammy refills during SP sustain', () => {
    // The phrase's last note has a 4-beat sustain: whammying through it adds 4/30 of a bar
    // (YARG: a full bar per 30 beats of whammy).
    const notes = [{ t: 1, f: G, l: 2 }, { t: 6, f: G, l: 2 }];
    const sp = [{ start_time: 0.9, end_time: 1.1 }];
    const e = engine5(notes, { starPower: sp });
    press(e, 0.5, 'green');
    strum(e, 1);
    assert.equal(e.getState().starPower.amount, 0.25);
    for (let t = 1; t <= 3.0001; t += 0.1) e.input(t, 'whammy', (Math.round(t * 10) % 2) ? 1 : 0.5);
    e.update(4);
    near(e.getState().starPower.amount, 0.25 + 4 / 30, 1e-6);

    // Whammy that stops keeps counting for 0.25 s after its last move (StarPowerWhammyBuffer):
    // moves at 1.0 and 1.1 count until 1.35, 0.7 beats.
    const e4 = engine5(notes, { starPower: sp });
    press(e4, 0.5, 'green');
    strum(e4, 1);
    e4.input(1, 'whammy', 1);
    e4.input(1.1, 'whammy', 0.5);
    e4.update(4);
    near(e4.getState().starPower.amount, 0.25 + 0.7 / 30, 1e-6);

    // No whammy: nothing added. Whammy on a sustain outside a phrase: nothing either.
    const e2 = engine5(notes, { starPower: sp });
    press(e2, 0.5, 'green');
    strum(e2, 1);
    e2.update(4);
    assert.equal(e2.getState().starPower.amount, 0.25);
    strum(e2, 6);
    for (let t = 6; t <= 8.0001; t += 0.1) e2.input(t, 'whammy', (Math.round(t * 10) % 2) ? 1 : 0.5);
    e2.update(9);
    assert.equal(e2.getState().starPower.amount, 0.25);

    // While star power is active, whammy gain pushes its end back. Half a bar (4 measures) activated
    // at 2 s would end at 10 s; whammying the 8-beat sustain (2 s to 6 s) adds 8 x 32 / 30 / 4 measures.
    const e3 = engine5([{ t: 1, f: G }, { t: 2, f: G, l: 4 }],
        { starPower: [{ start_time: 0.9, end_time: 1.1 }, { start_time: 1.9, end_time: 2.1 }] });
    const log3 = collect(e3, ['sp-end']);
    press(e3, 0.5, 'green');
    strum(e3, 1);
    strum(e3, 2);
    e3.input(2, 'star_power', true);
    assert.equal(e3.getState().starPower.active, true);
    for (let t = 2; t <= 6.0001; t += 0.1) e3.input(t, 'whammy', (Math.round(t * 10) % 2) ? 1 : 0.5);
    e3.update(20);
    assert.equal(log3.length, 1);
    near(log3[0][1].time, 2 * (3 + 4 + 8 * 32 / 30 / 4 - 2), 1e-6); // measure 7.133.. at 2 s per measure
});

test('solo percent', () => {
    const notes = [{ t: 1, f: G }, { t: 1.5, f: G }, { t: 2, f: G }, { t: 2.5, f: G }, { t: 5, f: G }];
    const e = engine5(notes, { solos: [{ start_time: 0.9, end_time: 3 }] });
    const log = collect(e, ['solo-start', 'solo-end']);
    press(e, 0.5, 'green');
    assert.deepEqual(e.getState().solo, { active: false, hit: 0, total: 0 });
    strum(e, 1);
    assert.deepEqual(log.map(x => x[0]), ['solo-start']);
    assert.deepEqual(e.getState().solo, { active: true, hit: 1, total: 4 });
    strum(e, 1.5);
    strum(e, 2);
    const before = e.getState().score;
    e.update(2.7); // the last solo note is missed
    assert.deepEqual(log.map(x => x[0]), ['solo-start', 'solo-end']);
    assert.equal(log[1][1].percent, 75);
    // YARG EndSolo: 100 x hit x (75% - 60%) / 40% = 112.5, rounded down to a multiple of 50.
    assert.equal(log[1][1].bonus, 100);
    assert.equal(e.getState().score - before, 100);
    assert.equal(e.getState().solo.active, false);

    // Under 60%: no bonus.
    const e2 = engine5(notes, { solos: [{ start_time: 0.9, end_time: 3 }] });
    const log2 = collect(e2, ['solo-end']);
    press(e2, 0.5, 'green');
    strum(e2, 1);
    strum(e2, 1.5);
    e2.update(2.7);
    assert.equal(log2[0][1].percent, 50);
    assert.equal(log2[0][1].bonus, 0);
});

test('stars from thresholds for guitar and bass', () => {
    // 20 notes, no sustains: the full-combo no-SP score YARG rates against is
    // 10 x 50 + 10 x 100 = 1500 (multiplier from the combo before each note).
    const notes = openRun(20);
    const g = engine(notes, { instrument: 'guitar' });
    const b = engine(notes, { instrument: 'bass' });
    assert.equal(g.getState().stars, 0);
    strumAll(g, notes, 2);
    strumAll(b, notes, 2);
    // Score 100. Guitar thresholds 90/180/...: 1 + (100 - 90) / 90. Bass 75/150/...: 1 + 25 / 75.
    near(g.getState().stars, 1 + 10 / 90, 1e-6);
    near(b.getState().stars, 1 + 25 / 75, 1e-6);
    strumAll(g, notes.slice(2), 2);
    strumAll(b, notes.slice(2), 2);
    // Score 200. Guitar: 2 + (200 - 180) / (300 - 180). Bass: 2 + (200 - 150) / (285 - 150).
    near(g.getState().stars, 2 + 20 / 120, 1e-6);
    near(b.getState().stars, 2 + 50 / 135, 1e-6);

    // A solo over the whole chart adds 100 points per note x [0.05, 0.1, ...] to the thresholds:
    // the first guitar threshold is 1500 x 0.06 + 2000 x 0.05 = 190.
    const gs = E.create({ notes, starPower: [], solos: [{ start_time: 0, end_time: 100 }], beats: [] },
        { instrument: 'guitar' });
    strumAll(gs, notes, 2);
    near(gs.getState().stars, 100 / 190, 1e-6);
});

test('reset(t) clears state ahead of t without misses', () => {
    const notes = [{ t: 1, f: G, l: 2 }, { t: 2, f: R }, { t: 4, f: G }, { t: 5, f: G }, { t: 6, f: G }];
    const e = engine5(notes, {
        starPower: [{ start_time: 0.9, end_time: 1.1 }, { start_time: 3.9, end_time: 4.1 }],
        solos: [{ start_time: 3.9, end_time: 6.5 }],
    });
    const log = collect(e, ['miss', 'sp-phrase-miss', 'solo-end', 'sustain-end']);
    press(e, 0.5, 'green');
    strum(e, 1); // phrase 1 awarded, sustain running
    assert.equal(e.getState().starPower.amount, 0.25);
    e.update(1.5);
    assert.ok(e.getState().score > 50);
    e.reset(4.5);
    const s = e.getState();
    assert.equal(s.score, 0);
    assert.equal(s.combo, 0);
    assert.equal(s.notesMissed, 0);
    assert.equal(s.stars, 0);
    assert.deepEqual(s.starPower, { amount: 0, active: false });
    assert.deepEqual(s.solo, { active: false, hit: 0, total: 0 });
    assert.deepEqual(log, [], 'no miss, phrase, solo or sustain events from the reset');
    assert.deepEqual([0, 1, 2].map(i => e.noteState(i)), [null, null, null]);
    // Note 3 starts the rest of the solo (the solo's first note was behind t).
    strum(e, 5);
    assert.deepEqual(e.getState().solo, { active: true, hit: 1, total: 2 });
    strum(e, 6);
    assert.equal(e.getState().notesMissed, 0);
    assert.equal(log.filter(x => x[0] === 'solo-end').length, 1);
    assert.equal(log.find(x => x[0] === 'solo-end')[1].percent, 100);
});

// ── API ──────────────────────────────────────────────────────────────────────

test('getState has the Task 4 fields', () => {
    const e = engine([{ t: 1, f: G }]);
    const s = e.getState();
    for (const k of ['score', 'combo', 'multiplier', 'notesHit', 'notesMissed', 'overstrums', 'ghostInputs']) {
        assert.equal(typeof s[k], 'number', k);
    }
});

test('off removes a listener; noteState of an unknown index is null', () => {
    const e = engine([{ t: 1, f: G }]);
    let n = 0;
    const fn = () => { n++; };
    e.on('miss', fn);
    e.off('miss', fn);
    e.update(2);
    assert.equal(n, 0);
    assert.equal(e.noteState(5), null);
});

test('notes keep their chart index when the chart is unsorted', () => {
    const e = engine([{ t: 2, f: R }, { t: 1, f: G }]);
    press(e, 0.9, 'green');
    strum(e, 1);
    assert.equal(e.noteState(1), 'hit');
    assert.equal(e.noteState(0), null);
});

test('reset(t) starts over at t without judging the notes before it', () => {
    const e = engine([{ t: 1, f: G }, { t: 2, f: G }, { t: 3, f: G }]);
    press(e, 0.9, 'green');
    strum(e, 1);
    e.reset(1.8);
    assert.deepEqual([e.noteState(0), e.noteState(1), e.noteState(2)], [null, null, null]);
    assert.equal(e.getState().score, 0);
    strum(e, 3); // green is still held after the reset
    e.update(3.5);
    assert.equal(e.noteState(2), 'hit');
    assert.equal(e.noteState(1), 'miss', 'note 1 was ahead of t, so it is played normally');
    assert.equal(e.getState().notesMissed, 1);
    assert.equal(e.noteState(0), null, 'note 0 was behind t: neither hit nor missed');
});

test('works as a browser global', () => {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'engine.js'), 'utf8');
    const win = {};
    vm.runInNewContext(src, { window: win });
    assert.equal(typeof win.FiveFretEngine.create, 'function');
});
