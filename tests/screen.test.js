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
const C = require(path.join(__dirname, '..', 'assets', 'controls.js'));

const FRAME = 1 / 60;

// ── Fakes ────────────────────────────────────────────────────────────────────────

function fakeElement(tag) {
    const classes = new Set();
    const el = {
        tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, listeners: {}, parentNode: null,
        width: 800, height: 600, clientWidth: 800, clientHeight: 600, offsetLeft: 0, offsetTop: 0, offsetParent: {},
        textContent: '', value: '', disabled: false, hidden: false, className: '',
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = el; el.children.push(c); return c; },
        append(...cs) { for (const c of cs) el.appendChild(c); },
        insertBefore(c) { return el.appendChild(c); },
        replaceChildren(...cs) { for (const c of el.children.slice()) c.remove(); for (const c of cs) el.appendChild(c); },
        remove() {
            const p = el.parentNode;
            if (p) { p.children.splice(p.children.indexOf(el), 1); el.parentNode = null; }
        },
        contains(c) { for (let n = c; n; n = n.parentNode) if (n === el) return true; return false; },
        addEventListener(type, fn) { (el.listeners[type] || (el.listeners[type] = [])).push(fn); },
        removeEventListener(type, fn) { el.listeners[type] = (el.listeners[type] || []).filter((f) => f !== fn); },
        fire(type) { for (const fn of (el.listeners[type] || []).slice()) fn({ type, target: el }); },
        getContext(type) { return type === 'webgl2' ? {} : null; },
        getBoundingClientRect() { return { width: 800, height: 600 }; },
    };
    return el;
}
// Depth-first search by data-ff (the controls screen tags its controls for tests).
function find(root, ff) {
    if (!root) return null;
    if (root.dataset && root.dataset.ff === ff) return root;
    for (const c of root.children || []) { const r = find(c, ff); if (r) return r; }
    return null;
}
function findAll(root, ff, out) {
    out = out || [];
    if (root.dataset && root.dataset.ff === ff) out.push(root);
    for (const c of root.children || []) findAll(c, ff, out);
    return out;
}

function memoryStorage() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => m.delete(k) };
}

// A fake core gamepad-input domain: one owner per controller (claim by the same owner returns the
// same handle), claim/release announced as change events, as core's static/capabilities/gamepad-input.js.
// pads: [{ id, mapping }] in slots 0..n (default: one standard 'Xbox' pad; none with pad:false).
function fakeGamepadInput(pads) {
    const held = new Map();   // index -> { owner, handle, listeners }
    const gi = {
        version: 1, claims: 0, releases: 0, changeFns: [], pads,
        get listeners() { const c = held.get(0); return c ? c.listeners : []; },
        list() {
            return pads.map((p, index) => ({ index, id: p.id, mapping: p.mapping, connected: true,
                claimedBy: held.has(index) ? held.get(index).owner : null }));
        },
        owner(index) { const c = held.get(index); return c ? c.owner : null; },
        claim(index, owner) {
            if (!pads[index]) return null;
            const c = held.get(index);
            if (c) return c.owner === owner ? c.handle : null;
            gi.claims++;
            const rec = { owner, listeners: [] };
            const n = pads.slice(0, index + 1).filter((p) => p.id === pads[index].id).length;
            rec.handle = {
                index, id: pads[index].id, controllerKey: pads[index].id + '#' + n,
                addListener(fn) { if (!rec.listeners.includes(fn)) rec.listeners = rec.listeners.concat(fn); },
                removeListener(fn) { rec.listeners = rec.listeners.filter((f) => f !== fn); },
                release() {
                    if (held.get(index) !== rec) return;
                    held.delete(index);
                    gi.releases++;
                    gi.change('release', index);
                },
            };
            held.set(index, rec);
            gi.change('claim', index);
            return rec.handle;
        },
        on(name, fn) {
            gi.changeFns.push(fn);
            return () => { gi.changeFns = gi.changeFns.filter((f) => f !== fn); };
        },
        change(type, index) { for (const fn of gi.changeFns.slice()) fn({ type, index }); },
        emit(ev, padIndex) {
            const c = held.get(padIndex || 0);
            if (c) for (const fn of c.listeners.slice()) fn(ev);
        },
        button(index, pressed, padIndex) {
            gi.emit({ type: 'button', index, value: pressed ? 1 : 0, pressed, t: performance.now() / 1000 }, padIndex);
        },
        axis(index, value, padIndex) {
            gi.emit({ type: 'axis', index, value, t: performance.now() / 1000 }, padIndex);
        },
    };
    return gi;
}

// window.feedBack's bus (emit -> CustomEvent-like { detail }).
function fakeBus() {
    const fns = {};
    return {
        on(name, fn) { (fns[name] || (fns[name] = [])).push(fn); },
        off(name, fn) { fns[name] = (fns[name] || []).filter((f) => f !== fn); },
        emit(name, detail) { for (const fn of (fns[name] || []).slice()) fn({ type: name, detail }); },
        count(name) { return (fns[name] || []).length; },
    };
}

// Web Audio stub: counts contexts and scheduled clicks; nothing plays.
function fakeAudio() {
    const audio = { contexts: [], clicks: 0 };
    audio.AudioContext = function () {
        const ctx = {
            currentTime: 0, state: 'running', closed: false, destination: {}, baseLatency: 0, outputLatency: 0,
            resume() { return Promise.resolve(); },
            close() { ctx.closed = true; ctx.state = 'closed'; return Promise.resolve(); },
            createOscillator() {
                return { type: '', frequency: { value: 0 }, connect() {}, start() { audio.clicks++; }, stop() {} };
            },
            createGain() {
                return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
            },
            // Output clock: context time 0 is heard at performance time ctx.perfZero (seconds).
            perfZero: 100,
            getOutputTimestamp() { return { contextTime: 0, performanceTime: ctx.perfZero * 1000 }; },
        };
        audio.contexts.push(ctx);
        return ctx;
    };
    return audio;
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
    const gi = fakeGamepadInput(opts.pads || (opts.pad === false ? [] : [{ id: 'Xbox', mapping: 'standard' }]));
    const storage = opts.storage || memoryStorage();
    const bus = fakeBus();
    const audio = fakeAudio();
    // The controls screen's DOM as core mounts screen.html (#plugin-five_fret).
    const dom = {
        'plugin-five_fret': fakeElement('div'),
        'five-fret-controls-list': fakeElement('div'),
        'five-fret-controls-back': fakeElement('button'),
    };
    const shown = [];
    const win = {
        FiveFretEngine: E, FiveFretProfiles: P, FiveFretSession: S, FiveFretLayout: {}, FiveFretControls: C,
        FiveFretHighway3D: {
            createView(THREE, cv) {
                const v = {
                    destroyed: false,
                    render(f) {
                        renders.push({ message: f.message, header: f.header, notes: f.notes.length, pressed: f.pressed.slice(),
                            lefty: f.lefty, hits: f.state ? f.state.notesHit : null, now: f.now, scoreHidden: f.scoreHidden, canvas: cv,
                            starPower: f.starPower });
                    },
                    resize() {},
                    destroy() { v.destroyed = true; },
                };
                views.push(v);
                return v;
            },
        },
        feedBack: Object.assign(bus, { uiVersion: 'v3', ui: { playerControlSlot: () => slot }, gamepadInput: gi }),
        togglePlays: 0,
        devicePixelRatio: 1,
        AudioContext: audio.AudioContext,
        showScreen: (id) => shown.push(id),
    };
    win.togglePlay = () => { win.togglePlays++; };
    const doc = { createElement: fakeElement, getElementById: (id) => dom[id] || null, querySelector: () => null, querySelectorAll: () => [], head: fakeElement('head') };
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
    return { win, slot, renders, views, gi, bus, audio, dom, shown, storage, list: dom['five-fret-controls-list'],
        last: () => renders[renders.length - 1] };
}

