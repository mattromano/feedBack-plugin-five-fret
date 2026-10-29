# feedBack Plugin: 5-Fret

Clone Hero-style 5-fret guitar and bass for [feedBack](https://github.com/got-feedback/feedback): play a
song's 5-fret part with a game controller or a plastic guitar, judged and scored by a JavaScript port of
[YARG](https://github.com/YARC-Official/YARG.Core)'s five-fret engine.

Status: in development. This version ships the scoring engine (`assets/engine.js`), controller
profiles (`assets/profiles.js`), the tilted 3D highway view (`assets/highway3d.js`), the player
renderer (`screen.js`, with `assets/session.js`), the controls screen (`screen.html`,
`assets/controls.js`) and a band API for Build-a-Band (`window.feedBackFiveFret`).

## Scoring engine

`assets/engine.js` works in the browser (`window.FiveFretEngine`) and in Node (`require`):

```js
const engine = FiveFretEngine.create(chart, { instrument: 'guitar', gamepadMode: false });
engine.on('hit', (e) => { /* e.index, e.points, e.combo, ... */ });
engine.input(t, 'green', true);       // frets: green, red, yellow, blue, orange
engine.input(t, 'strum_down', true);  // strum_up, strum_down; open, star_power
engine.input(t, 'whammy', 0.7);       // whammy position 0..1 (a change counts as movement)
engine.update(t);                     // advance the clock (misses, timers, sustains, star power)
engine.getState();                    // see below
engine.noteState(i);                  // 'held' | 'hit' | 'miss' | null (i = index into chart.notes)
engine.heldFrets();                   // held frets as a mask (bit 0 green .. bit 4 orange)
engine.reset(t);                      // seek: start over at t
```

`getState()` returns `{ score, combo, maxCombo, multiplier, maxMultiplier, notesHit, notesMissed,
totalNotes, overstrums, ghostInputs, time, starPower: { amount, active }, stars, solo: { active, hit,
total } }`: `score` includes the sustains being held and solo bonuses, `multiplier` is doubled during star
power, `maxMultiplier` is the cap without star power (4 guitar, 6 bass), `maxCombo` the longest combo so
far, `totalNotes` the chart's note count (a chord is one note), `time` the engine clock in seconds,
`starPower.amount` the bar from 0 to 1, `stars` 0 to 6 with a fraction (6 = gold stars) and `solo` the
solo being played.

`noteState(i)` is `'held'` while note i's sustain is active (from its hit until `sustain-end`, the
25 ms drop leniency included), then `'hit'`; a note without a sustain goes straight to `'hit'`. A
chord's notes all report the chord.

Events: `hit`, `miss`, `overstrum`, `combo-reset`, `sustain-start`, `sustain-end` (`finished`: scored in
full), `sp-phrase` (a phrase completed), `sp-phrase-miss`, `sp-ready` (half a bar), `sp-activate`,
`sp-end`, `solo-start`, `solo-end` (`percent` 0..100, `bonus`). Each payload carries `time`.

`chart` is one entry of the highway's `bundle.fiveFretParts` plus `bundle.beats`: notes
`{ t, f, l?, h?, tap? }` where `f` is the fret mask (bit 0 green .. bit 4 orange, 0 = open) and `l` the
sustain in seconds, `starPower` and `solos` as `[{ start_time, end_time }]`, and `beats` as
`[{ time, measure }]` (`measure` >= 0 on a downbeat), which sets the beats and measures that sustains and
star power count in (120 BPM 4/4 without it).

Rules follow YARG's defaults: a 140 ms hit window, 50 ms strum leniency (25 ms with no note near),
80 ms HOPO leniency, anti-ghosting, 50 points per fret and a multiplier up to 4x (6x on bass).
Sustains score 25 points per beat (25 ms drop leniency). A completed star power phrase fills a quarter of
the bar; star power activates from half a bar, doubles the multiplier and a full bar lasts 8 measures;
whammying a star power sustain refills it. Solos give YARG's bonus from 60% of their notes hit. Stars
use YARG's guitar and bass thresholds against the score of a full combo without star power.
**Gamepad mode** (Clone Hero's rule for controllers without a strum bar) hits a note when a fret goes
down and the held frets then match it (a chord when its last fret goes down), never on a release, with no
strums and no overstrums. The open button hits an open note when no frets are held. Every difference from YARG is listed in the
engine's header.

## Highway

`assets/highway3d.js` (`window.FiveFretHighway3D`) draws the classic tilted 5-fret highway with
three.js, which the caller passes in (core's vendored `three.module.min.js`), into a WebGL2 canvas
plus a 2D HUD canvas. The maths it uses is in `assets/layout.js` (`window.FiveFretLayout`), loaded
first.

```js
const view = FiveFretHighway3D.createView(THREE, canvas, { hudCanvas, context });
view.resize(cssWidth, cssHeight, devicePixelRatio);
view.render({ now, wallNow, events, notes, beats, starPower, solos, pressed, whammy, noteState, state,
              lefty, header, sourceKind, lookahead, message, scoreHidden });
view.fxSnapshot();   // the last frame's effects, for tests and debugging
view.destroy();
```

The look follows the drums plugin's Rock Band-style highway (behaviour only, written fresh; no artwork
from any game):

- **Track:** a scrolling textured track with the five lanes faintly tinted green / red / yellow / blue /
  orange, fog, a rim light, lane dividers, beat and measure lines, and side rails with glow strips.
  `lefty` mirrors the lanes.
- **Strike line:** five rounded fret targets in the lane colours that light up and grow while their fret
  (or its sustain) is held, with the lane behind them tinted.
- **Gems:** bevelled rounded gems with an additive glow. Strums have a lighter top and a dark frame line,
  HOPOs are lower with a white top, taps are dark with a lane-coloured top, and open notes are a purple
  bar across the highway. Star power phrase gems are drawn in the star power colour.
- **Sustains:** tails wobble with the whammy while the engine reports the note `'held'`, glow and throw
  sparks at the strike line while held (not while paused), and grey out once dropped.
- **Hits and misses:** the view reads the session's engine events (`events`, from
  `session.drainEvents()`). A hit flashes each of its frets' lanes in the timing colour (green within
  25 ms, blue early, orange late), throws a ring, a flare and a spark burst that grows with the streak,
  and the gem carries on past the strike line white-hot and fades. A miss flashes its lanes red and the
  gem carries on red. An overstrum flashes the strike line red. Breaking a streak of 3 or more washes
  the screen red.
