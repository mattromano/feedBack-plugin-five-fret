# Licensing notice for the 5-Fret plugin

Most of this plugin is original code under the **MIT** license (see `README.md`). That includes
`plugin.json`, the screen, settings and other assets, and the tests other than `tests/engine.test.js`.

Two files are ports of [YARG.Core](https://github.com/YARC-Official/YARG.Core) and are licensed under the
**GNU Lesser General Public License v3.0** (full text in [`LICENSE.LGPL-3.0`](LICENSE.LGPL-3.0); the LGPL
builds on the GNU GPL v3.0, whose text is in [`LICENSE.GPL-3.0`](LICENSE.GPL-3.0)):

| File | Status |
|------|--------|
| `assets/engine.js` | LGPL-3.0. JavaScript port, with modifications, of YARG.Core's five-fret guitar engine, from `master` at commit `9dafd346aff908b6d5b1db250eaf3a2588810c70` (`Engine/Guitar/Engines/YargFiveFretGuitarEngine.cs`, `Engine/Guitar/GuitarEngine.cs`, `GuitarEngineParameters.cs`, `GuitarStats.cs`, `Engine/BaseEngine.cs`, `BaseEngine.Generic.cs`, `EngineTimer.cs`, `HitWindowSettings.cs`, `Input/InputActions.cs` (GuitarAction), `Chart/Events/WaitCountdown.cs`, and the five-fret defaults from `Game/Presets/EnginePreset.Instruments.cs`). Copyright (c) YARC (YARG) contributors. |
| `tests/engine.test.js` | LGPL-3.0. Tests for `engine.js`, describing YARG's five-fret rules. |

`assets/engine.js` is a standalone, unminified script with no dependencies, shipped as its own file and
loaded at runtime. The rest of the plugin only uses it through its public API
(`window.FiveFretEngine` / `require('./engine.js')`), so it remains a separate MIT work that uses the Library
as described in LGPL-3.0 section 4 ("Combined Works"). You may replace `assets/engine.js` with a modified
version. If you distribute changes to `assets/engine.js`, they must stay under LGPL-3.0 and their source
must stay available. Combining an LGPL-3.0 file with MIT code this way is permitted by both licenses, and
both are compatible with feedBack's AGPL-3.0.

The header of `assets/engine.js` lists every behaviour that deviates from YARG ("Deviations from YARG").
The play style imitates rhythm-game guitar tracks but uses no artwork, fonts or logos from them.
