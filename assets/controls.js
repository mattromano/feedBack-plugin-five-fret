/*
 * controls.js: the feedBack five-fret plugin's controls screen (#plugin-five_fret): controller
 * setup, rebinding, input offset and calibration. screen.js opens and closes it (core's
 * screen:changed) and loads this file with the other assets.
 * Copyright (c) the feedBack five-fret plugin contributors. MIT license (see README.md).
 *
 *   FiveFretControls.create({ P, gamepadInput, list, owner, onBindingSaved(key), onOffsetSaved(key, ms) })
 *     -> { refresh(), destroy() }
 *
 * P is profiles.js; list the element the controller cards go in. While it exists it claims every free
 * connected controller as `owner`, lights each card's buttons, axes and actions from the claim's
 * events (event-driven, cached elements, no DOM queries), and saves bindings and input offsets through
 * P, calling onBindingSaved / onOffsetSaved after each. When controllers come and go (gamepad-input
 * change events) it reconciles the cards: a controller still connected keeps its card, claim, setup
 * and calibration. Calibrate is the only thing here that makes sound, and only when it is clicked.
 *
 * Shared with screen.js's in-song quick settings (feedBackFiveFret.mountQuickSettings):
 *   quickSettingsModel({ parts, playing, current, controllerKey, offsetMs, showAuto }) -> which controls
 *     show and with what values (pure; see below); parseOffset(raw) -> ms (step 5, ±200) or null;
 *   offsetInput() -> the input offset <input> both screens use.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (typeof window !== 'undefined' && window) window.FiveFretControls = api;
    else if (typeof module !== 'object' && root) root.FiveFretControls = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

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

    function wallNow() { return performance.now() / 1000; }
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }
    function button(label, ff, onClick) {
        const b = el('button', 'px-3 py-1 rounded-lg border border-fb-border text-fb-text text-sm', label);
        b.type = 'button';
        b.dataset.ff = ff;
        b.addEventListener('click', onClick);
        return b;
    }
    function setOn(chip, on) {
        const v = on ? '1' : '0';
        if (chip.dataset.on === v) return;
        chip.dataset.on = v;
        chip.style.background = on ? CHIP_ON : '';
        chip.style.color = on ? '#fff' : '';
    }
    function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
    function clampOffset(v) {
        return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, Math.round(v / OFFSET_STEP) * OFFSET_STEP));
    }
    // An offset field's value as ms (stepped and clamped), or null when it holds no number.
    function parseOffset(raw) {
        if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
        const v = Number(raw);
        return Number.isFinite(v) ? clampOffset(v) : null;
    }
    // The input offset field (ms), as the controls screen and the quick settings show it.
    function offsetInput() {
        const input = el('input', 'bg-fb-bg border border-fb-border rounded text-fb-text text-sm px-2 py-1 w-24');
        input.type = 'number';
        input.min = String(OFFSET_MIN);
        input.max = String(OFFSET_MAX);
        input.step = String(OFFSET_STEP);
        return input;
    }

    // ── Quick settings model (pure) ──

    const DIFFICULTIES = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['expert', 'Expert']];
    const PARTS = [['guitar', 'Guitar'], ['rhythm', 'Rhythm'], ['bass', 'Bass']];
    /**
     * Which in-song controls show, and their values.
     *   parts: the song's bundle.fiveFretParts (or null before it loads); playing: the instrument of the
     *   part being played, or null; current: { part, difficulty, lefty } (the instance's settings, or a
     *   band lane's pin); controllerKey: whose input offset to show (null hides it); offsetMs: the saved
     *   offsets by controller key; showAuto: "Show auto charts" (auto parts are offered only then).
     * -> { difficulty: { value, options }, part: { value, options } | null, lefty: { value },
     *      offset: { controllerKey, value, min, max, step } | null }
     * part options are the instruments the song has (guitar, rhythm, bass order; auto: true when only
     * an auto chart has it). part is null when there is nothing to switch to: no parts, or only the
     * one playing. value is null when none of the options is selected (a lane pinned to a part the
     * song lacks).
     */
    function quickSettingsModel(o) {
        o = o || {};
        const cur = o.current && typeof o.current === 'object' ? o.current : {};
        const has = (list, id) => typeof id === 'string' && list.some((x) => (Array.isArray(x) ? x[0] : x.id) === id);
        const difficulty = {
            value: has(DIFFICULTIES, cur.difficulty) ? cur.difficulty : 'expert',
            options: DIFFICULTIES.map(([id, label]) => ({ id, label })),
        };
        const kinds = Object.create(null);   // instrument -> 'chart' | 'auto'
        const parts = o.parts && typeof o.parts === 'object' ? o.parts : {};
        for (const id of Object.keys(parts)) {
            const p = parts[id];
            if (!p || typeof p !== 'object' || !has(PARTS, p.instrument)) continue;
            const auto = p.sourceKind === 'auto';
            if (auto && !o.showAuto) continue;
            if (!auto) kinds[p.instrument] = 'chart';
            else if (!kinds[p.instrument]) kinds[p.instrument] = 'auto';
        }
        const options = PARTS.filter(([id]) => kinds[id]).map(([id, label]) => ({ id, label, auto: kinds[id] === 'auto' }));
        let part = null;
        if (options.length) {
            let value = null;
            if (o.playing && has(options, o.playing)) value = o.playing;
            else if (has(options, cur.part)) value = cur.part;
            else if (!o.playing && !o.lane) value = options[0].id;
            if (options.length > 1 || value === null) part = { value, options };
        }
        const key = typeof o.controllerKey === 'string' && o.controllerKey ? o.controllerKey : null;
        const off = key && o.offsetMs && typeof o.offsetMs === 'object' ? o.offsetMs[key] : 0;
        return {
            difficulty,
            part,
            lefty: { value: cur.lefty === true },
            offset: key ? { controllerKey: key, value: Number.isFinite(off) ? off : 0,
                min: OFFSET_MIN, max: OFFSET_MAX, step: OFFSET_STEP } : null,
        };
    }
    // The browser's own state of one controller (axis rests, button count), or null.
    function browserPad(index) {
        try {
            const nav = window.navigator;
            const pads = nav && typeof nav.getGamepads === 'function' ? nav.getGamepads() : null;
            return pads && pads[index] ? pads[index] : null;
        } catch (_) { return null; }
    }
    function promptFor(action) { return PROMPTS[action] || ('Press ' + (ACTION_LABELS[action] || action)); }

    // ── Calibrate audio ──

    // Performance time (seconds) at which audio scheduled at context time `at` is heard.
    function heardAt(ctx, at) {
        try {
            const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
            if (ts && Number.isFinite(ts.contextTime) && ts.performanceTime > 0) {
                return ts.performanceTime / 1000 + (at - ts.contextTime);
            }
        } catch (_) { /* fall through */ }
        return wallNow() + (at - ctx.currentTime) + (+ctx.baseLatency || 0) + (+ctx.outputLatency || 0);
    }
    function scheduleClick(ctx, at) {
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
    // A press that counts as a strum while calibrating: strums, and on a gamepad frets too.
    function calibrationInput(action, binding) {
        if (action === 'strum_down' || action === 'strum_up') return true;
        return !!binding && binding.kind === 'gamepad'
            && (action === 'green' || action === 'red' || action === 'yellow' || action === 'blue'
                || action === 'orange' || action === 'open');
    }

    function create(opts) {
        const P = opts.P;
        const gi = opts.gamepadInput;
        const list = opts.list;
        const owner = opts.owner;
        const onBindingSaved = typeof opts.onBindingSaved === 'function' ? opts.onBindingSaved : () => {};
        const onOffsetSaved = typeof opts.onOffsetSaved === 'function' ? opts.onOffsetSaved : () => {};
        let cards = [];
        let busy = false;      // our own claim/release: ignore the change events they fire
        let destroyed = false;
        const message = el('p', 'text-fb-textDim text-sm');

        function claim(index) {
            busy = true;
            try { return gi.claim(index, owner); } catch (_) { return null; } finally { busy = false; }
        }
        function release(handle) {
            busy = true;
            try { handle.release(); } catch (_) { /* ignore */ } finally { busy = false; }
        }

        // ── One card ──

        function rawChip(card, type, index) {
            const arr = type === 'button' ? card.rawButtons : card.rawAxes;
            if (arr[index]) return arr[index];
            const chip = el('span', '', (type === 'button' ? 'B' : 'A') + index);
            chip.style.cssText = CHIP_STYLE;
            chip.dataset.ff = 'raw-' + type + '-' + index;
            chip.dataset.on = '0';
            arr[index] = chip;
            card.rawRow.appendChild(chip);
            return chip;
        }

        function statusText(card) {
            const b = card.binding;
            if (!b) return 'Not set up: choose Set up as guitar or Set up as gamepad.';
            if (b.kind === 'gamepad') return card.stored ? 'Set up as a gamepad.' : 'Gamepad (standard layout).';
            return 'Set up as a guitar.';
        }
        function refreshCard(card) {
            card.status.textContent = statusText(card);
            card.rebind.disabled = !card.binding;
            card.calibrate.disabled = !card.binding || !!card.recorder;   // strums are read through the binding
        }
        function setPrompt(card, text) {
            card.promptText.textContent = text || '';
            card.prompt.hidden = !text;
        }

        function startRecording(card, kind, actions, single) {
            stopCalibration(card, '');
            const pad = browserPad(card.index);
            const rest = {};
            if (pad && pad.axes) for (let i = 0; i < pad.axes.length; i++) rest[i] = Number(pad.axes[i]) || 0;
            const used = [];
            if (single && card.binding) {
                for (const a of Object.keys(card.binding.map)) if (a !== single) used.push(card.binding.map[a]);
            }
            card.recorder = P.createSetupRecorder(actions, { rest, used });
            card.recording = { kind, single };
            card.calibrate.disabled = true;
            setPrompt(card, promptFor(card.recorder.next));
        }
        function endRecording(card, text) {
            card.recorder = null;
            card.recording = null;
            setPrompt(card, null);
            refreshCard(card);
            if (text) card.status.textContent = text;
        }
        function recorderStep(card, r) {
            if (!r.done) { setPrompt(card, promptFor(r.next)); return; }
            const mode = card.recording;
            if (!Object.keys(r.binding.map).length) { endRecording(card, 'Nothing recorded, so nothing was saved.'); return; }
            const merge = mode.single && card.binding;
            const binding = {
                kind: merge ? card.binding.kind : mode.kind,
                map: merge ? Object.assign({}, card.binding.map, r.binding.map) : r.binding.map,
            };
            if (!P.saveBinding(card.key, binding)) { endRecording(card, 'Could not save: browser storage is unavailable.'); return; }
            card.binding = binding;
            card.stored = true;
            card.mapper = P.createMapper(binding);
            endRecording(card, null);
            onBindingSaved(card.key);
        }

        function saveOffset(card, ms) {
            card.offset.value = String(ms);
            P.setOffset(card.key, ms);
            onOffsetSaved(card.key, ms);
        }
        function onOffsetChange(card) {
            const ms = parseOffset(card.offset.value);
            if (ms === null) {
                const stored = P.loadSettings().offsetMs[card.key];
                card.offset.value = String(Number.isFinite(stored) ? stored : 0);
                return;
            }
            saveOffset(card, ms);
        }

        // ── Calibrate (plays clicks: only from its button) ──

        function startCalibration(card) {
            if (card.calib || card.recorder || !card.binding) return;
            const AC = window.AudioContext || window.webkitAudioContext;
            if (typeof AC !== 'function') { card.calibStatus.textContent = 'No audio output here to play the clicks.'; return; }
            let ctx;
            try { ctx = new AC(); } catch (e) {
                console.warn('[5-Fret] calibration audio failed:', e);
                card.calibStatus.textContent = 'Could not play the clicks.';
                return;
            }
            const calib = { ctx, clicks: [], strums: [], timer: null };
            card.calib = calib;
            card.calibrate.textContent = 'Stop';
            card.calibStatus.textContent = 'Strum along to the clicks…';
            let resumed;
            try { resumed = Promise.resolve(typeof ctx.resume === 'function' ? ctx.resume() : null); }
            catch (_) { resumed = Promise.resolve(); }
            // Schedule from the context's clock once it runs, so the lead-in is a real lead-in.
            resumed.catch(() => {}).then(() => {
                if (card.calib !== calib) return;   // stopped meanwhile
                try {
                    const t0 = (+ctx.currentTime || 0) + CAL_LEAD;
                    for (let i = 0; i < CAL_CLICKS; i++) {
                        const at = t0 + i * CAL_INTERVAL;
                        scheduleClick(ctx, at);
                        calib.clicks.push(at);
                    }
                } catch (e) {
                    console.warn('[5-Fret] calibration audio failed:', e);
                    stopCalibration(card, 'Could not play the clicks.');
                    return;
                }
                calib.timer = setTimeout(() => finishCalibration(card),
                    (CAL_LEAD + (CAL_CLICKS - 1) * CAL_INTERVAL + CAL_TAIL) * 1000);
            });
        }
        // Stop the clicks; text (if not null) replaces the calibration status.
        function stopCalibration(card, text) {
            const c = card.calib;
            if (!c) return;
            card.calib = null;
            if (c.timer) clearTimeout(c.timer);
            try { const p = c.ctx.close(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) { /* ignore */ }
            card.calibrate.textContent = 'Calibrate';
            if (text !== null) card.calibStatus.textContent = text;
        }
        function finishCalibration(card) {
            const c = card.calib;
            if (!c) return;
            const heard = c.clicks.map((at) => heardAt(c.ctx, at));
            const ms = P.calibrationOffset(heard, c.strums);
            if (ms === null) { stopCalibration(card, 'No strums near the clicks: try again.'); return; }
            const v = clampOffset(ms);
            stopCalibration(card, 'Input offset set to ' + v + ' ms.');
            saveOffset(card, v);
        }

        function onCardEvent(card, ev) {
            if (!ev || !Number.isInteger(ev.index)) return;
            if (ev.type === 'button') {
                setOn(rawChip(card, 'button', ev.index), !!ev.pressed || Number(ev.value) >= 0.5);
            } else if (ev.type === 'axis') {
                const chip = rawChip(card, 'axis', ev.index);
                const v = Number(ev.value) || 0;
                // Rest: the browser's state at build time, else the first value the axis reports.
                if (!Number.isFinite(card.axisRest[ev.index])) card.axisRest[ev.index] = v;
                setText(chip, 'A' + ev.index + ' ' + v.toFixed(2));
                setOn(chip, Math.abs(v - card.axisRest[ev.index]) > 0.5);
            }
            if (card.mapper) {
                const out = card.mapper.map(ev);
                for (let i = 0; i < out.length; i++) {
                    const a = out[i];
                    const chip = card.actionChips[a.action];
                    if (chip) setOn(chip, a.action === 'whammy' ? a.value > 0.5 : !!a.value);
                    if (card.calib && a.value && calibrationInput(a.action, card.binding)
                        && Number.isFinite(ev.t)) card.calib.strums.push(ev.t);
                }
            }
            if (card.recorder) {
                const r = card.recorder.feed(ev);
                if (r.recorded || r.done) recorderStep(card, r);
            }
        }

        function buildCard(info, nth, bindings, settings) {
            const card = {
                index: info.index, id: info.id, claimedBy: info.claimedBy || null, key: null, handle: null,
                binding: null, stored: false, mapper: null, rawButtons: [], rawAxes: [], axisRest: [],
                actionChips: {}, recorder: null, recording: null, calib: null, onEvent: null,
            };
            const h = info.claimedBy ? null : claim(info.index);
            card.key = h ? h.controllerKey : P.controllerKey(info, nth);
            card.stored = !!bindings[card.key];
            card.binding = P.resolveBinding(info, bindings[card.key]);
            card.mapper = card.binding ? P.createMapper(card.binding) : null;

            const root = el('section', 'bg-fb-card border border-fb-border rounded-xl p-4 mb-4');
            root.dataset.ff = 'card';
            card.el = root;
            card.status = el('div', 'text-fb-textDim text-sm mt-1');
            card.status.dataset.ff = 'status';
            root.append(el('div', 'text-fb-text font-semibold truncate', info.id), card.status);
            if (!h) {
                card.status.textContent = info.claimedBy ? 'In use by ' + info.claimedBy + '.' : 'Could not use this controller.';
                return card;
            }
            card.handle = h;
            card.claimedBy = owner;

            // Lights: actions (through the binding), then raw buttons and axes.
            const actionRow = el('div', 'flex flex-wrap gap-1 mt-2');
            for (const a of P.ACTIONS) {
                const chip = el('span', '', ACTION_LABELS[a] || a);
                chip.style.cssText = CHIP_STYLE;
                chip.dataset.ff = 'action-' + a;
                chip.dataset.on = '0';
                card.actionChips[a] = chip;
                actionRow.appendChild(chip);
            }
            card.rawRow = el('div', 'flex flex-wrap gap-1 mt-2');
            const pad = browserPad(info.index);
            if (pad) {
                for (let i = 0; i < (pad.buttons ? pad.buttons.length : 0); i++) rawChip(card, 'button', i);
                for (let i = 0; i < (pad.axes ? pad.axes.length : 0); i++) {
                    card.axisRest[i] = Number(pad.axes[i]) || 0;
                    rawChip(card, 'axis', i);
                }
            }
            root.append(actionRow, card.rawRow);

            // Setup.
            const setupRow = el('div', 'flex flex-wrap items-center gap-2 mt-2');
            setupRow.append(
                button('Set up as guitar', 'setup-guitar', () => startRecording(card, 'guitar', P.SETUP_ACTIONS.guitar, null)),
                button('Set up as gamepad', 'setup-gamepad', () => startRecording(card, 'gamepad', P.SETUP_ACTIONS.gamepad, null)),
            );
            card.prompt = el('div', 'flex flex-wrap items-center gap-2 mt-2');
            card.prompt.dataset.ff = 'prompt';
            card.promptText = el('span', 'text-fb-text font-semibold');
            card.promptText.dataset.ff = 'prompt-text';
            card.prompt.append(card.promptText,
                button('Skip', 'skip', () => { if (card.recorder) recorderStep(card, card.recorder.skip()); }),
                button('Cancel', 'cancel', () => { if (card.recorder) endRecording(card, 'Setup cancelled.'); }));
            card.prompt.hidden = true;

            // Rebind one action.
            const rebindRow = el('div', 'flex flex-wrap items-center gap-2 mt-2');
            card.rebindAction = el('select', 'bg-fb-bg border border-fb-border rounded text-fb-text text-sm px-2 py-1');
            card.rebindAction.dataset.ff = 'rebind-action';
            for (const a of P.ACTIONS) {
                const o = el('option', '', ACTION_LABELS[a] || a);
                o.value = a;
                card.rebindAction.appendChild(o);
            }
            card.rebindAction.value = P.ACTIONS[0];
            card.rebind = button('Rebind', 'rebind', () => {
                const a = card.rebindAction.value;
                if (card.binding && ACTION_LABELS[a]) startRecording(card, card.binding.kind, [a], a);
            });
            rebindRow.append(el('span', 'text-fb-textDim text-sm', 'Rebind'), card.rebindAction, card.rebind);

            // Input offset and Calibrate.
            const offsetRow = el('div', 'flex flex-wrap items-center gap-2 mt-2');
            card.offset = offsetInput();
            card.offset.dataset.ff = 'offset';
            const off = settings.offsetMs[card.key];
            card.offset.value = String(Number.isFinite(off) ? off : 0);
            card.offset.addEventListener('change', () => onOffsetChange(card));
            card.calibrate = button('Calibrate', 'calibrate', () => {
                if (card.calib) stopCalibration(card, 'Calibration stopped.');
                else startCalibration(card);
            });
            offsetRow.append(el('span', 'text-fb-textDim text-sm', 'Input offset (ms)'), card.offset, card.calibrate);
            const note = el('div', 'text-fb-textDim text-xs mt-1',
                'Calibrate plays clicks: strum along to them and the input offset is set from how late or early you are.');
            note.dataset.ff = 'calibrate-note';
            card.calibStatus = el('div', 'text-fb-textDim text-xs mt-1');
            card.calibStatus.dataset.ff = 'calib-status';

            root.append(setupRow, card.prompt, rebindRow, offsetRow, note, card.calibStatus);
            refreshCard(card);
            card.onEvent = (ev) => onCardEvent(card, ev);
            h.addListener(card.onEvent);
            return card;
        }

        // Stop what the card started and release its claim.
        function disposeCard(card) {
            stopCalibration(card, null);
            card.recorder = null;
            if (card.handle) {
                try { card.handle.removeListener(card.onEvent); } catch (_) { /* ignore */ }
                release(card.handle);
                card.handle = null;
            }
        }

        // Bring the cards in line with the connected controllers. A card stays (claim, setup and
        // calibration included) while its controller is connected in its slot and its claim state is
        // unchanged; cards for controllers that left go; new or newly free controllers get a card.
        function refresh() {
            if (destroyed) return;
            let infos = [];
            try { infos = gi.list() || []; } catch (_) { infos = []; }
            const bindings = P.loadBindings();
            const settings = P.loadSettings();
            const nth = Object.create(null);
            const old = cards.slice();
            const next = [];
            for (const info of infos) {
                if (!info || !info.connected) continue;
                nth[info.id] = (nth[info.id] || 0) + 1;
                const at = old.findIndex((c) => (c.handle ? c.handle.index : c.index) === info.index && c.id === info.id
                    && c.claimedBy === (info.claimedBy || null));
                if (at >= 0) { next.push(old[at]); old.splice(at, 1); continue; }
                next.push({ info, n: nth[info.id] });   // built below, after the cards that left release
            }
            for (const c of old) disposeCard(c);
            cards = next.map((x) => (x && x.el ? x : buildCard(x.info, x.n, bindings, settings)));
            if (cards.length) list.replaceChildren(...cards.map((c) => c.el));
            else {
                message.textContent = 'No controllers found. Connect one and press any button on it.';
                list.replaceChildren(message);
            }
        }

        // Controllers came, went, or someone claimed or released one.
        const offChange = gi.on('change', (ev) => { if (!busy && ev) refresh(); });

        refresh();
        return {
            refresh,
            destroy() {
                if (destroyed) return;
                destroyed = true;
                try { if (typeof offChange === 'function') offChange(); } catch (_) { /* ignore */ }
                for (const c of cards) disposeCard(c);
                cards = [];
                list.replaceChildren();
            },
        };
    }

    return { create, quickSettingsModel, parseOffset, offsetInput, OFFSET_MIN, OFFSET_MAX, OFFSET_STEP };
});
