// v2 / Segments — saved customer groups, and the rule behind every one of them.
//
// WHY THIS SCREEN IS BUILT THE WAY IT IS
//
// The competitor meters "saved segments" and "create segments with AI" on every pricing
// tier, so this is core surface. But the thing they meter is also the thing that goes
// wrong quietly: a group built from a sentence, stored as opaque criteria, and then used
// for months by people who never saw the rule. A segment whose rule you cannot see is a
// segment you cannot trust — so on this screen the rule is never hidden:
//
//   1. THE RULE IS ALWAYS ON SCREEN, in English, above the count it produced. Not behind
//      an "edit" click. The sentence and the number are read together or not at all.
//   2. THE COUNT IS PREVIEWED BEFORE SAVING. You see who matches while you are still
//      editing, and you see the matching customers by name, not just a total.
//   3. A DESCRIPTION BECOMES EDITABLE CRITERIA, NEVER A SAVED SEGMENT. Typed text lands
//      in the builder as a proposal with a Use / Discard choice, and the reader says
//      which of your words it did not use. Nothing is applied invisibly.
//
// WHAT IS AND IS NOT WIRED, stated here because the screen states it too:
//
//   * SAVING IS NOT WIRED. This build exposes 31 actions under /x/ and not one of them
//     stores a named rule. See SEGMENTS below — it is the only path a save takes, it
//     throws, and the throw is rendered verbatim. Segments built here are held in memory
//     for this window only and every row says so.
//   * MATCHING AND COUNTING ARE REAL. Every customer, every field and every number on
//     this page comes from decisionsCustomers and decisionsSettingsGet. The matching runs
//     locally over those rows. Nothing is sampled, seeded or rounded into existence.
//   * THE DESCRIPTION BOX IS A LOCAL PHRASE READER, NOT A MODEL. No route accepts free
//     text, so the model path throws like the rest. The fallback is a fixed set of
//     patterns running in this file — deterministic, offline, and incapable of naming a
//     plan or an owner that is not already in your data.
//
// Every string reaches the DOM through textContent. Customer names pass through this
// page; innerHTML is never used, the same rule as app.js, decisions.js and the rest of v2.

export const title = "Segments";

/* ══ THE UNWIRED ADAPTER ═══════════════════════════════════════════════════════
 *
 * 🔴 NOT WIRED, ON PURPOSE. Every method here throws. This object is the single
 * seam where a real backend would land: when segment routes exist, these five
 * bodies become ctx.api(...) calls and nothing else in this file changes.
 *
 * It is a stub rather than a guess because the route list is closed. The nearest
 * thing to a general store is decisionsSettingsSet, and that is an explicit
 * allow-list patch (owners, businessContext, pseudonymise, demoMode,
 * maxReasonedPerRun, seatPriceMonthly, thresholds) — an extra key is dropped
 * without comment, so a segment written there would vanish and the call would
 * still answer ok:true. Silently losing the user's work is worse than refusing.
 */

/** The one error shape this file throws for anything the backend cannot do yet. */
function notWired(what, wouldNeed) {
  const e = new Error(`${what} is not wired yet — no route in this build can do it.`);
  e.notWired = true;
  // Plain description, deliberately NOT a camelCase route name: a made-up name
  // beside the real ones reads like a real one.
  e.wouldNeed = wouldNeed;
  return e;
}

const SEGMENTS = {
  async list() {
    throw notWired("Reading saved segments", "a route that returns the rules stored in this workspace");
  },
  async save(_segment) {
    throw notWired("Saving a segment", "a route that stores a named rule against the workspace");
  },
  async remove(_id) {
    throw notWired("Deleting a saved segment", "a route that removes a stored rule");
  },
  async rename(_id, _name) {
    throw notWired("Renaming a saved segment", "a route that changes a stored rule's name");
  },
  async describe(_text) {
    throw notWired("Turning a description into criteria with a model", "a route that accepts a sentence");
  },
};

/* ══ tiny DOM helpers ══════════════════════════════════════════════════════ */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
};

