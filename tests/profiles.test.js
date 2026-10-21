'use strict';
// Tests for profiles.js (controller profiles, input mapper, bindings and settings storage).
// Run: node --test tests/profiles.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const P = require(path.join(__dirname, '..', 'assets', 'profiles.js'));
const E = require(path.join(__dirname, '..', 'assets', 'engine.js'));

function memoryStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
    };
}
function withStorage(storage, fn) {
    const desc = Object.getOwnPropertyDescriptor(global, 'localStorage');
    Object.defineProperty(global, 'localStorage', { value: storage, configurable: true, writable: true });
    try { return fn(); } finally {
        if (desc) Object.defineProperty(global, 'localStorage', desc); else delete global.localStorage;
    }
}
const btn = (index, value) => ({ type: 'button', index, value, pressed: value >= 0.5, t: 1 });
const axis = (index, value) => ({ type: 'axis', index, value, t: 1 });

test('standard profile mapping', () => {
    const S = P.STANDARD_GAMEPAD;
    assert.equal(S.kind, 'gamepad');
    const expected = {
        green: 6, red: 4, yellow: 5, blue: 7, orange: 0, open: 2,
        star_power: 3, pause: 9, strum_down: 13, strum_up: 12,
    };
    for (const [action, index] of Object.entries(expected)) {
        assert.deepEqual(S.map[action], { type: 'button', index }, action);
    }
    assert.deepEqual(S.map.whammy, { type: 'axis', index: 2 });
    const m = P.createMapper(S);
    assert.deepEqual(m.map(btn(6, 1)), [{ action: 'green', value: 1 }]);
    assert.deepEqual(m.map(btn(6, 0)), [{ action: 'green', value: 0 }]);
    assert.deepEqual(m.map(btn(13, 1)), [{ action: 'strum_down', value: 1 }]);
    assert.deepEqual(m.map(btn(9, 1)), [{ action: 'pause', value: 1 }]);
    assert.deepEqual(m.map(btn(30, 1)), []);
    // Every mapped action other than pause is one the engine understands.
    for (const a of Object.keys(S.map)) {
        if (a !== 'pause') assert.ok(E.ACTIONS.includes(a), a);
    }
    assert.ok(P.ACTIONS.includes('pause'));
});

test('trigger hysteresis', () => {
    const m = P.createMapper(P.STANDARD_GAMEPAD);
    assert.deepEqual(m.map(btn(6, 0.4)), []);
    assert.deepEqual(m.map(btn(6, 0.5)), [{ action: 'green', value: 1 }]);
    assert.deepEqual(m.map(btn(6, 0.9)), []);   // still pressed, no repeat
    assert.deepEqual(m.map(btn(6, 0.4)), []);   // between 0.3 and 0.5: stays pressed
    assert.deepEqual(m.map(btn(6, 0.3)), [{ action: 'green', value: 0 }]);
    assert.deepEqual(m.map(btn(6, 0.4)), []);   // does not re-press below 0.5
    assert.deepEqual(m.map(btn(6, 0.6)), [{ action: 'green', value: 1 }]);
    // A button event without a value falls back to its pressed flag.
    const m2 = P.createMapper(P.STANDARD_GAMEPAD);
    assert.deepEqual(m2.map({ type: 'button', index: 4, pressed: true, t: 1 }), [{ action: 'red', value: 1 }]);
    assert.deepEqual(m2.map({ type: 'button', index: 4, pressed: false, t: 2 }), [{ action: 'red', value: 0 }]);
});

test('whammy normalised', () => {
    const m = P.createMapper(P.STANDARD_GAMEPAD);
    assert.deepEqual(m.map(axis(2, 0.5)), [{ action: 'whammy', value: 0.5 }]);
    assert.deepEqual(m.map(axis(2, -0.75)), [{ action: 'whammy', value: 0.75 }]);
    assert.deepEqual(m.map(axis(2, 0)), [{ action: 'whammy', value: 0 }]);
    assert.deepEqual(m.map(axis(2, 3)), [{ action: 'whammy', value: 1 }]);
    // A signed axis binding reads only its own direction.
    const g = P.createMapper({ kind: 'guitar', map: { whammy: { type: 'axis', index: 5, sign: -1 } } });
    assert.deepEqual(g.map(axis(5, -1)), [{ action: 'whammy', value: 1 }]);
    assert.deepEqual(g.map(axis(5, 0.5)), [{ action: 'whammy', value: 0 }]);
    // A signed axis can drive a digital action (hat-style strum) with hysteresis.
    const h = P.createMapper({ kind: 'guitar', map: { strum_down: { type: 'axis', index: 9, sign: 1 } } });
    assert.deepEqual(h.map(axis(9, 1)), [{ action: 'strum_down', value: 1 }]);
    assert.deepEqual(h.map(axis(9, 0)), [{ action: 'strum_down', value: 0 }]);
});

