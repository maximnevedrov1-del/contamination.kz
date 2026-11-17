# Seller Hub — design

One look for the extension and its website: the site shows the product, so it is built from
the same tokens (`shared/tokens.css`).

## Direction
A calm, precise working tool. Monochrome UI (near-black accent on white or zinc), colour only
where it carries meaning:
- store colours mark the stores (blue `#2a78d6`, orange `#e8643c`, green `#1f9d6b`, purple `#7c5cd6`, amber `#d99a1b`);
- status colours: red = urgent / overdue, amber = soon, green = done or paid.

No decorative gradients beyond a faint glow behind product shots. The product screenshots are
the hero imagery.

## Colour (light / dark)
| role | light | dark |
|---|---|---|
| page | `#fafafa` | `#0a0a0b` |
| surface | `#ffffff` | `#111113` |
| surface-2 | `#f4f4f5` | `#18181b` |
| border | `#e4e4e7` | `#27272a` |
| text | `#0a0a0a` | `#fafafa` |
| text-2 | `#52525b` | `#a1a1aa` |
| accent (buttons) | `#0a0a0a` on white text | `#fafafa` on black text |
| focus ring | `#2a78d6` | `#5b9ae8` |
| urgent | `#c0262d` / bg `#fdecec` | `#f07178` / bg `#301417` |

## Type
`Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. No web font download on
the site: the system font keeps the first screen fast on phones.

Scale:
- display: 56/60 px, weight 700, −0.03em (40 px on phones);
- h2: 36 px, 700, −0.02em;
- h3: 20 px, 600;
- body: 17 px / 1.6;
- small: 14 px.

Numbers use `font-variant-numeric: tabular-nums`.

## Space, radius, shadow
- Spacing: 4-px grid. Sections have 96 px vertical padding (64 px on phones); content is at most 1160 px wide.
- Radius: 6 px for inputs, 10 px for buttons, 14 px for cards, 18 px for product frames.
- Shadows: `0 1px 2px` on cards; the large one, `0 24px 60px rgba(0,0,0,.14)`, only on product shots.

## Components
- **Buttons.** Primary is filled near-black. Secondary has a 1-px border. Both are 44 px tall on the
  site, 36 px in the extension.
- **Browser frame** around screenshots: a 36-px bar with three dots, radius 18 px. On a mouse
  device it tilts by at most 6° towards the cursor.
- **Store chip:** a coloured dot plus the store name.
- **Cards:** surface, 1-px border, radius 14 px.

## Motion
Things appear once, on scroll: fade plus a 16-px rise over 0.5 s. The product frame tilts with
the mouse. Nothing loops. Everything is off under `prefers-reduced-motion`.