function button(text, cls, onClick) {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function select(options, value, onChange) {
  const s = el("select", "sg-sel");
  for (const [v, label] of options) {
    const o = el("option", null, label);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

/**
 * ctx.fmt is written by a sibling agent in this same build, so every call is guarded:
 * a missing or throwing helper degrades to a readable fallback rather than taking the
 * page down. money() takes a currency because the workspace is not always in dollars.
 */
function money(ctx, amount, currency) {
  if (amount == null || !Number.isFinite(Number(amount))) return "—";
  const fn = ctx?.fmt?.money;
  if (typeof fn === "function") {
    try {
      const out = fn(Number(amount), currency);
      if (out != null && out !== "") return String(out);
    } catch {
      /* fall through to the plain number */
    }
  }
  return Math.round(Number(amount)).toLocaleString("en-US");
}

function dateText(ctx, iso) {
  if (!iso) return "";
  const fn = ctx?.fmt?.date;
  if (typeof fn === "function") {
    try {
      const out = fn(iso);
      if (out != null && out !== "") return String(out);
    } catch {
      /* fall through */
    }
  }
  return String(iso);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ══ THE FIELD VOCABULARY ══════════════════════════════════════════════════
 *
 * Exactly the fields decisionsCustomers returns, and nothing else. This list is
 * the honest ceiling of the builder:
 *
 *   industry, segment, seats_purchased, tenureDays and the contact list DO exist
 *   on a customer — but only on decisionsCustomer, one call per customer. A
 *   preview that had to fetch every account to count a rule would be one request
 *   per row per keystroke, so those fields are left out rather than faked. The
 *   panel under the builder says this on screen.
 *
 * `needsRun` marks the three fields that are empty until an analysis has run:
 * decisionsCustomers returns label:null, watching:0 and staleData:false for
 * everyone when there is no run. A rule on those would match nobody and look
 * like a bug, so the UI warns instead.
 */
const FIELDS = [
  { id: "name", label: "Name", type: "text", get: (c) => c.name },
  { id: "id", label: "Customer ID", type: "text", get: (c) => c.id },
  { id: "arr", label: "ARR", type: "money", get: (c) => c.arr },
  { id: "plan", label: "Plan", type: "text", choices: true, get: (c) => c.plan },
  { id: "owner", label: "Owner", type: "text", choices: true, get: (c) => c.owner },
  { id: "label", label: "State", type: "enum", needsRun: true, get: (c) => c.label },
  { id: "daysToRenewal", label: "Days to renewal", type: "number", get: (c) => c.daysToRenewal },
  { id: "renewalDate", label: "Renewal date", type: "date", get: (c) => c.renewalDate },
  { id: "openDecisions", label: "Open decisions", type: "number", get: (c) => c.openDecisions },
  { id: "watching", label: "Watch items", type: "number", needsRun: true, get: (c) => c.watching },
  { id: "staleData", label: "Data is stale", type: "bool", needsRun: true, get: (c) => c.staleData },
];

const fieldById = (id) => FIELDS.find((f) => f.id === id) ?? null;

const NUM_OPS = [
  ["gte", "is at least"],
  ["gt", "is more than"],
  ["lte", "is at most"],
  ["lt", "is less than"],
  ["eq", "is exactly"],
  ["blank", "is not known"],
  ["notblank", "is known"],
];

const OPS = {
  text: [
    ["is", "is"],
    ["isnot", "is not"],
    ["contains", "contains"],
    ["notcontains", "does not contain"],
    ["blank", "is blank"],
    ["notblank", "is not blank"],
  ],
  money: NUM_OPS,
  number: NUM_OPS,
  enum: [
    ["is", "is"],
    ["isnot", "is not"],
    ["blank", "has none"],
    ["notblank", "has one"],
  ],
  bool: [
    ["true", "is yes"],
    ["false", "is no"],
  ],
  date: [
    ["before", "is before"],
    ["after", "is after"],
    ["on", "is on"],
    ["blank", "is blank"],
    ["notblank", "is not blank"],
  ],
};

const opsFor = (field) => OPS[field?.type] ?? OPS.text;
const opLabel = (field, op) => (opsFor(field).find(([v]) => v === op) ?? [null, op])[1];

/** blank/notblank/true/false carry their own meaning; the rest need a value typed in. */
const VALUELESS = new Set(["blank", "notblank", "true", "false"]);
const needsValue = (op) => !VALUELESS.has(op);

/** A rule that still needs a value is not counted and cannot be saved. */
function isComplete(rule) {
  if (!rule || !fieldById(rule.field)) return false;
  if (!needsValue(rule.op)) return true;
  return String(rule.value ?? "").trim() !== "";
}

/* ══ MATCHING ══════════════════════════════════════════════════════════════
 *
 * The shape is a conjunction of disjunctions: every GROUP must match, and inside
 * a group any ONE rule is enough. That is the whole AND/OR model and it is
 * deliberate — a flat list with a per-row "and"/"or" needs brackets to mean
 * anything, and an unbracketed mixed rule is read differently by every person who
 * opens it. Ambiguity is the failure this screen exists to prevent, so the two
 * levels are fixed and the English sentence brackets them for you.
 */

function testRule(c, rule) {
  const f = fieldById(rule.field);
  if (!f) return false;
  const v = f.get(c);
  const op = rule.op;
  const empty = v == null || v === "";

  if (op === "blank") return empty;
  if (op === "notblank") return !empty;
  if (op === "true") return v === true;
  if (op === "false") return v !== true;

  const raw = String(rule.value ?? "").trim();
  if (raw === "") return false;

  if (f.type === "money" || f.type === "number") {
    const n = Number(v);
    const t = Number(raw);
    if (empty || !Number.isFinite(n) || !Number.isFinite(t)) return false;
    if (op === "gte") return n >= t;
    if (op === "gt") return n > t;
    if (op === "lte") return n <= t;
    if (op === "lt") return n < t;
    if (op === "eq") return n === t;
    return false;
  }

  if (f.type === "date") {
    // renewalDate arrives as "YYYY-MM-DD", so a string compare is a date compare.
    const day = String(v ?? "").slice(0, 10);
    if (!day) return false;
    if (op === "before") return day < raw;
    if (op === "after") return day > raw;
    if (op === "on") return day === raw;
    return false;
  }

  const s = String(v ?? "").toLowerCase();
  const t = raw.toLowerCase();
  if (op === "is") return s === t;
  if (op === "isnot") return s !== t;
  if (op === "contains") return s.includes(t);
  if (op === "notcontains") return !s.includes(t);
  return false;
}

/** Groups that still have no complete rule place no constraint at all. */
function activeGroups(seg) {
  return (seg?.groups ?? []).map((g) => (g?.rules ?? []).filter(isComplete)).filter((g) => g.length > 0);
}

function matchRows(rows, seg) {
  const groups = activeGroups(seg);
  if (!groups.length) return rows.slice();
  return rows.filter((c) => groups.every((g) => g.some((r) => testRule(c, r))));
}

function countIncomplete(seg) {
  let n = 0;
  for (const g of seg?.groups ?? []) for (const r of g?.rules ?? []) if (!isComplete(r)) n++;
  return n;
}

/* ══ THE RULE, IN ENGLISH ══════════════════════════════════════════════════ */

function ruleWords(rule, view) {
  const f = fieldById(rule.field);
  if (!f) return `${rule.field} ?`;
  const op = opLabel(f, rule.op);
  if (!needsValue(rule.op)) return `${f.label} ${op}`;
  const raw = String(rule.value ?? "").trim();
  if (raw === "") return `${f.label} ${op} …`;
  if (f.type === "money") return `${f.label} ${op} ${money(view.ctx, Number(raw), view.currency)}`;
  if (f.type === "date") return `${f.label} ${op} ${dateText(view.ctx, raw)}`;
  if (f.id === "label") return `${f.label} ${op} ${view.labels[raw] ?? raw}`;
  return `${f.label} ${op} ${raw}`;
}

/**
 * The sentence above the count. Built as text nodes, never as markup: a plan or
 * an owner name is customer data and goes in through textContent like everything
 * else.
 */
function ruleSentence(seg, view) {
  const line = el("div", "sg-sentence");
  const groups = (seg?.groups ?? []).map((g) => (g?.rules ?? []).filter(isComplete)).filter((g) => g.length);

  if (!groups.length) {
    line.append(el("span", "sg-muted", "No rules yet — this matches every customer."));
    return line;
  }

  groups.forEach((rules, gi) => {
    if (gi > 0) line.append(el("span", "sg-join", "AND"));
    const wrap = el("span", "sg-grp");
    if (rules.length > 1) wrap.append(el("span", "sg-paren", "("));
    rules.forEach((r, ri) => {
      if (ri > 0) wrap.append(el("span", "sg-join or", "or"));
      wrap.append(el("span", "sg-rule", ruleWords(r, view)));
    });
    if (rules.length > 1) wrap.append(el("span", "sg-paren", ")"));
    line.append(wrap);
  });
  return line;
}

/* ══ THE DESCRIPTION READER ════════════════════════════════════════════════
 *
 * 🔶 THIS IS NOT A MODEL. It is a fixed list of patterns, run in this file, with
 * no network call. It exists because SEGMENTS.describe throws and a box that can
 * only ever show an error is not a feature.
 *
 * Two properties make it safe to put in front of a user:
 *
 *   * IT CANNOT INVENT A VALUE. Plan and owner rules are only produced when the
 *     word already appears in the fetched customer rows, so it can never write
 *     `Plan is Platinum` into a workspace that has no Platinum plan. A phrase it
 *     cannot ground is left in the "words I did not use" list instead.
 *   * IT REPORTS WHAT IT IGNORED. Every word that produced no rule is shown back.
 *     The user can then see the gap rather than trusting a rule that quietly
 *     dropped half the sentence.
 *
 * Output is a PROPOSAL. It is never written into the builder without a click.
 */

const STOPWORDS = new Set([
  "a","an","the","and","or","of","in","on","at","to","for","with","that","this","these","those",
  "is","are","was","were","be","been","am","do","does","did","has","have","had","who","whose",
  "show","me","list","find","get","all","any","some","my","our","their","them","they","it",
  "customer","customers","account","accounts","client","clients","company","companies",
  "please","just","only","also","where","which","what","when","than","then","not","no",
  "one","two","three","most","more","less","other","others","still","yet","very",
]);

/** "$50k" -> 50000, "1.5m" -> 1500000, "50,000" -> 50000. */
function parseAmount(digits, suffix) {
  const n = Number(String(digits).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const s = String(suffix ?? "").toLowerCase();
  if (s === "k") return n * 1000;
  if (s === "m") return n * 1000000;
  return n;
}

/** Day counts for "in N weeks/months". Months are read as 30 days and the chip says so. */
function toDays(n, unit) {
  const k = Number(n);
  if (!Number.isFinite(k)) return null;
  const u = String(unit ?? "day").toLowerCase();
  if (u.startsWith("week")) return k * 7;
  if (u.startsWith("month")) return k * 30;
  return k;
}

/**
 * @returns {{rules: Array, phrases: string[], ignored: string[], notes: string[]}}
 */
function readDescription(text, view) {
  const rules = [];
  const phrases = [];
  const notes = [];
  // Matched text is blanked out of `rest`; whatever survives is what was ignored.
  let rest = ` ${String(text ?? "").toLowerCase()} `;

  const eat = (re, make) => {
    rest = rest.replace(re, (...args) => {
      const groups = args.slice(0, -2); // drop offset and the whole string
      const rule = make(...groups);
      if (!rule) return groups[0]; // grounded nothing: leave the words visible
      rules.push(rule);
      phrases.push(groups[0].trim());
      return " ";
    });
  };

  // 1. Renewal windows. "soon" is not a number this file invents — it is the
  //    workspace's own renewal_near threshold, read from decisionsSettingsGet.
  eat(/\brenew\w*\s+(?:is\s+)?(?:with)?in\s+(?:the\s+)?(?:next\s+)?(\d+)\s*(day|week|month)s?\b/g, (_m, n, unit) => {
    const d = toDays(n, unit);
    if (d == null) return null;
    if (unit.startsWith("month")) notes.push("A month was read as 30 days.");
    return { field: "daysToRenewal", op: "lte", value: String(d) };
  });
  eat(/\b(?:renew\w*|renewal)\s+(?:in\s+)?(?:the\s+)?next\s+(\d+)\s*(day|week|month)s?\b/g, (_m, n, unit) => {
    const d = toDays(n, unit);
    return d == null ? null : { field: "daysToRenewal", op: "lte", value: String(d) };
  });
  eat(/\brenew\w*\s+soon\b|\bsoon\s+to\s+renew\w*\b|\bupcoming\s+renewals?\b/g, () => {
    const near = view.renewalNearDays;
    if (near == null) {
      notes.push('"soon" was ignored: the renewal threshold could not be read from settings.');
      return null;
    }
    notes.push(`"soon" was read as ${plural(near, "day", "days")} — your renewal_near threshold.`);
    return { field: "daysToRenewal", op: "lte", value: String(near) };
  });

  // 2. Money. Every comparison word maps to one operator; nothing is guessed.
  eat(/\b(?:arr|revenue|value|worth|paying|spend)?\s*(?:over|above|more than|greater than|bigger than|>)\s*\$?\s*([\d][\d,.]*)\s*([km])?\b/g,
    (_m, d, s) => {
      const v = parseAmount(d, s);
      return v == null ? null : { field: "arr", op: "gt", value: String(v) };
    });
  eat(/\b(?:arr|revenue|value|worth|paying|spend)?\s*(?:at least|minimum of|>=)\s*\$?\s*([\d][\d,.]*)\s*([km])?\b/g,
    (_m, d, s) => {
      const v = parseAmount(d, s);
      return v == null ? null : { field: "arr", op: "gte", value: String(v) };
    });
  eat(/\b(?:arr|revenue|value|worth|paying|spend)?\s*(?:under|below|less than|smaller than|<)\s*\$?\s*([\d][\d,.]*)\s*([km])?\b/g,
    (_m, d, s) => {
      const v = parseAmount(d, s);
      return v == null ? null : { field: "arr", op: "lt", value: String(v) };
    });
  eat(/\b(?:arr|revenue|value|worth|paying|spend)?\s*(?:at most|no more than|<=)\s*\$?\s*([\d][\d,.]*)\s*([km])?\b/g,
    (_m, d, s) => {
      const v = parseAmount(d, s);
      return v == null ? null : { field: "arr", op: "lte", value: String(v) };
    });

  // 3. States. The keys come from the API's own `labels` map, so a state this
  //    product does not compute can never be produced here.
  const LABEL_PATTERNS = [
    ["payment_issue", /\bpayment\s+(?:issue|problem|failure|fail)s?\b|\bfailed\s+payments?\b|\bbilling\s+(?:issue|problem)s?\b/g],
    ["at_risk", /\bat[-\s]risk\b|\bchurn\s+risk\b|\brisk\s+of\s+churn\b|\blikely\s+to\s+churn\b/g],
    ["expansion_ready", /\bexpansion(?:\s+ready)?\b|\bupsell\b|\bupgrade\s+ready\b|\bready\s+to\s+expand\b/g],
    ["dormant", /\bdormant\b|\binactive\b|\bgone\s+quiet\b/g],
    ["watching", /\bwatch(?:ing|list)\b|\bbeing\s+watched\b/g],
    ["healthy", /\bhealthy\b|\bdoing\s+well\b|\bin\s+good\s+shape\b/g],
    ["new", /\bnew\s+(?:customer|account|client|logo)s?\b|\bnewly\s+signed\b/g],
  ];
  for (const [key, re] of LABEL_PATTERNS) {
    eat(re, () => (view.labels[key] ? { field: "label", op: "is", value: key } : null));
  }

  // 4. Owner. Only produced when the name is already an owner in the data.
  eat(/\bown(?:ed|er)\s*(?:by|is|:)?\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*)?)/g, (_m, who) => {
    const hit = view.owners.find((o) => {
      const lo = o.toLowerCase();
      return lo === who.trim() || lo.startsWith(who.trim()) || who.trim().startsWith(lo);
    });
    if (!hit) {
      notes.push(`No owner in your data matches "${who.trim()}", so no owner rule was added.`);
      return null;
    }
    return { field: "owner", op: "is", value: hit };
  });

  // 5. Plan. Same grounding rule: the plan must exist in the fetched rows.
  for (const p of view.plans) {
    const safe = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    eat(new RegExp(`\\b${safe}\\b(?:\\s+plan)?`, "gi"), () => ({ field: "plan", op: "is", value: p }));
  }

  // 6. Open decisions and stale data.
  eat(/\bno\s+open\s+(?:decision|issue|item)s?\b|\bnothing\s+open\b/g, () => ({ field: "openDecisions", op: "eq", value: "0" }));
  eat(/\b(?:with|has|have|having)?\s*open\s+(?:decision|issue|item)s?\b/g, () => ({ field: "openDecisions", op: "gte", value: "1" }));
  eat(/\bstale(?:\s+data)?\b|\bout[-\s]of[-\s]date\s+data\b/g, () => ({ field: "staleData", op: "true", value: "" }));

  const ignored = [];
  for (const w of rest.split(/[^a-z0-9$%'-]+/)) {
    const word = w.trim();
    if (word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    if (/^[\d,.$%]+$/.test(word)) continue;
    if (!ignored.includes(word)) ignored.push(word);
  }

  return { rules, phrases, ignored, notes };
}

/* ══ STYLES ════════════════════════════════════════════════════════════════
 *
 * One stylesheet, injected once, everything scoped under .sg so it cannot reach
 * the shell or a sibling page. CSP allows this (style-src 'self' 'unsafe-inline').
 * Colours come only from tokens.css; the tints are color-mix over those same
 * tokens, so a browser that cannot mix drops the fill and the border still reads.
 */
const STYLE_ID = "v2-segments-style";
const CSS = `
.sg { display: flex; flex-direction: column; gap: var(--s4); max-width: 1120px; }
.sg-head { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
.sg-head h2 { margin: 0; }
.sg-muted { color: var(--muted); font-size: var(--fs-sm); }
.sg-grow { flex: 1 1 auto; }

.sg-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); }
.sg-card > header { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap;
  padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
.sg-card > header h3 { font-size: var(--fs-md); }
.sg-body { padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); }
.sg-body.flush { padding: 0; }

/* The "not wired" strip. Amber, not red: nothing is broken, a thing is absent. */
.sg-warn { display: flex; gap: var(--s3); align-items: flex-start;
  border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border));
  background: color-mix(in srgb, var(--warn) 9%, transparent);
  border-radius: var(--radius); padding: var(--s3) var(--s4); font-size: var(--fs-sm); }
.sg-warn b { color: var(--warn); font-weight: 650; }
.sg-warn p { margin: 0 0 6px; }
.sg-warn p:last-child { margin-bottom: 0; }
.sg-warn code { display: inline-block; color: var(--muted); word-break: break-word; }

/* Rule sentence: the load-bearing line on this screen, so it is never small. */
.sg-sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  font-size: var(--fs-md); line-height: 1.7; }
.sg-grp { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sg-rule { background: var(--panel-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 2px 8px; }
.sg-join { font-size: var(--fs-xs); font-variant-caps: all-small-caps; letter-spacing: .07em;
  font-weight: 650; color: var(--muted); }
.sg-join.or { color: var(--accent); }
.sg-paren { color: var(--muted); }

.sg-count { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
.sg-big { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -0.01em; }
.sg-stat { color: var(--muted); font-size: var(--fs-sm); }
.sg-stat b { color: var(--text); font-weight: 600; }

/* Builder rows. A group is a bordered block; its rules stack inside it. */
.sg-group { border: 1px solid var(--border-soft); border-radius: var(--radius);
  padding: var(--s3); display: flex; flex-direction: column; gap: var(--s2); }
.sg-andline { display: flex; align-items: center; gap: var(--s2); color: var(--muted); }
.sg-andline hr { flex: 1; border: 0; border-top: 1px solid var(--border-soft); margin: 0; }
.sg-row { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
.sg-row .sg-orlead { width: 34px; flex: 0 0 34px; text-align: right; }

.sg-sel, .sg-in { background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 6px 9px; font-size: var(--fs-sm); }
.sg-sel:focus, .sg-in:focus { border-color: var(--muted); }
.sg-in { min-width: 150px; }
.sg-in.wide { flex: 1 1 220px; }
.sg-x { background: transparent; border: 0; color: var(--muted); font-size: var(--fs-md);
  line-height: 1; padding: 4px 7px; border-radius: var(--radius-sm); }
.sg-x:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }

.sg-ta { background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 9px 11px; font: inherit; font-size: var(--fs-sm);
  width: 100%; min-height: 66px; resize: vertical; }
.sg-ta:focus { border-color: var(--muted); }

/* Matching customers. A plain list of rows, not a table: two of the four columns
   are empty for most workspaces and an empty table cell reads as a bug. */
.sg-list { display: flex; flex-direction: column; }
.sg-item { display: flex; align-items: center; gap: var(--s3); padding: 9px var(--s4);
  border-top: 1px solid var(--border-soft); font-size: var(--fs-sm); text-align: left;
  background: transparent; border-left: 0; border-right: 0; border-bottom: 0; width: 100%; color: inherit; }
.sg-item:first-child { border-top: 0; }
.sg-item:hover { background: var(--panel-2); }
.sg-item .sg-nm { font-weight: 550; }
.sg-item .sg-meta { color: var(--muted); font-size: var(--fs-xs); }
.sg-item .sg-amt { margin-left: auto; font-variant-numeric: tabular-nums; }

.sg-seg { border-top: 1px solid var(--border-soft); padding: var(--s3) var(--s4);
  display: flex; flex-direction: column; gap: var(--s2); }
.sg-seg:first-child { border-top: 0; }
.sg-segtop { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.sg-segtop h4 { font-size: var(--fs-md); }
.sg-tag { font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border));
  color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent);
  border-radius: var(--radius-pill); padding: 1px 9px; white-space: nowrap; }
.sg-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

.sg-prop { border: 1px dashed color-mix(in srgb, var(--accent) 50%, var(--border));
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  border-radius: var(--radius); padding: var(--s3); display: flex; flex-direction: column; gap: var(--s2); }
.sg-prop h4 { font-size: var(--fs-sm); }
.sg-words { display: flex; flex-wrap: wrap; gap: 5px; }
.sg-word { font-size: var(--fs-xs); border: 1px solid var(--border); border-radius: var(--radius-pill);
  padding: 1px 8px; color: var(--muted); }
.sg-inline-err { color: var(--danger); font-size: var(--fs-sm); }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

/* ══ SESSION STORE ═════════════════════════════════════════════════════════
 *
 * Segments live on ctx.state so a trip to Customers and back does not throw the
 * work away. They are NOT saved: the badge on every row says so, and nothing
 * here claims otherwise. When SEGMENTS.save stops throwing, this list becomes
 * the optimistic copy of what the server holds.
 */
function store(ctx) {
  if (!Array.isArray(ctx.state.segments)) ctx.state.segments = [];
  return ctx.state.segments;
}

let seq = 0;
const newId = () => `sg_${Date.now().toString(36)}_${++seq}`;

const blankSegment = () => ({ id: null, name: "", groups: [{ rules: [] }] });

/** Structured clone without the risk of a shared reference between list and draft. */
const cloneSeg = (s) => ({
  id: s.id,
  name: s.name,
  createdAt: s.createdAt,
  groups: (s.groups ?? []).map((g) => ({ rules: (g.rules ?? []).map((r) => ({ ...r })) })),
});

/* ══ RENDER ════════════════════════════════════════════════════════════════ */

export async function render(root, ctx) {
  ensureStyles();
  root.replaceChildren();

  const page = el("div", "sg");
  root.append(page);

  // ── loading ───────────────────────────────────────────────────────────────
  const loading = el("div", null);
  for (let i = 0; i < 3; i++) loading.append(el("div", "skeleton block"));
  page.append(loading);

  // decisionsCustomers is the whole data source for matching, so its failure ends
  // the page. decisionsSettingsGet is fetched afterwards and is allowed to fail:
  // it supplies only the workspace currency, so a sum is not printed with the
  // wrong symbol, and the renewal_near threshold, so "renewing soon" means the
  // number this workspace already uses rather than one invented here.
  let cust;
  try {
    cust = await ctx.api("decisionsCustomers", { query: { label: "all", sort: "arr" } });
  } catch (err) {
    loading.remove();
    page.append(errorBox("The customer list could not be read", err?.message ?? String(err)));
    return;
  }

  loading.remove();

  if (!cust?.ok) {
    // needsWorkspace is normally caught by the shell, but a direct #/segments hit
    // can still land here before status has been read.
    page.append(
      errorBox(
        cust?.needsWorkspace ? "No workspace is open" : "The customer list could not be read",
        cust?.error ?? "the server did not say what went wrong",
      ),
    );
    return;
  }

  const rows = Array.isArray(cust.customers) ? cust.customers : [];
  const labels = cust.labels && typeof cust.labels === "object" ? cust.labels : {};

  let currency = "USD";
  let renewalNearDays = null;
  try {
    const st = await ctx.api("decisionsSettingsGet");
    if (st?.ok) {
      if (st.settings?.currency) currency = String(st.settings.currency);
      const near = (st.thresholds ?? []).find((t) => t.id === "renewal_near");
      if (near && Number.isFinite(Number(near.current))) renewalNearDays = Number(near.current);
    }
  } catch {
    // A missing currency symbol is not worth failing the page over; USD is the
    // backend's own default and every per-customer amount still uses arrLabel,
    // which the server formatted with the real one.
  }

  // Everything the sub-renderers need, in one bag, so no function reaches for a
  // closure two levels up.
  const view = {
    ctx,
    rows,
    labels,
    currency,
    renewalNearDays,
    hasRun: cust.hasRun === true,
    owners: distinct(rows.map((c) => c.owner)),
    plans: distinct(rows.map((c) => c.plan)),
  };

  if (!rows.length) {
    page.append(unwiredBanner());
    const box = el("div", "empty");
    box.append(el("h3", null, "No customers to group yet"));
    box.append(el("p", null, "A segment is a rule over your customer list, and this workspace has not imported one. Load a folder of CSVs or seed the demo data first."));
    box.append(button("Go to Data", "btn", () => ctx.go("data")));
    page.append(box);
    return;
  }

  page.append(header(view));
  page.append(unwiredBanner());
  if (!view.hasRun) page.append(noRunBanner());

  const savedMount = el("div");
  const builderMount = el("div");
  page.append(savedMount, builderMount);

  // The draft survives navigation for the same reason the list does.
  if (!ctx.state.segmentDraft) ctx.state.segmentDraft = blankSegment();

  const repaintAll = () => {
    paintSaved(savedMount, view, repaintAll, (seg) => {
      ctx.state.segmentDraft = cloneSeg(seg);
      paintBuilder(builderMount, view, repaintAll);
      builderMount.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  };

  repaintAll();
  paintBuilder(builderMount, view, repaintAll);
}

function distinct(values) {
  const out = [];
  for (const v of values) {
    const s = v == null ? "" : String(v).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/* ── header ─────────────────────────────────────────────────────────────── */

function header(view) {
  const h = el("div", "sg-head");
  h.append(el("h2", null, "Segments"));
  const asOf = view.ctx.state?.status?.asOf;
  const bits = [plural(view.rows.length, "customer", "customers")];
  if (asOf) bits.push(`as of ${dateText(view.ctx, asOf)}`);
  h.append(el("span", "sg-muted", bits.join(" · ")));
  return h;
}

/* ── the honest banners ─────────────────────────────────────────────────── */

function unwiredBanner() {
  const box = el("div", "sg-warn");
  const body = el("div");
  const p1 = el("p");
  p1.append(el("b", null, "Segments cannot be saved in this build. "));
  p1.append(
    document.createTextNode(
      "Everything below is live and real — the rules run against your imported customers and the counts are true. But nothing here survives closing this window.",
    ),
  );
  const p2 = el("p", "sg-muted");
  p2.append(document.createTextNode("Wiring it needs one thing the backend does not have yet: "));
  p2.append(el("code", null, "a route that stores a named rule against the workspace"));
  p2.append(document.createTextNode(". Until then every segment on this page is marked “Not saved”."));
  body.append(p1, p2);
  box.append(body);
  return box;
}

function noRunBanner() {
  const box = el("div", "sg-warn");
  const body = el("div");
  const p = el("p");
  p.append(el("b", null, "No analysis has run in this workspace. "));
  p.append(
    document.createTextNode(
      "State, Watch items and Data is stale are empty for every customer until one does, so a rule on those three fields will match nobody. Name, ARR, Plan, Owner, renewal and Open decisions all work now.",
    ),
  );
  body.append(p);
  box.append(body);
  return box;
}

/** Always says WHAT failed, in the server's own words. .err styles its own <code>. */
function errorBox(heading, detail) {
  const box = el("div", "err");
  box.append(el("strong", null, heading));
  box.append(el("code", null, detail));
  return box;
}

/* ── saved segments ─────────────────────────────────────────────────────── */

function paintSaved(mount, view, repaint, onEdit) {
  mount.replaceChildren();
  const list = store(view.ctx);

  // A message left by the last action that could not reach the backend. Shown
  // once, then cleared, so it never outlives the thing it describes.
  if (view.ctx.state.segmentNotice) {
    const note = el("div", "sg-warn");
    note.append(el("div", null, view.ctx.state.segmentNotice));
    mount.append(note);
    view.ctx.state.segmentNotice = "";
  }

  const card = el("div", "sg-card");
  const head = el("header");
  head.append(el("h3", null, "Your segments"));
  head.append(el("span", "sg-grow"));
  head.append(el("span", "sg-muted", list.length ? plural(list.length, "segment", "segments") : "none yet"));
  card.append(head);

  if (!list.length) {
    const body = el("div", "sg-body");
    const p = el("p", "sg-muted");
    p.textContent = "Build a rule below and it will appear here with its live count. Reading saved segments back from the workspace is not wired, so this list starts empty every time the window opens.";
    body.append(p);
    card.append(body);
    mount.append(card);
    return;
  }

  const body = el("div", "sg-body flush");
  for (const seg of list) body.append(segmentRow(seg, view, repaint, onEdit));
  card.append(body);
  mount.append(card);
}

function segmentRow(seg, view, repaint, onEdit) {
  const wrap = el("div", "sg-seg");

  const top = el("div", "sg-segtop");
  top.append(el("h4", null, seg.name || "Untitled segment"));
  // The badge is not decoration. It is the one thing standing between the user
  // and believing this list is persistent.
  top.append(el("span", "sg-tag", "Not saved"));
  top.append(el("span", "sg-grow"));

  const matched = matchRows(view.rows, seg);
  const arr = matched.reduce((t, c) => t + (Number.isFinite(Number(c.arr)) ? Number(c.arr) : 0), 0);

  const actions = el("div", "sg-actions");
  const listMount = el("div");
  let open = false;
  const toggle = button(`${matched.length} matching`, "btn tiny", () => {
    open = !open;
    toggle.textContent = open ? "Hide list" : `${matched.length} matching`;
    listMount.replaceChildren();
    if (open) listMount.append(matchedList(matched, view, 60));
  });
  actions.append(toggle);
  actions.append(button("Edit", "btn tiny", () => onEdit(seg)));
  actions.append(
    button("Delete", "btn tiny danger", async () => {
      try {
        await SEGMENTS.remove(seg.id);
      } catch (e) {
        // The throw is carried through the repaint rather than written to a node
        // that is about to be replaced. Honest, but not obstructive: the server
        // cannot forget this segment because the server never knew it.
        view.ctx.state.segmentNotice = `${e?.message ?? e} “${seg.name || "Untitled segment"}” was removed from this window only.`;
      }
      const list = store(view.ctx);
      const i = list.findIndex((s) => s.id === seg.id);
      if (i >= 0) list.splice(i, 1);
      repaint();
    }),
  );
  top.append(actions);

  wrap.append(top);
  wrap.append(ruleSentence(seg, view));

  const stats = el("div", "sg-count");
  const n = el("span", "sg-stat");
  n.append(el("b", null, String(matched.length)));
  n.append(document.createTextNode(` of ${view.rows.length} customers`));
  stats.append(n);
  const a = el("span", "sg-stat");
  a.append(el("b", null, money(view.ctx, arr, view.currency)));
  a.append(document.createTextNode(" ARR in this group"));
  stats.append(a);
  wrap.append(stats, listMount);

  return wrap;
}

/** The matching customers, by name. A count nobody can open is a count nobody checks. */
function matchedList(matched, view, cap) {
  const box = el("div", "sg-card");
  const list = el("div", "sg-list");
  for (const c of matched.slice(0, cap)) {
    const row = el("button", "sg-item");
    row.type = "button";
    const left = el("div");
    left.append(el("div", "sg-nm", c.name ?? c.id));
    const meta = [c.plan, c.owner ? `owner ${c.owner}` : "", c.labelText ?? ""].filter(Boolean).join(" · ");
    if (meta) left.append(el("div", "sg-meta", meta));
    row.append(left);
    // arrLabel is the server's own formatting, in the workspace currency. Using
    // it instead of reformatting arr is what stops this row and the Customers
    // page disagreeing about the same amount.
    row.append(el("span", "sg-amt", c.arrLabel ?? money(view.ctx, c.arr, view.currency)));
    row.addEventListener("click", () => view.ctx.go(`customers/${c.id}`));
    list.append(row);
  }
  box.append(list);
  if (matched.length > cap) {
    box.append(el("div", "sg-item sg-muted", `Showing the first ${cap} of ${matched.length}.`));
  }
  if (!matched.length) box.append(el("div", "sg-item sg-muted", "No customer matches this rule."));
  return box;
}

/* ── the builder ────────────────────────────────────────────────────────── */

function paintBuilder(mount, view, repaintSaved) {
  const ctx = view.ctx;
  const draft = ctx.state.segmentDraft;

  mount.replaceChildren();

  const card = el("div", "sg-card");
  const head = el("header");
  head.append(el("h3", null, draft.id ? "Edit segment" : "New segment"));
  head.append(el("span", "sg-grow"));
  head.append(
    button("Clear", "btn tiny ghost", () => {
      ctx.state.segmentDraft = blankSegment();
      paintBuilder(mount, view, repaintSaved);
    }),
  );
  card.append(head);

  const body = el("div", "sg-body");

  // name ---------------------------------------------------------------------
  const nameRow = el("div", "sg-row");
  const nameIn = el("input", "sg-in wide");
  nameIn.type = "text";
  nameIn.placeholder = "Name this segment";
  nameIn.value = draft.name ?? "";
  // Typing the name must not rebuild the rows underneath, or the caret jumps.
  nameIn.addEventListener("input", () => {
    draft.name = nameIn.value;
  });
  nameRow.append(nameIn);
  body.append(nameRow);

  // description box ----------------------------------------------------------
  const proposalMount = el("div");
  body.append(describeBox(view, proposalMount, () => rebuildRules()), proposalMount);

  // rules --------------------------------------------------------------------
  const rulesMount = el("div");
  body.append(rulesMount);

  // preview ------------------------------------------------------------------
  const previewMount = el("div");
  body.append(previewMount);

  // save ---------------------------------------------------------------------
  const saveRow = el("div", "sg-row");
  const saveErr = el("div", "sg-inline-err");
  saveErr.hidden = true;
  const saveBtn = button(draft.id ? "Update segment" : "Save segment", "btn-primary", async () => {
    const name = String(draft.name ?? "").trim();
    if (!name) {
      saveErr.textContent = "Give the segment a name first.";
      saveErr.hidden = false;
      nameIn.focus();
      return;
    }
    if (!activeGroups(draft).length) {
      saveErr.textContent = "Add at least one complete rule — a segment with no rule is the whole customer list.";
      saveErr.hidden = false;
      return;
    }

    const seg = cloneSeg(draft);
    seg.name = name;
    let message = "";
    try {
      await SEGMENTS.save(seg);
    } catch (e) {
      // The throw is shown word for word. The segment is still kept, because a
      // rule you can see and use beats a rule that was refused, and the row it
      // creates is badged "Not saved".
      message = `${e?.message ?? e} Kept on this screen until you close the window.`;
    }

    const list = store(ctx);
    if (seg.id) {
      const i = list.findIndex((s) => s.id === seg.id);
      if (i >= 0) list[i] = seg;
      else list.push(seg);
    } else {
      seg.id = newId();
      seg.createdAt = new Date().toISOString();
      list.push(seg);
    }

    ctx.state.segmentDraft = blankSegment();
    // The notice is set before the repaint so it lands in the saved list, beside
    // the row it is about, rather than above a builder that has already reset.
    if (message) ctx.state.segmentNotice = message;
    repaintSaved();
    paintBuilder(mount, view, repaintSaved);
  });
  saveRow.append(saveBtn, el("span", "sg-grow"));
  body.append(saveRow, saveErr);

  card.append(body);
  mount.append(card);

  /** Redraw the rule rows and the preview. Called whenever the rule shape changes. */
  function rebuildRules() {
    rulesMount.replaceChildren();
    draft.groups ??= [{ rules: [] }];
    if (!draft.groups.length) draft.groups.push({ rules: [] });

    draft.groups.forEach((group, gi) => {
      if (gi > 0) {
        const line = el("div", "sg-andline");
        line.append(el("hr"));
        line.append(el("span", "sg-join", "AND"));
        line.append(el("hr"));
        rulesMount.append(line);
      }
      rulesMount.append(groupBlock(group, gi));
    });

    const add = el("div", "sg-row");
    add.append(
      button("+ AND another condition", "btn tiny", () => {
        draft.groups.push({ rules: [{ field: "arr", op: "gte", value: "" }] });
        rebuildRules();
      }),
    );
    rulesMount.append(add);

    paintPreview();
  }

  function groupBlock(group, gi) {
    const box = el("div", "sg-group");
    group.rules ??= [];

    if (!group.rules.length) {
      const row = el("div", "sg-row");
      row.append(
        button("+ Add a rule", "btn tiny", () => {
          group.rules.push({ field: "arr", op: "gte", value: "" });
          rebuildRules();
        }),
      );
      if (draft.groups.length > 1) {
        row.append(el("span", "sg-grow"));
        row.append(
          button("Remove", "btn tiny ghost", () => {
            draft.groups.splice(gi, 1);
            rebuildRules();
          }),
        );
      }
      box.append(row);
      return box;
    }

    group.rules.forEach((rule, ri) => box.append(ruleRow(group, rule, ri)));

    const foot = el("div", "sg-row");
    foot.append(
      button("+ OR", "btn tiny", () => {
        group.rules.push({ field: "arr", op: "gte", value: "" });
        rebuildRules();
      }),
    );
    box.append(foot);
    return box;
  }

  function ruleRow(group, rule, ri) {
    const row = el("div", "sg-row");
    row.append(el("span", "sg-orlead sg-join or", ri === 0 ? "" : "or"));

    const field = fieldById(rule.field) ?? FIELDS[0];

    row.append(
      select(
        FIELDS.map((f) => [f.id, f.needsRun && !view.hasRun ? `${f.label} (needs a run)` : f.label]),
        field.id,
        (v) => {
          rule.field = v;
          // The operator list and the value control both depend on the field, so
          // the row is rebuilt rather than patched. Resetting to the first legal
          // operator avoids "Plan is at least".
          const nf = fieldById(v);
          rule.op = opsFor(nf)[0][0];
          rule.value = "";
          rebuildRules();
        },
      ),
    );

    row.append(
      select(opsFor(field), rule.op, (v) => {
        rule.op = v;
        if (!needsValue(v)) rule.value = "";
        rebuildRules();
      }),
    );

    if (needsValue(rule.op)) row.append(valueControl(field, rule));

    row.append(el("span", "sg-grow"));
    const x = button("✕", "sg-x", () => {
      group.rules.splice(ri, 1);
      // A group emptied of rules disappears unless it is the last one — an empty
      // bordered box with nothing in it is a rule the user cannot read.
      if (!group.rules.length && draft.groups.length > 1) {
        draft.groups.splice(draft.groups.indexOf(group), 1);
      }
      rebuildRules();
    });
    x.title = "Remove this rule";
    row.append(x);
    return row;
  }

  function valueControl(field, rule) {
    // The value is edited live, so the preview must update WITHOUT redrawing this
    // input — otherwise the caret jumps on every keystroke. Only paintPreview runs.
    if (field.id === "label") {
      const opts = Object.entries(view.labels).map(([k, text]) => [k, String(text)]);
      if (!opts.length) return el("span", "sg-muted", "no states available");
      if (!rule.value) rule.value = opts[0][0];
      return select(opts, rule.value, (v) => {
        rule.value = v;
        paintPreview();
      });
    }

    if (field.choices && (rule.op === "is" || rule.op === "isnot")) {
      const values = field.id === "plan" ? view.plans : view.owners;
      if (values.length) {
        if (!rule.value) rule.value = values[0];
        return select(
          values.map((v) => [v, v]),
          rule.value,
          (v) => {
            rule.value = v;
            paintPreview();
          },
        );
      }
    }

    const input = el("input", "sg-in");
    input.type = field.type === "money" || field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
    if (field.type === "money") input.placeholder = "50000";
    if (field.type === "number") input.placeholder = "0";
    input.value = rule.value ?? "";
    input.addEventListener("input", () => {
      rule.value = input.value;
      paintPreview();
    });
    return input;
  }

  /** The count, before saving. This is the reason the screen exists. */
  function paintPreview() {
    previewMount.replaceChildren();

    const panel = el("div", "sg-card");
    const body2 = el("div", "sg-body");

    body2.append(el("div", "col-head", "This rule reads"));
    body2.append(ruleSentence(draft, view));

    const matched = matchRows(view.rows, draft);
    const arr = matched.reduce((t, c) => t + (Number.isFinite(Number(c.arr)) ? Number(c.arr) : 0), 0);
    const open = matched.reduce((t, c) => t + (Number(c.openDecisions) || 0), 0);

    const count = el("div", "sg-count");
    count.append(el("span", "sg-big", String(matched.length)));
    count.append(el("span", "sg-stat", `of ${view.rows.length} customers match`));
    const a = el("span", "sg-stat");
    a.append(el("b", null, money(ctx, arr, view.currency)));
    a.append(document.createTextNode(" ARR"));
    count.append(a);
    const o = el("span", "sg-stat");
    o.append(el("b", null, String(open)));
    o.append(document.createTextNode(" open decisions"));
    count.append(o);
    body2.append(count);

    const incomplete = countIncomplete(draft);
    if (incomplete) {
      body2.append(
        el(
          "div",
          "sg-inline-err",
          `${plural(incomplete, "rule", "rules")} still need${incomplete === 1 ? "s" : ""} a value, so ${incomplete === 1 ? "it is" : "they are"} not being counted.`,
        ),
      );
    }

    panel.append(body2);
    // Eight is enough to recognise the group and short enough to read without
    // scrolling past the controls that produced it. matchedList prints its own
    // "showing the first 8 of N" line, so nothing is added here.
    panel.append(matchedList(matched, view, 8));
    previewMount.append(panel);
  }

  rebuildRules();
}

/* ── the description box ────────────────────────────────────────────────── */

function describeBox(view, proposalMount, afterApply) {
  const box = el("div", "sg-card");
  const head = el("header");
  head.append(el("h3", null, "Describe the group"));
  head.append(el("span", "sg-grow"));
  head.append(el("span", "sg-muted", "read locally · never applied on its own"));
  box.append(head);

  const body = el("div", "sg-body");
  const ta = el("textarea", "sg-ta");
  ta.placeholder = "e.g. at risk customers over $50k renewing in 60 days";
  ta.setAttribute("aria-label", "Describe the group in plain English");
  body.append(ta);

  const row = el("div", "sg-row");
  row.append(
    button("Read this", "btn", async () => {
      proposalMount.replaceChildren();
      const text = ta.value.trim();
      if (!text) return;

      // The model path is tried first and always throws in this build. Its words
      // are shown rather than swallowed, so nobody is left believing a model read
      // the sentence.
      let modelNote = "";
      try {
        await SEGMENTS.describe(text);
      } catch (e) {
        modelNote = String(e?.message ?? e);
      }

      const read = readDescription(text, view);
      proposalMount.append(proposalCard(read, modelNote, view, afterApply));
    }),
  );
  body.append(row);

  const help = el("p", "sg-muted");
  help.textContent =
    "This is a fixed list of phrases matched in your browser, not a model — no route in this build accepts a sentence. It only writes a plan or an owner that already exists in your data, and it tells you which of your words it did not use.";
  body.append(help);

  box.append(body);
  return box;
}

function proposalCard(read, modelNote, view, afterApply) {
  const box = el("div", "sg-prop");

  if (modelNote) {
    const n = el("div", "sg-muted");
    n.append(el("b", null, "Model reading unavailable: "));
    n.append(document.createTextNode(modelNote + " Read with the local phrase list instead."));
    box.append(n);
  }

  if (!read.rules.length) {
    box.append(el("h4", null, "Nothing in that sentence matched a field"));
    const p = el("p", "sg-muted");
    p.textContent =
      "No rule was made, and nothing was changed. The reader understands amounts (over $50k), renewal windows (renewing in 60 days), the customer states below, plan and owner names that exist in your data, open decisions and stale data.";
    box.append(p);
    if (read.ignored.length) box.append(ignoredWords(read.ignored));
    return box;
  }

  box.append(el("h4", null, `Proposed: ${plural(read.rules.length, "rule", "rules")}`));

  // The proposal is shown as the same sentence the saved segment will show, so
  // what is confirmed here and what appears in the list are the same object.
  const preview = { groups: read.rules.map((r) => ({ rules: [r] })) };
  box.append(ruleSentence(preview, view));

  const matched = matchRows(view.rows, preview);
  box.append(el("div", "sg-stat", `${matched.length} of ${view.rows.length} customers would match.`));

  for (const note of read.notes) box.append(el("div", "sg-muted", note));
  if (read.ignored.length) box.append(ignoredWords(read.ignored));

  const actions = el("div", "sg-actions");
  actions.append(
    button("Use these rules", "btn-primary", () => {
      const draft = view.ctx.state.segmentDraft;
      // Each rule becomes its own AND group. "at risk over $50k" is read the way
      // a person reads it — both, not either — and every one of them is now an
      // ordinary editable row.
      const existing = (draft.groups ?? []).filter((g) => (g.rules ?? []).some(isComplete));
      draft.groups = existing.concat(read.rules.map((r) => ({ rules: [{ ...r }] })));
      box.remove();
      afterApply();
    }),
  );
  actions.append(
    button("Discard", "btn ghost", () => {
      box.remove();
    }),
  );
  box.append(actions);

  return box;
}

function ignoredWords(words) {
  const wrap = el("div");
  wrap.append(el("div", "col-head", "Words I did not use"));
  const list = el("div", "sg-words");
  for (const w of words) list.append(el("span", "sg-word", w));
  wrap.append(list);
  return wrap;
}
