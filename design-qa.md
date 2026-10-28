# Radio Bob visual implementation QA — 2026-10-19

final result: passed

## Scope and source truth

The requested software UI is represented by the user's three screenshots, not the different landing-page demo at https://mmguo.dev/claudio-fm/. The implementation is the existing functional app at http://localhost:8080/.

Original screenshots (2522 × 3152 px each):
- Dark: `work/design-reference/source-screenshot.png`
- Light: `work/design-reference/source-screenshot.png`
- Profile: `work/design-reference/source-screenshot.png`

Working copies and all evidence are in `radio-bob/work/design-reference/`.

The recorded-video subtitles, Pause badge and mouse pointer are not application UI. Radio Bob naming, current local time, existing Chinese conversation, current track and actual account status are retained. The original creator's personal taste and identity are not substituted for the user's own data. These are expected content differences.

## Browser evidence and normalization

Desktop viewport: 1040 × 1300 CSS px. Browser captures: 1040 × 1300 physical px (effective capture scale 1 pixel/CSS px). Main card: x=170, y=32, width=700, height=1189 CSS px. Source main crop (449,80)-(2152,2962) is normalized from 1703 × 2882 to 700 × 1185 px. The 4 px height difference is retained, not stretched away.

Final main captures:
- `radio-bob/work/design-reference/implementation-dark-4.png`
- `radio-bob/work/design-reference/implementation-light-4.png`
- `radio-bob/work/design-reference/implementation-profile-4.png`

Final combined inputs, actually opened and visually compared with source on the left and implementation on the right:
- `comparison-dark-4.png` and `comparison-light-4.png`: 1420 × 1189 px, full main card.
- `comparison-dark-top-4.png` and `comparison-light-top-4.png`: 1420 × 600 px, focused typography, clock, player and queue.
- `comparison-profile-4.png`: 1720 × 1091 px. Source crop (270,195)-(2338,2849) normalized to 850 × 1091; implementation modal at (95,105)-(945,1195), 850 × 1090. This also provides a readable focused comparison of title, image, text, stats and texture.

States: dark/light, logged-in real account, three real queued tracks, paused final capture. Earlier iteration 3 captures also show real playback with ON AIR and elapsed time. Profile uses the user's actual empty-taste state. No fake music/chat payload was inserted for visual comparisons.

Responsive viewport: 390 × 844 CSS px. Full-page captures have a 386 px content width because the browser reserves 4 px for its scrollbar. `implementation-mobile-4.png` is 386 × 1167 px; document width 386 ≤ viewport width 390. `implementation-profile-mobile-4.png` records the profile modal. Its full-page area beyond the 844 px viewport is not used to assess modal backdrop coverage. Temporary viewport override was reset afterward.

## Comparison history and fixes

1. Initial combined comparison (`comparison-dark-1.png`, `comparison-top-1.png`) — blocked.
   - P2: software controls looked proportional, narrow and underweight. Replaced the website's proportional auxiliary face with a monospace candidate.
   - P2: header actions were too high, DJ title too faint, clock colon too bright, purple edge treatment insufficient. Adjusted alignment, optical weights, colon tokens and local texture/surface treatment.
   - P2: profile card scale was too small. Made desktop profile 850 px wide with the reference's large image/title and vertical rhythm.
2. Revised combined comparison (`comparison-dark-top-2.png`, `comparison-light-2.png`, `comparison-profile-2.png`) — blocked.
   - P2: IBM Plex Mono remained narrow/thin compared with the software screenshot. Changed auxiliary typography to locally hosted Space Mono, selected by direct visual comparison.
   - P2: profile dots were too dense and its dotted title too light. Changed profile tile spacing 18→22 px, title 70→78 px with a heavier Doto instance, and aligned stats columns.
   - P2: switching to FAV kept the queue count and queue empty-message. Corrected heading, count and empty copy to reflect the visible collection.
3. Revised combined comparison (`comparison-dark-3.png`, `comparison-light-top-3.png`, `comparison-profile-3.png`) — blocked pending final optical correction.
   - P2: intermediate font weight 500 used Space Mono's regular face, so control emphasis was weak. Changed emphasized text to the actual 700 face. Tuned profile Doto from 900 to 800 for separated square dots.
