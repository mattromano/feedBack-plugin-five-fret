/*
 * layout.js: the pure maths of the tilted 5-fret highway (lane positions, note depth, gem kinds,
 * visible windows, tail wobble and HUD helpers) for the feedBack five-fret plugin. highway3d.js draws
 * with these; nothing here touches the DOM or WebGL, so it is unit-tested in Node.
 * Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
 *
 * World units: x across the highway (lane 0 = green on the left, mirrored when lefty), z along it with
 * the strike line at z = 0 and upcoming notes at negative z (away from the camera), y up.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (typeof window !== 'undefined' && window) window.FiveFretLayout = api;
    else if (typeof module !== 'object' && root) root.FiveFretLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const TRACK = Object.freeze({
        lanes: 5,
        laneWidth: 0.62,
        length: 14,          // highway length ahead of the strike line (world units)
        behind: 1.4,         // drawn past the strike line
        lookahead: 1.6,      // seconds of chart on the highway by default
        wobble: 0.045,       // tail wobble amplitude at full whammy
        maxTailSegments: 24, // per sustain tail
        tailSegment: 0.3,    // preferred segment length (world units)
    });

    const COLORS = Object.freeze({
        frets: Object.freeze([0x2ecc40, 0xe5322d, 0xf7d117, 0x2f7de1, 0xf28c28]),
        open: 0xb56cff,
        overdrive: 0x4aa8ff,
        overdriveGem: 0xdff1ff,
        background: 0x0b0d14,
        track: 0x1b2030,
        trackNear: 0x20263a,
        rail: 0x8a93b8,
        solo: 0x5fd3c6,
        text: 0xc9cfe6,
        meterBack: 0x2a3150,
        gold: 0xffc93c,
    });

    const FRET_MASK = 31;

    /** Centre x of a fret lane (0 green .. 4 orange); lefty mirrors. */
    function laneX(fretIndex, lefty) {
        const x = (fretIndex - (TRACK.lanes - 1) / 2) * TRACK.laneWidth;
        return lefty ? -x : x;
    }

    /** Depth of a chart time: 0 at the strike line, negative ahead (speed in world units per second). */
    function noteZ(t, now, speed) {
        return (now - t) * speed;
    }

    /** 'strum' | 'hopo' | 'tap' | 'open' for a wire note { t, f, h?, tap? }. */
    function gemKind(note) {
        if (!note || ((note.f | 0) & FRET_MASK) === 0) return 'open';
        if (note.tap) return 'tap';
        if (note.h) return 'hopo';
        return 'strum';
    }

    function lowerBound(list, x, key) {
        let lo = 0, hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (+list[mid][key] < x) lo = mid + 1; else hi = mid;
        }
        return lo;
    }
    function upperBound(list, x, key) {
        let lo = 0, hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (+list[mid][key] <= x) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    /**
     * Index range [i0, i1) of a time-sorted list whose times lie in [now - behind, now + ahead].
     * `out` (optional) is a reused 2-element array; `key` is the time field ('t' for notes, 'time' for beats).
     */
    function visibleWindow(list, now, ahead, behind, out, key) {
        const r = out || [0, 0];
        if (!Array.isArray(list) || !list.length) { r[0] = 0; r[1] = 0; return r; }
        const k = key || 't';
        r[0] = lowerBound(list, now - behind, k);
        r[1] = upperBound(list, now + ahead, k);
        if (r[1] < r[0]) r[1] = r[0];
        return r;
    }

    /** Index of the [{start_time, end_time}] range (sorted) holding t (start inclusive, end exclusive), or -1. */
    function rangeIndexAt(ranges, t) {
        if (!Array.isArray(ranges)) return -1;
        let lo = 0, hi = ranges.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (+ranges[mid].start_time <= t) lo = mid + 1; else hi = mid;
        }
        const i = lo - 1;
        return i >= 0 && t < +ranges[i].end_time ? i : -1;
    }

    /** A beat { time, measure } starts a measure when measure >= 0 (the bundle's beat format). */
    function isDownbeat(beat) {
        return !!beat && beat.measure !== null && beat.measure !== undefined && +beat.measure >= 0;
    }

    /** Sideways offset of a sustain tail at depth z while whammied (whammy 0..1). */
    function wobbleX(z, now, whammy) {
        const w = whammy > 1 ? 1 : (whammy > 0 ? whammy : 0);
        if (w === 0) return 0;
        return TRACK.wobble * w * Math.sin(z * 4.2 + now * 22);
    }

    /** Split a tail of length len (world units) into n equal segments of length len / n. */
    function tailSegments(len, out) {
        const r = out || { n: 0, len: 0 };
        if (!(len > 0)) { r.n = 0; r.len = 0; return r; }
        const n = Math.min(TRACK.maxTailSegments, Math.max(1, Math.ceil(len / TRACK.tailSegment)));
        r.n = n;
        r.len = len / n;
        return r;
    }

    /**
     * Whether a sustain is being held: every fret of its mask pressed (pressed: bool[5]); an open
     * sustain (mask 0) is held with no frets down.
     */
    function sustainHeld(mask, pressed) {
        const m = (mask | 0) & FRET_MASK;
        for (let i = 0; i < 5; i++) {
            const down = !!(pressed && pressed[i]);
            if (m === 0 ? down : ((m >> i) & 1) && !down) return false;
        }
        return true;
    }

    /** HUD stars from getState().stars (0..6, 6 = gold): whole stars, the next star's fraction, gold. */
    function starFill(stars, out) {
        const r = out || { full: 0, frac: 0, gold: false };
        const s = Number.isFinite(stars) && stars > 0 ? stars : 0;
        r.gold = s >= 6;
        r.full = Math.min(5, Math.floor(s));
        r.frac = s < 5 ? s - r.full : 0;
        return r;
    }

    /** Running percent of the solo being played (getState().solo). */
    function soloPercent(solo) {
        return solo && solo.total > 0 ? Math.floor((100 * solo.hit) / solo.total) : 0;
    }

    return {
        TRACK, COLORS, FRET_MASK,
        laneX, noteZ, gemKind, visibleWindow, rangeIndexAt, isDownbeat, wobbleX, tailSegments, sustainHeld,
        starFill, soloPercent,
    };
});
