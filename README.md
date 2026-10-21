# feedBack Plugin: 5-Fret

Clone Hero-style 5-fret guitar and bass for [feedBack](https://github.com/got-feedback/feedback): play a
song's 5-fret part with a game controller or a plastic guitar, judged and scored by a JavaScript port of
[YARG](https://github.com/YARC-Official/YARG.Core)'s five-fret engine.

Status: in development. This version ships the scoring engine (`assets/engine.js`); the highway,
controller setup and settings come next.

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
engine.noteState(i);                  // 'hit' | 'miss' | null (i = index into chart.notes)
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

## Tests

```sh
node --test tests/*.test.js
```

## License

MIT, except `assets/engine.js` and `tests/engine.test.js`, which are LGPL-3.0 ports of YARG.Core.
See [NOTICE.md](NOTICE.md).
