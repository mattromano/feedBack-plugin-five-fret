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

        // Controller
        let handle = null, binding = null, mapper = null, connected = false, offChange = null;

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
        let header = '', headerPart = null, headerSession = null, headerHandle = null;
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

        // Claim the first free controller with a resolvable binding.
        function tryClaim() {
            if (handle || !P) return;
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

        function releaseController() {
            if (offChange) { try { offChange(); } catch (_) { /* ignore */ } offChange = null; }
            if (handle) {
                try { handle.removeListener(onEvent); handle.release(); } catch (_) { /* ignore */ }
            }
            handle = null; binding = null; mapper = null; connected = false;
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

        // "PART · INPUT · DIFFICULTY", rebuilt only when the part, session or controller changes.
        function headerFor(part) {
            if (part === headerPart && session === headerSession && handle === headerHandle) return header;
            headerPart = part; headerSession = session; headerHandle = handle;
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
            try { if (on) bus.on('highway:visibility', onVisibility); else bus.off('highway:visibility', onVisibility); } catch (_) { /* ignore */ }
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
            headerPart = headerSession = headerHandle = null;
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
