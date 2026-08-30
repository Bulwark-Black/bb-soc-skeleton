# Product design system

The repository's default appearance is the Bulwark Black SOC product design.
It is intentionally not a genericized theme. The product mark, dark console
shell, circuit treatment, blue highlight family, status palette, typography,
spacing density, and component treatments are committed together so a checkout
looks like the product without downstream restyling.

This document is normative for visual-parity work. A deliberate white-label or
product redesign may fork these values, but an integration claiming default
product parity should preserve them exactly.

The shell surface invariant is **38 SOC routes plus one local `/docs` utility**.
The documentation utility is not a separate microsite or theme: it uses the
same mark, palette, type, spacing, focus, responsive, and component vocabulary
as every SOC surface.

## CSS integration boundary

`public/active-ui.css` is the sanitized CSS-only snapshot of every active shell,
Overview, Triage, Rules, Detection Tuning, Threat Intel, and Access style block.
It preserves the exact selectors, color literals, state variants, responsive
rules, and component treatments without carrying application data or logic.
`public/app.css` loads after it and maps those treatments onto the portable
catalog renderer. There is no CSS framework, preprocessor, generated theme, or
runtime theme switch. Load both files in that order after any host-level
normalization they must override, and avoid broad host selectors that restyle
the console's headings, tables, forms, buttons, links, dialogs, or state
attributes. The shell sets dark `color-scheme`, a 320-pixel minimum document
width, border-box sizing, shared typography, and explicit focus rules.

The committed `active-ui.css` snapshot is 65,429 bytes with SHA-256
`2a2babdb4f431a4949aa4f6f8d074100f5f06e9cbda191ea9726296ac5816082`.
The local boundary test pins that value so an accidental color conversion,
selector loss, or partial regeneration is visible during review. The same test
also requires every hexadecimal and `rgb()`/`rgba()` color used by the portable
renderer stylesheet to come from that pinned active palette, preventing
near-color and alpha substitutions.

If the interface is embedded rather than served as its own document, treat the
complete shell as one styling boundary. Do not copy only selected rules or
translate hexadecimal colors into another color notation: that creates drift
in opacity, cascade, responsive behavior, and product screenshots. A host that
must namespace the stylesheet should mechanically scope selectors and verify
the resulting wide/narrow and interaction states against the unchanged source.

### Technical documentation styling boundary

`#/docs` is rendered locally from
[technical-reference.md](../public/technical-reference.md) through the generated
[technical-docs.js](../public/technical-docs.js) artifact. Edit the Markdown
source, run `npm run build:docs`, and run `npm run check:docs` to verify source
and artifact parity. The documentation renderer and its
`.technical-documentation-*` rules belong to the product shell; do not wrap the
manual in a generic documentation theme or introduce a second palette.

The documentation page must preserve semantic heading order, a labelled table
of contents, visible focus for section navigation, a labelled chapter filter,
keyboard-scrollable code and table regions, real table captions and column
headers, and an honest integrity-failure notice. Its content is local and must
never be styled or described as live SOC status. Navigating or filtering it
never calls `readPage`, `getSnapshot`, or `execute`.

## Brand assets

Use the committed raster assets directly. Do not redraw the shield, replace it
with a text abbreviation, apply a tint, place it inside another badge, or use
the icon as a substitute for the full sidebar mark.

| Asset | Purpose | Native size | SHA-256 |
| --- | --- | ---: | --- |
| `public/assets/mark.png` | Full Bulwark Black SOC sidebar mark | 264 × 295 | `c5bfbdf248f6230b9288592283b8b90541f5e96717d023fdc2c1ac7f07d20979` |
| `public/assets/icon-180.png` | Padded Apple touch icon | 180 × 180 | `fd2f1581967c48ab77f2ba73562eaf87e70bf1b330db1f85d15f58c634088e35` |
| `public/assets/icon-32.png` | Padded 32-pixel browser icon | 32 × 32 | `8723ee9f23865e50d2df58d3f76957a77f9667636ed6959c14246c747ca7c3a5` |
| `public/assets/favicon.ico` | Padded multi-size favicon | 16/32/48 resources | `5d3f2311b5d6effd1b350935460da29f9e396854cf19745deb1b2b1cc508da1e` |
| `public/assets/triage-back-arrow.png` | Event-detail return control artwork | 256 × 256 | `64c7101defb28677f3c0cf33927c2034da97bb75a7447f4a376766f5c0a0ddfb` |

