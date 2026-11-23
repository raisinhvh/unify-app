# motion-audit

A zero-dependency motion-quality auditor for web and Electron UIs. It drives a
headless Chromium over the Chrome DevTools Protocol, samples element geometry
and paint properties every animation frame, runs a scenario of pointer and
keyboard input, and reports animation mistakes with screenshots and property
curves.

Unify's rule is that every change on screen animates with springs: bouncy
pop-ins, elastic presses, crossfades between loader icons, and interruptible
motion. This tool looks for places that break that rule.

## What it checks

| Rule | Severity | Meaning |
| --- | --- | --- |
| `snap` | error | Position, size, opacity, scale or colour changes past a threshold in one frame with no motion around it. |
| `pop-in` / `pop-out` | error | An element appears or disappears already at full opacity and scale. |
| `layout-jump` | error | Neighbours move more than 3 px in one frame because something appeared, vanished or resized. |
| `late-feedback` | warn | No visual response within 50 ms of a hover, press or click. |
| `slow` | warn | One continuous property motion lasts longer than `--max-duration`. |
| `wobble` | warn | More than two direction reversals, or more than 12 % overshoot on a surface wider than 200 px. |
| `restart` | error | Input lands mid-motion and the value jumps back toward its start instead of retargeting. |
| `jank` | warn | Frames longer than 25 ms while something is moving. |
| `linear` | info | Flat velocity profile (linear easing); springs are expected. |
| `layout-props` | info | Continuous width/height/top/left animation; transform and opacity are cheaper. |

Issues with the same rule and element inside 100 ms are merged, and per-rule
output is capped.

## Usage

```sh
node .dsh/tools/motion-audit.mjs --url http://localhost:5173
node .dsh/tools/motion-audit.mjs --url .dsh/tools/motion-audit/fixtures/good.html \
  --scenario .dsh/tools/motion-audit/fixtures/good.json --out reports/good
```

Options:

```
--url <url|file.html>     page to audit (required unless --attach/--electron)
--scenario <steps.json>   input script; without one it just records --settle ms
--watch "css,selectors"   elements to sample (default: [data-motion], else visible page)
--out <dir>               output folder (default: new temp dir, printed)
--width 1280 --height 800 --scale 1
--settle 800              recording time after the last scenario step
--max-duration 700        slow-motion budget in ms
--json                    print report.json to stdout
--attach <port>           attach to an existing browser/Electron debug port
--electron <exe> [--app <dir>]   launch an Electron app with remote debugging
```

It launches Edge or Chrome with `--headless=new`, a free debug port and a
temporary profile, then always closes the browser and removes the profile.
Exit code is 1 when any error issue is found, 0 otherwise.

Outputs: `report.json`, `report.md` (issues plus a per-motion table),
`filmstrip.png` (timestamped frames with step labels) and `curves.png`
(property-vs-time curves for the most interesting motions).

## Scenario format

A JSON array run in order. Every step is timestamped and shown in the
filmstrip.

```json
[
  { "wait": 400 },
  { "mark": "initial state" },
  { "hover": "#save" },
  { "down": "#save" },
  { "up": "#save" },
  { "click": "#menuToggle" },
  { "move": [640, 400] },
  { "drag": { "from": "#slider", "to": "#end", "duration": 500 } },
  { "key": "Escape" },
  { "type": "hello" },
  { "eval": "document.querySelector('#menu').classList.add('open')" },
  { "mark": "menu opening" }
]
```

- `click` sends down, waits ~80 ms, then up.
- `drag` dispatches real mouse events along a straight path at ~60 Hz and its
  targets track the pointer one-to-one.
- Selectors resolve to the element centre. `eval` runs in the page.
- Use `mark` to label sections of the recording; `wait` pads time between steps.

## Attaching to Electron

Launch the app yourself with a debug port:

```sh
electron . --remote-debugging-port=9222
node .dsh/tools/motion-audit.mjs --attach 9222 --scenario steps.json
```

or let the tool launch it:

```sh
node .dsh/tools/motion-audit.mjs --electron node_modules/electron/dist/electron.exe \
  --app . --scenario steps.json
```

When attaching, the recorder is evaluated once into the current page and
`--url` is not required. For an Electron renderer, pass the renderer URL if the
first page target is not the app window.

## Limitations

- Only what the sampled elements do is measured. Elements inserted and removed
  between frames can be missed unless a `MutationObserver` record catches them.
- Viewport-relative rectangles mean window scrolling looks like element motion.
- Frame screenshots are sampled (about every 50 ms), so the filmstrip is
  illustrative rather than frame-exact.
- Colour snap detection compares nearest background/text colour at each frame;
  gradients and canvases are approximated.
- A spring can legitimately move several pixels per frame, so `restart` is
  tuned to single-frame jumps well above that motion's own peak speed. Very
  small restarts on very fast springs can be missed.
- The tool has no npm dependencies; it needs Node 24 and an installed
  Edge/Chrome (or a debuggable Electron app).
