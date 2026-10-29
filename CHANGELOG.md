# Changelog

All notable changes to the 5-Fret plugin. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `plugin.json`.

## [0.3.1] - Unreleased

### Added
- `window.feedBackFiveFret.mountQuickSettings(el, { canvas?, controllerKey? })`: in-song difficulty,
  part (only the parts the song has), lefty and input offset for one lane, applied live. A band lane's
  changes go to its pin (`setLane` / `setDifficulty`, never saved); the normal player's go through the
  5-Fret panel's path and are saved. Each change emits `five_fret:quick-setting`.
- `assets/controls.js` exports `quickSettingsModel` (which quick settings show, pure), `parseOffset`
  and `offsetInput`, shared by the controls screen and the quick settings.

### Changed
- With RockHeroSmith adopting solo plays (`rockHeroSmith.adoptsSolo()` true), an unpinned renderer
  hides its score HUD and RockHeroSmith's HUD scores the play. Without it nothing changes.
- The 5-Fret panel and the quick settings build their rows with the same helpers.

## [0.3.0] - Unreleased

### Changed
- The 3D highway was rebuilt to look and play like the drums plugin's Rock Band-style highway: a
  scrolling five-lane track with fog, a rim light, rail glow strips and clearer dividers; rounded fret
  targets that light while held; bevelled glowing gems (distinct strum, HOPO, tap and open styles,
  star power gems in the star power colour); and sustain tails that glow and throw sparks while held.
- Hits flash their lanes in the timing colour (on time / early / late) with a ring, a flare and a spark
  burst that grows with the streak, and hit gems carry on past the strike line and fade. Misses flash
  red and the gem trails red. Overstrums flash the strike line red, and breaking a 3+ streak washes red.
- The HUD now has a star power meter (READY / ACTIVE), a big score, stars, accuracy, an early / late
  timing meter, a multiplier ring with progress, a big NOTE STREAK, FULL COMBO, score pops, combo rings,
  streak bursts and toasts. It sits beside the track when there is room and goes compact in narrow lanes.
- Band lanes (score HUD hidden) keep every highway effect and the streak flashes, without the score
  panels.

### Added
- `screen.js` passes each draw's engine events (`frame.events`) and wall clock (`frame.wallNow`) to the
  view. They still go to the bus as before.
- Session hit events carry `offsetMs`, the hit's timing in ms (+ = late).
- `assets/highway3d.js` exports `HIT_FX`, `trailAlpha`, `trailZ`, `timingHex`, `sparkCount`,
  `multiplierColor`, `hudModel` and `view.fxSnapshot()`. `tests/highway3d.test.js` drives the scene
  with a real session on a stub three.js.

## [0.2.1] - Unreleased

### Added
- **Play as** entries for core's library menus (`libraryCardActions`, placement `play-as`): 5-Fret Guitar / Rhythm / Bass for each part the song has (auto charts only while "Show auto charts" is on), then the difficulty, and `window.feedBackFiveFret.playOnPart(filename, part, difficulty?)`.

### Fixed
- HUD moved to the bottom corners so it no longer overlaps the player's title, tuning and time; band lanes (score HUD hidden) no longer draw the header tag, and AUTO CHART sits bottom-left.

## [0.2.0] - Unreleased

### Added
- Band API `window.feedBackFiveFret` (version 1) for Build-a-Band, modelled on `window.feedBackDrums`:
  `setLane(canvas, { controllerKey, part, difficulty, lefty })` pins the renderer on a canvas (now, or
  the one that inits on it later) to one controller, one part played exactly, a difficulty and lefty;
  `clearLane`, `setDifficulty(id, canvas)`, `setScoreHudHidden` / `isScoreHudHidden`,
  `getInstanceState(canvas)` (engine state plus the full chart's `starThresholds`, `partId`,
  `instrument`, `sourceKind`, `controllerKey`, `connected`), `listControllers()` and
  `createMapper(controllerKey)` (Promises; they load `profiles.js` on demand), `showAutoCharts()` and
  `openControls({ returnTo })`.
- A pinned lane holds its controller from `setLane` until `clearLane` or destroy, paused or not; it
  never mounts the 5-Fret panel or saves `five_fret.settings.v1`, and its gamepad mode follows the
  controller's kind.
- `assets/session.js`: `pickPart(parts, arrangementName, setting, opts)` with
  `opts = { exact?, showAuto? }` (`exact`: a missing instrument gives null); `session.starThresholds`.
- `assets/highway3d.js`: `frame.scoreHidden` leaves the score, multiplier, streak, star power bar and
  stars off the HUD.
- Judgment and star power events on core's bus from every renderer: `five_fret:hit`, `miss`,
  `overstrum`, `sustain-end`, `sp-phrase`, `sp-ready`, `sp-activate`, `sp-end`, with the engine payload
  plus `canvas`, `controllerKey`, `partId`, `instrument`, `score`, `combo`, `multiplier`, `spActive`
  (one state read per frame) and `resets` (scoring restarts: first frame, seeks, rebuilds).
- A pinned lane's Start emits `five_fret:band-pause` and a 1 s hold of Back (button 8)
  `five_fret:band-back-hold` (`{ controllerKey, canvas }`) instead of pausing the song.
- Auto-charted parts get star power: one phrase over the last 2 measures of each song section with at
  least 8 notes (`session.autoStarPower`, `session.starPower`). A phrase needs all its notes hit
  (YARG), not the spec's 90%.

## [0.1.0] - Unreleased

### Added
- "Show auto charts" setting (`showAutoCharts` in `five_fret.settings.v1`, default off, checkbox on the settings page). Auto-generated parts (`sourceKind: 'auto'`) are hidden by `pickPart` unless it is on; a song with only auto parts shows the no-part status. `pickPart` takes `opts` (`{ exact?, showAuto? }`; `exact` is accepted and ignored for now). Renderers re-read the setting on `five_fret:settings-changed`.
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
- Hat-switch bindings `{ type: 'axis', index, value, tolerance }` (tolerance 0.1): the setup recorder
  records a hat axis by value, the mapper presses while the axis is within tolerance. A sign-less axis
  in a rebind's used controls blocks both directions.
- The controls screen lives in `assets/controls.js` (`window.FiveFretControls`); `screen.js` keeps the
  open/close hook. Controller list changes add or remove only the changed cards.
- The player's 5-Fret panel uses core's `bg-fb-card`, `text-fb-textDim`, `text-fb-primary` classes
  (the bare `fb-*` names it used are not in core's CSS).
