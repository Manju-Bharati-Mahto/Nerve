# Nerve Media Ops: implementation plan for the mobile presentation layer

**Scope and line numbers.** "F" means `public/media-ops/index.html` in the current working tree: 22,926 lines, of which about 1,900 are an uncommitted diff (`git diff --stat`: 742+/1194−). Line numbers are taken before any change. After P1 adds lines to `<head>`, find code by function name. I re-checked every load-bearing claim with grep/sed. Where the readers disagreed, the resolution is recorded in §2.6.

---

## 0. Outcome (October 2026)

P0–P10 shipped on `nerve-redesign-phase1`, one commit per phase plus three
fixes. **This section is the record of what actually happened; the sections
below are the plan as written beforehand and were not rewritten to match.**
Where they disagree, this section is right.

### What shipped
| Phase | Commit | Note |
|---|---|---|
| P0 measurement | `02662ad` | Playwright harness, desktop fingerprints + pixel baselines, phone report |
| P1 layout switch | `fc8ed42` | `data-layout`, touch-aware Auto, pre-paint theme |
| P2 phone chrome | `fb69b29` | PHONE LAYER, topbar, bar, safe areas |
| P3 navigation | `8e75d97` | Bottom bar, More sheet, Tier A icons |
| P4 toggle | `39acb60` | Display control in profile + More sheet |
| P5 overlays | `8048eed` | Sheets, Back closes overlays, keyboard handling |
| P6 forms | `7406112` | 16px fields, 44px controls, keyboard hints |
| P7 daily screens | `8b5f3c3`, `6b51c0f` | Shared layout utilities; **the fix matters, see below** |
| P8 kanban + RO | `f55fba4`, `5cfed9e` | One column per screen, tap-to-move, sticky first column |
| P9 PWA | `ebf3fdc` | Icons, manifest, `sw.js` v3, update notice, offline card |
| P10 icons | `a50f064` | Status/menu/view-mode glyphs → real icons (**desktop changes here**) |

Plus `df600c1`, a real bug: More-sheet rows navigated and bounced straight
back, because closing the sheet queued a `history.back()` that raced the
navigation. Broken since P5 and the existing test had been failing unnoticed.

### Deliberately not done
- **In-scope standalone sign-in.** §7 recommends it, conditional on a device
  test. Not run, so not built. Decide after installing on iOS: sign out, sign
  in. If iOS loops or lands signed out, build the card described in §7.
- **Lookup/category glyphs (68 of them).** A project type's icon is content an
  admin typed into Lookups, not UI chrome. `mIco()` renders a known icon key as
  an icon and anything else as itself, so these stay as entered. Decided
  against converting on 1 Oct 2026.
- **Per-table `m-cards`.** §5 lists it for many tables. P8 used a sticky first
  column instead: one rule, every table, no per-view markup. `m-cards` and
  `m-sticky` exist for a table that later needs the full treatment.
- **Filter-into-bottom-sheet.** Deferred from P6 through P8. Needs per-view
  markers (`data-filterbar`); filters currently wrap instead.

### Two lessons worth keeping
- **Overflow is a gameable metric.** P7 reached "0 screens overflow" partly by
  setting `overflow-wrap:anywhere`, which broke words — and numbers — at any
  character. The Pipeline tiles rendered "In flight / 45" as "In fligh t" over a
  two-line "4 5" while the gate reported success. Fixed in `6b51c0f`; a test now
  pins that a stat number renders on one line. **Screenshot before believing a
  number.**
- **Read test output in full.** Four burger tests failed silently from P3, and
  the More-sheet test from P5, because failures mid-list were being missed.

### Before trusting a deploy
1. `npm run build` — `build:client` stamps `mo-build` into `dist/media-ops`.
   Without that stamp the update notice can never fire.
2. Bump `CACHE` in `sw.js` whenever the shell list, manifest or icons change.
3. `npm run icons:media-ops` after any brand-colour change, then step 2.

### The device test that is still owed (§10)
Install on a current iPhone and an Android, then check: the home-screen icon
and name; it opens portrait, standalone, with no browser chrome; the status bar
matches the theme; safe areas clear the notch and home indicator; sign out and
back in; airplane mode shows the offline card, not seed data; deploy again and
confirm the update banner appears.

---

## 1. What exists today

- **Head (F:1-10).** `viewport` already has `viewport-fit=cover` (5). `theme-color` is `#0E1512` (6). The manifest link is at 7. `apple-touch-icon` points to `icon.svg` (7), which iOS cannot use. `<html>` carries only `data-theme` (2). There is no head script, and no JS anywhere calls `matchMedia`. The only viewport read is in `menu()` (F:3312-3314: `innerWidth`/`innerHeight`), and no touch or pointer handlers exist.
- **Phone mode is a single width query.** `@media(max-width:820px)` at F:897-913 makes `#sidebar` off-canvas, shows `#mobilebar`, sets `#content` padding-bottom to 58px, adjusts `.page` padding, and hides `.hide-sm`. `.only-sm` (914) is unused. The other width blocks are at 245, 253, 273-275, 375-376, 438, 454, 500, 616, 808 and 976-982. View-injected `<style>` adds `.myday-cols` at min-width 1040/1500 (F:5865-5866, 6782-6783, without `!important`) and SMC rules at max-width 640 (22043, 22333).
- **Bottom bar.** The static glyph markup (F:1069-1076: ◉ ▤ ＋ ▣ ◔) has no handlers until boot. `renderMobileBar()` (F:3638-3658) does one of two things:
  - Outside the Creator Network (CN), it hardcodes My Day / Projects / Log FAB / Gear / Alerts, filtered only by `moduleAllowed`.
  - Inside the CN, it shows `cnItems().slice(0,5)` with `ic()` SVGs that nothing sizes. `#mobilebar button .mi{font-size:18px}` at 877 is the only rule.
  - In both cases there is no Home, no More and no badges, and the active state is an exact match only.
- **The off-canvas nav cannot be closed (verified).** `#btn-burger` only toggles `body.nav-open` (3771). `#scrim.on` is set only by `openDrawer` (3301), so the scrim handler at 3772 can never fire. `render()` (3720-3752) and Esc (3992) never clear `nav-open`. The open `#sidebar` (z40, 156-158) covers the burger in `#topbar` (z30, 205-207). `#mobilebar` (z50) covers the Kiosk/collapse row (1011-1016).
- **Safe areas.** Only `#mobilebar` uses `env()` (872), and it has no effect: with border-box, the height stays 58px and `.mb-in` is also 58px (873). `#content` padding ignores the inset (905). `#toasts` sits at bottom 24px, z99, on top of the bar (685).
- **Overlays.**
  - `modal()` (3291-3298) is a centred card with 88vh max height and a 60ms autofocus.
  - The drawer (3300-3303) is 500px wide, or 100vw at ≤560.
  - `menu()` (3304-3317) is a z88 popover that sits under the z90 modal.
  - The palette (3960) uses 11vh/70vh.
  - Toast icons are glyphs (3285).
  - The kiosk is z120 and has no overflow handling.
  - No overlay closes on route change or Back. There is no `pushState`, `popstate` or `visualViewport` anywhere.