The favicon and touch-icon variants are deterministic proportional reductions
of `mark.png` centered on transparent square canvases. Their longest artwork
dimension occupies approximately 82% of the canvas, leaving a clear safe area
on every edge; do not crop or stretch the portrait mark to fill the square.

The desktop sidebar renders `mark.png` at 132 pixels wide and approximately
148 pixels high, preserving its native aspect ratio. Give the image the
accessible name “Bulwark Black SOC”; do not repeat the same name in adjacent
visible text.

The checksums make accidental re-encoding, optimization, or substitution
detectable. Update a checksum and obtain product approval together if an asset
is intentionally replaced.

The repository's software license should not be treated as a grant of trademark
rights. A third party must have permission to deploy Bulwark Black product
identity.

## Color contract

Keep opaque color values in the same six-digit hexadecimal format used by the
product. Preserve the source format for alpha values as well: composited glows
and washes use `rgba()` (for example `rgba(62,166,255,.12)`), while the four
badge fills retain the product's eight-digit hex values `#53a05126`,
`#f8be3426`, `#dc4e4126`, and `#8c929626`.

| Role | CSS token | Exact value | Use |
| --- | --- | --- | --- |
| Application background | `--canvas` | `#171d21` | Base document background |
| Sidebar base | `--sidebar` | `#04070a` | Black/navy product-navigation field |
| Surface | `--surface` | `#0d141b` | Standard inset/component surface |
| Deep surface | `--surface-deep` | `#080d11` | Deep panel and content edge |
| Control surface | `--surface-control` | `#0b1117` | Inputs and compact controls |
| Primary text | `--text` | `#e5e8ea` | Headings and high-emphasis copy |
| Secondary text | `--text-secondary` | `#c3cbd1` | Supporting values and labels |
| Muted text | `--muted` | `#8c9296` | Metadata and nonessential explanations |
| Faint text | `--faint` | `#5c6470` | Lowest-emphasis decorative metadata |
| Accent | `--accent` | `#3ea6ff` | Active navigation, focus, links, charts, and product energy |
| Accent highlight | `--accent-hi` | `#8fd6ff` | Bright pulse and hover highlights |
| Accent dark | `--accent-dark` | `#1c6fb8` | Accent borders and low-emphasis blue surfaces |
| Positive | `--ok` | `#53a051` | Healthy, available, complete, and verified states |
| Warning | `--warn` | `#f8be34` | Review, pending, quiet, and overdue attention states |
| Critical | `--bad` | `#dc4e41` | High priority, failure, and destructive-risk states |
| Product line | `--line` | `#21425b` | Blue-toned structural borders |
| Content soft line | `--line-soft` | `#1d3242` | Shared content-surface separators |
| Neutral line | `--line-generic` | `#33373b` | General component borders |
| Soft neutral line | `--line-neutral-soft` | `#2b3033` | Older/global neutral dividers and inset structure |

The primary panel surface is a vertical gradient from `#111a23` to `#080d11`.
The main content field layers the source-format `rgba(62,166,255,.12)` radial glow
over a dark linear progression through `#10171e`, `#0b1015`, and `#080c10`.
The sidebar remains black/navy so its circuit traces and the full-color mark
retain their intended separation.

Do not introduce a parallel set of near-black or near-blue values for new
components. Reuse the semantic roles above, including state colors. State must
also be communicated with text or iconography; color alone is insufficient.

### Analytics and inline component colors

The active analytics renderer defines its visualization palette in JavaScript,
not in a style block. The portable renderer therefore keeps these exact literals
in `public/app.js` and applies them only to safe, generated SVG/metric marks:

- categorical, never cycled: `#4e79a7`, `#f28e2b`, `#e15759`, `#76b7b2`,
  `#59a14f`, `#edc948`, `#b07aa1`, `#ff9da7`;
- ranked/sequential: `#3987e5`;
- categorical-palette exhausted: `#6b7075`;
- severity: critical `#dc4e41`, high `#f8be34`, info `#8c9296`.

Cycling the categorical palette would falsely imply that two series are the
same, so a ninth non-severity series uses the active grey fallback and renders a
visible palette-exhausted warning. Every populated chart also exposes the values
as a literal table.

