/**
 * Kaspi Seller Hub — how waybill pages are laid out on the seller's paper.
 *
 * Sellers print on different printers, so the mode is chosen once per computer in
 * «Настройки → Печать накладных» (stored in this browser only):
 *   original — each waybill on its own page size (whatever Kaspi's PDF is: A4 or a label);
 *   label    — thermal label printer: every waybill fitted on a label of the chosen size,
 *              turned 90° when its orientation differs from the label;
 *   a4       — office printer, one waybill per A4 sheet;
 *   a4x4     — office printer, four waybills per A4 sheet (2×2, cut along the dashed lines),
 *              saves paper when Kaspi gives label-size waybills.
 * Waybills are never redrawn: Kaspi's own PDF page is scaled as a whole ("contain"),
 * so the number and the barcode stay exactly Kaspi's.
 */

export const PAPER_MODES = ['original', 'label', 'a4', 'a4x4'];
export const A4 = Object.freeze({ w: 210, h: 297 });
/**
 * Modes where the empty paper around the waybill is cut off before fitting: Kaspi's
 * waybill is a ~100×150 mm label in the corner of an A4 page (checked on a real one,
 * 2026-11-18), so fitting the whole A4 page into a label would shrink it by half.
 */
export const TRIM_MODES = new Set(['label', 'a4x4']);
/** Common thermal label sizes in Kazakhstan, mm (width × height). */
export const LABEL_PRESETS = [
  [100, 150],
  [100, 100],
  [75, 120],
  [58, 100],
];
export const LABEL_LIMITS = Object.freeze({ min: 40, maxW: 210, maxH: 300 });
const A4_MARGIN = 8; // most office printers cannot print the outer 4–6 mm

/** Clean print settings (also used for settings restored from a backup). */
export function normalizePrint(p = {}) {
  const clamp = (v, max, def) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= LABEL_LIMITS.min && n <= max ? n : def;
  };
  return {
    paper: PAPER_MODES.includes(p.paper) ? p.paper : 'original',
    labelW: clamp(p.labelW, LABEL_LIMITS.maxW, 100),
    labelH: clamp(p.labelH, LABEL_LIMITS.maxH, 150),
  };
}

const orientationDiffers = (a, b) => a.w !== a.h && b.w !== b.h && a.w > a.h !== b.w > b.h;

/**
 * Where one waybill page goes.
 * @param {{w:number,h:number}} pageMm size of the waybill page in Kaspi's PDF
 * @param {ReturnType<typeof normalizePrint>} print
 * @returns {{ sheet:{w:number,h:number}, padding:number, cols:number, rows:number, cell:{w:number,h:number}, rotate:0|90 }}
 */
export function layoutFor(pageMm, print) {
  const p = normalizePrint(print);
  if (p.paper === 'original') return { sheet: { ...pageMm }, padding: 0, cols: 1, rows: 1, cell: { ...pageMm }, rotate: 0 };
  if (p.paper === 'label') {
    const label = { w: p.labelW, h: p.labelH };
    return { sheet: label, padding: 0, cols: 1, rows: 1, cell: label, rotate: orientationDiffers(pageMm, label) ? 90 : 0 };
  }
  const cols = p.paper === 'a4x4' ? 2 : 1;
  const rows = cols;
  const cell = { w: (A4.w - 2 * A4_MARGIN) / cols, h: (A4.h - 2 * A4_MARGIN) / rows };
  return { sheet: { ...A4 }, padding: A4_MARGIN, cols, rows, cell, rotate: orientationDiffers(pageMm, cell) ? 90 : 0 };
}

/** Size of the paper for the test print (the label, or A4). */
export function testSheet(print) {
  const p = normalizePrint(print);
  return p.paper === 'label' ? { w: p.labelW, h: p.labelH } : { ...A4 };
}