const G = 1, R = 2;
// A fresh parts object per test (draws within a test share it, as bundle.fiveFretParts is live).
function parts() {
    return {
        lead: { partId: 'lead', name: 'Lead', instrument: 'guitar', sourceKind: 'chart', notes: [{ t: 1, f: G }, { t: 2, f: R }],
            levels: { easy: { notes: [{ t: 1, f: G }], generated: true } }, starPower: [], solos: [] },
        low: { partId: 'low', name: 'Bass', instrument: 'bass', sourceKind: 'chart', notes: [{ t: 1, f: G }, { t: 1.5, f: G }, { t: 2, f: G }],
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

test('init mounts the panel; the first playing draw claims the gamepad and draws the picked part', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
    assert.equal(env.gi.claims, 0);   // nothing plays yet
    assert.equal(env.slot.children.length, 1);
    // Only classes core's tailwind.min.css has: bg-fb-card, text-fb-textDim, ... never a bare fb-* token.
    const panel = env.slot.children[0];
    assert.match(panel.className, /(^|\s)bg-fb-card(\s|$)/);
    const bare = [];
    (function walk(n) {
        for (const c of String(n.className || '').split(/\s+/)) if (/^fb-/.test(c)) bare.push(c);
        for (const k of n.children || []) walk(k);
    })(panel);
    assert.deepEqual(bare, []);
    r.draw(bundleAt(0, ff));
    assert.equal(env.gi.claims, 1);
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
    const r = await started(env);
    r.draw(bundleAt(0, ff));
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
    assert.equal(env.slot.children.length, 1);
    r.draw(bundleAt(0, ff));
    assert.equal(env.gi.claims, 2);
    assert.equal(env.last().message, null);
});

// ── Bindings changed mid-session ──────────────────────────────────────────────────

const GUITAR_MAP = {
    green: { type: 'button', index: 0 }, red: { type: 'button', index: 1 }, yellow: { type: 'button', index: 2 },
    blue: { type: 'button', index: 3 }, orange: { type: 'button', index: 4 },
    strum_down: { type: 'axis', index: 1, sign: 1 }, strum_up: { type: 'axis', index: 1, sign: -1 },
    whammy: { type: 'axis', index: 2, sign: 1 }, star_power: { type: 'button', index: 5 }, pause: { type: 'button', index: 6 },
};
const tick = () => new Promise((r) => setImmediate(r));

test('a binding saved mid-session is picked up by the renderer (five_fret:bindings-changed)', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
    r.draw(bundleAt(0, ff));
    assert.equal(env.last().header, 'Lead · GAMEPAD · Expert');
    P.saveBinding('Xbox#1', { kind: 'guitar', map: GUITAR_MAP });
    env.gi.button(6, true);    // green held (standard map)
    // Another controller's change leaves this one alone: same binding, held fret kept.
    env.bus.emit('five_fret:bindings-changed', { controllerKey: 'Other#1' });
    env.bus.emit('five_fret:offset-changed', { controllerKey: 'Other#1', offsetMs: 50 });
    r.draw(bundleAt(FRAME / 2, ff));
    assert.equal(env.last().header, 'Lead · GAMEPAD · Expert');
    assert.deepEqual(env.last().pressed, [true, false, false, false, false]);
    env.gi.button(6, false);
    env.bus.emit('five_fret:bindings-changed', { controllerKey: 'Xbox#1' });
    r.draw(bundleAt(FRAME, ff));
    assert.equal(env.last().header, 'Lead · GUITAR · Expert');
    env.gi.button(0, true);    // green under the new binding (the standard map has orange there)
    r.draw(bundleAt(2 * FRAME, ff));
    assert.deepEqual(env.last().pressed, [true, false, false, false, false]);
    assert.equal(env.gi.claims, 1);   // same claim, new binding

    // An unbound controller (a plastic guitar) is claimed once a binding for it is saved.
    const env2 = setup(t, { pads: [{ id: 'Guitar', mapping: '' }] });
    const r2 = await started(env2);
    r2.draw(bundleAt(0, ff));
    assert.equal(env2.gi.claims, 0);
    assert.equal(env2.last().message, 'Connect a controller and press any button');
    P.saveBinding('Guitar#1', { kind: 'guitar', map: GUITAR_MAP });
    env2.bus.emit('five_fret:bindings-changed', { controllerKey: 'Guitar#1' });
    r2.draw(bundleAt(FRAME, ff));
    assert.equal(env2.gi.owner(0), 'five_fret');
    assert.equal(env2.last().message, null);
    r2.destroy();
    assert.equal(env2.bus.count('five_fret:bindings-changed'), 0);
});

test('auto parts are hidden until "Show auto charts" is on (five_fret:settings-changed)', async (t) => {
    const env = setup(t);
    const only = { low: Object.assign({}, parts().low, { sourceKind: 'auto' }) };
    const r = await started(env);
    r.draw(bundleAt(0, only));
    assert.equal(env.last().message, 'No 5-fret chart for this song');
    P.saveSettings({ showAutoCharts: true });
    env.bus.emit('five_fret:settings-changed', { showAutoCharts: true });
    r.draw(bundleAt(FRAME, only));
    assert.equal(env.last().notes, 3);
    assert.notEqual(env.last().message, 'No 5-fret chart for this song');
    P.saveSettings({ showAutoCharts: false });
    env.bus.emit('five_fret:settings-changed', {});
    r.draw(bundleAt(2 * FRAME, only));
    assert.equal(env.last().message, 'No 5-fret chart for this song');
    r.destroy();
    assert.equal(env.bus.count('five_fret:settings-changed'), 0);
});

// ── Claim rules ──────────────────────────────────────────────────────────────────

test('a set-up controller is claimed before a standard pad in an earlier slot', async (t) => {
    const env = setup(t, { pads: [{ id: 'Xbox', mapping: 'standard' }, { id: 'Guitar', mapping: '' }] });
    P.saveBinding('Guitar#1', { kind: 'guitar', map: GUITAR_MAP });
    const ff = parts();
    const r = await started(env);
    r.draw(bundleAt(0, ff));
    assert.equal(env.gi.owner(1), 'five_fret');
    assert.equal(env.gi.owner(0), null);
    assert.equal(env.gi.claims, 1);
    assert.equal(env.last().header, 'Lead · GUITAR · Expert');
    // Without a saved binding, the standard pad is still the fallback.
    const env2 = setup(t, { pads: [{ id: 'Guitar', mapping: '' }, { id: 'Xbox', mapping: 'standard' }] });
    const r2 = await started(env2);
    r2.draw(bundleAt(0, ff));
    assert.equal(env2.gi.owner(1), 'five_fret');
    assert.equal(env2.last().header, 'Lead · GAMEPAD · Expert');
});

test('the claim is held only while a part plays: none on a no-part song, released while paused', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
    // A song with no 5-fret part: the pad stays with core's menus.
    r.draw(bundleAt(0, {}));
    r.draw(bundleAt(FRAME, {}));
    assert.equal(env.gi.claims, 0);
    assert.equal(env.last().message, 'No 5-fret chart for this song');
    // Before playback starts (paused): no claim, and no controller message for a ready pad.
    r.draw(bundleAt(0, ff, { isPlaying: false }));
    assert.equal(env.gi.claims, 0);
    assert.equal(env.last().message, null);
    assert.equal(env.last().header, 'Lead · GAMEPAD · Expert');
    // Playing: claimed.
    r.draw(bundleAt(FRAME, ff));
    assert.equal(env.gi.owner(0), 'five_fret');
    env.gi.button(6, true);   // green held
    r.draw(bundleAt(2 * FRAME, ff));
    assert.deepEqual(env.last().pressed, [true, false, false, false, false]);
    // Paused: released, the held fret let go, nothing said about the controller.
    r.draw(bundleAt(2 * FRAME, ff, { isPlaying: false }));
    assert.equal(env.gi.owner(0), null);
    assert.equal(env.gi.releases, 1);
    assert.deepEqual(env.last().pressed, [false, false, false, false, false]);
    assert.equal(env.last().message, null);
    assert.equal(env.last().header, 'Lead · GAMEPAD · Expert');
    env.gi.button(6, true);   // core's menus have it now: the renderer ignores it
    r.draw(bundleAt(2 * FRAME, ff, { isPlaying: false }));
    assert.deepEqual(env.last().pressed, [false, false, false, false, false]);
    // Resumed: claimed again, and plays.
    r.draw(bundleAt(3 * FRAME, ff));
    assert.equal(env.gi.owner(0), 'five_fret');
    assert.equal(env.gi.claims, 2);
    env.gi.button(4, true);   // red
    r.draw(bundleAt(4 * FRAME, ff));
    assert.deepEqual(env.last().pressed, [false, true, false, false, false]);
    // The part goes away mid-song (a song change): released again.
    r.draw(bundleAt(5 * FRAME, {}));
    assert.equal(env.gi.owner(0), null);
    assert.equal(env.gi.releases, 2);
    // Paused with no controller at all: say so.
    const env2 = setup(t, { pad: false });
    const r2 = await started(env2);
    r2.draw(bundleAt(0, ff, { isPlaying: false }));
    assert.equal(env2.last().message, 'Connect a controller and press any button');
    assert.equal(env2.last().header, 'Lead · NO CONTROLLER · Expert');
});

