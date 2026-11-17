/**
 * Kaspi Seller Hub — line icons (one style everywhere: 24-px grid, 2-px stroke, round caps).
 * Used instead of emoji, which look different on every system and clash with the menu icons.
 * Built as SVG nodes (no innerHTML).
 */
import { s } from './utils.js';

const PATHS = {
  // urgent / deadline
  fire: ['M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.6 1.2 2.6 2.3 2.8C11 9 11.2 6 12 3z'],
  // new orders
  sparkle: ['M12 3l1.8 4.6L18.5 9.4 13.8 11.2 12 16l-1.8-4.8L5.5 9.4l4.7-1.8z', 'M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z'],
  chat: ['M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z'],
  card: ['M3 6h18v12H3z', 'M3 10h18', 'M7 15h3'],
  hourglass: ['M7 3h10', 'M7 21h10', 'M8 3c0 5 8 5 8 9s-8 4-8 9', 'M16 3c0 5-8 5-8 9s8 4 8 9'],
  // waiting for payment
  wallet: ['M4 7h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12', 'M16 13h.01'],
  return: ['M9 14L4 9l5-5', 'M4 9h11a5 5 0 0 1 0 10h-3'],
  cancel: ['M18 6L6 18', 'M6 6l12 12'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
};

/**
 * @param {keyof typeof PATHS} name
 * @param {{ size?: number, label?: string }} [opts] without a label the icon is decorative
 */
export function svgIcon(name, { size = 18, label } = {}) {
  return s(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: `ico ico--${name}`,
      'aria-hidden': label ? null : 'true',
      role: label ? 'img' : null,
      'aria-label': label || null,
    },
    ...(PATHS[name] || []).map((d) => s('path', { d })),
  );
}