Several active controls use inline-only shades and therefore are not present in
the pinned style-block snapshot. The portable equivalents retain them in their
DOM attributes: Logs search uses `#0d1216` with `#3ea6ff55`; its UTC window
inputs use `#3ea6ff66`; alert-reconciliation controls use `#454a4e` and
`#c7cbce`; Threat Intel search text uses `#e6edf3`. The command-only source
revoke shade is intentionally absent because that mutation is outside the
public read contract.

## Typography

The application font stack is:

```css
13px/1.45 "Helvetica Neue", -apple-system, Arial, sans-serif
```

Use the existing heading weights and compact console density rather than
substituting a display font. Identifiers, short machine values, and route-like
text use Menlo with a platform monospace fallback. Preserve normal text casing
for content; small labels may use the established uppercase and tracked style.

## Shell geometry

- The desktop sidebar is 192 pixels wide and remains visually anchored to the
  left edge.
- The mark is centered within the sidebar at its documented rendered size.
- The main content uses the dark layered background, while cards use the panel
  gradient and restrained borders.
- The top bar presents product/session context and the route filter without
  competing with page headings.
- On compact layouts, the fixed sidebar yields to the grouped route selector.
  Onboarding and Settings remain available through their shell controls, and
  the nine linked detail routes remain directly addressable with the
  same responsive shell. The Docs control must continue to reach the local
  `#/docs` utility. None of the 38 SOC routes or the local utility may become
  desktop-only.

Integrators may place the console in a larger host shell, but should choose one
owner for global navigation, focus restoration, and top-level spacing. Nesting
the full shell inside another fixed sidebar normally creates duplicate
landmarks and should be avoided.

## Responsive behavior

The committed stylesheet keeps four explicit viewport thresholds. At 1,180
pixels and 1,000 pixels, wide multi-column arrangements progressively collapse.
At 760 pixels, the fixed sidebar becomes the compact shell/navigation treatment
and content spacing tightens. At 480 pixels, the read-only pill and user copy
yield to the smallest shell while the page-heading action becomes full width.
Do not replace these breakpoints with a different framework scale when exact
product parity is required; verify both sides of `1180px`, `1000px`, `760px`,
and `480px`, plus the 320-pixel minimum document width. On `#/docs`, verify the
contents rail, long headings, code samples, and wide reference tables at those
same thresholds rather than allowing horizontal page overflow.

## Circuit treatment and motion

The sidebar contains circuit-path artwork plus a small number of blue comet
pulses. The paths are decorative and excluded from the accessibility tree. The
active treatment creates three to five pulse groups on each mount so the board
reads as ambient current rather than a metronome.
The sidebar gradient is exactly `#04070a` at 0%, `#060b10` at 55%, and
`#04080c` at 100%. Its 96-pixel circuit tile uses `#103246` strokes and
`#134058` nodes at 0.5 layer opacity.

Each pulse group uses `--accent-hi`, `--accent`, and `--accent-dark` with the
checked-in 2/1.6/1.2-pixel head/middle/tail strokes. It selects one of the two
active trace grammars, a 150–290 second duration, and a negative phase within
that duration. Keep the population and timing inside those exact active bounds.

Motion is ambient, slow, and nonessential. Under `prefers-reduced-motion:
reduce`, suppress the pulse animation and nonessential transitions without
removing information or focus indication.

Keyboard focus uses a two-pixel `--accent-hi` outline, a two-pixel offset, and
the source-format `rgba(62,166,255,.22)` outer ring. Hover, active, selected,
disabled, error, empty, and loading treatments across `public/active-ui.css` and
`public/app.css` are part of the product state vocabulary; preserve their state
selectors as well as their default appearance.

## Component rules

### Navigation

Use blue only for the active/current emphasis and focus treatment. Group labels
remain quieter than route names. Filtering must preserve route order, expose a
live result count, and explicitly report no matches.

### Page headings

Use the active `.dash-title` treatment: one route title, its blue status dot,
and optional compact metadata. A route title is not a card title. Use the
`bulwark>soc · Page` document-title pattern.

### Panels and cards

Use the product panel gradient, one-pixel structural border, modest radius, and
compact padding. Avoid large floating shadows, glassmorphism, white surfaces,
or unrelated dashboard-card treatments.

### Metrics and readiness

Metric values carry the highest visual emphasis. Labels and explanatory notes
remain secondary. Meters, rings, and charts must have adjacent textual values
or a table equivalent.