test('stored binding beats standard', () => {
    const info = { id: 'Pad (Vendor: 1 Product: 2)', mapping: 'standard' };
    const stored = { kind: 'guitar', map: { green: { type: 'button', index: 1 } } };
    assert.equal(P.resolveBinding(info, stored), stored);
    assert.equal(P.resolveBinding(info, undefined), P.STANDARD_GAMEPAD);
    assert.equal(P.resolveBinding(info, { bogus: true }), P.STANDARD_GAMEPAD);
});

test('unknown controller needs setup', () => {
    assert.equal(P.resolveBinding({ id: 'Guitar', mapping: '' }, undefined), null);
    assert.equal(P.resolveBinding({ id: 'Guitar', mapping: '' }, null), null);
    const stored = { kind: 'guitar', map: {} };
    assert.equal(P.resolveBinding({ id: 'Guitar', mapping: '' }, stored), stored);
});

test('controllerKey format', () => {
    assert.equal(P.controllerKey({ id: 'Xbox' }, 1), 'Xbox#1');
    assert.equal(P.controllerKey({ id: 'Xbox' }, 2), 'Xbox#2');
    assert.equal(P.controllerKey({ id: 'Xbox' }), 'Xbox#1');
});

test('bindings and settings round trip', () => {
    withStorage(memoryStorage(), () => {
        assert.deepEqual(P.loadBindings(), {});
        const b = { kind: 'guitar', map: { green: { type: 'button', index: 3 } } };
        P.saveBinding('Pad#1', b);
        P.saveBinding('Pad#2', P.STANDARD_GAMEPAD);
        assert.deepEqual(P.loadBindings()['Pad#1'], b);
        assert.deepEqual(Object.keys(P.loadBindings()).sort(), ['Pad#1', 'Pad#2']);
        const d = P.loadSettings();
        assert.equal(d.lefty, false);
        assert.equal(d.gamepadMode, null);
        assert.equal(d.part, 'auto');
        assert.equal(d.difficulty, 'expert');
        assert.deepEqual(d.offsetMs, {});
        P.saveSettings({ lefty: true, offsetMs: { 'Pad#1': 12 } });
        P.saveSettings({ difficulty: 'hard' });
        const s = P.loadSettings();
        assert.equal(s.lefty, true);
        assert.equal(s.difficulty, 'hard');
        assert.deepEqual(s.offsetMs, { 'Pad#1': 12 });
        assert.equal(global.localStorage.getItem('five_fret.bindings.v1') !== null, true);
        assert.equal(global.localStorage.getItem('five_fret.settings.v1') !== null, true);
    });
});

test('storage survives a throwing localStorage', () => {
    const boom = () => { throw new Error('denied'); };
    withStorage({ getItem: boom, setItem: boom, removeItem: boom }, () => {
        assert.deepEqual(P.loadBindings(), {});
        assert.doesNotThrow(() => P.saveBinding('k', { kind: 'gamepad', map: {} }));
        assert.equal(P.loadSettings().lefty, false);
        assert.doesNotThrow(() => P.saveSettings({ lefty: true }));
    });
    withStorage(memoryStorage(), () => {
        global.localStorage.setItem('five_fret.bindings.v1', '{not json');
        global.localStorage.setItem('five_fret.settings.v1', '[1,2]');
        assert.deepEqual(P.loadBindings(), {});
        assert.equal(P.loadSettings().gamepadMode, null);
    });
    // No usable localStorage at all.
    withStorage(undefined, () => {
        assert.deepEqual(P.loadBindings(), {});
        assert.doesNotThrow(() => P.saveSettings({ lefty: true }));
    });
});

