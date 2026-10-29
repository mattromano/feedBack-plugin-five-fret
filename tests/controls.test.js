'use strict';
// Tests for the pure helpers in assets/controls.js: the quick settings model (which controls show,
// with what values and options) and the input offset parser shared with the controls screen.
// Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
// Run: node --test tests/controls.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', 'assets', 'controls.js'));

const part = (instrument, sourceKind) => ({ instrument, sourceKind: sourceKind || 'chart', notes: [] });
const SONG = { lead: part('guitar'), low: part('bass'), rhy: part('rhythm', 'auto') };
const CUR = { part: 'auto', difficulty: 'hard', lefty: true };
const model = (extra) => C.quickSettingsModel(Object.assign({
    parts: SONG, playing: 'guitar', current: CUR, controllerKey: 'Xbox#1', offsetMs: { 'Xbox#1': 25 }, showAuto: false,
}, extra));

test('difficulty: all four, the current one selected (expert when unknown)', () => {
    const m = model();
    assert.deepEqual(m.difficulty.options.map((o) => o.id), ['easy', 'medium', 'hard', 'expert']);
    assert.deepEqual(m.difficulty.options.map((o) => o.label), ['Easy', 'Medium', 'Hard', 'Expert']);
    assert.equal(m.difficulty.value, 'hard');
    assert.equal(model({ current: { difficulty: 'insane' } }).difficulty.value, 'expert');
    assert.equal(model({ current: null }).difficulty.value, 'expert');
});

test('part: only the parts the song has, in guitar / rhythm / bass order, the playing one selected', () => {
    const m = model();
    assert.deepEqual(m.part.options.map((o) => o.id), ['guitar', 'bass']);   // rhythm is auto: hidden
    assert.deepEqual(m.part.options.map((o) => o.label), ['Guitar', 'Bass']);
    assert.equal(m.part.value, 'guitar');
    assert.equal(model({ playing: 'bass' }).part.value, 'bass');
    // Auto charts show while "Show auto charts" is on, flagged.
    const a = model({ showAuto: true });
    assert.deepEqual(a.part.options.map((o) => [o.id, o.auto]), [['guitar', false], ['rhythm', true], ['bass', false]]);
    // A chart beats an auto part for the same instrument.
    const both = model({ parts: { a: part('bass', 'auto'), b: part('bass'), g: part('guitar') }, showAuto: true });
    assert.deepEqual(both.part.options.map((o) => [o.id, o.auto]), [['guitar', false], ['bass', false]]);
});

test('part: nothing playing yet uses the setting, else the first part', () => {
    assert.equal(model({ playing: null, current: { part: 'bass' } }).part.value, 'bass');
    assert.equal(model({ playing: null, current: { part: 'auto' } }).part.value, 'guitar');
});

test('part: hidden with no parts, or with only the part that is playing', () => {
    assert.equal(model({ parts: null }).part, null);
    assert.equal(model({ parts: {} }).part, null);
    assert.equal(model({ parts: { g: part('guitar') } }).part, null);
    assert.equal(model({ parts: { r: part('rhythm', 'auto') } }).part, null);   // auto, hidden
});

test('part: a lane on a part the song lacks shows the parts there are, none selected', () => {
    const m = model({ parts: { g: part('guitar') }, playing: null, current: { part: 'rhythm' }, lane: true });
    assert.deepEqual(m.part.options.map((o) => o.id), ['guitar']);
    assert.equal(m.part.value, null);
});

test('lefty is a boolean', () => {
    assert.equal(model().lefty.value, true);
    assert.equal(model({ current: { lefty: 'yes' } }).lefty.value, false);
});

test('offset: per controller, hidden without one', () => {
    assert.deepEqual(model().offset, { controllerKey: 'Xbox#1', value: 25, min: -200, max: 200, step: 5 });
    assert.equal(model({ controllerKey: 'Pad#2' }).offset.value, 0);
    assert.equal(model({ offsetMs: null }).offset.value, 0);
    assert.equal(model({ controllerKey: null }).offset, null);
    assert.equal(model({ controllerKey: '' }).offset, null);
});

test('parseOffset: step 5, clamped to ±200, null for no number', () => {
    assert.equal(C.parseOffset('23'), 25);
    assert.equal(C.parseOffset('-999'), -200);
    assert.equal(C.parseOffset('200'), 200);
    assert.equal(C.parseOffset(-12), -10);
    assert.equal(C.parseOffset('abc'), null);
    assert.equal(C.parseOffset(''), null);
    assert.equal(C.parseOffset(null), null);
});
