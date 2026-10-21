/*
 * session.js: the scoring session the five-fret renderer drives, and the renderer's pure helpers.
 * Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
 *
 * Modelled on feedBack-plugin-drums/assets/session.js createSession. Wraps one engine.js engine for
 * one part at one difficulty:
 *   createSession({ chart, instrument, difficulty, gamepadMode, offsetMs, pressed?, now? }) ->
 *     { input(action, value, tSong), update(tSong), releaseAll(tSong), pressedFrets(), whammy(), state(), noteState(i),
 *       drainEvents(), notes, difficulty, offsetMs, resets, starThresholds }
 *   drainEvents(): engine events as { type: event name, ...payload } (a payload's note type is noteType).
 *   chart: a bundle.fiveFretParts entry plus `beats` ({ notes, levels, starPower, solos, beats }).
 *   tSong: highway chart time (bundle.currentTime). The input offset is applied here, to inputs and to
 *   the engine clock alike, so an offset input is never clamped forward to a clock that ran ahead.
 *   pressed: bool[5] frets already held (a rebuild mid-song), applied to the engine on the first update.
 *   now(): wall clock in seconds (default performance.now() / 1000), for jump detection.
 *
 * Seeking / looping (Review Focus 4): update() compares the song advance since the last update with
 * the wall time since then. More than 0.25 s behind it, or more than 0.25 s beyond it, is a jump and
 * resets the engine at the new time (engine.reset: notes already past are set aside, not missed). A
 * paused song (no advance while the wall clock runs) is not a jump.
 *
 * Exported on window.FiveFretSession (browser) and module.exports (Node tests). Needs engine.js
 * (window.FiveFretEngine, or require('./engine.js') in Node), loaded first.
 */
