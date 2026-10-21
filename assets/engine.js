/*
 * engine.js: Clone Hero / Rock Band-style five-fret guitar hit detection and scoring for the feedBack
 * five-fret plugin.
 *
 * Ported from YARG.Core (https://github.com/YARC-Official/YARG.Core), branch master at commit
 * 9dafd346aff908b6d5b1db250eaf3a2588810c70 (2026-10-19):
 *   YARG.Core/Engine/Guitar/Engines/YargFiveFretGuitarEngine.cs
 *   YARG.Core/Engine/Guitar/GuitarEngine.cs
 *   YARG.Core/Engine/Guitar/GuitarEngineParameters.cs
 *   YARG.Core/Engine/Guitar/GuitarStats.cs
 *   YARG.Core/Engine/BaseEngine.cs, BaseEngine.Generic.cs (the parts the hit logic uses)
 *   YARG.Core/Engine/EngineTimer.cs
 *   YARG.Core/Engine/HitWindowSettings.cs
 *   YARG.Core/Input/InputActions.cs (GuitarAction)
 *   YARG.Core/Chart/Events/WaitCountdown.cs (MIN_SECONDS)
 *   YARG.Core/Game/Presets/EnginePreset.Instruments.cs (FiveFretGuitarPreset defaults)
 *
 * Copyright (c) YARC (YARG) contributors
 * Licensed under the GNU Lesser General Public License v3.0
 * (see https://github.com/YARC-Official/YARG.Core/blob/master/LICENSE, and LICENSE.LGPL-3.0 at the plugin
 * root; LGPL-3.0 builds on the GPL-3.0 in LICENSE.GPL-3.0).
 *
 * Ported and modified to JavaScript for the feedBack five-fret plugin. This file is a derivative work of
 * the above files and stays under LGPL-3.0. The rest of the plugin is MIT (see NOTICE.md).
 * Modifications: rewritten as a dependency-free JavaScript module with an immediate input()/update() API
 * in place of YARG's input queue, works in seconds in place of chart ticks, reads feedBack's 5-fret wire
 * notes, and adds a gamepad mode. The deviations are listed below.
 *
 * -------------------------------------------------------------------------------------------------
 * Rules ported from YARG (defaults = EnginePreset FiveFretGuitarPreset):
 *  - Hit window: 140 ms total, front/back ratio 1.0, so 70 ms early to 70 ms late, not dynamic. The
 *    "Dark YARG" dynamic window is ported (params.hitWindow.isDynamic). The window scales with
 *    params.songSpeed. A note is still hittable exactly at its back end and missed once time > t + back.
 *  - Strums (YargFiveFretGuitarEngine.UpdateHitLogic / CheckForNoteHit): a strum starts the strum
 *    leniency timer (50 ms; 25 ms "small" leniency when no note is in the window). While it runs, the
 *    first unhit note in the window is hit as soon as the held frets match it. When it runs out, or on a
 *    second strum while it runs, the player overstrums. With combo 0 a strum may hit a later note in the
 *    window (note skipping); the skipped notes are missed.
 *  - HOPOs: hittable without a strum by a fret change if it is the first note in the window and the combo
 *    is above 0 (or it is the chart's first note). Taps: the same, and also with combo 0. After a
 *    HOPO/tap hit, the HOPO leniency timer (80 ms) eats one strum, so strumming through a HOPO does not
 *    overstrum. Front end: a HOPO/tap can only be tapped while the last fret change's front end has not
 *    expired (params.infiniteFrontEnd lifts this; default off).
 *  - Fret matching (CanNoteBeHit): single notes may be anchored by any frets below the note. Strummed
 *    chords need the exact frets. HOPO/tap chords may be anchored below their lowest fret. Open notes
 *    need no frets held.
 *  - Anti-ghosting (default on): a hammer-on to a fret the next note does not have, while that note is in
 *    its window, counts a ghost input and stops that note from being tapped (it can still be strummed).
 *  - Overstrum (GuitarEngine.Overstrum): resets the combo and adds 1 to overstrums. Ignored before the
 *    first note is resolved, after the last note, and during a WaitCountdown (a gap of 9 s or more).
 *  - Score: 50 points per note plus 50 per extra fret of a chord, times the multiplier.
 *    Multiplier = min(floor(combo / 10) + 1, max), max 4 for guitar and 6 for bass. Combo +1 per note
 *    (a chord is one note). The multiplier updates before the note scores, so the 10th note scores 2x.
 *
 * Deviations from YARG:
 *  1. Gamepad mode (opts.gamepadMode, Clone Hero's rule; a separate hit path, not in YARG): strum inputs
 *     are ignored. Only presses count: whenever a fret goes down, the first unhit note is hit if it is
 *     inside its hit window and the held frets then match it: chords exactly (so a chord is hit when its
 *     last fret goes down), single notes with YARG's anchoring rule (lower frets may be held). Releases
 *     never hit. Note type (strum/HOPO/tap) does not matter. Open notes are hit only by pressing the
 *     'open' action with no frets held. A press or release that matches nothing is
 *     ignored (no overstrum, no ghost input); a note is missed only when its window passes.
 *  2. Time model: YARG queues inputs and runs in chart ticks. This engine uses seconds and runs input()
 *     and update() immediately. Times earlier than the engine clock are clamped forward, as YARG's
 *     QueueInput does. Between calls, the engine runs at each "interesting" time in order (note front
 *     ends, note back ends + 1 ulp, leniency timer ends), as YARG's queued updates do. The hit-logic
 *     re-run loop stops after 1000 passes (a safety net; YARG has none).
 *  3. Not ported: bots, trill/tremolo lanes and their leniency, Big Rock Endings / codas, solo taps
 *     (SoloTaps; off by default), the six-fret engine, wildcard notes, band/unison bonus and
 *     revives, replays, and the HoposStrummed stat (YARG never increments it).
 *  4. Not ported yet (Task 5 adds them at the hooks marked "Task 5"): sustains, whammy, star power,
 *     solos and stars. The 'whammy' and 'star_power' inputs are recorded but have no effect yet.
 *  5. Input actions: YARG's GuitarAction values become names ('green'..'orange', 'strum_up',
 *     'strum_down', 'whammy', 'star_power') plus 'open', which only gamepad mode uses (deviation 1). In
 *     strum mode 'open' is ignored; open notes are strummed with no frets held, as in YARG.
 *  6. Chart import: feedBack wire notes {t, f, l?, h?, tap?} become one note per chord (f is the fret
 *     mask, 0 = open; tap beats h). The wire drops the open bit from open+fret chords, so YARG's open
 *     chord rules never apply. Notes less than 1 ms apart are merged into one chord (OR-ed frets, the
 *     first note's type, the longest sustain); noteState() of a merged index reports the chord.
 *  7. Reporting: getState().notesMissed counts notes actually missed so far (YARG reports
 *     TotalNotes - NotesHit). 'combo-reset' fires on every combo reset, as YARG's OnComboReset does, and
 *     carries the combo it reset from.
 *  8. reset(t) (seeking): YARG's Reset(keepCurrentButtons: true), then notes whose window has already
 *     passed at t are set aside without a hit or miss and the engine clock starts at t.
 * -------------------------------------------------------------------------------------------------
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (typeof window !== 'undefined' && window) window.FiveFretEngine = api;
    else if (typeof module !== 'object' && root) root.FiveFretEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ── Constants ───────────────────────────────────────────────────────────────

    // GuitarEngine.OPEN_MASK: bit 6 stands for "no fret held" / an open note.
    const OPEN_MASK = 64;
    const FRET_MASK = 31;

    // BaseEngine.cs
    const POINTS_PER_NOTE = 50;
    // BaseEngine.UpdateMultiplier: (Combo / 10) + 1
    const NOTES_PER_MULTIPLIER = 10;

    // GuitarAction (InputActions.cs): GreenFret..OrangeFret = 0..4, so a fret's bit is 1 << action.
    const FRET_ACTIONS = Object.freeze({ green: 0, red: 1, yellow: 2, blue: 3, orange: 4 });
    const ACTIONS = Object.freeze(['green', 'red', 'yellow', 'blue', 'orange',
        'strum_up', 'strum_down', 'open', 'whammy', 'star_power']);

    const NOTE_TYPE = Object.freeze({ STRUM: 'strum', HOPO: 'hopo', TAP: 'tap' });
    const EVENTS = Object.freeze(['hit', 'miss', 'overstrum', 'combo-reset']);

    const CHORD_EPS = 0.001;            // wire notes closer than 1 ms form one chord
    const NOT_STARTED = Number.MAX_VALUE; // EngineTimer.NOT_STARTED (double.MaxValue)
    const MIN_TIME = -Number.MAX_VALUE;   // BaseEngine.Reset: CurrentTime = double.MinValue
    const MAX_LOOP_PASSES = 1000;        // safety net for RunEngineLoop's do/while (YARG has none)

    // ── Default parameters ─────────────────────────────────────────────────────

    /**
     * YARG's default five-fret parameters (EnginePreset.Instruments.cs FiveFretGuitarPreset.Create):
     *  - hitWindow: MaxWindow 0.14, MinWindow 0.14, IsDynamic false, FrontToBackRatio 1.0, plus the
     *    HitWindowPreset dynamic defaults (scale 1.0, slope 0.93, gamma 1.5).
     *  - maxMultiplier: DEFAULT_MAX_MULTIPLIER 4, BASS_MAX_MULTIPLIER 6.
     *  - hopoLeniency 0.08, strumLeniency 0.05, strumLeniencySmall 0.025, antiGhosting true,
     *    infiniteFrontEnd false.
     *  - waitCountdownSeconds: WaitCountdown.MIN_SECONDS = 9.
     */
    function defaultParams(instrument) {
        return {
            hitWindow: {
                maxWindow: 0.14,
                minWindow: 0.14,
                isDynamic: false,
                frontToBackRatio: 1.0,
                dynamicScale: 1.0,
                dynamicSlope: 0.93,
                dynamicGamma: 1.5,
            },
            songSpeed: 1.0,
            maxMultiplier: instrument === 'bass' ? 6 : 4,
            notesPerMultiplier: NOTES_PER_MULTIPLIER,
            pointsPerNote: POINTS_PER_NOTE,
            hopoLeniency: 0.08,
            strumLeniency: 0.05,
            strumLeniencySmall: 0.025,
            infiniteFrontEnd: false,
            antiGhosting: true,
            waitCountdownSeconds: 9,
        };
    }

    function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

    function mergeParams(instrument, overrides) {
        const p = defaultParams(instrument);
        const o = overrides && typeof overrides === 'object' ? overrides : {};
        for (const k of Object.keys(o)) {
            if (k === 'hitWindow') continue;
            if (o[k] !== undefined) p[k] = o[k];
        }
        if (o.hitWindow && typeof o.hitWindow === 'object') Object.assign(p.hitWindow, o.hitWindow);
        // HitWindowSettings constructor: max >= min, dynamic settings clamped.
        const hw = p.hitWindow;
        if (hw.maxWindow < hw.minWindow) { const t = hw.maxWindow; hw.maxWindow = hw.minWindow; hw.minWindow = t; }
        hw.dynamicSlope = clamp(hw.dynamicSlope, 0, 1);
        hw.dynamicScale = clamp(hw.dynamicScale, 0.3, 3);
        hw.dynamicGamma = clamp(hw.dynamicGamma, 0.1, 10);
        return p;
    }

    // ── Hit window (HitWindowSettings.cs) ──────────────────────────────────────

    // CalculateHitWindow: MaxWindow unless dynamic, else Dark_Yarg_Impl.
    function calculateHitWindow(hw, averageTimeDistance) {
        if (!hw.isDynamic) return hw.maxWindow;
        const x = averageTimeDistance * 1000;
        const minMs = hw.minWindow * 1000;
        const maxMs = hw.maxWindow * 1000;
        const gammaPow = Math.pow(x / (maxMs * hw.dynamicScale), hw.dynamicGamma);
        const minMultiSlope = minMs * hw.dynamicSlope;
        const realSize = (gammaPow * (maxMs - minMultiSlope) + minMultiSlope) / 1000;
        return clamp(realSize, hw.minWindow, hw.maxWindow);
    }
    function getFrontEnd(hw, fullWindow, scale) {
        return -(Math.abs(fullWindow / 2) * hw.frontToBackRatio) * scale;
    }
    function getBackEnd(hw, fullWindow, scale) {
        return Math.abs(fullWindow / 2) * (2 - hw.frontToBackRatio) * scale;
    }

    // ── Bit helpers (BaseEngine.Generic.cs, MathUtil) ──────────────────────────

    // GetMostSignificantBit: 1-based index of the highest set bit, 0 for an empty mask.
    function msb(mask) {
        let i = 0;
        while (mask !== 0) { mask >>>= 1; i++; }
        return i;
    }
    function popcount(mask) {
        let c = 0;
        while (mask) { c += mask & 1; mask >>>= 1; }
        return c;
    }
    // MathUtil.BitIncrement: the next representable double above x.
    const _f64 = new Float64Array(1);
    const _i64 = new BigInt64Array(_f64.buffer);
    function bitIncrement(x) {
        if (Number.isNaN(x) || x === Infinity) return x;
        if (x === 0) return Number.MIN_VALUE;
        _f64[0] = x;
        _i64[0] += x > 0 ? 1n : -1n;
        return _f64[0];
    }

    // ── EngineTimer.cs ─────────────────────────────────────────────────────────

    function EngineTimer(threshold) {
        this.threshold = threshold;
        this.speed = 1.0;
        this.startTime = NOT_STARTED;
        this.active = false;
    }
    Object.defineProperty(EngineTimer.prototype, 'endTime', {
        get() { return this.startTime + this.threshold * this.speed; },
    });
    EngineTimer.prototype.start = function (t) { this.startTime = t; this.active = true; };
    EngineTimer.prototype.startWithOffset = function (t, offset) {
        this.startTime = t - Math.abs(this.threshold * this.speed - offset);
        this.active = true;
    };
    EngineTimer.prototype.disable = function () { this.active = false; };
    EngineTimer.prototype.reset = function () { this.startTime = NOT_STARTED; this.active = false; };
    EngineTimer.prototype.isExpired = function (t) { return t >= this.endTime; };

    // BaseEngine.StartTimer
    function startTimer(timer, t, offset) {
        if (offset > 0) timer.startWithOffset(t, offset);
        else timer.start(t);
    }

    // ── Chart import ───────────────────────────────────────────────────────────

    function noteType(n) {
        if (n.tap) return NOTE_TYPE.TAP;
        if (n.h) return NOTE_TYPE.HOPO;
        return NOTE_TYPE.STRUM;
    }

    /** Wire notes -> engine notes in time order, one per chord. Returns { notes, bySrc }. */
    function buildNotes(wire) {
        const list = [];
        (Array.isArray(wire) ? wire : []).forEach((n, i) => {
            if (n && Number.isFinite(+n.t)) list.push({ n, i });
        });
        list.sort((a, b) => (+a.n.t - +b.n.t) || (a.i - b.i));
        const notes = [];
        const bySrc = new Map();
        for (const { n, i } of list) {
            const t = +n.t;
            const frets = (n.f | 0) & FRET_MASK;
            const len = Number.isFinite(+n.l) && +n.l > 0 ? +n.l : 0;
            const last = notes[notes.length - 1];
            if (last && t - last.t < CHORD_EPS) {
                const merged = (last.mask & FRET_MASK) | frets;
                last.mask = merged || OPEN_MASK;
                last.len = Math.max(last.len, len);
                bySrc.set(i, last);
                continue;
            }
            const note = {
                index: notes.length, srcIndex: i, src: n, t, len,
                mask: frets || OPEN_MASK, type: noteType(n),
                prev: last || null, next: null, front: 0, back: 0,
                hit: false, missed: false, skipped: false, hitTime: null, offset: null,
            };
            if (last) last.next = note;
            notes.push(note);
            bySrc.set(i, note);
        }
        return { notes, bySrc };
    }

    function isChord(note) { return popcount(note.mask & FRET_MASK) > 1; }
    function resolved(note) { return note.hit || note.missed || note.skipped; }

    // ── Engine ─────────────────────────────────────────────────────────────────

    function Engine(chart, opts) {
        chart = chart || {};
        opts = opts || {};
        this.instrument = opts.instrument === 'bass' ? 'bass' : 'guitar';
        this.gamepadMode = !!opts.gamepadMode;
        this.params = mergeParams(this.instrument, opts.params);
        this._listeners = {};

        const built = buildNotes(chart.notes);
        this.notes = built.notes;
        this._bySrc = built.bySrc;

        // GetAverageNoteDistance + CalculateHitWindow, per note (the window never changes mid-song).
        const hw = this.params.hitWindow;
        const scale = this.params.songSpeed;
        for (const note of this.notes) {
            const full = calculateHitWindow(hw, this._averageNoteDistance(note));
            note.front = getFrontEnd(hw, full, scale);
            note.back = getBackEnd(hw, full, scale);
        }

        // BaseEngine.Generic.GetWaitCountdowns: gaps of >= MIN_SECONDS from the end of the previous note
        // (sustain included) to the next note.
        this.waitCountdowns = [];
        let latestEnd = 0;
        for (const note of this.notes) {
            if (note.t - latestEnd >= this.params.waitCountdownSeconds) {
                this.waitCountdowns.push({ start: latestEnd, end: note.t });
            }
            latestEnd = Math.max(latestEnd, note.t + note.len);
        }

        // GuitarEngine constructor: leniency timers.
        this.strumLeniencyTimer = new EngineTimer(this.params.strumLeniency);
        this.hopoLeniencyTimer = new EngineTimer(this.params.hopoLeniency);
        this.strumLeniencyTimer.speed = this.params.songSpeed;
        this.hopoLeniencyTimer.speed = this.params.songSpeed;

        this.inputButtonMask = 0;
        this.lastButtonMask = 0;
        this._resetState(false);
    }

    // BaseEngine.Generic.GetAverageNoteDistance
    Engine.prototype._averageNoteDistance = function (note) {
        let currentToNext = this.params.hitWindow.maxWindow / 2;
        if (note.next) currentToNext = (note.next.t - note.t) / 2;
        const previousToCurrent = note.prev ? (note.t - note.prev.t) / 2 : currentToNext;
        return previousToCurrent + currentToNext;
    };

    // YargFiveFretGuitarEngine.Reset / GuitarEngine.Reset / BaseEngine(.Generic).Reset
    Engine.prototype._resetState = function (keepCurrentButtons) {
        const buttons = this.effectiveButtonMask;

        this.noteIndex = 0;
        this.currentTime = MIN_TIME;
        this.lastUpdateTime = MIN_TIME;
        this.reRunHitLogic = false;

        this.effectiveButtonMask = OPEN_MASK;
        this.hasFretted = false;
        this.hasStrummed = false;
        this.hasTapped = true;
        this.isFretPress = false;
        this.wasNoteGhosted = false;
        this.strumLeniencyTimer.reset();
        this.hopoLeniencyTimer.reset();
        this.frontEndExpireTime = 0;

        // Gamepad mode (deviation 1): what changed since the last hit-logic pass.
        this.gamepadFretsPressed = false;
        this.gamepadOpenPressed = false;

        this.isWaitCountdownActive = false;
        this.waitCountdownIndex = 0;
        this.isStarPowerInputActive = false;
        this.whammy = 0;
        // Task 5: active sustains (YARG's ActiveSustains). Always empty until sustains are ported.
        this.activeSustains = [];

        this.stats = {
            score: 0, noteScore: 0, combo: 0, maxCombo: 0, multiplier: 1,
            notesHit: 0, notesMissed: 0, overstrums: 0, ghostInputs: 0,
        };

        for (const note of this.notes) {
            note.hit = false; note.missed = false; note.skipped = false;
            note.hitTime = null; note.offset = null;
        }

        if (keepCurrentButtons && buttons !== undefined) this.effectiveButtonMask = buttons;
    };

    // ── Events ──

    Engine.prototype.on = function (name, cb) {
        if (typeof cb !== 'function') return () => {};
        (this._listeners[name] || (this._listeners[name] = [])).push(cb);
        return () => this.off(name, cb);
    };
    Engine.prototype.off = function (name, cb) {
        const l = this._listeners[name];
        if (!l) return;
        if (cb === undefined) { delete this._listeners[name]; return; }
        const i = l.indexOf(cb);
        if (i >= 0) l.splice(i, 1);
    };
    Engine.prototype._emit = function (name, payload) {
        const l = this._listeners[name];
        if (!l || !l.length) return;
        for (const cb of l.slice()) {
            try { cb(payload); } catch (e) {
                if (typeof console !== 'undefined' && console.error) console.error('[FiveFretEngine] listener error', name, e);
            }
        }
    };

    // ── Public API ──

    /**
     * Feed one input. action: 'green'..'orange', 'strum_up', 'strum_down', 'open', 'whammy', 'star_power'.
     * value: pressed (boolean), or 0..1 for 'whammy'. (BaseEngine.QueueInput + ProcessInputs.)
     */
    Engine.prototype.input = function (t, action, value) {
        t = +t;
        if (!Number.isFinite(t) || ACTIONS.indexOf(action) < 0) return;
        if (t < this.currentTime) t = this.currentTime;
        this._runQueuedUpdates(t);
        this._mutateStateWithInput(action, value);
        this._runEngineLoop(t);
    };

    /** Advance the engine clock to t (BaseEngine.Update without inputs). */
    Engine.prototype.update = function (t) {
        t = +t;
        if (!Number.isFinite(t)) return;
        if (t < this.currentTime) t = this.currentTime;
        this._runQueuedUpdates(t);
        this._runEngineLoop(t);
    };

    /**
     * Start over at t (seek / loop): YARG's Reset(keepCurrentButtons: true), then the notes whose window
     * has already passed at t are set aside without a hit or a miss (deviation 8).
     */
    Engine.prototype.reset = function (t) {
        this._resetState(true);
        t = +t;
        if (!Number.isFinite(t)) return;
        while (this.noteIndex < this.notes.length) {
            const note = this.notes[this.noteIndex];
            if (t <= note.t + note.back) break;
            note.skipped = true;
            this.noteIndex++;
        }
        this._runEngineLoop(t);
    };

    Engine.prototype.getState = function () {
        const s = this.stats;
        return {
            score: s.score,
            combo: s.combo,
            maxCombo: s.maxCombo,
            multiplier: s.multiplier,
            maxMultiplier: this.params.maxMultiplier,
            notesHit: s.notesHit,
            notesMissed: s.notesMissed,
            totalNotes: this.notes.length,
            overstrums: s.overstrums,
            ghostInputs: s.ghostInputs,
            time: this.currentTime,
        };
    };

    /** 'hit' | 'miss' | null for the chart note at index i (index into chart.notes). */
    Engine.prototype.noteState = function (i) {
        const note = this._bySrc.get(i);
        if (!note) return null;
        return note.hit ? 'hit' : (note.missed ? 'miss' : null);
    };

    /** Held frets as a mask (bit0 green .. bit4 orange). */
    Engine.prototype.heldFrets = function () {
        return this.effectiveButtonMask & FRET_MASK;
    };

    // ── Engine loop (BaseEngine.cs) ──

    // RunEngineLoop
    Engine.prototype._runEngineLoop = function (time) {
        let passes = 0;
        do {
            this.reRunHitLogic = false;
            this._updateTimeVariables(time);
            this._updateStarPower();
            this._updateHitLogic(time);
        } while (this.reRunHitLogic && ++passes < MAX_LOOP_PASSES);
        if (this.reRunHitLogic && typeof console !== 'undefined' && console.warn) {
            console.warn('[FiveFretEngine] hit-logic loop stopped after ' + MAX_LOOP_PASSES + ' passes at', time);
        }
    };

    // RunQueuedUpdates: run the engine at every queued time before `time`, earliest first.
    Engine.prototype._runQueuedUpdates = function (time) {
        for (;;) {
            const next = this._nextQueuedUpdate(time);
            if (next === null) return;
            this._runEngineLoop(next);
        }
    };

    // GenerateQueuedUpdates (GuitarEngine + BaseEngine.Generic): the earliest time strictly between the
    // engine clock and nextTime at which something can change, or null.
    Engine.prototype._nextQueuedUpdate = function (nextTime) {
        const prev = this.currentTime;
        let best = null;
        const consider = (x) => {
            if (x > prev && x < nextTime && (best === null || x < best)) best = x;
        };
        if (this.hopoLeniencyTimer.active) consider(this.hopoLeniencyTimer.endTime);
        if (this.strumLeniencyTimer.active) consider(this.strumLeniencyTimer.endTime);
        // Task 5: sustain drop/burst/end times, star power whammy and end times.
        for (let i = this.noteIndex; i < this.notes.length; i++) {
            const note = this.notes[i];
            const front = note.t + note.front;
            if (nextTime < front) break;
            consider(front);
            // A note is not missed exactly at its back end, so the miss update is 1 ulp later.
            consider(bitIncrement(note.t + note.back));
        }
        return best;
    };

    // BaseEngine.Generic.UpdateTimeVariables (WaitCountdown part; codas not ported)
    Engine.prototype._updateTimeVariables = function (time) {
        this.lastUpdateTime = this.currentTime;
        this.currentTime = time;
        const cds = this.waitCountdowns;
        while (this.waitCountdownIndex < cds.length && time >= cds[this.waitCountdownIndex].end) {
            this.waitCountdownIndex++;
        }
        this.isWaitCountdownActive = this.waitCountdownIndex < cds.length &&
            time >= cds[this.waitCountdownIndex].start;
    };

    // Task 5: BaseEngine.Generic.UpdateStarPower (drain, whammy gain, activation).
    Engine.prototype._updateStarPower = function () {};

    // Task 5: BaseEngine.Generic.UpdateSustains (scoring, drops, bursts).
    Engine.prototype._updateSustains = function () {};

    // ── Input (YargFiveFretGuitarEngine.MutateStateWithInput) ──

    Engine.prototype._mutateStateWithInput = function (action, value) {
        if (action === 'star_power') {
            this.isStarPowerInputActive = !!value; // Task 5: activation
        } else if (action === 'whammy') {
            this.whammy = clamp(+value || 0, 0, 1); // Task 5: StartWhammyTimer
        } else if (action === 'strum_up' || action === 'strum_down') {
            if (value && !this.gamepadMode) this.hasStrummed = true;
        } else if (action === 'open') {
            if (value && this.gamepadMode) this.gamepadOpenPressed = true;
        } else {
            const before = this.effectiveButtonMask;
            this.lastButtonMask = this.effectiveButtonMask;
            this.hasFretted = true;
            this.isFretPress = !!value;
            this._toggleFret(FRET_ACTIONS[action], !!value);
            // No other frets are held: enable the "open fret"; else disable it.
            if ((this.effectiveButtonMask & ~OPEN_MASK) === 0) this.effectiveButtonMask |= OPEN_MASK;
            else this.effectiveButtonMask &= ~OPEN_MASK;
            // Gamepad mode (deviation 1) hits only on a fret going down, never on a release.
            if (value && this.effectiveButtonMask !== before) this.gamepadFretsPressed = true;
        }
    };

    // GuitarEngine.ToggleFret (no solo frets on this API)
    Engine.prototype._toggleFret = function (fret, active) {
        if (active) this.inputButtonMask |= (1 << fret);
        else this.inputButtonMask &= ~(1 << fret);
        this.effectiveButtonMask = this.inputButtonMask & 0xff;
    };

    // ── Hit logic ──

    Engine.prototype._updateHitLogic = function (time) {
        if (this.gamepadMode) this._updateHitLogicGamepad();
        else this._updateHitLogicStrum(time);
    };

    // YargFiveFretGuitarEngine.UpdateHitLogic
    Engine.prototype._updateHitLogicStrum = function () {
        this._updateTimers();

        let strumEatenByHopo = false;
        // Up here so overstrumming still works when there are no notes left.
        if (this.hasStrummed) {
            if (this.hopoLeniencyTimer.active) {
                // A HOPO was hit recently: it eats this strum (only one).
                this.strumLeniencyTimer.disable();
                this.hopoLeniencyTimer.disable();
                strumEatenByHopo = true;
                this.reRunHitLogic = true;
            } else if (this.strumLeniencyTimer.active) {
                // Strummed while strum leniency is active (double strum).
                this._overstrum();
            }

            if (!strumEatenByHopo) {
                let offset = 0;
                if (this.noteIndex >= this.notes.length || !this._isNoteInWindow(this.notes[this.noteIndex])) {
                    offset = this.params.strumLeniencySmall;
                }
                startTimer(this.strumLeniencyTimer, this.currentTime, offset);
                this.reRunHitLogic = true;
            }
        }

        if (this.noteIndex >= this.notes.length) {
            this._clearInputFlags();
            this._updateSustains();
            return;
        }

        const note = this.notes[this.noteIndex];
        if (this.hasFretted) {
            this.hasTapped = true;
            // The time the front end will expire. Used for hit logic without infinite front end.
            this.frontEndExpireTime = this.currentTime + Math.abs(note.front);
            // Ghost logic runs regardless of the setting, for the ghost counter.
            const ghosted = this._checkForGhostInput(note);
            this.wasNoteGhosted = this.params.antiGhosting && (ghosted || this.wasNoteGhosted);
            if (ghosted) this.stats.ghostInputs++;
        }

        this._checkForNoteHit();
        this._updateSustains();
        this._clearInputFlags();
    };

    Engine.prototype._clearInputFlags = function () {
        this.hasStrummed = false;
        this.hasFretted = false;
        this.isFretPress = false;
        this.gamepadFretsPressed = false;
        this.gamepadOpenPressed = false;
    };

    // YargFiveFretGuitarEngine.CheckForNoteHit
    Engine.prototype._checkForNoteHit = function () {
        const p = this.params;
        for (let i = this.noteIndex; i < this.notes.length; i++) {
            const isFirstNoteInWindow = i === this.noteIndex;
            const note = this.notes[i];
            if (resolved(note)) break;

            const w = this._windowState(note);
            if (w !== 'in') {
                if (isFirstNoteInWindow && w === 'missed') this._missNote(note);
                break;
            }

            if (!this._canNoteBeHit(note)) {
                // Note skipping is not allowed on the first note if it is a HOPO/tap.
                if (note.type !== NOTE_TYPE.STRUM && this.noteIndex === 0) break;
                continue;
            }

            const combo = this.stats.combo;
            // A HOPO can be hit without combo if it is the first note (practice mode).
            const hopoCondition = note.type === NOTE_TYPE.HOPO && isFirstNoteInWindow &&
                (combo > 0 || this.noteIndex === 0);
            // A tap can be hit only if it is the closest note, unless the combo is 0 (note skipping).
            const tapCondition = note.type === NOTE_TYPE.TAP && (isFirstNoteInWindow || combo === 0);
            const frontEndIsExpired = note.t > this.frontEndExpireTime;
            const canUseInfFrontEnd = p.infiniteFrontEnd || !frontEndIsExpired || this.noteIndex === 0;

            if (this.hasTapped && (hopoCondition || tapCondition) && canUseInfFrontEnd && !this.wasNoteGhosted) {
                this._hitNote(note);
                break;
            }

            // If the HOPO/tap checks failed, the note can be hit if it was strummed.
            if ((this.hasStrummed || this.strumLeniencyTimer.active) &&
                (isFirstNoteInWindow || (this.noteIndex > 0 && combo === 0))) {
                this._hitNote(note);
                break;
            }
        }
    };

    // Gamepad mode (deviation 1): a fret change hits the next note if it matches; nothing else counts.
    Engine.prototype._updateHitLogicGamepad = function () {
        this._updateTimers();

        // Notes whose window has passed are missed first, so the input applies to the next note.
        while (this.noteIndex < this.notes.length &&
            this._windowState(this.notes[this.noteIndex]) === 'missed') {
            this._missNote(this.notes[this.noteIndex]);
        }

        if (this.noteIndex < this.notes.length) {
            const note = this.notes[this.noteIndex];
            if (this._windowState(note) === 'in') {
                const open = note.mask === OPEN_MASK;
                // The open button hits an open note only with no frets held, as a strum does in strum mode.
                const openHit = this.gamepadOpenPressed && (this.effectiveButtonMask & FRET_MASK) === 0;
                if (open ? openHit : (this.gamepadFretsPressed && this._gamepadMatches(note))) {
                    this._hitNote(note);
                }
            }
        }

        this._updateSustains();
        this._clearInputFlags();
    };

    Engine.prototype._gamepadMatches = function (note) {
        const held = this.effectiveButtonMask;
        if (isChord(note)) return (held & FRET_MASK) === note.mask;
        return this._isNoteHittable(note, held);
    };

    // 'before' | 'in' | 'missed' (BaseEngine.Generic.IsNoteInWindow)
    Engine.prototype._windowState = function (note) {
        const time = this.currentTime;
        if (time < note.t + note.front) return 'before';
        if (time > note.t + note.back) return 'missed';
        return 'in';
    };
    Engine.prototype._isNoteInWindow = function (note) { return this._windowState(note) === 'in'; };

    // YargFiveFretGuitarEngine.CanNoteBeHit. Task 5: frets of extended sustains are masked out first.
    Engine.prototype._canNoteBeHit = function (note) {
        return this._isNoteHittable(note, this.effectiveButtonMask);
    };

    // YargFiveFretGuitarEngine.CanNoteBeHit.IsNoteHittable (no wildcard, disjoint or open-chord notes here)
    Engine.prototype._isNoteHittable = function (note, buttons) {
        const noteMask = note.mask;
        // Holding the exact note mask can hit.
        if (buttons === noteMask) return true;

        // XOR gives the anchor (held frets) around the note.
        const anchorButtons = buttons ^ noteMask;

        if (isChord(note)) {
            // Strum chords need the exact frets.
            if (note.type === NOTE_TYPE.STRUM) return buttons === noteMask;
            // HOPO/tap chords: anchors below the lowest fret of the chord, and every chord fret held.
            const chordMask = lowestFretMask(noteMask);
            return isAnchoringValid(anchorButtons, chordMask) && buttons - anchorButtons === noteMask;
        }

        // Single notes: anchors are frets held below the note. The open bit is removed from the note,
        // otherwise this always passes (it is higher than every fret).
        return isAnchoringValid(anchorButtons, noteMask & ~OPEN_MASK);
    };

    // YargFiveFretGuitarEngine.IsAnchoringValid: anchor frets must be strictly lower than the target.
    function isAnchoringValid(anchorButtons, targetFretMask) {
        if (anchorButtons === 0) return true;
        return msb(anchorButtons) < msb(targetFretMask);
    }

    // YargFiveFretGuitarEngine.GetChordLowestFretMask
    function lowestFretMask(noteMask) {
        let chordMask = 0;
        for (let fret = 0; fret <= 4; fret++) {
            chordMask = 1 << fret;
            if ((chordMask & noteMask) === chordMask) break;
        }
        return chordMask;
    }

    // YargFiveFretGuitarEngine.CheckForGhostInput (trill lanes not ported)
    Engine.prototype._checkForGhostInput = function (note) {
        // The first note cannot be ghosted, nor can a release (pull-off).
        if (!note.prev || !this.isFretPress) return false;
        // A note can only be ghosted inside its window.
        if (!this._isNoteInWindow(note)) return false;
        const highestHeldFret = msb(this.effectiveButtonMask);
        // A hammer-on: the highest held fret is higher than the highest fret held before.
        const isHammerOn = highestHeldFret > msb(this.lastButtonMask);
        // ...to a fret that is not part of the note.
        return isHammerOn && (this.effectiveButtonMask & note.mask) === 0;
    };

    // YargFiveFretGuitarEngine.UpdateTimers
    Engine.prototype._updateTimers = function () {
        const t = this.currentTime;
        if (this.hopoLeniencyTimer.active && this.hopoLeniencyTimer.isExpired(t)) {
            this.hopoLeniencyTimer.disable();
            this.reRunHitLogic = true;
        }
        if (this.strumLeniencyTimer.active && this.strumLeniencyTimer.isExpired(t)) {
            this._overstrum();
            this.strumLeniencyTimer.disable();
            this.reRunHitLogic = true;
        }
    };

    // ── Hit / miss / overstrum ──

    // YargFiveFretGuitarEngine.HitNote -> GuitarEngine.HitNote -> BaseEngine.Generic.HitNote
    Engine.prototype._hitNote = function (note) {
        if (note.type !== NOTE_TYPE.STRUM) {
            this.hasTapped = false;
            startTimer(this.hopoLeniencyTimer, this.currentTime, 0);
        } else {
            // Lets HOPOs/taps be hit with infinite front end after strumming.
            this.hasTapped = true;
            // The same when infinite front end is off.
            this.frontEndExpireTime = NOT_STARTED;
        }
        this.strumLeniencyTimer.disable();
        // Task 5: end active sustains that share a fret with this note.

        if (resolved(note)) return;
        note.hit = true;
        note.hitTime = this.currentTime;
        note.offset = this.currentTime - note.t;

        this._skipPreviousNotes(note);
        // Task 5: star power phrase award (IsStarPowerEnd) / strip with NoStarPowerOverlap.

        this._incrementCombo();
        this.stats.notesHit++;
        this._updateMultiplier();
        const points = this._addScore(note);
        // Task 5: StartSustain.

        this.wasNoteGhosted = false;
        this._emit('hit', {
            time: this.currentTime, index: note.srcIndex, note: note.src, noteTime: note.t,
            offset: note.offset, mask: note.mask & FRET_MASK, type: note.type, points,
            combo: this.stats.combo, multiplier: this.stats.multiplier, score: this.stats.score,
        });
        // Task 5: solo note tracking (HandleSoloNote).
        this._advanceToNextNote();
    };

    // YargFiveFretGuitarEngine.MissNote -> GuitarEngine.MissNote -> BaseEngine.Generic.MissNote
    Engine.prototype._missNote = function (note) {
        this.hasTapped = false;
        if (resolved(note)) return;
        note.missed = true;
        // Task 5: StripStarPower(note).
        this.wasNoteGhosted = false;
        this._resetCombo();
        this.stats.notesMissed++;
        this._updateMultiplier();
        this._emit('miss', { time: this.currentTime, index: note.srcIndex, note: note.src, noteTime: note.t });
        // Task 5: solo note tracking (HandleSoloNote).
        this._advanceToNextNote();
    };

    // BaseEngine.Generic.AdvanceToNextNote
    Engine.prototype._advanceToNextNote = function () {
        this.noteIndex++;
        this.reRunHitLogic = true;
    };

    // BaseEngine.Generic.SkipPreviousNotes (lane autohit not ported)
    Engine.prototype._skipPreviousNotes = function (current) {
        let prev = current.prev;
        let skipped = false;
        while (prev && !resolved(prev)) {
            skipped = true;
            this._missNote(prev);
            prev = prev.prev;
        }
        return skipped;
    };

    // GuitarEngine.Overstrum (lanes and codas not ported)
    Engine.prototype._overstrum = function () {
        // Can't overstrum before the first note is hit/missed.
        if (this.noteIndex === 0) return;
        // Past the last note with no active sustains.
        if (this.noteIndex >= this.notes.length && this.activeSustains.length === 0) return;
        if (this.isWaitCountdownActive) return;
        // Task 5: break all active sustains (scored up to now); strip the star power phrase of the
        // current note unless it starts the phrase.
        this._resetCombo();
        this.stats.overstrums++;
        this._updateMultiplier();
        this._emit('overstrum', { time: this.currentTime });
    };

    // ── Combo and score (BaseEngine.cs, GuitarEngine.cs) ──

    Engine.prototype._incrementCombo = function () {
        this.stats.combo++;
        if (this.stats.combo > this.stats.maxCombo) this.stats.maxCombo = this.stats.combo;
    };

    Engine.prototype._resetCombo = function () {
        const previous = this.stats.combo;
        this.stats.combo = 0;
        this._emit('combo-reset', { time: this.currentTime, combo: previous });
    };

    // BaseEngine.UpdateMultiplier. Task 5: doubled while star power is active; sustains rebased.
    Engine.prototype._updateMultiplier = function () {
        const p = this.params;
        this.stats.multiplier = Math.min(Math.floor(this.stats.combo / p.notesPerMultiplier) + 1, p.maxMultiplier);
    };

    // GuitarEngine.AddScore(note): 50 per note plus 50 per extra chord fret, times the multiplier.
    Engine.prototype._addScore = function (note) {
        const notePoints = this.params.pointsPerNote * Math.max(1, popcount(note.mask & FRET_MASK));
        this.stats.noteScore += notePoints;
        const points = notePoints * this.stats.multiplier;
        this.stats.score += points;
        return points;
    };

    function create(chart, opts) { return new Engine(chart, opts); }

    return {
        OPEN_MASK,
        FRET_ACTIONS,
        ACTIONS,
        NOTE_TYPE,
        EVENTS,
        POINTS_PER_NOTE,
        create,
        defaultParams,
        calculateHitWindow,
        Engine,
    };
});
