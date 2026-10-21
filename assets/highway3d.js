/*
 * highway3d.js: the tilted 3D 5-fret highway for the feedBack five-fret plugin (original code).
 * Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
 *
 * A perspective guitar track in the classic tilted style of the plastic-guitar games: five lanes,
 * beat and measure lines, round gems in green / red / yellow / blue / orange (HOPOs with a white glow,
 * taps with a dark centre, open notes as a purple bar across the highway), sustain tails that wobble
 * while held (engine 'held') and whammied, star power phrases as white/blue gems and a blue highway while star power is on,
 * solo sections as a band, fret buttons at the strike line lit by the held frets, hit gems that flash
 * and vanish and missed gems that dim. A 2D HUD canvas shows the header tag, AUTO CHART, score,
 * multiplier, streak, the star power bar, stars and the solo percent. No artwork from those games.
 *
 * Exported on window.FiveFretHighway3D (browser) and module.exports (Node tests):
 *   createView(THREE, canvas, { hudCanvas, context }) -> { render(frame), resize(w, h, dpr), destroy() }
 * THREE is passed in (the renderer factory imports core's vendored three.module.min.js); `context` is
 * an optional WebGL2 context for `canvas`. All the maths lives in layout.js (loaded first:
 * window.FiveFretLayout, or require('./layout.js') in Node). Meshes are built once and reused
 * (instanced gems, tails, beat lines); render() makes no DOM queries.
 *
 * frame = { now, notes, beats, starPower, solos, pressed: bool[5], whammy, noteState(i), state,
 *           lefty, header, sourceKind, lookahead?, message?, scoreHidden? }
 *   now: chart time in seconds; notes: wire notes { t, f, l?, h?, tap? } sorted by t;
 *   noteState(i): engine noteState ('held' while the sustain is active, 'hit', 'miss' or null);
 *   state: engine getState(); header: "PART · INPUT · DIFFICULTY";
 *   sourceKind 'auto' shows AUTO CHART; message (optional): a status line drawn over the highway;
 *   scoreHidden (a band lane): no score, multiplier, streak, star power bar or stars on the HUD.
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
    const W = TR.lanes * TR.laneWidth;
    const MAX_GEMS = 384;
    const MAX_OPEN = 64;
    const MAX_TAIL = 2048;
    const MAX_BEATS = 96;
    const MAX_SOLO = 4;
    const FLASH_S = 0.18;
    const MISS_DIM = 0.3;
    const DROPPED_DIM = 0.45;
    const FONT = 'system-ui, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
    const F_TAG = '600 11px ' + FONT, F_AUTO = '700 9px ' + FONT, F_SCORE = '700 20px ' + FONT;
    const F_SMALL = '600 12px ' + FONT, F_SOLO = '700 22px ' + FONT, F_MSG = '600 14px ' + FONT;
    const EMPTY = Object.freeze([]);
    const SP_FADE_S = 0.1;           // star power wash fade time constant (seconds of chart time)

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function cssHex(hex) { return '#' + (hex >>> 0).toString(16).padStart(6, '0'); }

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

    // Pixel-store state survives on a context shared by successive renderers (same <canvas>).
    function resetPixelStore(gl) {
        try {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        } catch (_) { /* context lost */ }
    }

    function drawStar(ctx, cx, cy, r) {
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
        scene.fog = new T.Fog(C.background, TR.length * 0.72, TR.length * 1.02);
        const camera = new T.PerspectiveCamera(50, 16 / 9, 0.1, 100);
        const CAM_POS = new T.Vector3(0, 3.1, 3.7);
        camera.position.copy(CAM_POS);
        camera.lookAt(0, 0, -4.8);
        const camDist = CAM_POS.length();

        scene.add(new T.AmbientLight(0xffffff, 1.0));
        const keyLight = new T.DirectionalLight(0xffffff, 2.2);
        keyLight.position.set(1, 6, 4);
        scene.add(keyLight);

        const zSpan = TR.length + TR.behind;
        const zMid = (TR.behind - TR.length) / 2;
        const flatPlane = () => own(new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));

        const glowTex = own(radialTexture(T, 128, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]));

        // ── Highway (static) ──
        const trackGeo = own(new T.PlaneGeometry(W + 0.14, zSpan).rotateX(-Math.PI / 2));
        {
            // vertex colours: darker far end, lighter near the strike line
            const far = new T.Color(C.track), near = new T.Color(C.trackNear);
            const pos = trackGeo.attributes.position;
            const col = new Float32Array(pos.count * 3);
            for (let i = 0; i < pos.count; i++) {
                const c = pos.getZ(i) < 0 ? far : near;
                col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
            }
            trackGeo.setAttribute('color', new T.BufferAttribute(col, 3));
        }
        const track = new T.Mesh(trackGeo, own(new T.MeshBasicMaterial({ vertexColors: true })));
        track.position.set(0, -0.002, zMid);
        scene.add(track);

        const spWashMat = own(new T.MeshBasicMaterial({ color: C.overdrive, transparent: true, opacity: 0,
            blending: T.AdditiveBlending, depthWrite: false }));
        const spWash = new T.Mesh(trackGeo, spWashMat);
        spWash.position.set(0, 0.001, zMid);
        scene.add(spWash);

        const dividerMat = own(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, depthWrite: false }));
        const dividerGeo = own(new T.BoxGeometry(0.02, 0.004, zSpan));
        for (let i = 1; i < TR.lanes; i++) {
            const d = new T.Mesh(dividerGeo, dividerMat);
            d.position.set((i - TR.lanes / 2) * TR.laneWidth, 0.003, zMid);
            scene.add(d);
        }
        const railMat = own(new T.MeshBasicMaterial({ color: C.rail }));
        const railGeo = own(new T.BoxGeometry(0.06, 0.05, zSpan));
        for (const sx of [-1, 1]) {
            const r = new T.Mesh(railGeo, railMat);
            r.position.set(sx * (W / 2 + 0.07), 0.025, zMid);
            scene.add(r);
        }
        const strikeMat = own(new T.MeshBasicMaterial({ color: C.text, transparent: true, opacity: 0.45, depthWrite: false }));
        const strike = new T.Mesh(own(new T.BoxGeometry(W + 0.14, 0.01, 0.05)), strikeMat);
        strike.position.set(0, 0.004, 0);
        scene.add(strike);

        // ── Fret buttons at the strike line (one per lane, positions follow lefty) ──
        const ringGeo = own(new T.TorusGeometry(0.25, 0.045, 10, 40).rotateX(-Math.PI / 2));
        const innerGeo = own(new T.CylinderGeometry(0.21, 0.21, 0.03, 32));
        const flashGeo = flatPlane();
        const buttons = [];
        for (let i = 0; i < TR.lanes; i++) {
            const color = new T.Color(C.frets[i]);
            const ringMat = own(new T.MeshStandardMaterial({ color: C.frets[i], roughness: 0.4, metalness: 0.2 }));
            const ring = new T.Mesh(ringGeo, ringMat);
            const innerMat = own(new T.MeshBasicMaterial({ color: C.background }));
            const inner = new T.Mesh(innerGeo, innerMat);
            scene.add(ring, inner);
            buttons.push({ ring, inner, innerMat, color });
        }
        // Hit flashes: one glow per lane plus a full-width one for open notes.
        const flashes = [];
        for (let i = 0; i <= TR.lanes; i++) {
            const open = i === TR.lanes;
            const mat = own(new T.MeshBasicMaterial({ map: glowTex, color: open ? C.open : C.frets[i], transparent: true,
                opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
            const mesh = new T.Mesh(flashGeo, mat);
            mesh.position.set(0, 0.06, 0);
            mesh.scale.set(open ? W * 1.1 : 0.9, 1, open ? 0.7 : 0.9);
            mesh.visible = false;
            mesh.renderOrder = 5;
            scene.add(mesh);
            flashes.push({ mesh, mat, open });
        }
        const flashAt = new Float64Array(TR.lanes + 1).fill(-1e9);

        let placedLefty = null;
        function placeButtons(lefty) {
            placedLefty = lefty;
            for (let i = 0; i < TR.lanes; i++) {
                const x = L.laneX(i, lefty);
                buttons[i].ring.position.set(x, 0.04, 0);
                buttons[i].inner.position.set(x, 0.03, 0);
                flashes[i].mesh.position.x = x;
            }
        }

        // ── Instanced meshes ──
        const dummy = new T.Object3D();
        const tmp = new T.Color();
        const white = new T.Color(0xffffff);
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

        const beatMat = own(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13, depthWrite: false }));
        const measureMat = own(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }));
        const beatLines = inst(own(new T.BoxGeometry(W, 0.004, 0.03)), beatMat, MAX_BEATS);
        const measureLines = inst(own(new T.BoxGeometry(W + 0.14, 0.006, 0.06)), measureMat, MAX_BEATS);

        const soloMat = own(new T.MeshBasicMaterial({ color: C.solo, transparent: true, opacity: 0.1,
            blending: T.AdditiveBlending, depthWrite: false }));
        const soloBands = inst(flatPlane(), soloMat, MAX_SOLO);
        const soloEdgeMat = own(new T.MeshBasicMaterial({ color: C.solo, transparent: true, opacity: 0.7, depthWrite: false }));
        const soloEdges = inst(own(new T.BoxGeometry(W + 0.14, 0.008, 0.05)), soloEdgeMat, MAX_SOLO * 2);

        const tailMat = own(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.88, depthWrite: false }));
        const tails = inst(own(new T.BoxGeometry(1, 0.02, 1).translate(0, 0.012, 0)), tailMat, MAX_TAIL);

        const gemMat = own(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.1 }));
        const flatMat = own(new T.MeshBasicMaterial({ color: 0xffffff }));
        const glowMat = own(new T.MeshBasicMaterial({ map: glowTex, transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
        const gemBody = inst(own(new T.CylinderGeometry(0.22, 0.24, 0.09, 28).translate(0, 0.045, 0)), gemMat, MAX_GEMS);
        const gemRim = inst(own(new T.TorusGeometry(0.235, 0.03, 8, 32).rotateX(-Math.PI / 2).translate(0, 0.09, 0)), flatMat, MAX_GEMS);
        const gemCap = inst(own(new T.CylinderGeometry(0.12, 0.12, 0.02, 24).translate(0, 0.095, 0)), flatMat, MAX_GEMS);
        const gemGlow = inst(flatPlane(), glowMat, MAX_GEMS + MAX_OPEN);
        const openBar = inst(own(new T.BoxGeometry(1, 0.05, 0.12).translate(0, 0.03, 0)), gemMat, MAX_OPEN);
        gemGlow.renderOrder = 4;
        tails.renderOrder = 1;

        // Per-note memory (rebuilt only when the notes array changes): last judged state, for hit flashes.
        let lastNotes = null;
        // State codes: 0 unjudged, 1 hit, 2 miss, 3 held (sustain active).
        let prevState = new Uint8Array(0);
        let tracking = false;   // false until one frame has recorded states (no flashes for old hits)
        let maxSustain = 0;
        function prepareNotes(notes) {
            lastNotes = notes;
            tracking = false;
            prevState = new Uint8Array(notes.length);
            maxSustain = 0;
            for (let i = 0; i < notes.length; i++) {
                const l = +notes[i].l;
                if (l > maxSustain) maxSustain = l;
            }
        }

        const win = [0, 0];
        const seg = { n: 0, len: 0 };
        const stars = { full: 0, frac: 0, gold: false };
        const laneCol = C.frets.map(h => new T.Color(h));
        const openCol = new T.Color(C.open);
        const odCol = new T.Color(C.overdrive);
        const odGemCol = new T.Color(C.overdriveGem);
        const rimCol = new T.Color(0xd8dce8);
        const tapCol = new T.Color(0x15171f);
        const railCol = new T.Color(C.rail);
        let spIn = 0;
        let lastNow = NaN;
        // HUD colours and text, built once / when their values change.
        const CSS = { text: cssHex(C.text), background: cssHex(C.background), meterBack: cssHex(C.meterBack),
            overdrive: cssHex(C.overdrive), gold: cssHex(C.gold), solo: cssHex(C.solo) };
        const hudText = { score: NaN, scoreStr: '0', mult: NaN, combo: NaN, streakStr: '',
            soloHit: NaN, soloTotal: NaN, soloPctStr: '', soloStr: '', header: null, headerStr: '' };
        let cssW = 1, cssH = 1, dpr = 1;
        let destroyed = false;
        let hudDirty = true;
        const hudLast = { score: NaN, combo: NaN, mult: NaN, sp: NaN, spActive: false, stars: NaN,
            solo: false, soloHit: NaN, soloTotal: NaN, header: null, auto: false, message: null, scoreHidden: false };

        function placeTail(note, mask, code, sp, now, speed, lefty, whammy, cnt) {
            const t = +note.t, len = +note.l;
            let zHead = L.noteZ(t, now, speed);
            let zEnd = L.noteZ(t + len, now, speed);
            const held = code === 3;
            if (held || code === 1) zHead = Math.min(zHead, 0);
            zHead = Math.min(zHead, TR.behind);
            zEnd = Math.max(zEnd, -TR.length);
            if (zHead - zEnd <= 0.01) return cnt;
            // 'hit' with a tail left = dropped (a finished sustain has no tail ahead of the strike line).
            const dim = code === 2 ? MISS_DIM : (code === 1 ? DROPPED_DIM : 1);
            const wob = held ? whammy : 0;
            L.tailSegments(zHead - zEnd, seg);
            for (let b = 0; b < TR.lanes; b++) {
                const open = mask === 0;
                if (!open && !((mask >> b) & 1)) continue;
                const baseX = open ? 0 : L.laneX(b, lefty);
                const width = open ? W * 0.8 : 0.1;
                tmp.copy(sp ? odCol : (open ? openCol : laneCol[b])).multiplyScalar(dim);
                for (let k = 0; k < seg.n && cnt < MAX_TAIL; k++) {
                    const zc = zHead - (k + 0.5) * seg.len;
                    place(tails, cnt++, baseX + L.wobbleX(zc, now, wob), 0, zc, width, 1, seg.len * 1.02, tmp);
                }
                if (open) break;
            }
            return cnt;
        }

        function render(frame) {
            if (destroyed) return;
            frame = frame || {};
            const now = Number.isFinite(frame.now) ? frame.now : 0;
            const look = frame.lookahead > 0 ? frame.lookahead : TR.lookahead;
            const speed = TR.length / look;
            const behindS = TR.behind / speed;
            const lefty = !!frame.lefty;
            if (lefty !== placedLefty) placeButtons(lefty);
            const notes = Array.isArray(frame.notes) ? frame.notes : EMPTY;
            if (notes !== lastNotes) prepareNotes(notes);
            const state = frame.state || null;
            const spActive = !!(state && state.starPower && state.starPower.active);
            const pressed = frame.pressed || EMPTY;
            const whammy = Number.isFinite(frame.whammy) ? frame.whammy : 0;
            const noteState = typeof frame.noteState === 'function' ? frame.noteState : null;
            const spRanges = frame.starPower;

            // Star power: blue wash and rails.
            // dt from chart time, clamped: a pause holds the fade, a seek steps it by at most 0.1 s.
            let dt = Number.isFinite(lastNow) ? now - lastNow : 0;
            if (!(dt >= 0) || dt > 0.1) dt = 0.1;
            lastNow = now;
            spIn += ((spActive ? 1 : 0) - spIn) * (1 - Math.exp(-dt / SP_FADE_S));
            spWashMat.opacity = 0.16 * spIn;
            railMat.color.copy(railCol).lerp(odCol, spIn);

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

            // Notes: tails, gems, hit flashes.
            let nt = 0, ng = 0, no = 0, nglow = 0;
            L.visibleWindow(notes, now, look, behindS + maxSustain, win);
            for (let i = win[0]; i < win[1]; i++) {
                const n = notes[i];
                const t = +n.t;
                const st = noteState ? noteState(i) : null;
                const code = st === 'hit' ? 1 : (st === 'miss' ? 2 : (st === 'held' ? 3 : 0));
                const judgedHit = code === 1 || code === 3;
                const kind = L.gemKind(n);
                const mask = kind === 'open' ? 0 : (n.f | 0) & L.FRET_MASK;
                // Flash when the hit is first seen (keyed on the judgment, however late it lands).
                if (judgedHit && tracking && prevState[i] !== 1 && prevState[i] !== 3) {
                    if (mask === 0) flashAt[TR.lanes] = now;
                    else for (let b = 0; b < TR.lanes; b++) if ((mask >> b) & 1) flashAt[b] = now;
                }
                prevState[i] = code;
                const sp = L.rangeIndexAt(spRanges, t) >= 0;
                if (+n.l > 0) nt = placeTail(n, mask, code, sp, now, speed, lefty, whammy, nt);
                if (judgedHit) continue;   // hit gems vanish (after the flash)
                const z = L.noteZ(t, now, speed);
                if (z > TR.behind || z < -TR.length) continue;
                const dim = code === 2 ? MISS_DIM : 1;
                const hopo = kind === 'hopo' || (kind === 'open' && !!n.h);
                if (kind === 'open') {
                    if (no >= MAX_OPEN) continue;
                    place(openBar, no++, 0, 0, z, W * 0.94, hopo ? 0.8 : 1, 1, tmp.copy(sp ? odGemCol : openCol).multiplyScalar(dim));
                    if (hopo && nglow < MAX_GEMS + MAX_OPEN) place(gemGlow, nglow++, 0, 0.01, z, W * 1.05, 1, 0.5, tmp.setScalar(0.5 * dim));
                    continue;
                }
                for (let b = 0; b < TR.lanes; b++) {
                    if (!((mask >> b) & 1) || ng >= MAX_GEMS) continue;
                    const x = L.laneX(b, lefty);
                    const sy = hopo ? 0.8 : 1;
                    const lane = laneCol[b];
                    place(gemBody, ng, x, 0, z, 1, sy, 1, tmp.copy(sp ? odGemCol : lane).multiplyScalar(dim));
                    if (hopo) tmp.copy(white);
                    else if (sp) tmp.copy(odCol);
                    else if (kind === 'tap') tmp.copy(lane).lerp(white, 0.25);
                    else tmp.copy(rimCol);
                    place(gemRim, ng, x, (sy - 1) * 0.09, z, 1, 1, 1, tmp.multiplyScalar(dim));
                    if (kind === 'tap') tmp.copy(tapCol);
                    else if (hopo) tmp.copy(white);
                    else tmp.copy(sp ? white : lane).lerp(white, 0.35);
                    place(gemCap, ng, x, (sy - 1) * 0.09, z, 1, 1, 1, tmp.multiplyScalar(dim));
                    ng++;
                    if (hopo && nglow < MAX_GEMS + MAX_OPEN) {
                        tmp.copy(sp ? odCol : white).multiplyScalar(0.6 * dim);
                        place(gemGlow, nglow++, x, 0.01, z, 0.95, 1, 0.75, tmp);
                    }
                }
            }
            tracking = true;
            finish(tails, nt); finish(gemBody, ng); finish(gemRim, ng); finish(gemCap, ng);
            finish(gemGlow, nglow); finish(openBar, no);

            // Fret buttons and hit flashes.
            for (let i = 0; i <= TR.lanes; i++) {
                let age = now - flashAt[i];
                if (age < 0) { flashAt[i] = -1e9; age = 1e9; }   // seeked back past the flash
                const k = age < FLASH_S ? 1 - age / FLASH_S : 0;
                const f = flashes[i];
                f.mesh.visible = k > 0;
                f.mat.opacity = k;
                if (i === TR.lanes) continue;
                const s = 1 + 0.5 * (1 - k);
                f.mesh.scale.set(0.9 * s, 1, 0.9 * s);
                const btn = buttons[i];
                const down = !!pressed[i];
                btn.innerMat.color.setHex(C.background).lerp(btn.color, down ? 1 : 0.12).lerp(white, 0.6 * k);
                const sc = down ? 1.08 : 1;
                btn.ring.scale.set(sc, sc, sc);
            }

            renderer.render(scene, camera);
            drawHud(frame, state, spActive);
        }

        // ── HUD (redrawn only when something on it changes) ──
        function drawHud(frame, state, spActive) {
            if (!hctx || !hud) return;
            const score = state ? state.score | 0 : 0;
            const combo = state ? state.combo | 0 : 0;
            const mult = state ? state.multiplier | 0 : 0;
            const sp = state && state.starPower ? Math.round(clamp(+state.starPower.amount || 0, 0, 1) * 200) / 200 : 0;
            const st = state ? Math.round((+state.stars || 0) * 100) / 100 : 0;
            const solo = !!(state && state.solo && state.solo.active);
            const soloHit = solo ? state.solo.hit : 0, soloTotal = solo ? state.solo.total : 0;
            const header = typeof frame.header === 'string' ? frame.header : '';
            const auto = frame.sourceKind === 'auto';
            const message = typeof frame.message === 'string' && frame.message ? frame.message : null;
            const scoreHidden = frame.scoreHidden === true;
            const h = hudLast;
            if (!hudDirty && h.score === score && h.combo === combo && h.mult === mult && h.sp === sp
                && h.spActive === spActive && h.stars === st && h.solo === solo && h.soloHit === soloHit
                && h.soloTotal === soloTotal && h.header === header && h.auto === auto && h.message === message
                && h.scoreHidden === scoreHidden) return;
            hudDirty = false;
            h.score = score; h.combo = combo; h.mult = mult; h.sp = sp; h.spActive = spActive; h.stars = st;
            h.solo = solo; h.soloHit = soloHit; h.soloTotal = soloTotal; h.header = header; h.auto = auto; h.message = message;
            h.scoreHidden = scoreHidden;

            const ctx = hctx;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssW, cssH);
            const pad = 10;
            const text = CSS.text;
            const ht = hudText;   // formatted strings, rebuilt only when their values change
            if (ht.score !== score) { ht.score = score; ht.scoreStr = score.toLocaleString('en-US'); }
            if (ht.mult !== mult || ht.combo !== combo) {
                ht.mult = mult; ht.combo = combo; ht.streakStr = 'x' + mult + '   ' + combo + ' streak';
            }
            if (ht.soloHit !== soloHit || ht.soloTotal !== soloTotal) {
                ht.soloHit = soloHit; ht.soloTotal = soloTotal;
                ht.soloPctStr = L.soloPercent({ hit: soloHit, total: soloTotal }) + '%';
                ht.soloStr = 'SOLO  ' + soloHit + ' / ' + soloTotal;
            }
            if (ht.header !== header) { ht.header = header; ht.headerStr = header.toUpperCase(); }
            ctx.textBaseline = 'alphabetic';

            // Header tag and AUTO CHART.
            ctx.textAlign = 'left';
            if (header) {
                ctx.font = F_TAG;
                ctx.fillStyle = text;
                ctx.fillText(ht.headerStr, pad, pad + 10);
            }
            if (auto) {
                ctx.font = F_AUTO;
                const tw = ctx.measureText('AUTO CHART').width;
                const y = pad + (header ? 16 : 0);
                ctx.fillStyle = text;
                ctx.fillRect(pad, y, tw + 10, 13);
                ctx.fillStyle = CSS.background;
                ctx.fillText('AUTO CHART', pad + 5, y + 10);
            }

            // Star power bar, score, multiplier x streak, stars (top right); none in a band lane.
            const right = cssW - pad;
            const barW = 90, barH = 7;
            if (!scoreHidden) {
                ctx.fillStyle = CSS.meterBack;
                ctx.fillRect(right - barW, pad, barW, barH);
                if (sp > 0) {
                    ctx.fillStyle = CSS.overdrive;
                    ctx.fillRect(right - barW, pad, barW * sp, barH);
                }
                if (state) {
                    ctx.textAlign = 'right';
                    ctx.fillStyle = '#ffffff';
                    ctx.font = F_SCORE;
                    ctx.fillText(ht.scoreStr, right, pad + barH + 24);
                    ctx.font = F_SMALL;
                    ctx.fillStyle = spActive ? CSS.overdrive : text;
                    ctx.fillText(ht.streakStr, right, pad + barH + 41);
                    L.starFill(st, stars);
                    const r = 6, gap = 15;
                    for (let i = 0; i < 5; i++) {
                        const cx = right - r - (4 - i) * gap, cy = pad + barH + 56;
                        drawStar(ctx, cx, cy, r);
                        ctx.fillStyle = CSS.meterBack;
                        ctx.fill();
                        const fill = i < stars.full ? 1 : (i === stars.full ? stars.frac : 0);
                        if (fill > 0) {
                            ctx.save();
                            ctx.clip();
                            ctx.fillStyle = stars.gold ? CSS.gold : '#ffffff';
                            ctx.fillRect(cx - r, cy - r, 2 * r * fill, 2 * r);
                            ctx.restore();
                        }
                    }
                }
            }

            // Solo: running percent.
            if (solo) {
                ctx.textAlign = 'center';
                ctx.fillStyle = CSS.solo;
                ctx.font = F_SOLO;
                ctx.fillText(ht.soloPctStr, cssW / 2, cssH * 0.28);
                ctx.font = F_TAG;
                ctx.fillText(ht.soloStr, cssW / 2, cssH * 0.28 + 16);
            }

            // Status message.
            if (message) {
                ctx.textAlign = 'center';
                ctx.font = F_MSG;
                const tw = ctx.measureText(message).width;
                ctx.fillStyle = 'rgba(11,13,20,0.82)';
                ctx.fillRect(cssW / 2 - tw / 2 - 12, cssH * 0.45 - 18, tw + 24, 28);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(message, cssW / 2, cssH * 0.45);
            }
        }

        function layoutCamera() {
            const aspect = cssW / Math.max(1, cssH);
            camera.aspect = aspect;
            // Keep the strike line and its fret buttons in view on narrow lanes.
            const needHalfW = W / 2 + 0.35;
            const fovNeeded = 2 * Math.atan(needHalfW / (camDist * aspect)) * 180 / Math.PI;
            camera.fov = clamp(Math.max(50, fovNeeded), 50, 100);
            camera.updateProjectionMatrix();
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
            hudDirty = true;
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

        placeButtons(false);
        return { render, resize, destroy, dispose: destroy };
    }

    return { createView };
});
