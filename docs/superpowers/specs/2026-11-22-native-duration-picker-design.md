# Native duration picker - design

Date: 2026-11-22
Status: approved (small change)

## Intent / why

The duration control was a `#minutes` number input plus preset chips. It only
spoke minutes, felt wrong for long locks, and any custom wheel we tried took up
too much space and never felt good. Replace it with a native `<select>` so the
operating system's own scroll wheel (the iOS wheel, the Android dropdown) does
the work, and space the options logarithmically so precision matches the lock's
actual uncertainty.

## Key reasoning

The realized unlock time is `target * MARGIN * (rate_at_lock / rate_at_unlock)`.
The uncertainty is therefore multiplicative (a percentage), not a fixed number
of seconds. So the honest scale is logarithmic: equal ratios, not equal amounts.
At the year scale a single step is already larger than the noise, so offering
seconds there would be a lie. The log ladder encodes this directly.

## The ladder (option value = seconds)

```
10s 15s 20s 30s 45s
1m 2m 5m 10m 15m 30m 45m
1h 2h 4h 8h 12h
1d 2d 4d
1w 2w
1mo 2mo 4mo 6mo
1y 2y 5y 10y 20y
```

Geometric 1-2-5 spacing, coarsening with scale. `15s` is included so every
preset maps to an exact step. Default selection: 5 minutes.

## Approaches considered

- Custom scroll wheels (single value+unit, or d:h:m:s columns), built ourselves:
  rejected, took too much space and never felt native/good.
- `datetime-local` "unlock on" field: compact and native but reframes duration
  as an absolute moment, awkward for short locks. Possible later addition.
- Native `<select>` of log-spaced durations: chosen. The system wheel is the
  real thing, zero custom code, tiny footprint, principled spacing.

## Decisions

- **No spread/confidence band.** Considered showing `roughly A to B` under the
  picker. Rejected: the band is dominated by the unknown unlock device, so it is
  a guess dressed as data, and at e.g. 2h it reads `~1.4h to ~3.4h`, which just
  makes a correct lock look broken. The log steps already carry the "precision
  matches uncertainty" idea; that is enough.
- **15s added** to the ladder so presets are all exact steps.
- **txt frontend untouched.** It is already preset-only `[5m][15m][30m][1h][2h]`
  with no free input, which fits its plain-text look; a native wheel would break
  that. Leave it as-is.
- Calibration / MARGIN / lock path unchanged. Only how `targetSec` is read
  changes.

## Changes

- `index.html` (~149-174): replace `#minutes` number input + "minutes" note with
  `<select id="dur">` holding the ladder; keep `#dur-chips`, change `data-min` to
  `data-sec` with exact step values (15, 300, 900, 1800, 3600, 7200).
- `app.js`: `lock()` reads `targetSec = parseInt($("dur").value, 10)`; preset
  click sets `$("dur").value`; the `#minutes` input listener becomes a `change`
  listener on `#dur` that highlights a matching preset; `showToken` uses `fmtEta`
  instead of `fmtTime` for the "locked" head so long durations read cleanly.
- `styles.css`: style `#dur` to match the base input (mono, surface, 10px
  radius), add a custom chevron, drop the `.dur input` width rule.
