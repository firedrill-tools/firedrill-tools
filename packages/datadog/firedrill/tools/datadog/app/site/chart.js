// SVG timeseries graph in the style of Datadog widgets: light grid, left value axis, time axis, classic palette,
// optional threshold bands and a hover crosshair tooltip. Pure DOM, no library.
import { el, fmtDate, fmtNumber } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";
export const PALETTE = ["#6F8CD8", "#9D7CD6", "#57B6C9", "#E68A45", "#D65C88", "#6CB26A", "#C6A73E", "#8F8F9E"];
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

function niceTicks(min, max, count = 4) {
  if (!(max > min)) { max = min + 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2 && ticks.length < 12; v += step) ticks.push(Number(v.toFixed(6)));
  return { lo, hi, ticks };
}

/**
 * series: [{ name, points: [[ms, value|null]] }]; options: { from, to (sec), height, thresholds: [{ value, color, label }], kind: "line"|"bars" }
 */
export function timeseriesChart(series, { from, to, height = 180, thresholds = [], kind = "line" } = {}) {
  const width = 800;
  const pad = { l: 44, r: 12, t: 10, b: 22 };
  const values = series.flatMap((s) => s.points.map((p) => p[1]).filter((v) => v !== null && Number.isFinite(v)));
  for (const t of thresholds) if (Number.isFinite(t.value)) values.push(t.value);
  const min = Math.min(0, ...(values.length ? values : [0]));
  const max = Math.max(...(values.length ? values : [1]));
  const { lo, hi, ticks } = niceTicks(min, max === min ? min + 1 : max);
  const x = (ms) => pad.l + ((ms / 1000 - from) / Math.max(1, to - from)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (height - pad.t - pad.b);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "dd-chart__svg", role: "img" });
  svg.setAttribute("aria-label", `Graph of ${series.length} series`);
  for (const tick of ticks) {
    svg.append(svgEl("line", { x1: pad.l, x2: width - pad.r, y1: y(tick), y2: y(tick), class: "dd-chart__grid" }));
    const label = svgEl("text", { x: pad.l - 6, y: y(tick) + 3, class: "dd-chart__axis", "text-anchor": "end" });
    label.textContent = fmtNumber(tick, 1);
    svg.append(label);
  }
  const span = to - from;
  const stepSec = [60, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400].find((s) => span / s <= 6) ?? 86400;
  for (let t = Math.ceil(from / stepSec) * stepSec; t <= to; t += stepSec) {
    const label = svgEl("text", { x: x(t * 1000), y: height - 6, class: "dd-chart__axis", "text-anchor": "middle" });
    const d = new Date(t * 1000);
    label.textContent = span > 172800 ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    svg.append(label);
  }
  for (const t of thresholds) {
    if (!Number.isFinite(t.value)) continue;
    svg.append(svgEl("rect", { x: pad.l, width: width - pad.l - pad.r, y: t.above ? pad.t : y(t.value), height: Math.max(0, t.above ? y(t.value) - pad.t : height - pad.b - y(t.value)), fill: t.color, opacity: 0.08 }));
    svg.append(svgEl("line", { x1: pad.l, x2: width - pad.r, y1: y(t.value), y2: y(t.value), stroke: t.color, "stroke-dasharray": "4 3", "stroke-width": 1.2 }));
  }
  series.forEach((s, index) => {
    const color = s.color ?? PALETTE[index % PALETTE.length];
    if (kind === "bars") {
      const w = Math.max(1, (width - pad.l - pad.r) / Math.max(1, s.points.length) - 1);
      for (const [ms, v] of s.points) if (v !== null) svg.append(svgEl("rect", { x: x(ms) - w / 2, y: y(Math.max(v, 0)), width: w, height: Math.abs(y(v) - y(0)), fill: color }));
      return;
    }
    let d = "";
    let pen = false;
    for (const [ms, v] of s.points) {
      if (v === null || !Number.isFinite(v)) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${x(ms).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    if (d) svg.append(svgEl("path", { d, fill: "none", stroke: color, "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }));
  });
  const wrap = el("div.dd-chart", {});
  const tip = el("div.dd-chart__tip", { hidden: true });
  const cross = svgEl("line", { y1: pad.t, y2: height - pad.b, class: "dd-chart__cross", visibility: "hidden" });
  svg.append(cross);
  wrap.append(svg, tip);
  wrap.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    if (px < pad.l || px > width - pad.r || series.length === 0) { tip.hidden = true; cross.setAttribute("visibility", "hidden"); return; }
    const sec = from + ((px - pad.l) / (width - pad.l - pad.r)) * (to - from);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    tip.replaceChildren(el("div.dd-chart__tip-time", { text: fmtDate(Math.round(sec)) }));
    series.slice(0, 8).forEach((s, i) => {
      let best = null;
      for (const p of s.points) if (p[1] !== null && (best === null || Math.abs(p[0] / 1000 - sec) < Math.abs(best[0] / 1000 - sec))) best = p;
      tip.append(el("div.dd-chart__tip-row", {}, el("span.dd-swatch", { dataset: { c: String(i % PALETTE.length) } }), el("span.dd-chart__tip-name", { text: s.name }), el("b", { text: best ? fmtNumber(best[1]) : "—" })));
    });
    tip.hidden = false;
    tip.style.left = `${Math.min(event.clientX - rect.left + 12, rect.width - 220)}px`;
  });
  wrap.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
  return wrap;
}
