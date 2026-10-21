'use strict';
// Tests for screen.js (the renderer factory and its wiring), in Node with a stub window, a minimal
// fake DOM, a fake gamepad-input domain and a stub view. engine/profiles/session are the real ones.
// Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
// Run: node --test tests/screen.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const E = require(path.join(__dirname, '..', 'assets', 'engine.js'));
const P = require(path.join(__dirname, '..', 'assets', 'profiles.js'));
const S = require(path.join(__dirname, '..', 'assets', 'session.js'));

const FRAME = 1 / 60;

// ── Fakes ────────────────────────────────────────────────────────────────────────

function fakeElement(tag) {
    const el = {
        tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, listeners: {}, parentNode: null,
        width: 800, height: 600, clientWidth: 800, clientHeight: 600, offsetLeft: 0, offsetTop: 0, offsetParent: {},
        appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = el; el.children.push(c); return c; },
        insertBefore(c) { return el.appendChild(c); },
        remove() {
            const p = el.parentNode;
            if (p) { p.children.splice(p.children.indexOf(el), 1); el.parentNode = null; }
        },
        contains(c) { for (let n = c; n; n = n.parentNode) if (n === el) return true; return false; },
        addEventListener(type, fn) { (el.listeners[type] || (el.listeners[type] = [])).push(fn); },
        getContext(type) { return type === 'webgl2' ? {} : null; },
        getBoundingClientRect() { return { width: 800, height: 600 }; },
    };
    return el;
}

function memoryStorage() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => m.delete(k) };
}

// One standard gamepad in slot 0 (or none).
function fakeGamepadInput(withPad) {
    const gi = {
        version: 1, claims: 0, releases: 0, changeFns: [], listeners: [],
        list() { return withPad ? [{ index: 0, id: 'Xbox', mapping: 'standard', connected: true, claimedBy: gi.held ? 'five_fret' : null }] : []; },
        claim(index, owner) {
            if (!withPad || gi.held) return null;
            gi.claims++;
            gi.held = true;
            return {
                index, id: 'Xbox', controllerKey: 'Xbox#1',
                addListener(fn) { gi.listeners.push(fn); },
                removeListener(fn) { gi.listeners = gi.listeners.filter((f) => f !== fn); },
                release() { gi.held = false; gi.releases++; },
            };
        },
        on(name, fn) {
            gi.changeFns.push(fn);
            return () => { gi.changeFns = gi.changeFns.filter((f) => f !== fn); };
        },
        change(type, index) { for (const fn of gi.changeFns.slice()) fn({ type, index }); },
        button(index, pressed) {
            const ev = { type: 'button', index, value: pressed ? 1 : 0, pressed, t: performance.now() / 1000 };
            for (const fn of gi.listeners.slice()) fn(ev);
        },
    };
    return gi;
}

// Installs window/document/localStorage for one test; returns the environment.
function setup(t, opts) {
    opts = opts || {};
    const saved = {};
    for (const k of ['window', 'document', 'localStorage']) {
        saved[k] = Object.getOwnPropertyDescriptor(global, k);
    }
    const slot = fakeElement('div');
    const renders = [];
    const views = [];
    const gi = fakeGamepadInput(opts.pad !== false);
    const storage = memoryStorage();
    const win = {
        FiveFretEngine: E, FiveFretProfiles: P, FiveFretSession: S, FiveFretLayout: {},
        FiveFretHighway3D: {
            createView() {
                const v = {
                    destroyed: false,
                    render(f) {
                        renders.push({ message: f.message, header: f.header, notes: f.notes.length, pressed: f.pressed.slice(),
                            lefty: f.lefty, hits: f.state ? f.state.notesHit : null, now: f.now });
                    },
                    resize() {},
                    destroy() { v.destroyed = true; },
                };
                views.push(v);
                return v;
            },
        },
        feedBack: { uiVersion: 'v3', ui: { playerControlSlot: () => slot }, gamepadInput: gi, on() {}, off() {} },
        togglePlays: 0,
        devicePixelRatio: 1,
    };
    win.togglePlay = () => { win.togglePlays++; };
    const doc = { createElement: fakeElement, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], head: fakeElement('head') };
    for (const [k, v] of [['window', win], ['document', doc], ['localStorage', storage]]) {
        Object.defineProperty(global, k, { value: v, configurable: true, writable: true });
    }
    t.after(() => {
        for (const k of Object.keys(saved)) {
            if (saved[k]) Object.defineProperty(global, k, saved[k]); else delete global[k];
        }
    });
    delete require.cache[require.resolve(path.join(__dirname, '..', 'screen.js'))];
    require(path.join(__dirname, '..', 'screen.js'));
    win.feedBackViz_five_fret.importThree = () => Promise.resolve({});
    return { win, slot, renders, views, gi, storage, last: () => renders[renders.length - 1] };
}