test('pausing does not rebuild the session (score and gamepad mode kept)', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
    for (let x = 0.8; x < 1; x += FRAME) r.draw(bundleAt(x, ff));
    r.draw(bundleAt(1, ff));
    env.gi.button(6, true);
    env.gi.button(13, true);
    r.draw(bundleAt(1 + FRAME, ff));
    assert.equal(env.last().hits, 1);
    r.draw(bundleAt(1 + FRAME, ff, { isPlaying: false }));
    assert.equal(env.last().hits, 1);
    assert.equal(r.getSetting('gamepadMode'), true);
    r.draw(bundleAt(1 + 2 * FRAME, ff));
    assert.equal(env.last().hits, 1);
});

// ── Band API (window.feedBackFiveFret) ───────────────────────────────────────────────

async function startedOn(env, canvas) {
    const r = env.win.feedBackViz_five_fret();
    r.init(canvas, {});
    await r.readyPromise;
    return r;
}
const lane = (extra) => Object.assign({ controllerKey: 'Xbox#1', part: 'guitar', difficulty: 'easy', lefty: true }, extra);

test('setLane before init pins the instance that inits on the canvas', async (t) => {
    const env = setup(t);
    const api = env.win.feedBackFiveFret;
    assert.equal(api.version, 1);
    const cv = fakeElement('canvas');
    assert.equal(api.setLane(cv, lane()), true);
    const r = await startedOn(env, cv);
    assert.equal(env.gi.owner(0), 'five_fret');   // claimed from setLane, before any draw
    r.draw(bundleAt(0, parts()));
    assert.equal(env.last().header, 'Lead · GAMEPAD · Easy');
    assert.equal(env.last().notes, 1);
    assert.equal(env.last().lefty, true);
    // Bad arguments change nothing.
    for (const bad of [lane({ part: 'auto' }), lane({ part: 'drums' }), lane({ difficulty: 'insane' }),
        lane({ controllerKey: '' }), lane({ controllerKey: 7 }), lane({ lefty: 'yes' })]) {
        assert.equal(api.setLane(cv, bad), false);
    }
    assert.equal(api.setLane(null, lane()), false);
    assert.equal(api.setLane(cv, null), false);
    r.draw(bundleAt(FRAME, parts()));
    assert.equal(env.last().header, 'Lead · GAMEPAD · Easy');
    // Calling again updates.
    assert.equal(api.setLane(cv, lane({ part: 'bass', difficulty: 'expert', lefty: false })), true);   // bass: no levels
    r.draw(bundleAt(2 * FRAME, parts()));
    assert.equal(env.last().header, 'Bass · GAMEPAD · Expert');
    assert.equal(env.last().lefty, false);
    assert.equal(env.gi.claims, 1);   // same controller, same claim
    // setDifficulty updates the pinned lane (drums parity); an unpinned canvas is a no-op.
    api.setLane(cv, lane({ difficulty: 'expert' }));
    assert.equal(api.setDifficulty('easy', cv), true);
    r.draw(bundleAt(3 * FRAME, parts()));
    assert.equal(env.last().header, 'Lead · GAMEPAD · Easy');
    assert.equal(env.last().notes, 1);
    assert.equal(api.setDifficulty('insane', cv), false);
    assert.equal(api.setDifficulty('easy', fakeElement('canvas')), false);
});

test('a pinned lane claims only its controllerKey, even with a standard pad in an earlier slot', async (t) => {
    const env = setup(t, { pads: [{ id: 'Xbox', mapping: 'standard' }, { id: 'Xbox', mapping: 'standard' }] });
    const api = env.win.feedBackFiveFret;
    const cv = fakeElement('canvas');
    api.setLane(cv, lane({ controllerKey: 'Xbox#2' }));
    const r = await startedOn(env, cv);
    r.draw(bundleAt(0, parts()));
    assert.equal(env.gi.owner(0), null);
    assert.equal(env.gi.owner(1), 'five_fret');
    assert.equal(env.gi.claims, 1);
    // Its inputs come from that pad only.
    env.gi.button(6, true, 0);
    r.draw(bundleAt(FRAME, parts()));
    assert.deepEqual(env.last().pressed, [false, false, false, false, false]);
    env.gi.button(6, true, 1);
    r.draw(bundleAt(2 * FRAME, parts()));
    assert.deepEqual(env.last().pressed, [true, false, false, false, false]);
    // A key that is not connected: nothing is claimed.
    const env2 = setup(t);
    const cv2 = fakeElement('canvas');
    env2.win.feedBackFiveFret.setLane(cv2, lane({ controllerKey: 'Guitar#1' }));
    const r2 = await startedOn(env2, cv2);
    r2.draw(bundleAt(0, parts()));
    assert.equal(env2.gi.claims, 0);
    assert.equal(env2.last().message, 'Connect a controller and press any button');
});

test('a pinned lane keeps its claim while paused and before the part loads', async (t) => {
    const env = setup(t);
    const api = env.win.feedBackFiveFret;
    const cv = fakeElement('canvas');
    api.setLane(cv, lane());
    const r = await startedOn(env, cv);
    assert.equal(env.gi.owner(0), 'five_fret');
    r.draw(bundleAt(0, {}));                              // no part yet
    assert.equal(env.gi.owner(0), 'five_fret');
    r.draw(bundleAt(0, parts(), { isPlaying: false }));   // counting in / paused
    assert.equal(env.gi.owner(0), 'five_fret');
    r.draw(bundleAt(FRAME, parts()));
    r.draw(bundleAt(FRAME, parts(), { isPlaying: false }));
    assert.equal(env.gi.owner(0), 'five_fret');
    assert.equal(env.gi.releases, 0);
    assert.equal(env.gi.claims, 1);
    // A pad plugged in later is claimed as soon as it connects.
    const env2 = setup(t, { pad: false });
    const cv2 = fakeElement('canvas');
    env2.win.feedBackFiveFret.setLane(cv2, lane());
    const r2 = await startedOn(env2, cv2);
    r2.draw(bundleAt(0, parts(), { isPlaying: false }));
    env2.gi.pads.push({ id: 'Xbox', mapping: 'standard' });
    env2.gi.change('connect', 0);
    assert.equal(env2.gi.owner(0), 'five_fret');
    // destroy releases it.
    r2.destroy();
    assert.equal(env2.gi.owner(0), null);
});

