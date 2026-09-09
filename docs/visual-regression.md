# Visual regression and Apple HIG checks

Two suites, one Playwright config (`playwright.visual.config.ts`), three viewports:

| Project   | Device                | Why |
| --------- | --------------------- | --- |
| `desktop` | Desktop Chrome 1440×900 | The contents rail only exists at `lg` and above. |
| `tablet`  | iPad (gen 7), 810 px  | Below `lg` but above `md`: rail gone, floating tab bar gone. The width where layout bugs hide. |
| `mobile`  | iPhone 13, 390 px     | Docked contents control, floating tab bar, safe-area insets. |

```bash
npm run test:visual          # compare against the committed baselines
npm run test:visual:update   # regenerate the baselines
```

## What each suite asserts

**`tests/visual/community.visual.spec.ts`** — pixel baselines for the community index and the deck
reader: above the fold, the card grid, the deck hero, a card carrying a table, a card carrying stat
figures, and on narrow viewports the docked contents control both closed and open. Plus two
non-pixel assertions that catch the failures screenshots are bad at: no page scrolls sideways, and
the contents rail stays pinned when the page scrolls (an `overflow-x: hidden` on an ancestor once
made every sticky element on the site inert, and nothing caught it).

**`tests/visual/hig.spec.ts`** — Apple's Human Interface Guidelines as measurements, not opinions:

- every visible control is at least 44×44 pt (HIG, Layout — "at least 44x44 pt");
- no text sits closer than 16 px to the display edge, excluding anything inside a horizontal
  scroller, where running past the edge is the feature;
- nothing tappable is covered by the floating tab bar.

The third one is why the suite exists. The deck reader's own contents control was docked underneath
the site's floating tab bar and was untappable on every phone — visible in review, and invisible to
every other test in the repo.

## Baselines are machine-specific

A PNG baseline encodes the exact font rasterisation and image decoding of the machine that produced
it. The committed baselines were generated in this repo's container against Chromium; a different
Chromium build, a different OS, or a machine with different fonts installed will differ by more than
the 0.2/1 % tolerance in the config and the suite will fail for reasons that have nothing to do with
the code.

**So this suite is not wired into CI, and must not be until CI runs it inside a pinned image**
(`mcr.microsoft.com/playwright:v1.57.0-noble`, matching the `@playwright/test` version in
`package.json`). Regenerate the baselines inside that image in the same change that wires it up.

It is run locally, before a change lands on the community surfaces. That is where it pays for
itself: the diff is a picture of what moved.

## Environment notes

- `PLAYWRIGHT_CHROMIUM_PATH` points the run at a browser the container already has, instead of
  downloading one. In this repo's dev container: `/opt/pw-browsers/chromium`.
- `--no-sandbox` is applied automatically when running as uid 0, because Chromium refuses to start
  its sandbox as root. A developer on their own machine keeps the sandbox.
- The web server runs with `COMMUNITY_CONTENT_BACKEND=static` so a screenshot never depends on
  Firestore being reachable, and a diff means the layout changed rather than that someone published
  an article.
- Cross-origin requests are blocked per test. Card covers fall back to Unsplash, and hanging a pixel
  baseline on a third-party CDN makes it slow, reframable, and unresolvable on a machine with no
  egress.
