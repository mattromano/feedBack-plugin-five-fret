/*
 * profiles.js: controller profiles, input mapper and bindings/settings storage for the feedBack
 * five-fret plugin. Names raw gamepad-input events (button/axis) as engine actions.
 * Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
 *
 * Gamepad mode (D-pad strums only when it is off, fret-press hits when it is on) is the engine's
 * concern, not the mapper's: the mapper always emits every action it is bound to.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (typeof window !== 'undefined' && window) window.FiveFretProfiles = api;
    else if (typeof module !== 'object' && root) root.FiveFretProfiles = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Engine actions plus 'pause' (Start), which the engine ignores and the screen handles.
    const ACTIONS = Object.freeze(['green', 'red', 'yellow', 'blue', 'orange',
        'strum_up', 'strum_down', 'open', 'whammy', 'star_power', 'pause']);

    const PRESS_AT = 0.5;
    const RELEASE_AT = 0.3;

    const BINDINGS_KEY = 'five_fret.bindings.v1';
    const SETTINGS_KEY = 'five_fret.settings.v1';

    const b = (index) => Object.freeze({ type: 'button', index });
    const STANDARD_GAMEPAD = Object.freeze({
        kind: 'gamepad',
        map: Object.freeze({
            green: b(6), red: b(4), yellow: b(5), blue: b(7), orange: b(0),
            open: b(2), star_power: b(3), pause: b(9),
            whammy: Object.freeze({ type: 'axis', index: 2 }),
            strum_down: b(13), strum_up: b(12),
        }),
    });

    // Same format as core's gamepad-input claim key: `${id}#${n}`, n from 1 among identical ids.
    function controllerKey(info, nth) {
        if (!info || typeof info.id !== 'string' || !info.id) return null;
        const n = Number.isInteger(nth) && nth > 0 ? nth : 1;
        return `${info.id}#${n}`;
    }

    function isBinding(x) {
        return !!x && typeof x === 'object' && !!x.map && typeof x.map === 'object' && !Array.isArray(x.map);
    }

    function resolveBinding(info, stored) {
        if (isBinding(stored)) return stored;
        if (info && info.mapping === 'standard') return STANDARD_GAMEPAD;
        return null;
    }

    // Reading of one event for one binding, or null if the event is not the binding's input.
    // Buttons read 0..1 (value, else the pressed flag); axes read their own direction (sign) or
    // the absolute value when no sign is given.
    function reading(spec, ev) {
        if (!spec || spec.type !== ev.type || spec.index !== ev.index) return null;
        let v = Number(ev.value);
        if (!Number.isFinite(v)) v = ev.pressed ? 1 : 0;
        if (spec.type === 'axis') v = spec.sign ? v * (spec.sign < 0 ? -1 : 1) : Math.abs(v);
        return Math.min(1, Math.max(0, v));
    }

    function createMapper(profile) {
        const map = (profile && profile.map) || {};
        const down = Object.create(null);
        return {
            map(ev) {
                const out = [];
                if (!ev) return out;
                for (const action of Object.keys(map)) {
                    const v = reading(map[action], ev);
                    if (v === null) continue;
                    if (action === 'whammy') {
                        out.push({ action, value: v });
                        continue;
                    }
                    const was = !!down[action];
                    const now = was ? v > RELEASE_AT : v >= PRESS_AT;
                    if (now !== was) {
                        down[action] = now;
                        out.push({ action, value: now ? 1 : 0 });
                    }
                }
                return out;
            },
        };
    }

    // ── Storage (every access guarded: localStorage can be absent or throw) ──────
    function readJSON(key) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null || raw === undefined) return null;
            const v = JSON.parse(raw);
            return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
        } catch (_) { return null; }
    }
    function writeJSON(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
    }

    function loadBindings() { return readJSON(BINDINGS_KEY) || {}; }
    function saveBinding(key, binding) {
        const all = loadBindings();
        all[key] = binding;
        return writeJSON(BINDINGS_KEY, all);
    }

    // gamepadMode null = by controller kind (see effectiveGamepadMode); part 'auto' = pick from the song.
    function defaultSettings() {
        return { difficulty: 'expert', lefty: false, gamepadMode: null, offsetMs: {}, part: 'auto' };
    }
    function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
    // Coerce every field to its expected type, falling back to the default.
    function normaliseSettings(raw) {
        const d = defaultSettings();
        const r = isPlainObject(raw) ? raw : {};
        const offsetMs = {};
        if (isPlainObject(r.offsetMs)) {
            for (const k of Object.keys(r.offsetMs)) {
                if (typeof r.offsetMs[k] === 'number' && Number.isFinite(r.offsetMs[k])) offsetMs[k] = r.offsetMs[k];
            }
        }
        return {
            difficulty: typeof r.difficulty === 'string' && r.difficulty ? r.difficulty : d.difficulty,
            lefty: typeof r.lefty === 'boolean' ? r.lefty : d.lefty,
            gamepadMode: typeof r.gamepadMode === 'boolean' ? r.gamepadMode : d.gamepadMode,
            offsetMs,
            part: typeof r.part === 'string' && r.part ? r.part : d.part,
        };
    }
    function loadSettings() { return normaliseSettings(readJSON(SETTINGS_KEY)); }
    // Shallow-merges the patch, except offsetMs which merges per controller key. Returns what was stored.
    function saveSettings(patch) {
        const cur = loadSettings();
        const p = isPlainObject(patch) ? patch : {};
        const merged = Object.assign({}, cur, p);
        merged.offsetMs = Object.assign({}, cur.offsetMs, isPlainObject(p.offsetMs) ? p.offsetMs : {});
        const s = normaliseSettings(merged);
        writeJSON(SETTINGS_KEY, s);
        return s;
    }
    function setOffset(key, ms) {
        return saveSettings({ offsetMs: { [key]: ms } });
    }

    // Explicit setting wins; null/unset = on for gamepads, off for guitars (and unknown kinds).
    function effectiveGamepadMode(settings, binding) {
        if (settings && typeof settings.gamepadMode === 'boolean') return settings.gamepadMode;
        return !!binding && binding.kind === 'gamepad';
    }

    // ── Setup (the controls screen) ───────────────────────────────────────────

    // The actions "Set up as guitar" / "Set up as gamepad" ask for, in order.
    const SETUP_ACTIONS = Object.freeze({
        guitar: Object.freeze(['green', 'red', 'yellow', 'blue', 'orange',
            'strum_down', 'strum_up', 'whammy', 'star_power', 'pause']),
        gamepad: Object.freeze(['green', 'red', 'yellow', 'blue', 'orange', 'open',
            'strum_down', 'strum_up', 'whammy', 'star_power', 'pause']),
    });
    const SETUP_AXIS_MOVE = 0.5;   // an axis counts once it is this far from rest

    // A control's identity: a button, or one direction of an axis (an axis can strum both ways).
    function controlId(spec) {
        return spec.type === 'axis' ? `axis:${spec.index}:${spec.sign < 0 ? -1 : 1}` : `button:${spec.index}`;
    }

    // Walks `actions`, taking for each the first new button press or an axis moving more than 0.5
    // from rest (recorded with its sign), and ignoring a control already used (by this walk or
    // opts.used). opts.rest = { [axisIndex]: restValue }; an axis with no rest given takes the first
    // value it reports as its rest. Pure: feed(ev) -> { done, next, binding, recorded }, where
    // binding is { map } once done (else null) and recorded is { action, spec } when ev recorded one.
    function createSetupRecorder(actions, opts) {
        const list = Array.isArray(actions) ? actions.slice() : [];
        const o = opts || {};
        const used = new Set();
        if (Array.isArray(o.used)) for (const s of o.used) if (s && (s.type === 'button' || s.type === 'axis')) used.add(controlId(s));
        const rest = Object.create(null);
        if (o.rest && typeof o.rest === 'object') {
            for (const k of Object.keys(o.rest)) if (Number.isFinite(o.rest[k])) rest[k] = o.rest[k];
        }
        const down = new Set();   // buttons held now
        const map = {};
        let i = 0;

        const result = (recorded) => {
            const done = i >= list.length;
            return { done, next: done ? null : list[i], binding: done ? { map: Object.assign({}, map) } : null, recorded };
        };
        function take(spec) {
            const id = controlId(spec);
            if (used.has(id)) return result(null);
            used.add(id);
            map[list[i]] = spec;
            const recorded = { action: list[i], spec };
            i++;
            return result(recorded);
        }

        return {
            get next() { return i < list.length ? list[i] : null; },
            feed(ev) {
                if (!ev || !Number.isInteger(ev.index) || ev.index < 0) return result(null);
                if (ev.type === 'button') {
                    const v = Number(ev.value);
                    const pressed = typeof ev.pressed === 'boolean' ? ev.pressed : (Number.isFinite(v) && v >= PRESS_AT);
                    if (!pressed) { down.delete(ev.index); return result(null); }
                    if (down.has(ev.index)) return result(null);
                    down.add(ev.index);
                    if (i >= list.length) return result(null);
                    return take({ type: 'button', index: ev.index });
                }
                if (ev.type === 'axis') {
                    const v = Number(ev.value);
                    if (!Number.isFinite(v)) return result(null);
                    if (!(ev.index in rest)) { rest[ev.index] = v; return result(null); }
                    const d = v - rest[ev.index];
                    if (i >= list.length || Math.abs(d) <= SETUP_AXIS_MOVE) return result(null);
                    return take({ type: 'axis', index: ev.index, sign: d < 0 ? -1 : 1 });
                }
                return result(null);
            },
            // Leave the current action unbound and move on.
            skip() {
                if (i < list.length) i++;
                return result(null);
            },
        };
    }

    const CALIBRATION_MAX_PAIR = 0.150;   // seconds: a strum further than this from every click is ignored

    // Input offset (ms) from a calibration run: the median, over the strums, of (strum - nearest
    // click), ignoring pairs more than 150 ms apart. Times in seconds. Positive = the player is late
    // (the session subtracts it). null when no strum is near a click.
    function calibrationOffset(clickTimes, strumTimes) {
        const clicks = Array.isArray(clickTimes) ? clickTimes.filter(Number.isFinite) : [];
        const strums = Array.isArray(strumTimes) ? strumTimes.filter(Number.isFinite) : [];
        if (!clicks.length) return null;
        const diffs = [];
        for (const s of strums) {
            let best = Infinity;
            for (const c of clicks) if (Math.abs(s - c) < Math.abs(best)) best = s - c;
            if (Math.abs(best) <= CALIBRATION_MAX_PAIR + 1e-9) diffs.push(best * 1000);
        }
        if (!diffs.length) return null;
        diffs.sort((a, b) => a - b);
        const mid = diffs.length >> 1;
        return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
    }

    return {
        ACTIONS,
        SETUP_ACTIONS,
        STANDARD_GAMEPAD,
        BINDINGS_KEY,
        SETTINGS_KEY,
        controllerKey,
        resolveBinding,
        createMapper,
        loadBindings,
        saveBinding,
        loadSettings,
        saveSettings,
        setOffset,
        effectiveGamepadMode,
        createSetupRecorder,
        calibrationOffset,
    };
});
