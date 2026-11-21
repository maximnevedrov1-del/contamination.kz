/**
 * Kaspi Seller Hub — lightweight SVG charts (no dependencies).
 *
 * Design rules: one y-axis per chart (two measures → two charts), 2px lines,
 * recessive grid, rounded bar ends anchored at the baseline, hover tooltip on
 * every chart, colours by entity (each store keeps its colour). All labels are
 * produced by formatter callbacks so they follow the current language.
 */
import { s, h, clear } from '../shared/utils.js';

/** Round "nice" tick values for an axis 0..max. */
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) || raw;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function tooltip(container) {
  let tip = container.querySelector('.chart-tip');
  if (!tip) {
    tip = h('div', { class: 'chart-tip', role: 'status', hidden: true });
    container.append(tip);
  }
  return {
    show(x, y, lines) {
      clear(tip);
      lines.forEach(([label, value, color]) =>
        tip.append(h('div', { class: 'chart-tip__row' }, color && h('span', { class: 'dot', style: { background: color } }), h('span', { class: 'chart-tip__label' }, label), h('b', null, value))),
      );
      tip.hidden = false;
      const cw = container.clientWidth;
      const left = Math.min(Math.max(8, x + 12), cw - tip.offsetWidth - 8);
      tip.style.transform = `translate(${left}px, ${Math.max(0, y - tip.offsetHeight - 8)}px)`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

/**
 * Line chart for a daily series.
 * @param {HTMLElement} container
 * @param {{
 *   points: {x:string, y:number|null}[],
 *   color?: string,
 *   label: string,
 *   yFormat: (v:number)=>string,
 *   yFormatAxis?: (v:number)=>string,
 *   xFormat: (x:string)=>string,
 *   height?: number
 * }} opts
 */
export function lineChart(container, opts) {
  let first = true; // draw-in animation only once, not on every resize
  const draw = () => {
    const { points, color = 'var(--series-1)', yFormat, xFormat, label } = opts;
    const yAxisFmt = opts.yFormatAxis || yFormat;
    const W = Math.max(280, container.clientWidth);
    const H = opts.height || 220;
    const pad = { t: 12, r: 12, b: 26, l: 64 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const max = Math.max(0, ...points.map((p) => p.y ?? 0));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const x = (i) => pad.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
    const y = (v) => pad.t + ih - (v / top) * ih;

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label, class: 'chart-svg' });
    ticks.forEach((tv) => {
      svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y(tv), y2: y(tv), class: 'chart-grid' }));
      svg.append(s('text', { x: pad.l - 8, y: y(tv) + 4, 'text-anchor': 'end', class: 'chart-axis-label' }, yAxisFmt(tv)));
    });
    const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 72))));
    points.forEach((p, i) => {
      const last = i === points.length - 1;
      // the last date is always shown; a regular label too close to it is skipped (they overlapped)
      if ((i % every === 0 && points.length - 1 - i >= every) || last)
        svg.append(s('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle', class: 'chart-axis-label' }, xFormat(p.x)));
    });

    // Line split into segments at missing values.
    let d = '';
    points.forEach((p, i) => {
      if (p.y == null) return;
      d += `${d && points[i - 1]?.y != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`;
    });
    if (d) {
      const area = points.every((p) => p.y != null) ? `${d}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z` : '';
      if (area) svg.append(s('path', { d: area, fill: color, opacity: 0.08, class: first ? 'chart-area-in' : null }));
      svg.append(s('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', pathLength: 1, class: first ? 'chart-line-in' : null }));
    }

    const cross = s('line', { y1: pad.t, y2: pad.t + ih, class: 'chart-crosshair', visibility: 'hidden' });
    const marker = s('circle', { r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
    svg.append(cross, marker);
    const hit = s('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent', class: opts.onPick ? 'chart-hit--pick' : null });
    svg.append(hit);

    clear(container).append(svg);
    first = false;
    const tip = tooltip(container);
    const pointAt = (ev) => {
      const rect = svg.getBoundingClientRect();
      const mx = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.round(((mx - pad.l) / iw) * (points.length - 1));
      return points[Math.min(points.length - 1, Math.max(0, i))];
    };
    // click on a day → its orders (the dashboard decides what that means)
    if (opts.onPick) hit.addEventListener('click', (ev) => {
      const p = pointAt(ev);
      if (p) opts.onPick(p);
    });
    const onMove = (ev) => {
      const rect = svg.getBoundingClientRect();
      const mx = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.round(((mx - pad.l) / iw) * (points.length - 1));
      const p = points[Math.min(points.length - 1, Math.max(0, i))];
      if (!p) return;
      const idx = points.indexOf(p);
      cross.setAttribute('x1', x(idx));
      cross.setAttribute('x2', x(idx));
      cross.setAttribute('visibility', 'visible');
      if (p.y != null) {
        marker.setAttribute('cx', x(idx));
        marker.setAttribute('cy', y(p.y));
        marker.setAttribute('visibility', 'visible');
      } else marker.setAttribute('visibility', 'hidden');
      tip.show((x(idx) / W) * rect.width, (y(p.y ?? 0) / H) * rect.height, [[xFormat(p.x), p.y == null ? '—' : yFormat(p.y), color], ...(opts.pickHint ? [[opts.pickHint, '', null]] : [])]);
    };
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      marker.setAttribute('visibility', 'hidden');
      tip.hide();
    });
  };
  return observe(container, draw);
}

