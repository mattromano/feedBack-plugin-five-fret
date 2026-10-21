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
engine.input(t, 'strum_down', true);  // strum_up, strum_down; open, whammy, star_power
engine.update(t);                     // advance the clock (misses, leniency timers)
engine.getState();                    // see below
engine.noteState(i);                  // 'hit' | 'miss' | null (i = index into chart.notes)
engine.heldFrets();                   // held frets as a mask (bit 0 green .. bit 4 orange)
engine.reset(t);                      // seek: start over at t
```

`getState()` returns `{ score, combo, maxCombo, multiplier, maxMultiplier, notesHit, notesMissed,
totalNotes, overstrums, ghostInputs, time }`: `maxCombo` is the longest combo so far, `maxMultiplier` the
cap (4 guitar, 6 bass), `totalNotes` the chart's note count (a chord is one note) and `time` the engine
clock in seconds. Events: `hit`, `miss`, `overstrum`, `combo-reset`.

`chart` is one entry of the highway's `bundle.fiveFretParts` plus `bundle.beats`: notes
`{ t, f, l?, h?, tap? }` where `f` is the fret mask (bit 0 green .. bit 4 orange, 0 = open).

Rules follow YARG's defaults: a 140 ms hit window, 50 ms strum leniency (25 ms with no note near),
80 ms HOPO leniency, anti-ghosting, 50 points per fret and a multiplier up to 4x (6x on bass).
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
