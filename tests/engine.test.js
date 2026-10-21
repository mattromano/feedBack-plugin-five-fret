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
