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

// ── Controls screen ───────────────────────────────────────────────────────────────

function openControls(env) { env.bus.emit('screen:changed', { id: 'plugin-five_fret', from: 'player' }); return tick(); }
function leaveControls(env) { env.bus.emit('screen:changed', { id: 'home', from: 'plugin-five_fret' }); return tick(); }

test('controls screen claims while open; the renderer yields and takes the controller back on leave', async (t) => {
    const env = setup(t);
    const ff = parts();
    const r = await started(env);
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