4. Final combined comparison (`comparison-dark-4.png`, `comparison-light-4.png`, focused top comparisons, `comparison-profile-4.png`) — passed.
   - All listed P2 findings were recaptured and resolved. The main composition, compact controls, sectional rhythm, contrast scheme, dotted displays and profile proportions now follow the references. No actionable P0/P1/P2 remains within the available reference evidence.

## Required fidelity surfaces

- **Fonts/typography:** Doto from the reference website is locally served with square ROND=0: title 600, clock 900, profile 800. Inter body and Chinese system fallbacks preserve readable real chat content. Space Mono is the closest reviewed auxiliary match, using real regular/bold files. Clock and labels are live text, not screenshot cutouts. Long current song/artist names truncate within the reference's compact player, with full titles available in the queue. Exact original software CSS is unavailable; auxiliary font identification is explicitly an inference, not a claim of binary-identical fonts.
- **Spacing/layout:** 700 px centered radio card, approximately 100 px header, 298 px clock, 104 px player, 36 px queue strip, 58 px DJ strip, 452 px conversation, compact composer/footer. Desktop profile is wider than the main card as in the source. Mobile uses two player rows to keep controls inside the card. No horizontal overflow or overlapping header controls was found at 390 px.
- **Colors/tokens:** black/charcoal dark surfaces, soft gray/light surfaces, muted gray labels, mint active state, violet edge glow and translucent-looking layered sections. Light theme persists across reload. Video compression and source blur prevent objective subpixel color equivalence; very small opacity differences remain acceptable polish.
- **Images/assets:** exact public cat image retrieved from the reference site and served locally. Background dot tiles and cyan profile dot pattern were extracted from user-provided screenshots; no generated avatar or handcrafted illustration substituted. Original Phosphor icon paths are packed into an external sprite. The user's unspecified portrait is represented by a neutral account icon, not the original creator's avatar. Font files return HTTP 200 with font/woff2 MIME.
- **Copy/content:** source hierarchy and English functional labels retained, with Radio Bob's real name and Chinese user history. Live playback/account connection drives status. Profile genre tags derive only from saved taste; an honest edit invitation replaces the source creator's personal genres when empty. Microphone button explains that voice input is not yet connected; it does not pretend to record.

## Functional and accessibility checks

- Actual NetEase account stays linked after reload; no logout or cookie rewrite performed.
- Playback tested on November Rain: media paused=false, currentTime advanced past 23 seconds, full duration 536.466667 seconds. STOP then yielded paused=true/currentTime=0. Test playback was stopped for handoff.
- DARK/LIGHT switching and reload persistence passed; final theme returned to dark.
- SHOW/HIDE expands/collapses real queue; favorites toggle/list and removal passed. Test favorite removed, zero-count and dedicated empty-state verified.
- Avatar/title opens profile; EDIT TASTE transitions to settings; close controls work. Existing auto-voice/service IDs preserved after moving settings into taste dialog.
- Native buttons, labelled ranges, alt text, dialog names, visible keyboard focus styles, reduced-motion rule and actual disabled/loading states retained.
- Browser console error/warning inspection returned an empty list after responsive and interaction checks.
- `node --check public/app.js` passed.
- `npm test`: 19 passed, 0 failed after the last JavaScript edit.
- Read-only DOM regression: 85 HTML IDs, no duplicates; all 172 literal JS references and dynamic theme/service/tab IDs resolve.

No new Claude or Fish generation request was needed for this style change. Existing integration tests and earlier successful sessions cover those providers; this pass does not claim a new live TTS/chat generation test.

## Follow-up polish and explicit limits

- P3: if the original software source/CSS becomes available, confirm the auxiliary font and exact icon set. Current Space Mono selection is a screenshot-based match; no assertion of pixel-perfect or exact-font identity is made.
- P3: video blur and subtitles obscure small texture/color regions. Remaining subpixel dot softness and opacity differences are accepted against this reference quality.
- Live data, longer Radio Bob name, longer song titles, several persisted messages and empty taste naturally differ from the reference's short sample content. These are expected, not placeholder substitutions.

## Implementation checklist

- [x] Main dark/light composition implemented.
- [x] Profile card implemented with real taste/settings.
- [x] Local fonts, actual avatar, source textures and icon assets loaded.
- [x] Post-fix full-view and focused comparisons inspected.
- [x] Desktop/mobile controls and key interactions verified.
- [x] Existing account/history preserved; regression checks pass.
- [x] Local preview kept running; viewport restored; final captures copied to user outputs.
