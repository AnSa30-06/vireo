// v2 charts — the two data visuals, drawn by hand as inline SVG.
//
// No library, no canvas, no CDN. The app has to work with no internet, and the
// CSP on every static file under public/ is `default-src 'none'` with
// `script-src 'self'`, so a charting library could not be fetched even if one
// were wanted. Two shapes is not enough work to justify a dependency anyway.
//
// COLOUR NEVER APPEARS IN THIS FILE. Every painted node takes its colour from
// an inline style that reads a token — var(--accent), var(--muted),
// var(--text) — so the same nodes follow whatever tokens.css has in force and
// both themes work with no branch here. It has to be a style property and not
// a presentation attribute: browsers do not run var() substitution on
// `fill="var(--accent)"`, which silently renders black.
//
// Every string that reaches the DOM is set with textContent, the same rule the
// rest of this app follows. Customer names and model-written text pass through
// these captions.
//
// Both functions return an SVGElement, so the text alternative lives inside
// the SVG as <title>/<desc> with role="img" rather than in a wrapping <figure>.
// role="img" also collapses the subtree, so the drawn caption is not read out
// a second time after the description.

const SVG_NS = "http://www.w3.org/2000/svg";

// Ids for aria-labelledby have to be unique across the whole document, and a
// page can hold many of these.
let uid = 0;
const nextIds = () => {
  const n = ++uid;
  return [`v2c-t${n}`, `v2c-d${n}`];
};

const r2 = (n) => Math.round(n * 100) / 100;

function node(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (v !== null && v !== undefined) n.setAttribute(key, String(v));
    }
  }
  return n;
}

/** Paint through a token, never a literal colour. See the file header. */
function paint(n, prop, token) {
  n.style.setProperty(prop, `var(${token})`);
  return n;
}

function label(x, y, text, size, token) {
  const t = node("text", { x: r2(x), y: r2(y), "font-size": size });
  paint(t, "fill", token);
  t.textContent = text;
  return t;
}

// There is no way to measure text before it is in the document, and these
// charts are built detached. 0.56em per character is close enough for a
// system font at these sizes; `overflow: visible` on the root covers the rest,
// so a long caption spills instead of being clipped.
const textWidth = (text, size) => Math.ceil(String(text).length * size * 0.56);

function frame(cls, w, h, titleText, descText) {
  const [tid, did] = nextIds();
  const svg = node("svg", {
    class: cls,
    viewBox: `0 0 ${r2(w)} ${r2(h)}`,
    width: r2(w),
    height: r2(h),
    role: "img",
    "aria-labelledby": `${tid} ${did}`,
  });
  svg.style.maxWidth = "100%";
  svg.style.overflow = "visible";

  const title = node("title", { id: tid });
  title.textContent = titleText;
  const desc = node("desc", { id: did });
  desc.textContent = descText;
  svg.append(title, desc);
  return svg;
}

/** A count from the API, or 0. Never NaN, never negative. */
function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

const int = (n) => Math.round(n).toLocaleString();

