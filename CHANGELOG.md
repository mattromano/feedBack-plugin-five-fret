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