- **Icons.** `ICONS` has 54 keys (3143-3198). `ic()` (3199-3200) sets no width, height or aria. Everything else uses glyphs: toasts, about 125 ✕ close buttons, status maps, quick-add (3875-3887), and palette rows. The palette rows print the raw key text, such as "home" (3973).
- **Forms.** `.inp` is 13.5px/36px (568), so iOS zooms on focus. `.btn.xs` is 24px (343), `.seg` buttons 26px (593), `.icon-btn` 36px (211). `.row` never wraps (580). `.tabs` scroll with no affordance (619).
- **PWA and auth.**
  - The manifest has scope `/api/media-ops/`, start `index.html#/media/home`, orientation `any`, colour `#0E1512`, and one SVG icon marked "any maskable".
  - `sw.js` uses `mo-v2`. It caches the navigation response without an `r.ok` check and serves the manifest and icon cache-first.
  - `icon.svg` still uses the old green (#3B9B76→#0F4E37).
  - Sign-out and 401 both call `location.replace('/login…')` (21696, 21701), which is outside the manifest scope.
  - `clearClientAuth()` (21687-21691) runs `localStorage.clear()` and unregisters every service worker.
- **Tests and tooling.**
  - 19 jsdom UI tests boot F through `new JSDOM(...)`, which has no `matchMedia`.
  - `equipment-read-model.ui.test.ts:1918` asserts that localStorage is empty after an offline kiosk run.
  - `scripts/audit-media-ops-bundle.mjs` runs `node --check` on each inline script. It also requires every `data-act` to have a two-space-indented ACTIONS entry.
  - Playwright 1.58.2 and Chromium 1208 are installed. WebKit is not.
  - `playwright.config.ts` is empty, so Playwright would pick up the vitest files.

---

## 2. Architecture of the change

### 2.1 The switch
`<html data-layout="mobile|desktop" data-layout-pref="auto|desktop|mobile">`. All phone CSS keys off `data-layout`. All phone JS asks `isMobileLayout()`.

### 2.2 Where it is set: a synchronous head script inserted after the head meta/link tags (after F:10 `<title>`, so after the viewport meta at F:5 and the theme-color meta at F:6 that it reads), before `<style>` (F:11)
```js
<script>(function(){
  var KEY='mo_layout', d=document.documentElement, vp=document.querySelector('meta[name=viewport]'),
      tc=document.getElementById('tc-phone'), VP0=vp&&vp.getAttribute('content'),
      MM=(typeof window.matchMedia==='function')?function(q){return window.matchMedia(q);}:null,
      /* Auto is TOUCH-aware: a mouse/trackpad desktop window never becomes "mobile",
         however narrow or zoomed it is. It keeps today's ≤820 regime instead. */
      mq=MM?MM('(max-width: 820px) and (hover: none) and (pointer: coarse), (hover: none) and (pointer: coarse) and (max-height: 500px)'):null,
      touch=!!(MM&&MM('(hover: none) and (pointer: coarse)').matches),
      narrow0=touch&&window.innerWidth<=820,   /* measured once, against the ORIGINAL viewport */
      pending=false;
  function pref(){ var q=/[?&]layout=(auto|desktop|mobile)\b/.exec(location.search); if(q) return q[1];
    try{ var p=localStorage.getItem(KEY); return p==='desktop'||p==='mobile'?p:'auto'; }catch(_){ return 'auto'; } }
  function theme(l){ if(l!=='mobile') return null;            /* Q17: persisted theme is phone-only */
    try{ var t=localStorage.getItem('mo_theme'); return t==='dark'||t==='light'?t:null; }catch(_){ return null; } }
  function apply(){ var p=pref(), l=p==='auto'?(mq&&mq.matches?'mobile':'desktop'):p, was=d.dataset.layout;
    if(was&&was!==l){
      /* Never flip under an open overlay: postpone until the overlay closes or the route changes. */
      if(typeof window.moCanFlip==='function'&&!window.moCanFlip()){ pending=true; return; }
      dispatchEvent(new Event('mo:layout-before'));           /* teardown runs while the OLD layout is still set */
    }
    pending=false;
    if(vp) vp.setAttribute('content',(p==='desktop'&&narrow0)?'width=1280, viewport-fit=cover':VP0);
    d.dataset.layout=l; d.dataset.layoutPref=p;
    var t=theme(l); if(t) d.dataset.theme=t;
    if(tc) tc.setAttribute('content',l==='mobile'?(d.dataset.theme==='dark'?'#131A24':'#FFFFFF'):'#0E1512');
    if(was&&was!==l) dispatchEvent(new Event('mo:layout')); }
  apply();
  if(mq){ var h=function(){ if(pref()==='auto') apply(); };
    mq.addEventListener?mq.addEventListener('change',h):(mq.addListener&&mq.addListener(h)); }
  window.moLayout={ get pref(){return pref();}, get layout(){return d.dataset.layout;},
    flushPending:function(){ if(pending) apply(); },
    set:function(v){ try{ v==='auto'?localStorage.removeItem(KEY):localStorage.setItem(KEY,v); }catch(_){}
      var before=vp&&vp.getAttribute('content'); apply();
      if(vp&&vp.getAttribute('content')!==before) location.reload(); } };
})();</script>
```
- It never writes storage at boot, so `equipment-read-model.ui.test.ts:1918` stays green.
- Without `matchMedia` (jsdom) it resolves to `desktop`, so all 19 jsdom tests keep taking the desktop path. It uses `window.matchMedia`, never the bare identifier.
- `?layout=` is a QA-only override and is not persisted.
- **Auto is touch-aware** (critique: desktop-leak). Mouse users at any width or zoom stay `desktop` and keep today's ≤820 regime, so resizing, Snap/Split View, docked DevTools or 200% zoom never flips a desktop window. A live Auto flip can now happen only on a touch device (for example an iPad rotating 820↔1180, or Split View on iPad).
- **No flip under an open overlay.** The main script defines `window.moCanFlip=()=>!moOverlayOpen()` (modal-layer `.on`, `#drawer.on`, `#palette.on`, `.menu`, `#m-sheet.on`, `#kiosk.on`). While it returns false, the flip is postponed. Every closer and the hashchange handler call `moLayout.flushPending()`. So a half-filled form is never torn down by a rotation or resize.
- **Viewport rewrite only on narrow touch devices.** `narrow0` is measured once from the original viewport (`innerWidth<=820` on a coarse, no-hover device). Desktop laptops (1366×768, 1280×800) and landscape tablets never get the `width=1280` rewrite, so choosing Desktop/Auto on them never reloads and never discards in-memory state.
- **Theme-color and persisted theme are applied before paint** (see §7 head meta and Q17). The `#tc-phone` meta must come **before** this script in `<head>`.
- In the main script, next to the `$` helpers (F:3134-3137), add:
  - `const isMobileLayout=()=>document.documentElement.dataset.layout==='mobile';`
  - a guarded `isStandalone()` that checks `matchMedia('(display-mode: standalone)')` or `navigator.standalone===true` inside try/catch.
- Add, next to the hashchange listener (F:3752):
  - `addEventListener('mo:layout-before',()=>{closeMoreSheet();document.body.classList.remove('nav-open');moTeardownAll();})`. It runs while the **old** layout is still set. Because flips are postponed while an overlay is open, it never has a modal, drawer or form to close; `moTeardownAll()` is a safety net that removes any leftover `inert`/`aria-hidden`/`kb-open` and discards overlay-stack bookkeeping without calling `history.back()`.
  - `addEventListener('mo:layout',()=>{renderNav();renderMobileBar();render();})`. No overlay closers here.
  - The hashchange handler and every overlay closer end with `moLayout.flushPending()`.
- **Teardown depends on state, not on the current layout.** Each overlay records what it set (`o.inerted`, `o.pushed`, `o.kb`). Its closer undoes exactly those, whatever `isMobileLayout()` now returns. Only the overlay that owns the top `{moOv}` history entry calls `history.back()`, once, and never while handling `popstate` (a `_inPop` flag). The Esc chain at F:3992 (`closePalette();closeModal();closeDrawer();closeMenu();`) therefore produces at most one `history.back()`.

### 2.3 How each mode resolves
| Preference | Device or window | `data-layout` | Viewport | CSS in force |
|---|---|---|---|---|
| auto | touch device ≤820px (phones in portrait, iPad portrait) | mobile | device-width | existing ≤820 block plus the phone layer |
| auto | landscape phone (coarse pointer, height ≤500, width 844-932) | mobile | device-width | phone layer only; its mirrors supply the chrome |
| auto | touch device >820px | desktop | device-width | today's desktop, unchanged |
| auto | mouse/trackpad desktop window at **any** width or zoom (including ≤820) | desktop | n/a | today's desktop, or today's ≤820 regime when narrow, unchanged apart from the Q5 burger fix |
| desktop | narrow touch device (`innerWidth` ≤820 at load) | desktop | **width=1280** plus a reload | today's desktop, zoomed out; no max-width rule matches |
| desktop | landscape tablet or any non-touch device | desktop | unchanged (no rewrite, no reload) | today's desktop |
| desktop | narrow desktop browser window (viewport meta ignored) | desktop | n/a | today's ≤820 regime, unchanged apart from the Q5 burger fix |
| mobile | any width, including 1440 | mobile | device-width | phone layer at full width |

### 2.4 Reconciling the existing @media rules and JS width checks
- **Every existing `@media` block stays byte-identical**, including 897-914.
- There is one new section just before `</style>` (F:996), after the print block, headed `/* ==== PHONE LAYER ==== */`. It contains no `@media`. It has two parts:
  - **(a) Attribute mirrors** of the width rules the phone layer relies on, so that forced-Mobile above 820 and landscape phones work:
    - chrome from 897-913 (`#mobilebar{display:block}`, `.page` padding, `.page-title` 22px, `.hide-sm{display:none!important}`, `.tbl-wrap{overflow-x:auto}`)
    - **`.hide-sm` audit (P7 gate).** About 20 `.hide-sm` sites exist, and some are controls, not decoration: the CRUD "Created by" select and "Created on or after" date (F:14886, 14888), plus data columns (Location, Project, Type, Crew; project crew and deliverable counts). Every site gets a phone destination before its screen ships: controls move into the filter sheet (the CRUD toolbar gets `data-filterbar`, and a scoped `html[data-layout="mobile"] .fb-sheet .hide-sm{display:revert!important}` un-hides them there); hidden table cells become `data-m=meta` inside `m-cards`. A jsdom/Playwright check lists every `.hide-sm` control (`select,input,button`) and fails if it has no phone destination
    - grids 273-275 (`:is(.g2,.g3,.g4,.g5,.g21,.g12,.mg-wrap){grid-template-columns:1fr}`)
    - `.ts-strip`/`.ts-card` (376), `.asg-chip b` (500), `#drawer` (616), `.facets` (808), `.opp-row` (976-982), `.role-switch .who` (245)
    - `.myday-cols{grid-template-columns:1fr}`: specificity (0,2,1) beats the injected (0,1,0), so no `!important` is needed
    - copies of the SMC 640 rules
  - **(b) The new phone presentation rules.**
- **JS width checks.** Only `menu()` reads the viewport. It gets a phone action-sheet branch plus a `Math.max(10,…)` clamp on `left`. The clamp is invisible at desktop widths.

### 2.5 Desktop-protection rule (every change must obey it)
1. Existing selectors, declarations and `@media` blocks are never edited or reordered.
2. Every new CSS selector starts with `html[data-layout="mobile"]` (compound forms such as `html[data-layout="mobile"].kb-open …` count; a bare `html.kb-open …` does not). The single allowed exception is `html:not([data-layout="mobile"]) .m-only{display:none!important}`. New `@keyframes` inside the PHONE LAYER must be named `m-*` and must not redefine an existing keyframe name (`pop`, `slideUp`, `fadeOut`, `shimmer`, `scan`, `skp`). The scope test enforces both.
3. New markup in shared templates is either attributes only (`data-m`, `data-filterbar`, class hooks) or elements carrying `.m-only`.
4. Every JS behaviour change sits behind `if(isMobileLayout())` or `if(isStandalone())`, or in a function only phone code calls. Fixes that are visible on desktop ship as separate, signed-off commits (§11, Q5).
5. Enforcement:
   - a static vitest (`src/test/phone-layer-scope.test.ts`) that fails on any phone-layer selector that does not follow rule 2
   - Playwright desktop baselines at 1440×900, 1280×800, 1024×768 and 821×900 for every role and route, with `maxDiffPixels:0`, gating every phase
   - **plus desktop baselines at ≤820 and under zoom** (no preference, mouse pointer): 800×900 and 1440×900 at 200% (`deviceScaleFactor:2` with a 720×450 CSS viewport), each with the sidebar open and a nav item clicked
   - **plus desktop behaviour checks** that pixels cannot catch: with overlays open (task-log modal, drawer, menu), `setViewportSize` 1280→800→1280 keeps the typed input and the route; jsdom asserts that on desktop `#tl-link` has no `type`, the blocker path still toasts, `#drawer` never gets `inert`, and the palette/role-label/refocus changes appear only in their Q5 commits

### 2.6 Reader disagreements, resolved against the code
| Question | Resolution |
|---|---|
| Wrap 897-913 in `:where(html:not([data-layout=desktop]))` (reader 8), or leave it untouched (reader 1)? | **Leave it untouched.** Forced-Desktop on phones goes through the viewport rewrite, so 820 never matches. The only remaining "desktop at ≤820" case is a narrow or zoomed mouse-driven desktop window. Because Auto is touch-aware (§2.2), that window stays `desktop` under **every** preference, including the Auto default, and keeps today's behaviour. |
| Does `.myday-cols` need `!important`? | No. F:6782-6783 and 5865-5866 have no `!important`, and (0,2,1) beats (0,1,0) regardless of source order. |
| Attribute and key names | `data-layout` and the key `mo_layout`, matching the existing `mo_crud_filter` at F:14823. |
| Hide the topbar Quick add on phones? | **Keep it.** It is the only phone path to Book / Leave / Assign / Board card. `renderNav` already hides it when empty (F:3602), which covers creators. |
| Filter the bar with `moduleAllowed` or the NAV predicate? | The NAV predicate. The seed grants `requests` and `dispatch` to team_lead, employee and smc_member (mediaops-db.ts:3301-3310), but NAV `roles:['coordinator','admin']` (F:3402-3403) and the views deny them (5352, 5467). |
| CN bar: "first four" (comment) or `slice(0,5)` (code)? | The code slices 5 (F:3643). The new model is 4 items plus More. |
| Where is the Escape handler? | F:3992. F:3984 is the palette input's Esc. |
| Is the burger visible on desktop? | Yes. No rule hides `#btn-burger` (1022). Leave it as is. |

---

## 3. Files and functions to modify

### Head and boot
| File | Function / selector / line | Change | Why |
|---|---|---|---|
| F | after line 10 (after the viewport and `#tc-phone` metas) | Head script from §2.2 | Pre-paint attribute, no flash, viewport rewrite |
| F | 3134-3137 (UI primitives) | Add `isMobileLayout()`, `isStandalone()`, `closeMoreSheet()` stubs | One predicate for all JS |
| F | `render()` 3720-3751 | Compute `routeChanged = hash!==S._lastRoute`. When `isMobileLayout()&&routeChanged`: close the overlay stack (§3 overlays) and remove `nav-open`. Replace `$('#content').scrollTop=0` (3747) with `if(!isMobileLayout()||routeChanged)` | Overlays go stale after Back; in-page taps jump to the top |
| F | 3752 | Add the `mo:layout-before` and `mo:layout` listeners, `moCanFlip`, `moTeardownAll`, and `moLayout.flushPending()` in hashchange (§2.2) | Live switching on touch devices without losing overlay state |
| F | boot 22885 | `if(!location.hash) location.hash = isMobileLayout()? mobileLanding() : '#/media/home'` (Q9). `mobileLanding()` = first bar route, else `firstAllowedRoute()` (F:3508), else `'#/media/home'`; never `undefined`/`null` | Land on the first bar item on phones; safe when the bar has only More |
| F | S init 2303 | `theme: document.documentElement.dataset.theme||'light'` (desktop: the markup's `light`, unchanged) | Picks up the pre-paint phone theme (Q17) |
| F | `clearClientAuth` 21696 | Read `mo_layout` and `mo_theme` **before** `localStorage.clear()`, and write back each one **only if non-null**, on the line right after `clear()` (synchronously, before the first `await`) | Device preferences survive logout and 401; no `"null"` strings; an unset preference leaves storage empty |

### CSS layer
| File | Line | Change | Why |
|---|---|---|---|
| F | insert before 996 `</style>` | Add the PHONE LAYER. Contents: (1) tokens under `html[data-layout="mobile"]`: `--topbar-h:56px; --mbar-h:60px; --tap:44px; --safe-t/r/b/l:env(safe-area-inset-*,0px)`; (2) `-webkit-text-size-adjust:100%; -webkit-tap-highlight-color:transparent`; (3) `a,button{touch-action:manipulation}` with an `:active` tint; (4) `button.stat:hover,.gal-card:hover{transform:none}`; (5) `#content{scroll-behavior:auto;overscroll-behavior-y:contain}`; (6) the mirrors from §2.4; (7) every other phone rule in this plan. | Single auditable home for phone CSS |
| F | 880-895 `.phone*`, `.sheet*` (dead) | Do not reuse the names. New primitives are `.m-sheet`, `.menu.as-sheet`, `.fb-sheet`. Delete the dead block later in a separate commit. | `.sheet` is `position:absolute; translateY(101%)` and would leak |

### Chrome: topbar, bottom bar, More sheet, sidebar
| File | Function / selector / line | Change | Why |
|---|---|---|---|
| F | topbar markup 1021-1048 | After the burger, add `<b class="m-title m-only" id="m-title"></b>`. Before quick-add, add `<button class="icon-btn m-only" id="btn-msearch" aria-label="Search">`+search SVG+`</button>` | Page title and search icon on phones |
| F | phone CSS | `#sidebar,#btn-burger,.search-wrap,.role-switch>svg{display:none}`. `#topbar{padding:0 max(12px,var(--safe-r)) 0 max(12px,var(--safe-l));gap:4px}`. `.m-title{flex:1;min-width:0;font:650 17px/1.2 var(--font-ui);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`. `#topbar .icon-btn,.role-switch{width:44px;height:44px}` | Title width is about 104px at 320, 159px at 375, 214px at 430 with 4 buttons |
| F | `renderNav` 3620 | Also write the crumb text into `#m-title`. On phones, hide `#btn-bell` when `DB.my_module_group==='creator'`, whose notifications are always empty (22842) | Title after scroll; no dead bell for creators |
| F | shell wiring 3771-3772, keydown 3992 | `#btn-msearch.onclick=()=>openPalette()` (phone). **Desktop ≤820 burger fix, its own Q5 commit:** Burger: `if(window.matchMedia&&window.matchMedia('(max-width:820px)').matches) $('#scrim').classList.toggle('on',document.body.classList.contains('nav-open'))`. Because `#scrim` is z60 (F:599-601) and `#sidebar` z40 (F:156-158), the same commit adds one desktop rule, `body.nav-open #sidebar{z-index:61}`, so the open sidebar sits **above** the scrim and nav taps reach it; the scrim still covers the topbar (z30) and content, and tapping it closes the nav. Esc adds `document.body.classList.remove('nav-open')` | Fixes the unclosable drawer in the desktop ≤820 regime; invisible above 820 (the rule only matters when `nav-open` is set, which only the burger does). Gated by the new 800×900 desktop baseline (sidebar open, nav item clicked) |
| F | static bar 1069-1076 | Replace with `<div class="mb-in"></div>` | No dead buttons before boot |
| F | `renderMobileBar` 3638-3658 | `if(isMobileLayout()) return renderPhoneBar();`. The legacy branch stays **byte-identical** for the desktop ≤820 regime, glyphs included (◉ ▤ ＋ ▣ ◔). `ic()` has no width/height (F:3199-3200) and `.mi` is sized only by `font-size` (F:877), so SVGs there would render at intrinsic size. Any glyph swap in the legacy bar belongs to P10/Q6 with a Q5-signed `#mobilebar .mi svg{width:20px;height:20px}` rule | New model on phones only; desktop ≤820 unchanged |
| F | new `renderPhoneBar()` | Render `<a href class="mb-it">` items: `ic(it.mi||it.i)`, the `ml\|\|l` label, `aria-current`, and an `it.badge()` pill. FAB is a `<button class="fab" aria-label="Log a task">`. More is a `<button data-mb="more" aria-haspopup="dialog">` with a dot when any sheet item has a badge. Active when `hashModule(S.route)===hashModule(it.r)`, or `cnCurrent().k` inside the CN. Tapping the active tab scrolls `#content` to the top | Implements §4 |
| F | phone CSS | `#mobilebar{display:block;height:calc(var(--mbar-h) + var(--safe-b));padding:0 var(--safe-r) var(--safe-b) var(--safe-l)}` `.mb-in{height:var(--mbar-h)}` `#mobilebar :is(a,button){flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:10.5px;font-weight:600;color:var(--text-3)}` `#mobilebar svg{width:22px;height:22px}` FAB is a 44px circle with shadow `rgba(37,99,235,.40)`. `#content{padding-bottom:calc(var(--mbar-h) + var(--safe-b))}` | Clears the home indicator; brand-blue glow |
| F | after 1076 | `<div id="m-sheet-scrim" class="m-only"></div><div id="m-sheet" class="m-sheet m-only" role="dialog" aria-modal="true" aria-labelledby="m-sheet-h"></div>`. It must **not** go inside `#nav` (creator-shell.ui.test.ts:80 asserts the `#nav .nav-item` list) | More sheet container |
| F | new `openMoreSheet()`/`drawMoreSheet()` | Grouped rows (§4). Phone CSS: `.m-sheet{position:fixed;left:0;right:0;bottom:0;max-height:calc(100dvh - var(--safe-t) - 24px);overflow-y:auto;overscroll-behavior:contain;border-radius:var(--r-xl) var(--r-xl) 0 0;padding-bottom:var(--safe-b);z-index:75;transform:translateY(101%)}` `.m-sheet.on{transform:none}`. 48px rows | Everything off the bar stays reachable |

### Navigation model
| File | Function / line | Change | Why |
|---|---|---|---|
| F | `NAV` 3391-3463 | Add literal-only fields `ml` (short label) and `mi` (phone icon). requests `ml:'Requests',mi:'inbox'`; dispatch `mi:'send'`; pipeline `ml:'Pipeline'`; reports `ml:'Reports',mi:'clipboard'`; boards `ml:'Boards'`; casting `ml:'Casting',mi:'clapper'`; casting-admin `ml:'Casting mgmt'`; library `ml:'Library',mi:'gallery'`; smc `ml:'SMC',mi:'megaphone'`; tv `ml:'TV board',mi:'tv'`; admin/users `ml:'Users',mi:'usercog'`; admin/audit `ml:'Audit'`; ai `ml:'AI'` | Distinct icons and short labels without changing desktop (renderNav reads only `i`/`l`). `mediaops-tv-access.test.ts:60` executes this block, so use literals only |
| F | after `navShow` 3467 | `const navReachable=it=>navShow(it)&&moduleAllowed(hashModule(it.r));`. Use it in `renderNav` 3581, `firstAllowedRoute` 3509 and `paletteItems` 3931, with identical output | One predicate for all four projections |
| F | new, next to `renderMobileBar` | `MOBILE_PRIMARY` keyed by `DB.my_module_group\|\|role()`, and `CN_MOBILE` keyed by `cnMode()` (§4), holding **module keys, not route literals**, so `mediaops-module-defaults.integration.test.ts:165-172` is unaffected. `mobileBarModel()` filters with `navReachable`, takes the first 4, or 3 plus the FAB when `moduleAllowed('reports')`, then appends More. `mobileLanding()` returns the first bar route | Bar derived from real permissions |
| F | `CN_NAV` 11015-11074 | Add `mi` fields: profile `user`, payouts `wallet`, warzone `swords`, achievements `award`, board (leaderboard) `trophy`; `ml` on opps (Q8) and on lead `teams` `'Team'`. Do not reorder | CN de-duplication; order drives the desktop sidebar and landing |
| F | 3611, 3783 | Add `coordinator:'Coordinator'` to both role-label maps | Wrong label on the profile control. Desktop-visible text, so sign-off (Q5) |

### Icons
| File | Line | Change | Why |
|---|---|---|---|
| F | `ICONS` 3143-3198 | Append the §6 keys, copied as element strings from `node_modules/lucide-react/dist/esm/icons/*.js` (v0.462.0, ISC), with a licence comment. All 60 source files were confirmed present | Own SVG set, no runtime dependency |
| F | `ic()` 3199 | Add `aria-hidden="true" focusable="false"`. **No `<title>`**: creator-navigation.ui.test.ts reads `textContent` | Accessibility, no visual change |
| F | new | `icoOrGlyph(v)` returns `ICONS[v]?ic(v):esc(v)`. `gi(key,glyph)` returns `(isMobileLayout()\|\|ICON_REFRESH)?ic(key):glyph`, with `ICON_REFRESH=false` until Q6 | Glyphs become SVG on phones now and on desktop only when approved |
| F | 3285, 13541, 13670 | Rename the shadowing locals `ic` (toast) → `tIcon`, `ic` → `presGlyph`, `ICONS` → `TEAM_GLYPHS` | Otherwise `ic('…')` throws inside those functions |
| F | `drawPalette` 3973 | Use `icoOrGlyph(it.i)` | Fixes the "home"/"myday" text bug. Desktop-visible (Q5) |

### Overlays: modal, drawer, menu, palette, toast, kiosk as sheets
| File | Function / line | Change | Why |
|---|---|---|---|
| F | new overlay stack (pushes only on phones; pops by state) | `ovPush(kind,closeFn)` calls `history.pushState({moOv:n},'')` (same URL, so no hashchange) and records `{kind,n,pushed:true}` on a stack. A `popstate` handler sets `_inPop`, closes the top overlay, clears `_inPop`. Closing from the UI calls `history.back()` **only** when the closing overlay owns the top stack entry and `!_inPop`; any other closer just drops its own entry. So the Esc chain (4 closers in a row) calls `history.back()` at most once. Each overlay kind pushes once, on its closed→open transition | Android Back and the iOS edge swipe dismiss overlays; no extra Back navigations off the route |
| F | `modal()` 3291-3298 | Phone path: set `layer.dataset.mkind` to `opts.mobile` or, if there is no text input or `size==='small'`, `'sheet'`, otherwise `'full'`. Skip autofocus and focus the `.modal` (tabindex -1). Set `aria-labelledby` from the first `.mo-head h2`. Inject `<button class="icon-btn ml-auto" aria-label="Close">${ic('x')}</button>` when the head has none. Dirty guard: backdrop tap or Back after input asks `confirm('Discard changes?')`. Call `ovPush`. **Keep the DOM ids and synchronous render** (openTaskLog callers at 17068 and 21203-21210 read `#tl-*` right away) | Bottom sheets and full-screen forms |
| F | phone CSS | `#modal-layer{padding:0;place-items:end stretch;top:var(--vvt,0);bottom:auto;height:var(--vvh,100dvh)}`. `[data-mkind=sheet] .modal{width:100%;max-height:calc(100% - 24px - var(--safe-t));border-radius:var(--r-xl) var(--r-xl) 0 0;animation:slideUp 200ms var(--ease)}`. `[data-mkind=full] .modal{width:100%;height:100%;max-height:none;border-radius:0}`. `.mo-head{padding-top:calc(12px + var(--safe-t))}`. `.mo-body{padding:16px;overscroll-behavior:contain}`. `.mo-foot{padding:12px 16px calc(12px + var(--safe-b));flex-direction:column-reverse;align-items:stretch}`. `.mo-foot .f{flex-wrap:wrap}`. `.mo-foot .btn{width:100%;min-height:44px}` | The footer stays visible; the profile footer no longer overflows (about 337px of buttons in 238-332px) |
| F | `closeModal` 3299, `openDrawer`/`closeDrawer` 3300-3303 | Open (phone only): `ovPush`, set `$('#app').inert` and `#mobilebar.inert`, record `inerted=true`; the drawer focuses `.dr-head h2`. **Close (any layout, state-driven):** if this overlay set `inert`/`aria-hidden`/`kb-open`, remove them; if it pushed, pop per the stack rule; focus returns to the opener; then `moLayout.flushPending()`. Closed-drawer `inert`/`aria-hidden` is **phone-only** (set in the phone open/close path, never on desktop) | Screen readers, focus; a layout flip can never leave `#app` inert on desktop |
| F | phone CSS | `#drawer{width:100%;top:var(--vvt,0);height:var(--vvh,100dvh)}`. `.dr-head{padding-top:calc(var(--s4) + var(--safe-t))}`. `.dr-head .icon-btn{width:44px;height:44px}`. `.dr-foot{padding-bottom:calc(var(--s3) + var(--safe-b))}`. `.dr-foot .btn{min-height:44px}`. `.dr-body{overscroll-behavior:contain}` | Home indicator, rubber-banding |
| F | phone CSS (left/right insets) | Landscape iPhones have ~47-62px left/right insets under `viewport-fit=cover`, and iOS ignores the manifest `orientation`. Add `.page{padding-left:max(var(--s3),var(--safe-l));padding-right:max(var(--s3),var(--safe-r))}`, and matching `padding-left/right:max(<current>,var(--safe-l/r))` on `.m-sheet`, `[data-mkind] .modal .mo-head/.mo-body/.mo-foot`, `.dr-head/.dr-body/.dr-foot`, `.menu.as-sheet`, `.pal-inp/.pal-list`, `.fb-sheet` | Content, sheets, drawer and menus stay clear of the notch/Dynamic Island in landscape |
| F | `menu()` 3304-3317 | Phone: add class `as-sheet`, skip positioning, append a `.menu-scrim`, add a Cancel row, keep the item and `fn` wiring. The `left=Math.max(10,…)` clamp is desktop-visible and ships only as a Q5 commit (phone path skips positioning anyway). `wirePage` 3762 passes a regenerator so multi-select menus (items with `on`) stay open on phones | Thumb-reachable, 48px rows |
| F | phone CSS | `.menu.as-sheet{left:0;right:0;bottom:0;top:auto;width:100%;min-width:0;max-height:70dvh;border-radius:var(--r-xl) var(--r-xl) 0 0;padding-bottom:calc(8px + var(--safe-b));z-index:92}`. `.menu.as-sheet .menu-item{min-height:48px;font-size:15px}`. `.menu-item svg{width:16px;height:16px}` | Above the modal (z90) so menus inside modals work |
| F | `openPalette` 3960, markup 1058-1066 | Add `<button class="btn ghost m-only" onclick="closePalette()">Cancel</button>` in `.pal-inp`, plus `enterkeyhint="search"`. Phone CSS: `#palette{padding:0;align-items:stretch;top:var(--vvt,0);height:var(--vvh,100dvh)}`, `.pal{width:100%;max-height:none;border-radius:0}`, `.pal-inp{padding-top:calc(14px + var(--safe-t))}`, `.pal-foot{display:none}`, `.pal-item{min-height:52px}` | Phone search screen |
| F | `toast()` 3283 | Icons via `gi('tick'\|'xcircle'\|'alert'\|'info', glyph)`; `role="alert"` on `bad` **only when `isMobileLayout()`** (desktop gets it only through Q5). Phone CSS: `#toasts{left:max(12px,var(--safe-l));right:max(12px,var(--safe-r));transform:none;width:auto;max-width:none;bottom:calc(var(--mbar-h) + var(--safe-b) + 8px);z-index:130}`; `html[data-layout="mobile"].kb-open #toasts{top:calc(var(--safe-t) + 12px);bottom:auto}`; `.toast button{min-height:44px}` | Toasts stop covering the bar and stay visible over the keyboard and the kiosk |
| F | new `mVV()` listener | Phone only: on `visualViewport` resize and scroll, set `--vvh`/`--vvt` on `<html>` and toggle `html.kb-open` when `innerHeight - vv.height > 120`. Add `html[data-layout="mobile"].kb-open #mobilebar{display:none}`. A delegated `focusin` on modal and drawer calls `scrollIntoView({block:'center'})` after 250ms. `fieldError()` (1143) also scrolls on phones | Keyboard covering Save and fields |
| F | `#kiosk` 838, keydown 3992 | Phone CSS: `#kiosk{overflow-y:auto;justify-content:flex-start;padding:max(var(--s4),var(--safe-t)) max(var(--s4),var(--safe-r)) max(var(--s4),var(--safe-b)) max(var(--s4),var(--safe-l))}` (keeps a gutter on non-notched 320-375px phones, where every inset is 0; F:839 today is `padding:var(--s5)`) and `.kiosk-inner{margin:auto 0}`. Esc check becomes `S.kiosk.step<1` (desktop fix, Q5) | Steps 3-4 are about 760px tall on a 667px screen |

### Forms and filters
| File | Function / line | Change | Why |
|---|---|---|---|
| F | phone CSS | `:is(.inp,select.inp,textarea.inp,.pal-inp input){font-size:16px!important}` (`!important` overrides the roughly 20 inline-styled selects). `.inp:not(textarea),select.inp{height:44px!important}`. `.btn{min-height:40px}`. `:is(.btn.xs,.btn.sm,.chip,.dc-btn,.seg button,.btn-group button){position:relative}` with `::after{content:'';position:absolute;inset:-8px}`. `.seg button{height:40px}`. `.chk input{width:20px;height:20px}`. `.mo-body .row,.dr-body .row{flex-wrap:wrap}` and `>.field{flex:1 1 140px}`. Date and time inputs get `appearance:none;min-width:0;text-align:left` | iOS zoom, 44px targets, date fields |
| F | new `mInputAttrs(root)` | Run at the end of `modal`, `openDrawer` and `render` on phones. `input[placeholder^="https://"]` gets `autocapitalize=off autocorrect=off spellcheck=false inputmode=url`. `type=number` gets `inputmode` numeric or decimal. Search placeholders get `enterkeyhint=search` | "Https://" fails the case-sensitive checks at 17288, 17632 and 17712 |
| F | 4764, 4820, 5397, 5484 | Route the handlers through a `setFilterAndRefocus(id)` helper modelled on `ACTIONS.dirSearch` (16765); add ids `castadm-q`, `castreq-q`, `req-q`, `disp-q` | The keyboard closes after one character. Desktop bug too (Q5; phone-gated if not approved) |
| F | `openTaskLog` 15722-15819, `saveTask` 17272 | **Phone only (`isMobileLayout()`)**: `type=url inputmode=url autocapitalize=off` on `#tl-link`, `inputmode=numeric` on `#tl-qty/#tl-pb/#tl-pa`, and the blocker error uses `fieldError('#tl-blocknote',…)` instead of the toast (17290). On desktop `#tl-link` keeps no `type` and the blocker path still toasts, unless Q5 approves each change separately. Recent chips (15738-15740) call `s.onchange&&s.onchange()` and get class `rec` (desktop bug fix, Q5) | Most-used phone form |
| F | markers in `viewProjects` 7078-7091, `viewPipeline` 7773-7781, `viewRequests` 5394-5411, `viewLibrary` 7849-7861, `viewCasting` 4473-4492, `eqCatalog` 9091-9105 | Add `data-filterbar` on the container, `data-fb-keep` on search, `data-fb-inline` on short single-choice chip sets | Inert on desktop |
| F | new `mobileFilterBars()` called at the end of `wirePage` 3755 on phones | Move non-kept nodes, handlers intact, into `.fb-sheet`, opened by `Filters · n` (`ic('sliders')`). Turn `[data-menu]` buttons into inline checkbox lists from `MENUS[key](dataset)`. `S.fbOpen[route]` reopens the sheet after each `render()` | Filter blocks of 150px or more collapse into one button |

### Per-screen adaptations (shared utilities; §5 has the per-view use)
| File | New helper | Change | Why |
|---|---|---|---|
| F | `table.m-cards` plus `td[data-m=title\|aside\|meta\|actions\|hide]` | Phone CSS: `thead{display:none}`, `tr{display:grid;grid-template-columns:1fr auto;gap:4px 10px;padding:12px 14px;border-bottom:1px solid var(--border)}`, role placement, `[data-m=hide]{display:none}` | Tables become cards through attributes only |
| F | `table.m-sticky` | Phone: first `th`/`td` `position:sticky;left:0;background:var(--surface);z-index:1` | Readability-only wide tables |
| F | `.kpi` on stat grids | Phone: `grid-template-columns:repeat(2,minmax(0,1fr))`, `.stat` padding 12, `.stat-ico` hidden, value 24px | 4-13 tiles no longer fill 500-1150px |
| F | `mSection(title,html,{open,count})` | Returns `html` unchanged on desktop and a `<details class="card">` on phones | Collapses secondary widgets |
| F | `mTabs()` in `wirePage` | Phone: scroll `.tabs .on` into view. Bars with more than 5 tabs render a `<select class="inp">` built from the same array. Add class `on` to the selected anchor at 14157 and 14674 (no desktop rule styles it) | Tab bars of 390-1400px |
| F | `.list-row` | Phone: `flex-wrap:wrap`, `.lr-main{flex:1 1 calc(100% - 48px)}` | Titles no longer shrink to zero |
| F | `chartLine`/`chartBar` 3322/3339 | Callers pass `{w:340,h:180}` on phones and show every third label when n>6. Compliance and per-person bars become a `bar()` list | Labels at about 5.5px; distortion |
| F | kanban `.kb`/`.kb-col` 698-700, `wireDnD` 21565 | Phone: `scroll-snap-type:x mandatory`, column `flex-basis:calc(100vw - 56px)`, `max-height:none`, `draggable=false`, a status chip row. Tap alternatives: the projStatus menu, the deliverable drawer, and a new phone-only "Move to column" select in `drawerCard` 15682 | HTML5 drag and drop does not work on touch |

### PWA files
| File | Change |
|---|---|
| `public/media-ops/manifest.webmanifest` | See §7 |
| `public/media-ops/sw.js` | See §7 |
| `public/media-ops/icon.svg` | Redraw in blue |
| new `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | Generated by the script below and committed |
| new `scripts/generate-media-ops-icons.mjs` | Uses the installed `@playwright/test` Chromium: `page.setContent('<style>html,body{margin:0}svg{display:block}</style>'+svg)` and a `clip` of exactly N×N (the default 8px body margin would offset and crop). Source art for the PNGs is a full-bleed square (no `rx`); the platform applies its own mask. No new dependency |
| F:6-8 | Head meta, see §7 |

### Server
- **None required.** The standalone sign-in uses the existing `POST /api/auth/login` (server/index.ts:444, body `{email,password}`, 10 attempts per 15 minutes at 375-381).
- Optional: fix the stale iframe comment at server/index.ts:222-228.

### React login
- **None required.** Browser-tab phone users keep `/login`, which shares the tab's cookie jar.
- Optional, low-risk: in `src/pages/LoginForm.tsx`:
  - add `autoComplete` values `username`/`current-password`/`new-password`/`one-time-code`;
  - fix the OTP row width (304px in 236-291px at 320-375). This only affects the forgot-password flow.

### Tests
| File | Change |
|---|---|
| new `src/test/phone-layer-scope.test.ts` | Parse the PHONE LAYER section and fail on any selector that is not `html[data-layout="mobile"]…` (compound `html[data-layout="mobile"].kb-open` allowed; one exception, see §2.5). `@keyframes` names must start `m-` and must not match an existing keyframe |
| new `src/test/mobile-layout.ui.test.ts` (jsdom) | (1) With no `matchMedia`: `data-layout==='desktop'`. (2) With `beforeParse` setting localStorage `mo_layout=mobile`: `'mobile'` before first render. (3) `clearClientAuth` keeps `mo_layout`/`mo_theme` when set, and leaves `Object.keys(localStorage).length===0` when unset. (4) For each group admin/team_lead/coordinator/employee/smc_member and CN self/lead/manage: bar ∪ More ⊇ `NAV.filter(navReachable)` ∪ `cnItems()`, bar ≤ 5, no bar or More route fails `navReachable`. (5) Stub `matchMedia` to mobile, open a modal, flip to desktop via `moLayout.set('desktop')` and via a postponed Auto flip: `!$('#app').inert`, `#mobilebar` not inert, hash unchanged, at most one `history.back()`. (6) `mobileLanding()` for a staff user whose overrides grant only `['kra','ai']` returns a reachable route. (7) Desktop: `#tl-link` has no `type`, blocker still toasts, `#drawer` never `inert` |
| `src/test/server-is-the-only-writer.ui.test.ts:30` | **Changed in P1.** It slices from the first `<script` to the last `</script>`, which after the head script would include the whole `<style>` and body markup. Take the inline script that contains `const ROUTES` (as `scripts/audit-media-ops-bundle.mjs` enumerates blocks) |
| new `e2e/*.pw.ts` plus `playwright.config.ts` (`testDir:'./e2e'`, `testMatch:'**/*.pw.ts'`, `serviceWorkers:'block'`) | See §10 |
| existing 19 UI tests, `audit:media-ops` | Must stay green; unchanged except the one slice fix above. New `data-act` values (`setLayout`, `setTheme`, `openMore`) need two-space-indented ACTIONS entries |

---

## 4. Mobile navigation per role

**Rules.**
- `bar = first N of (keys ++ fallbacks) filtered by navReachable`.
- FAB `log` (calls `openTaskLog`) only if listed **and** `moduleAllowed('reports')`. Otherwise the slot goes to the next fallback.
- More is always last.
- **More sheet** = `NAV.filter(navReachable)` minus bar items, grouped by the NAV `group` label in NAV order, then the Account group.
- Inside the CN: CN groups first (minus bar items), then a "Media Ops" group for staff whose Media Ops set is non-empty.
- **Account group:**
  - Notifications, with unread count (`#/media/notifications`); hidden for creators
  - Profile (opens the profile sheet)
  - Display: Theme and Layout segs (§8)
  - Kiosk mode, if `moduleAllowed('kiosk')&&moduleAllowed('equipment')`, matching F:3596
  - Nerve home (external icon). The profile sheet keeps its "← Nerve home" button too (§5), so both entries behave the same. In P3, verify what `/` does per role group on a phone; if it only bounces back into Media Ops for a group, drop the entry from **both** places for that group and record it as intentionally unreachable
  - Log out
- TV Display Board shows with an external icon and opens `/api/media-tv/`. In **iOS** standalone, `window.open` goes to Safari, whose cookie jar is separate, so the board (data from the authenticated `/api/v1/media/tv/board`) opens signed out; there the row is labelled "Opens in Safari (sign in there)". Android standalone shares cookies and uses `window.open`.
- Keyboard-shortcut help is omitted on phones; it is keyboard-only.
- The jsdom reachability test guarantees that every desktop destination is reachable.

| Group (from `DB.my_module_group`) | Bottom bar: icon · label → route | More sheet (in order) |
|---|---|---|
| **admin** | `home`·Home→`#/media/home` · `folder`·Projects→`#/media/projects` · `clipboard`·Reports→`#/media/reports` (badge `reviewQueueCount`) · `umbrella`·Leave→`#/media/leave` (badge `pendingLeaveCount`) · `apps`·More. Fallbacks: pipeline, my-day, team, dispatch | Main: My Day · SMC: SMC Management · Operations: Request Intake, Dispatch (badge) · Production: Pipeline (badge), Production Board · Casting: Preview, Management (badge) · Assets: Library, Equipment (badge) · Planning: Calendar, Team · Insight: Analytics, KRA, Performance, AI Assist · Creator Network · System: TV Display Board · Admin: Settings, Automations, Audit Logs, Users & Roles · Account |
| **team_lead** | Home · Projects · Reports (badge) · Leave (badge) · More. Fallbacks: my-day, pipeline, team, calendar | My Day, Pipeline, Production Board, Casting Preview, [Casting Management with duty], [SMC with duty and grant], Library, Equipment, Calendar, Team, Analytics, KRA, Performance, AI Assist, Account. Seeded `requests`/`dispatch` stay hidden (NAV `roles`) |
| **coordinator** | `myday`·My Day · `inbox`·Requests→`#/media/requests` · `send`·Dispatch→`#/media/dispatch` (badge `dispatchQueue`) · `folder`·Projects · More. No FAB | Home, Pipeline, Daily Reports, Casting Preview, Library, Equipment, Calendar, Leave, Analytics, KRA, Performance, AI Assist, Account. No Team or Boards (verified: `ROLE_RANK` lacks coordinator; no cap) |
| **employee** | `myday`·My Day · `folder`·Projects · `plus`·Log (FAB) · `camera`·Equipment (badge `overdueEquipment`) · More. Without reports: My Day, Projects, Equipment, Calendar, More | Home, Pipeline, Daily Reports (badge), Casting Preview, Library, Calendar, Leave (badge), KRA, Performance, AI Assist, Account |
| **smc_member** | My Day · Projects · Log (FAB) · `calendar`·Calendar · More (Q8: Calendar or Equipment) | Home, Pipeline, Daily Reports, Library, Equipment, Leave, KRA, Performance, AI Assist, Account. No Casting (not seeded) |
| **creator, self** | `sparkles`·Assistant · `file`·Opps (Q8) · `board`·My Tasks · `zap`·Points→`/creator/points` · More | Creator Network: Leaderboard (`trophy`), War Zone (`swords`), Achievements (`award`) · Insights: My Analytics · Account group plus My Payouts (`wallet`), My Profile (`user`). Bell hidden; no Kiosk |
| **creator, lead** | Assistant · My Tasks · `check`·Review · `users`·Team→`/creator/my-team` · More | Opportunities, Leaderboard, War Zone, Achievements, Team Analytics, My Analytics, My Points, My Profile, Account |
| **creator, manage** (creator_admin, or a Media Ops admin inside the CN) | `grid`·Overview · `check`·Review · `board`·Tasks · `calendar`·Events · More | Creators, Teams, Points, Payouts (`wallet`), Recognition, Analytics, Assistant · then "Media Ops" (admin's full list) · Account |

Constants (module keys only):
```js
const MOBILE_PRIMARY={
  admin:{keys:['home','projects','reports','leave'],fb:['pipeline','my-day','team','dispatch','calendar']},
  team_lead:{keys:['home','projects','reports','leave'],fb:['my-day','pipeline','team','calendar']},
  coordinator:{keys:['my-day','requests','dispatch','projects'],fb:['home','pipeline','calendar','equipment']},
  employee:{fab:'log',keys:['my-day','projects','equipment'],fb:['calendar','reports','home','library']},
  smc_member:{fab:'log',keys:['my-day','projects','calendar'],fb:['equipment','leave','home','library']}};
const CN_MOBILE={self:['assistant','opps','tasks','points'],lead:['assistant','tasks','review','teams'],
  manage:['overview','review','tasks','events']};
```
- A staff member inside the CN gets `CN_MOBILE[cnMode()]`.
- A creator-only account never falls back to the Media Ops list. If `cnMode()` is null (while loading or on error), the bar shows only More.

---

## 5. Screen-by-screen adaptation
"RO" means readability only (admin, custodian and manager screens). Everything else gets the full phone treatment.

| View (function:line) | What changes on the phone |
|---|---|
| Home, staff (`viewDashboard` 5875) | `.kpi` 2×2 on 5909-5947 and 6334-6353. Order: team strip, Needs attention, Pending approvals, Upcoming shoots, Next 14 days (no inner max-height). Everything else goes in closed `mSection`s. Widget tables 6098/6124/6237 become `m-cards`. Chart `w:340`. The velocity switcher (6008 `.hide-sm`) becomes a `.seg` under the title. "Configure widgets" (F:5975, the only entry to the widget modal) moves into a page-head ⋯ menu; its modal opens as a `full` sheet |
| Home, coordinator (`viewCoordDashboard` 5510) | First g4 becomes a 2×2 kpi; the second g4 is collapsed. Order: Ready for dispatch, Recent requests, Upcoming meetings, rest collapsed. `.card-head` wraps. `.dc-btn` 40px |
| My Day (`viewMyDay` 6578) | Already one column. `.list-row` wraps. `.asg-acts`/`.dlv-acts` buttons 40px. Explanatory card-foot text hidden (6621, 6644, 6718). Delivered, My projects and Equipment I hold go in `mSection`. Header "+ Log task" hidden when the FAB is present |
| My Day, coordinator (`viewCoordMyDay` 5720) | CSS `order`: dispatch, meetings, requests, follow-ups, TL assignments, rest collapsed. The three "Log…" buttons move to a ⋯ menu. Selects 44px |
| Projects (`viewProjects` 7063, `projList` 7097) | Full-width search plus a `Filters · n` sheet. **All modes stay** (List, Table, Kanban, Calendar, Gallery, Timeline; F:7067) in a mode `<select>` or scrolling seg with SVG icons and labels; the stored mode is honoured. Table renders with `m-sticky` (RO); Timeline renders inside its existing `.gantt` horizontal scroll container (RO). Row 🗑 (7117) moves to a row ⋯. Thin `bar()` under the meta line. Saved views and Export go in ⋯ |
| Project detail (`viewProject` 7207) | Tabs scroll into view. "Owner" label hidden. "+ Assign work" is primary; the rest go in ⋯. Overview reordered (progress, next deadlines, deliverables, shoots, team `m-cards`, casting, activity). Deliverables (7559, 11 columns) become `m-cards`: title, status aside, owner/due/scheduled meta, 40px actions. Shoots, Equipment and Files become `m-cards`. Activity `.diff .dl{white-space:pre-wrap;word-break:break-all}` |
| Pipeline (`viewPipeline` 7742) | kpi 2×2, filters sheet, kanban treatment with a status chip row, opens on `changes_requested` when non-empty, note hidden |
| Daily Reports (`viewReports` 6830) | History becomes `m-cards` (also add `class="hide-sm"` to the Projects `<th>` at 6861; invisible above 820). `reportCard` 6896: `.day-time` 44px, wrapped chips. Review queue (6944) becomes `m-cards` with 40px Approve/Return. Team grid gets `m-sticky`. Compliance chart becomes a list |
| Production Board (`viewBoards` 14383), TL/admin | Kanban treatment. "Move to column" select in `drawerCard` (phone). `.kb-card .chip{white-space:normal;height:auto}`. Sync note hidden |
| Media Library (`viewLibrary` 7808) | Facets go in the filter sheet. Syntax hints and architecture note hidden. Table becomes `m-cards` with Copy link as the action. Gallery unchanged |
| Calendar (`viewCalendar` 10510, `calendarGrid` 10456) | Default `S.cal.view='agenda'` on phones unless the user chose otherwise. Month view: 6px dots with tap-a-day to list below. Layer chips in one scrolling row. ICS in ⋯. Drag text hidden |
| Equipment (`viewEquipment` 7898) | Default tab `mine`. Header: Scan (primary) and Book, plus "+ Add item" for `equipment.manage` (F:7935; the only UI path to create equipment) in the header or its ⋯ menu. Kbd hints hidden. The header Kiosk button is hidden only because Account › Kiosk mode reaches the same overlay. Tabs: Mine, Catalog, Bookings, Availability, then a More select. kpi tiles. Overdue note shortened to one line with a View link |
| · Catalog `eqCatalog` 9069 / Mine 9384 / Bookings 9324 / Availability 9250 | Catalog rows become cards (make/model, pill, tag, holder, 44px Check out/in). Mine: Check-in button on its own line. Bookings: `m-cards`. Availability: `m-sticky`, 7 days |
| · Dashboard 8392, Transactions, Maintenance, Kits, Import, Physical, Verification, Analytics | **RO**: `m-sticky`, full-width filters, `.hide-m` on Via/Recorded by/Vendor. `eqPvOpen` becomes a full-screen sheet |
| Asset 360 (`viewEquipmentItem` 9912) | Sticky bottom action bar above `#mobilebar` (Check out/in, Book). QR label and Report damage go in ⋯. Tabs: Overview, Custody, Reservations, History, More. Reservations `m-cards`. Maintenance rows wrap |
| Scan (`ACTIONS.eqScan` 18725) | Full-screen sheet, full-width video, no autofocus once the camera starts, light `.scanner` variant. Manual entry on iOS (BarcodeDetector absent; verify) |
| Team (`viewTeam` 10579), `teamDirectory` 13319 | **RO**: tab select; `m-sticky` on Workload, Availability and Skills; compact directory rows; drag hint hidden. **Reordering keeps a tap path:** team rows get `draggable=false` on phones (`wireTeamDnD` F:13708-13721 joins the kanban-treatment list), and `teamMenu` (F:21416-21422) gains phone-only "Move up" / "Move down" that rebuild the id list and call `ACTIONS.teamReorder({ids})` (F:17137) |
| Team member (`viewTeamMember` 13727) | 44px avatar, Profile card first, phone `tel:`/`mailto:` links |
| Leave (`viewLeave` 14016) | Approvals: full-width Approve/Reject, helper text hidden. `leaveMine` 14089 becomes `m-cards`. Calendar tab becomes an agenda list. Leave modal stacks its rows |
| Analytics (`viewAnalytics` 14143) | **RO**: report select, chart `w`, `m-sticky`, metric definitions moved out of the header |
| KRA (`viewKRA` 13919) | My KRAs become cards (title, source, target, weight, achievement bar). Totals in the first tile row. Team roll-up `m-sticky` |
| Performance (`viewPerformance` 13818) | Chart `w`; `m-sticky` on Month and Person columns |
| AI Assist (`viewAI` 14574) | Shared input and header fixes only |
| Notifications (`viewNotifications` 14625) | Kind chip hidden, time under the title, 56px rows, preferences behind a disclosure, kind icons via `gi()` |
| Request Intake (`viewRequests` 5351) | kpi 2-up, chips in the filter sheet, search refocus, 40px `.dc-btn`, drawer safe areas |
| Dispatch (`viewDispatch` 5466) | Queue unchanged. Delivered/Archive table (5491) uses `dispatchRow` card styling. Search refocus |
| Casting Preview (`viewCasting` 4460) | One scrolling chip row plus the filter sheet; compact cards |
| Casting Management (`viewCastingAdmin` 4699) | **RO**: kpi, tab select, `m-sticky` Name, search refocus |
| SMC Management (`viewSmcManagement` 22094) | **RO**: tab select, `smcMgmtRow` wraps, Submissions filter becomes a select, 640 mirrors |
| Admin (`viewAdmin` 14666) and CRUD (`viewCrudEngine` 14852) | **RO**: section select, `.card-head` and `.ca` wrap, `m-sticky`, View/Edit folded into the existing `crudRow` ⋯. The toolbar gets `data-filterbar`; the `.hide-sm` "Created by" and "Created on or after" filters (F:14886, 14888) move into the filter sheet and are un-hidden there (§2.4 audit) |
| CN Assistant (`cnAssistantTab` 13028) | Preset buttons `white-space:normal;height:auto;text-align:left` |
| CN Opportunities (`cnOppsTab` 11574) | Event card header wraps; `.opp-act .btn` 40px |
| CN My Tasks / Tasks (`cnTasksTab` 11451) | Task cards: title, event and due date, pills, reviewer note, full-width primary action |
| CN Review (`cnReviewTab` 11529) | Review cards: Open content (full width), then Approve, Changes, Reject at 40px |
| CN My Points (`cnMyPointsTab` 11669, self) / Leaderboard (12263) | My Points: ledger rows become `m-cards` (event, points, date); totals as a 2-up kpi. Leaderboard hides Team (`.hide-m`) |
| CN My Payouts (`cnPayoutList` 11939, creator) and statement (`cnPayoutStatement` 12004, when `CN_PAYOUT.id`) | List: cards with cycle, large net amount, status, points × rate. Statement: full-width summary, line items as `m-cards`, back link at 44px. Manager ledgers **RO** (`m-sticky`) |
| CN Events (11326) and detail (`cnEventDetail` 11350) | Events become cards. `.ca` wraps. Interest table (11436) wrapped in `.tbl-wrap` (inert on desktop), rows become list rows on phones |
| CN lead My Team (`cnPage` 10961 → `creatorTeamsTab(st,manage)`, lead route `/creator/my-team`, a bar item) | **Full treatment**: member rows as cards (avatar, name, points, task count), actions in a row ⋯, 44px targets |
| CN Team Analytics (`cnAnalyticsTab(false)`, lead) | Charts at `w:340`, tables `m-sticky`, kpi 2-up |
| CN War Zone (`cnWarZoneTab` 12446) and competition detail (`cnCompetitionDetail` 12501), creator/lead | **Full treatment** for creators and leads: competition cards, standings as a ranked list, join/submit actions full-width; manager views RO |
| CN Achievements (`cnAchievementsTab` 12327), creator/lead | **Full treatment**: badge grid `repeat(auto-fill,minmax(96px,1fr))`, locked/unlocked state as text as well as colour; manager view RO |
| CN Overview / landing (11161 / 10931) | kpi 2-up; "Where to go" links move above the tiles as chips |
| CN Creators, Teams, Recognition, War Zone, Achievements, Analytics (manager views only) | **RO**: `m-sticky`; emoji become `gi()` icons; view buttons become a select. Every CN row above gets the 320×568 overflow gate |
| CN My Analytics, My Profile | No change needed |
| TV Display Board (`#/media/tv`) | External; `window.open` when standalone. No adaptation |
| Kiosk overlay (`drawKiosk` 10278) | Scrollable, safe areas, `.kiosk-people` `minmax(140px,1fr)`, 64px buttons (Q10) |
| Profile (`#btn-role` modal 3782-3807) | `full` sheet; Display block at the top (§8); stacked footer; "← Nerve home" (F:3804) kept, consistent with the More sheet entry (§4 rule: verify `/` per group in P3, drop from both places only if it bounces back) |
| Log task / Booking / Leave / New project modals | `full` sheets, stacked `.row`s, sticky footer, fixes from §3 Forms |
| Detail drawers (8 builders: 4306, 4571, 4648, 5210, 15519, 15619, 15638, 15682) | Full-width with safe areas, 44px close, Back closes |

Spec leftovers are **hidden on phones** via `.hide-m`. Removing them everywhere is Q12. They are:
- "Module N" crumbs at 6840/7070/7755/7832/10542/14386
- "wireframe W2/W6/W8"
- `type_meta JSONB` at 7410
- the Postgres note at 7841/7890
- the Offline queue card at 6886-6891
- (Removed: the "🎙 Voice / ✦ AI-2 / D3" entry. Those strings no longer exist in F; 15752/15789 are now required task-log inputs.)

Re-anchor this list by grepping the current file at implementation time. A verification check asserts that no `.hide-m` lands on, or wraps, an `input`, `select`, `textarea` or `button`.

---

## 6. Icons to add
Copy each from `node_modules/lucide-react/dist/esm/icons/<source>.js` (v0.462.0, all files verified present). Element markup only, no `stroke-width`. Add a comment "Portions © Lucide Contributors (ISC); see node_modules/lucide-react/LICENSE".

**Tier A (27 icons, phone chrome and nav de-duplication; ships in P3):**
| Key ← Lucide source | Used for |
|---|---|
| `apps`←layout-grid | More tab |
| `back`←arrow-left | Sheet back |
| `up`←chevron-up | Expand |
| `kebab`←ellipsis-vertical | Row ⋯ on phones |
| `tick`←check | Plain tick |
| `user`←user | Profile, My Profile |
| `logout`←log-out | Log out |
| `sun`←sun | Theme |
| `monitor`←monitor | Desktop option |
| `smartphone`←smartphone | Mobile option |
| `external`←external-link | Nerve home, TV board |
| `sliders`←sliders-horizontal | Filters |
| `trash`←trash-2 | Delete |
| `info`←info | Toast |
| `inbox`←inbox | Request Intake |
| `send`←send | Dispatch |
| `clipboard`←clipboard-list | Daily Reports |
| `clapper`←clapperboard | Casting |
| `gallery`←images | Library |
| `megaphone`←megaphone | SMC |
| `usercog`←user-cog | Users & Roles |
| `tv`←tv | TV board |
| `wallet`←wallet | Payouts |
| `trophy`←trophy | Leaderboard |
| `swords`←swords | War Zone |
| `award`←award | Achievements |
| `scan`←scan-line | Scan button |

**Tier B (20 icons, glyph replacement in shared components via `gi()`; phone-only until Q6):** `copy`←copy, `mail`←mail, `archive`←archive, `undo`←undo-2, `restore`←rotate-ccw, `history`←history, `pending`←circle-dashed, `xcircle`←circle-x, `pause`←pause, `ban`←ban, `wrench`←wrench, `hourglass`←hourglass, `plane`←plane, `dot`←circle-dot, `key`←key-round, `grip`←grip-vertical, `unlock`←lock-open, `call`←phone, `eye`←eye, `sort`←arrow-up-down.

**Tier C (9 icons, view modes and category glyph map):** `list`←list, `table`←table, `timeline`←chart-gantt, `diamond`←diamond, `half`←contrast, `scissors`←scissors, `music`←music, `crown`←crown, `backspace`←delete.

Reused without change: home, myday, folder, camera, calendar, bell, plus, search, x, check, alert, umbrella, chart, target, trend, sparkles, zap, star, board, users, file, grid, kiosk, filter, down, edit, clock, flag, lock, refresh, play, download, dots.

**Size rules (phone layer):**
- `#mobilebar svg` 22px, FAB 24px
- `.menu-item svg` 16px
- `.pal-item .pi svg` 15px
- `.status .si svg` 11px
- `.toast .ti svg` 16px
- `.dc-btn svg` and `.btn-group button svg` 15px

Existing ICONS paths are never edited. The dashboard and sidebar depend on them.

---

## 7. PWA

**Manifest (`manifest.webmanifest`):**
- Add `"id":"/api/media-ops/index.html"`. This equals the id Chrome already derives, so existing installs keep their identity.
- `"start_url":"/api/media-ops/index.html"`: hashless, so boot picks the mobile landing (Q9). Keep the hash if Q9 is declined.
- `"scope":"/api/media-ops/"` unchanged.
- `"orientation":"portrait"` (Q11).
- `"theme_color":"#FFFFFF"`, `"background_color":"#F7F9FC"` (light `--surface`/`--bg`, F:41).
- `"lang":"en"`.
- Icons: `icon-192.png` 192 `any`, `icon-512.png` 512 `any`, `icon-maskable-512.png` 512 `maskable`, `icon.svg` `any` (no combined purpose).
- Optional `shortcuts`: My Day, Equipment, Notifications. The route guard (F:3726) already redirects disallowed routes.

**Icons.**
- Redraw `icon.svg` as the `.brand-mark` art (F:161-163): a 145° gradient `#60A5FA→#1D4ED8`, with the stroked N `M5 20V5.6L19 20V4` (F:1003) scaled up.
- `scripts/generate-media-ops-icons.mjs` does `import {chromium} from '@playwright/test'` (1.58.2, and Chromium 1208 is in `~/Library/Caches/ms-playwright`). It renders four variants with `setViewportSize` and `screenshot({omitBackground:false})`:
  - 192 and 512, opaque square
  - maskable 512: full-bleed gradient; the safe zone is a **circle** of radius 40% (diameter 80%), not a square, so the N glyph's bounding box must fit a centred square of at most ~56% of the width (≤280px in 512). Check with DevTools → Application → Manifest → "Show only the minimum safe area for maskable icons"
  - apple-touch 180: opaque, full-bleed square with no `rx` (the current `icon.svg` has `rx=112`, which would leave white corners under iOS's mask), iOS rounds the corners
  - Every render wraps the SVG in `<style>html,body{margin:0}svg{display:block}</style>` and screenshots a `clip` of exactly N×N
- No new dependency (no sharp, resvg or ImageMagick is available). Commit the PNGs.

**Head meta (F:6-8):**
- Replace nothing; **give the existing tag an id**: `<meta name="theme-color" id="tc-phone" content="#0E1512">` (it stays before the head script). Its content is set by the head script's `apply()` from the **resolved layout and theme**, not from a width query: `mobile` → `#FFFFFF` (light) or `#131A24` (dark); `desktop` → `#0E1512`, today's value, so the desktop tab and any desktop-installed PWA title bar are unchanged. This covers landscape phones (844-932 wide, mobile layout) and forced Desktop (1280 viewport), which a `max-width:820px` media attribute would get wrong. Decided on purpose: the manifest `theme_color` stays `#FFFFFF` (phone installs are the target, so the Android launch status bar matches the light app). A desktop-installed PWA therefore opens with a white title bar that turns `#0E1512` once the meta loads; that is accepted and listed under Q13.
- On iOS 26+, Safari tints its bars from page content rather than `theme-color`, so the fixed `#topbar` and `body` backgrounds must carry the light/dark colour themselves (they already use tokens; verify on device).
- Add `mobile-web-app-capable=yes`, `apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-title="Media Ops"` and `apple-mobile-web-app-status-bar-style="default"`.
- Change the apple-touch-icon to `<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">`. Keep the SVG favicon; it turns blue (Q13).
- `toggleTheme` (3774) and `setTheme` update `#tc-phone` with the same rule (mobile only) and, on phones, write `mo_theme` (Q17). The head script reads `mo_theme` before paint when the layout is mobile, so a saved dark theme boots dark with a dark status bar.

**Service worker (`sw.js`):**
- `CACHE='mo-v3'`. Bump it on every manifest or icon change.
- `SHELL` adds the four PNGs. They must exist, because `addAll` fails atomically and registration errors are swallowed at F:22882.
- Navigate branch caches only `r.ok && r.type==='basic' && (r.headers.get('content-type')||'').startsWith('text/html')`, so 502s, 401s and navigations to the manifest, an icon or `sw.js` never overwrite the cached shell. The offline fallback is `caches.match('/api/media-ops/index.html').then(c=>c||new Response('<!doctype html><title>Offline</title><p>You are offline.</p>',{headers:{'Content-Type':'text/html'}}))`, never `respondWith(undefined)`.
- Manifest and icons: stale-while-revalidate.
- `activate` deletes only keys that start with `mo-` and are not the current cache.
- Optional: a 4s navigation timeout that falls back to the cached shell.
- Update notice: embed a build id in F (`<meta name="mo-build" content="…">`, stamped at build/deploy, or a hash of F computed by a small script in P9). When standalone, immediately after boot and then on `visibilitychange` (at most every 10 minutes), `fetch('index.html',{cache:'no-store'})` and compare its `mo-build` with the running one (ETag alone has no baseline, because a page cannot read its own navigation headers). On a mismatch show a **persistent** banner or More-sheet row "New version available · Reload", not a 6-second toast (F:3283-3290 auto-dismisses action toasts after 6000ms).

**Standalone behaviour (`isStandalone()`):**
- `#/media/tv` and "Nerve home" use `window.open(url,'_blank')`. On **iOS** standalone that opens Safari with a separate cookie jar, so both open signed out; the rows say "Opens in Safari (sign in there)". Android shares cookies.
- On a transport failure (`err.status===0`), boot shows an offline card ("You're offline — Retry", re-running on `online`) instead of seed data (22897-22921). Browser tabs keep today's behaviour. **Order in boot's catch (F:~22910):** `if(_loggingOut) return;` first (a 401 already called `handle401()`, so do not paint `creatorShellFailure` while the redirect loads), then `if(e.status===0 && isStandalone()) return showOfflineCard();`, and only then `hydrateCreatorShell()`.
- Add a "Reload app" row to the More sheet Account group.

**Auth and scope decision (recommended: an in-scope sign-in for standalone only).**
- `handle401`/`doLogout` (21701-21711): when `isStandalone()`, **`await clearClientAuth()`** (handle401 today calls it without `await`, F:21709) and then `location.replace('/api/media-ops/index.html?signin=1'+location.hash)`. The preference write-back inside `clearClientAuth` happens synchronously on the line after `localStorage.clear()`. Note that `clearClientAuth` also clears sessionStorage, deletes every Cache Storage entry and unregisters the worker, so the offline shell is gone until the next online load. Otherwise behaviour is unchanged.
- In `boot()`, when `?signin=1`, skip `/state` and render a `#signin` card with email and password:
  - `fetch('/api/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body})`
  - On success, `creatorOnly = user.creator?.status==='active' && user.team!=='media' && user.team!=='smc'` (mirrors MediaOps.tsx:33 and creator-access.ts:19-21).
  - Then **always** `location.replace('/api/media-ops/index.html'+(creatorOnly?'?as=creator':'')+hash)`. There is **no client-side access gate**: super_admin gets full Media Ops admin regardless of team (server/mediaops-api.ts:77; RoleGuard.tsx:36), and anyone the server refuses already gets an explicit refusal through `/state` → `hydrateCreatorShell` → `creatorShellFailure`.
  - Show the server message for 401, "verify your email" for 403 `EMAIL_NOT_VERIFIED`, and the limiter text for 429.
  - "Forgot password" does `window.open('/login')`.

| Option | Pros | Cons |
|---|---|---|
| **In-scope sign-in** (recommended) | Works with iOS standalone's separate cookie jar, because login happens inside the app web view. No out-of-scope toolbar. Keeps the deep link. No server or React change | A second, minimal login UI to maintain. No in-app OTP or forgot-password flow |
| Scope `"/"` | One line | An Android WebAPK captures every Nerve URL, including public `/casting/register/…` and `/reset-password` email links. The React shell runs chromeless with no back button on iOS. Blocks a future Nerve-wide PWA |
| Leave out-of-scope `/login` | No work | Unverified whether the cookie from the out-of-scope sheet reaches the iOS standalone app (possible login loop). Deep link lost. super_admin stranded at `/super-admin/dashboard` |

Before building, run the device test in §10. If `/login` works cleanly on the **current iOS release (26 or later, where Add to Home Screen opens sites as a web app by default) and one older iOS**, and on Android, the in-scope card can be deferred.

---

## 8. The Desktop/Mobile toggle
- **Placement — decided by the user, not a default.** A small icon button (36px desktop, 44px phone) immediately to the left of the profile button `#btn-role` in `#topbar` (F:1045), on **both** layouts. It shows `ic('monitor')` while the layout is desktop and `ic('smartphone')` while it is mobile, with `aria-label="Display: Desktop"`/`"Display: Mobile"`. Tapping it opens a small `menu()` with **Auto · Desktop · Mobile** (the current one ticked). This is the one deliberate, requested change to the desktop topbar; it takes ~40px from the search field at narrow desktop widths, and the desktop baselines are re-approved once for it (P4).
  - The same Auto/Desktop/Mobile control also appears as the first block of the profile modal/sheet and in the More sheet's Account group, so it is reachable where people look for settings too.
  - Q4 is closed by this.
- **Markup** (uses the existing `.seg`, F:592-594, text only so no new desktop CSS):
```html
<div class="m-display mb4"><div class="small b mb2" id="dsp-h">Display on this device</div>
  <div class="f ac gap3 wrap" role="group" aria-labelledby="dsp-h">
    <div class="seg" role="radiogroup" aria-label="Layout">
      <button data-act="setLayout" data-v="auto" role="radio" aria-checked="${p==='auto'}" class="${p==='auto'?'on':''}">Auto</button>
      <button data-act="setLayout" data-v="desktop" …>Desktop</button>
      <button data-act="setLayout" data-v="mobile" …>Mobile</button></div>
    <div class="seg" role="radiogroup" aria-label="Theme">
      <button data-act="setTheme" data-v="light" …>Light</button><button data-act="setTheme" data-v="dark" …>Dark</button></div></div>
  <div class="hint">Auto uses the phone layout on touch screens up to tablet size. Saved on this device only.</div></div>
<div class="divider"></div>
```
  Here `p = moLayout.pref`. ACTIONS entries, indented by two spaces for the audit regex:
  - `setLayout:(d)=>{closeModal();closeMoreSheet();moLayout.set(d.v);}`
  - `setTheme:(d)=>{if(S.theme!==d.v)toggleTheme();}`
  - The existing wiring at 3807 already binds `[data-act]` inside `#modal-layer`.
- **Persistence.**
  - localStorage `mo_layout`; absent means auto. Each browser profile and device has its own value; nothing goes to the server.
  - Preserved through `clearClientAuth`.
  - `?layout=` is a non-persisting QA override.
- **Behaviour.**
  - **Auto:** on touch devices (no hover, coarse pointer), follows `(max-width:820px)` or a landscape phone, live, through the media-query change event, postponed while any overlay is open. Mouse/trackpad windows always resolve to desktop. The hint text reads "Auto uses the phone layout on touch screens up to tablet size. Saved on this device only."
  - **Desktop on a narrow touch device:** rewrites the viewport to `width=1280` and reloads, giving the real desktop zoomed out with pinch-zoom intact. On laptops and landscape tablets no rewrite and no reload happen.
  - **Mobile on a wide screen:** `setLayout` closes the profile modal and More sheet first (in the old layout), then flips the attribute; `mo:layout` re-renders at full width with no reload.
  - Going back to Auto from a rewritten viewport restores the original viewport content and reloads.
  - **Theme (Q17):** the Theme seg writes `mo_theme` only when the layout is mobile; the head script applies it before paint only in the mobile layout. Desktop keeps today's non-persisted theme unless Q5 approves persistence there.
  - The selected button shows `.on` and `aria-checked`.

---

## 9. Phasing
Each phase is independently shippable. Every phase must keep `npm test`, `npm run audit:media-ops`, the phone-layer scope test and the desktop baselines (0 px diff) green.

| Phase | Contents | Verified after |
|---|---|---|
| **P0 Baseline** | Commit or branch the current WIP (Q16). Add `e2e/` with the Playwright config, fixture server, role fixtures (including coordinator and smc_member), desktop baselines, and overflow and tap-target scanners in **report-only** mode | Baselines stored; overflow and tap reports archived as the "before" state |
| **P1 Layout switch (inert)** | Head script (touch-aware Auto, postponed flips, touch-only viewport rewrite, pre-paint theme/theme-color), `isMobileLayout`, `isStandalone`, `mo:layout-before`/`mo:layout` listeners, `moCanFlip`/`flushPending`, `clearClientAuth` preserve (non-null only), `phone-layer-scope` test, `mobile-layout.ui.test.ts` parts 1-3, the `server-is-the-only-writer` slice fix | Desktop diff 0 (including 800×900 and 200% zoom); first recorded `data-layout` equals the final value (no flash); a mouse resize never flips; jsdom green |
| **P2 Phone chrome** | PHONE LAYER tokens and mirrors, topbar (title, search icon), sidebar and burger hidden, bar safe-area and sizing, left/right insets, `#content` padding, toasts, empty static bar, `ic()` aria. Separate Q5 commit: burger/scrim/Esc fix plus `body.nav-open #sidebar{z-index:61}` | Zero chrome overflow at 320-430; bar clears `--safe-b` (checked in the iOS Simulator); desktop diff 0 except the approved Q5 commit at ≤820 |
| **P3 Navigation model** | Tier A icons, `navReachable` refactor, NAV/CN `mi`/`ml`, `MOBILE_PRIMARY`/`CN_MOBILE`, `renderPhoneBar`, More sheet, badges, active state, re-tap to top, creator bell | jsdom reachability test for all 8 profiles; creator-navigation, creator-shell and tv-access tests unchanged |
| **P4 Toggle** | Display block in the profile modal and More sheet, `setLayout`/`setTheme`, viewport rewrite | Playwright iPhone profile: each option gives the expected attribute and viewport; desktop baseline differs **only** in the profile modal screenshot (approved) |
| **P5 Overlays** | `modal` kinds, drawer, menu sheet, palette, overlay stack with Back, no autofocus, `visualViewport`, `kb-open`, kiosk overflow | `page.goBack()` closes each overlay without changing the route; overflow scan with the profile, task-log and booking modals and a drawer open is 0 |
| **P6 Forms and filters** | 16px/44px rules, `.row` wrap, date inputs, `mInputAttrs`, search refocus, route-only scroll reset, filter sheet on 6 screens, task-log fixes | Sub-44 tap-target count ratchets down; focus survives typing in the 4 search boxes |
| **P7 Daily screens** | Shared utilities first: `m-cards`, `kpi`, `mSection`, `mTabs`, chart width, `.list-row` wrap. Then one commit per screen: Home, My Day, Reports, Projects, Project detail, Calendar, Equipment (Mine, Catalog, Bookings, Availability), Asset 360, Scan, Leave, Notifications, Requests, Dispatch, Casting, Team member, CN self/lead pages | Per-route overflow is 0 at 8 widths for each role that can open it |
| **P8 RO screens** | Everything marked RO in §5, plus the kanban treatment (Pipeline, Boards, project kanban) | Overflow is 0 outside approved scroll containers |
| **P9 PWA** | Icons and generator, manifest, head meta, `sw.js` v3, update notice, offline card, out-of-scope links; device test; standalone sign-in (unless the device test clears it) | chrome://inspect manifest panel shows no errors; install on iOS and Android (§10) |
| **P10 Desktop icon refresh** (only if Q6 = yes) | `ICON_REFRESH=true`; Tier B/C in status maps, empty states, close buttons, menus; category `lookupIcon` (Q7) | Desktop baselines re-approved in one reviewed diff |

---

## 10. Verification
- **Existing checks.** `npm test` (vitest: 19 jsdom UI tests plus server tests), `npm run audit:media-ops`, `npm run lint`.
- **New static test.** Every phone-layer selector is scoped (§2.5).
- **Playwright harness (`e2e/`, Chromium; add WebKit with `npx playwright install webkit`).**
  - **Fixtures.**
    - Serve `public/media-ops` at `/api/media-ops/`.
    - `page.route()` answers `/api/v1/media/**` and `/api/auth/**` with per-group payloads (admin, team_lead, coordinator, employee, smc_member; creator self, lead, manage), reusing the jsdom fixture shapes.
    - Test settings: `serviceWorkers:'block'`, `page.clock.install()` with a fixed date, `animations:'disabled'`, `#toasts` masked.
  - **Matrix.** Every role × every route that role reaches (`NAV.filter(navReachable)` plus `cnItems()`) × every viewport below × preference auto/desktop/mobile (set with `addInitScript` on localStorage). In P0, confirm that the phone profiles (`isMobile`, `hasTouch`) report `(hover:none) and (pointer:coarse)` in Chromium; if they do not, the Auto rows for phones run with `?layout=mobile` and Auto-on-touch is checked in DevTools device mode and on devices only.
    - Phone viewports (`isMobile`, `hasTouch`, DSF 3): 320×568, 360×740, 375×667, 375×812, 390×844, 393×852, 414×896, 430×932.
    - Larger viewports: 768×1024, 821×900, 1024×768, 1280×800, 1440×900.
  - **Overflow.** A document-scroll check alone would always pass, because `body` and `#content` hide overflow (F:132, 248). Instead, fail when either:
    - `#content.scrollWidth > #content.clientWidth+1`, or
    - any visible element has `rect.right>innerWidth+1 || rect.left<-1` and no ancestor with computed `overflow-x:auto|scroll` (`.tbl-wrap`, `.kb`, `.ts-strip`, `.tabs`, `.dr-tabs`, `.gantt`).
    - Repeat the scan with the More sheet, the profile, task-log and booking modals, and a drawer open.
  - **Tap targets:** visible `button, a[href], input, select, textarea, [role=button], [data-act], [data-go], [data-drawer], label.chk` smaller than 44×44, counted per route. Start from the P0 baseline, then ratchet: primary actions must be at least 44, and `::after` hit areas count.
  - **Desktop regression:** at 1440, 1280, 1024 and 821 with no preference, `toHaveScreenshot({maxDiffPixels:0})` for every role × route, plus `getComputedStyle` snapshots of `#sidebar`, `#topbar`, `#btn-role`, `.page`, `#mobilebar`. **Also** at 800×900 (mouse, no preference and pref=desktop: legacy bar, sidebar open over the scrim, nav click works) and 1440 at 200% zoom: `data-layout` must stay `desktop` and the page must match today's ≤820 regime (only the Q5 burger/scrim commit may change it).
  - **Layout attribute:** a MutationObserver installed via `addInitScript` records every `data-layout` value; exactly one value before first paint; on a touch profile `setViewportSize` across 820 flips it only when the preference is auto; on a mouse profile it never flips.
  - **Overlay survival:** open the task-log modal at 1280 (mouse), type, `setViewportSize` to 800: the input survives and the modal stays open. On a touch profile with a modal open, crossing 820 postpones the flip until the modal closes; after close the attribute flips and `#app` is not inert.
  - **Behaviour:** `goBack()` closes the top overlay; tapping the active bar tab scrolls to the top; the Log FAB opens `openTaskLog` only for employee and smc_member.
- **Real devices** (iPhone SE-class and a notched iPhone on the **current iOS release (26 or later)** plus one older iOS; a mid-range Android on current Chrome):
  - Landscape iPhone (Simulator or device): content, sheets, drawer, menus and toasts clear the notch/Dynamic Island (iOS ignores the manifest orientation lock).
  - Safari tab: no focus zoom, keyboard does not cover Save in the task log, bar clears the home indicator, date inputs render, glyphs (✔ ⚠ ⛁ ⚿) render.
  - **Install:** Add to Home Screen and the Android install prompt. Check:
    - the correct blue icon (not a screenshot) and the label "Media Ops"
    - splash `#F7F9FC`, and the status bar white or dark per theme
    - portrait lock (Android) and standalone launch
  - **Signed-out flow:** fresh install launch (new iOS cookie jar) and session expiry (`?signin=1` path, or `/login` if deferred).
  - Offline launch shows the offline card. Run this after re-login and one more online load, not straight after sign-out (sign-out deletes the caches and unregisters the worker).
  - TV board and Nerve home open outside the app; on iOS standalone confirm the "Opens in Safari (sign in there)" label and that the board shows data after signing in there.
  - Kiosk at 320×568 (overlay open, every step): no overflow, a visible gutter, 44px targets.
  - QR scan: Android camera decodes; iPhone falls back to manual entry.
  - Equipment CSV export in iOS standalone.
  - Kanban tap alternatives.
  - chrome://inspect → Application → Manifest shows no warnings. Lighthouse PWA check.
  - Confirm the CN bar icons render at 22px.

---

## 11. Risks and product decisions
Each item is a question with a recommended default.

1. **Auto threshold.** Should Auto mean touch devices ≤820px (which includes iPad portrait 768/810/820) plus landscape phones, and never a mouse-driven window? **Default: yes.** Narrow or zoomed desktop windows keep today's ≤820 regime, so browser zoom, Snap/Split View and docked DevTools never switch a desktop user to the phone UI.
2. **Forced Mobile on a wide screen.** Full width, or a centred ~480px column? **Default: full width.** A column needs left/right math on every fixed overlay.
3. **Forced Desktop on a phone.** Should it be a true 1280px desktop (viewport rewrite plus reload)? **Default: yes.** It is the only way desktop is really unchanged.
4. **Toggle placement.** ~~Profile modal or topbar button?~~ **Decided by the user: a visible button beside the profile button** (§8), mirrored in the profile sheet and More sheet.
5. **Fixes that are visible on desktop.** Ship them now as separate, signed-off commits? **Default: yes, as a separate track.** Anything declined stays phone-gated. The list:
   - palette icon keys (3973)
   - coordinator role labels (3611/3783)
   - search refocus ×4
   - task-log recent-chip `onchange`
   - kiosk Esc at step 0.5
   - toasts above the kiosk
   - SMC undefined tokens (`--surface-1`, `--bad`, `--ok`)
   - Skills matrix name column (13555)
   - hard-coded timeline window (7165)
   - `.tl-dot` on the coordinator Home
   - burger/scrim/Esc fix for the ≤820 desktop regime, including `body.nav-open #sidebar{z-index:61}`
   - `menu()` left-edge clamp `Math.max(10,…)`
   - `role="alert"` on error toasts
   - task-log `type=url` on `#tl-link`, and the blocker error as `fieldError` instead of a toast
   - theme persistence (`mo_theme`) on desktop (Q17)
   Each item is its own commit with its own desktop baseline update; anything declined stays behind `isMobileLayout()`.
6. **Icon refresh on desktop.** Should glyphs become SVG in shared components on desktop too (close buttons, status pills, empty states, menus, toasts)? This conflicts with "desktop visually unchanged". **Default: yes, as P10 after mobile ships.** Until then it is phone-only through `gi()`.
7. **Category, type and team icons stored as glyphs in the database** (CRUD_ICONS at mediaops-api.ts:10975). **Default: keep the glyphs, and append U+FE0E on phones.** A client-side glyph→key map comes with P10; no data migration.
8. **Bar composition.**
   - Admin/TL slot 4: Leave (default) or Pipeline/Team?
   - SMC slot: Calendar (default) or Equipment?
   - FAB only for employee and smc_member? (default: yes)
   - Creator self: Points (default) or Leaderboard?
   - "Opportunities" short label: "Opps" (default) or the full label with ellipsis?
9. **Mobile landing.** With an empty hash on a phone, land on the first bar item, which needs a hashless `start_url`? **Default: yes.** Routes are unchanged; only the landing changes.
10. **Kiosk on phones.** Keep it reachable in More (with the overflow fix) or hide it? **Default: keep**, so every desktop destination stays reachable.
11. **Orientation.** The lock is **Android-only**; iOS/Safari ignores the manifest `orientation`, so landscape iPhones must be handled anyway (left/right safe-area insets, §3). `portrait` locks every Android install. Is the installed app used on the landscape kiosk tablet? **Default: `portrait`**, unless the kiosk tablet uses the installed PWA; in that case keep `any`.
12. **Spec and developer copy** ("Module N", wireframe IDs, Postgres/JSONB notes, the static Offline queue card, voice/AI-2/D3 strings). Remove everywhere or hide on phones? **Default: hide on phones now; removing on desktop is part of Q5.**
13. **Favicon and desktop standalone title bar.** Accept the blue favicon in desktop tabs, and a desktop-installed PWA that opens with the manifest's white title bar before the `#0E1512` meta applies? **Default: yes** (brand fix; desktop tabs keep `#0E1512`).
14. **Standalone auth.** In-scope sign-in, scope `"/"`, or leave `/login` out of scope? **Default: in-scope sign-in**, skipped only if the device test passes on both platforms.
15. **Offline in the installed app.** Show seed/demo data or an offline card? **Default: offline card** in standalone; seed stays for tabs and localhost.
16. **Uncommitted WIP.** F has an uncommitted ~1,900-line diff, and baselines must come from a known state. **Default: commit or branch it before P0.**
17. **Theme persistence.** Persist theme per device (`mo_theme`)? It is not persisted today (S.theme at 2303), and persisting it changes desktop boot behaviour. **Default: yes on phones only** (written only in the mobile layout, applied before paint by the head script together with theme-color, preserved through logout only when set). Desktop persistence is a separate Q5 item.
18. **Filter sheet.** Apply each change immediately (today's semantics) or batch behind an Apply button? **Default: immediate.**
19. **Dirty forms.** Should backdrop tap or Back on a dirty form sheet ask "Discard changes?" **Default: yes, phones only.**
20. **iPhone QR decoding.** Add a CDN decoder (jsQR from cdn.jsdelivr.net) when `BarcodeDetector` is missing? **Default: no for now**; manual entry on iOS.

**Residual technical risks.**
- The viewport-meta rewrite and `pushState` overlay handling must be checked on iOS WebKit, which Playwright does not have until WebKit is installed.
- `env()` cannot be emulated, so safe areas are verified only in the Simulator or on devices.
- The live nginx CSP and gzip settings for `/api/media-ops/*` are unknown (the repo's vhost differs from production). Verify with `curl -sI -H 'Accept-Encoding: gzip, br' https://nerve.paruluniversity.ac.in/api/media-ops/index.html`.
- A second, unmanaged copy of the app is served at `/media-ops/` (Vite copies `public/`). Redirect it to `/api/media-ops/`.
- Session cookies do not roll (server/index.ts:286), so re-login is required at least every 7 days. A server-wide change is out of scope.

---


## Critique dispositions

| Lens | Severity | Issue (short) | Disposition | Reason |
|---|---|---|---|---|
| Desktop protection | blocker | Live Auto flip on resize/zoom tears down open modals (closeModal wipes HTML, F:3299) | Accepted | §2.2: Auto is touch-aware; flips postponed while any overlay is open (`moCanFlip`/`flushPending`); `mo:layout` no longer closes overlays |
| Desktop protection | blocker | Teardown gated on isMobileLayout() after attribute flip leaves #app inert; extra history.back() | Accepted | §2.2/§3: `mo:layout-before` fires before the write; closers undo by recorded state; only the top-entry owner calls back(), never in popstate; jsdom test (5) |
| Desktop protection | blocker | Scrim (z60) covers the open sidebar (z40); bare `matchMedia` | Accepted | §3 chrome: Q5 commit adds `body.nav-open #sidebar{z-index:61}`, uses `window.matchMedia`; 800×900 desktop baseline added |
| Desktop protection | major | Auto keys only on width, so narrow/zoomed desktop windows get the phone UI | Accepted | Touch-aware query; §2.3, §2.6, §8, Q1 and §10 (800×900, 200% zoom baselines) updated |
| Desktop protection | major | Legacy bar ic() SVGs are unsized and change desktop ≤820 | Accepted | Legacy branch stays byte-identical with glyphs; any swap moved to P10/Q6 with a sizing rule |
| Desktop protection | major | Ungated desktop changes (tl-link type, blocker toast, drawer inert, role=alert, menu clamp) | Accepted | Each gated behind isMobileLayout() and listed in Q5; jsdom desktop assertions added |
| Desktop protection | minor | narrow() true on common laptops, causing reloads; tablets forced to 1280 | Accepted | Rewrite only on coarse/no-hover devices with innerWidth ≤820 at load |
| Desktop protection | minor | `html.kb-open` selectors fail the scope test; keyframes undefined | Accepted | Rewritten as `html[data-layout="mobile"].kb-open`; `m-*` keyframe rule added to §2.5 and the test |
| Desktop protection | minor | server-is-the-only-writer slices first to last script (test:30) | Accepted | Verified; P1 changes the slice to the script containing `const ROUTES`; "unchanged" claim corrected |
| Desktop protection | minor | mo_theme on both layouts; write-back may store "null" | Accepted | Q17 now phone-only; write back only non-null values; jsdom test (3) covers set and unset |
| Completeness | major | Project Table/Timeline modes dropped on phones | Accepted | Verified F:7067; all modes kept, Table m-sticky, Timeline in .gantt |
| Completeness | major | Configure widgets hidden with no other entry | Accepted | Verified F:5975; moved into a page-head ⋯ menu |
| Completeness | major | Team reorder is drag-only | Accepted | Verified F:13636/13715; phone Move up/down in teamMenu calling teamReorder |
| Completeness | major | Mirrored .hide-sm removes CRUD filters and data columns | Accepted | Verified F:14886/14888; §2.4 audit gives each site a phone destination, with a check |
| Completeness | major | Equipment "+ Add item" missing from phone header | Accepted | Verified F:7935; kept in header or ⋯ |
| Completeness | major | Missing CN rows (lead My Team, Team Analytics, War Zone, Achievements, My Points, statement); wrong anchors | Accepted | Verified anchors (10961, 11350, 11669, 12004, 12327, 12446, 12501); rows added |
| Completeness | minor | Nerve home in More but hidden in profile | Accepted | Kept in both; P3 verifies `/` per group and drops from both if it bounces back |
| Completeness | minor | Voice/AI-2 leftovers anchor on required task-log inputs | Accepted | grep finds no such strings; entry removed; no-`.hide-m`-on-controls check added |
| Completeness | minor | mobileLanding() can return undefined | Accepted | Falls back to firstAllowedRoute() then '#/media/home'; jsdom test (6) |
| Completeness | minor | Kiosk loses its gutter on non-notched phones | Accepted | Padding uses max(var(--s4), safe inset); kiosk 320 check added |
| PWA/auth | major | In-scope sign-in refuses super_admin | Accepted | Verified mediaops-api.ts:77; client gate removed, always redirect, server decides |
| PWA/auth | major | Maskable safe zone is a circle, not a square | Accepted | Glyph limited to ~56% square; DevTools safe-area check |
| PWA/auth | major | No left/right insets for landscape iPhones; iOS ignores orientation | Accepted | New §3 inset row; Q11 notes Android-only lock; landscape device check |
| PWA/auth | major | Persisted theme not applied before paint or to theme-color | Accepted | Head script applies mo_theme (phone) and theme-color; S.theme reads dataset |
| PWA/auth | major | Device matrix and Q14 gate target iOS 17/18 | Accepted | Current iOS (26+) plus one older; note on Safari 26 content-based tinting |
| PWA/auth | minor | theme-color keyed to width, not layout | Accepted | Single meta whose content the head script sets from resolved layout and theme; desktop keeps #0E1512 |
| PWA/auth | minor | handle401 does not await clearClientAuth | Accepted | Verified F:21709; standalone branch awaits; write-back synchronous after clear(); offline check re-sequenced |
| PWA/auth | minor | Boot catch paints creatorShellFailure during 401 redirect; offline card ordering | Accepted | Catch order: `_loggingOut` return, offline card, then hydrateCreatorShell |
| PWA/auth | minor | ETag update check has no baseline; 6s toast | Accepted | Embedded build id compared on fetch; persistent banner |
| PWA/auth | minor | Navigate branch can cache non-HTML; undefined fallback | Accepted | Verified sw.js:22-25; content-type check and an inline offline Response |
| PWA/auth | minor | iOS standalone window.open uses Safari's cookie jar | Partially accepted | Labelled "Opens in Safari (sign in there)" plus device check; in-app TV route not adopted (TV shell is out of scope) |
| PWA/auth | minor | Icon generator body margin and rounded corners | Accepted | margin:0 wrapper, N×N clip, full-bleed square art |