test('a paused pinned lane is strummed and its combo and overstrums are unchanged', async (t) => {
    const env = setup(t);
    const api = env.win.feedBackFiveFret;
    const cv = fakeElement('canvas');
    api.setLane(cv, lane({ difficulty: 'expert', lefty: false }));
    const r = await startedOn(env, cv);
    const ff = parts();
    for (let x = 0.8; x < 1; x += FRAME) r.draw(bundleAt(x, ff));
    r.draw(bundleAt(1, ff));
    env.gi.button(6, true);    // green
    env.gi.button(13, true);   // strum: hits the note at 1
    r.draw(bundleAt(1 + FRAME, ff));
    env.gi.button(13, false);
    env.gi.button(6, false);
    const before = api.getInstanceState(cv);
    assert.equal(before.combo, 1);
    // Paused away from any note: a strum would be an overstrum.
    for (let x = 1 + 2 * FRAME; x < 1.5; x += FRAME) r.draw(bundleAt(x, ff));
    r.draw(bundleAt(1.5, ff));
    r.draw(bundleAt(1.5, ff, { isPlaying: false }));
    env.gi.button(13, true);
    env.gi.button(13, false);
    r.draw(bundleAt(1.5, ff, { isPlaying: false }));
    // Paused on the note at 2 (red): a strum would hit it while the song is stopped.
    for (let x = 1.5 + FRAME; x < 2; x += FRAME) r.draw(bundleAt(x, ff));
    r.draw(bundleAt(2, ff, { isPlaying: false }));
    env.gi.button(4, true);    // red
    env.gi.button(13, true);
    r.draw(bundleAt(2, ff, { isPlaying: false }));
    const paused = api.getInstanceState(cv);
    assert.equal(paused.combo, 1);
    assert.equal(paused.overstrums, 0);
    assert.equal(paused.notesHit, 1);
    assert.deepEqual(env.last().pressed, [false, false, false, false, false]);   // presses not taken
    assert.equal(env.gi.owner(0), 'five_fret');                                  // claim kept
    // Releases still go through, and play resumes normally.
    env.gi.button(4, false);
    env.gi.button(13, false);
    r.draw(bundleAt(2, ff));
    env.gi.button(4, true);
    env.gi.button(13, true);
    r.draw(bundleAt(2 + FRAME, ff));
    assert.equal(api.getInstanceState(cv).notesHit, 2);
});

test('a pinned lane plays its part exactly: Rhythm missing shows the no-chart message', async (t) => {
    const env = setup(t);
    const cv = fakeElement('canvas');
    env.win.feedBackFiveFret.setLane(cv, lane({ part: 'rhythm' }));
    const r = await startedOn(env, cv);
    r.draw(bundleAt(0, parts()));   // Lead and Bass only
    assert.equal(env.last().message, 'No 5-fret chart for this song');
    assert.equal(env.last().notes, 0);
    assert.equal(env.last().header, '');
});

test('a pinned lane uses the pinned difficulty and lefty and never mounts the panel or saves settings', async (t) => {
    const env = setup(t);
    P.saveSettings({ difficulty: 'hard', lefty: false, gamepadMode: false });
    const saved = env.storage.getItem(P.SETTINGS_KEY);
    const api = env.win.feedBackFiveFret;
    const cv = fakeElement('canvas');
    api.setLane(cv, lane({ difficulty: 'easy', lefty: true }));
    const r = await startedOn(env, cv);
    assert.equal(env.slot.children.length, 0);
    r.draw(bundleAt(0, parts()));
    assert.equal(env.last().header, 'Lead · GAMEPAD · Easy');
    assert.equal(env.last().lefty, true);
    assert.equal(r.getSetting('difficulty'), 'easy');
    // The saved global gamepadMode (off) is ignored: the controller's kind decides (a pad: on).
    assert.equal(r.getSetting('gamepadMode'), true);
    r.applySetting('difficulty', 'expert');
    r.applySetting('lefty', false);
    assert.equal(env.storage.getItem(P.SETTINGS_KEY), saved);
    assert.equal(env.slot.children.length, 0);
    // Pinning an instance that owns the panel takes the panel away.
    const cv2 = fakeElement('canvas');
    const r2 = await startedOn(env, cv2);
    assert.equal(env.slot.children.length, 1);
    api.setLane(cv2, lane({ controllerKey: 'Xbox#1' }));
    assert.equal(env.slot.children.length, 0);
    r2.applySetting('difficulty', 'easy');
    assert.equal(env.storage.getItem(P.SETTINGS_KEY), saved);
    // A guitar-bound controller plays without gamepad mode even when the saved setting is on.
    P.saveSettings({ gamepadMode: true });
    const env3 = setup(t, { pads: [{ id: 'Guitar', mapping: '' }], storage: env.storage });
    P.saveBinding('Guitar#1', { kind: 'guitar', map: GUITAR_MAP });
    const cv3 = fakeElement('canvas');
    env3.win.feedBackFiveFret.setLane(cv3, lane({ controllerKey: 'Guitar#1' }));
    const r3 = await startedOn(env3, cv3);
    assert.equal(r3.getSetting('gamepadMode'), false);
});

test('clearLane returns the instance to its own settings', async (t) => {
    const env = setup(t);
    const api = env.win.feedBackFiveFret;
    const cv = fakeElement('canvas');
    api.setLane(cv, lane({ difficulty: 'easy', lefty: true }));
    const r = await startedOn(env, cv);
    r.draw(bundleAt(0, parts(), { isPlaying: false }));
    assert.equal(env.gi.owner(0), 'five_fret');
    api.clearLane(cv);
    // Back to the unpinned rules: paused, so the claim is let go; its own settings; the panel.
    assert.equal(env.gi.owner(0), null);
    assert.equal(env.slot.children.length, 1);
    r.draw(bundleAt(0, parts(), { isPlaying: false }));
    assert.equal(env.last().header, 'Lead · GAMEPAD · Expert');
    assert.equal(env.last().lefty, false);
    r.draw(bundleAt(FRAME, parts()));
    assert.equal(env.gi.owner(0), 'five_fret');
    assert.doesNotThrow(() => api.clearLane(null));
    // A re-init on a cleared canvas is not pinned.
    r.init(cv, {});
    await r.readyPromise;
    assert.equal(env.slot.children.length, 1);
});

test('setScoreHudHidden sets frame.scoreHidden for that canvas only', async (t) => {
    const env = setup(t, { pads: [{ id: 'Xbox', mapping: 'standard' }, { id: 'Xbox', mapping: 'standard' }] });
    const api = env.win.feedBackFiveFret;
    const a = fakeElement('canvas'), b = fakeElement('canvas');
    api.setLane(a, lane());
    api.setLane(b, lane({ controllerKey: 'Xbox#2' }));
    const ra = await startedOn(env, a);
    const rb = await startedOn(env, b);
    assert.equal(api.setScoreHudHidden(a, true), true);
    assert.equal(api.setScoreHudHidden(a, 'yes'), false);
    assert.equal(api.setScoreHudHidden(null, true), false);
    assert.equal(api.isScoreHudHidden(a), true);
    assert.equal(api.isScoreHudHidden(b), false);
    ra.draw(bundleAt(0, parts()));
    assert.equal(env.last().scoreHidden, true);
    rb.draw(bundleAt(0, parts()));
    assert.equal(env.last().scoreHidden, false);
    api.setScoreHudHidden(a, false);
    ra.draw(bundleAt(FRAME, parts()));
    assert.equal(env.last().scoreHidden, false);
    assert.equal(env.last().canvas, a);
});

