# Changelog

All notable changes to the 5-Fret plugin. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `plugin.json`.

## [0.1.0] - Unreleased

### Added
- Plugin scaffold: `plugin.json` (visualization, `gamepad-input` requester), licence files, CI.
- `assets/engine.js`: JavaScript port of YARG.Core's five-fret guitar engine (LGPL-3.0), part 1:
  strums with strum leniency, HOPOs and taps with HOPO leniency and front end, chords and anchoring,
  open notes, anti-ghosting, overstrums (not during wait countdowns), scoring (50 points per fret) and
  the combo multiplier (max 4 guitar, 6 bass). A gamepad mode hits notes on fret presses (never on
  releases; a chord when its last fret goes down, an open note by the open button with no frets held), with
  no strums and no overstrums.
- `assets/engine.js`, part 2: sustains (25 points per beat, drop leniency, burst, extended sustains),
  star power (phrases, activation from half a bar, drain over 8 measures, doubled multiplier, whammy
  refill), solos with YARG's solo bonus, and stars from YARG's guitar and bass thresholds. Beats and
  measures come from the chart's beat list. New `getState()` fields `starPower`, `stars`, `solo` and
  events `sustain-start`, `sustain-end`, `sp-phrase`, `sp-phrase-miss`, `sp-ready`, `sp-activate`,
  `sp-end`, `solo-start`, `solo-end`.
- `assets/engine.js`: `noteState(i)` reports `'held'` while the note's sustain is active.
- `assets/profiles.js`: controller profiles, the input mapper, and bindings and settings storage.
- `assets/layout.js` and `assets/highway3d.js`: the tilted 3D 5-fret highway (gems, HOPO glow, taps,
  open bars, sustain tails that wobble while held, star power, solo bands, fret buttons, hit flashes)
  with a HUD (header tag, AUTO CHART, score, multiplier, streak, star power bar, stars, solo percent).
- `assets/session.js` and `screen.js`: the player renderer `window.feedBackViz_five_fret` (WebGL2).
  Picks the part by the `part` setting, claims a controller through `gamepad-input`, judges inputs on
  the highway chart clock with the input offset, resets on seeks of more than 0.25 s without misses,
  shows "No 5-fret chart for this song", "Connect a controller and press any button" and "Controller
  disconnected" on the HUD, pauses on Start, and has per-panel settings (`plugin.json`
  `capabilities.visualization.settings`) and a "5-Fret" panel in the player's plugin controls.
- Controls screen (`screen.html`, `settings.html` links to it): lists controllers with live button,
  axis and action lights; **Set up as guitar** / **Set up as gamepad**, **Rebind** one action,
  per-controller **Input offset** (−200..200 ms, step 5) and **Calibrate** (clicks, only on request;
  median strum offset, pairs over 150 ms ignored). It claims controllers while open
  (`five_fret.controls`) and releases them on leave. `assets/profiles.js`: `SETUP_ACTIONS`,
  `createSetupRecorder`, `calibrationOffset`.
- The renderer picks up bindings and offsets saved mid-session (`five_fret:bindings-changed`,
  `five_fret:offset-changed`) and lets its controller go while the controls screen is open
  (`five_fret:controls-screen`).
