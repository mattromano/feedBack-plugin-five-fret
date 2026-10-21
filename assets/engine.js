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
 *   YARG.Core/Engine/BaseEngine.cs, BaseEngine.Generic.cs (hit logic, sustains, star power, solos, stars)
 *   YARG.Core/Engine/SustainList.cs (ActiveSustain), YARG.Core/Engine/SoloSection.cs
 *   YARG.Core/Engine/EngineTimer.cs
 *   YARG.Core/Engine/HitWindowSettings.cs
 *   YARG.Core/Engine/BaseStats.cs (TotalScore), YARG.Core/YargMath.cs (InverseLerpF)
 *   YARG.Core/Chart/Sync/TimeSignatureEvent.cs (MEASURE_RESOLUTION_SCALE: star power measure ticks)
 *   YARG.Core/Chart/Loaders/MoonSong/MoonSongLoader.Guitar.cs (GetGuitarNoteFlags: extended sustains)
 *   YARG.Core/Input/InputActions.cs (GuitarAction)
 *   YARG.Core/Chart/Events/WaitCountdown.cs (MIN_SECONDS)
 *   YARG.Core/Game/Presets/EnginePreset.Instruments.cs (FiveFretGuitarPreset defaults)
 * and from the YARG game (https://github.com/YARC-Official/YARG, also LGPL-3.0), master at commit
 * f5bfbe6996b4af35722d4204a93c6cc5c8f52a45:
 *   Assets/Script/Gameplay/Player/FiveFretGuitarPlayer.cs (guitar and bass star score thresholds)
 *   Assets/Script/Gameplay/Player/BasePlayer.cs (SoloBonusStarMultiplierThresholds)
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
 *    Multiplier = min(floor(combo / 10) + 1, max), max 4 for guitar and 6 for bass, doubled while star
 *    power is active. Combo +1 per note (a chord is one note). The multiplier updates before the note
 *    scores, so the 10th note scores 2x. getState().score is YARG's TotalScore: committed points, the
 *    points of the sustains being held (PendingScore) and solo bonuses.
 *  - Sustains (UpdateSustains, StartSustain, EndSustain, CanSustainHold): a hit note with a length
 *    starts a sustain worth 25 points per beat (POINTS_PER_BEAT), rounded up, times the multiplier
 *    when it is scored. It is scored in full once the time passes the burst point, a quarter beat
 *    before its end (SUSTAIN_BURST_FRACTION; at once if it is shorter than that). Letting go of the
 *    frets starts a 25 ms drop leniency (SustainDropLeniency x song speed); still let go when it runs
 *    out, the sustain is dropped and scored up to then. Extended sustains (a sustain still running
 *    when the next note starts) only need their own frets held, and those frets are masked out
 *    when the next notes are matched. Hitting a note that shares a fret with an active sustain ends
 *    that sustain without scoring the rest. An overstrum ends every active sustain and adds its points
 *    so far without the multiplier (GuitarEngine.Overstrum).
 *  - Star power (GainStarPower, AwardStarPower, StripStarPower, ActivateStarPower, ReleaseStarPower,
 *    UpdateStarPower): the bar holds 8 measures (STAR_POWER_MAX_MEASURES). Hitting the last note of a
 *    phrase whose notes were all hit adds a quarter bar (2 measures). A missed note, or an overstrum on
 *    a phrase note other than its first, fails the phrase. The 'star_power' button activates star
 *    power while it is held and the bar is at least half full. While active, the bar drains one measure
 *    per measure of song time, so a full bar lasts 8 measures, and the multiplier is doubled. While
 *    the whammy moves (each change keeps it "on" for 0.25 s, StarPowerWhammyBuffer) and a sustain of a
 *    star power note is held, the bar gains a full bar per 30 beats (CalculateStarPowerGain: gain
 *    factor 32 / 30 measure ticks per quarter tick), active or not.
 *  - Solos (GetSoloSections, HandleSoloNote, StartSolo, EndSolo): a solo starts when its first note
 *    is hit or missed and ends with its last. Bonus: 0 below 60% of its notes hit, else
 *    100 x notes hit x (percent - 60%) / 40%, rounded down to a multiple of 50. The bonus is not
 *    multiplied.
 *  - Stars (CalculateChartScores, PopulateStarScoreThresholds, UpdateStars): BaseScore = the score of a
 *    full combo with every sustain held and no star power (multiplier from the combo before each
 *    note). Threshold i = floor(BaseScore x star[i] + max solo bonus x solo[i]) (single-precision
 *    floats, as YARG), with star = [0.06, 0.12, 0.2, 0.47, 0.78, 1.15] for guitar and
 *    [0.05, 0.1, 0.19, 0.47, 0.78, 1.15] for bass (FiveFretGuitarPlayer.cs), solo =
 *    [0.05, 0.1, 0.2, 0.35, 0.65, 0.95] (BasePlayer.cs) and the max solo bonus = 100 per solo note.
 *    stars = thresholds passed + progress to the next, 0..6 (5 = five stars, 6 = gold stars).
 *
 * Deviations from YARG:
 *  1. Gamepad mode (opts.gamepadMode, Clone Hero's rule; a separate hit path, not in YARG): strum inputs
 *     are ignored. Only presses count: whenever a fret goes down, the first unhit note is hit if it is
 *     inside its hit window and the held frets then match it: chords exactly (so a chord is hit when its
 *     last fret goes down), single notes with YARG's anchoring rule (lower frets may be held); the frets
 *     of extended sustains are masked out first, as in CanNoteBeHit. Releases never hit. Note type
 *     (strum/HOPO/tap) does not matter. Open notes are hit only by pressing the 'open' action with no
 *     frets held. A press or release that matches nothing is ignored (no overstrum, no ghost input); a
 *     note is missed only when its window passes. Sustains, star power, solos and stars work as in
 *     strum mode.
 *  2. Time model: YARG queues inputs and runs in chart ticks. This engine uses seconds and runs input()
 *     and update() immediately. Times earlier than the engine clock are clamped forward, as YARG's
 *     QueueInput does. Between calls, the engine runs at each "interesting" time in order (note front
 *     ends, note back ends + 1 ulp, leniency timer ends, sustain drop / burst / end times, the whammy
 *     timer end, the star power end), as YARG's queued updates do. The hit-logic
 *     re-run loop stops after 1000 passes (a safety net; YARG has none).
 *  3. Not ported: bots, trill/tremolo lanes and their leniency, Big Rock Endings / codas, solo taps
 *     (SoloTaps; off by default), the six-fret engine, wildcard notes, band/unison bonus and
 *     revives, replays, and the HoposStrummed stat (YARG never increments it).
 *  4. Beats and measures come from chart.beats ([{time, measure}], one entry per beat, measure >= 0
 *     on a downbeat) in place of YARG's tick sync track. A beat is one chart.beats entry (YARG: a
 *     quarter note, Resolution ticks), so sustain points and whammy gain follow the chart's beats, which
 *     differ from YARG only where the beat is not a quarter note. The star power position is the
 *     fractional measure number, interpolated between downbeats (YARG: rounded integer measure ticks),
 *     so star power has no tick rounding. With fewer than two downbeats, 4 beats make a measure;
 *     with fewer than two beats, 120 BPM in 4/4 is assumed. Times outside the beat list are
 *     extrapolated at the tempo of its first or last interval.
 *  5. Input actions: YARG's GuitarAction values become names ('green'..'orange', 'strum_up',
 *     'strum_down', 'whammy', 'star_power') plus 'open', which only gamepad mode uses (deviation 1). In
 *     strum mode 'open' is ignored; open notes are strummed with no frets held, as in YARG. A 'whammy'
 *     input (value 0..1) counts as whammy movement only when its value changes, as YARG's input layer
 *     only sends changes.
 *  6. Chart import: feedBack wire notes {t, f, l?, h?, tap?} become one note per chord (f is the fret
 *     mask, 0 = open; tap beats h). The wire drops the open bit from open+fret chords, so YARG's open
 *     chord rules never apply. Notes less than 1 ms apart are merged into one chord (OR-ed frets, the
 *     first note's type, the longest sustain); noteState() of a merged index reports the chord.
 *     Chords therefore never have disjoint sustains (YARG's Disjoint flag). A note has an extended
 *     sustain when its sustain ends more than 1 us after the next note starts, or the previous
 *     note's sustain ends more than 1 us after it starts and it has a sustain itself
 *     (GetGuitarNoteFlags; YARG compares ticks with NoteSnapThreshold). Star power phrases and solos
 *     come from chart.starPower / chart.solos ([{start_time, end_time}] seconds); a note belongs to
 *     one when start - 0.1 ms <= t < end - 0.1 ms (YARG: tick ranges), and ranges without notes are
 *     left out.
 *  7. Reporting: getState().notesMissed counts notes actually missed so far (YARG reports
 *     TotalNotes - NotesHit). 'combo-reset' fires on every combo reset, as YARG's OnComboReset does, and
 *     carries the combo it reset from. A solo's percent is reported as 0..100.
 *  8. reset(t) (seeking): YARG's Reset(keepCurrentButtons: true), which zeroes the stats and clears
 *     star power, active sustains and solo progress. Then notes whose window has already passed at t
 *     are set aside without a hit or miss and the engine clock starts at t. A solo already under way at
 *     t restarts at the first note left, counting only the notes left (as YARG's practice mode does
 *     with its sliced chart); a star power phrase partly behind t can still be completed. Star
 *     thresholds stay those of the whole chart.
 *  9. Not ported from star power and sustains: RebaseSustains (it re-splits a held sustain's points
 *     at a multiplier change, but YARG then scores the whole sustain at the multiplier in force when it
 *     ends, so it changes no score), the queued "half bar" / "bar full" / whammy SP-end times (the
 *     'sp-ready' event and the end of star power fire on the next update), revives, unison bonus and
 *     the star power stats (StarPowerPhrasesHit, TimeInStarPower, ...).
 * 10. Overstrum during the tail of a sustain that was already scored in full (past its burst point)
 *     does not add its points a second time (YARG's Overstrum adds them again).
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
    const POINTS_PER_BEAT = 25;          // sustain points per beat
    const STAR_POWER_MAX_MEASURES = 8;   // a full star power bar
    const SUSTAIN_BURST_FRACTION = 4;    // a sustain is fully scored a quarter beat before its end
    // BaseEngine.UpdateMultiplier: (Combo / 10) + 1
    const NOTES_PER_MULTIPLIER = 10;
    // TimeSignatureEvent.MEASURE_RESOLUTION_SCALE: measure ticks per measure = 4 x quarter ticks per beat.
    const MEASURE_RESOLUTION_SCALE = 4;
    // BaseEngine.Generic.EndSolo
    const SOLO_MIN_PERCENT = 0.6;
    const SOLO_POINTS_PER_NOTE = 100;
    const SOLO_ROUND_TO = 50;

    // Star score thresholds (YARG game repo): fractions of BaseScore and of the max solo bonus.
    const GUITAR_STAR_THRESHOLDS = Object.freeze([0.06, 0.12, 0.2, 0.47, 0.78, 1.15]);  // FiveFretGuitarPlayer.cs
    const BASS_STAR_THRESHOLDS = Object.freeze([0.05, 0.1, 0.19, 0.47, 0.78, 1.15]);    // FiveFretGuitarPlayer.cs
    const SOLO_BONUS_STAR_THRESHOLDS = Object.freeze([0.05, 0.1, 0.2, 0.35, 0.65, 0.95]); // BasePlayer.cs

    // GuitarAction (InputActions.cs): GreenFret..OrangeFret = 0..4, so a fret's bit is 1 << action.
    const FRET_ACTIONS = Object.freeze({ green: 0, red: 1, yellow: 2, blue: 3, orange: 4 });
    const ACTIONS = Object.freeze(['green', 'red', 'yellow', 'blue', 'orange',
        'strum_up', 'strum_down', 'open', 'whammy', 'star_power']);

    const NOTE_TYPE = Object.freeze({ STRUM: 'strum', HOPO: 'hopo', TAP: 'tap' });
    const EVENTS = Object.freeze(['hit', 'miss', 'overstrum', 'combo-reset',
        'sustain-start', 'sustain-end', 'sp-phrase', 'sp-phrase-miss', 'sp-ready', 'sp-activate', 'sp-end',
        'solo-start', 'solo-end']);

    const CHORD_EPS = 0.001;            // wire notes closer than 1 ms form one chord
    const SECTION_EPS = 0.0001;         // star power / solo range edges (deviation 6)
    const EXTENDED_EPS = 0.000001;      // sustain overlap needed for an extended sustain (deviation 6)
    const SP_EPS = 1e-7;                // star power amounts, in measures (float noise)
    const BEAT_EPS = 1e-9;              // sustain points, in points (float noise before Math.ceil)
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
     *  - sustainDropLeniency 0.025 (DEFAULT_SUSTAIN_DROP_LENIENCY), starPowerWhammyBuffer 0.25
     *    (DEFAULT_WHAMMY_BUFFER), noStarPowerOverlap false.
     *  - starMultiplierThresholds: FiveFretGuitarPlayer.cs (guitar or bass);
     *    soloBonusStarMultiplierThresholds: BasePlayer.cs.
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
            sustainPointsPerBeat: POINTS_PER_BEAT,
            sustainDropLeniency: 0.025,
            starPowerWhammyBuffer: 0.25,
            starPowerMeasures: STAR_POWER_MAX_MEASURES,
            noStarPowerOverlap: false,
            starMultiplierThresholds: (instrument === 'bass' ? BASS_STAR_THRESHOLDS : GUITAR_STAR_THRESHOLDS).slice(),
            soloBonusStarMultiplierThresholds: SOLO_BONUS_STAR_THRESHOLDS.slice(),
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
                extended: false, phrase: null, sp: false, solo: null,
                beat: 0, endBeat: 0, end: t, burstTime: t,
            };
            if (last) last.next = note;
            notes.push(note);
            bySrc.set(i, note);
        }
        // MoonSongLoader.Guitar.GetGuitarNoteFlags: extended sustains (forwards and backwards).
        for (const note of notes) {
            const end = note.t + note.len;
            const forwards = note.next !== null && end > note.next.t + EXTENDED_EPS;
            const backwards = note.prev !== null && note.len > 0 && note.prev.t + note.prev.len > note.t + EXTENDED_EPS;
            note.extended = forwards || backwards;
        }
        return { notes, bySrc };
    }

    function isChord(note) { return popcount(note.mask & FRET_MASK) > 1; }
    function resolved(note) { return note.hit || note.missed || note.skipped; }

    /**
     * Star power phrases / solos ([{start_time, end_time}] seconds) -> sections over the notes they
     * contain, in time order: { index, start, end, first, last, count }. Each note in a section gets
     * note[key] = section. Ranges with no notes are left out (deviation 6).
     */
    function buildSections(notes, ranges, key) {
        const list = [];
        for (const r of Array.isArray(ranges) ? ranges : []) {
            const start = r ? +r.start_time : NaN;
            const end = r ? +r.end_time : NaN;
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) list.push({ start, end });
        }
        list.sort((a, b) => a.start - b.start);
        const sections = [];
        for (const { start, end } of list) {
            const members = notes.filter(n => n.t >= start - SECTION_EPS && n.t < end - SECTION_EPS);
            if (!members.length) continue;
            const section = {
                index: sections.length, start, end,
                first: members[0], last: members[members.length - 1], count: members.length,
            };
            for (const n of members) n[key] = section;
            sections.push(section);
        }
        return sections;
    }

    // ── Beats and measures (stand-in for YARG's SyncTrack, deviation 4) ─────────

    // A piecewise-linear, increasing map xs -> ys, extrapolated at the slope of the first / last interval.
    function linearMap(xs, ys) {
        const n = xs.length;
        const first = (ys[1] - ys[0]) / (xs[1] - xs[0]);
        const last = (ys[n - 1] - ys[n - 2]) / (xs[n - 1] - xs[n - 2]);
        function lookup(from, to, v, s0, s1) {
            if (v <= from[0]) return to[0] - (from[0] - v) * s0;
            if (v >= from[n - 1]) return to[n - 1] + (v - from[n - 1]) * s1;
            let lo = 0, hi = n - 1; // from[lo] <= v < from[hi]
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (from[mid] <= v) lo = mid; else hi = mid;
            }
            return to[lo] + (v - from[lo]) * (to[hi] - to[lo]) / (from[hi] - from[lo]);
        }
        return {
            fwd: (x) => lookup(xs, ys, x, first, last),
            inv: (y) => lookup(ys, xs, y, 1 / first, 1 / last),
        };
    }

    /**
     * chart.beats ([{time, measure}], measure >= 0 on downbeats) -> beat and measure positions.
     * Returns { beatAt(t), timeAtBeat(b), measureAt(t), timeAtMeasure(m) }.
     */
    function buildTempoMap(beats) {
        const raw = [];
        for (const b of Array.isArray(beats) ? beats : []) {
            const isObj = b !== null && typeof b === 'object';
            const t = isObj ? +(b.time !== undefined ? b.time : b.t) : +b;
            if (!Number.isFinite(t)) continue;
            raw.push({ t, down: isObj && b.measure !== null && b.measure !== undefined && +b.measure >= 0 });
        }
        raw.sort((a, b) => a.t - b.t);
        const list = raw.filter((b, i) => i === 0 || b.t > raw[i - 1].t);

        let beatMap, measureMap;
        if (list.length >= 2) {
            const times = list.map(b => b.t);
            beatMap = linearMap(times, times.map((_, i) => i));
            const downs = list.filter(b => b.down).map(b => b.t);
            measureMap = downs.length >= 2
                ? linearMap(downs, downs.map((_, i) => i))
                : linearMap(times, times.map((_, i) => i / 4));
        } else {
            // 120 BPM in 4/4: 2 beats and half a measure per second.
            beatMap = linearMap([0, 1], [0, 2]);
            measureMap = linearMap([0, 1], [0, 0.5]);
        }
        return { beatAt: beatMap.fwd, timeAtBeat: beatMap.inv, measureAt: measureMap.fwd, timeAtMeasure: measureMap.inv };
    }

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

        // Beats (sustain points, whammy) and measures (star power) from chart.beats (deviation 4).
        this._tempo = buildTempoMap(chart.beats);
        for (const note of this.notes) {
            note.beat = this._tempo.beatAt(note.t);
            note.end = note.t + note.len;
            note.endBeat = note.len > 0 ? this._tempo.beatAt(note.end) : note.beat;
            // ActiveSustain.GetEndTime(SustainBurstThreshold): at the note itself if it is too short.
            const burst = 1 / SUSTAIN_BURST_FRACTION;
            note.burstTime = note.endBeat - note.beat < burst ? note.t : this._tempo.timeAtBeat(note.endBeat - burst);
        }

        // Star power phrases and solos (GetSoloSections), deviation 6.
        this.phrases = buildSections(this.notes, chart.starPower, 'phrase');
        this.solos = buildSections(this.notes, chart.solos, 'solo');

        // SetInitialStats: BaseScore (CalculateChartScores), max solo bonus, star thresholds.
        this.baseScore = this._calculateBaseScore();
        this.maxSoloBonus = this.solos.reduce((sum, s) => sum + s.count * SOLO_POINTS_PER_NOTE, 0);
        this.starThresholds = populateStarScoreThresholds(this.params.starMultiplierThresholds,
            this.params.soloBonusStarMultiplierThresholds, this.baseScore, this.maxSoloBonus);

        // GuitarEngine constructor: leniency timers. BaseEngine.Generic: the star power whammy timer.
        this.strumLeniencyTimer = new EngineTimer(this.params.strumLeniency);
        this.hopoLeniencyTimer = new EngineTimer(this.params.hopoLeniency);
        this.whammyTimer = new EngineTimer(this.params.starPowerWhammyBuffer);
        this.strumLeniencyTimer.speed = this.params.songSpeed;
        this.hopoLeniencyTimer.speed = this.params.songSpeed;
        this.whammyTimer.speed = this.params.songSpeed;

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

    // Sustain points of a note held from its start to `beat` (CalculateSustainPoints, before rounding up).
    Engine.prototype._sustainPoints = function (note, beat) {
        const held = clamp(beat, note.beat, note.endBeat) - note.beat;
        return held * this.params.sustainPointsPerBeat;
    };
    // Math.Ceiling on sustain points, ignoring float noise from the seconds -> beats conversion.
    function ceilPoints(points) { return Math.ceil(points - BEAT_EPS); }

    // GuitarEngine.CalculateChartScores: a full combo with every sustain held and no star power.
    Engine.prototype._calculateBaseScore = function () {
        const p = this.params;
        let baseScore = 0;
        let combo = 0;
        for (const note of this.notes) {
            const multiplier = Math.min(Math.floor(combo / p.notesPerMultiplier) + 1, p.maxMultiplier);
            baseScore += multiplier * this._notePoints(note);
            baseScore += multiplier * ceilPoints(this._sustainPoints(note, note.endBeat));
            combo++;
        }
        return Math.round(baseScore);
    };

    // BaseEngine.Generic.PopulateStarScoreThresholds. YARG multiplies int by float in single precision.
    function populateStarScoreThresholds(multipliers, soloMultipliers, baseScore, soloScore) {
        return multipliers.map((m, i) => {
            const fromBase = Math.fround(baseScore * Math.fround(m));
            const fromSolo = Math.fround(soloScore * Math.fround(soloMultipliers[i] || 0));
            return Math.floor(Math.fround(fromBase + fromSolo));
        });
    }

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
        this.whammyTimer.reset();
        this.firstWhammyBeat = 0;
        // ActiveSustains: { note, finishedScoring, leniencyHeld, leniencyDropTime }
        this.activeSustains = [];
        this.currentBeat = -Infinity; // CurrentTick / LastTick, in beats
        this.lastBeat = -Infinity;

        // Star power, in measures (a full bar = params.starPowerMeasures).
        this.sp = { amount: 0, active: false, pos: 0, activationTime: 0, endPos: 0, endTime: 0 };
        this.activeSolo = null;
        this.starIndex = 0;

        // score = CommittedScore; getState().score adds pendingScore and soloBonuses (TotalScore).
        this.stats = {
            score: 0, noteScore: 0, pendingScore: 0, soloBonuses: 0, stars: 0,
            combo: 0, maxCombo: 0, multiplier: 1,
            notesHit: 0, notesMissed: 0, overstrums: 0, ghostInputs: 0,
        };

        for (const note of this.notes) {
            note.hit = false; note.missed = false; note.skipped = false;
            note.hitTime = null; note.offset = null;
            note.sp = note.phrase !== null; // StripStarPower clears it
        }
        for (const solo of this.solos) {
            solo.startNote = solo.first; // a seek may start a solo part-way (deviation 8)
            solo.total = solo.count;
            solo.hit = 0;
            solo.bonus = 0;
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
        this._mutateStateWithInput(t, action, value);
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
        // A solo under way at t starts at the first note left and counts only the notes left.
        for (const solo of this.solos) {
            if (solo.first.index < this.noteIndex && solo.last.index >= this.noteIndex) {
                solo.startNote = this.notes[this.noteIndex];
                solo.total = solo.last.index - this.noteIndex + 1;
            }
        }
        this._runEngineLoop(t);
    };

    Engine.prototype.getState = function () {
        const s = this.stats;
        const solo = this.activeSolo;
        return {
            score: this._totalScore(),
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
            starPower: { amount: this.sp.amount / this._fullBar(), active: this.sp.active },
            stars: s.stars,
            solo: solo ? { active: true, hit: solo.hit, total: solo.total } : { active: false, hit: 0, total: 0 },
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
        const p = this.params;
        for (const s of this.activeSustains) {
            if (s.leniencyHeld) consider(s.leniencyDropTime + p.sustainDropLeniency * p.songSpeed);
            consider(s.note.burstTime); // scoring finishes here
            consider(s.note.end);       // the sustain ends here
        }
        if (this.whammyTimer.active) consider(this.whammyTimer.endTime);
        if (this.sp.active) consider(this.sp.endTime);
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
        this.lastBeat = this.currentBeat;
        this.currentTime = time;
        this.currentBeat = this._tempo.beatAt(time);
        const cds = this.waitCountdowns;
        while (this.waitCountdownIndex < cds.length && time >= cds[this.waitCountdownIndex].end) {
            this.waitCountdownIndex++;
        }
        this.isWaitCountdownActive = this.waitCountdownIndex < cds.length &&
            time >= cds[this.waitCountdownIndex].start;
    };

    // ── Star power (BaseEngine.cs, BaseEngine.Generic.cs), in measures ──

    Engine.prototype._fullBar = function () { return this.params.starPowerMeasures; };
    Engine.prototype._halfBar = function () { return this.params.starPowerMeasures / 2; };
    Engine.prototype._quarterBar = function () { return this.params.starPowerMeasures / 4; };
    Engine.prototype._canStarPowerActivate = function () { return this.sp.amount >= this._halfBar() - SP_EPS; };

    // BaseEngine.Generic.UpdateStarPower: whammy gain, drain, release, activation.
    Engine.prototype._updateStarPower = function () {
        const sp = this.sp;
        if (this._isStarPowerSustainActive() && this.whammyTimer.active) {
            const gain = this._whammyGain(this.currentBeat, Math.max(this.lastBeat, this.firstWhammyBeat));
            if (!sp.active && sp.amount < this._halfBar() - SP_EPS && sp.amount + gain >= this._halfBar() - SP_EPS) {
                this._emit('sp-ready', { time: this.currentTime });
            }
            // Don't cap until the drain has been calculated.
            sp.amount += gain;
            if (sp.active) this._updateStarPowerEnds();
        }

        const previousPos = sp.pos;
        sp.pos = this._tempo.measureAt(this.currentTime);
        if (sp.active) {
            const drain = sp.pos - previousPos;
            sp.amount = sp.amount <= drain + SP_EPS ? 0 : sp.amount - drain;
        }

        // Limit the amount to a full bar.
        if (sp.amount > this._fullBar()) {
            sp.amount = this._fullBar();
            if (sp.active) this._updateStarPowerEnds();
        }

        if (sp.active && sp.amount === 0) this._releaseStarPower();
        if (this.isStarPowerInputActive && this._canStarPowerActivate()) this._activateStarPower();

        if (this.whammyTimer.active && this.whammyTimer.isExpired(this.currentTime)) this.whammyTimer.disable();
    };

    // CalculateStarPowerGain: (quarter ticks) x MAX_BEATS / (MAX_BEATS - 2) measure ticks, here in
    // measures: a full bar per MAX_BEATS - 2 = 30 beats of whammy.
    Engine.prototype._whammyGain = function (beat, lastBeat) {
        const maxBeats = this.params.starPowerMeasures * 4;
        const gainFactor = maxBeats / (maxBeats - 2); // - 2 for leniency
        return Math.max(0, beat - lastBeat) * gainFactor / MEASURE_RESOLUTION_SCALE;
    };

    // BaseEngine.Generic.IsStarPowerSustainActive
    Engine.prototype._isStarPowerSustainActive = function () {
        return this.activeSustains.some(s => s.note.sp);
    };

    // BaseEngine.Generic.StartWhammyTimer
    Engine.prototype._startWhammyTimer = function (time) {
        if (!this.whammyTimer.active) this.firstWhammyBeat = this._tempo.beatAt(time);
        this.whammyTimer.start(time);
    };

    // BaseEngine.UpdateStarPowerEnds
    Engine.prototype._updateStarPowerEnds = function () {
        const sp = this.sp;
        sp.endPos = sp.pos + sp.amount;
        sp.endTime = this._tempo.timeAtMeasure(sp.endPos);
    };

    // BaseEngine.GainStarPower
    Engine.prototype._gainStarPower = function (measures) {
        const sp = this.sp;
        const previous = sp.amount;
        if (!sp.active && previous < this._halfBar() - SP_EPS && previous + measures >= this._halfBar() - SP_EPS) {
            this._emit('sp-ready', { time: this.currentTime });
        }
        sp.amount = Math.min(this._fullBar(), sp.amount + measures);
        if (sp.active) this._updateStarPowerEnds();
    };

    // BaseEngine.ActivateStarPower (revives not ported)
    Engine.prototype._activateStarPower = function () {
        const sp = this.sp;
        if (sp.active) return;
        sp.activationTime = this.currentTime;
        this._updateStarPowerEnds();
        sp.active = true;
        this._updateMultiplier();
        this._emit('sp-activate', { time: this.currentTime, amount: sp.amount / this._fullBar(), endTime: sp.endTime });
    };

    // BaseEngine.ReleaseStarPower
    Engine.prototype._releaseStarPower = function () {
        this.sp.active = false;
        this._updateMultiplier();
        this._emit('sp-end', { time: this.currentTime });
    };

    // BaseEngine.Generic.AwardStarPower
    Engine.prototype._awardStarPower = function (note) {
        this._gainStarPower(this._quarterBar());
        this._emit('sp-phrase', {
            time: this.currentTime, index: note.srcIndex, phrase: note.phrase.index,
            amount: this.sp.amount / this._fullBar(),
        });
    };

    // BaseEngine.Generic.StripStarPower: the whole phrase loses its star power.
    Engine.prototype._stripStarPower = function (note) {
        if (!note || !note.sp) return;
        const phrase = note.phrase;
        for (let n = phrase.first; n; n = n.next) {
            n.sp = false;
            if (n === phrase.last) break;
        }
        this._emit('sp-phrase-miss', { time: this.currentTime, index: note.srcIndex, phrase: phrase.index });
    };

    // ── Sustains (BaseEngine.Generic.cs, GuitarEngine.cs) ──

    // BaseEngine.Generic.UpdateSustains: scoring, drops (with leniency), bursts and ends.
    Engine.prototype._updateSustains = function () {
        const p = this.params;
        const time = this.currentTime;
        let pending = 0;
        for (let i = 0; i < this.activeSustains.length; i++) {
            const sustain = this.activeSustains[i];
            const note = sustain.note;

            // Close enough to the end of the sustain: finish scoring it.
            const isBurst = time >= note.burstTime;
            const isEndOfSustain = time >= note.end;
            const scoreBeat = isBurst || isEndOfSustain ? note.endBeat : this.currentBeat;

            let dropped = false;
            if (!this._canSustainHold(note)) {
                if (sustain.leniencyHeld) {
                    // Held by the sustain drop leniency until it runs out.
                    if (time >= sustain.leniencyDropTime + p.sustainDropLeniency * p.songSpeed) dropped = true;
                } else {
                    sustain.leniencyHeld = true;
                    sustain.leniencyDropTime = time;
                }
            } else {
                sustain.leniencyHeld = false;
            }

            if (!sustain.finishedScoring) {
                if (isBurst || isEndOfSustain) sustain.finishedScoring = true;
                const points = ceilPoints(this._sustainPoints(note, scoreBeat));
                if (dropped || isBurst || isEndOfSustain) this._addScorePoints(points);
                else pending += points * this.stats.multiplier;
            }

            // Only removed when dropped or at its last moment.
            if (dropped || isEndOfSustain) {
                this._endSustain(i, dropped);
                i--;
            }
        }
        this.stats.pendingScore = pending;
        this._updateStars();
    };

    // BaseEngine.Generic.StartSustain
    Engine.prototype._startSustain = function (note) {
        this.activeSustains.push({ note, finishedScoring: false, leniencyHeld: false, leniencyDropTime: -9999 });
        this._emit('sustain-start', { time: this.currentTime, index: note.srcIndex, note: note.src });
    };

    // BaseEngine.Generic.EndSustain
    Engine.prototype._endSustain = function (i, dropped) {
        const sustain = this.activeSustains.splice(i, 1)[0];
        this._emitSustainEnd(sustain, dropped);
    };
    Engine.prototype._emitSustainEnd = function (sustain, dropped) {
        this._emit('sustain-end', {
            time: this.currentTime, index: sustain.note.srcIndex, note: sustain.note.src,
            finished: sustain.finishedScoring, dropped,
        });
    };

    // GuitarEngine.CanSustainHold (no disjoint or open-chord notes here)
    Engine.prototype._canSustainHold = function (note) {
        if (note.extended) {
            let buttons = this.effectiveButtonMask;
            if (note.mask & OPEN_MASK) buttons |= OPEN_MASK;
            return (note.mask & buttons) === note.mask;
        }
        return this._canNoteBeHit(note);
    };

    // ── Input (YargFiveFretGuitarEngine.MutateStateWithInput) ──

    Engine.prototype._mutateStateWithInput = function (time, action, value) {
        if (action === 'star_power') {
            // Activates in UpdateStarPower while held and the bar is at least half full.
            this.isStarPowerInputActive = !!value;
        } else if (action === 'whammy') {
            // Only a change of the whammy value is movement (deviation 5).
            const whammy = clamp(+value || 0, 0, 1);
            if (whammy !== this.whammy) {
                this.whammy = whammy;
                this._startWhammyTimer(time);
            }
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

    // Chords need exactly their frets, single notes YARG's anchoring; frets of extended sustains are
    // masked out first, as in CanNoteBeHit.
    Engine.prototype._gamepadMatches = function (note) {
        if (!isChord(note)) return this._canNoteBeHit(note);
        const held = this.effectiveButtonMask & FRET_MASK;
        return held === note.mask || (this._sustainMaskedButtons() & FRET_MASK) === note.mask;
    };

    // 'before' | 'in' | 'missed' (BaseEngine.Generic.IsNoteInWindow)
    Engine.prototype._windowState = function (note) {
        const time = this.currentTime;
        if (time < note.t + note.front) return 'before';
        if (time > note.t + note.back) return 'missed';
        return 'in';
    };
    Engine.prototype._isNoteInWindow = function (note) { return this._windowState(note) === 'in'; };

    // YargFiveFretGuitarEngine.CanNoteBeHit: try with the frets of extended sustains masked out first,
    // then with every held fret.
    Engine.prototype._canNoteBeHit = function (note) {
        if (this.activeSustains.length > 0) {
            let masked = this._sustainMaskedButtons();
            let buttons = this.effectiveButtonMask;
            // Nothing left: apply the open mask so open notes can be hit.
            if (masked === 0) {
                masked |= OPEN_MASK;
                buttons |= OPEN_MASK;
            }
            // Don't use the masked buttons if they are the same.
            if (masked !== buttons && this._isNoteHittable(note, masked)) return true;
        }
        return this._isNoteHittable(note, this.effectiveButtonMask);
    };

    // The held frets without the frets of extended sustains.
    Engine.prototype._sustainMaskedButtons = function () {
        let masked = this.effectiveButtonMask;
        for (const s of this.activeSustains) {
            if (s.note.extended) masked &= ~s.note.mask & 0xff;
        }
        return masked;
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
        // End active sustains that share a fret with this note (not scored further).
        for (let i = 0; i < this.activeSustains.length; i++) {
            if ((this.activeSustains[i].note.mask & note.mask) !== 0) {
                this._endSustain(i, true);
                i--;
            }
        }

        if (resolved(note)) return;
        note.hit = true;
        note.hitTime = this.currentTime;
        note.offset = this.currentTime - note.t;

        this._skipPreviousNotes(note);
        if (note.sp) {
            if (this.sp.active && this.params.noStarPowerOverlap) this._stripStarPower(note);
            else if (note === note.phrase.last) this._awardStarPower(note);
        }

        this._incrementCombo();
        this.stats.notesHit++;
        this._updateMultiplier();
        const points = this._addScore(note);
        if (note.len > 0) this._startSustain(note);

        this.wasNoteGhosted = false;
        this._emit('hit', {
            time: this.currentTime, index: note.srcIndex, note: note.src, noteTime: note.t,
            offset: note.offset, mask: note.mask & FRET_MASK, type: note.type, points,
            combo: this.stats.combo, multiplier: this.stats.multiplier, score: this._totalScore(),
        });
        this._handleSoloNote(note);
        this._advanceToNextNote();
    };

    // YargFiveFretGuitarEngine.MissNote -> GuitarEngine.MissNote -> BaseEngine.Generic.MissNote
    Engine.prototype._missNote = function (note) {
        this.hasTapped = false;
        if (resolved(note)) return;
        note.missed = true;
        if (note.sp) this._stripStarPower(note);
        this.wasNoteGhosted = false;
        this._resetCombo();
        this.stats.notesMissed++;
        this._updateMultiplier();
        this._emit('miss', { time: this.currentTime, index: note.srcIndex, note: note.src, noteTime: note.t });
        this._handleSoloNote(note);
        this._advanceToNextNote();
    };

    // ── Solos (BaseEngine.Generic.HandleSoloNote, StartSolo, EndSolo) ──

    Engine.prototype._handleSoloNote = function (note) {
        const solo = note.solo;
        if (!solo) return;
        if (note === solo.startNote) {
            this.activeSolo = solo;
            this._emit('solo-start', { time: this.currentTime, solo: solo.index, total: solo.total });
        }
        if (note.hit) solo.hit++;
        if (note === solo.last) this._endSolo(solo);
    };

    Engine.prototype._endSolo = function (solo) {
        if (this.activeSolo !== solo) return;
        const fraction = solo.hit / solo.total;
        let bonus = 0;
        if (fraction >= SOLO_MIN_PERCENT) {
            const multiplier = clamp((fraction - SOLO_MIN_PERCENT) / (1 - SOLO_MIN_PERCENT), 0, 1);
            const points = SOLO_POINTS_PER_NOTE * solo.hit * multiplier;
            // Round down to the nearest 50.
            bonus = points - (points % SOLO_ROUND_TO);
        }
        solo.bonus = bonus;
        this.stats.soloBonuses += bonus;
        this.activeSolo = null;
        this._emit('solo-end', {
            time: this.currentTime, solo: solo.index, hit: solo.hit, total: solo.total,
            percent: fraction * 100, bonus,
        });
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

        // Break all active sustains: their points so far are added without the multiplier, as YARG
        // does (unless already scored in full, deviation 10).
        const broken = this.activeSustains;
        this.activeSustains = [];
        for (const sustain of broken) {
            if (!sustain.finishedScoring) {
                this.stats.score += ceilPoints(this._sustainPoints(sustain.note, this.currentBeat));
            }
            this._emitSustainEnd(sustain, true);
        }
        this.stats.pendingScore = 0;

        // The current note's phrase fails, unless the note starts the phrase.
        if (this.noteIndex < this.notes.length) {
            const note = this.notes[this.noteIndex];
            if (note.sp && note !== note.phrase.first) this._stripStarPower(note);
        }

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

    // BaseEngine.UpdateMultiplier: doubled while star power is active (RebaseSustains: deviation 9).
    Engine.prototype._updateMultiplier = function () {
        const p = this.params;
        this.stats.multiplier = Math.min(Math.floor(this.stats.combo / p.notesPerMultiplier) + 1, p.maxMultiplier);
        if (this.sp.active) this.stats.multiplier *= 2;
    };

    // GuitarEngine.AddScore(note): 50 per note plus 50 per extra chord fret, times the multiplier.
    Engine.prototype._notePoints = function (note) {
        return this.params.pointsPerNote * Math.max(1, popcount(note.mask & FRET_MASK));
    };
    Engine.prototype._addScore = function (note) {
        const notePoints = this._notePoints(note);
        this.stats.noteScore += notePoints;
        return this._addScorePoints(notePoints);
    };

    // BaseEngine.Generic.AddScore(int): points times the multiplier, then UpdateStars.
    Engine.prototype._addScorePoints = function (points) {
        const scored = points * this.stats.multiplier;
        this.stats.score += scored;
        this._updateStars();
        return scored;
    };

    // BaseStats.TotalScore
    Engine.prototype._totalScore = function () {
        return this.stats.score + this.stats.pendingScore + this.stats.soloBonuses;
    };

    // BaseEngine.Generic.UpdateStars: thresholds passed plus the progress to the next one.
    Engine.prototype._updateStars = function () {
        const thresholds = this.starThresholds;
        const total = this._totalScore();
        while (this.starIndex < thresholds.length && total > thresholds[this.starIndex]) this.starIndex++;
        let progress = 0;
        if (this.starIndex < thresholds.length) {
            const previous = this.starIndex > 0 ? thresholds[this.starIndex - 1] : 0;
            const next = thresholds[this.starIndex];
            // YargMath.InverseLerpF
            progress = previous === next ? (total < previous ? 0 : 1) : (total - previous) / (next - previous);
        }
        this.stats.stars = this.starIndex + progress;
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