test('getInstanceState returns engine state plus full-chart starThresholds, unchanged by a seek', async (t) => {
    const env = setup(t);
    const api = env.win.feedBackFiveFret;
    const cv = fakeElement('canvas');
    assert.equal(api.getInstanceState(cv), null);
    api.setLane(cv, lane({ difficulty: 'expert' }));
    const r = await startedOn(env, cv);
    assert.equal(api.getInstanceState(cv), null);   // no part drawn yet
    const ff = parts();
    for (let x = 0.8; x < 1; x += FRAME) r.draw(bundleAt(x, ff));
    r.draw(bundleAt(1, ff));
    env.gi.button(6, true);
    env.gi.button(13, true);
    r.draw(bundleAt(1 + FRAME, ff));
    const st = api.getInstanceState(cv);
    assert.equal(st.notesHit, 1);
    assert.ok(st.score > 0);
    assert.equal(st.partId, 'lead');
    assert.equal(st.instrument, 'guitar');
    assert.equal(st.sourceKind, 'chart');
    assert.equal(st.controllerKey, 'Xbox#1');
    assert.equal(st.connected, true);
    const want = E.create({ notes: ff.lead.notes, beats: [], starPower: [], solos: [] }, { instrument: 'guitar' }).starThresholds;
    assert.deepEqual(st.starThresholds, want);
    // Seek back: the score starts over, the thresholds stay the full chart's.
    r.draw(bundleAt(0.2, ff));
    const st2 = api.getInstanceState(cv);
    assert.equal(st2.notesHit, 0);
    assert.deepEqual(st2.starThresholds, want);
    env.gi.change('disconnect', 0);
    assert.equal(api.getInstanceState(cv).connected, false);
    assert.equal(api.getInstanceState(fakeElement('canvas')), null);
});

test('listControllers names, kinds and keys (two identical pads #1, #2; unknown non-standard kind null)', async (t) => {
    const env = setup(t, { pads: [
        { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', mapping: 'standard' },
        { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', mapping: 'standard' },
        { id: 'Guitar Hero Les Paul Wireless Guitar Controller', mapping: '' },
        { id: 'Mystery Pad', mapping: '' },
    ] });
    P.saveBinding('Guitar Hero Les Paul Wireless Guitar Controller#1', { kind: 'guitar', map: GUITAR_MAP });
    env.gi.claim(3, 'drums');
    const p = env.win.feedBackFiveFret.listControllers();
    assert.ok(p && typeof p.then === 'function');
    const list = await p;
    assert.deepEqual(list.map((c) => [c.index, c.name, c.kind, c.controllerKey, c.connected, c.claimedBy]), [
        [0, 'Xbox Wireless Controller', 'gamepad', 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)#1', true, null],
        [1, 'Xbox Wireless Controller 2', 'gamepad', 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)#2', true, null],
        [2, 'Guitar Hero Les Paul Wir', 'guitar', 'Guitar Hero Les Paul Wireless Guitar Controller#1', true, null],
        [3, 'Mystery Pad', null, 'Mystery Pad#1', true, 'drums'],
    ]);
    assert.equal(list[0].mapping, 'standard');
    assert.equal(list[0].id, env.gi.pads[0].id);
    // No gamepad-input domain: an empty list.
    delete env.win.feedBack.gamepadInput;
    assert.deepEqual(await env.win.feedBackFiveFret.listControllers(), []);
});

test('createMapper maps a standard pad\'s Start to pause', async (t) => {
    const env = setup(t);
    const api = env.win.feedBackFiveFret;
    const p = api.createMapper('Xbox#1');
    assert.ok(p && typeof p.then === 'function');
    const m = await p;
    assert.deepEqual(m.map({ type: 'button', index: 9, value: 1, pressed: true }), [{ action: 'pause', value: 1 }]);
    assert.deepEqual(m.map({ type: 'button', index: 9, value: 0, pressed: false }), [{ action: 'pause', value: 0 }]);
    assert.equal(await api.createMapper('Nope#1'), null);
    assert.equal(await api.createMapper(''), null);
});

test('showAutoCharts reads the saved flag, default false', async (t) => {
    const env = setup(t);
    const api = env.win.feedBackFiveFret;
    assert.equal(api.showAutoCharts(), false);
    env.storage.setItem(P.SETTINGS_KEY, JSON.stringify({ showAutoCharts: true }));
    assert.equal(api.showAutoCharts(), true);
    env.storage.setItem(P.SETTINGS_KEY, '{oops');
    assert.equal(api.showAutoCharts(), false);
});

test('openControls returns to returnTo on Back', async (t) => {
    const env = setup(t);
    const api = env.win.feedBackFiveFret;
    api.openControls({ returnTo: 'plugin-rockherosmith' });
    assert.deepEqual(env.shown, ['plugin-five_fret']);
    await openControls(env);
    env.dom['five-fret-controls-back'].fire('click');
    assert.equal(env.shown[env.shown.length - 1], 'plugin-rockherosmith');
    await leaveControls(env);
    // Only for that visit: the next one (from Settings) goes home.
    await openControls(env);
    env.dom['five-fret-controls-back'].fire('click');
    assert.equal(env.shown[env.shown.length - 1], 'home');
    await leaveControls(env);
    api.openControls();
    await openControls(env);
    env.dom['five-fret-controls-back'].fire('click');
    assert.equal(env.shown[env.shown.length - 1], 'home');
});

// ── Controls screen ───────────────────────────────────────────────────────────────

function openControls(env) { env.bus.emit('screen:changed', { id: 'plugin-five_fret', from: 'player' }); return tick(); }
function leaveControls(env) { env.bus.emit('screen:changed', { id: 'home', from: 'plugin-five_fret' }); return tick(); }

test('controls screen claims while open; the renderer yields and takes the controller back on leave', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
    r.draw(bundleAt(0, ff));
    assert.equal(env.gi.owner(0), 'five_fret');
    await openControls(env);
    assert.equal(env.gi.owner(0), 'five_fret.controls');
    assert.ok(find(env.list, 'setup-guitar'), 'a card with setup buttons');
    assert.match(find(env.list, 'status').textContent, /gamepad/i);
    // While the screen holds it, the renderer does not try to claim it back.
    env.gi.change('connect', 0);
    r.draw(bundleAt(0, ff));
    assert.equal(env.gi.owner(0), 'five_fret.controls');
    // Live lights: the pressed button's chip and its action light up.
    env.gi.button(6, true);
    assert.equal(find(env.list, 'raw-button-6').dataset.on, '1');
    assert.equal(find(env.list, 'action-green').dataset.on, '1');
    env.gi.button(6, false);
    assert.equal(find(env.list, 'action-green').dataset.on, '0');
    // An axis light's rest is its first value (no browser pad state here): resting at -1 is off.
    env.gi.axis(3, -1);
    assert.equal(find(env.list, 'raw-axis-3').dataset.on, '0');
    env.gi.axis(3, 0);
    assert.equal(find(env.list, 'raw-axis-3').dataset.on, '1');
    await leaveControls(env);
    assert.equal(env.gi.owner(0), 'five_fret');
    assert.equal(env.list.children.length, 0);
    assert.equal(env.gi.changeFns.length, 1);   // only the renderer's subscription is left
    r.draw(bundleAt(FRAME, ff));
    assert.equal(env.last().message, null);
    // Opening again works; a second open while open is a no-op.
    await openControls(env);
    await openControls(env);
    assert.equal(env.gi.owner(0), 'five_fret.controls');
    assert.equal(findAll(env.list, 'setup-guitar').length, 1);
    // Back goes home.
    env.dom['five-fret-controls-back'].fire('click');
    assert.deepEqual(env.shown, ['home']);
});

test('controls screen with no controller, and a controller held by another plugin', async (t) => {
    const env = setup(t, { pad: false });
    await openControls(env);
    assert.match(env.list.children[0].textContent, /No controllers/);
    await leaveControls(env);

    const env2 = setup(t);
    env2.gi.claim(0, 'drums');
    await openControls(env2);
    assert.equal(env2.gi.owner(0), 'drums');
    assert.match(find(env2.list, 'status').textContent, /In use by drums/);
    assert.equal(find(env2.list, 'setup-guitar'), null);
});

test('set up as guitar walks the actions, saves the binding, and the renderer plays with it', async (t) => {
    const env = setup(t, { pads: [{ id: 'Guitar', mapping: '' }] });
    const ff = parts();
    const r = await started(env);
    r.draw(bundleAt(0, ff));
    assert.equal(env.gi.claims, 0);
    await openControls(env);
    assert.match(find(env.list, 'status').textContent, /Not set up/);
    assert.equal(find(env.list, 'rebind').disabled, true);
    assert.equal(find(env.list, 'calibrate').disabled, true);   // no binding to read strums through
    find(env.list, 'calibrate').fire('click');
    assert.equal(env.audio.contexts.length, 0);
    find(env.list, 'setup-guitar').fire('click');
    const prompt = find(env.list, 'prompt');
    const promptText = find(env.list, 'prompt-text');
    assert.equal(prompt.hidden, false);
    assert.match(promptText.textContent, /Green/);
    for (let b = 0; b < 5; b++) { env.gi.button(b, true); env.gi.button(b, false); }
    env.gi.button(0, true);   // green again: already used, ignored
    env.gi.button(0, false);
    assert.match(promptText.textContent, /Strum down/);
    env.gi.axis(1, 0);        // the axis's rest
    env.gi.axis(1, 1);
    env.gi.axis(1, 0);
    env.gi.axis(1, -1);
    env.gi.axis(1, 0);
    assert.match(promptText.textContent, /whammy/i);
    find(env.list, 'skip').fire('click');   // no whammy on this one
    env.gi.button(5, true);
    env.gi.button(6, true);
    const saved = P.loadBindings()['Guitar#1'];
    assert.equal(saved.kind, 'guitar');
    const want = Object.assign({}, GUITAR_MAP);
    delete want.whammy;
    assert.deepEqual(saved.map, want);
    assert.equal(prompt.hidden, true);
    assert.match(find(env.list, 'status').textContent, /guitar/i);
    assert.equal(find(env.list, 'rebind').disabled, false);
    assert.equal(find(env.list, 'calibrate').disabled, false);
    await leaveControls(env);
    // The renderer claims it with the saved binding.
    assert.equal(env.gi.owner(0), 'five_fret');
    r.draw(bundleAt(0, ff));
    assert.equal(env.last().header, 'Lead · GUITAR · Expert');
});

test('setup can be cancelled, and leaving mid-setup saves nothing', async (t) => {
    const env = setup(t, { pads: [{ id: 'Guitar', mapping: '' }] });
    await openControls(env);
    find(env.list, 'setup-gamepad').fire('click');
    env.gi.button(3, true);
    find(env.list, 'cancel').fire('click');
    assert.equal(find(env.list, 'prompt').hidden, true);
    env.gi.button(4, true);
    find(env.list, 'setup-guitar').fire('click');
    env.gi.button(0, true);
    await leaveControls(env);
    assert.deepEqual(P.loadBindings(), {});
});

test('rebind one action keeps the rest and ignores controls other actions use', async (t) => {
    const env = setup(t);
    let emitted = 0;
    env.bus.on('five_fret:bindings-changed', () => { emitted++; });
    await openControls(env);
    find(env.list, 'rebind-action').value = 'green';
    find(env.list, 'rebind').fire('click');
    assert.match(find(env.list, 'prompt-text').textContent, /Green/);
    env.gi.button(4, true);    // red's button: ignored
    env.gi.button(1, true);
    const saved = P.loadBindings()['Xbox#1'];
    assert.equal(saved.kind, 'gamepad');
    assert.deepEqual(saved.map.green, { type: 'button', index: 1 });
    assert.deepEqual(saved.map.red, { type: 'button', index: 4 });
    assert.deepEqual(saved.map.whammy, { type: 'axis', index: 2 });
    assert.equal(emitted, 1);
    // The card's lights follow the new binding.
    env.gi.button(1, false);
    env.gi.button(1, true);
    assert.equal(find(env.list, 'action-green').dataset.on, '1');
});

test('input offset: step 5, clamped to ±200, saved per controller, picked up by the renderer', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
    await openControls(env);
    const input = find(env.list, 'offset');
    assert.equal(input.min, '-200');
    assert.equal(input.max, '200');
    assert.equal(input.step, '5');
    assert.equal(input.value, '0');
    input.value = '23';
    input.fire('change');
    assert.equal(input.value, '25');
    assert.equal(P.loadSettings().offsetMs['Xbox#1'], 25);
    input.value = '-999';
    input.fire('change');
    assert.equal(input.value, '-200');
    input.value = 'abc';
    input.fire('change');
    assert.equal(input.value, '-200');
    input.value = '200';
    input.fire('change');
    assert.equal(P.loadSettings().offsetMs['Xbox#1'], 200);
    await leaveControls(env);
    // A strum 200 ms after the note is on time with the new offset.
    for (let x = 0.8; x < 1.2; x += FRAME) r.draw(bundleAt(x, ff));
    r.draw(bundleAt(1.2, ff));
    env.gi.button(6, true);
    env.gi.button(13, true);
    r.draw(bundleAt(1.2 + FRAME, ff));
    assert.equal(env.last().hits, 1);
});