/**
 * Horizontal bar chart — one bar per store, coloured by the store's colour,
 * direct-labelled with the value.
 * @param {HTMLElement} container
 * @param {{ bars: {label:string, value:number|null, color:string}[], format:(v:number)=>string, label:string }} opts
 */
export function barChart(container, opts) {
  let first = true;
  const draw = () => {
    const { bars, format, label } = opts;
    const W = Math.max(280, container.clientWidth);
    const row = 34;
    const pad = { t: 4, r: 116, b: 4, l: 132 };
    const H = pad.t + pad.b + bars.length * row;
    const iw = W - pad.l - pad.r;
    const max = Math.max(0, ...bars.map((b) => b.value ?? 0)) || 1;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label, class: 'chart-svg' });
    clear(container).append(svg);
    const tip = tooltip(container);

    bars.forEach((b, i) => {
      const cy = pad.t + i * row + row / 2;
      const bw = b.value ? Math.max(4, (b.value / max) * iw) : 0;
      const name = b.label.length > 18 ? `${b.label.slice(0, 17)}…` : b.label;
      svg.append(s('text', { x: pad.l - 10, y: cy + 4, 'text-anchor': 'end', class: 'chart-cat-label' }, name));
      svg.append(s('line', { x1: pad.l, x2: pad.l, y1: cy - 12, y2: cy + 12, class: 'chart-baseline' }));
      if (bw) {
        // Square at the baseline, rounded (4px) at the data end.
        const r = Math.min(4, bw);
        const y0 = cy - 8;
        svg.append(
          s('path', {
            d: `M${pad.l},${y0}H${pad.l + bw - r}Q${pad.l + bw},${y0} ${pad.l + bw},${y0 + r}V${y0 + 16 - r}Q${pad.l + bw},${y0 + 16} ${pad.l + bw - r},${y0 + 16}H${pad.l}Z`,
            fill: b.color,
            class: first ? 'chart-bar-in' : null,
            style: first ? `animation-delay:${i * 60}ms` : null,
          }),
        );
      }
      svg.append(s('text', { x: pad.l + bw + 8, y: cy + 4, class: 'chart-value-label' }, b.value == null ? '—' : format(b.value)));
      const hit = s('rect', { x: 0, y: cy - row / 2, width: W, height: row, fill: 'transparent', class: opts.onPick ? 'chart-hit--pick' : null });
      if (opts.onPick) hit.addEventListener('click', () => opts.onPick(b));
      hit.addEventListener('pointermove', (ev) => {
        const rect = svg.getBoundingClientRect();
        tip.show(ev.clientX - rect.left, ((cy - 10) / H) * rect.height, [[b.label, b.value == null ? '—' : format(b.value), b.color], ...(opts.pickHint ? [[opts.pickHint, '', null]] : [])]);
      });
      hit.addEventListener('pointerleave', () => tip.hide());
      svg.append(hit);
    });
    first = false;
  };
  return observe(container, draw);
}

/** Redraw on container resize. Returns a disposer. */
function observe(container, draw) {
  draw();
  let w = container.clientWidth;
  const ro = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - w) > 4) {
      w = container.clientWidth;
      draw();
    }
  });
  ro.observe(container);
  return () => ro.disconnect();
}
