# feedBack Plugin: 5-Fret

Clone Hero-style 5-fret guitar and bass for [feedBack](https://github.com/got-feedback/feedback): play a
song's 5-fret part with a game controller or a plastic guitar, judged and scored by a JavaScript port of
[YARG](https://github.com/YARC-Official/YARG.Core)'s five-fret engine.

Status: in development. This version ships the scoring engine (`assets/engine.js`), controller
profiles (`assets/profiles.js`), the tilted 3D highway view (`assets/highway3d.js`), the player
renderer (`screen.js`, with `assets/session.js`) and the controls screen (`screen.html`).

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
view.render({ now, notes, beats, starPower, solos, pressed, whammy, noteState, state,
              lefty, header, sourceKind, lookahead, message });
view.destroy();
```

It draws five lanes with beat and measure lines, round gems (HOPOs with a white glow, taps with a dark
centre, open notes as a purple bar), and sustain tails. A tail wobbles with the whammy while the
engine reports the note `'held'`, and is dimmed once dropped. Star power phrases are drawn as
white/blue gems, and the highway turns blue while star power is active. Solo sections show as a band,
fret buttons light from `pressed`, hit gems flash and vanish, and missed gems dim. The HUD shows the
header tag, **AUTO CHART** for auto-charted parts, the score, the multiplier and streak, the star
power bar, the stars and the solo percent. `lefty` mirrors the lanes. Meshes are built once and
reused, and `render` makes no DOM queries.

## Player

Pick **5-Fret** in the player's visualization picker (Auto mode picks it for a 5-fret-only song).
The renderer (`window.feedBackViz_five_fret`, WebGL2) plays one part of the song's 5-fret chart:

- **Part:** the `part` setting, `auto` | `guitar` | `rhythm` | `bass`. `auto` takes the bass part
  when the current arrangement's name contains "bass", else the guitar part, else the first part. A
  part the song lacks falls back to `auto`.
- **Controller:** it claims the first free controller with a binding (a standard gamepad works out of
  the box) through core's `gamepad-input` domain. Start pauses. If it unplugs, the song keeps going
  without input and the highway says "Controller disconnected" until it is back.
- **Timing:** inputs are judged on the highway's chart clock, minus the controller's input offset.
  Seeking or looping (a jump of more than 0.25 s) starts the scoring over from the new position
  without counting the skipped notes as misses.
- **Settings:** part, difficulty, lefty and gamepad mode, in a "5-Fret" panel in the player's plugin
  controls or in splitscreen's per-panel settings. Each highway keeps its own settings, starting
  from the saved ones; the normal player's panel saves its choices to `five_fret.settings.v1`.

`assets/session.js` (`window.FiveFretSession`) holds the scoring session and the renderer's pure
helpers (`pickPart`, `inputChartTime`, `statusMessage`, `isJump`).

## Controls screen

**5-Fret controls** (the plugin's screen: the player panel's "Controller setup…" link, or Settings →
5-Fret) lists the connected controllers. While it is open it claims each free one (owner
`five_fret.controls`; the player's renderers let theirs go and take them back when you leave), so
its buttons, axes and actions light up as you press them. For each controller:

- **Set up as guitar** asks, in order, for green, red, yellow, blue, orange, strum down, strum up,
  whammy, star power and pause; **Set up as gamepad** asks for the standard gamepad profile's
  actions. Each takes the first new button press, or an axis moving more than 0.5 from rest
  (recorded with its direction, so one axis can strum both ways). A control already used is
  ignored. **Skip** leaves an action unbound; **Cancel** saves nothing.
- **Rebind** one action: pick it, then press the button or move the axis. The other actions stay.
- **Input offset** in ms (−200 to 200, step 5), per controller.
- **Calibrate** plays 12 clicks (it is the only thing on the screen that makes sound, and only when
  clicked): strum along, and the offset is set to the median of strum-minus-nearest-click, ignoring
  pairs more than 150 ms apart.

Bindings are saved to `five_fret.bindings.v1` and offsets to `five_fret.settings.v1`. Each save is
announced on `window.feedBack` (`five_fret:bindings-changed`, `five_fret:offset-changed`), and a
running renderer re-reads its binding and offset, so a plastic guitar set up mid-song is claimed
straight away. The pure helpers are in `assets/profiles.js`: `SETUP_ACTIONS`,
`createSetupRecorder(actions, { used?, rest? })` and `calibrationOffset(clickTimes, strumTimes)`.

## Tests

```sh
node --test tests/*.test.js
```

## License

MIT, except `assets/engine.js` and `tests/engine.test.js`, which are LGPL-3.0 ports of YARG.Core.
See [NOTICE.md](NOTICE.md).
