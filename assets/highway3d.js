/*
 * highway3d.js: the tilted 3D 5-fret highway for the feedBack five-fret plugin (original code).
 * Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
 *
 * A Rock Band / YARG-style guitar track, built to match the feedBack drums plugin's drum highway
 * (behaviour and look only, written fresh; no artwork from those games): a scrolling textured track
 * with five coloured lanes (green / red / yellow / blue / orange, mirrored when lefty), fog, a rim
 * light, side rails with glow strips that light and pulse in star power, lane dividers and beat /
 * measure lines. At the strike line five rounded fret targets in the lane colours light up and grow
 * while their fret is held, and the lane behind them is tinted.
 *
 * Gems are bevelled rounded blocks with an additive glow: strums with a dark frame line and a lighter
 * top, HOPOs lower with a white top, taps dark with a lane-coloured top, open notes a purple bar across
 * the highway, and star power phrase gems in the star power colour. Sustain tails wobble with the whammy
 * while held, glow and throw sparks at the strike line while held (engine 'held'), and dim when dropped.
 *
 * Feedback comes from the session's engine events (frame.events, session.drainEvents()): a hit flashes
 * its lane(s) in the timing colour (green on time, blue early, orange late), throws a ring, a flare and
 * a spark burst that grows with the streak, and the hit gem carries on past the strike line white-hot and
 * fades out; a miss flashes its lane(s) red and the gem carries on red; an overstrum flashes the strike
 * line red; breaking a streak of 3+ washes the screen red. The 2D HUD canvas draws the star power meter
 * (READY / ACTIVE, pulsing), a big score, stars, accuracy, an early / late timing meter, the multiplier
 * ring with its progress arc, the NOTE STREAK, FULL COMBO, score pops, a combo ring every 10 notes,
 * bursts at 25 / 50 / every 100 and toasts (star power, phrases, solos), plus the header tag, AUTO CHART,
 * the solo percent and a status message. A band lane (frame.scoreHidden) keeps every highway effect,
 * the streak ring / bursts / break wash, the solo percent and the toasts, and leaves out the score
 * panels (meter, score, stars, accuracy, timing, multiplier, streak, score pops, header tag).
 *
 * Exported on window.FiveFretHighway3D (browser) and module.exports (Node tests):
 *   createView(THREE, canvas, { hudCanvas, context }) ->
 *     { render(frame), resize(w, h, dpr), destroy(), fxSnapshot() }
 *   plus the pure helpers HIT_FX, trailAlpha, trailZ, timingHex, sparkCount, multiplierColor, hudModel,
 *   hudLayout.
 * THREE is passed in (the renderer factory imports core's vendored three.module.min.js); `context` is
 * an optional WebGL2 context for `canvas`. The track maths lives in layout.js (loaded first:
 * window.FiveFretLayout, or require('./layout.js') in Node). Every mesh, pool and buffer is built once
 * and reused (instanced gems, tails, trails and beat lines, a 24-slot flash pool, a 480-point spark
 * pool, 12 score pops); render() makes no DOM queries and allocates nothing in the steady state.
 *
 * frame = { now, wallNow?, events?, notes, beats, starPower, solos, pressed: bool[5], whammy,
 *           noteState(i), state, lefty, header, sourceKind, lookahead?, message?, scoreHidden? }
 *   now: chart time in seconds; wallNow: wall clock in ms for the effects (default performance.now());
 *   events: this draw's session.drainEvents() ({ type, ... }: hit, miss, overstrum, combo-reset,
 *   sustain-start / -end, sp-*, solo-*); notes: wire notes { t, f, l?, h?, tap? } sorted by t;
 *   noteState(i): engine noteState ('held' while the sustain is active, 'hit', 'miss' or null);
 *   state: engine getState(); header: "PART · INPUT · DIFFICULTY";
 *   sourceKind 'auto' shows AUTO CHART; message (optional): a status line drawn over the highway;
 *   scoreHidden (a band lane): see above.
 */