test('calibrate plays clicks only after a click, with a visible note, and sets the median offset', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const env = setup(t);
    await openControls(env);
    // Opening the screen makes no sound.
    assert.equal(env.audio.contexts.length, 0);
    const note = find(env.list, 'calibrate-note');
    assert.match(note.textContent, /plays clicks/i);
    assert.equal(note.hidden, false);
    find(env.list, 'calibrate').fire('click');
    assert.equal(env.audio.contexts.length, 1);
    // The clicks are scheduled once the context has resumed, from its clock then.
    assert.equal(env.audio.clicks, 0);
    const ctx = env.audio.contexts[0];
    ctx.currentTime = 5;
    await tick();
    assert.equal(env.audio.clicks, 12);
    // Strum 30 ms after each heard click (context time 5 + 1.0 + 0.6 i, heard at perfZero + that).
    for (let i = 0; i < 12; i++) {
        const at = ctx.perfZero + 5 + 1.0 + 0.6 * i + (i === 5 ? 0.4 : 0.03);   // one stray strum
        env.gi.emit({ type: 'button', index: 13, value: 1, pressed: true, t: at });
        env.gi.emit({ type: 'button', index: 13, value: 0, pressed: false, t: at + 0.05 });
    }
    t.mock.timers.tick(20000);
    assert.equal(ctx.closed, true);
    assert.equal(P.loadSettings().offsetMs['Xbox#1'], 30);
    assert.equal(find(env.list, 'offset').value, '30');
    assert.match(find(env.list, 'calib-status').textContent, /30 ms/);

    // Leaving mid-calibration stops the clicks and saves nothing.
    find(env.list, 'calibrate').fire('click');
    await tick();
    assert.equal(env.audio.contexts.length, 2);
    await leaveControls(env);
    assert.equal(env.audio.contexts[1].closed, true);
    t.mock.timers.tick(20000);
    assert.equal(P.loadSettings().offsetMs['Xbox#1'], 30);
});