- **Star power:** the wash, rails and dividers pulse blue while it is active, and the rails glow faintly
  once it can be activated. A toast announces activation, completed phrases, READY and solos.
- **HUD:** the star power meter (READY / ACTIVE, pulsing), a big score, stars, accuracy, an early / late
  timing meter of the last 24 hits (`offsetMs` on the session's hit events), the multiplier ring with
  its progress to the next multiplier, the NOTE STREAK, FULL COMBO, `+points` pops, a combo ring every
  10 notes and bursts at 25, 50 and every 100. It also shows the header tag, **AUTO CHART**, the solo
  percent and the status message. With room beside the track, the score column sits right of it and
  the multiplier left of it. Narrow lanes get a compact, scaled HUD in the bottom corners without the
  timing meter.
- **Band lanes** (`scoreHidden`): every highway effect, the streak ring, bursts and red wash, the solo
  percent and the toasts stay. The score panels (meter, score, stars, accuracy, timing, multiplier,
  streak, pops) and the header tag are left out.

Meshes, pools (24 flashes, 480 sparks, 12 score pops) and buffers are built once and reused, `render`
makes no DOM queries, and the HUD is only redrawn when something on it changes or animates.

## Player

Pick **5-Fret** in the player's visualization picker (Auto mode picks it for a 5-fret-only song).
The renderer (`window.feedBackViz_five_fret`, WebGL2) plays one part of the song's 5-fret chart:

- **Part:** the `part` setting, `auto` | `guitar` | `rhythm` | `bass`. `auto` takes the bass part
  when the current arrangement's name contains "bass", else the guitar part, else the first part. A
  part the song lacks falls back to `auto`.
- **Controller:** it claims a free controller through core's `gamepad-input` domain: one set up on
  the controls screen first, else a standard gamepad (which works out of the box), each in slot
  order. It holds the controller only while a 5-fret part is playing: paused, before playback, or on
  a song with no 5-fret part it lets go, so core's menus work (A plays/pauses, B goes back) and a
  controller-only player can always leave. Start pauses (in a band lane, Build-a-Band does: see
  Band API). If it unplugs, the song keeps going without
  input and the highway says "Controller disconnected" until it is back.
- **Timing:** inputs are judged on the highway's chart clock, minus the controller's input offset.
  Seeking or looping (a jump of more than 0.25 s) starts the scoring over from the new position
  without counting the skipped notes as misses.
- **Settings:** part, difficulty, lefty and gamepad mode, in a "5-Fret" panel in the player's plugin
  controls or in splitscreen's per-panel settings. Each highway keeps its own settings, starting
  from the saved ones; the normal player's panel saves its choices to `five_fret.settings.v1`.

`assets/session.js` (`window.FiveFretSession`) holds the scoring session and the renderer's pure
helpers (`pickPart`, `inputChartTime`, `statusMessage`, `isJump`). `pickPart(parts, arrangementName,
setting, opts)` takes `opts = { exact?, showAuto? }`: `exact` gives null for an instrument the song
lacks instead of falling back; `showAuto` is reserved for the auto-chart setting and changes nothing
yet.

**Star power on auto charts.** An auto-charted part (`sourceKind: 'auto'`) has no star power phrases
of its own, so the session makes them from the song's sections (`bundle.sections`, each running to the
next one's start; `autoStarPower(notes, sections, beats)`): every section with at least 8 notes gets
one phrase over its last 2 measures, the last measure being the one holding the section's last note
(never starting before the section). Measures come from `bundle.beats` downbeats, as the engine
counts them; with fewer than two downbeats 4 beats make a measure, and with no beats a measure is
2 s (120 BPM 4/4). Notes are counted on the full (expert) chart, so every difficulty has the same
ranges. The engine then earns and deploys them like any phrase. Phrases on a real chart are never
changed. **Deviation from the plastic-controllers spec:** a phrase pays out only when all its notes
are hit (YARG's rule, which the engine keeps), not the spec's 90%.

## Controls screen

**5-Fret controls** (the plugin's screen: the player panel's "Controller setup…" link, or Settings →
5-Fret) lists the connected controllers. While it is open it claims each free one (owner
`five_fret.controls`; the player's renderers let theirs go and take them back when you leave), so
its buttons, axes and actions light up as you press them. For each controller:

- **Set up as guitar** asks, in order, for green, red, yellow, blue, orange, strum down, strum up,
  whammy, star power and pause; **Set up as gamepad** asks for the standard gamepad profile's
  actions. Each takes the first new button press, or an axis moving more than 0.5 from rest
  (recorded with its direction, so one axis can strum both ways). A hat switch (an axis resting
  outside -1..1, or jumping from rest straight to a value short of full scale) is recorded by value,
  `{ type: 'axis', index, value, tolerance: 0.1 }`: the action is pressed while the axis is within
  the tolerance of that value, so a hat strum bar binds up and down on one axis. A control already
  used is ignored. **Skip** leaves an action unbound; **Cancel** saves nothing.
- **Rebind** one action: pick it, then press the button or move the axis. The other actions stay.
- **Input offset** in ms (−200 to 200, step 5), per controller.
- **Calibrate** plays 12 clicks (it is the only thing on the screen that makes sound, and only when
  clicked): strum along, and the offset is set to the median of strum-minus-nearest-click, ignoring
  pairs more than 150 ms apart.

Controllers that connect, disconnect, or are claimed or released by another plugin get their
cards added or removed; the others keep their claim, setup and calibration. The screen's code is
`assets/controls.js` (`window.FiveFretControls.create(...)`), loaded with the other assets when the
screen opens.

Bindings are saved to `five_fret.bindings.v1` and offsets to `five_fret.settings.v1`. Each save is
announced on `window.feedBack` (`five_fret:bindings-changed`, `five_fret:offset-changed`), and a
running renderer re-reads its binding or offset when the event names its controller, so a
plastic guitar set up mid-song is claimed straight away. The pure helpers are in `assets/profiles.js`: `SETUP_ACTIONS`,
`createSetupRecorder(actions, { used?, rest? })` and `calibrationOffset(clickTimes, strumTimes)`.

## Band API

`window.feedBackFiveFret` (`version: 1`) lets Build-a-Band run one 5-fret lane per controller, the
way it uses `window.feedBackDrums`. Lanes are keyed by their highway canvas, so a call made before a
renderer inits on the canvas (or across a re-init) still applies.

```js
const ff = window.feedBackFiveFret;
ff.setLane(canvas, { controllerKey: 'Xbox Wireless Controller#2', part: 'bass', difficulty: 'expert', lefty: false });
ff.setDifficulty('hard', canvas);
ff.setScoreHudHidden(canvas, true);      // ff.isScoreHudHidden(canvas)
ff.getInstanceState(canvas);             // null, or getState() + { starThresholds, partId, instrument,
                                         //   sourceKind, controllerKey, connected }
ff.clearLane(canvas);
await ff.listControllers();              // [{ index, controllerKey, id, mapping, name, kind, connected, claimedBy }]
await ff.createMapper(controllerKey);    // { map(ev) -> [{ action, value }] } | null
ff.showAutoCharts();                     // the saved "show auto charts" flag, default false
ff.openControls({ returnTo: 'plugin-build_a_band' });
ff.playOnPart('song.sloppak', 'bass', 'hard');   // main player: that part (and difficulty), 5-Fret view for this play only
const qs = ff.mountQuickSettings(el, { canvas, controllerKey });   // in-song settings; qs.destroy()
```

- **`mountQuickSettings(el, { canvas?, controllerKey? })`** puts in-song settings for one lane in `el`
  and returns `{ destroy() }`: difficulty, part (only the instruments the song has; hidden when there
  is nothing to switch to), lefty and the controller's input offset (step 5, ±200 ms; hidden until a
  controller has played). Changes apply live. With a band lane's `canvas` they change its pin
  (`setLane` / `setDifficulty`) and are never saved; otherwise (no `canvas`: the normal player) they go
  through the same path as the 5-Fret panel and are saved as the defaults. `controllerKey` picks whose
  offset is shown (default: the lane's controller). Every change emits `five_fret:quick-setting`
  `{ canvas, controllerKey, key, value, lane }` so a band host can keep its own per-player prefs in
  step. The controls fill in once the plugin's scripts load; they follow changes made elsewhere (the
  panel, `setLane`, `setDifficulty`, the controls screen). Which controls show is
  `FiveFretControls.quickSettingsModel` (`assets/controls.js`, pure).
- **Score HUD with RockHeroSmith.** A renderer that is not a band lane hides its score HUD (as
  `setScoreHudHidden`) while `window.rockHeroSmith.adoptsSolo()` returns true: RockHeroSmith then
  scores the solo play with its own HUD and results. Without RockHeroSmith, or one without
  `adoptsSolo` or with it off, the 5-fret HUD shows as before.

- **`playOnPart(filename, part, difficulty?)`** plays a library song (unencoded filename) in the main
  player on one part (`guitar` | `rhythm` | `bass`), optionally at a difficulty (`easy` | `medium` |
  `hard` | `expert`): they become the saved Part / Difficulty settings, as picking them in the 5-Fret
  panel does, and core's `feedBack.ui.playSongAs` sets the 5-Fret view for that play only.
  The plugin uses it for its **Play as** entries (core `libraryCardActions`, placement `play-as`):
  one row per instrument the song has a 5-fret chart for (auto charts only while "Show auto charts"
  is on), then the difficulty (the saved one first), in the Songs table's row menu and the card ⋮ "Play as…".

- **`setLane`** returns false (changing nothing) on bad arguments; calling it again updates the lane.
  `part` is `guitar` | `rhythm` | `bass` and is played exactly: a song without it shows "No 5-fret chart
  for this song" (`pickPart(…, { exact: true })`). `difficulty` is `easy` | `medium` | `hard` |
  `expert`; `lefty` a boolean.
- A pinned lane claims only its `controllerKey`, and holds it from `setLane` (as soon as it is
  connected) until `clearLane` or destroy, while loading, counting in or paused too. It never mounts
  the 5-Fret panel or saves `five_fret.settings.v1`, and its gamepad mode follows the controller's
  kind (on for gamepads, off for guitars), not the saved setting. It still lets go while the controls
  screen is open. `clearLane` returns the renderer to its own settings and the normal claim rules.
- **`setScoreHudHidden`** hides the lane's score, multiplier, streak, star power bar and stars; the
  header tag, AUTO CHART and status messages stay.
- **`getInstanceState`**'s `starThresholds` are the full chart's (the same after a seek).
- **`listControllers`** and **`createMapper`** return Promises and load `profiles.js` on demand.
  `kind` is the resolved binding's (`gamepad` | `guitar`), or null when the controller needs setup.
  `name` is the controller id up to its first ` (`, at most 24 characters, plus ` 2` for a second
  identical controller.
- **`openControls`** shows the controls screen; its Back button goes to `returnTo` (default `home`)
  for that visit.

**Events on `window.feedBack`.** Every renderer (pinned or not) emits its judgments and star power
as `five_fret:hit`, `five_fret:miss`, `five_fret:overstrum`, `five_fret:sustain-end`,
`five_fret:sp-phrase`, `five_fret:sp-ready`, `five_fret:sp-activate` and `five_fret:sp-end`. `detail`
is the engine payload (as `drainEvents()`: `type`, and a note's own type as `noteType`) plus `canvas`
(the highway canvas: filter by it), `controllerKey` (null with no controller), `partId`,
`instrument`, and `score`, `combo`, `multiplier` and `spActive` from the engine state at the end of
that frame (so several events in one frame share them). `resets` counts the times this renderer's
scoring started over (the first frame, each seek or loop, a rebuilt session): a change from the last
event's value means the score restarted. Events go out only when the bus has `emit`; a frame
without events costs nothing, and a listener that throws never stops the draw.

**Pause and leave in a band lane.** A pinned lane never pauses the song itself. Its controller's
**Start** (the binding's `pause` action) emits `five_fret:band-pause` on the press, and holding
**Back** (button 8 on standard-mapped pads; bindings have no back action, so button 8 for every
controller whose binding leaves it free) for 1 s emits `five_fret:band-back-hold` once per hold (a
release before 1 s cancels it). Both carry `detail { controllerKey, canvas }`, and both work while
paused. Build-a-Band toggles pause and opens its leave prompt. Unpinned renderers keep Start →
`window.togglePlay()`.

## Tests

```sh
node --test tests/*.test.js
```

## License

MIT, except `assets/engine.js` and `tests/engine.test.js`, which are LGPL-3.0 ports of YARG.Core.
See [NOTICE.md](NOTICE.md).
