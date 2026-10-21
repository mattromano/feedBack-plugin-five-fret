/*
 * screen.js: the feedBack five-fret plugin's highway renderer (window.feedBackViz_five_fret).
 * Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
 *
 * setRenderer contract (core CLAUDE.md "setRenderer contract"): a WebGL2 renderer that draws the tilted
 * 5-fret highway (assets/highway3d.js) for one part of bundle.fiveFretParts, judged by a scoring session
 * (assets/session.js over the engine port in assets/engine.js) fed by one claimed game controller
 * (window.feedBack.gamepadInput, named through assets/profiles.js).
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
 * Also the plugin's controls screen (screen.html, #plugin-five_fret): controller setup, rebinding,
 * input offset and calibration. See "Controls screen" below.
 */
(function () {
    'use strict';

    const PLUGIN_ID = 'five_fret';
    const ASSET_VERSION = '0.1.0';   // cache-buster for the lazily loaded files: bump with releases
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
        el.className = 'five-fret-panel fb-card';
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
            span.className = 'fb-textDim';
            r.appendChild(span);
            r.appendChild(control);
            el.appendChild(r);
            return control;
        };
        const select = (labels) => {
            const s = document.createElement('select');
            s.className = 'fb-card';
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
        link.className = 'fb-primary';
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

        // Controller (handleInfo: its gamepad-input list() entry at claim time, for resolveBinding)
        let handle = null, handleInfo = null, binding = null, mapper = null, connected = false, offChange = null;

        // Session and clock
        let session = null;
        // The picked part, recomputed only when the parts object (identity or key count), the
        // arrangement name or the part setting changes.
        const pick = { parts: null, count: -1, arrangement: null, setting: null, partId: null };
        const statusArgs = { hasParts: false, hasController: false, connected: false };
        // What the session was built from: rebuilt when any of these change (compared field by field,
        // so the steady state allocates nothing).
        const built = { partId: null, part: null, difficulty: null, gamepadMode: null, offsetMs: null,
            notes: null, notesLen: -1, levelNotes: null, levelLen: -1, beats: null, beatsLen: -1 };
        let header = '', headerPart = null, headerSession = null, headerHandle = null, headerBinding = null;
        let lastChartTime = NaN, lastFrameT = NaN, playing = true;
        const noteState = (i) => (session ? session.noteState(i) : null);
        const frame = {
            now: 0, notes: EMPTY, beats: EMPTY, starPower: EMPTY, solos: EMPTY, pressed: NO_PRESSED, whammy: 0,
            noteState, state: null, lefty: false, header: '', sourceKind: '', message: null,
        };

        function countKeys(o) {
            let n = 0;
            for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++;
            return n;
        }
        function pickedPart(parts, arrangement) {
            const count = parts && typeof parts === 'object' ? countKeys(parts) : 0;
            if (pick.parts !== parts || pick.count !== count || pick.arrangement !== arrangement
                || pick.setting !== settings.part) {
                pick.parts = parts; pick.count = count; pick.arrangement = arrangement; pick.setting = settings.part;
                pick.partId = H.pickPart(parts, arrangement, settings.part);
            }
            return pick.partId;
        }

        function gamepadMode() {
            return P ? P.effectiveGamepadMode(settings, binding) : false;
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

        // Claim the first free controller with a resolvable binding (not while the controls screen,
        // which claims controllers itself, is open).
        function tryClaim() {
            if (handle || !P || _controlsOpen) return;
            const gi = _gamepadInput();
            if (!gi) return;
            let list;
            try { list = gi.list(); } catch (_) { return; }
            const bindings = P.loadBindings();
            const nth = Object.create(null);
            for (const info of list) {
                if (!info || !info.connected) continue;
                nth[info.id] = (nth[info.id] || 0) + 1;
                if (info.claimedBy) continue;   // another plugin, or another 5-fret panel
                if (!P.resolveBinding(info, bindings[P.controllerKey(info, nth[info.id])])) continue;
                const h = gi.claim(info.index, PLUGIN_ID);
                if (!h) continue;
                // The claim's controllerKey is the authority (it can differ after renumbering).
                const b = P.resolveBinding(info, bindings[h.controllerKey]);
                if (!b) { h.release(); continue; }
                handle = h;
                handleInfo = info;
                binding = b;
                mapper = P.createMapper(b);
                connected = true;
                h.addListener(onEvent);
                return;
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
            } else if (ev.type === 'connect' || ev.type === 'release') {
                tryClaim();
            }
        }

        // Let go of the claimed controller (frets it held are released in the session).
        function dropHandle() {
            if (!handle) return;
            const h = handle;
            handle = null; handleInfo = null; binding = null; mapper = null; connected = false;
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

        // The controls screen saved a binding or an input offset: re-read both, so a binding or an
        // offset set up mid-session applies now (the session rebuilds when the offset changes).
        function onControlsSaved() {
            if (!P) return;
            settings = Object.assign({}, settings, { offsetMs: P.loadSettings().offsetMs });
            if (!handle) { tryClaim(); return; }
            const b = P.resolveBinding(handleInfo, P.loadBindings()[handle.controllerKey]);
            if (!b) { dropHandle(); tryClaim(); return; }
            if (session) session.releaseAll(H.inputChartTime(lastChartTime, lastFrameT, _wallNow(), 0, playing));
            binding = b;
            mapper = P.createMapper(b);
        }

        // ── Session ──

        function ensureSession(partId, part, beats) {
            const levels = part.levels || {};
            const lv = levels[settings.difficulty];
            const levelNotes = lv && Array.isArray(lv.notes) ? lv.notes : null;
            const gm = gamepadMode();
            const off = offsetMs();
            const b = built;
            if (session && b.partId === partId && b.part === part && b.difficulty === settings.difficulty
                && b.gamepadMode === gm && b.offsetMs === off
                && b.notes === part.notes && b.notesLen === (part.notes ? part.notes.length : -1)
                && b.levelNotes === levelNotes && b.levelLen === (levelNotes ? levelNotes.length : -1)
                && b.beats === beats && b.beatsLen === beats.length) return;
            b.partId = partId; b.part = part; b.difficulty = settings.difficulty; b.gamepadMode = gm; b.offsetMs = off;
            b.notes = part.notes; b.notesLen = part.notes ? part.notes.length : -1;
            b.levelNotes = levelNotes; b.levelLen = levelNotes ? levelNotes.length : -1;
            b.beats = beats; b.beatsLen = beats.length;
            session = H.createSession({
                chart: { notes: part.notes, levels, starPower: part.starPower, solos: part.solos, beats },
                instrument: part.instrument === 'bass' ? 'bass' : 'guitar',
                difficulty: settings.difficulty,
                gamepadMode: gm,
                offsetMs: off,
                pressed: session ? session.pressedFrets() : null,   // frets still held carry over
            });
        }

        // "PART · INPUT · DIFFICULTY", rebuilt only when the part, session, controller or binding changes.
        function headerFor(part) {
            if (part === headerPart && session === headerSession && handle === headerHandle
                && binding === headerBinding) return header;
            headerPart = part; headerSession = session; headerHandle = handle; headerBinding = binding;
            const input = !handle ? 'NO CONTROLLER' : (binding && binding.kind === 'gamepad' ? 'GAMEPAD' : 'GUITAR');
            header = [part.name || part.instrument || '5-Fret', input,
                DIFFICULTY_LABELS[session ? session.difficulty : settings.difficulty] || ''].join(' · ');
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
                [EV_BINDINGS, onControlsSaved], [EV_OFFSET, onControlsSaved]];
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
            _unmountPanel(instance);
            if (view) { try { view.destroy(); } catch (e) { console.warn('[5-Fret] view destroy failed:', e); } }
            view = null;
            if (hud) { try { hud.remove(); } catch (_) { /* gone */ } }
            hud = null;
            canvas = null;
            session = null;
            headerPart = headerSession = headerHandle = headerBinding = null;
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
                    tryClaim();
                    _mountPanel(instance);
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

                frame.now = t;
                frame.notes = session ? session.notes : EMPTY;
                frame.beats = beats;
                frame.starPower = part && Array.isArray(part.starPower) ? part.starPower : EMPTY;
                frame.solos = part && Array.isArray(part.solos) ? part.solos : EMPTY;
                frame.pressed = session ? session.pressedFrets() : NO_PRESSED;
                frame.whammy = session ? session.whammy() : 0;
                frame.state = session ? session.state() : null;
                frame.lefty = !!settings.lefty;
                frame.header = part ? headerFor(part) : '';
                frame.sourceKind = part ? part.sourceKind : '';
                statusArgs.hasParts = !!part;
                statusArgs.hasController = !!handle;
                statusArgs.connected = connected;
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
                return settings[key];
            },
        };
        return instance;
    }

    // ── Controls screen (#plugin-five_fret: setup, rebinding, input offset) ─────
    //
    // Core mounts screen.html as #plugin-five_fret; this wires it per visit from core's
    // screen:changed event. While it is open it claims every free controller as
    // 'five_fret.controls' (renderers, owner 'five_fret', stand aside: EV_CONTROLS), lights each
    // card's buttons and actions from the claim's events, and saves bindings and input offsets
    // through profiles.js, announcing each (EV_BINDINGS, EV_OFFSET) so a running renderer picks it
    // up. Calibrate is the only thing here that makes sound, and only when it is clicked.

    const SCREEN_ID = 'plugin-' + PLUGIN_ID;
    const CONTROLS_OWNER = PLUGIN_ID + '.controls';
    const OFFSET_MIN = -200, OFFSET_MAX = 200, OFFSET_STEP = 5;
    const CAL_CLICKS = 12, CAL_LEAD = 1.0, CAL_INTERVAL = 0.6, CAL_TAIL = 0.5;   // seconds
    const ACTION_LABELS = {
        green: 'Green', red: 'Red', yellow: 'Yellow', blue: 'Blue', orange: 'Orange', open: 'Open',
        strum_down: 'Strum down', strum_up: 'Strum up', whammy: 'Whammy', star_power: 'Star power',
        pause: 'Pause',
    };
    const PROMPTS = {
        strum_down: 'Strum down', strum_up: 'Strum up', whammy: 'Push the whammy bar',
        star_power: 'Press Star power (a button, or tilt the guitar)', pause: 'Press Start (pause)',
    };
    const CHIP_STYLE = 'display:inline-block;min-width:2.2rem;text-align:center;padding:2px 6px;border-radius:6px;'
        + 'font-size:11px;border:1px solid rgba(51,65,85,.8);';
    const CHIP_ON = '#0ea5e9';

    const _ctl = { visit: 0, list: null, back: null, P: null, cards: [], offChange: null, busy: false };

    function _bus() {
        const b = window.feedBack;
        return b && typeof b.on === 'function' && typeof b.emit === 'function' ? b : null;
    }
    function _emit(name, detail) {
        const b = _bus();
        if (b) { try { b.emit(name, detail); } catch (e) { console.warn('[5-Fret] ' + name + ' listener failed:', e); } }
    }

    function _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }
    function _button(label, ff, onClick) {
        const b = _el('button', 'px-3 py-1 rounded-lg border border-fb-border text-fb-text text-sm', label);
        b.type = 'button';
        b.dataset.ff = ff;
        b.addEventListener('click', onClick);
        return b;
    }
    function _setOn(chip, on) {
        const v = on ? '1' : '0';
        if (chip.dataset.on === v) return;
        chip.dataset.on = v;
        chip.style.background = on ? CHIP_ON : '';
        chip.style.color = on ? '#fff' : '';
    }
    function _clampOffset(v) {
        return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, Math.round(v / OFFSET_STEP) * OFFSET_STEP));
    }
    // The browser's own state of one controller (axis rests, button count), or null.
    function _pad(index) {
        try {
            const nav = window.navigator;
            const pads = nav && typeof nav.getGamepads === 'function' ? nav.getGamepads() : null;
            return pads && pads[index] ? pads[index] : null;
        } catch (_) { return null; }
    }

    function _listMessage(text) {
        if (!_ctl.list) return;
        const p = _el('p', 'text-fb-textDim text-sm', text);
        _ctl.list.replaceChildren(p);
    }

    // ── One card per controller ──

    function _rawChip(card, type, index) {
        const arr = type === 'button' ? card.rawButtons : card.rawAxes;
        if (arr[index]) return arr[index];
        const chip = _el('span', '', (type === 'button' ? 'B' : 'A') + index);
        chip.style.cssText = CHIP_STYLE;
        chip.dataset.ff = 'raw-' + type + '-' + index;
        chip.dataset.on = '0';
        arr[index] = chip;
        card.rawRow.appendChild(chip);
        return chip;
    }

    function _statusText(card) {
        const b = card.binding;
        if (!b) return 'Not set up: choose Set up as guitar or Set up as gamepad.';
        const stored = !!card.stored;
        if (b.kind === 'gamepad') return stored ? 'Set up as a gamepad.' : 'Gamepad (standard layout).';
        return 'Set up as a guitar.';
    }
    function _refreshCard(card) {
        card.status.textContent = _statusText(card);
        card.rebind.disabled = !card.binding;
        card.calibrate.disabled = !card.binding || !!card.recorder;   // strums are read through the binding
    }

    function _setPrompt(card, text) {
        card.promptText.textContent = text || '';
        card.prompt.hidden = !text;
    }
    function _promptFor(action) {
        return PROMPTS[action] || ('Press ' + (ACTION_LABELS[action] || action));
    }

    function _startRecording(card, kind, actions, single) {
        if (!_ctl.P) return;
        _stopCalibration(card, '');
        const pad = _pad(card.index);
        const rest = {};
        if (pad && pad.axes) for (let i = 0; i < pad.axes.length; i++) rest[i] = Number(pad.axes[i]) || 0;
        const used = [];
        if (single && card.binding) {
            for (const a of Object.keys(card.binding.map)) if (a !== single) used.push(card.binding.map[a]);
        }
        card.recorder = _ctl.P.createSetupRecorder(actions, { rest, used });
        card.recording = { kind, single };
        card.calibrate.disabled = true;
        _setPrompt(card, _promptFor(card.recorder.next));
    }

    function _endRecording(card, message) {
        card.recorder = null;
        card.recording = null;
        _setPrompt(card, null);
        _refreshCard(card);
        if (message) card.status.textContent = message;
    }

    function _recorderStep(card, r) {
        if (!r.done) { _setPrompt(card, _promptFor(r.next)); return; }
        const P = _ctl.P;
        const mode = card.recording;
        const map = mode.single && card.binding
            ? Object.assign({}, card.binding.map, r.binding.map)
            : r.binding.map;
        if (!Object.keys(r.binding.map).length) { _endRecording(card, 'Nothing recorded, so nothing was saved.'); return; }
        const binding = { kind: mode.single && card.binding ? card.binding.kind : mode.kind, map };
        if (!P.saveBinding(card.key, binding)) { _endRecording(card, 'Could not save: browser storage is unavailable.'); return; }
        card.binding = binding;
        card.stored = true;
        card.mapper = P.createMapper(binding);
        _endRecording(card, null);
        _emit(EV_BINDINGS, { controllerKey: card.key });
    }

    function _onOffsetChange(card) {
        const P = _ctl.P;
        const stored = P.loadSettings().offsetMs[card.key];
        const v = Number(card.offset.value);
        if (card.offset.value === '' || !Number.isFinite(v)) {
            card.offset.value = String(Number.isFinite(stored) ? stored : 0);
            return;
        }
        _saveOffset(card, _clampOffset(v));
    }
    function _saveOffset(card, ms) {
        card.offset.value = String(ms);
        _ctl.P.setOffset(card.key, ms);
        _emit(EV_OFFSET, { controllerKey: card.key, offsetMs: ms });
    }

    // ── Calibrate (plays clicks: only from its button) ──

    // Performance time (seconds) at which audio scheduled at context time `at` is heard.
    function _heardAt(ctx, at) {
        try {
            const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
            if (ts && Number.isFinite(ts.contextTime) && ts.performanceTime > 0) {
                return ts.performanceTime / 1000 + (at - ts.contextTime);
            }
        } catch (_) { /* fall through */ }
        return _wallNow() + (at - ctx.currentTime) + (+ctx.baseLatency || 0) + (+ctx.outputLatency || 0);
    }
    function _click(ctx, at) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 1500;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.4, at + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.05);
    }

    function _startCalibration(card) {
        if (card.calib || card.recorder || !card.binding) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (typeof AC !== 'function') { card.calibStatus.textContent = 'No audio output here to play the clicks.'; return; }
        let ctx = null;
        try {
            ctx = new AC();
            if (typeof ctx.resume === 'function') ctx.resume().catch(() => {});
            const t0 = (+ctx.currentTime || 0) + CAL_LEAD;
            const clicks = [];
            for (let i = 0; i < CAL_CLICKS; i++) {
                const at = t0 + i * CAL_INTERVAL;
                _click(ctx, at);
                clicks.push(at);
            }
            card.calib = { ctx, clicks, strums: [], timer: null };
        } catch (e) {
            console.warn('[5-Fret] calibration audio failed:', e);
            try { if (ctx) ctx.close(); } catch (_) { /* ignore */ }
            card.calibStatus.textContent = 'Could not play the clicks.';
            return;
        }
        const ms = (CAL_LEAD + (CAL_CLICKS - 1) * CAL_INTERVAL + CAL_TAIL) * 1000;
        card.calib.timer = setTimeout(() => _finishCalibration(card), ms);
        card.calibrate.textContent = 'Stop';
        card.calibStatus.textContent = 'Strum along to the clicks…';
    }

    // Stop the clicks; message (if any) replaces the calibration status.
    function _stopCalibration(card, message) {
        const c = card.calib;
        if (!c) return;
        card.calib = null;
        if (c.timer) clearTimeout(c.timer);
        try { const p = c.ctx.close(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) { /* ignore */ }
        card.calibrate.textContent = 'Calibrate';
        if (message !== null) card.calibStatus.textContent = message;
    }

    function _finishCalibration(card) {
        const c = card.calib;
        if (!c) return;
        const heard = c.clicks.map((at) => _heardAt(c.ctx, at));
        const ms = _ctl.P.calibrationOffset(heard, c.strums);
        if (ms === null) { _stopCalibration(card, 'No strums near the clicks: try again.'); return; }
        const v = _clampOffset(ms);
        _stopCalibration(card, 'Input offset set to ' + v + ' ms.');
        _saveOffset(card, v);
    }

    // A press that counts as a strum while calibrating: strums, and on a gamepad frets too.
    function _calibrationInput(action, binding) {
        if (action === 'strum_down' || action === 'strum_up') return true;
        return !!binding && binding.kind === 'gamepad'
            && (action === 'green' || action === 'red' || action === 'yellow' || action === 'blue'
                || action === 'orange' || action === 'open');
    }

    function _onCardEvent(card, ev) {
        if (!ev || !Number.isInteger(ev.index)) return;
        // Raw lights.
        if (ev.type === 'button') {
            _setOn(_rawChip(card, 'button', ev.index), !!ev.pressed || Number(ev.value) >= 0.5);
        } else if (ev.type === 'axis') {
            const chip = _rawChip(card, 'axis', ev.index);
            const v = Number(ev.value) || 0;
            chip.textContent = 'A' + ev.index + ' ' + v.toFixed(2);
            _setOn(chip, Math.abs(v - (card.axisRest[ev.index] || 0)) > 0.5);
        }
        // Action lights (and calibration strums) through the current binding.
        if (card.mapper) {
            const out = card.mapper.map(ev);
            for (let i = 0; i < out.length; i++) {
                const a = out[i];
                const chip = card.actionChips[a.action];
                if (chip) _setOn(chip, a.action === 'whammy' ? a.value > 0.5 : !!a.value);
                if (card.calib && a.value && _calibrationInput(a.action, card.binding)
                    && Number.isFinite(ev.t)) card.calib.strums.push(ev.t);
            }
        }
        if (card.recorder) {
            const r = card.recorder.feed(ev);
            if (r.recorded || r.done) _recorderStep(card, r);
        }
    }

    function _buildCard(gi, info, nth, bindings, settings) {
        const P = _ctl.P;
        const card = {
            index: info.index, key: null, handle: null, binding: null, stored: false, mapper: null,
            rawButtons: [], rawAxes: [], axisRest: [], actionChips: {}, recorder: null, recording: null, calib: null,
        };
        let h = null;
        if (!info.claimedBy) {
            _ctl.busy = true;
            try { h = gi.claim(info.index, CONTROLS_OWNER); } catch (_) { h = null; } finally { _ctl.busy = false; }
        }
        card.key = h ? h.controllerKey : P.controllerKey(info, nth);
        card.stored = !!bindings[card.key];
        card.binding = P.resolveBinding(info, bindings[card.key]);
        card.mapper = card.binding ? P.createMapper(card.binding) : null;

        const el = _el('section', 'bg-fb-card border border-fb-border rounded-xl p-4 mb-4');
        el.dataset.ff = 'card';
        const title = _el('div', 'text-fb-text font-semibold truncate', info.id);
        card.status = _el('div', 'text-fb-textDim text-sm mt-1');
        card.status.dataset.ff = 'status';
        el.append(title, card.status);
        if (!h) {
            card.status.textContent = info.claimedBy
                ? 'In use by ' + info.claimedBy + '.'
                : 'Could not use this controller.';
            card.el = el;
            return card;
        }
        card.handle = h;

        // Lights: actions (through the binding), then raw buttons and axes.
        const actionRow = _el('div', 'flex flex-wrap gap-1 mt-2');
        for (const a of P.ACTIONS) {
            const chip = _el('span', '', ACTION_LABELS[a] || a);
            chip.style.cssText = CHIP_STYLE;
            chip.dataset.ff = 'action-' + a;
            chip.dataset.on = '0';
            card.actionChips[a] = chip;
            actionRow.appendChild(chip);
        }
        card.rawRow = _el('div', 'flex flex-wrap gap-1 mt-2');
        const pad = _pad(info.index);
        if (pad) {
            for (let i = 0; i < (pad.buttons ? pad.buttons.length : 0); i++) _rawChip(card, 'button', i);
            for (let i = 0; i < (pad.axes ? pad.axes.length : 0); i++) {
                card.axisRest[i] = Number(pad.axes[i]) || 0;
                _rawChip(card, 'axis', i);
            }
        }
        el.append(actionRow, card.rawRow);

        // Setup.
        const setupRow = _el('div', 'flex flex-wrap items-center gap-2 mt-2');
        setupRow.append(
            _button('Set up as guitar', 'setup-guitar', () => _startRecording(card, 'guitar', P.SETUP_ACTIONS.guitar, null)),
            _button('Set up as gamepad', 'setup-gamepad', () => _startRecording(card, 'gamepad', P.SETUP_ACTIONS.gamepad, null)),
        );
        card.prompt = _el('div', 'flex flex-wrap items-center gap-2 mt-2');
        card.prompt.dataset.ff = 'prompt';
        card.promptText = _el('span', 'text-fb-text font-semibold');
        card.promptText.dataset.ff = 'prompt-text';
        card.prompt.append(card.promptText,
            _button('Skip', 'skip', () => { if (card.recorder) _recorderStep(card, card.recorder.skip()); }),
            _button('Cancel', 'cancel', () => { if (card.recorder) _endRecording(card, 'Setup cancelled.'); }));
        card.prompt.hidden = true;

        // Rebind one action.
        const rebindRow = _el('div', 'flex flex-wrap items-center gap-2 mt-2');
        card.rebindAction = _el('select', 'bg-fb-bg border border-fb-border rounded text-fb-text text-sm px-2 py-1');
        card.rebindAction.dataset.ff = 'rebind-action';
        for (const a of P.ACTIONS) {
            const o = _el('option', '', ACTION_LABELS[a] || a);
            o.value = a;
            card.rebindAction.appendChild(o);
        }
        card.rebindAction.value = P.ACTIONS[0];
        card.rebind = _button('Rebind', 'rebind', () => {
            const a = card.rebindAction.value;
            if (card.binding && ACTION_LABELS[a]) _startRecording(card, card.binding.kind, [a], a);
        });
        rebindRow.append(_el('span', 'text-fb-textDim text-sm', 'Rebind'), card.rebindAction, card.rebind);

        // Input offset and Calibrate.
        const offsetRow = _el('div', 'flex flex-wrap items-center gap-2 mt-2');
        card.offset = _el('input', 'bg-fb-bg border border-fb-border rounded text-fb-text text-sm px-2 py-1 w-24');
        card.offset.type = 'number';
        card.offset.min = String(OFFSET_MIN);
        card.offset.max = String(OFFSET_MAX);
        card.offset.step = String(OFFSET_STEP);
        card.offset.dataset.ff = 'offset';
        const off = settings.offsetMs[card.key];
        card.offset.value = String(Number.isFinite(off) ? off : 0);
        card.offset.addEventListener('change', () => _onOffsetChange(card));
        card.calibrate = _button('Calibrate', 'calibrate', () => {
            if (card.calib) _stopCalibration(card, 'Calibration stopped.');
            else _startCalibration(card);
        });
        offsetRow.append(_el('span', 'text-fb-textDim text-sm', 'Input offset (ms)'), card.offset, card.calibrate);
        const note = _el('div', 'text-fb-textDim text-xs mt-1',
            'Calibrate plays clicks: strum along to them and the input offset is set from how late or early you are.');
        note.dataset.ff = 'calibrate-note';
        card.calibStatus = _el('div', 'text-fb-textDim text-xs mt-1');
        card.calibStatus.dataset.ff = 'calib-status';

        el.append(setupRow, card.prompt, rebindRow, offsetRow, note, card.calibStatus);
        card.el = el;
        _refreshCard(card);
        card.onEvent = (ev) => _onCardEvent(card, ev);
        h.addListener(card.onEvent);
        return card;
    }

    // Release every claim and stop everything the cards started.
    function _clearCards() {
        const cards = _ctl.cards;
        _ctl.cards = [];
        for (const card of cards) {
            _stopCalibration(card, null);
            card.recorder = null;
            if (card.handle) {
                _ctl.busy = true;
                try { card.handle.removeListener(card.onEvent); card.handle.release(); } catch (_) { /* ignore */ }
                finally { _ctl.busy = false; }
                card.handle = null;
            }
        }
        if (_ctl.list) _ctl.list.replaceChildren();
    }

    function _renderCards() {
        _clearCards();
        const gi = _gamepadInput();
        const P = _ctl.P;
        if (!gi || !P || !_ctl.list) return;
        let list = [];
        try { list = gi.list() || []; } catch (_) { list = []; }
        const bindings = P.loadBindings();
        const settings = P.loadSettings();
        const nth = Object.create(null);
        for (const info of list) {
            if (!info || !info.connected) continue;
            nth[info.id] = (nth[info.id] || 0) + 1;
            const card = _buildCard(gi, info, nth[info.id], bindings, settings);
            _ctl.cards.push(card);
            _ctl.list.appendChild(card.el);
        }
        if (!_ctl.cards.length) _listMessage('No controllers found. Connect one and press any button on it.');
    }

    // Controllers came, went, or another plugin claimed or released one: list them again.
    function _onControlsChange(ev) {
        if (_ctl.busy || !_controlsOpen || !ev) return;
        _renderCards();
    }

    function _openControls() {
        if (_controlsOpen) return;
        _controlsOpen = true;
        const visit = ++_ctl.visit;
        _emit(EV_CONTROLS, { open: true });
        _ctl.list = document.getElementById('five-fret-controls-list');
        const back = document.getElementById('five-fret-controls-back');
        if (back && back !== _ctl.back) {
            _ctl.back = back;
            back.addEventListener('click', () => { if (typeof window.showScreen === 'function') window.showScreen('home'); });
        }
        _listMessage('Loading…');
        _loadModules().then((m) => {
            if (visit !== _ctl.visit || !_controlsOpen) return;
            _ctl.P = m.P;
            const gi = _gamepadInput();
            if (!gi) { _listMessage('Controller input is not available in this version of feedBack.'); return; }
            _ctl.offChange = gi.on('change', _onControlsChange);
            _renderCards();
        }).catch((e) => {
            console.error('[5-Fret] controls screen failed to load:', e);
            if (visit === _ctl.visit) _listMessage('The 5-Fret scripts failed to load.');
        });
    }

    function _closeControls() {
        if (!_controlsOpen) return;
        _ctl.visit++;
        if (_ctl.offChange) { try { _ctl.offChange(); } catch (_) { /* ignore */ } _ctl.offChange = null; }
        _clearCards();
        _controlsOpen = false;
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