const G = 1, R = 2;
// A fresh parts object per test (draws within a test share it, as bundle.fiveFretParts is live).
function parts() {
    return {
        lead: { partId: 'lead', name: 'Lead', instrument: 'guitar', sourceKind: 'chart', notes: [{ t: 1, f: G }, { t: 2, f: R }],
            levels: { easy: { notes: [{ t: 1, f: G }], generated: true } }, starPower: [], solos: [] },
        low: { partId: 'low', name: 'Bass', instrument: 'bass', sourceKind: 'auto', notes: [{ t: 1, f: G }, { t: 1.5, f: G }, { t: 2, f: G }],
            levels: {}, starPower: [], solos: [] },
    };
}
// One beats array for the song: core swaps the reference only when the chart changes.
const BEATS = [];
function bundleAt(t, fiveFretParts, extra) {
    return Object.assign({ currentTime: t, isPlaying: true, songInfo: { arrangement: 'Lead' }, fiveFretParts, beats: BEATS, renderScale: 1 }, extra);
}
async function started(env) {
    const r = env.win.feedBackViz_five_fret();
    r.init(fakeElement('canvas'), {});
    await r.readyPromise;
    return r;
}

// ── Wiring ───────────────────────────────────────────────────────────────────────

test('init claims the gamepad, mounts the panel, and draws the picked part', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
    assert.equal(env.gi.claims, 1);
    assert.equal(env.slot.children.length, 1);
    r.draw(bundleAt(0, ff));
    assert.equal(env.last().notes, 2);
    assert.equal(env.last().message, null);
    assert.equal(env.last().header, 'Lead · GAMEPAD · Expert');
});

test('status messages: no part, no controller, disconnected and back', async (t) => {
    const env = setup(t, { pad: false });
    const ff = parts();
    const r = await started(env);
    r.draw(bundleAt(0, {}));
    assert.equal(env.last().message, 'No 5-fret chart for this song');
    r.draw(bundleAt(FRAME, ff));
    assert.equal(env.last().message, 'Connect a controller and press any button');

    const env2 = setup(t);
    const r2 = await started(env2);
    r2.draw(bundleAt(0, ff));
    env2.gi.button(6, true);   // green held
    r2.draw(bundleAt(FRAME, ff));
    assert.deepEqual(env2.last().pressed, [true, false, false, false, false]);
    env2.gi.change('disconnect', 0);
    r2.draw(bundleAt(2 * FRAME, ff));
    assert.equal(env2.last().message, 'Controller disconnected');
    assert.deepEqual(env2.last().pressed, [false, false, false, false, false]);   // nothing latched
    env2.gi.change('connect', 0);
    r2.draw(bundleAt(3 * FRAME, ff));
    assert.equal(env2.last().message, null);
});

test('controller inputs are judged on the chart clock', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
    for (let x = 0.8; x < 1; x += FRAME) r.draw(bundleAt(x, ff));
    r.draw(bundleAt(1, ff));
    env.gi.button(6, true);    // green
    env.gi.button(13, true);   // strum down
    r.draw(bundleAt(1 + FRAME, ff));
    assert.equal(env.last().hits, 1);
});

test('part and difficulty changes rebuild the session; held frets carry over', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
    r.draw(bundleAt(0, ff));
    env.gi.button(6, true);
    r.applySetting('difficulty', 'easy');
    r.draw(bundleAt(FRAME, ff));
    assert.equal(env.last().notes, 1);
    assert.equal(env.last().header, 'Lead · GAMEPAD · Easy');
    assert.deepEqual(env.last().pressed, [true, false, false, false, false]);
    r.applySetting('part', 'bass');
    r.applySetting('difficulty', 'expert');
    r.draw(bundleAt(2 * FRAME, ff));
    assert.equal(env.last().notes, 3);
    assert.equal(env.last().header, 'Bass · GAMEPAD · Expert');
    // Auto on a bass arrangement picks the bass part too.
    r.applySetting('part', 'auto');
    r.draw(bundleAt(3 * FRAME, ff, { songInfo: { arrangement: 'Bass' } }));
    assert.equal(env.last().notes, 3);
});

test('Start pauses through window.togglePlay', async (t) => {
    const env = setup(t);
    const ff = parts();
    await started(env);
    env.gi.button(9, true);
    env.gi.button(9, false);
    assert.equal(env.win.togglePlays, 1);
    delete env.win.togglePlay;
    assert.doesNotThrow(() => env.gi.button(9, true));
});