(function (root, factory) {
    'use strict';
    const L = (typeof module === 'object' && module && module.exports)
        ? require('./layout.js')
        : (typeof window !== 'undefined' ? window.FiveFretLayout : root && root.FiveFretLayout);
    const api = factory(L);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (typeof window !== 'undefined' && window) window.FiveFretHighway3D = api;
    else if (typeof module !== 'object' && root) root.FiveFretHighway3D = api;
})(typeof self !== 'undefined' ? self : this, function (L) {
    'use strict';
    if (!L) throw new Error('highway3d.js needs layout.js (window.FiveFretLayout)');

    const TR = L.TRACK;
    const C = L.COLORS;
    const LANES = TR.lanes;
    const W = LANES * TR.laneWidth;
    const MAX_GEMS = 384;
    const MAX_OPEN = 64;
    const MAX_TAIL = 2048;
    const MAX_BEATS = 96;
    const MAX_SOLO = 4;
    const MAX_TRAIL = 96;
    const MAX_FLASH = 24;
    const MAX_SPARKS = 480;
    const POP_N = 12, BURST_N = 2, BURST_P = 36;
    const TIMING_N = 24;          // hits shown on the early / late meter
    const TIMING_RANGE = 100;     // ms at either end of the meter
    const MISS_DIM = 0.3;
    const DROPPED_DIM = 0.35;
    const TRACK_TEX_PERIOD = 1.4; // world units per repeat of the scrolling track texture
    const FONT = 'system-ui, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
    const EMPTY = Object.freeze([]);
    const TIMING_EARLY = '#66c7ff', TIMING_LATE = '#ff9a40', TIMING_OK = '#e5e7eb';

    // ── Hit / miss feedback (visual only: judgement and scoring stay in engine.js) ──
    const HIT_FX = Object.freeze({
        behind: 0.4,            // s a judged gem keeps travelling past the strike line while it fades
        missTint: 0xef4444,     // missed gems
        flashMs: 300,           // lane flash decay
        flashPeak: 0.65,        // lane flash opacity at the strike
        onTime: 0x22ff88,       // lane flash / spark colour by timing
        early: 0x35d6ff,
        late: 0xffb84d,
        wrong: 0xff4444,        // miss lane flash, overstrum strike-line flash
        onTimeMs: 25,           // |offset| within this counts as on time
        streakFull: 16,         // streak at which spark bursts reach full size
        popMs: 800, ringMs: 600, burstMs: 900, breakMs: 350, strikeMs: 280,
        toastMs: 1600, toastLongMs: 2600,
        sustainSparkMs: 45,     // a held sustain throws sparks this often
    });

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function cssHex(hex) { return '#' + (hex >>> 0).toString(16).padStart(6, '0'); }
    const CSS = Object.freeze({ text: cssHex(C.text), background: cssHex(C.background), solo: cssHex(C.solo) });
    function timingCss(ms) { return Math.abs(ms) <= HIT_FX.onTimeMs ? TIMING_OK : (ms < 0 ? TIMING_EARLY : TIMING_LATE); }
    function defaultNowMs() {
        return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
            ? performance.now() : Date.now();
    }

    /** Opacity of a judged gem `since` s past the strike line: 1 until the line, smooth fade to 0 at HIT_FX.behind. */
    function trailAlpha(since) {
        if (!(since > 0)) return 1;
        if (since >= HIT_FX.behind) return 0;
        const p = since / HIT_FX.behind;
        return 1 - p * p * (3 - 2 * p);
    }

    /**
     * Track z of a gem `since` s past the strike line at `speed` units/s (negative = still approaching).
     * Past the line it keeps its speed at first, then eases out so it reaches the back of the visible
     * track (TRACK.behind) as it finishes fading.
     */
    function trailZ(since, speed) {
        if (!(since > 0)) return since * speed;
        const zEnd = TR.behind;
        const k = Math.max(1, speed * HIT_FX.behind / zEnd);
        const p = Math.min(1, since / HIT_FX.behind);
        return zEnd * (1 - Math.pow(1 - p, k));
    }

    /** Lane flash / spark colour for a hit `offsetMs` from its note (+ = late). */
    function timingHex(offsetMs) {
        if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) <= HIT_FX.onTimeMs) return HIT_FX.onTime;
        return offsetMs < 0 ? HIT_FX.early : HIT_FX.late;
    }

    /** Sparks per fret in a hit burst: grows with the streak (fret 12 -> 24, open 24 -> 40). */
    function sparkCount(open, combo) {
        const f = Math.min(1, Math.max(0, combo | 0) / HIT_FX.streakFull);
        return open ? 24 + Math.round(16 * f) : 12 + Math.round(12 * f);
    }

    /** Multiplier ring colour: x1 grey, x2 yellow, x3 green, x4+ violet, star power cyan. */
    function multiplierColor(mult, spActive) {
        if (spActive) return '#7fe6ff';
        if (mult >= 4) return '#c77dff';
        if (mult === 3) return '#4be37a';
        if (mult === 2) return '#ffd23f';
        return '#c8ccd8';
    }

    /**
     * What the HUD shows, from engine getState() (null: zeros). `out` (optional) is filled in place.
     * { mult, multColor, multProgress (0..1 toward the next multiplier, 1 at the cap), combo, score,
     *   spAmount, spActive, spReady (half a bar, not active), stars, accuracy (0..1), fullCombo }
     */
    function hudModel(state, out) {
        const r = out || {};
        const s = state || {};
        const sp = s.starPower || {};
        const mult = s.multiplier > 0 ? s.multiplier | 0 : 1;
        const spActive = !!sp.active;
        const base = spActive ? Math.max(1, mult / 2) : mult;
        const maxBase = s.maxMultiplier > 0 ? s.maxMultiplier : 4;
        const combo = s.combo > 0 ? s.combo | 0 : 0;
        const hit = s.notesHit > 0 ? s.notesHit | 0 : 0;
        const missed = s.notesMissed > 0 ? s.notesMissed | 0 : 0;
        r.mult = mult;
        r.multColor = multiplierColor(mult, spActive);
        r.multProgress = base >= maxBase ? 1 : (combo % 10) / 10;
        r.combo = combo;
        r.score = s.score > 0 ? Math.floor(s.score) : 0;
        r.spAmount = clamp(+sp.amount || 0, 0, 1);
        r.spActive = spActive;
        r.spReady = !spActive && r.spAmount >= 0.5 - 1e-9;
        r.stars = Number.isFinite(+s.stars) ? +s.stars : 0;
        r.accuracy = hit + missed > 0 ? hit / (hit + missed) : 1;
        r.fullCombo = hit > 0 && missed === 0 && combo === hit;
        return r;
    }

    /**
     * HUD positions (CSS px) for a w x h canvas. opts = { scoreHidden, trackLeft, trackRight, strikeY }:
     * the track's screen edges and strike line height (from the camera). Wide (room beside the track):
     * the score column sits right of the track and the multiplier ring left of it, both by the strike
     * line, clear of the player chrome along the top. Narrow (band lanes, splitscreen): a compact score
     * column (no timing meter) in the bottom-right corner and the ring bottom-left. The header tag and
     * AUTO CHART stay bottom-left (a band lane, scoreHidden, drops the header tag). Pure: no DOM.
     */
    function hudLayout(w, h, opts) {
        opts = opts || {};
        w = w > 0 ? w : 1; h = h > 0 ? h : 1;
        const pad = 10;
        const top = 64;   // clear of the player chrome (title / tuning, time) along the top
        const s = clamp(Math.min(w, h * 1.6) / 1100, 0.55, 1.2);
        const tl = Number.isFinite(opts.trackLeft) ? opts.trackLeft : w * 0.3;
        const tr = Number.isFinite(opts.trackRight) ? opts.trackRight : w * 0.7;
        const strikeY = Number.isFinite(opts.strikeY) ? clamp(opts.strikeY, h * 0.4, h - 20) : h * 0.85;
        const colW = 190 * s, r = 34 * s;
        const wide = w - tr >= colW + 40 * s && tl >= 2 * r + 60 * s;
        const colH = (wide ? 190 : 136) * s;
        const colX = wide ? tr + 28 * s : w - pad - colW;
        const colY = wide ? clamp(strikeY - 175 * s, top, Math.max(top, h - pad - colH)) : Math.max(pad, h - pad - colH);
        const meterY = colY + 17 * s;
        const scoreY = meterY + 58 * s;
        const starsY = scoreY + 24 * s;
        const accY = starsY + 30 * s;
        const multX = wide ? tl - 28 * s - r : pad + r + 4;
        const multY = wide ? clamp(strikeY - 90 * s, top + 60 * s, h - pad - 70 * s)
            : Math.max(r + 46 * s + pad, h - pad - 44 - r - 20 * s);
        return {
            pad, scale: s, wide, compact: !wide, strikeY,
            showHeader: !opts.scoreHidden,
            header: { x: pad, y: h - pad },                       // baseline, left aligned
            auto: { x: pad, y: h - pad - 29 },                     // box top (13px tall) above the header
            autoSolo: { x: pad, y: h - pad - 13 },                 // ...and when no header is drawn
            col: { x: colX, y: colY, w: colW, h: colH },
            meterY, meterH: 14 * s, scoreY, starsY, accY,
            timingY: wide ? accY + 26 * s : null,                  // null: no timing meter (compact)
            mult: { x: multX, y: multY, r },
            streakY: multY - r - 28 * s, streakLabelY: multY - r - 12 * s, fullComboY: multY + r + 18 * s,
            toastY: Math.max(top + 24 * s, h * 0.2),
            soloY: h * 0.3,
            messageY: h * 0.45,
        };
    }

    // ── Textures and shapes ──

    function radialTexture(T, size, stops) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        for (const [o, col] of stops) grad.addColorStop(o, col);
        g.fillStyle = grad;
        g.fillRect(0, 0, size, size);
        const tex = new T.CanvasTexture(c);
        tex.colorSpace = T.SRGBColorSpace;
        return tex;
    }

    // A gaussian across the texture (u); with fadeEnds it also fades toward both ends (v).
    function gaussTexture(T, fadeEnds) {
        const w = 128, h = 64;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        const gx = g.createLinearGradient(0, 0, w, 0);
        for (let i = 0; i <= 10; i++) {
            const d = (i / 10 - 0.5) / 0.28;
            gx.addColorStop(i / 10, 'rgba(255,255,255,' + Math.exp(-0.5 * d * d).toFixed(3) + ')');
        }
        g.fillStyle = gx;
        g.fillRect(0, 0, w, h);
        if (fadeEnds) {
            g.globalCompositeOperation = 'destination-in';
            const gy = g.createLinearGradient(0, 0, 0, h);
            gy.addColorStop(0, 'rgba(255,255,255,0)');
            gy.addColorStop(0.3, 'rgba(255,255,255,1)');
            gy.addColorStop(0.7, 'rgba(255,255,255,1)');
            gy.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = gy;
            g.fillRect(0, 0, w, h);
        }
        const tex = new T.CanvasTexture(c);
        tex.colorSpace = T.SRGBColorSpace;
        return tex;
    }

    // The track: dark base, each lane faintly tinted in its fret colour, faint scanlines so it reads as
    // moving. Lane 0 (green) on the left; lefty mirrors the mesh.
    function trackTexture(T) {
        const w = 640, h = 64;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = cssHex(C.track);
        g.fillRect(0, 0, w, h);
        const edge = 0.07 / (W + 0.14);   // the track is a little wider than the lanes
        const x0 = w * edge, lw = (w - 2 * x0) / LANES;
        for (let i = 0; i < LANES; i++) {
            const col = C.frets[i];
            const r = (col >> 16) & 255, gg = (col >> 8) & 255, b = col & 255;
            const grad = g.createLinearGradient(x0 + i * lw, 0, x0 + (i + 1) * lw, 0);
            grad.addColorStop(0, 'rgba(' + r + ',' + gg + ',' + b + ',0.03)');
            grad.addColorStop(0.5, 'rgba(' + r + ',' + gg + ',' + b + ',0.11)');
            grad.addColorStop(1, 'rgba(' + r + ',' + gg + ',' + b + ',0.03)');
            g.fillStyle = grad;
            g.fillRect(x0 + i * lw, 0, lw, h);
        }
        g.fillStyle = 'rgba(255,255,255,0.03)';
        for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 2);
        const tex = new T.CanvasTexture(c);
        tex.colorSpace = T.SRGBColorSpace;
        tex.wrapS = T.ClampToEdgeWrapping;
        tex.wrapT = T.RepeatWrapping;
        tex.anisotropy = 4;
        return tex;
    }

    // A rounded-rectangle Shape (w x h, corner radius r) centred on the origin; with hw / hh / hr it gets
    // a centred rounded-rectangle hole (a frame).
    function roundedRect(T, w, h, r, hw, hh, hr) {
        const path = (P, w, h, r) => {
            const x = -w / 2, y = -h / 2;
            r = Math.min(r, w / 2, h / 2);
            P.moveTo(x + r, y);
            P.lineTo(x + w - r, y);
            P.quadraticCurveTo(x + w, y, x + w, y + r);
            P.lineTo(x + w, y + h - r);
            P.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
            P.lineTo(x + r, y + h);
            P.quadraticCurveTo(x, y + h, x, y + h - r);
            P.lineTo(x, y + r);
            P.quadraticCurveTo(x, y, x + r, y);
            return P;
        };
        const sh = path(new T.Shape(), w, h, r);
        if (hw > 0 && hh > 0) sh.holes.push(path(new T.Path(), hw, hh, hr));
        return sh;
    }

    // Per-instance opacity for an InstancedMesh material: reads the geometry's `instAlpha` instanced
    // attribute (the fading trail of judged gems).
    function instanceAlpha(mat) {
        mat.transparent = true;
        mat.depthWrite = false;
        mat.onBeforeCompile = (sh) => {
            sh.vertexShader = 'attribute float instAlpha;\nvarying float vInstAlpha;\n'
                + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvInstAlpha = instAlpha;');
            sh.fragmentShader = 'varying float vInstAlpha;\n'
                + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= vInstAlpha;');
        };
        mat.customProgramCacheKey = () => 'five-fret-inst-alpha';
        return mat;
    }

    // Pixel-store state survives on a context shared by successive renderers (same <canvas>).
    function resetPixelStore(gl) {
        try {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        } catch (_) { /* context lost */ }
    }

    function seededRandom(seed) {
        let x = seed >>> 0 || 1;
        return function () {
            x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
            return x / 4294967296;
        };
    }

    function starPath(ctx, cx, cy, r) {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
            const a = -Math.PI / 2 + i * Math.PI / 5;
            const rr = i % 2 === 0 ? r : r * 0.45;
            const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
    }

    function createView(T, canvas, opts) {
        if (!canvas || typeof canvas.getContext !== 'function') throw new Error('createView needs a canvas');
        opts = opts || {};
        const gl = opts.context || canvas.getContext('webgl2', { antialias: true, alpha: false });
        if (!gl) throw new Error('WebGL2 is not available');
        const renderer = new T.WebGLRenderer({ canvas, context: gl, antialias: true });
        renderer.setClearColor(C.background, 1);
        resetPixelStore(gl);
        const hud = opts.hudCanvas || null;
        const hctx = hud ? hud.getContext('2d') : null;

        const disposables = [];
        const own = (x) => { disposables.push(x); return x; };
        const instanced = [];

        const scene = new T.Scene();
        scene.background = new T.Color(C.background);
        scene.fog = new T.Fog(C.background, TR.length * 0.62, TR.length * 1.02);
        const camera = new T.PerspectiveCamera(50, 16 / 9, 0.1, 100);
        const CAM_POS = new T.Vector3(0, 3.1, 3.7);
        camera.position.copy(CAM_POS);
        camera.lookAt(0, 0, -4.8);
        const camDist = CAM_POS.length();

        scene.add(new T.AmbientLight(0xffffff, 1.0));
        const keyLight = new T.DirectionalLight(0xffffff, 2.3);
        keyLight.position.set(1, 6, 4);
        scene.add(keyLight);
        const rimLight = new T.DirectionalLight(0x9fc4ff, 0.9);
        rimLight.position.set(-3, 2, -6);
        scene.add(rimLight);

        const zSpan = TR.length + TR.behind;
        const zMid = (TR.behind - TR.length) / 2;
        const flatPlane = (w, d) => own(new T.PlaneGeometry(w || 1, d || 1).rotateX(-Math.PI / 2));

        const glowTex = own(radialTexture(T, 128, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]));
        const softTex = own(radialTexture(T, 64, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]));
        const ringTex = own(radialTexture(T, 128, [[0, 'rgba(255,255,255,0)'], [0.62, 'rgba(255,255,255,0)'], [0.78, 'rgba(255,255,255,1)'], [0.9, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']]));
        const flashTex = own(gaussTexture(T, true));
        const stripTex = own(gaussTexture(T, false));
        const trackTex = own(trackTexture(T));
        trackTex.repeat.set(1, zSpan / TRACK_TEX_PERIOD);

        const white = new T.Color(0xffffff);
        const tmp = new T.Color();
        const tmp2 = new T.Color();
        const laneCol = C.frets.map((h) => new T.Color(h));
        const openCol = new T.Color(C.open);
        const odCol = new T.Color(C.overdrive);
        const odGemCol = new T.Color(C.overdriveGem);
        const tapCol = new T.Color(0x15171f);
        const railCol = new T.Color(C.rail);
        const trackCol = new T.Color(C.track);
        const divCol = new T.Color(0x2f3a5c);
        const strikeCol = new T.Color(0xc9cfe6);
        const missCol = new T.Color(HIT_FX.missTint);
        const wrongCol = new T.Color(HIT_FX.wrong);

        // ── Track ──
        const trackGeo = flatPlane(W + 0.14, zSpan);
        const track = new T.Mesh(trackGeo, own(new T.MeshBasicMaterial({ map: trackTex })));
        track.position.set(0, -0.002, zMid);
        scene.add(track);

        const spWashMat = own(new T.MeshBasicMaterial({ color: C.overdrive, transparent: true, opacity: 0,
            blending: T.AdditiveBlending, depthWrite: false }));
        const spWash = new T.Mesh(trackGeo, spWashMat);
        spWash.position.set(0, 0.001, zMid);
        scene.add(spWash);

        const dividerMat = own(new T.MeshBasicMaterial({ color: divCol.getHex() }));
        const dividerGeo = own(new T.BoxGeometry(0.022, 0.01, zSpan));
        for (let i = 1; i < LANES; i++) {
            const d = new T.Mesh(dividerGeo, dividerMat);
            d.position.set((i - LANES / 2) * TR.laneWidth, 0.004, zMid);
            scene.add(d);
        }
        const railMat = own(new T.MeshBasicMaterial({ color: C.rail }));
        const railGeo = own(new T.BoxGeometry(0.07, 0.06, zSpan));
        const railGlowMat = own(new T.MeshBasicMaterial({ map: stripTex, color: C.overdrive, transparent: true,
            opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
        const railGlowGeo = flatPlane(0.7, zSpan);
        for (const sx of [-1, 1]) {
            const r = new T.Mesh(railGeo, railMat);
            r.position.set(sx * (W / 2 + 0.07), 0.03, zMid);
            scene.add(r);
            const g = new T.Mesh(railGlowGeo, railGlowMat);
            g.position.set(sx * (W / 2 + 0.07), 0.01, zMid);
            scene.add(g);
        }

        // ── Strike line: a bar with a soft glow (flashes red on an overstrum) ──
        const strikeMat = own(new T.MeshBasicMaterial({ color: strikeCol.getHex() }));
        const strike = new T.Mesh(own(new T.BoxGeometry(W + 0.16, 0.02, 0.05)), strikeMat);
        strike.position.set(0, 0.006, 0);
        scene.add(strike);
        const strikeGlowMat = own(new T.MeshBasicMaterial({ map: softTex, color: 0xffffff, transparent: true, opacity: 0.16,
            blending: T.AdditiveBlending, depthWrite: false }));
        const strikeGlow = new T.Mesh(flatPlane(W + 1.0, 0.8), strikeGlowMat);
        strikeGlow.position.set(0, 0.02, 0);
        strikeGlow.renderOrder = 6;
        scene.add(strikeGlow);

        // ── Fret targets (rounded frames over a translucent face), lane tints, lane flashes ──
        const targetRingGeo = own(new T.ExtrudeGeometry(roundedRect(T, 0.56, 0.32, 0.08, 0.44, 0.2, 0.05),
            { depth: 0.03, bevelEnabled: false, curveSegments: 6 }).rotateX(-Math.PI / 2));
        const targetDiscGeo = own(new T.ShapeGeometry(roundedRect(T, 0.46, 0.22, 0.05), 6).rotateX(-Math.PI / 2));
        const tintGeo = flatPlane(TR.laneWidth * 0.96, 3.2);
        const flashGeo = flatPlane(TR.laneWidth * 0.95, 1.4);
        const targets = [], tints = [], laneFlashes = [];
        for (let i = 0; i < LANES; i++) {
            const ringMat = own(new T.MeshBasicMaterial({ color: C.frets[i] }));
            const ring = new T.Mesh(targetRingGeo, ringMat);
            const discMat = own(new T.MeshBasicMaterial({ color: C.frets[i], transparent: true, opacity: 0.92, depthWrite: false }));
            const disc = new T.Mesh(targetDiscGeo, discMat);
            scene.add(ring, disc);
            targets.push({ ring, ringMat, disc, discMat, color: laneCol[i], hold: 0, pulse: -1e9 });
            const tm = own(new T.MeshBasicMaterial({ color: C.frets[i], transparent: true, opacity: 0,
                blending: T.AdditiveBlending, depthWrite: false }));
            const tint = new T.Mesh(tintGeo, tm);
            scene.add(tint);
            tints.push({ mesh: tint, mat: tm });
        }
        // Lane flashes: one per lane plus a full-width one for open notes; colour set per event.
        for (let i = 0; i <= LANES; i++) {
            const open = i === LANES;
            const m = own(new T.MeshBasicMaterial({ map: open ? softTex : flashTex, color: HIT_FX.onTime, transparent: true,
                opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
            const mesh = new T.Mesh(open ? flatPlane(W * 1.05, 1.1) : flashGeo, m);
            mesh.position.set(0, open ? 0.012 : 0.03, 0);
            mesh.renderOrder = 7;
            mesh.visible = false;
            scene.add(mesh);
            laneFlashes.push({ mesh, mat: m, wall: -1e9, hit: false, k: 0 });
        }

        let placedLefty = null;
        function placeLanes(lefty) {
            placedLefty = lefty;
            track.scale.x = lefty ? -1 : 1;   // the lane tints in the texture follow the frets
            for (let i = 0; i < LANES; i++) {
                const x = L.laneX(i, lefty);
                targets[i].ring.position.set(x, 0.012, 0);
                targets[i].disc.position.set(x, 0.03, 0);
                tints[i].mesh.position.set(x, 0.006, -1.6);
                laneFlashes[i].mesh.position.x = x;
            }
        }

        // ── Instanced meshes ──
        const dummy = new T.Object3D();
        function inst(geo, mat, n) {
            const m = new T.InstancedMesh(geo, mat, n);
            m.instanceMatrix.setUsage(T.DynamicDrawUsage);
            m.frustumCulled = false;
            for (let i = 0; i < n; i++) m.setColorAt(i, white);
            m.instanceColor.setUsage(T.DynamicDrawUsage);
            m.count = 0;
            scene.add(m);
            instanced.push(m);
            return m;
        }
        function place(m, idx, x, y, z, sx, sy, sz, color) {
            dummy.position.set(x, y, z);
            dummy.scale.set(sx, sy, sz);
            dummy.updateMatrix();
            m.setMatrixAt(idx, dummy.matrix);
            m.setColorAt(idx, color);
        }
        function finish(m, n) {
            m.count = n;
            m.instanceMatrix.needsUpdate = true;
            m.instanceColor.needsUpdate = true;
        }

        const beatMat = own(new T.MeshBasicMaterial({ color: 0x8890b8, transparent: true, opacity: 0.32, depthWrite: false }));
        const measureMat = own(new T.MeshBasicMaterial({ color: 0xc9d2ff, transparent: true, opacity: 0.7, depthWrite: false }));
        const beatLines = inst(own(new T.BoxGeometry(W, 0.004, 0.035)), beatMat, MAX_BEATS);
        const measureLines = inst(own(new T.BoxGeometry(W + 0.14, 0.006, 0.06)), measureMat, MAX_BEATS);

        const soloMat = own(new T.MeshBasicMaterial({ color: C.solo, transparent: true, opacity: 0.1,
            blending: T.AdditiveBlending, depthWrite: false }));
        const soloBands = inst(flatPlane(), soloMat, MAX_SOLO);
        const soloEdgeMat = own(new T.MeshBasicMaterial({ color: C.solo, transparent: true, opacity: 0.7, depthWrite: false }));
        const soloEdges = inst(own(new T.BoxGeometry(W + 0.14, 0.008, 0.05)), soloEdgeMat, MAX_SOLO * 2);

        // Sustain tails, and an additive glow strip under a held one.
        const tailMat = own(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
        const tails = inst(own(new T.BoxGeometry(1, 0.02, 1).translate(0, 0.012, 0)), tailMat, MAX_TAIL);
        tails.renderOrder = 1;
        const tailGlowMat = own(new T.MeshBasicMaterial({ map: stripTex, transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
        const tailGlow = inst(flatPlane(), tailGlowMat, MAX_TAIL / 2);
        tailGlow.renderOrder = 2;

        // Gems: a bevelled rounded block, a lighter inset top and a frame line between the two.
        const GEM_W = 0.5, GEM_D = 0.26, GEM_BEVEL = 0.03, GEM_H = 0.07 + 2 * GEM_BEVEL;
        const gemGeo = own(new T.ExtrudeGeometry(roundedRect(T, GEM_W - 2 * GEM_BEVEL, GEM_D - 2 * GEM_BEVEL, 0.06), {
            depth: GEM_H - 2 * GEM_BEVEL, bevelEnabled: true, bevelThickness: GEM_BEVEL, bevelSize: GEM_BEVEL,
            bevelSegments: 3, curveSegments: 6 }));
        gemGeo.rotateX(-Math.PI / 2).translate(0, GEM_BEVEL, 0);
        const capGeo = own(new T.ShapeGeometry(roundedRect(T, GEM_W - 0.13, GEM_D - 0.11, 0.045), 6));
        capGeo.rotateX(-Math.PI / 2).translate(0, GEM_H + 0.002, 0);
        const rimGeo = own(new T.ShapeGeometry(roundedRect(T, GEM_W - 0.08, GEM_D - 0.06, 0.06, GEM_W - 0.13, GEM_D - 0.11, 0.045), 6));
        rimGeo.rotateX(-Math.PI / 2).translate(0, GEM_H + 0.001, 0);
        // Open note: a bevelled bar across the highway with a light top line.
        const OPEN_D = 0.15, OPEN_H = 0.05 + 2 * GEM_BEVEL;
        const openGeo = own(new T.ExtrudeGeometry(roundedRect(T, W - 0.1 - 2 * GEM_BEVEL, OPEN_D - 2 * GEM_BEVEL, 0.04), {
            depth: OPEN_H - 2 * GEM_BEVEL, bevelEnabled: true, bevelThickness: GEM_BEVEL, bevelSize: GEM_BEVEL,
            bevelSegments: 2, curveSegments: 4 }));
        openGeo.rotateX(-Math.PI / 2).translate(0, GEM_BEVEL, 0);
        const openCapGeo = own(new T.ShapeGeometry(roundedRect(T, W - 0.3, 0.05, 0.025), 4));
        openCapGeo.rotateX(-Math.PI / 2).translate(0, OPEN_H + 0.002, 0);

        const solidMat = own(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28, metalness: 0.18 }));
        const capMat = own(new T.MeshBasicMaterial({ color: 0xffffff }));
        const glowMat = own(new T.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0.9,
            blending: T.AdditiveBlending, depthWrite: false }));
        const gemBody = inst(gemGeo, solidMat, MAX_GEMS);
        const gemCap = inst(capGeo, capMat, MAX_GEMS);
        const gemRim = inst(rimGeo, capMat, MAX_GEMS);
        const openBar = inst(openGeo, solidMat, MAX_OPEN);
        const openCap = inst(openCapGeo, capMat, MAX_OPEN);
        const gemGlow = inst(flatPlane(), glowMat, MAX_GEMS + MAX_OPEN + MAX_TRAIL);
        gemGlow.renderOrder = 4;

        // Judged gems past the strike line (the fading trail): white-hot hit and red miss materials and a
        // cap material, all with per-instance opacity. Each mesh has its own geometry copy for instAlpha.
        const trailHitMat = own(instanceAlpha(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.15,
            emissive: 0xffffff, emissiveIntensity: 0.35 })));
        const trailMissMat = own(instanceAlpha(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.1,
            emissive: HIT_FX.missTint, emissiveIntensity: 0.4 })));
        const trailCapMat = own(instanceAlpha(new T.MeshBasicMaterial({ color: 0xffffff })));
        const trailList = [];
        function trailInst(geo, mat, n, state, kind) {
            const g2 = own(geo.clone());
            const alpha = new Float32Array(n).fill(1);
            const attr = new T.InstancedBufferAttribute(alpha, 1);
            attr.setUsage(T.DynamicDrawUsage);
            g2.setAttribute('instAlpha', attr);
            const mesh = inst(g2, mat, n);
            const rec = { mesh, alpha, attr, z: new Float32Array(n), cap: n, n: 0, state, kind };
            trailList.push(rec);
            return rec;
        }
        const trail = {
            hitGem: trailInst(gemGeo, trailHitMat, MAX_TRAIL, 'hit', 'gem'),
            hitOpen: trailInst(openGeo, trailHitMat, 16, 'hit', 'open'),
            missGem: trailInst(gemGeo, trailMissMat, MAX_TRAIL, 'miss', 'gem'),
            missOpen: trailInst(openGeo, trailMissMat, 16, 'miss', 'open'),
            cap: trailInst(capGeo, trailCapMat, MAX_TRAIL * 2, null, 'cap'),
        };
        function placeTrail(rec, x, y, z, sx, sy, sz, color, alpha) {
            if (rec.n >= rec.cap) return;
            place(rec.mesh, rec.n, x, y, z, sx, sy, sz, color);
            rec.alpha[rec.n] = alpha;
            rec.z[rec.n] = z;
            rec.n++;
        }

        // ── Hit flashes (ring + flare pool) and sparks ──
        const flashQuad = flatPlane();
        const flashes = [];
        for (let i = 0; i < MAX_FLASH; i++) {
            const ringMat = own(new T.MeshBasicMaterial({ map: ringTex, transparent: true, opacity: 0,
                blending: T.AdditiveBlending, depthWrite: false }));
            const flareMat = own(new T.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0,
                blending: T.AdditiveBlending, depthWrite: false }));
            const ring = new T.Mesh(flashQuad, ringMat);
            const flare = new T.Mesh(flashQuad, flareMat);
            ring.visible = flare.visible = false;
            ring.renderOrder = flare.renderOrder = 8;
            scene.add(ring, flare);
            flashes.push({ ring, ringMat, flare, flareMat, born: -1e9, open: false, x: 0 });
        }
        let flashNext = 0;

        const sparkPos = new Float32Array(MAX_SPARKS * 3);
        const sparkCol = new Float32Array(MAX_SPARKS * 3);
        const sparkVel = new Float32Array(MAX_SPARKS * 3);
        const sparkOrigin = new Float32Array(MAX_SPARKS * 3);
        const sparkBase = new Float32Array(MAX_SPARKS * 3);
        const sparkBorn = new Float64Array(MAX_SPARKS).fill(-1e9);
        const sparkLife = new Float32Array(MAX_SPARKS);
        const sparkGeo = own(new T.BufferGeometry());
        sparkGeo.setAttribute('position', new T.BufferAttribute(sparkPos, 3).setUsage(T.DynamicDrawUsage));
        sparkGeo.setAttribute('color', new T.BufferAttribute(sparkCol, 3).setUsage(T.DynamicDrawUsage));
        const sparkMat = own(new T.PointsMaterial({ size: 0.09, map: softTex, vertexColors: true, transparent: true,
            blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
        const sparks = new T.Points(sparkGeo, sparkMat);
        sparks.frustumCulled = false;
        sparks.renderOrder = 9;
        scene.add(sparks);
        let sparkNext = 0;
        let sparksLive = 0, sparksBorn = 0, sustainSparks = 0;
        const rand = seededRandom(0x5eed);

        // ── Score FX (HUD): pooled "+points" pops, combo ring every 10, bursts at 25 / 50 / every 100,
        // a red wash when a streak of 3+ breaks, toasts.
        const pops = [];
        for (let i = 0; i < POP_N; i++) pops.push({ born: -1e9, x: 0, text: '', sp: false });
        let popNext = 0;
        const bursts = [];
        for (let i = 0; i < BURST_N; i++) {
            const b = { born: -1e9, vx: new Float32Array(BURST_P), vy: new Float32Array(BURST_P) };
            for (let j = 0; j < BURST_P; j++) {
                const a = (j / BURST_P) * Math.PI * 2, sp = 2 + (j % 5) * 0.8;
                b.vx[j] = Math.cos(a) * sp;
                b.vy[j] = Math.sin(a) * sp - 1.2;
            }
            bursts.push(b);
        }
        let burstNext = 0;
        let ringBorn = -1e9, ringHot = false, breakBorn = -1e9, strikeBorn = -1e9;
        const toast = { text: '', sub: '', color: '#8fe6ff', born: -1e9, long: false };
        const projV = new T.Vector3();

        // Early / late meter: the last TIMING_N hit offsets (ms, + = late) and their median.
        const timing = new Float32Array(TIMING_N), timingSorted = new Float32Array(TIMING_N);
        let timingCount = 0, timingNext = 0, timingVersion = 0, timingMedian = 0, timingMedianVersion = -1;
        let timingWord = '', timingWordMedian = NaN;
        function recordTiming(ms) {
            if (!Number.isFinite(ms)) return;
            timing[timingNext] = ms;
            timingNext = (timingNext + 1) % TIMING_N;
            if (timingCount < TIMING_N) timingCount++;
            timingVersion++;
        }
        function medianTiming() {
            if (timingMedianVersion === timingVersion) return timingMedian;
            timingMedianVersion = timingVersion;
            for (let i = 0; i < timingCount; i++) timingSorted[i] = timing[i];
            const sub = timingSorted.subarray(0, timingCount);
            sub.sort();
            const mid = timingCount >> 1;
            timingMedian = timingCount % 2 ? sub[mid] : (sub[mid - 1] + sub[mid]) / 2;
            return timingMedian;
        }

        // ── State ──
        let lastNotes = null, maxSustain = 0;
        function prepareNotes(notes) {
            lastNotes = notes;
            maxSustain = 0;
            for (let i = 0; i < notes.length; i++) {
                const l = +notes[i].l;
                if (l > maxSustain) maxSustain = l;
            }
        }
        const win = [0, 0];
        const seg = { n: 0, len: 0 };
        const starsOut = { full: 0, frac: 0, gold: false };
        const model = hudModel(null);
        let spActiveSince = -1e9, spEndedAt = -1e9, spIn = 0, railGlow = 0;
        let lastSustainSpark = -1e9, sparkChartNow = -Infinity, wallLast = 0, wallPrev = NaN;
        let heldMask = 0, heldOpen = false, heldSpMask = 0, heldGlowSegs = 0;
        let lastSpRanges = EMPTY;
        let cssW = 1, cssH = 1, dpr = 1;
        let destroyed = false;
        let lay = hudLayout(1, 1, {});
        let fonts = null, fontScale = -1;
        const hudText = { score: -1, scoreStr: '0', combo: -1, comboStr: '0', mult: -1, multStr: 'x1',
            accHit: -1, accMissed: -1, accStr: '', soloHit: NaN, soloTotal: NaN, soloPctStr: '', soloStr: '', header: null, headerStr: '' };
        const hudLast = { key: '', animating: true };
        let hudDrewScore = false;

        function laneX(b, lefty) { return L.laneX(b, lefty); }

        // A ring + flare at a lane (b = -1: open, across the highway) and `n` sparks of `sparkHex`.
        function spawnFlash(b, colorHex, wall, sparkHex, n, lefty) {
            const f = flashes[flashNext];
            flashNext = (flashNext + 1) % MAX_FLASH;
            f.born = wall;
            f.open = b < 0;
            f.x = f.open ? 0 : laneX(b, lefty);
            f.ringMat.color.setHex(colorHex);
            f.flareMat.color.setHex(colorHex);
            spawnSparks(f.x, f.open ? W : 0.22, sparkHex, n, wall, 1);
            return n;
        }
        function spawnSparks(x, spread, hex, n, wall, power) {
            const c = tmp2.setHex(hex);
            for (let k = 0; k < n; k++) {
                const i = sparkNext;
                sparkNext = (sparkNext + 1) % MAX_SPARKS;
                sparkOrigin[i * 3] = x + (rand() - 0.5) * spread;
                sparkOrigin[i * 3 + 1] = 0.1;
                sparkOrigin[i * 3 + 2] = (rand() - 0.5) * 0.12;
                const a = rand() * Math.PI * 2;
                const sp = (1.2 + rand() * 1.8) * power;
                sparkVel[i * 3] = Math.cos(a) * sp * 0.5;
                sparkVel[i * 3 + 1] = (1.8 + rand() * 2.8) * power;
                sparkVel[i * 3 + 2] = Math.sin(a) * sp * 0.4 + 0.5 * power;
                const mix = rand() * 0.6;
                sparkBase[i * 3] = c.r + (1 - c.r) * mix;
                sparkBase[i * 3 + 1] = c.g + (1 - c.g) * mix;
                sparkBase[i * 3 + 2] = c.b + (1 - c.b) * mix;
                sparkBorn[i] = wall;
                sparkLife[i] = (0.3 + rand() * 0.3) * (power < 1 ? 0.8 : 1);
            }
        }
        function flashLane(i, wall, hit, hex) {
            const fl = laneFlashes[i];
            fl.wall = wall; fl.hit = hit; fl.mat.color.setHex(hex);
        }
        function noteMask(ev) {
            if (Number.isFinite(ev.mask)) return ev.mask & L.FRET_MASK;
            return ev.note ? (ev.note.f | 0) & L.FRET_MASK : 0;
        }
        function isSpNote(ev, spRanges) {
            const t = ev.note ? +ev.note.t : +ev.noteTime;
            return Number.isFinite(t) && L.rangeIndexAt(spRanges, t) >= 0;
        }
        function showToast(text, sub, color, wall, long) {
            toast.text = text; toast.sub = sub || ''; toast.color = color; toast.born = wall; toast.long = !!long;
        }

        function handleEvents(events, wall, spRanges, lefty) {
            for (let e = 0; e < events.length; e++) {
                const ev = events[e];
                if (!ev) continue;
                switch (ev.type) {
                    case 'hit': {
                        const mask = noteMask(ev);
                        const sp = isSpNote(ev, spRanges);
                        const offMs = Number.isFinite(ev.offsetMs) ? ev.offsetMs
                            : (Number.isFinite(ev.offset) ? ev.offset * 1000 : NaN);
                        const th = timingHex(offMs);
                        const combo = ev.combo | 0;
                        let born = 0, sumX = 0, nl = 0;
                        if (mask === 0) {
                            born += spawnFlash(-1, sp ? C.overdrive : C.open, wall, th, sparkCount(true, combo), lefty);
                            flashLane(LANES, wall, true, th);
                        } else {
                            for (let b = 0; b < LANES; b++) {
                                if (!((mask >> b) & 1)) continue;
                                born += spawnFlash(b, sp ? C.overdrive : C.frets[b], wall, th, sparkCount(false, combo), lefty);
                                flashLane(b, wall, true, th);
                                targets[b].pulse = wall;
                                sumX += laneX(b, lefty); nl++;
                            }
                        }
                        sparksBorn = born;
                        recordTiming(offMs);
                        const pop = pops[popNext];
                        popNext = (popNext + 1) % POP_N;
                        pop.born = wall;
                        pop.x = nl ? sumX / nl : 0;
                        pop.sp = sp;
                        pop.text = '+' + (ev.points > 0 ? ev.points : 0);
                        if (combo > 0 && combo % 10 === 0) { ringBorn = wall; ringHot = combo >= 30; }
                        if (combo === 25 || combo === 50 || (combo > 0 && combo % 100 === 0)) {
                            bursts[burstNext].born = wall;
                            burstNext = (burstNext + 1) % BURST_N;
                        }
                        break;
                    }
                    case 'miss': {
                        const mask = noteMask(ev);
                        if (mask === 0) flashLane(LANES, wall, false, HIT_FX.wrong);
                        else for (let b = 0; b < LANES; b++) if ((mask >> b) & 1) flashLane(b, wall, false, HIT_FX.wrong);
                        break;
                    }
                    case 'overstrum':
                        strikeBorn = wall;
                        break;
                    case 'combo-reset':
                        if ((ev.combo | 0) >= 3) breakBorn = wall;
                        break;
                    case 'sustain-end': {
                        // A sustain held to the end: a last shower of sparks.
                        if (!ev.finished || ev.dropped) break;
                        const mask = noteMask(ev);
                        const hex = isSpNote(ev, spRanges) ? C.overdrive : 0;
                        if (mask === 0) spawnSparks(0, W, hex || C.open, 16, wall, 0.8);
                        else for (let b = 0; b < LANES; b++) if ((mask >> b) & 1) spawnSparks(laneX(b, lefty), 0.2, hex || C.frets[b], 10, wall, 0.8);
                        break;
                    }
                    case 'sp-phrase': showToast('PHRASE COMPLETE', '', '#dff3ff', wall); break;
                    case 'sp-ready': showToast('STAR POWER READY', '', '#8fe6ff', wall); break;
                    case 'sp-activate':
                        spActiveSince = wall;
                        showToast('STAR POWER!', '', '#8fe6ff', wall);
                        break;
                    case 'sp-end': spEndedAt = wall; break;
                    case 'solo-start': showToast('SOLO!', '', CSS.solo, wall); break;
                    case 'solo-end': {
                        const pct = Number.isFinite(+ev.percent) ? Math.round(+ev.percent) : 0;
                        const bonus = ev.bonus > 0 ? ev.bonus | 0 : 0;
                        showToast(pct >= 100 ? 'PERFECT SOLO!' : 'SOLO ' + pct + '%', bonus ? '+' + bonus + ' bonus' : '',
                            pct >= 100 ? '#ffc531' : CSS.solo, wall, true);
                        break;
                    }
                    default: break;
                }
            }
        }

        // A sustain tail from the gem (or the strike line, once hit) to its end. code: 0 unjudged, 1 hit
        // (a tail left = dropped), 2 miss, 3 held. Held tails glow and wobble with the whammy.
        function placeTail(note, mask, code, sp, now, speed, lefty, whammy, pulse, cnt) {
            const t = +note.t, len = +note.l;
            let zHead = L.noteZ(t, now, speed);
            let zEnd = L.noteZ(t + len, now, speed);
            const held = code === 3;
            if (held || code === 1) zHead = Math.min(zHead, 0);
            zHead = Math.min(zHead, TR.behind);
            zEnd = Math.max(zEnd, -TR.length);
            if (zHead - zEnd <= 0.01) return cnt;
            const dim = code === 2 ? MISS_DIM : (code === 1 ? DROPPED_DIM : 1);
            const wob = held ? whammy : 0;
            L.tailSegments(zHead - zEnd, seg);
            const open = mask === 0;
            for (let b = 0; b < LANES; b++) {
                if (!open && !((mask >> b) & 1)) continue;
                const baseX = open ? 0 : L.laneX(b, lefty);
                const width = open ? W * 0.8 : 0.11;
                const base = sp ? odCol : (open ? openCol : laneCol[b]);
                if (held) {
                    tmp.copy(base).lerp(white, 0.35 + 0.15 * pulse);
                    heldMask |= open ? 0 : (1 << b);
                    if (open) heldOpen = true;
                    if (sp) heldSpMask |= open ? 32 : (1 << b);
                } else if (code === 1) {
                    tmp.copy(base).lerp(trackCol, 0.5).multiplyScalar(dim);   // dropped: greyed out
                } else tmp.copy(base).multiplyScalar(dim);
                for (let k = 0; k < seg.n && cnt < MAX_TAIL; k++) {
                    const zc = zHead - (k + 0.5) * seg.len;
                    const x = baseX + L.wobbleX(zc, now, wob);
                    place(tails, cnt++, x, 0, zc, held ? width * 1.3 : width, 1, seg.len * 1.02, tmp);
                    if (held && heldGlowSegs < MAX_TAIL / 2) {
                        tmp2.copy(base).multiplyScalar(0.5 + 0.3 * pulse);
                        place(tailGlow, heldGlowSegs++, x, 0.015, zc, open ? W * 0.95 : 0.5, 1, seg.len * 1.02, tmp2);
                    }
                }
                if (open) break;
            }
            return cnt;
        }

        // A judged gem past (or, hit early, still before) the strike line: tinted, fading.
        function drawTrailGem(kind, mask, sp, hit, alpha, z, since, lefty, glowCnt) {
            const p = since > 0 ? Math.min(1, since / HIT_FX.behind) : 0;
            const grow = hit ? 1 + 0.25 * p : 1;
            if (kind === 'open') {
                const col = hit ? tmp.copy(sp ? odGemCol : openCol).lerp(white, 0.55) : missCol;
                placeTrail(hit ? trail.hitOpen : trail.missOpen, 0, 0, z, grow, 1, grow, col, alpha);
                if (hit && glowCnt < MAX_GEMS + MAX_OPEN + MAX_TRAIL) {
                    place(gemGlow, glowCnt++, 0, 0.01, z, W * 1.1 * grow, 1, 0.8 * grow,
                        tmp2.copy(sp ? odCol : openCol).multiplyScalar(0.8 * alpha));
                }
                return glowCnt;
            }
            const sy = kind === 'hopo' ? 0.72 : 1;
            for (let b = 0; b < LANES; b++) {
                if (!((mask >> b) & 1)) continue;
                const x = L.laneX(b, lefty);
                const lane = sp ? odGemCol : laneCol[b];
                const col = hit ? tmp.copy(lane).lerp(white, 0.5) : missCol;
                placeTrail(hit ? trail.hitGem : trail.missGem, x, 0, z, grow, sy, grow, col, alpha);
                placeTrail(trail.cap, x, 0, z, grow, sy, grow, hit ? white : tmp2.copy(missCol).lerp(white, 0.3), alpha);
                if (hit && glowCnt < MAX_GEMS + MAX_OPEN + MAX_TRAIL) {
                    const gs = 1.2 * (1 + 0.6 * p);
                    place(gemGlow, glowCnt++, x, 0.01, z, gs, 1, gs * 0.7, tmp2.copy(sp ? odCol : laneCol[b]).multiplyScalar(0.9 * alpha));
                }
            }
            return glowCnt;
        }

        function render(frame) {
            if (destroyed) return;
            frame = frame || {};
            const wall = Number.isFinite(frame.wallNow) ? frame.wallNow : defaultNowMs();
            let dtW = Number.isFinite(wallPrev) ? wall - wallPrev : 0;
            if (!(dtW >= 0) || dtW > 100) dtW = 100;
            wallPrev = wall;
            wallLast = wall;
            const now = Number.isFinite(frame.now) ? frame.now : 0;
            const look = frame.lookahead > 0 ? frame.lookahead : TR.lookahead;
            const speed = TR.length / look;
            const behindS = TR.behind / speed;
            const lefty = !!frame.lefty;
            if (lefty !== placedLefty) placeLanes(lefty);
            const notes = Array.isArray(frame.notes) ? frame.notes : EMPTY;
            if (notes !== lastNotes) prepareNotes(notes);
            const state = frame.state || null;
            hudModel(state, model);
            const spActive = model.spActive, spReady = model.spReady;
            const pressed = frame.pressed || EMPTY;
            const whammy = Number.isFinite(frame.whammy) ? frame.whammy : 0;
            const noteState = typeof frame.noteState === 'function' ? frame.noteState : null;
            const spRanges = Array.isArray(frame.starPower) ? frame.starPower : EMPTY;
            lastSpRanges = spRanges;
            const events = Array.isArray(frame.events) ? frame.events : EMPTY;
            if (events.length) handleEvents(events, wall, spRanges, lefty);

            // Track motion: the texture scrolls toward the camera at note speed.
            const scroll = (now * speed) / TRACK_TEX_PERIOD;
            trackTex.offset.y = scroll - Math.floor(scroll);

            // Star power: a pulsing blue wash, rails and dividers; the rails glow faintly when ready.
            const pulse = 0.5 + 0.5 * Math.sin(wall / 140);
            spIn = spActive ? clamp((wall - spActiveSince) / 250, 0, 1) : clamp(1 - (wall - spEndedAt) / 400, 0, 1);
            spWashMat.opacity = 0.14 * spIn + 0.06 * spIn * pulse;
            railGlow = spIn * (0.55 + 0.35 * pulse) + (spReady ? 0.16 + 0.12 * pulse : 0);
            railGlowMat.opacity = railGlow;
            railMat.color.copy(railCol).lerp(odCol, Math.max(spIn, spReady ? 0.35 : 0));
            dividerMat.color.copy(divCol).lerp(odCol, spIn * 0.6);

            // Beat and measure lines.
            const beats = Array.isArray(frame.beats) ? frame.beats : EMPTY;
            L.visibleWindow(beats, now, look, behindS, win, 'time');
            let nb = 0, nm = 0;
            for (let i = win[0]; i < win[1]; i++) {
                const z = L.noteZ(+beats[i].time, now, speed);
                if (L.isDownbeat(beats[i])) { if (nm < MAX_BEATS) place(measureLines, nm++, 0, 0.003, z, 1, 1, 1, white); }
                else if (nb < MAX_BEATS) place(beatLines, nb++, 0, 0.003, z, 1, 1, 1, white);
            }
            finish(beatLines, nb); finish(measureLines, nm);

            // Solo bands.
            let ns = 0, ne = 0;
            const solos = Array.isArray(frame.solos) ? frame.solos : EMPTY;
            for (let i = 0; i < solos.length && ns < MAX_SOLO; i++) {
                const s = +solos[i].start_time, e = +solos[i].end_time;
                if (!(e > now - behindS) || !(s < now + look)) continue;
                const zA = L.noteZ(Math.max(s, now - behindS), now, speed);
                const zB = L.noteZ(Math.min(e, now + look), now, speed);
                place(soloBands, ns++, 0, 0.002, (zA + zB) / 2, W + 0.14, 1, Math.max(0.01, zA - zB), white);
                if (s >= now - behindS) place(soloEdges, ne++, 0, 0.004, zA, 1, 1, 1, white);
                if (e <= now + look) place(soloEdges, ne++, 0, 0.004, zB, 1, 1, 1, white);
            }
            finish(soloBands, ns); finish(soloEdges, ne);

            // Notes: tails, gems, the judged-gem trail.
            let nt = 0, ng = 0, no = 0, nglow = 0;
            heldMask = 0; heldOpen = false; heldSpMask = 0; heldGlowSegs = 0;
            for (let i = 0; i < trailList.length; i++) trailList[i].n = 0;
            const tailPulse = 0.5 + 0.5 * Math.sin(wall / 70);
            L.visibleWindow(notes, now, look, Math.max(behindS, HIT_FX.behind) + maxSustain, win);
            // Far to near, so the additive glows layer sensibly.
            for (let i = win[1] - 1; i >= win[0]; i--) {
                const n = notes[i];
                const t = +n.t;
                const st = noteState ? noteState(i) : null;
                const code = st === 'hit' ? 1 : (st === 'miss' ? 2 : (st === 'held' ? 3 : 0));
                const kind = L.gemKind(n);
                const mask = kind === 'open' ? 0 : (n.f | 0) & L.FRET_MASK;
                const sp = L.rangeIndexAt(spRanges, t) >= 0;
                if (+n.l > 0) nt = placeTail(n, mask, code, sp, now, speed, lefty, whammy, tailPulse, nt);
                const since = now - t;
                if (code !== 0) {
                    const a = trailAlpha(since);
                    if (a > 0) nglow = drawTrailGem(kind, mask, sp, code !== 2, a, trailZ(since, speed), since, lefty, nglow);
                    continue;
                }
                if (since >= HIT_FX.behind) continue;
                const z = trailZ(since, speed);
                if (z < -TR.length) continue;
                const hopo = kind === 'hopo' || (kind === 'open' && !!n.h);
                if (kind === 'open') {
                    if (no >= MAX_OPEN) continue;
                    const sy = hopo ? 0.75 : 1;
                    place(openBar, no, 0, 0, z, 1, sy, 1, tmp.copy(sp ? odGemCol : openCol));
                    place(openCap, no, 0, 0, z, 1, sy, 1, hopo ? white : tmp.copy(sp ? white : openCol).lerp(white, 0.45));
                    no++;
                    if (nglow < MAX_GEMS + MAX_OPEN + MAX_TRAIL) {
                        place(gemGlow, nglow++, 0, 0.01, z, W * 1.05, 1, 0.55, tmp2.copy(sp ? odCol : openCol).multiplyScalar(hopo ? 0.75 : 0.5));
                    }
                    continue;
                }
                const sy = hopo ? 0.72 : 1;
                for (let b = 0; b < LANES; b++) {
                    if (!((mask >> b) & 1) || ng >= MAX_GEMS) continue;
                    const x = L.laneX(b, lefty);
                    const lane = laneCol[b];
                    const tap = kind === 'tap';
                    // Body: lane colour (star power: the SP gem colour); a tap is dark with a coloured top.
                    place(gemBody, ng, x, 0, z, 1, sy, 1, tap ? tapCol : (sp ? odGemCol : lane));
                    // Top: lighter lane colour (strum), white (HOPO), lane colour (tap).
                    if (hopo) tmp.copy(white);
                    else if (tap) tmp.copy(sp ? odGemCol : lane).lerp(white, 0.15);
                    else tmp.copy(sp ? white : lane).lerp(white, 0.3);
                    place(gemCap, ng, x, 0, z, 1, sy, 1, tmp);
                    // Frame line: dark (strum / HOPO), bright (tap), star power blue.
                    if (sp) tmp.copy(odCol);
                    else if (tap) tmp.copy(lane).lerp(white, 0.4);
                    else tmp.copy(lane).multiplyScalar(0.25);
                    place(gemRim, ng, x, 0, z, 1, sy, 1, tmp);
                    ng++;
                    if (nglow < MAX_GEMS + MAX_OPEN + MAX_TRAIL) {
                        const gk = sp ? 0.8 : (hopo ? 0.85 : (tap ? 0.7 : 0.55));
                        tmp2.copy(sp ? odCol : lane);
                        if (hopo) tmp2.lerp(white, 0.35);
                        place(gemGlow, nglow++, x, 0.01, z, hopo ? 1.05 : 0.95, 1, 0.6, tmp2.multiplyScalar(gk));
                    }
                }
            }
            finish(tails, nt); finish(tailGlow, heldGlowSegs);
            finish(gemBody, ng); finish(gemCap, ng); finish(gemRim, ng);
            finish(openBar, no); finish(openCap, no); finish(gemGlow, nglow);
            for (let i = 0; i < trailList.length; i++) {
                const r = trailList[i];
                r.mesh.visible = r.n > 0;
                finish(r.mesh, r.n);
                if (r.n) r.attr.needsUpdate = true;
            }

            // Held sustains throw sparks at the strike line (not while paused).
            const advancing = now > sparkChartNow;
            sparkChartNow = now;
            if ((heldMask || heldOpen) && advancing && wall - lastSustainSpark >= HIT_FX.sustainSparkMs) {
                lastSustainSpark = wall;
                if (heldOpen) { spawnSparks(0, W * 0.9, (heldSpMask & 32) ? C.overdrive : C.open, 4, wall, 0.55); sustainSparks += 4; }
                for (let b = 0; b < LANES; b++) {
                    if (!((heldMask >> b) & 1)) continue;
                    spawnSparks(L.laneX(b, lefty), 0.12, ((heldSpMask >> b) & 1) ? C.overdrive : C.frets[b], 2, wall, 0.55);
                    sustainSparks += 2;
                }
            }

            // Fret targets and lane tints: lit while the fret is held (or its sustain), pulse on a hit.
            const hk = 1 - Math.exp(-dtW / 40);
            for (let b = 0; b < LANES; b++) {
                const tg = targets[b];
                const down = !!pressed[b] || ((heldMask >> b) & 1) === 1;
                tg.hold += ((down ? 1 : 0) - tg.hold) * hk;
                if (tg.hold < 0.001) tg.hold = 0;
                const pk = clamp(1 - (wall - tg.pulse) / 160, 0, 1);
                const sc = 1 + 0.1 * tg.hold + 0.14 * pk;
                tg.ring.scale.set(sc, 1, sc);
                tg.disc.scale.set(sc, 1, sc);
                tg.ringMat.color.copy(tg.color).lerp(white, 0.2 * tg.hold + 0.55 * pk);
                tg.discMat.color.copy(trackCol).lerp(tg.color, 0.16 + 0.6 * tg.hold + 0.24 * pk);
                tints[b].mat.opacity = 0.1 * tg.hold + 0.14 * pk;
            }
            // Lane flashes (timing colour on a hit, red on a miss).
            for (let i = 0; i < laneFlashes.length; i++) {
                const fl = laneFlashes[i];
                const age = wall - fl.wall;
                fl.k = age >= 0 ? clamp(1 - age / HIT_FX.flashMs, 0, 1) : 0;
                fl.mat.opacity = HIT_FX.flashPeak * fl.k;
                fl.mesh.visible = fl.k > 0;
            }
            // Strike line: red on an overstrum, blue-tinted in star power.
            const sk = clamp(1 - (wall - strikeBorn) / HIT_FX.strikeMs, 0, 1);
            strikeMat.color.copy(strikeCol).lerp(odCol, 0.5 * spIn).lerp(wrongCol, sk);
            strikeGlowMat.color.copy(white).lerp(odCol, spIn).lerp(wrongCol, sk);
            strikeGlowMat.opacity = 0.16 + 0.12 * spIn + 0.6 * sk;

            // Ring + flare flashes.
            for (let i = 0; i < MAX_FLASH; i++) {
                const f = flashes[i];
                const age = (wall - f.born) / 1000;
                const life = f.open ? 0.32 : 0.36;
                if (age < 0 || age > life) { f.ring.visible = f.flare.visible = false; continue; }
                const p = age / life;
                f.flare.visible = true;
                if (f.open) {
                    f.ring.visible = false;
                    f.flare.position.set(0, 0.06, 0);
                    f.flare.scale.set(W + 1.2 + p * 1.0, 1, 1.0 + p * 1.2);
                    f.flareMat.opacity = 0.95 * (1 - p);
                } else {
                    f.ring.visible = true;
                    const rs = 0.6 + p * 1.0;
                    f.ring.position.set(f.x, 0.08, 0);
                    f.ring.scale.set(rs, 1, rs * 0.6);
                    f.ringMat.opacity = 0.95 * (1 - p);
                    const gs = 1.2 + p * 0.6;
                    f.flare.position.set(f.x, 0.09, 0);
                    f.flare.scale.set(gs, 1, gs * 0.65);
                    f.flareMat.opacity = (1 - p) * (1 - p);
                }
            }

            // Sparks.
            sparksLive = 0;
            for (let i = 0; i < MAX_SPARKS; i++) {
                const age = (wall - sparkBorn[i]) / 1000;
                const life = sparkLife[i];
                if (age < 0 || age > life) {
                    sparkCol[i * 3] = sparkCol[i * 3 + 1] = sparkCol[i * 3 + 2] = 0;
                    sparkPos[i * 3 + 1] = -5;
                    continue;
                }
                const k = 1 - age / life;
                sparksLive++;
                sparkPos[i * 3] = sparkOrigin[i * 3] + sparkVel[i * 3] * age;
                sparkPos[i * 3 + 1] = sparkOrigin[i * 3 + 1] + sparkVel[i * 3 + 1] * age - 9.0 * age * age;
                sparkPos[i * 3 + 2] = sparkOrigin[i * 3 + 2] + sparkVel[i * 3 + 2] * age;
                sparkCol[i * 3] = sparkBase[i * 3] * k;
                sparkCol[i * 3 + 1] = sparkBase[i * 3 + 1] * k;
                sparkCol[i * 3 + 2] = sparkBase[i * 3 + 2] * k;
            }
            sparkGeo.attributes.position.needsUpdate = true;
            sparkGeo.attributes.color.needsUpdate = true;

            renderer.render(scene, camera);
            drawHud(frame, state, wall);
        }

        // ── HUD ──
        const live = (born, ms, wall) => { const a = wall - born; return a >= 0 && a < ms; };
        function toastLife() { return toast.long ? HIT_FX.toastLongMs : HIT_FX.toastMs; }
        function anyFxLive(wall) {
            if (live(breakBorn, HIT_FX.breakMs, wall) || live(ringBorn, HIT_FX.ringMs, wall)) return true;
            if (live(toast.born, toastLife(), wall)) return true;
            for (let i = 0; i < BURST_N; i++) if (live(bursts[i].born, HIT_FX.burstMs, wall)) return true;
            for (let i = 0; i < POP_N; i++) if (live(pops[i].born, HIT_FX.popMs, wall)) return true;
            return false;
        }
        // Allocation-free projection into projV (css px in projV.x / projV.y); false when off-screen depth.
        function projectTo(x, y, z) {
            projV.set(x, y, z).project(camera);
            const ok = projV.z >= -1 && projV.z <= 1;
            projV.x = (projV.x + 1) / 2 * cssW;
            projV.y = (1 - projV.y) / 2 * cssH;
            return ok;
        }
        function buildFonts(s) {
            fontScale = s;
            const px = (n) => (Math.round(n * s * 10) / 10) + 'px ';
            fonts = {
                tag: '600 11px ' + FONT, auto: '700 9px ' + FONT, msg: '600 14px ' + FONT,
                label: '700 ' + px(11) + FONT, score: 'italic 800 ' + px(40) + FONT, acc: '600 ' + px(13) + FONT,
                timing: '800 ' + px(13) + FONT, small: '600 ' + px(10) + FONT, mult: 'italic 900 ' + px(28) + FONT,
                streak: '800 ' + px(30) + FONT, streakLabel: '700 ' + px(10) + FONT, pop: 'bold ' + px(15) + FONT,
                toast: 'italic 800 ' + px(26) + FONT, toastSub: '700 ' + px(15) + FONT, solo: '800 ' + px(30) + FONT,
            };
        }

        function drawHud(frame, state, wall) {
            if (!hctx || !hud) return;
            const m = model;
            const scoreHidden = frame.scoreHidden === true;
            const header = typeof frame.header === 'string' ? frame.header : '';
            const auto = frame.sourceKind === 'auto';
            const message = typeof frame.message === 'string' && frame.message ? frame.message : null;
            const solo = !!(state && state.solo && state.solo.active);
            const soloHit = solo ? state.solo.hit : 0, soloTotal = solo ? state.solo.total : 0;
            const animating = anyFxLive(wall) || ((m.spReady || m.spActive) && !scoreHidden);
            // Skip the redraw when nothing on the HUD changed and nothing animates (one frame more
            // after an animation ends, to clear it).
            if (!animating && !hudLast.animating && hudLast.hasState === !!state && hudLast.score === m.score
                && hudLast.combo === m.combo && hudLast.mult === m.mult && hudLast.sp === m.spAmount
                && hudLast.stars === m.stars && hudLast.timing === timingVersion && hudLast.scoreHidden === scoreHidden
                && hudLast.header === header && hudLast.auto === auto && hudLast.message === message
                && hudLast.solo === solo && hudLast.soloHit === soloHit && hudLast.soloTotal === soloTotal
                && hudLast.hit === (state ? state.notesHit : -1) && hudLast.missed === (state ? state.notesMissed : -1)
                && !hudLast.dirty) return;
            hudLast.animating = animating; hudLast.hasState = !!state; hudLast.score = m.score; hudLast.combo = m.combo;
            hudLast.mult = m.mult; hudLast.sp = m.spAmount; hudLast.stars = m.stars; hudLast.timing = timingVersion;
            hudLast.scoreHidden = scoreHidden; hudLast.header = header; hudLast.auto = auto; hudLast.message = message;
            hudLast.solo = solo; hudLast.soloHit = soloHit; hudLast.soloTotal = soloTotal;
            hudLast.hit = state ? state.notesHit : -1; hudLast.missed = state ? state.notesMissed : -1;
            hudLast.dirty = false;

            const ctx = hctx;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssW, cssH);
            const s = lay.scale;
            if (s !== fontScale) buildFonts(s);
            const F = fonts;
            const ht = hudText;
            ctx.textBaseline = 'alphabetic';
            ctx.shadowBlur = 0;

            // Streak-break wash (a band lane too).
            const breakAge = wall - breakBorn;
            if (breakAge >= 0 && breakAge < HIT_FX.breakMs) {
                ctx.globalAlpha = 0.12 * (1 - breakAge / HIT_FX.breakMs);
                ctx.fillStyle = '#ef4444';
                ctx.fillRect(0, 0, cssW, cssH);
                ctx.globalAlpha = 1;
            }

            // Header tag and AUTO CHART (bottom-left).
            if (ht.header !== header) { ht.header = header; ht.headerStr = header.toUpperCase(); }
            ctx.textAlign = 'left';
            const showHeader = !!header && !scoreHidden;
            if (showHeader) {
                ctx.font = F.tag;
                ctx.fillStyle = CSS.text;
                ctx.fillText(ht.headerStr, lay.header.x, lay.header.y);
            }
            if (auto) {
                ctx.font = F.auto;
                const tw = ctx.measureText('AUTO CHART').width;
                const y = showHeader ? lay.auto.y : lay.autoSolo.y;
                ctx.fillStyle = CSS.text;
                ctx.fillRect(lay.auto.x, y, tw + 10, 13);
                ctx.fillStyle = CSS.background;
                ctx.fillText('AUTO CHART', lay.auto.x + 5, y + 10);
            }

            hudDrewScore = false;
            if (!scoreHidden && state) {
                hudDrewScore = true;
                drawScoreColumn(ctx, wall, s);
                drawMultiplier(ctx, s);
            }
            drawScoreFx(ctx, wall, s, scoreHidden);

            // Solo: running percent.
            if (solo) {
                if (ht.soloHit !== soloHit || ht.soloTotal !== soloTotal) {
                    ht.soloHit = soloHit; ht.soloTotal = soloTotal;
                    ht.soloPctStr = L.soloPercent({ hit: soloHit, total: soloTotal }) + '%';
                    ht.soloStr = 'SOLO  ' + soloHit + ' / ' + soloTotal;
                }
                ctx.textAlign = 'center';
                ctx.fillStyle = CSS.solo;
                ctx.shadowColor = 'rgba(0,0,0,0.85)';
                ctx.shadowBlur = 8;
                ctx.font = F.solo;
                ctx.fillText(ht.soloPctStr, cssW / 2, lay.soloY);
                ctx.font = F.tag;
                ctx.fillText(ht.soloStr, cssW / 2, lay.soloY + 16);
                ctx.shadowBlur = 0;
            }

            // Status message, else a toast.
            if (message) {
                ctx.textAlign = 'center';
                ctx.font = F.msg;
                const tw = ctx.measureText(message).width;
                ctx.fillStyle = 'rgba(11,13,20,0.82)';
                ctx.fillRect(cssW / 2 - tw / 2 - 12, lay.messageY - 18, tw + 24, 28);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(message, cssW / 2, lay.messageY);
            } else if (live(toast.born, toastLife(), wall)) {
                const life = toastLife();
                ctx.globalAlpha = clamp(1 - (wall - toast.born - (life - 500)) / 500, 0, 1);
                ctx.textAlign = 'center';
                ctx.font = F.toast;
                ctx.shadowColor = toast.color;
                ctx.shadowBlur = 16;
                ctx.fillStyle = toast.color;
                ctx.fillText(toast.text, cssW / 2, lay.toastY);
                if (toast.sub) {
                    ctx.font = F.toastSub;
                    ctx.shadowBlur = 8;
                    ctx.fillText(toast.sub, cssW / 2, lay.toastY + 24 * s);
                }
                ctx.globalAlpha = 1;
                ctx.shadowBlur = 0;
            }
        }

        // Star power meter, score, stars, accuracy and (wide) the early / late meter.
        function drawScoreColumn(ctx, wall, s) {
            const m = model, ht = hudText, F = fonts;
            const x = lay.col.x, mw = lay.col.w, my = lay.meterY, mh = lay.meterH;
            ctx.textAlign = 'left';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 6;
            ctx.font = F.label;
            ctx.fillStyle = m.spActive ? '#8fe6ff' : (m.spReady ? '#bff0ff' : '#8a93b0');
            ctx.fillText(m.spActive ? 'STAR POWER ACTIVE' : (m.spReady ? 'STAR POWER READY' : 'STAR POWER'), x, my - 6 * s);
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(10,14,30,0.85)';
            ctx.fillRect(x, my, mw, mh);
            ctx.globalAlpha = m.spReady || m.spActive ? 0.75 + 0.25 * Math.sin(wall / 120) : 1;
            ctx.fillStyle = m.spActive ? '#8fe6ff' : '#5abeff';
            ctx.fillRect(x, my, mw * m.spAmount, mh);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = m.spReady || m.spActive ? '#bfefff' : '#3d4a70';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 0.5, my + 0.5, mw - 1, mh - 1);
            ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            ctx.beginPath();
            for (let q = 1; q < 4; q++) { const qx = x + mw * q / 4; ctx.moveTo(qx, my + 1); ctx.lineTo(qx, my + mh - 1); }
            ctx.stroke();

            if (ht.score !== m.score) { ht.score = m.score; ht.scoreStr = m.score.toLocaleString('en-US'); }
            ctx.shadowColor = 'rgba(0,0,0,0.85)';
            ctx.shadowBlur = 8;
            ctx.font = F.score;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(ht.scoreStr, x, lay.scoreY);
            ctx.shadowBlur = 0;

            L.starFill(m.stars, starsOut);
            const sr = 11 * s, sy = lay.starsY;
            for (let i = 0; i < 5; i++) {
                const cx = x + sr + i * sr * 2.3;
                starPath(ctx, cx, sy, sr);
                ctx.fillStyle = 'rgba(40,44,64,0.9)';
                ctx.fill();
                const fill = i < starsOut.full ? 1 : (i === starsOut.full ? starsOut.frac : 0);
                if (fill > 0) {
                    ctx.save();
                    ctx.clip();
                    ctx.fillStyle = starsOut.gold ? '#ffcf3a' : '#f4f6ff';
                    ctx.fillRect(cx - sr, sy + sr - 2 * sr * fill, 2 * sr, 2 * sr * fill);
                    ctx.restore();
                }
                starPath(ctx, cx, sy, sr);
                ctx.strokeStyle = starsOut.gold ? '#ffcf3a' : 'rgba(200,210,255,0.6)';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }

            const hit = hudLast.hit > 0 ? hudLast.hit : 0, missed = hudLast.missed > 0 ? hudLast.missed : 0;
            if (ht.accHit !== hit || ht.accMissed !== missed) {
                ht.accHit = hit; ht.accMissed = missed;
                ht.accStr = 'Accuracy ' + (model.accuracy * 100).toFixed(1) + '%   ' + hit + ' / ' + (hit + missed);
            }
            ctx.font = F.acc;
            ctx.fillStyle = '#c3cbe6';
            ctx.fillText(ht.accStr, x, lay.accY);

            if (lay.timingY === null) return;
            // Early / late meter: the last hits as ticks on a +-100 ms bar (blue early, orange late) and
            // their median.
            const ty = lay.timingY;
            ctx.font = F.label;
            ctx.fillStyle = '#7a84a6';
            if (!timingCount) { ctx.fillText('TIMING · waiting for hits', x, ty); return; }
            ctx.fillText('TIMING', x, ty);
            const med = medianTiming();
            if (med !== timingWordMedian) {
                timingWordMedian = med;
                timingWord = Math.abs(med) <= HIT_FX.onTimeMs ? 'ON TIME'
                    : (med > 0 ? '+' : '') + Math.round(med) + ' ms ' + (med < 0 ? 'EARLY' : 'LATE');
            }
            ctx.font = F.timing;
            ctx.fillStyle = timingCss(med);
            ctx.fillText(timingWord, x + 56 * s, ty);
            const bw = lay.col.w, bh = 10 * s, by = ty + 6 * s;
            ctx.fillStyle = 'rgba(10,14,30,0.85)';
            ctx.fillRect(x, by, bw, bh);
            ctx.fillStyle = 'rgba(160,170,200,0.5)';
            ctx.fillRect(x + bw / 2 - 0.5, by, 1, bh);
            for (let k = 0; k < timingCount; k++) {
                // oldest first: index from timingNext back
                const idx = (timingNext - timingCount + k + TIMING_N) % TIMING_N;
                const ms = timing[idx];
                ctx.globalAlpha = 0.25 + 0.75 * (k + 1) / timingCount;
                ctx.fillStyle = timingCss(ms);
                ctx.fillRect(x + bw / 2 + (bw / 2) * clamp(ms / TIMING_RANGE, -1, 1) - 1, by + 1, 2, bh - 2);
            }
            ctx.globalAlpha = 1;
            ctx.fillStyle = timingCss(med);
            ctx.fillRect(x + bw / 2 + (bw / 2) * clamp(med / TIMING_RANGE, -1, 1) - 1.5, by - 2 * s, 3, bh + 4 * s);
            ctx.font = F.small;
            ctx.fillStyle = TIMING_EARLY; ctx.fillText('early', x, by + bh + 11 * s);
            ctx.fillStyle = TIMING_LATE; ctx.textAlign = 'right'; ctx.fillText('late', x + bw, by + bh + 11 * s);
            ctx.textAlign = 'left';
        }

        // Multiplier ring with its progress arc, the note streak above it, FULL COMBO under it.
        function drawMultiplier(ctx, s) {
            const m = model, ht = hudText, F = fonts;
            const rx = lay.mult.x, ry = lay.mult.y, br = lay.mult.r;
            if (ht.mult !== m.mult) { ht.mult = m.mult; ht.multStr = 'x' + m.mult; }
            if (ht.combo !== m.combo) { ht.combo = m.combo; ht.comboStr = String(m.combo); }
            ctx.shadowBlur = 14;
            ctx.shadowColor = m.multColor;
            ctx.beginPath();
            ctx.arc(rx, ry, br, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(8,10,22,0.9)';
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.lineWidth = 4 * s;
            ctx.strokeStyle = 'rgba(70,80,110,0.8)';
            ctx.beginPath(); ctx.arc(rx, ry, br - 3 * s, 0, Math.PI * 2); ctx.stroke();
            ctx.strokeStyle = m.multColor;
            ctx.beginPath();
            ctx.arc(rx, ry, br - 3 * s, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * m.multProgress);
            ctx.stroke();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = F.mult;
            ctx.fillStyle = m.multColor;
            ctx.fillText(ht.multStr, rx, ry + 1);
            ctx.textBaseline = 'alphabetic';
            ctx.shadowColor = 'rgba(0,0,0,0.85)';
            ctx.shadowBlur = 8;
            ctx.font = F.streak;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(ht.comboStr, rx, lay.streakY);
            ctx.font = F.streakLabel;
            ctx.fillStyle = '#9aa4c4';
            ctx.fillText('NOTE STREAK', rx, lay.streakLabelY);
            if (m.fullCombo) {
                ctx.fillStyle = '#ffd23f';
                ctx.fillText('FULL COMBO', rx, lay.fullComboY);
            }
            ctx.shadowBlur = 0;
        }

        // Combo ring, milestone bursts (a band lane too) and "+points" pops (not in a band lane).
        function drawScoreFx(ctx, wall, s, scoreHidden) {
            const ringAge = wall - ringBorn;
            const ringLive = ringAge >= 0 && ringAge < HIT_FX.ringMs;
            let anyBurst = false;
            for (let i = 0; i < BURST_N; i++) if (live(bursts[i].born, HIT_FX.burstMs, wall)) anyBurst = true;
            if ((ringLive || anyBurst) && projectTo(0, 0.3, 0)) {
                const cx = projV.x, cy = projV.y;
                if (ringLive) {
                    const p = ringAge / HIT_FX.ringMs, ease = 1 - (1 - p) * (1 - p);
                    ctx.beginPath();
                    ctx.arc(cx, cy, 20 + ease * Math.min(cssW, cssH) * 0.28, 0, Math.PI * 2);
                    ctx.strokeStyle = ringHot ? '#fde047' : '#86efac';
                    ctx.globalAlpha = 0.6 * (1 - p);
                    ctx.lineWidth = 3;
                    ctx.stroke();
                }
                for (let i = 0; i < BURST_N; i++) {
                    const b = bursts[i];
                    const age = wall - b.born;
                    if (!(age >= 0 && age < HIT_FX.burstMs)) continue;
                    ctx.globalAlpha = 1 - age / HIT_FX.burstMs;
                    const f = age / (1000 / 60);
                    const fall = 0.04 * f * (f + 1);
                    for (let j = 0; j < BURST_P; j++) {
                        ctx.fillStyle = (j & 1) ? '#fde047' : '#86efac';
                        ctx.fillRect(cx + b.vx[j] * f * s - 2, cy + (b.vy[j] * f + fall) * s - 2, 4, 4);
                    }
                }
                ctx.globalAlpha = 1;
            }
            if (scoreHidden) return;
            let fontSet = false;
            for (let i = 0; i < POP_N; i++) {
                const pop = pops[i];
                const age = wall - pop.born;
                if (!(age >= 0 && age < HIT_FX.popMs)) continue;
                if (!projectTo(pop.x, 0.6, 0)) continue;
                if (!fontSet) {
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.font = fonts.pop;
                    ctx.lineWidth = 4;
                    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
                    fontSet = true;
                }
                const p = age / HIT_FX.popMs;
                const y = projV.y - p * 30 * s;
                ctx.globalAlpha = p < 0.4 ? 1 : 1 - (p - 0.4) / 0.6;
                ctx.strokeText(pop.text, projV.x, y);
                ctx.fillStyle = pop.sp ? '#8fe6ff' : '#86efac';
                ctx.fillText(pop.text, projV.x, y);
            }
            ctx.globalAlpha = 1;
            ctx.textBaseline = 'alphabetic';
        }

        // Camera: keep the strike line and its fret targets in view on narrow lanes; then the HUD
        // layout from the track's screen edges (the camera is fixed, so once per resize).
        function layoutCamera() {
            const aspect = cssW / Math.max(1, cssH);
            camera.aspect = aspect;
            const needHalfW = W / 2 + 0.35;
            const fovNeeded = 2 * Math.atan(needHalfW / (camDist * aspect)) * 180 / Math.PI;
            camera.fov = clamp(Math.max(50, fovNeeded), 50, 100);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld();
            projectTo(-W / 2 - 0.1, 0, 0);
            const tl = +projV.x, sy = +projV.y;
            projectTo(W / 2 + 0.1, 0, 0);
            const trx = +projV.x;
            lay = hudLayout(cssW, cssH, { trackLeft: tl, trackRight: trx, strikeY: sy });
        }

        function resize(w, h, pixelRatio) {
            if (destroyed || !(w > 0) || !(h > 0)) return;
            cssW = w; cssH = h;
            dpr = pixelRatio > 0 ? pixelRatio
                : (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
            renderer.setPixelRatio(dpr);
            renderer.setSize(w, h, false);
            if (hud) {
                hud.width = Math.round(w * dpr);
                hud.height = Math.round(h * dpr);
                hud.style.width = w + 'px';
                hud.style.height = h + 'px';
            }
            hudLast.dirty = true;
            layoutCamera();
        }

        function destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const d of disposables) { try { d.dispose(); } catch (_) { /* ignore */ } }
            for (const m of instanced) { try { m.dispose(); } catch (_) { /* ignore */ } }
            try { renderer.renderLists.dispose(); renderer.dispose(); } catch (_) { /* ignore */ }
            resetPixelStore(gl);   // the canvas (and its context) may be reused by the next renderer
            if (hctx && hud) { try { hctx.setTransform(1, 0, 0, 1, 0, 0); hctx.clearRect(0, 0, hud.width, hud.height); } catch (_) { /* ignore */ } }
        }

        /**
         * The effects of the last frame, for tests and debugging (allocates; not for the draw loop):
         * { trail: [{ state, kind, alpha, z }], sparksLive, sparksBorn, sustainSparks, flash: k per lane
         *   (5 frets + open), flashHit, strikeFlash, heldMask, heldOpen, tailGlow, targets: hold per fret,
         *   spIn, railGlow, pops, popPool, bursts, ring, breakWash, toast, timing: { count, median },
         *   hudScore (the score panels were drawn), layout }
         */
        function fxSnapshot() {
            const out = [];
            for (const r of trailList) {
                if (!r.state) continue;
                for (let i = 0; i < r.n; i++) out.push({ state: r.state, kind: r.kind, alpha: r.alpha[i], z: r.z[i] });
            }
            const w = wallLast;
            return {
                trail: out, sparksLive, sparksBorn, sustainSparks,
                flash: laneFlashes.map((f) => f.k), flashHit: laneFlashes.map((f) => f.k > 0 && f.hit),
                strikeFlash: clamp(1 - (w - strikeBorn) / HIT_FX.strikeMs, 0, 1),
                heldMask, heldOpen, tailGlow: heldGlowSegs, targets: targets.map((t) => t.hold),
                spIn, railGlow,
                pops: pops.filter((p) => live(p.born, HIT_FX.popMs, w)).length, popPool: POP_N,
                bursts: bursts.filter((b) => live(b.born, HIT_FX.burstMs, w)).length,
                ring: live(ringBorn, HIT_FX.ringMs, w), breakWash: live(breakBorn, HIT_FX.breakMs, w),
                toast: live(toast.born, toastLife(), w) ? toast.text : null,
                timing: { count: timingCount, median: timingCount ? medianTiming() : null },
                hudScore: hudDrewScore, layout: lay, spRanges: lastSpRanges.length,
            };
        }

        placeLanes(false);
        return { render, resize, destroy, dispose: destroy, fxSnapshot };
    }

    return {
        HIT_FX, trailAlpha, trailZ, timingHex, sparkCount, multiplierColor, hudModel, hudLayout,
        createView,
    };
});
