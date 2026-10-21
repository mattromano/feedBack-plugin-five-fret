/*
 * screen.js: the feedBack five-fret plugin's highway renderer (window.feedBackViz_five_fret).
 * Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
 *
 * setRenderer contract (core CLAUDE.md "setRenderer contract"): a WebGL2 renderer that draws the tilted
 * 5-fret highway (assets/highway3d.js) for one part of bundle.fiveFretParts, judged by a scoring session
 * (assets/session.js over the engine port in assets/engine.js) fed by one claimed game controller
 * (window.feedBack.gamepadInput, named through assets/profiles.js).
 *
 * Claim: the renderer holds a controller only while a 5-fret part is playing. It lets it go while
 * paused, on a song with no 5-fret part, and before playback starts, so core's menus (A = play/pause,
 * B = back) work then and a controller-only player can always leave; it claims again when playback
 * resumes. Claim order: a controller with a saved binding (set up on the controls screen) first, then
 * a standard-mapping pad, each in slot order.
 *
 * Band lanes (window.feedBackFiveFret, below): a canvas pinned with setLane gets a renderer that plays
 * one controller (controllerKey), one part exactly, and the pinned difficulty and lefty. It holds that
 * controller from setLane (once it is connected) until clearLane or destroy, paused or not; the claim
 * rule above is for unpinned renderers. A pinned renderer never mounts the panel or saves settings,
 * and its gamepad mode follows the controller's kind, not the saved setting.
 *
 * Time: the engine runs on the highway's chart clock. Each draw records (bundle.currentTime,
 * performance.now() / 1000); a controller event's time is that chart time plus the wall time since the
 * frame (session.inputChartTime). The session applies the controller's input offset, to inputs and to
 * its clock alike. Never getDisplayTime().
 *
 * Settings (part, difficulty, lefty, gamepadMode) are declared in plugin.json
 * capabilities.visualization.settings for splitscreen's per-panel popover (applySetting), and shown in
 * the normal player as a "5-Fret" panel in window.feedBack.ui.playerControlSlot(). Each instance keeps
 * its own settings, seeded from five_fret.settings.v1; only the normal player's panel instance saves
 * back to it (profiles.saveSettings), so splitscreen panels never change each other or the defaults.
 *
 * It also opens and closes the plugin's controls screen (screen.html, #plugin-five_fret; the screen
 * itself is assets/controls.js). See "Controls screen hook" below.
 */
