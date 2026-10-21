'use strict';
// Tests for the controller setup helpers in profiles.js (createSetupRecorder, calibrationOffset).
// Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
// Run: node --test tests/setup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const P = require(path.join(__dirname, '..', 'assets', 'profiles.js'));

const press = (index) => ({ type: 'button', index, value: 1, pressed: true, t: 1 });
const lift = (index) => ({ type: 'button', index, value: 0, pressed: false, t: 1 });
const axis = (index, value) => ({ type: 'axis', index, value, t: 1 });

test('setup action lists: guitar order, gamepad = the standard profile actions', () => {
    assert.deepEqual(P.SETUP_ACTIONS.guitar,
        ['green', 'red', 'yellow', 'blue', 'orange', 'strum_down', 'strum_up', 'whammy', 'star_power', 'pause']);
    assert.deepEqual(P.SETUP_ACTIONS.gamepad.slice().sort(), Object.keys(P.STANDARD_GAMEPAD.map).sort());
});

test('setup records each action once', () => {
    const rec = P.createSetupRecorder(['green', 'red', 'yellow']);
    assert.equal(rec.next, 'green');
    let r = rec.feed(press(0));
    assert.deepEqual(r, { done: false, next: 'red', binding: null, recorded: { action: 'green', spec: { type: 'button', index: 0 } } });
    // A release, or a second event while the button is still down, records nothing.
    r = rec.feed(lift(0));
    assert.equal(r.next, 'red');
    assert.equal(r.recorded, null);
    r = rec.feed(press(1));
    assert.equal(r.next, 'yellow');
    r = rec.feed({ type: 'button', index: 1, value: 0.9, pressed: true, t: 1 });   // still held
    assert.equal(r.next, 'yellow');
    r = rec.feed(press(4));
    assert.equal(r.done, true);
    assert.equal(r.next, null);
    assert.deepEqual(r.binding, { map: {
        green: { type: 'button', index: 0 }, red: { type: 'button', index: 1 }, yellow: { type: 'button', index: 4 },
    } });
    // Finished: further input changes nothing.
    r = rec.feed(press(7));
    assert.equal(r.done, true);
    assert.equal(r.recorded, null);
    assert.equal(Object.keys(r.binding.map).length, 3);
    // Bad events are ignored.
    const rec2 = P.createSetupRecorder(['green']);
    for (const ev of [null, {}, { type: 'button' }, { type: 'axis', index: 0, value: 'x' }]) {
        assert.equal(rec2.feed(ev).done, false);
    }
});

test('axis recorded with sign', () => {
    // Rest given: whammy rests at -1 and moves up.
    const rec = P.createSetupRecorder(['strum_down', 'strum_up', 'whammy'], { rest: { 1: 0, 3: -1 } });
    let r = rec.feed(axis(1, 0.3));      // not past 0.5 yet
    assert.equal(r.next, 'strum_down');
    r = rec.feed(axis(1, 0.9));
    assert.deepEqual(r.recorded, { action: 'strum_down', spec: { type: 'axis', index: 1, sign: 1 } });
    r = rec.feed(axis(1, 0));            // back to rest: no record
    assert.equal(r.next, 'strum_up');
    r = rec.feed(axis(1, -0.95));        // the same axis the other way is a different control
    assert.deepEqual(r.recorded, { action: 'strum_up', spec: { type: 'axis', index: 1, sign: -1 } });
    r = rec.feed(axis(3, -0.7));         // 0.3 from its rest of -1
    assert.equal(r.next, 'whammy');
    r = rec.feed(axis(3, -0.4));
    assert.equal(r.done, true);
    assert.deepEqual(r.binding.map.whammy, { type: 'axis', index: 3, sign: 1 });

    // No rest given: the first value seen is the rest (an axis resting at -1 jitters, then moves).
    const rec2 = P.createSetupRecorder(['whammy']);
    r = rec2.feed(axis(2, -0.98));
    assert.equal(r.done, false);
    r = rec2.feed(axis(2, -0.2));
    assert.deepEqual(r.binding.map.whammy, { type: 'axis', index: 2, sign: 1 });
});

test('duplicate control ignored', () => {
    const rec = P.createSetupRecorder(['green', 'red', 'strum_down', 'strum_up']);
    rec.feed(press(0));
    rec.feed(lift(0));
    let r = rec.feed(press(0));          // green's button again: ignored
    assert.equal(r.next, 'red');
    assert.equal(r.recorded, null);
    rec.feed(press(1));
    rec.feed(axis(1, 0));
    rec.feed(axis(1, 1));                // strum_down = axis 1 +
    rec.feed(axis(1, 0));
    r = rec.feed(axis(1, 1));            // axis 1 + again: ignored
    assert.equal(r.next, 'strum_up');
    r = rec.feed(press(12));
    assert.equal(r.done, true);
    assert.deepEqual(r.binding.map.strum_up, { type: 'button', index: 12 });

    // Controls already used elsewhere (a rebind) are ignored too; skip moves on without one.
    const rb = P.createSetupRecorder(['green', 'red'], { used: [{ type: 'button', index: 5 }] });
    r = rb.feed(press(5));
    assert.equal(r.next, 'green');
    r = rb.skip();
    assert.equal(r.next, 'red');
    r = rb.feed(press(6));
    assert.equal(r.done, true);
    assert.deepEqual(r.binding.map, { red: { type: 'button', index: 6 } });
});

test('calibration median ignores outliers', () => {
    const clicks = [1, 2, 3, 4, 5];
    // Late by 30, 20, 40, (a stray strum 500 ms off), 30 ms; one strum before the first click.
    const strums = [0.8, 1.03, 2.02, 3.04, 3.5, 5.03];
    const ms = P.calibrationOffset(clicks, strums);
    assert.ok(Math.abs(ms - 30) < 1e-6, String(ms));
    // Even count: the mean of the middle two. Early strums give a negative offset.
    assert.ok(Math.abs(P.calibrationOffset([1, 2], [0.99, 1.97]) - -20) < 1e-6);
    // Exactly 150 ms counts; nothing near: null.
    assert.ok(Math.abs(P.calibrationOffset([1], [1.15]) - 150) < 1e-6);
    assert.equal(P.calibrationOffset([1, 2], [1.4, 2.6]), null);
    assert.equal(P.calibrationOffset([], [1]), null);
    assert.equal(P.calibrationOffset(null, undefined), null);
});