test('effectiveGamepadMode follows controller kind unless set', () => {
    const pad = { kind: 'gamepad', map: {} };
    const guitar = { kind: 'guitar', map: {} };
    assert.equal(P.effectiveGamepadMode({ gamepadMode: null }, pad), true);
    assert.equal(P.effectiveGamepadMode({ gamepadMode: null }, guitar), false);
    assert.equal(P.effectiveGamepadMode({}, pad), true);
    assert.equal(P.effectiveGamepadMode(undefined, guitar), false);
    assert.equal(P.effectiveGamepadMode({ gamepadMode: null }, null), false);
    assert.equal(P.effectiveGamepadMode({ gamepadMode: false }, pad), false);
    assert.equal(P.effectiveGamepadMode({ gamepadMode: true }, guitar), true);
});

test('saveSettings keeps other controllers offsets', () => {
    withStorage(memoryStorage(), () => {
        P.saveSettings({ offsetMs: { 'A#1': 10 } });
        P.saveSettings({ offsetMs: { 'B#1': -5 } });
        assert.deepEqual(P.loadSettings().offsetMs, { 'A#1': 10, 'B#1': -5 });
        P.setOffset('A#1', 20);
        const s = P.setOffset('C#1', 3);
        assert.deepEqual(s.offsetMs, { 'A#1': 20, 'B#1': -5, 'C#1': 3 });
        P.saveSettings({ lefty: true });
        assert.deepEqual(P.loadSettings().offsetMs, { 'A#1': 20, 'B#1': -5, 'C#1': 3 });
    });
});

test('saveSettings re-normalises bad patches and returns what was stored', () => {
    withStorage(memoryStorage(), () => {
        P.saveSettings({ offsetMs: { 'A#1': 10 } });
        let s = P.saveSettings({ offsetMs: null, lefty: 'yes', difficulty: 5, gamepadMode: 'x', part: null });
        assert.deepEqual(s, { difficulty: 'expert', lefty: false, gamepadMode: null, offsetMs: { 'A#1': 10 }, part: 'auto', showAutoCharts: false });
        s = P.saveSettings({ offsetMs: [1, 2] });
        assert.deepEqual(s.offsetMs, { 'A#1': 10 });
        s = P.saveSettings({ offsetMs: { 'B#1': 'x', 'C#1': NaN, 'D#1': 7 } });
        assert.deepEqual(s.offsetMs, { 'A#1': 10, 'D#1': 7 });
        assert.deepEqual(P.loadSettings(), s);
        assert.doesNotThrow(() => P.saveSettings(null));
    });
});

test('controllerKey rejects a missing id; malformed bindings are not used', () => {
    assert.equal(P.controllerKey(undefined, 1), null);
    assert.equal(P.controllerKey({}, 1), null);
    assert.equal(P.controllerKey({ id: '' }, 1), null);
    const std = { id: 'X', mapping: 'standard' };
    assert.equal(P.resolveBinding(std, { kind: 'guitar', map: [] }), P.STANDARD_GAMEPAD);
    assert.equal(P.resolveBinding(std, 'str'), P.STANDARD_GAMEPAD);
    assert.equal(P.resolveBinding({ id: 'X', mapping: '' }, { kind: 'guitar', map: [] }), null);
    // Malformed entries inside a stored binding map are ignored by the mapper.
    const m = P.createMapper({ kind: 'guitar', map: { green: null, red: 'x', yellow: { type: 'button', index: 1 } } });
    assert.deepEqual(m.map(btn(1, 1)), [{ action: 'yellow', value: 1 }]);
    assert.deepEqual(m.map(btn(0, 1)), []);
});

test('settings default showAutoCharts false and coerces non-booleans', () => {
    withStorage(memoryStorage(), () => {
        assert.equal(P.loadSettings().showAutoCharts, false);
        assert.equal(P.saveSettings({ showAutoCharts: 'yes' }).showAutoCharts, false);
        assert.equal(P.saveSettings({ showAutoCharts: 1 }).showAutoCharts, false);
        assert.equal(P.saveSettings({ showAutoCharts: true }).showAutoCharts, true);
        assert.equal(P.loadSettings().showAutoCharts, true);
        P.saveSettings({ lefty: true });
        assert.equal(P.loadSettings().showAutoCharts, true);
    });
});