The Overview keeps its product-specific posture lede, collection ring and
legend, readiness meters, and fact tiles. These patterns use the same global
tokens and compact card geometry; they are not a separate theme.

### Tables

Tables are dense, left aligned, and separated with subtle rules. Supply a real
caption, column scopes, safe text-only cell rendering, and a keyboard-reachable
horizontal scroll region when needed. Represent machine-readable dates with
`<time datetime="…">`.

### Pills and states

Pills label state; they are not decoration. Use the positive, warning, critical,
or neutral treatment according to meaning. Expandable pills must retain a
visible disclosure marker and keyboard-operable summary.

### Forms and commands

Labels remain visible above or beside their control. Do not rely on placeholder
text as a label. Empty-skeleton controls are clearly unavailable. When an
adopter enables a command, add progress, success, validation, conflict, denial,
and failure states without changing the base visual vocabulary.

### Tabs

Selected tabs use the accent treatment and a clear relationship to their panel.
Visual selection must agree with `aria-selected`, focus position, URL state, and
the visible tabpanel.

### Toasts and notices

Persistent notices explain empty, gated, or unavailable behavior. Transient notices
are dismissible and announced without stealing focus. If a downstream host adds
automatic dismissal, its timeout must pause while the notice is hovered or
focused.

### Technical documentation

Use existing panel, muted-text, accent-link, badge, table, code, and notice
treatments for the manual. Section targeting and the current contents link must
have visible and semantic state. Chapter filtering may hide nonmatching
sections, but it must report the visible result count and must not change the
canonical source. The page is shell-owned local content and never reflects
page-adapter or connector-control state.

## Page-local product patterns

Detection Tuning intentionally carries a scoped secondary workspace palette;
it does not redefine the shell. Preserve all of its local tokens exactly:

| Token | Exact value | Role |
| --- | --- | --- |
| `--tune-bg` | `#081018` | Workspace background |
| `--tune-panel` | `#0d1720` | Primary tuning panel |
| `--tune-panel-2` | `#0a131b` | Secondary tuning panel |
| `--tune-panel-3` | `#111d27` | Raised tuning panel |
| `--tune-border` | `#23465d` | Primary tuning border |
| `--tune-border-soft` | `#17384d` | Soft tuning border |
| `--tune-text` | `#eef3f7` | Tuning primary text |
| `--tune-muted` | `#9aa8b4` | Tuning secondary text |
| `--tune-muted-2` | `#73818d` | Tuning tertiary text |
| `--tune-blue` | `#2da7ff` | Tuning accent |
| `--tune-blue-deep` | `#0f3048` | Deep blue action surface |
| `--tune-blue-soft` | `#103652` | Soft blue action surface |
| `--tune-green` | `#58c870` | Positive tuning state |
| `--tune-green-bg` | `#102918` | Positive-state surface |
| `--tune-warning` | `#e4b15e` | Warning tuning state |
| `--tune-danger` | `#ff6d6d` | Dangerous/error tuning state |

The checked-in tuning summary, actions, KPI row, and workspace establish that
scoped treatment.

Triage uses the product's compact board treatment: a state/filter rail, a
1,020-pixel minimum fixed-layout table, five-by-six-pixel cells, ellipsized
columns, and compact pills inside a keyboard-scrollable region. Threat
Intelligence uses fixed table geometry while allowing the indicator column to
break long values. Rendered governance documents retain the product heading,
mark, code, preformatted, and blockquote vocabulary.

## Visual parity review

Before calling a downstream implementation product-matched, verify:

- [ ] All five asset hashes match the committed files.
- [ ] The full sidebar mark is used at the documented size and aspect ratio.
- [ ] Base, text, accent, state, line, panel, and content-background values
      match exactly.
- [ ] Desktop sidebar width, compact navigation, density, and typography match.
- [ ] Overview, tables, tabs, forms, document views, empty states, and error
      states use the same component vocabulary.
- [ ] `#/docs` uses the exact product palette and shell treatments at wide and
      narrow sizes; its contents, filter, headings, code, tables, links, focus,
      and integrity-failure state remain accessible.
- [ ] Hover, focus-visible, active, disabled, and reduced-motion states are
      present.
- [ ] Wide and narrow screenshots contain no substituted color or generic logo.
- [ ] Automated contrast results are supplemented with keyboard, zoom, and
      screen-reader review.
