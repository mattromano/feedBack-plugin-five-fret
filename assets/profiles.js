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
        const n = Number.isInteger(nth) && nth > 0 ? nth : 1;
        return `${info && info.id}#${n}`;
    }

    function isBinding(x) {
        return !!x && typeof x === 'object' && !!x.map && typeof x.map === 'object';
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

    function defaultSettings() {
        return { difficulty: 'expert', lefty: false, gamepadMode: false, offsetMs: {}, part: 'guitar' };
    }
    function loadSettings() {
        const stored = readJSON(SETTINGS_KEY) || {};
        const s = Object.assign(defaultSettings(), stored);
        if (!s.offsetMs || typeof s.offsetMs !== 'object' || Array.isArray(s.offsetMs)) s.offsetMs = {};
        return s;
    }
    function saveSettings(patch) {
        const s = Object.assign(loadSettings(), patch || {});
        writeJSON(SETTINGS_KEY, s);
        return s;
    }

    return {
        ACTIONS,
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
    };
});