(function (root, factory) {
    'use strict';
    const E = (typeof module === 'object' && module && module.exports)
        ? require('./engine.js')
        : (typeof window !== 'undefined' ? window.FiveFretEngine : root && root.FiveFretEngine);
    const api = factory(E);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (typeof window !== 'undefined' && window) window.FiveFretSession = api;
    else if (typeof module !== 'object' && root) root.FiveFretSession = api;
})(typeof self !== 'undefined' ? self : this, function (E) {
    'use strict';
    if (!E) throw new Error('session.js needs engine.js (window.FiveFretEngine)');

    const SEEK = 0.25;            // a jump of more than this (s) against the expected advance resets
    const MAX_AHEAD = 0.06;       // an input is extrapolated at most this far (s) past the last frame
    const NO_EVENTS = Object.freeze([]);
    const MAX_EVENTS = 256;
    const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard', 'expert']);
    const PART_SETTINGS = Object.freeze(['auto', 'guitar', 'rhythm', 'bass']);
    const FRETS = Object.freeze({ green: 0, red: 1, yellow: 2, blue: 3, orange: 4 });
    const FRET_NAMES = Object.freeze(Object.keys(FRETS));

    const MSG_NO_PARTS = 'No 5-fret chart for this song';
    const MSG_NO_CONTROLLER = 'Connect a controller and press any button';
    const MSG_DISCONNECTED = 'Controller disconnected';

    function defaultNow() {
        return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
            ? performance.now() / 1000 : Date.now() / 1000;
    }

    // ── Pure helpers ──────────────────────────────────────────────────────────

    /** True when the song moved more than SEEK off the expected advance (0..wallElapsed). */
    function isJump(prevTime, time, wallElapsed) {
        if (!Number.isFinite(prevTime) || !Number.isFinite(time)) return false;
        const expected = Number.isFinite(wallElapsed) && wallElapsed > 0 ? wallElapsed : 0;
        const delta = time - prevTime;
        return delta < -SEEK || delta > expected + SEEK;
    }

    /**
     * The part to play from bundle.fiveFretParts ({ [partId]: part }, manifest order) by the `part`
     * setting: 'guitar' | 'rhythm' | 'bass' takes the first part of that instrument; 'auto' (and an
     * instrument the song lacks) takes bass when the arrangement name contains "bass", else guitar,
     * else the first part. null when there are no parts.
     * opts (optional) = { exact?, showAuto? }: exact makes an instrument setting the song lacks give
     * null instead of falling back (a band lane pinned to Rhythm never plays Lead). showAuto is
     * accepted for Plan 5's auto-chart gate and does not change the pick yet. No opts: as before.
     */
    function pickPart(parts, arrangementName, setting, opts) {
        if (!parts || typeof parts !== 'object') return null;
        const ids = Object.keys(parts).filter((id) => parts[id] && typeof parts[id] === 'object');
        if (!ids.length) return null;
        const byInstrument = (inst) => ids.find((id) => parts[id].instrument === inst) || null;
        if (setting === 'guitar' || setting === 'rhythm' || setting === 'bass') {
            const id = byInstrument(setting);
            if (id || (opts && opts.exact === true)) return id;
        }
        if (/bass/i.test(typeof arrangementName === 'string' ? arrangementName : '')) {
            const id = byInstrument('bass');
            if (id) return id;
        }
        return byInstrument('guitar') || ids[0];
    }

    /**
     * Chart time of a controller event: the chart time of the last drawn frame plus the wall time
     * since that frame (evT and lastFrameT in seconds, performance.now() / 1000), minus offsetMs.
     * As the drums plugin's estimateTime, the wall time is clamped to 0..60 ms (a stalled or hidden
     * highway must not push inputs far ahead of the clock), and not added at all when `playing` is
     * false (paused: the chart clock stands still). NaN when there is no frame yet or no event time.
     */
    function inputChartTime(lastChartTime, lastFrameT, evT, offsetMs, playing) {
        if (!Number.isFinite(lastChartTime) || !Number.isFinite(lastFrameT) || !Number.isFinite(evT)) return NaN;
        const off = Number.isFinite(offsetMs) ? offsetMs : 0;
        const ahead = playing === false ? 0 : Math.min(MAX_AHEAD, Math.max(0, evT - lastFrameT));
        return lastChartTime + ahead - off / 1000;
    }

    /** The HUD status line, or null when there is nothing to say. */
    function statusMessage(o) {
        o = o || {};
        if (!o.hasParts) return MSG_NO_PARTS;
        if (!o.hasController) return MSG_NO_CONTROLLER;
        if (!o.connected) return MSG_DISCONNECTED;
        return null;
    }

    // The difficulty's notes: levels[difficulty].notes, or the top-level (expert) notes.
    function chartNotes(chart, difficulty) {
        const lv = difficulty !== 'expert' && chart.levels && typeof chart.levels === 'object'
            ? chart.levels[difficulty] : null;
        if (lv && Array.isArray(lv.notes)) return { notes: lv.notes, difficulty };
        return { notes: Array.isArray(chart.notes) ? chart.notes : [], difficulty: 'expert' };
    }

    // Wire notes with a finite time, sorted by t (stable), so engine indices match the view's.
    function sortedNotes(notes) {
        const list = [];
        for (let i = 0; i < notes.length; i++) {
            const n = notes[i];
            if (n && Number.isFinite(+n.t)) list.push({ n, i });
        }
        list.sort((a, b) => (+a.n.t - +b.n.t) || (a.i - b.i));
        return list.map((x) => x.n);
    }

    // ── Session ───────────────────────────────────────────────────────────────

    function createSession(opts) {
        opts = opts || {};
        const chart = opts.chart && typeof opts.chart === 'object' ? opts.chart : {};
        const now = typeof opts.now === 'function' ? opts.now : defaultNow;
        const picked = chartNotes(chart, DIFFICULTIES.indexOf(opts.difficulty) >= 0 ? opts.difficulty : 'expert');
        const notes = sortedNotes(picked.notes);
        const offsetMs = Number.isFinite(opts.offsetMs) ? opts.offsetMs : 0;
        const offset = offsetMs / 1000;
        const engine = E.create({
            notes,
            beats: Array.isArray(chart.beats) ? chart.beats : [],
            starPower: Array.isArray(chart.starPower) ? chart.starPower : [],
            solos: Array.isArray(chart.solos) ? chart.solos : [],
        }, { instrument: opts.instrument === 'bass' ? 'bass' : 'guitar', gamepadMode: !!opts.gamepadMode });
        // The full chart's star thresholds (engine.reset on a seek leaves them as they are).
        const starThresholds = Object.freeze(Array.isArray(engine.starThresholds) ? engine.starThresholds.slice() : []);

        // Held frets carried over from a previous session (a rebuild while the player holds frets).
        const pressed = [0, 1, 2, 3, 4].map((k) => !!(Array.isArray(opts.pressed) && opts.pressed[k]));
        const events = [];
        let whammy = 0;
        let lastTime = null;   // player time (offset applied) of the last update
        let lastWall = null;
        let resets = 0;

        for (const name of E.EVENTS) {
            engine.on(name, (p) => {
                // `type` names the event; a note's own type (strum/hopo/tap) moves to `noteType`.
                const ev = Object.assign({}, p);
                if (p && p.type !== undefined) ev.noteType = p.type;
                ev.type = name;
                events.push(ev);
                if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
            });
        }

        function reset(time) {
            engine.reset(time);
            resets++;
        }

        const api = {
            /** One named action at highway time tSong (value: 1/0 or boolean; 0..1 for whammy). */
            input(action, value, tSong) {
                const t = +tSong - offset;
                if (!Number.isFinite(t)) return;
                if (action === 'whammy') whammy = Math.min(1, Math.max(0, +value || 0));
                else if (Object.prototype.hasOwnProperty.call(FRETS, action)) pressed[FRETS[action]] = !!value;
                if (E.ACTIONS.indexOf(action) < 0) return;
                engine.input(t, action, action === 'whammy' ? whammy : !!value);
            },
            /** Advance to highway time tSong (each drawn frame). */
            update(tSong) {
                const t = +tSong - offset;
                if (!Number.isFinite(t)) return;
                const wall = now();
                if (lastTime === null) {
                    // Frets held when the session was built go into the engine first; reset() keeps
                    // the held buttons and undoes anything those inputs judged.
                    for (const name of FRET_NAMES) if (pressed[FRETS[name]]) engine.input(t, name, true);
                }
                // First update (possibly mid-song) or a seek / loop: start over here, no misses behind.
                if (lastTime === null || isJump(lastTime, t, wall - lastWall)) reset(t);
                else engine.update(t);
                lastTime = t;
                lastWall = wall;
            },
            /**
             * Let go of everything held (the controller unplugged): every held fret and star power is
             * released at highway time tSong, so nothing stays latched.
             */
            releaseAll(tSong) {
                for (const name of FRET_NAMES) if (pressed[FRETS[name]]) api.input(name, 0, tSong);
                api.input('star_power', 0, tSong);
            },
            /** Held frets as bool[5] (green..orange), from the inputs. Live array: do not mutate. */
            pressedFrets() { return pressed; },
            whammy() { return whammy; },
            state() { return engine.getState(); },
            noteState(i) { return engine.noteState(i); },
            /** Engine events since the last call ({ type, ...payload }), oldest first (a shared frozen [] when none). */
            drainEvents() {
                if (!events.length) return NO_EVENTS;
                const out = events.slice();
                events.length = 0;
                return out;
            },
            get notes() { return notes; },
            get difficulty() { return picked.difficulty; },
            get offsetMs() { return offsetMs; },
            get resets() { return resets; },
            /** Star score thresholds for the whole chart (frozen), the same after any seek. */
            get starThresholds() { return starThresholds; },
        };
        return api;
    }

    return {
        SEEK, DIFFICULTIES, PART_SETTINGS, MSG_NO_PARTS, MSG_NO_CONTROLLER, MSG_DISCONNECTED,
        isJump, pickPart, inputChartTime, statusMessage,
        createSession,
    };
});