test('splitscreen-style instances keep their own settings; only the panel instance saves', async (t) => {
    const env = setup(t);
    const ff = parts();
    const a = await started(env);   // first: owns the player panel
    const b = await started(env);
    b.applySetting('part', 'bass');
    b.applySetting('difficulty', 'easy');
    assert.equal(a.getSetting('part'), 'auto');
    assert.equal(a.getSetting('difficulty'), 'expert');
    assert.equal(P.loadSettings().part, 'auto');   // b did not write the shared key
    a.applySetting('lefty', true);
    assert.equal(b.getSetting('lefty'), false);
    assert.equal(b.getSetting('part'), 'bass');
    assert.equal(P.loadSettings().lefty, true);     // the panel instance did
    // A new instance starts from the saved settings.
    const c = await started(env);
    assert.equal(c.getSetting('lefty'), true);
    assert.equal(c.getSetting('part'), 'auto');
});

test('destroy releases the claim, removes the panel and view; init again works', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
    r.draw(bundleAt(0, ff));
    r.destroy();
    assert.equal(env.gi.releases, 1);
    assert.equal(env.slot.children.length, 0);
    assert.equal(env.views[0].destroyed, true);
    assert.equal(env.gi.changeFns.length, 0);
    r.init(fakeElement('canvas'), {});
    await r.readyPromise;
    assert.equal(env.gi.claims, 2);
    assert.equal(env.slot.children.length, 1);
    r.draw(bundleAt(0, ff));
    assert.equal(env.last().message, null);
});

// ── Factory ───────────────────────────────────────────────────────────────────────

// Bare stub window: the factory statics and settings work before any init.
function loadScreen(t) {
    const had = Object.prototype.hasOwnProperty.call(global, 'window');
    const prev = global.window;
    global.window = {};
    t.after(() => { if (had) global.window = prev; else delete global.window; });
    delete require.cache[require.resolve(path.join(__dirname, '..', 'screen.js'))];
    require(path.join(__dirname, '..', 'screen.js'));
    return global.window;
}

test('factory: webgl2 on the renderer and as a static', (t) => {
    const w = loadScreen(t);
    assert.equal(typeof w.feedBackViz_five_fret, 'function');
    assert.equal(w.feedBackViz_five_fret.contextType, 'webgl2');
    const r = w.feedBackViz_five_fret();
    assert.equal(r.contextType, 'webgl2');
    for (const fn of ['init', 'draw', 'resize', 'destroy', 'applySetting', 'getSetting']) assert.equal(typeof r[fn], 'function', fn);
});

test('matchesArrangement: only the single 5-fret placeholder arrangement', (t) => {
    const match = loadScreen(t).feedBackViz_five_fret.matchesArrangement;
    const ff = [{ id: 'lead', name: 'Lead', instrument: 'guitar', source_kind: 'chart' }];
    assert.equal(match({ arrangements: [{ index: 0, name: 'Lead', notes: 0 }], five_fret_parts: ff }), true);
    // A normal song with a 5-fret part as well.
    assert.equal(match({ arrangements: [{ name: 'Lead', notes: 900 }], five_fret_parts: ff }), false);
    assert.equal(match({ arrangements: [{ name: 'Lead', notes: 0 }, { name: 'Bass', notes: 0 }], five_fret_parts: ff }), false);
    assert.equal(match({ arrangements: [{ name: 'Drums', notes: 0 }], five_fret_parts: ff, has_drum_tab: true }), false);
    assert.equal(match({ arrangements: [{ name: 'Lead', notes: 0 }], five_fret_parts: [] }), false);
    assert.equal(match({}), false);
    assert.equal(match(null), false);
});

test('applySetting before init keeps valid values and ignores the rest', (t) => {
    const r = loadScreen(t).feedBackViz_five_fret();
    assert.equal(r.getSetting('part'), 'auto');
    assert.equal(r.getSetting('difficulty'), 'expert');
    r.applySetting('part', 'bass');
    r.applySetting('difficulty', 'hard');
    r.applySetting('lefty', true);
    r.applySetting('difficulty', 'impossible');
    r.applySetting('part', 'drums');
    r.applySetting('lefty', 'yes');
    r.applySetting('offsetMs', 50);
    assert.equal(r.getSetting('part'), 'bass');
    assert.equal(r.getSetting('difficulty'), 'hard');
    assert.equal(r.getSetting('lefty'), true);
});

test('init without webgl2 rejects readyPromise and does not throw', async (t) => {
    const r = loadScreen(t).feedBackViz_five_fret();
    const canvas = { getContext: () => null };
    const warn = console.warn;
    const warned = [];
    console.warn = (...a) => warned.push(a.join(' '));
    try { assert.doesNotThrow(() => r.init(canvas, {})); } finally { console.warn = warn; }
    assert.ok(warned.some((m) => /webgl2/.test(m)));
    await assert.rejects(r.readyPromise, /webgl2 unavailable/);
    assert.doesNotThrow(() => r.draw({ currentTime: 1 }));
    assert.doesNotThrow(() => r.destroy());
});