function pctText(part, whole) {
  const p = (part / whole) * 100;
  // Rounding must never turn a group that exists into "0%", or a group with
  // someone missing into "100%". Those two are the only lies rounding tells.
  if (p > 0 && p < 0.1) return "less than 0.1%";
  if (p < 100 && p > 99.9) return "almost 100%";
  return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`;
}

/* ── dot grid ───────────────────────────────────────────────────────────── */

const MAX_DOTS = 200; // beyond this a unit chart is a texture, not a count
const PITCH = 12; // centre-to-centre
const DOT_R = 4;

/**
 * How many people one dot stands for: the first rung of the 1/2/5 ladder that
 * keeps the grid under MAX_DOTS. Round numbers only, because the caption has
 * to say the rung out loud and "one dot, 37 people" is not readable.
 */
function peoplePerDot(total) {
  const pattern = [1, 2, 5];
  let step = 1;
  for (let k = 0; k < 27; k++) {
    step = pattern[k % 3] * 10 ** Math.floor(k / 3);
    if (Math.ceil(total / step) <= MAX_DOTS) return step;
  }
  return step;
}

/**
 * A unit chart: one dot is one person. Filled dots are the affected group,
 * hollow ones the rest.
 *
 * @param {object} opts
 * @param {number} opts.filled  how many are in the affected group
 * @param {number} opts.total   how many there are altogether
 * @param {string} [opts.caption]     a line drawn above the unit line
 * @param {string} [opts.noun]        singular unit, default "person"
 * @param {string} [opts.nounPlural]  plural unit, default "people"
 * @returns {SVGElement}
 */
export function dotGrid(opts = {}) {
  const caption = opts.caption ? String(opts.caption) : "";
  const noun = typeof opts.noun === "string" && opts.noun ? opts.noun : "person";
  const nounPlural =
    typeof opts.nounPlural === "string" && opts.nounPlural
      ? opts.nounPlural
      : noun === "person"
        ? "people"
        : `${noun}s`;

  const given = toCount(opts.filled);
  const whole = toCount(opts.total);

  if (whole <= 0) return emptyGrid(caption, given, noun, nounPlural);

  // More affected than exist means the caller's two numbers disagree. Draw the
  // honest maximum so the picture stays readable, and let the description
  // carry the numbers as they were given rather than quietly repairing them.
  const part = Math.min(given, whole);

  const per = peoplePerDot(whole);
  const dots = Math.ceil(whole / per);
  // A group that exists must be visible, so a group that rounds to nothing
  // still gets one dot. The description states the real ratio either way.
  const litDots = Math.min(dots, part > 0 ? Math.max(1, Math.round(part / per)) : 0);

  const cols = dots <= 10 ? dots : Math.min(25, Math.max(10, Math.ceil(Math.sqrt(dots * 2))));
  const rows = Math.ceil(dots / cols);
  const gridW = cols * PITCH;
  const gridH = rows * PITCH;

  const unitLine =
    per === 1 ? `one dot, one ${noun}` : `one dot, ${int(per)} ${nounPlural}`;

  const lines = [];
  if (caption) lines.push({ text: caption, size: 12, token: "--text" });
  lines.push({ text: unitLine, size: 11, token: "--muted" });

  const w = Math.max(gridW, ...lines.map((l) => textWidth(l.text, l.size)));
  const h = gridH + 13 + (lines.length - 1) * 15 + 4;

  const ratio = `${int(given)} of ${int(whole)} ${whole === 1 ? noun : nounPlural}`;
  const svg = frame(
    "v2-dotgrid",
    w,
    h,
    caption || ratio,
    `${ratio}, ${pctText(given, whole)}. ` +
      (per === 1
        ? `Each dot is one ${noun}.`
        : `Each dot stands for ${int(per)} ${nounPlural}.`),
  );
  svg.style.display = "block";

  const g = node("g");
  for (let i = 0; i < dots; i++) {
    const cx = (i % cols) * PITCH + PITCH / 2;
    const cy = Math.floor(i / cols) * PITCH + PITCH / 2;
    if (i < litDots) {
      g.append(paint(node("circle", { cx, cy, r: DOT_R }), "fill", "--accent"));
    } else {
      const hollow = node("circle", { cx, cy, r: DOT_R - 0.5, fill: "none", "stroke-width": 1 });
      g.append(paint(hollow, "stroke", "--muted"));
    }
  }
  svg.append(g);

  lines.forEach((l, i) => svg.append(label(0, gridH + 13 + i * 15, l.text, l.size, l.token)));
  return svg;
}

/** No total means there is no ratio to draw. Say that instead of drawing one. */
function emptyGrid(caption, given, noun, nounPlural) {
  const lines = [];
  if (caption) lines.push({ text: caption, size: 12, token: "--text" });
  lines.push({
    text:
      given > 0
        ? `${int(given)} ${given === 1 ? noun : nounPlural}, out of an unknown total`
        : `no ${nounPlural} to show`,
    size: 11,
    token: "--muted",
  });

  const w = Math.max(...lines.map((l) => textWidth(l.text, l.size)));
  const h = 13 + (lines.length - 1) * 15 + 4;
  const svg = frame("v2-dotgrid is-empty", w, h, caption || "No chart", lines[lines.length - 1].text);
  svg.style.display = "block";
  lines.forEach((l, i) => svg.append(label(0, 13 + i * 15, l.text, l.size, l.token)));
  return svg;
}

/* ── sparkline ──────────────────────────────────────────────────────────── */

/** Trim a value for the text alternative without inventing precision. */
function num(n) {
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * A thin unfilled trend line. No axes, no gridlines, no fill.
 *
 * Gaps break the line. Drawing through a gap would put a number on screen that
 * nobody measured, which is worse than a hole.
 *
 * @param {object} opts
 * @param {Array<number|null|undefined|string>} opts.values  oldest first
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @returns {SVGElement}
 */
export function sparkline(opts = {}) {
  const w = Number.isFinite(Number(opts.width)) && Number(opts.width) > 0 ? Number(opts.width) : 120;
  const h = Number.isFinite(Number(opts.height)) && Number(opts.height) > 0 ? Number(opts.height) : 28;
  const series = Array.isArray(opts.values) ? opts.values : [];

  // null/undefined/"" are holes and must be tested BEFORE Number(), because
  // Number(null) is 0 and Number("") is 0 — a hole would become a real zero.
  const points = series.map((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });

  const real = points.filter((n) => n !== null);
  const gaps = points.length - real.length;

  if (real.length === 0) {
    const text = "no data";
    const svg = frame("v2-sparkline is-empty", Math.max(w, textWidth(text, 10)), h, "Trend", "No trend data.");
    svg.style.verticalAlign = "middle";
    svg.append(label(0, h / 2 + 3, text, 10, "--muted"));
    return svg;
  }

  const min = Math.min(...real);
  const max = Math.max(...real);
  const padX = 1.5;
  const padY = 3; // keeps the stroke off the top and bottom edges
  const span = max - min;

  const n = points.length;
  const xAt = (i) => (n === 1 ? w / 2 : padX + (i / (n - 1)) * (w - padX * 2));
  // An all-equal series has no range to scale against; it is a flat line down
  // the middle, and the division never happens.
  const yAt = (v) => (span === 0 ? h / 2 : padY + (1 - (v - min) / span) * (h - padY * 2));

  let summary;
  if (real.length === 1) summary = `One point, ${num(real[0])}.`;
  else if (span === 0) summary = `${real.length} points, flat at ${num(min)}.`;
  else {
    summary =
      `${real.length} points, from ${num(real[0])} to ${num(real[real.length - 1])}. ` +
      `Lowest ${num(min)}, highest ${num(max)}.`;
  }

  const svg = frame(
    "v2-sparkline",
    w,
    h,
    "Trend",
    summary + (gaps > 0 ? ` ${gaps} ${gaps === 1 ? "point has" : "points have"} no data.` : ""),
  );
  svg.style.verticalAlign = "middle";

  // Walk the series, cutting a new run at every hole. A run of one has no line
  // to draw, so it gets a dot — otherwise a lone reading between two gaps
  // would render as nothing at all.
  let d = "";
  let run = 0;
  for (let i = 0; i <= n; i++) {
    const v = i < n ? points[i] : null;
    if (v !== null) {
      d += `${run === 0 ? "M" : "L"}${r2(xAt(i))} ${r2(yAt(v))}`;
      run++;
      continue;
    }
    if (run === 1) {
      const j = i - 1;
      svg.append(paint(node("circle", { cx: r2(xAt(j)), cy: r2(yAt(points[j])), r: 1.6 }), "fill", "--accent"));
      d = d.slice(0, d.lastIndexOf("M")); // drop the one-point subpath
    }
    run = 0;
  }

  if (d) {
    const path = node("path", {
      d,
      fill: "none",
      "stroke-width": 1.5,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      // the root may be scaled down by max-width; the line stays thin
      "vector-effect": "non-scaling-stroke",
    });
    svg.append(paint(path, "stroke", "--accent"));
  }

  return svg;
}