test('controllers coming and going do not cancel setup or calibration on the others', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const env = setup(t, { pads: [{ id: 'Guitar', mapping: '' }] });
    await openControls(env);
    const guitar = findAll(env.list, 'card')[0];
    find(guitar, 'setup-guitar').fire('click');
    env.gi.button(0, true);
    assert.match(find(guitar, 'prompt-text').textContent, /Red/);
    // A second controller arrives: it gets a card; the guitar keeps its claim, card and setup.
    env.gi.pads.push({ id: 'Xbox', mapping: 'standard' });
    env.gi.change('connect', 1);
    let cards = findAll(env.list, 'card');
    assert.equal(cards.length, 2);
    assert.equal(cards[0], guitar);
    assert.equal(env.gi.claims, 2);
    assert.equal(env.gi.releases, 0);
    assert.equal(env.gi.owner(1), 'five_fret.controls');
    assert.match(find(guitar, 'prompt-text').textContent, /Red/);
    // Calibrate the pad while the guitar setup goes on.
    const pad = cards[1];
    find(pad, 'calibrate').fire('click');
    await tick();
    const ctx = env.audio.contexts[0];
    // Another plugin claiming and releasing something else changes nothing here.
    env.gi.change('claim', 7);
    env.gi.change('release', 7);
    assert.equal(ctx.closed, false);
    for (let b = 1; b < 5; b++) env.gi.button(b, true);
    for (let k = 0; k < 5; k++) find(guitar, 'skip').fire('click');
    assert.deepEqual(Object.keys(P.loadBindings()['Guitar#1'].map), ['green', 'red', 'yellow', 'blue', 'orange']);
    // The pad leaves: its card goes, its claim is released and its clicks stop; the guitar stays.
    env.gi.pads.pop();
    env.gi.change('disconnect', 1);
    cards = findAll(env.list, 'card');
    assert.deepEqual(cards, [guitar]);
    assert.equal(ctx.closed, true);
    assert.equal(env.gi.owner(1), null);
    assert.equal(env.gi.owner(0), 'five_fret.controls');
    assert.equal(env.gi.releases, 1);
    // A controller another plugin held becomes free: its card is replaced by a claimed one.
    env.gi.pads.push({ id: 'Drumkit', mapping: '' });
    env.gi.claim(1, 'drums');
    assert.match(find(findAll(env.list, 'card')[1], 'status').textContent, /In use by drums/);
    env.gi.claim(1, 'drums').release();
    cards = findAll(env.list, 'card');
    assert.equal(cards.length, 2);
    assert.equal(env.gi.owner(1), 'five_fret.controls');
    assert.ok(find(cards[1], 'setup-guitar'));
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

// ── Band events on core's bus (five_fret:*) ──────────────────────────────────────────

// Every five_fret:<judgment / star power / band> emit, in order, as { name, detail }.
const BAND_EVENT = /^five_fret:(hit|miss|overstrum|sustain-end|sp-phrase|sp-ready|sp-activate|sp-end|band-pause|band-back-hold)$/;
function recordBandEvents(env) {
    const seen = [];
    const emit = env.bus.emit;
    env.bus.emit = (name, detail) => {
        if (BAND_EVENT.test(name)) seen.push({ name, detail });
        return emit(name, detail);
    };
    return seen;
}
const named = (seen, name) => seen.filter((e) => e.name === name);
// Draw from `from` to `to` (inclusive), a frame at a time.
function drawTo(r, ff, from, to, extra) {
    for (let x = from; x < to; x += FRAME) r.draw(bundleAt(x, ff, extra));
    r.draw(bundleAt(to, ff, extra));
}
async function pinnedLane(env, extra) {
    const cv = fakeElement('canvas');
    env.win.feedBackFiveFret.setLane(cv, lane(Object.assign({ difficulty: 'expert', lefty: false }, extra)));
    return { cv, r: await startedOn(env, cv) };
}

test('a hit emits five_fret:hit with canvas, controllerKey, points, score, combo, multiplier, spActive', async (t) => {
    const env = setup(t);
    const seen = recordBandEvents(env);
    const { cv, r } = await pinnedLane(env);
    const ff = parts();
    drawTo(r, ff, 0.8, 1);
    env.gi.button(6, true);    // green (gamepad mode: the press hits)
    r.draw(bundleAt(1 + FRAME, ff));
    const hits = named(seen, 'five_fret:hit');
    assert.equal(hits.length, 1);
    const d = hits[0].detail;
    assert.equal(d.canvas, cv);
    assert.equal(d.controllerKey, 'Xbox#1');
    assert.equal(d.partId, 'lead');
    assert.equal(d.instrument, 'guitar');
    assert.equal(d.points, 50);
    assert.equal(d.type, 'hit');
    assert.equal(d.noteType, 'strum');
    const st = env.win.feedBackFiveFret.getInstanceState(cv);
    assert.equal(d.score, st.score);
    assert.equal(d.combo, 1);
    assert.equal(d.multiplier, 1);
    assert.equal(d.spActive, false);
    assert.equal(typeof d.resets, 'number');
    // An unpinned renderer emits too, with its claimed controller's key.
    const env2 = setup(t);
    const seen2 = recordBandEvents(env2);
    const cv2 = fakeElement('canvas');
    const r2 = await startedOn(env2, cv2);
    drawTo(r2, ff, 0.8, 1);
    env2.gi.button(6, true);
    env2.gi.button(13, true);
    r2.draw(bundleAt(1 + FRAME, ff));
    const h2 = named(seen2, 'five_fret:hit');
    assert.equal(h2.length, 1);
    assert.equal(h2[0].detail.canvas, cv2);
    assert.equal(h2[0].detail.controllerKey, 'Xbox#1');
});

test('a missed note emits five_fret:miss; an overstrum emits five_fret:overstrum', async (t) => {
    const env = setup(t);
    const seen = recordBandEvents(env);
    const r = await started(env);   // unpinned, standard pad: gamepad mode on by kind, unless set off
    r.applySetting('gamepadMode', false);
    const ff = parts();
    drawTo(r, ff, 0, 1.5);
    env.gi.button(13, true);   // strum with no note near
    env.gi.button(13, false);
    drawTo(r, ff, 1.5 + FRAME, 2.5);
    const over = named(seen, 'five_fret:overstrum');
    assert.equal(over.length, 1);
    const misses = named(seen, 'five_fret:miss');
    assert.equal(misses.length, 2);   // the notes at 1 and 2
    assert.equal(misses[0].detail.combo, 0);
    assert.equal(misses[0].detail.partId, 'lead');
});

test('star power activation emits five_fret:sp-activate', async (t) => {
    const env = setup(t);
    const seen = recordBandEvents(env);
    const { cv, r } = await pinnedLane(env);
    // Two one-note phrases fill half the bar.
    const ff = { lead: { partId: 'lead', name: 'Lead', instrument: 'guitar', sourceKind: 'chart',
        notes: [{ t: 1, f: G }, { t: 2, f: G }, { t: 3, f: G }], levels: {},
        starPower: [{ start_time: 0.9, end_time: 1.1 }, { start_time: 1.9, end_time: 2.1 }], solos: [] } };
    drawTo(r, ff, 0.5, 1);
    env.gi.button(6, true);
    r.draw(bundleAt(1 + FRAME, ff));
    env.gi.button(6, false);
    drawTo(r, ff, 1 + 2 * FRAME, 2);
    env.gi.button(6, true);
    r.draw(bundleAt(2 + FRAME, ff));
    env.gi.button(6, false);
    assert.equal(named(seen, 'five_fret:sp-phrase').length, 2);
    assert.equal(named(seen, 'five_fret:sp-ready').length, 1);
    env.gi.button(3, true);   // star power (Y)
    r.draw(bundleAt(2 + 2 * FRAME, ff));
    const act = named(seen, 'five_fret:sp-activate');
    assert.equal(act.length, 1);
    assert.equal(act[0].detail.canvas, cv);
    assert.equal(act[0].detail.spActive, true);
    assert.equal(act[0].detail.multiplier, 2);
});

test('no events: nothing emitted, no state read', async (t) => {
    const env = setup(t);
    // Count session.state() reads: the HUD's frame.state is the only one per draw, events or not.
    let reads = 0;
    const createSession = S.createSession;
    env.win.FiveFretSession = Object.assign({}, S, {
        createSession(o) {
            const s = createSession(o);
            const state = s.state;
            s.state = () => { reads++; return state(); };
            return s;
        },
    });
    const seen = recordBandEvents(env);
    const { r } = await pinnedLane(env);
    const ff = parts();
    r.draw(bundleAt(0, ff));
    reads = 0;
    const n0 = env.renders.length;
    drawTo(r, ff, FRAME, 0.5);   // nothing to judge
    assert.equal(seen.length, 0);
    assert.ok(env.renders.length - n0 > 20);
    assert.equal(reads, env.renders.length - n0);
    // A draw with events still reads state once.
    drawTo(r, ff, 0.5 + FRAME, 1);
    env.gi.button(6, true);
    reads = 0;
    r.draw(bundleAt(1 + FRAME, ff));
    assert.equal(named(seen, 'five_fret:hit').length, 1);
    assert.equal(reads, 1);
    // A bus that cannot emit: draws go on, nothing to emit to.
    const env2 = setup(t);
    delete env2.win.feedBack.emit;
    const { cv: cv2, r: r2 } = await pinnedLane(env2);
    drawTo(r2, ff, 0.8, 1);
    env2.gi.button(6, true);
    assert.doesNotThrow(() => r2.draw(bundleAt(1 + FRAME, ff)));
    assert.equal(env2.win.feedBackFiveFret.getInstanceState(cv2).notesHit, 1);
});

test('a throwing listener doesn\'t stop drawing', async (t) => {
    const env = setup(t);
    const seen = recordBandEvents(env);
    env.bus.on('five_fret:hit', () => { throw new Error('listener'); });
    const { r } = await pinnedLane(env);
    const ff = parts();
    drawTo(r, ff, 0.8, 1);
    env.gi.button(6, true);
    const n = env.renders.length;
    assert.doesNotThrow(() => r.draw(bundleAt(1 + FRAME, ff)));
    assert.equal(env.renders.length, n + 1);   // the frame was still drawn
    env.gi.button(6, false);
    drawTo(r, ff, 1 + 2 * FRAME, 2.5);         // the note at 2 (red) is missed: later events still go
    assert.equal(named(seen, 'five_fret:hit').length, 1);
    assert.equal(named(seen, 'five_fret:miss').length, 1);
});

test('events carry resets: a seek and a session rebuild each raise it', async (t) => {
    const env = setup(t);
    const seen = recordBandEvents(env);
    const { cv, r } = await pinnedLane(env);
    const ff = parts();
    const hitAt1 = () => {
        drawTo(r, ff, 0.8, 1);
        env.gi.button(6, true);
        r.draw(bundleAt(1 + FRAME, ff));
        env.gi.button(6, false);
        const h = named(seen, 'five_fret:hit');
        return h[h.length - 1].detail.resets;
    };
    const a = hitAt1();
    drawTo(r, ff, 1 + 2 * FRAME, 1.2);
    const b = hitAt1();             // drawing 0.8 after 1.2 is a seek back
    assert.ok(b > a);
    env.win.feedBackFiveFret.setDifficulty('easy', cv);   // a rebuilt session (score 0 again)
    drawTo(r, ff, 1 + 2 * FRAME, 1.2);
    const c = hitAt1();
    assert.ok(c > b);
});

// ── Band pause and leave (Ruling 7) ───────────────────────────────────────────────────

test('a pinned lane\'s Start emits five_fret:band-pause and does not toggle play', async (t) => {
    const env = setup(t);
    const seen = recordBandEvents(env);
    const { cv, r } = await pinnedLane(env);
    r.draw(bundleAt(0, parts()));
    env.gi.button(9, true);
    env.gi.button(9, false);
    assert.equal(env.win.togglePlays, 0);
    const p = named(seen, 'five_fret:band-pause');
    assert.equal(p.length, 1);   // the press, not the release
    assert.deepEqual(p[0].detail, { controllerKey: 'Xbox#1', canvas: cv });
    // Paused too (RockHeroSmith resumes on it).
    r.draw(bundleAt(0, parts(), { isPlaying: false }));
    env.gi.button(9, true);
    assert.equal(named(seen, 'five_fret:band-pause').length, 2);
    assert.equal(env.win.togglePlays, 0);
});

test('holding Back 1 s on a pinned lane emits band-back-hold once; a shorter hold does not', async (t) => {
    const env = setup(t);
    const seen = recordBandEvents(env);
    const { cv, r } = await pinnedLane(env);
    const ff = parts();
    const back = (down, ago) => env.gi.emit({ type: 'button', index: 8, value: down ? 1 : 0, pressed: down,
        t: performance.now() / 1000 - (ago || 0) });
    r.draw(bundleAt(0, ff));
    // Held for 0.5 s, then let go: nothing.
    back(true, 0.5);
    r.draw(bundleAt(FRAME, ff));
    back(false);
    r.draw(bundleAt(2 * FRAME, ff));
    assert.equal(named(seen, 'five_fret:band-back-hold').length, 0);
    // Held for 1 s (paused here): one event, however long it stays down.
    back(true, 1.05);
    r.draw(bundleAt(2 * FRAME, ff, { isPlaying: false }));
    r.draw(bundleAt(2 * FRAME, ff, { isPlaying: false }));
    const held = named(seen, 'five_fret:band-back-hold');
    assert.equal(held.length, 1);
    assert.deepEqual(held[0].detail, { controllerKey: 'Xbox#1', canvas: cv });
    back(false);
    r.draw(bundleAt(2 * FRAME, ff));
    assert.equal(named(seen, 'five_fret:band-back-hold').length, 1);
    // A new hold fires again.
    back(true, 1.05);
    r.draw(bundleAt(3 * FRAME, ff));
    assert.equal(named(seen, 'five_fret:band-back-hold').length, 2);
    back(false);
    // An unpinned renderer: Back does nothing.
    const env2 = setup(t);
    const seen2 = recordBandEvents(env2);
    const r2 = await started(env2);
    r2.draw(bundleAt(0, ff));
    env2.gi.emit({ type: 'button', index: 8, value: 1, pressed: true, t: performance.now() / 1000 - 1.05 });
    r2.draw(bundleAt(FRAME, ff));
    assert.equal(seen2.length, 0);
    // A binding that uses button 8 for an action (star power on a guitar's Select): no back-hold.
    const env3 = setup(t, { pads: [{ id: 'Guitar', mapping: '' }] });
    P.saveBinding('Guitar#1', { kind: 'guitar', map: Object.assign({}, GUITAR_MAP, { star_power: { type: 'button', index: 8 } }) });
    const seen3 = recordBandEvents(env3);
    const { r: r3 } = await pinnedLane(env3, { controllerKey: 'Guitar#1' });
    r3.draw(bundleAt(0, ff));
    env3.gi.emit({ type: 'button', index: 8, value: 1, pressed: true, t: performance.now() / 1000 - 1.05 });
    r3.draw(bundleAt(FRAME, ff));
    assert.equal(named(seen3, 'five_fret:band-back-hold').length, 0);
});

test('an unpinned renderer\'s Start still toggles play', async (t) => {
    const env = setup(t);
    const seen = recordBandEvents(env);
    const r = await started(env);
    r.draw(bundleAt(0, parts()));
    env.gi.button(9, true);
    env.gi.button(9, false);
    assert.equal(env.win.togglePlays, 1);
    assert.equal(named(seen, 'five_fret:band-pause').length, 0);
    // A cleared lane is unpinned again.
    const env2 = setup(t);
    const { cv, r: r2 } = await pinnedLane(env2);
    env2.win.feedBackFiveFret.clearLane(cv);
    r2.draw(bundleAt(0, parts()));
    env2.gi.button(9, true);
    assert.equal(env2.win.togglePlays, 1);
});

test('an auto part draws and plays star power phrases from the song\'s sections', async (t) => {
    // Auto parts are hidden unless showAutoCharts is on (Plan 5's gate).
    const storage = memoryStorage();
    storage.setItem('five_fret.settings.v1', JSON.stringify({ showAutoCharts: true }));
    const env = setup(t, { storage });
    const r = await started(env);
    const notes = [];
    for (let x = 0; x < 16; x += 0.5) notes.push({ t: x, f: G });
    const auto = { gen: { partId: 'gen', name: 'Lead', instrument: 'guitar', sourceKind: 'auto', notes, levels: {}, starPower: [], solos: [] } };
    // No sections yet: no phrases. Sections arrive: the session is rebuilt with one (no beats: 2 s measures).
    r.draw(bundleAt(0, auto, { sections: [] }));
    assert.deepEqual(env.last().starPower, []);
    r.draw(bundleAt(FRAME, auto, { sections: [{ time: 0, name: 'Intro' }] }));
    assert.deepEqual(env.last().starPower, [{ start_time: 12, end_time: 16 }]);
    // A chart part keeps its own (none here), whatever the sections.
    r.draw(bundleAt(2 * FRAME, parts(), { sections: [{ time: 0, name: 'Intro' }] }));
    assert.deepEqual(env.last().starPower, []);
});