(function () {
    'use strict';

    const PLUGIN_ID = 'five_fret';
    const ASSET_VERSION = '0.2.0';   // cache-buster for the lazily loaded files: bump with releases
    const THREE_URL = '/static/vendor/three/three.module.min.js';
    const PLUGIN_ASSETS = '/api/plugins/' + PLUGIN_ID + '/assets/';
    // Load order matters: session.js needs engine.js, highway3d.js needs layout.js.
    const MODULES = [
        ['engine.js', 'FiveFretEngine'],
        ['profiles.js', 'FiveFretProfiles'],
        ['session.js', 'FiveFretSession'],
        ['layout.js', 'FiveFretLayout'],
        ['highway3d.js', 'FiveFretHighway3D'],
    ];
    const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
    const PART_LABELS = { auto: 'Auto', guitar: 'Guitar', rhythm: 'Rhythm', bass: 'Bass' };
    // Bus events between the controls screen and the renderers (window.feedBack.emit / on).
    const EV_CONTROLS = 'five_fret:controls-screen';    // { open }: the screen claims controllers while open
    const EV_BINDINGS = 'five_fret:bindings-changed';   // { controllerKey }: a binding was saved
    const EV_OFFSET = 'five_fret:offset-changed';       // { controllerKey, offsetMs }: an input offset was saved
    let _controlsOpen = false;   // renderers don't claim while the controls screen is open
    // Band lanes, by canvas (see window.feedBackFiveFret): a pin made before an instance inits on the
    // canvas, or across a re-init, still applies. _byCanvas finds the live instance drawing on one.
    const _lanes = new WeakMap();         // canvas -> { controllerKey, part, difficulty, lefty }
    const _scoreHidden = new WeakMap();   // canvas -> true: the HUD skips score, multiplier, streak, SP, stars
    const _byCanvas = new WeakMap();      // canvas -> renderer instance
    const LANE_PARTS = Object.freeze({ guitar: true, rhythm: true, bass: true });
    const LANE_GAMEPAD_MODE = Object.freeze({ gamepadMode: null });   // a lane: by the controller's kind
    const EMPTY = Object.freeze([]);
    const NO_PRESSED = Object.freeze([false, false, false, false, false]);

    // ── Script loading (as the drums plugin) ──────────────────────────────────

    // A failed load removes its <script> element, so a later call for the same URL loads it again.
    // A tag of ours still loading is waited for (data-five-fret: 'loading' -> 'loaded'); a tag
    // someone else added counts as loaded.
    function _loadScript(url) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${url}"]`);
            if (existing) {
                if (existing.dataset && existing.dataset.fiveFret === 'loading') {
                    existing.addEventListener('load', () => resolve(), { once: true });
                    existing.addEventListener('error', () => reject(new Error('Failed to load ' + url)), { once: true });
                } else {
                    resolve();
                }
                return;
            }
            const s = document.createElement('script');
            s.src = url;
            s.dataset.fiveFret = 'loading';
            s.addEventListener('load', () => { s.dataset.fiveFret = 'loaded'; resolve(); }, { once: true });
            s.addEventListener('error', () => {
                try { s.remove(); } catch (_) { /* already gone */ }
                reject(new Error('Failed to load ' + url));
            }, { once: true });
            document.head.appendChild(s);
        });
    }
    // Remove the <script> element for `url` (a load that "succeeded" without registering its global).
    function _dropScript(url) {
        try { document.querySelectorAll(`script[src="${url}"]`).forEach((el) => el.remove()); } catch (_) { /* no DOM */ }
    }
    const _assetUrl = (name) => PLUGIN_ASSETS + name + '?v=' + ASSET_VERSION;

    // One shared promise, so N instances never race on the same tags.
    let _modulesPromise = null;
    function _loadModules() {
        if (_modulesPromise) return _modulesPromise;
        _modulesPromise = MODULES.reduce(
            (p, [name, global]) => p.then(() => (window[global] ? null : _loadScript(_assetUrl(name)))),
            Promise.resolve(),
        ).then(() => {
            for (const [name, global] of MODULES) if (!window[global]) throw new Error(name + ' did not register');
            return {
                P: window.FiveFretProfiles, H: window.FiveFretSession, V: window.FiveFretHighway3D,
            };
        }).catch((e) => {
            _modulesPromise = null;   // allow a retry on the next init
            for (const [name, global] of MODULES) if (!window[global]) _dropScript(_assetUrl(name));
            throw e;
        });
        return _modulesPromise;
    }

    let _libsPromise = null;
    function _loadLibs() {
        if (_libsPromise) return _libsPromise;
        _libsPromise = Promise.all([factory.importThree(), _loadModules()])
            .then(([THREE, m]) => Object.assign({ THREE }, m))
            .catch((e) => {
                _libsPromise = null;
                throw e;
            });
        return _libsPromise;
    }

    function _wallNow() { return performance.now() / 1000; }

    // A gamepad-input list() entry's controllerKey (core's, else `id#nth` as profiles.controllerKey).
    function _keyOf(P, info, nth) {
        return info && typeof info.controllerKey === 'string' && info.controllerKey
            ? info.controllerKey : P.controllerKey(info, nth);
    }

    function _gamepadInput() {
        const gi = window.feedBack && window.feedBack.gamepadInput;
        return gi && gi.version === 1 ? gi : null;
    }

    function _ssActive() {
        const ss = window.slopsmithSplitscreen;
        try { return !!(ss && typeof ss.isActive === 'function' && ss.isActive()); } catch (_) { return false; }
    }

    function _playerSlot() {
        const fb = window.feedBack;
        if (!fb || fb.uiVersion !== 'v3' || !fb.ui || typeof fb.ui.playerControlSlot !== 'function') return null;
        try { return fb.ui.playerControlSlot() || null; } catch (_) { return null; }
    }

    // Settings values a control may set (anything else is ignored).
    function _validSetting(key, value) {
        if (key === 'part') return Object.prototype.hasOwnProperty.call(PART_LABELS, value);
        if (key === 'difficulty') return Object.prototype.hasOwnProperty.call(DIFFICULTY_LABELS, value);
        if (key === 'lefty' || key === 'gamepadMode') return typeof value === 'boolean';
        return false;
    }

    // Plan 5's "show auto charts" flag in five_fret.settings.v1 (default false). Read directly, so it
    // works before profiles.js has loaded.
    const SETTINGS_KEY = 'five_fret.settings.v1';
    function _showAutoCharts() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const v = raw ? JSON.parse(raw) : null;
            return !!(v && typeof v === 'object' && v.showAutoCharts === true);
        } catch (_) { return false; }
    }

    // ── Normal-player panel (one, owned by the main player's instance) ─────────

    let _panelOwner = null;   // the renderer instance whose settings the panel shows
    let _panel = null;        // { el, part, difficulty, lefty, gamepadMode }

    function _mountPanel(owner) {
        if (_ssActive()) return;   // splitscreen panels use the per-panel popover
        if (_panelOwner && _panelOwner !== owner) return;
        const slot = _playerSlot() || document.getElementById('player-controls');
        if (!slot) return;
        _panelOwner = owner;
        if (_panel && slot.contains(_panel.el)) { _syncPanel(); return; }
        if (_panel) _panel.el.remove();

        const el = document.createElement('div');
        el.className = 'five-fret-panel bg-fb-card border border-fb-border rounded-lg text-fb-text';
        el.dataset.fiveFretPanel = '1';
        el.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 10px;font-size:12px;min-width:180px;';
        const title = document.createElement('div');
        title.textContent = '5-Fret';
        title.style.cssText = 'font-weight:600;';
        el.appendChild(title);

        const row = (label, control) => {
            const r = document.createElement('label');
            r.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
            const span = document.createElement('span');
            span.textContent = label;
            span.className = 'text-fb-textDim';
            r.appendChild(span);
            r.appendChild(control);
            el.appendChild(r);
            return control;
        };
        const select = (labels) => {
            const s = document.createElement('select');
            s.className = 'bg-fb-bg border border-fb-border rounded text-fb-text';
            for (const id of Object.keys(labels)) {
                const o = document.createElement('option');
                o.value = id;
                o.textContent = labels[id];
                s.appendChild(o);
            }
            return s;
        };
        const check = () => {
            const c = document.createElement('input');
            c.type = 'checkbox';
            return c;
        };
        const part = row('Part', select(PART_LABELS));
        const difficulty = row('Difficulty', select(DIFFICULTY_LABELS));
        const lefty = row('Lefty', check());
        const gamepadMode = row('Gamepad mode', check());
        part.addEventListener('change', () => _panelOwner && _panelOwner.applySetting('part', part.value));
        difficulty.addEventListener('change', () => _panelOwner && _panelOwner.applySetting('difficulty', difficulty.value));
        lefty.addEventListener('change', () => _panelOwner && _panelOwner.applySetting('lefty', lefty.checked));
        gamepadMode.addEventListener('change', () => _panelOwner && _panelOwner.applySetting('gamepadMode', gamepadMode.checked));

        // Controls screen (setup, rebinding, input offset).
        const link = document.createElement('button');
        link.type = 'button';
        link.textContent = 'Controller setup…';
        link.className = 'text-fb-primary';
        link.style.cssText = 'margin-top:2px;text-align:left;background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;';
        link.addEventListener('click', () => {
            if (typeof window.showScreen === 'function') window.showScreen('plugin-' + PLUGIN_ID);
        });
        el.appendChild(link);

        slot.appendChild(el);
        _panel = { el, part, difficulty, lefty, gamepadMode };
        _syncPanel();
    }

    function _syncPanel() {
        if (!_panel || !_panelOwner) return;
        _panel.part.value = _panelOwner.getSetting('part');
        _panel.difficulty.value = _panelOwner.getSetting('difficulty');
        _panel.lefty.checked = !!_panelOwner.getSetting('lefty');
        _panel.gamepadMode.checked = !!_panelOwner.getSetting('gamepadMode');
    }

    function _unmountPanel(owner) {
        if (_panelOwner !== owner) return;
        if (_panel) { try { _panel.el.remove(); } catch (_) { /* gone */ } }
        _panel = null;
        _panelOwner = null;
    }

    // ── Renderer ───────────────────────────────────────────────────────────────

    function createRenderer() {
        let P = null, H = null;            // profiles.js, session.js (once loaded)
        let canvas = null, hud = null, view = null;
        let token = 0;
        let lastW = 0, lastH = 0, lastScale = 1;
        // This instance's own settings (splitscreen panels never share them). Seeded from
        // five_fret.settings.v1 once profiles.js has loaded; only the normal player's panel instance
        // writes them back (see applySetting).
        let settings = { part: 'auto', difficulty: 'expert', lefty: false, gamepadMode: null, offsetMs: {} };
        let pending = {};                  // applySetting before profiles.js loaded
        // This canvas's band lane (_lanes), or null. Its part, difficulty and lefty stand in for the
        // instance's own settings while it is set (cur()); its gamepad mode is by controller kind.
        let pin = null;
        const cur = () => pin || settings;

        // Controller (handleInfo: its gamepad-input list() entry at claim time, for resolveBinding).
        // binding stays set while the claim is parked (paused / no part), so the gamepad mode, and with
        // it the session, does not change across a pause.
        let handle = null, handleInfo = null, binding = null, mapper = null, connected = false, offChange = null;
        // wantClaim: a part is playing (see "Claim" above). readyKind: while no controller is held, the
        // binding kind of the one tryClaim would take (null: none), for the header and status while paused.
        let wantClaim = false, readyKind = null, claiming = false;

        // Session and clock
        let session = null;
        // The picked part, recomputed only when the parts object (identity or key count), the
        // arrangement name or the part setting changes.
        const pick = { parts: null, count: -1, arrangement: null, setting: null, exact: false, partId: null };
        const statusArgs = { hasParts: false, hasController: false, connected: false };
        // What the session was built from: rebuilt when any of these change (compared field by field,
        // so the steady state allocates nothing).
        const built = { partId: null, part: null, difficulty: null, gamepadMode: null, offsetMs: null,
            notes: null, notesLen: -1, levelNotes: null, levelLen: -1, beats: null, beatsLen: -1 };
        let header = '', headerPart = null, headerSession = null, headerInput = null;
        let lastChartTime = NaN, lastFrameT = NaN, playing = true;
        const noteState = (i) => (session ? session.noteState(i) : null);
        const frame = {
            now: 0, notes: EMPTY, beats: EMPTY, starPower: EMPTY, solos: EMPTY, pressed: NO_PRESSED, whammy: 0,
            noteState, state: null, lefty: false, header: '', sourceKind: '', message: null, scoreHidden: false,
        };

        function countKeys(o) {
            let n = 0;
            for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++;
            return n;
        }
        // A band lane plays its part exactly (no fallback to another instrument).
        function pickedPart(parts, arrangement) {
            const count = parts && typeof parts === 'object' ? countKeys(parts) : 0;
            const setting = cur().part, exact = !!pin;
            if (pick.parts !== parts || pick.count !== count || pick.arrangement !== arrangement
                || pick.setting !== setting || pick.exact !== exact) {
                pick.parts = parts; pick.count = count; pick.arrangement = arrangement;
                pick.setting = setting; pick.exact = exact;
                pick.partId = exact
                    ? H.pickPart(parts, arrangement, setting, { exact: true, showAuto: _showAutoCharts() })
                    : H.pickPart(parts, arrangement, setting);
            }
            return pick.partId;
        }

        function gamepadMode() {
            return P ? P.effectiveGamepadMode(pin ? LANE_GAMEPAD_MODE : settings, binding) : false;
        }
        function offsetMs() {
            const key = handle && handle.controllerKey;
            const v = key && settings.offsetMs ? settings.offsetMs[key] : 0;
            return Number.isFinite(v) ? v : 0;
        }

        // ── Controller ──

        function onEvent(ev) {
            connected = true;   // events resume after a reconnect
            if (!mapper || !ev) return;
            const out = mapper.map(ev);
            for (let i = 0; i < out.length; i++) {
                const a = out[i];
                if (a.action === 'pause') {
                    if (a.value && typeof window.togglePlay === 'function') {
                        try { window.togglePlay(); } catch (e) { console.warn('[5-Fret] togglePlay failed:', e); }
                    }
                    continue;
                }
                if (!session) continue;
                // The session applies the input offset (to inputs and its clock), so none here.
                const t = H.inputChartTime(lastChartTime, lastFrameT, ev.t, 0, playing);
                if (Number.isFinite(t)) session.input(a.action, a.value, t);
            }
        }

        // Free connected controllers this renderer could play with, in claim order: those with a saved
        // binding first, then standard pads (the implicit standard profile), each in slot order. So a
        // controller set up on the controls screen wins over a pad in an earlier slot (a Steam Deck's
        // built-in controls are always slot 0). A band lane: only its own controller.
        function claimable() {
            const gi = _gamepadInput();
            if (!gi) return [];
            let list;
            try { list = gi.list(); } catch (_) { return []; }
            const bindings = P.loadBindings();
            const saved = [], standard = [];
            const nth = Object.create(null);
            for (const info of list) {
                if (!info || !info.connected) continue;
                nth[info.id] = (nth[info.id] || 0) + 1;
                if (info.claimedBy) continue;   // another plugin, or another 5-fret panel
                const key = _keyOf(P, info, nth[info.id]);
                if (pin && key !== pin.controllerKey) continue;
                const stored = bindings[key];
                const b = P.resolveBinding(info, stored);
                if (b) (b === stored ? saved : standard).push({ info, kind: b.kind });
            }
            return saved.concat(standard);
        }

        // Claim the first claimable controller while a part plays (not while the controls screen, which
        // claims controllers itself, is open); otherwise just note which one that would be (readyKind).
        // Runs on claim-state changes and controller events, never per frame.
        function tryClaim() {
            if (handle || !P || claiming) return;
            claiming = true;   // our own claim/release fires change events synchronously
            try {
                const cands = claimable();
                readyKind = cands.length ? cands[0].kind : null;
                if (!wantClaim || _controlsOpen) return;
                const gi = _gamepadInput();
                const bindings = P.loadBindings();
                for (const c of cands) {
                    const h = gi.claim(c.info.index, PLUGIN_ID);
                    if (!h) continue;
                    if (pin && h.controllerKey !== pin.controllerKey) { h.release(); continue; }
                    // The claim's controllerKey is the authority (it can differ after renumbering).
                    const b = P.resolveBinding(c.info, bindings[h.controllerKey]);
                    if (!b) { h.release(); continue; }
                    handle = h;
                    handleInfo = c.info;
                    binding = b;
                    mapper = P.createMapper(b);
                    connected = true;
                    h.addListener(onEvent);
                    return;
                }
                readyKind = null;
            } finally {
                claiming = false;
            }
        }

        function onChange(ev) {
            if (!ev) return;
            if (handle) {
                if (ev.index !== handle.index) return;
                if (ev.type === 'disconnect') {
                    connected = false;
                    // Nothing stays latched while it is gone: release every held fret, and start the
                    // mapper over so a still-down button reads as a fresh press when events resume.
                    if (session) session.releaseAll(H.inputChartTime(lastChartTime, lastFrameT, _wallNow(), 0, playing));
                    if (binding) mapper = P.createMapper(binding);
                } else if (ev.type === 'connect') {
                    connected = true;
                }
            } else {
                tryClaim();   // a controller came, went, or was claimed or released
            }
        }

        // Let go of the claimed controller (frets it held are released in the session). park: only
        // paused or between parts, so keep the binding (the gamepad mode, and the session, stay).
        function dropHandle(park) {
            if (!handle) return;
            const h = handle;
            handle = null; handleInfo = null; mapper = null; connected = false;
            if (!park) binding = null;
            if (session) session.releaseAll(H.inputChartTime(lastChartTime, lastFrameT, _wallNow(), 0, playing));
            try { h.removeListener(onEvent); h.release(); } catch (_) { /* ignore */ }
        }

        function releaseController() {
            if (offChange) { try { offChange(); } catch (_) { /* ignore */ } offChange = null; }
            dropHandle();
        }

        // The controls screen opened (it claims the controllers: let ours go) or closed (claim again).
        function onControlsScreen(e) {
            if (!P) return;
            if (e && e.detail && e.detail.open) dropHandle();
            else tryClaim();
        }

        // detail.controllerKey names another controller than ours (no key: assume ours).
        function otherController(e) {
            const key = e && e.detail && e.detail.controllerKey;
            return !!handle && typeof key === 'string' && key !== handle.controllerKey;
        }

        // The controls screen saved an input offset: re-read the offsets (the session rebuilds when
        // our controller's offset changed).
        function onOffsetChanged(e) {
            if (!P || otherController(e)) return;
            settings = Object.assign({}, settings, { offsetMs: P.loadSettings().offsetMs });
        }

        // The controls screen saved a binding: re-resolve ours, or claim a controller set up just now.
        function onBindingsChanged(e) {
            if (!P) return;
            if (!handle) { tryClaim(); return; }
            if (otherController(e)) return;
            const b = P.resolveBinding(handleInfo, P.loadBindings()[handle.controllerKey]);
            if (!b) { dropHandle(); tryClaim(); return; }
            if (session) session.releaseAll(H.inputChartTime(lastChartTime, lastFrameT, _wallNow(), 0, playing));
            binding = b;
            mapper = P.createMapper(b);
        }

        // ── Session ──

        function ensureSession(partId, part, beats) {
            const difficulty = cur().difficulty;
            const levels = part.levels || {};
            const lv = levels[difficulty];
            const levelNotes = lv && Array.isArray(lv.notes) ? lv.notes : null;
            const gm = gamepadMode();
            const off = offsetMs();
            const b = built;
            if (session && b.partId === partId && b.part === part && b.difficulty === difficulty
                && b.gamepadMode === gm && b.offsetMs === off
                && b.notes === part.notes && b.notesLen === (part.notes ? part.notes.length : -1)
                && b.levelNotes === levelNotes && b.levelLen === (levelNotes ? levelNotes.length : -1)
                && b.beats === beats && b.beatsLen === beats.length) return;
            b.partId = partId; b.part = part; b.difficulty = difficulty; b.gamepadMode = gm; b.offsetMs = off;
            b.notes = part.notes; b.notesLen = part.notes ? part.notes.length : -1;
            b.levelNotes = levelNotes; b.levelLen = levelNotes ? levelNotes.length : -1;
            b.beats = beats; b.beatsLen = beats.length;
            session = H.createSession({
                chart: { notes: part.notes, levels, starPower: part.starPower, solos: part.solos, beats },
                instrument: part.instrument === 'bass' ? 'bass' : 'guitar',
                difficulty,
                gamepadMode: gm,
                offsetMs: off,
                pressed: session ? session.pressedFrets() : null,   // frets still held carry over
            });
        }

        // "PART · INPUT · DIFFICULTY", rebuilt only when the part, session or input label changes. INPUT is
        // the held controller's kind, or while parked (paused) the kind of the one a resume would claim.
        function headerFor(part) {
            const kind = handle ? (binding && binding.kind) : (wantClaim ? null : readyKind);
            const input = !kind ? 'NO CONTROLLER' : (kind === 'gamepad' ? 'GAMEPAD' : 'GUITAR');
            if (part === headerPart && session === headerSession && input === headerInput) return header;
            headerPart = part; headerSession = session; headerInput = input;
            header = [part.name || part.instrument || '5-Fret', input,
                DIFFICULTY_LABELS[session ? session.difficulty : cur().difficulty] || ''].join(' · ');
            return header;
        }

        // The HUD is sibling DOM: hide it with the highway canvas (splitscreen display:none's #highway).
        // Every highway instance emits on the shared bus, so filter by canvas.
        function onVisibility(e) {
            if (!e || !e.detail || e.detail.canvas !== canvas || !hud) return;
            hud.style.display = e.detail.visible === false ? 'none' : '';
        }
        function wireBus(on) {
            const bus = window.feedBack;
            if (!bus || typeof bus.on !== 'function' || typeof bus.off !== 'function') return;
            const pairs = [['highway:visibility', onVisibility], [EV_CONTROLS, onControlsScreen],
                [EV_BINDINGS, onBindingsChanged], [EV_OFFSET, onOffsetChanged]];
            for (const [name, fn] of pairs) {
                try { if (on) bus.on(name, fn); else bus.off(name, fn); } catch (_) { /* ignore */ }
            }
        }

        // ── View sizing ──

        function positionHud() {
            if (!hud || !canvas) return;
            hud.style.left = canvas.offsetLeft + 'px';
            hud.style.top = canvas.offsetTop + 'px';
        }
        function doResize() {
            if (!view || !canvas) return;
            const rect = canvas.getBoundingClientRect();
            const w = rect.width || canvas.clientWidth;
            const h = rect.height || canvas.clientHeight;
            if (!w || !h) return;
            const base = Math.min(window.devicePixelRatio || 1, _ssActive() ? 1.25 : 2);
            view.resize(w, h, base * (lastScale || 1));
            lastW = canvas.width;
            lastH = canvas.height;
            positionHud();
        }

        function teardown() {
            token++;
            wireBus(false);
            releaseController();
            binding = null; wantClaim = false; readyKind = null;
            _unmountPanel(instance);
            if (canvas && _byCanvas.get(canvas) === instance) _byCanvas.delete(canvas);
            pin = null;
            if (view) { try { view.destroy(); } catch (e) { console.warn('[5-Fret] view destroy failed:', e); } }
            view = null;
            if (hud) { try { hud.remove(); } catch (_) { /* gone */ } }
            hud = null;
            canvas = null;
            session = null;
            headerPart = headerSession = headerInput = null;
            lastChartTime = lastFrameT = NaN;
            lastW = lastH = 0;
        }

        const instance = {
            contextType: 'webgl2',
            init(cv /* , bundle */) {
                if (canvas || hud || view) teardown();
                let gl = null;
                try { gl = cv ? cv.getContext('webgl2', { antialias: true, alpha: false }) : null; } catch (_) { gl = null; }
                if (!gl) {
                    console.warn('[5-Fret] init: webgl2 context unavailable on the highway canvas');
                    this.readyPromise = Promise.reject(new Error('webgl2 unavailable'));
                    this.readyPromise.catch(() => {});
                    return;
                }
                canvas = cv;
                _byCanvas.set(cv, instance);
                pin = _lanes.get(cv) || null;
                hud = document.createElement('canvas');
                hud.className = 'five-fret-hud';
                hud.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2;';
                if (cv.parentNode) cv.parentNode.insertBefore(hud, cv.nextSibling);
                if (cv.offsetParent === null) hud.style.display = 'none';
                wireBus(true);
                const my = ++token;
                this.readyPromise = _loadLibs().then((libs) => {
                    if (my !== token) throw new Error('superseded');
                    P = libs.P;
                    H = libs.H;
                    settings = Object.assign(P.loadSettings(), pending);
                    pending = {};
                    view = libs.V.createView(libs.THREE, cv, { hudCanvas: hud, context: gl });
                    doResize();
                    const gi = _gamepadInput();
                    if (gi) offChange = gi.on('change', onChange);
                    // Unpinned, nothing plays yet: notes readyKind (the first playing draw claims). A
                    // band lane claims its controller now.
                    if (pin) wantClaim = true;
                    tryClaim();
                    if (!pin) _mountPanel(instance);
                });
                this.readyPromise.catch((e) => {
                    if (e && e.message === 'superseded') return;
                    console.error('[5-Fret] renderer failed to start:', e);
                });
            },
            draw(bundle) {
                if (!view || !bundle) return;   // modules still loading
                const scale = bundle.renderScale || 1;
                if (scale !== lastScale) { lastScale = scale; doResize(); }
                else if (canvas.width !== lastW || canvas.height !== lastH) doResize();

                const t = +bundle.currentTime || 0;
                lastChartTime = t;
                lastFrameT = _wallNow();

                playing = bundle.isPlaying !== false;
                const parts = bundle.fiveFretParts;
                const partId = pickedPart(parts, bundle.songInfo ? bundle.songInfo.arrangement : undefined);
                const part = partId ? parts[partId] : null;
                const beats = Array.isArray(bundle.beats) ? bundle.beats : EMPTY;
                if (part) {
                    ensureSession(partId, part, beats);
                    session.update(t);
                    session.drainEvents();   // nothing consumes them yet; keep the queue short
                } else {
                    session = null;
                }
                // Hold the controller only while a part plays (see "Claim" above); a band lane always.
                const want = pin ? true : (!!part && playing);
                if (want !== wantClaim) {
                    wantClaim = want;
                    if (!want) dropHandle(true);
                    tryClaim();
                }

                frame.now = t;
                frame.notes = session ? session.notes : EMPTY;
                frame.beats = beats;
                frame.starPower = part && Array.isArray(part.starPower) ? part.starPower : EMPTY;
                frame.solos = part && Array.isArray(part.solos) ? part.solos : EMPTY;
                frame.pressed = session ? session.pressedFrets() : NO_PRESSED;
                frame.whammy = session ? session.whammy() : 0;
                frame.state = session ? session.state() : null;
                frame.lefty = !!cur().lefty;
                frame.scoreHidden = _scoreHidden.get(canvas) === true;
                frame.header = part ? headerFor(part) : '';
                frame.sourceKind = part ? part.sourceKind : '';
                statusArgs.hasParts = !!part;
                // Parked (paused) with a controller ready to claim on resume: no controller message.
                statusArgs.hasController = !!handle || (!wantClaim && readyKind !== null);
                statusArgs.connected = handle ? connected : true;
                frame.message = H.statusMessage(statusArgs);
                view.render(frame);
            },
            resize() { doResize(); },
            destroy() { teardown(); },
            applySetting(key, value) {
                if (!_validSetting(key, value)) return;
                settings = Object.assign({}, settings, { [key]: value });
                if (!P) pending[key] = value;
                if (_panelOwner === instance) {
                    // The normal player: its panel's choices are the saved defaults.
                    if (P) P.saveSettings({ [key]: value });
                    _syncPanel();
                }
            },
            getSetting(key) {
                if (key === 'gamepadMode') return gamepadMode();
                return cur()[key];
            },
            // ── Band API hooks (window.feedBackFiveFret) ──
            // This canvas's pin was set, changed or cleared.
            _pinChanged() {
                const was = pin;
                pin = canvas ? (_lanes.get(canvas) || null) : null;
                if (!P) return;   // init's load claims (or mounts the panel) once it is done
                if (pin) {
                    _unmountPanel(instance);
                    if (handle && handle.controllerKey !== pin.controllerKey) dropHandle();
                    wantClaim = true;
                    tryClaim();
                } else if (was) {
                    wantClaim = false;    // first: the release's change event must not re-claim
                    dropHandle();         // back to the unpinned claim order (the next draw claims
                    tryClaim();           // again if a part plays); notes readyKind
                    _mountPanel(instance);
                }
            },
            // Engine state plus what the band needs, or null with no session.
            _bandState() {
                if (!session || !built.part) return null;
                return Object.assign(session.state(), {
                    starThresholds: session.starThresholds.slice(),
                    partId: built.partId,
                    instrument: built.part.instrument,
                    sourceKind: built.part.sourceKind,
                    controllerKey: handle ? handle.controllerKey : (pin ? pin.controllerKey : null),
                    connected: !!handle && connected,
                });
            },
        };
        return instance;
    }

    // ── Controls screen hook (the screen itself is assets/controls.js) ─────────
    //
    // Core mounts screen.html as #plugin-five_fret. On core's screen:changed this sets _controlsOpen
    // and announces EV_CONTROLS (renderers let their controller go and stop claiming), then loads
    // controls.js and creates the screen, which claims controllers as 'five_fret.controls'. Leaving
    // destroys it (claims released, clicks stopped) and announces EV_CONTROLS { open: false }.

    const SCREEN_ID = 'plugin-' + PLUGIN_ID;
    const CONTROLS_OWNER = PLUGIN_ID + '.controls';
    // returnTo: where Back goes on this visit (openControls({ returnTo }); 'home' otherwise).
    const _ctl = { visit: 0, screen: null, back: null, returnTo: 'home' };

    function _bus() {
        const b = window.feedBack;
        return b && typeof b.on === 'function' && typeof b.emit === 'function' ? b : null;
    }
    function _emit(name, detail) {
        const b = _bus();
        if (b) { try { b.emit(name, detail); } catch (e) { console.warn('[5-Fret] ' + name + ' listener failed:', e); } }
    }

    let _controlsPromise = null;
    function _loadControls() {
        if (_controlsPromise) return _controlsPromise;
        const url = _assetUrl('controls.js');
        _controlsPromise = _loadModules()
            .then((m) => Promise.resolve(window.FiveFretControls ? null : _loadScript(url)).then(() => {
                if (!window.FiveFretControls) throw new Error('controls.js did not register');
                return { P: m.P, C: window.FiveFretControls };
            }))
            .catch((e) => {
                _controlsPromise = null;
                if (!window.FiveFretControls) _dropScript(url);
                throw e;
            });
        return _controlsPromise;
    }

    function _listNote(list, text) {
        if (!list) return;
        const p = document.createElement('p');
        p.className = 'text-fb-textDim text-sm';
        p.textContent = text;
        list.replaceChildren(p);
    }

    function _openControls() {
        if (_controlsOpen) return;
        _controlsOpen = true;
        const visit = ++_ctl.visit;
        _emit(EV_CONTROLS, { open: true });
        const list = document.getElementById('five-fret-controls-list');
        const back = document.getElementById('five-fret-controls-back');
        if (back && back !== _ctl.back) {
            _ctl.back = back;
            back.addEventListener('click', () => { if (typeof window.showScreen === 'function') window.showScreen(_ctl.returnTo); });
        }
        _listNote(list, 'Loading…');
        _loadControls().then(({ P, C }) => {
            if (visit !== _ctl.visit || !list) return;
            const gi = _gamepadInput();
            if (!gi) { _listNote(list, 'Controller input is not available in this version of feedBack.'); return; }
            _ctl.screen = C.create({
                P, gamepadInput: gi, list, owner: CONTROLS_OWNER,
                onBindingSaved: (key) => _emit(EV_BINDINGS, { controllerKey: key }),
                onOffsetSaved: (key, ms) => _emit(EV_OFFSET, { controllerKey: key, offsetMs: ms }),
            });
        }).catch((e) => {
            console.error('[5-Fret] controls screen failed to load:', e);
            if (visit === _ctl.visit) _listNote(list, 'The 5-Fret scripts failed to load.');
        });
    }

    function _closeControls() {
        if (!_controlsOpen) return;
        _ctl.visit++;
        if (_ctl.screen) { try { _ctl.screen.destroy(); } catch (e) { console.warn('[5-Fret] controls destroy failed:', e); } }
        _ctl.screen = null;
        _controlsOpen = false;   // after the screen's releases, so renderers claim once, on the event
        _ctl.returnTo = 'home';
        _emit(EV_CONTROLS, { open: false });
    }

    function _onScreenChanged(e) {
        const id = (e && e.detail && e.detail.id) || (e && e.id);
        if (id === SCREEN_ID) _openControls();
        else _closeControls();
    }

    (function _wireControlsScreen() {
        const bus = _bus();
        if (!bus || typeof document === 'undefined' || !document) return;
        bus.on('screen:changed', _onScreenChanged);
        let el = null;
        try { el = document.getElementById(SCREEN_ID); } catch (_) { el = null; }
        if (el && el.classList && el.classList.contains('active')) _openControls();
    })();

    // ── Band API (window.feedBackFiveFret), modelled on window.feedBackDrums ────
    //
    // Build-a-Band pins one renderer per controller lane by its canvas. Pins, and hidden score HUDs,
    // are kept per canvas, so they apply to an instance that inits on the canvas later.

    // profiles.js alone, on demand (listControllers / createMapper need no other asset).
    let _profilesPromise = null;
    function _loadProfiles() {
        if (window.FiveFretProfiles) return Promise.resolve(window.FiveFretProfiles);
        if (_profilesPromise) return _profilesPromise;
        const url = _assetUrl('profiles.js');
        _profilesPromise = _loadScript(url).then(() => {
            if (!window.FiveFretProfiles) throw new Error('profiles.js did not register');
            return window.FiveFretProfiles;
        }).catch((e) => {
            _profilesPromise = null;
            if (!window.FiveFretProfiles) _dropScript(url);
            throw e;
        });
        return _profilesPromise;
    }

    function _canvasArg(canvas) { return !!canvas && typeof canvas === 'object'; }

    // A controller's display name: its id up to the first " (", at most 24 characters, plus " n" for
    // the nth identical one (from its key's #n).
    function _controllerName(id, key) {
        let name = typeof id === 'string' ? id : '';
        const cut = name.indexOf(' (');
        if (cut >= 0) name = name.slice(0, cut);
        name = name.trim().slice(0, 24).trim() || 'Controller';
        const m = typeof key === 'string' ? /#(\d+)$/.exec(key) : null;
        const n = m ? +m[1] : 1;
        return n > 1 ? name + ' ' + n : name;
    }

    // Every gamepad-input entry with its key (core's, else `id#n` among connected identical ones).
    function _controllerEntries(P) {
        const gi = _gamepadInput();
        if (!gi) return [];
        let list;
        try { list = gi.list(); } catch (_) { return []; }
        const nth = Object.create(null);
        const out = [];
        for (const info of list || []) {
            if (!info) continue;
            let key = null;
            if (typeof info.controllerKey === 'string' && info.controllerKey) key = info.controllerKey;
            else if (info.connected) { nth[info.id] = (nth[info.id] || 0) + 1; key = P.controllerKey(info, nth[info.id]); }
            out.push({ info, key });
        }
        return out;
    }

    window.feedBackFiveFret = {
        version: 1,
        // Pin the renderer on `canvas` (now, or the one that inits on it) to one controller, part,
        // difficulty and lefty. false (changing nothing) on bad arguments; calling again updates.
        setLane(canvas, opts) {
            if (!_canvasArg(canvas) || !opts || typeof opts !== 'object') return false;
            const { controllerKey, part, difficulty } = opts;
            const lefty = opts.lefty === undefined ? false : opts.lefty;
            if (typeof controllerKey !== 'string' || !controllerKey) return false;
            if (!Object.prototype.hasOwnProperty.call(LANE_PARTS, part)) return false;
            if (!Object.prototype.hasOwnProperty.call(DIFFICULTY_LABELS, difficulty)) return false;
            if (typeof lefty !== 'boolean') return false;
            _lanes.set(canvas, { controllerKey, part, difficulty, lefty });
            const inst = _byCanvas.get(canvas);
            if (inst) inst._pinChanged();
            return true;
        },
        // Forget the pin: the instance goes back to its own settings and claim order.
        clearLane(canvas) {
            if (!_canvasArg(canvas) || !_lanes.has(canvas)) return;
            _lanes.delete(canvas);
            const inst = _byCanvas.get(canvas);
            if (inst) inst._pinChanged();
        },
        // A pinned lane's difficulty (drums parity). false for an unpinned canvas or a bad id.
        setDifficulty(id, canvas) {
            const lane = _canvasArg(canvas) ? _lanes.get(canvas) : null;
            if (!lane || !Object.prototype.hasOwnProperty.call(DIFFICULTY_LABELS, id)) return false;
            lane.difficulty = id;   // the instance reads it on its next draw
            return true;
        },
        // Hide (true) or show (false) that lane's score, multiplier, streak, SP bar and stars.
        setScoreHudHidden(canvas, hidden) {
            if (!_canvasArg(canvas) || typeof hidden !== 'boolean') return false;
            if (hidden) _scoreHidden.set(canvas, true);
            else _scoreHidden.delete(canvas);
            return true;
        },
        isScoreHudHidden(canvas) { return _canvasArg(canvas) && _scoreHidden.get(canvas) === true; },
        // Engine getState() plus { starThresholds (full chart), partId, instrument, sourceKind,
        // controllerKey, connected }, or null (no instance on the canvas, or no part playing).
        getInstanceState(canvas) {
            const inst = _canvasArg(canvas) ? _byCanvas.get(canvas) : null;
            try { return inst ? inst._bandState() : null; } catch (_) { return null; }
        },
        // Promise of [{ index, controllerKey, id, mapping, name, kind, connected, claimedBy }];
        // kind 'gamepad' | 'guitar', or null when the controller needs setup.
        listControllers() {
            return _loadProfiles().then((P) => {
                const bindings = P.loadBindings();
                return _controllerEntries(P).map(({ info, key }) => {
                    const b = P.resolveBinding(info, key ? bindings[key] : null);
                    return {
                        index: info.index, controllerKey: key, id: info.id, mapping: info.mapping,
                        name: _controllerName(info.id, key),
                        kind: b ? (b.kind === 'gamepad' ? 'gamepad' : 'guitar') : null,
                        connected: !!info.connected, claimedBy: info.claimedBy || null,
                    };
                });
            });
        },
        // Promise of a mapper ({ map(ev) -> [{ action, value }] }) from the controller's resolved
        // binding, or null (unknown key, or a controller that needs setup).
        createMapper(controllerKey) {
            return _loadProfiles().then((P) => {
                if (typeof controllerKey !== 'string' || !controllerKey) return null;
                const entry = _controllerEntries(P).find((e) => e.key === controllerKey);
                const b = P.resolveBinding(entry ? entry.info : null, P.loadBindings()[controllerKey]);
                return b ? P.createMapper(b) : null;
            });
        },
        // Plan 5's "show auto charts" flag (five_fret.settings.v1), default false.
        showAutoCharts: () => _showAutoCharts(),
        // Show the controls screen; its Back button goes to returnTo (default 'home') for this visit.
        openControls(opts) {
            const to = opts && typeof opts.returnTo === 'string' && opts.returnTo ? opts.returnTo : 'home';
            if (typeof window.showScreen !== 'function') return;
            _ctl.returnTo = to;
            window.showScreen(SCREEN_ID);
        },
    };

    function factory() { return createRenderer(); }
    factory.contextType = 'webgl2';
    // three.js loader, a seam the Node tests replace (core's vendored ES module in the app).
    factory.importThree = () => import(THREE_URL);
    window.feedBackViz_five_fret = factory;
    // Auto mode: only a 5-fret-only pack, whose arrangement list is the single placeholder core adds
    // for it (named after the first 5-fret part, no notes). Lives here, not in session.js: Auto mode
    // asks before any instance has loaded the assets.
    window.feedBackViz_five_fret.matchesArrangement = function (songInfo) {
        if (!songInfo || typeof songInfo !== 'object' || songInfo.has_drum_tab) return false;
        const ff = songInfo.five_fret_parts, arrs = songInfo.arrangements;
        if (!Array.isArray(ff) || !ff.length || !Array.isArray(arrs) || arrs.length !== 1) return false;
        const a = arrs[0];
        return !!a && !(a.notes > 0) && !!ff[0] && a.name === ff[0].name;
    };
})();
