// Ask — plain-English questions about your customers.
//
// WHY THIS SCREEN IS BUILT THE WAY IT IS
//
// The competitor's whole product is a text box that turns a typed question into SQL.
// The measured record for that category is 86% on academic benchmarks and 0-6% on real
// enterprise databases, and the documented fix for a wrong answer is "write better custom
// instructions". So the failure is not rare, and the remedy is a settings blob.
//
// Three consequences, and every one of them is visible on this screen rather than in a
// README:
//
//  1. AN ANSWER CARRIES ITS RECORDS. The evidence and the rows that produced the number
//     are rendered with the number, not behind a "show work" toggle. A number you cannot
//     check is a number you cannot use.
//  2. "I COULD NOT ANSWER THAT" IS A RESULT, not an error. It has its own card, its own
//     wording and its own next step. An honest refusal beats a plausible wrong number,
//     and that is the entire argument.
//  3. THE CORRECTION SITS BESIDE THE ANSWER. The "Wrong?" control is inside the headline
//     row, one click from the number to the definition that produced it, and it writes
//     through decisionsSettingsSet. Nobody is sent to a settings page to edit prose.
//
// WHAT IS AND IS NOT WIRED, stated plainly because the screen states it too:
//
//   * A TYPED question is NOT answered. No route in this build accepts free text — see
//     the stub directly below, which is the only thing a typed question reaches. It
//     throws, and the throw is rendered verbatim.
//   * A PICKED question IS answered, for real, from the real routes. The questions in
//     QUESTIONS below each run named routes with named filters and show what came back.
//     Nothing on this page is generated, sampled or rounded into existence.
//
// Every string here reaches the DOM through textContent. Customer names and model-written
// text pass through this page; innerHTML is never used, the same rule as app.js,
// decisions.js and the rest of v2.

export const title = "Ask";

/* ══ THE ONE UNWIRED THING ══════════════════════════════════════════════════
 *
 * 🔴 NOT WIRED. This is the only path a typed question takes, and it is a stub on
 * purpose.
 *
 * The backend exposes 31 actions under /x/ and every one of them is a structured read or
 * write with fixed parameters — decisionsOverview, decisionsList, decisionsCustomers,
 * decisionsGet, decisionsSettingsSet and so on. Not one of them accepts a sentence.
 *
 * The alternative to this stub would be to match the typed words against the built-in
 * questions and answer the closest one. That is exactly the failure this screen exists to
 * argue against: it answers a question nobody asked and shows a real number while doing
 * it, which is worse than silence because it looks right. So the typed path refuses, and
 * the closest built-ins are offered as SUGGESTIONS the person has to choose.
 *
 * To wire it: add a route that takes { question } and returns { answer, evidence[],
 * records[] } or an explicit refusal, then call it here and return the same shape
 * buildAnswer() already renders. Nothing else on this page has to change.
 */
async function answerTypedQuestion(/* ctx, question */) {
  throw new Error(
    "Not wired yet: no route in this build turns a typed question into an answer. " +
      "All 31 actions under /x/ are structured reads and writes with fixed parameters " +
      "(decisionsOverview, decisionsList, decisionsCustomers, decisionsGet, …); none of them " +
      "accepts free text. Vireo will not guess which question you meant and answer that one " +
      "instead, so nothing is shown here until a question route exists.",
  );
}

/* ── DOM helpers ────────────────────────────────────────────────────────── */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(label, cls, onClick) {
  const b = el("button", cls, label);
  b.type = "button";
  if (onClick) b.onclick = onClick;
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A button that stays disabled for the length of its await. Every action here can be slow. */
function busyButton(label, busyLabel, cls, fn) {
  const b = button(label, cls, async () => {
    b.disabled = true;
    b.textContent = busyLabel;
    try {
      await fn();
    } finally {
      b.disabled = false;
      b.textContent = label;
    }
  });
  return b;
}

/* ── formatting ─────────────────────────────────────────────────────────── */

// ctx.fmt is specified only by the names of its four helpers, so every call falls back to
// the raw value rather than risk printing "undefined" where a date should be.
function dateText(ctx, iso) {
  if (!iso) return "";
  const f = ctx.fmt?.date;
  if (typeof f === "function") {
    const out = f(iso);
    if (out) return String(out);
  }
  return String(iso).slice(0, 10);
}

/**
 * Whole counts only. Money is never formatted here — the API already sends a label.
 *
 * null is an em dash, not a zero. Number(null) is 0, so the obvious one-liner turns "this
 * column was never written" into "nothing happened", which are different facts and would
 * be a fabricated number on a page whose whole argument is that it does not fabricate.
 */
const count = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : Number(n).toLocaleString("en-US"));

/**
 * Money falls back to ctx.fmt only when the API sent no label. decisionsOverview,
 * decisionsList and decisionsCustomers all pre-format their amounts (arrUnderReviewLabel,
 * impactLabel, arrLabel); using those keeps one formatter on screen instead of two that
 * drift apart on the same row.
 */
function moneyText(ctx, label, amount, currency) {
  if (label) return String(label);
  const f = ctx.fmt?.money;
  if (typeof f === "function" && amount != null) return String(f(amount, currency ?? "USD"));
  return "—";
}

/**
 * A run timestamp, which needs its clock as well as its day: two runs on one day are
 * common and "15 Sep 2026" cannot tell them apart. nowIso() writes UTC, so the label says
 * UTC rather than implying local time.
 */
function whenText(ctx, iso) {
  const day = dateText(ctx, iso);
  const clock = String(iso ?? "").slice(11, 16);
  return clock ? `${day} ${clock} UTC` : day;
}

function renewalText(ctx, iso, days) {
  if (!iso) return "no renewal date";
  const when = dateText(ctx, iso);
  if (days == null || !Number.isFinite(Number(days))) return when;
  const n = Number(days);
  if (n === 0) return when + " · today";
  return when + (n > 0 ? ` · in ${n} days` : ` · ${Math.abs(n)} days ago`);
}

/* ── record tables ──────────────────────────────────────────────────────── */

// A workspace can hold hundreds of open decisions and decisionsList has no pagination, so
// the table is capped and says so. An uncapped answer builds a 2,000-row DOM to prove a
// count that is already printed at the top.
const RECORD_CAP = 50;

/**
 * records = { columns:[string], rows:[{ cells:[string], go:string|null }], total, note }
 * The first cell of a row carries the link, so the row stays reachable by keyboard
 * without a faked role on a <tr>.
 */
function recordsTable(ctx, records) {
  const wrap = el("div", "ak-records");

  const head = el("div", "ak-sec-head");
  head.append(el("span", "col-head", `Records (${count(records.total)})`));
  if (records.note) head.append(el("span", "ak-note", records.note));
  wrap.append(head);

  if (!records.rows.length) {
    wrap.append(el("p", "ak-dim", "No records came back for this filter."));
    return wrap;
  }

  const scroll = el("div", "ak-scroll");
  const table = el("table", "ak-table");

  const thead = el("thead");
  const hr = el("tr");
  for (const c of records.columns) hr.append(el("th", "col-head", c));
  thead.append(hr);

  const tbody = el("tbody");
  for (const row of records.rows.slice(0, RECORD_CAP)) {
    const tr = el("tr");
    row.cells.forEach((cell, i) => {
      const td = el("td");
      if (i === 0 && row.go) {
        td.append(button(String(cell), "ak-link", () => ctx.go(row.go)));
      } else {
        td.textContent = String(cell);
        if (i > 0) td.className = "ak-cell-dim";
      }
      tr.append(td);
    });
    tbody.append(tr);
  }

  table.append(thead, tbody);
  scroll.append(table);
  wrap.append(scroll);

  if (records.rows.length > RECORD_CAP) {
    wrap.append(
      el("p", "ak-dim", `Showing the first ${RECORD_CAP} of ${count(records.rows.length)} rows.`),
    );
  }
  return wrap;
}

/** DecisionCard[] -> a records table. Field names are the camelCase ones decisionCard maps. */
function decisionRecords(ctx, cards) {
  const missingImpact = cards.filter((d) => d.impactAmount == null).length;
  return {
    columns: ["Decision", "Customer", "Impact", "Owner", "Due"],
    total: cards.length,
    note: missingImpact ? `${count(missingImpact)} carry no impact amount` : "",
    rows: cards.map((d) => ({
      go: d.id ? `decisions/${d.id}` : null,
      cells: [
        d.title ?? d.id ?? "—",
        d.accountName ?? "—",
        d.impactLabel ?? "—",
        d.owner || "Unassigned",
        d.overdueDays != null
          ? `${count(d.overdueDays)} days overdue`
          : d.dueAt
            ? dateText(ctx, d.dueAt)
            : "no due date",
      ],
    })),
  };
}

/** decisionsCustomers rows -> a records table. */
function customerRecords(ctx, customers) {
  return {
    columns: ["Customer", "ARR", "Vireo's label", "Open decisions", "Renewal"],
    total: customers.length,
    note: "",
    rows: customers.map((c) => ({
      go: c.id ? `customers/${c.id}` : null,
      cells: [
        c.name ?? c.id ?? "—",
        moneyText(ctx, c.arrLabel, c.arr),
        c.labelText ?? "no label",
        count(c.openDecisions),
        renewalText(ctx, c.renewalDate, c.daysToRenewal),
      ],
    })),
  };
}

/* ── answers and refusals ───────────────────────────────────────────────── */
//
// Every built-in question returns one of exactly two shapes, and both are first-class.
//
//   ANSWER  { kind:"answer", value, unit, sentence, definition, evidence[], facts[]?,
//             records?, corrections:[thresholdId], usesSeatPrice?, tone? }
//   REFUSAL { kind:"refusal", reason, checked[], remedies:[{label, kind}] }
//
// A refusal is returned whenever the data cannot support the question — no run yet, no
// imported rows, a route that said ok:false. It is never a thrown error and never an
// empty answer with a zero in it, because "0 customers at risk" and "nobody has looked"
// are different facts and must not render the same.

const answer = (a) => ({ kind: "answer", corrections: [], evidence: [], ...a });
const refusal = (r) => ({ kind: "refusal", checked: [], remedies: [], ...r });

/** A route that answered ok:false. The server's exact wording is kept, never paraphrased. */
function routeRefusal(name, res, checked = []) {
  if (res?.needsWorkspace) {
    return refusal({
      reason: "There is no workspace open, so there is nothing to count.",
      checked: [`${name} answered: ${res.error ?? "no workspace yet"}`, ...checked],
      remedies: [{ label: "Choose or create a workspace", kind: "workspace" }],
    });
  }
  return refusal({
    reason: "Vireo could not read the records this question needs, so it is not answering it.",
    checked: [`${name} answered: ${res?.error ?? "no reason given"}`, ...checked],
    remedies: [{ label: "Try again", kind: "retry" }],
  });
}

/**
 * Nothing has been imported, so the question is about records that do not exist.
 *
 * "No renewal is due in the next 60 days" and "no customer has been loaded" are the same
 * zero on screen and opposite facts underneath. Only one of them means you are safe.
 */
function noDataRefusal(what, checked = []) {
  return refusal({
    reason: `${what} come from the customer data you import, and this workspace has none. A zero here would read as "you are clear" when it means "nothing has been loaded".`,
    checked,
    remedies: [{ label: "Import customer data", kind: "go:data" }],
  });
}

/** No analysis has run, so every label, signal and decision is absent rather than empty. */
function noRunRefusal(what, checked = []) {
  return refusal({
    reason: `${what} come from the analysis run, and no analysis has finished in this workspace yet. Vireo will not report zero when the truthful answer is "nobody has looked".`,
    checked,
    remedies: [
      { label: "Run the analysis", kind: "run" },
      { label: "Check the imported data", kind: "go:data" },
    ],
  });
}

/* ── the questions Vireo can actually answer ────────────────────────────── */
//
// Each entry names the routes it calls in `routes`, and those names are printed on screen
// in the evidence block. That is deliberate: the person reading the answer can go and
// check the same route themselves, which is not a thing the competitor's generated SQL
// offers.

const QUESTIONS = [
  {
    id: "needs-me",
    text: "What needs me today?",
    keywords: "today now urgent overdue attention queue work on next priority",
    routes: ["decisionsOverview"],
    async run(ctx, env) {
      const r = await ctx.api("decisionsOverview");
      if (!r?.ok) return routeRefusal("decisionsOverview", r);

      const t = r.tiles ?? {};
      const c = r.counts ?? {};

      // The conjunction matters: refuse only when there is nothing AND nothing has ever
      // looked. Either one alone would hide a real zero, which is a fact worth having.
      if ((c.all ?? 0) === 0 && !env.status?.lastRun) {
        return noRunRefusal("Decisions", [
          "decisionsOverview returned no decisions at all",
          "decisionsStatus reported no analysis run has ever finished here",
        ]);
      }
      const rows = [...(r.sections?.overdue ?? []), ...(r.sections?.attention ?? [])];
      const total = (t.overdue ?? 0) + (t.attention ?? 0);

      return answer({
        value: count(total),
        unit: total === 1 ? "decision is waiting for you" : "decisions are waiting for you",
        sentence:
          total === 0
            ? "Nothing is past its due date and nothing is waiting for a decision from you."
            : `${count(t.overdue ?? 0)} of them are past their due date.`,
        definition:
          "Overdue means the decision has a due date in the past and is still new, accepted, in progress or waiting. Needs a decision means it is open and not overdue. The API counts an overdue decision once, in overdue only, so these two never double-count.",
        tone: (t.overdue ?? 0) > 0 ? "danger" : "plain",
        evidence: [
          ["Route", "decisionsOverview, no filters"],
          ["As of", r.asOf ?? "not given"],
          ["Open decisions in this workspace", count(c.open)],
          ["Overdue", count(t.overdue)],
          ["Needs a decision", count(t.attention)],
          ["Being handled", count(t.waiting)],
          ["Snoozed", count(t.snoozed)],
        ],
        records: decisionRecords(ctx, rows),
        corrections: [],
      });
    },
  },

  {
    id: "arr-under-review",
    text: "How much ARR is under review?",
    keywords: "arr money revenue risk churn amount exposed value dollars under review",
    routes: ["decisionsOverview", "decisionsList"],
    async run(ctx, env) {
      const [o, list] = await Promise.all([
        ctx.api("decisionsOverview"),
        ctx.api("decisionsList", { query: { status: "open", kind: "churn_risk", sort: "priority" } }),
      ]);
      if (!o?.ok) return routeRefusal("decisionsOverview", o);
      if (!list?.ok) return routeRefusal("decisionsList", list);

      if ((o.counts?.all ?? 0) === 0 && !env.status?.lastRun) {
        return noRunRefusal("Churn risks", [
          "decisionsOverview returned no decisions at all",
          "decisionsStatus reported no analysis run has ever finished here",
        ]);
      }

      const cards = list.decisions ?? [];
      const missing = cards.filter((d) => d.impactAmount == null).length;

      return answer({
        // `||` and not `??`: an empty label is as useless as a missing one, and the tile
        // is a formatted string rather than a number.
        value: o.tiles?.arrUnderReviewLabel || moneyText(ctx, null, o.tiles?.arrUnderReview),
        unit: "of ARR sits under an open churn risk",
        sentence: `${count(cards.length)} open churn-risk ${cards.length === 1 ? "decision is" : "decisions are"} behind that figure.`,
        definition:
          "The sum of impact_amount over OPEN decisions of kind churn_risk only. Expansion, payment risk and cohort shift are excluded, and a decision stops counting the moment it is resolved or dismissed. For a churn risk the impact is the account's whole ARR — the contract value at risk, not a forecast of what you would lose. The thresholds decide WHICH accounts are in this sum, not how much each one contributes.",
        evidence: [
          ["Route", "decisionsOverview for the total"],
          ["Route", "decisionsList with status=open, kind=churn_risk, sort=priority for the rows"],
          ["As of", o.asOf ?? "not given"],
          ["Open churn-risk decisions", count(cards.length)],
          [
            "Rows with no impact amount",
            missing
              ? `${count(missing)} — these add nothing to the total, so the real exposure is higher than the figure above`
              : "none",
          ],
        ],
        records: decisionRecords(ctx, cards),
        // Seat price is deliberately NOT listed here. It only moves an EXPANSION impact
        // (situations.mjs: a churn risk's impact is the account's ARR), and offering a
        // control that cannot change the number above would be the same lie as the number
        // itself.
        corrections: ["usage_drop_30d", "renewal_near", "tickets_up_30d"],
      });
    },
  },

  {
    id: "expansion",
    text: "Where could we sell more seats?",
    keywords: "expansion upsell grow seats more sell revenue opportunity buying",
    routes: ["decisionsList"],
    async run(ctx, env) {
      const r = await ctx.api("decisionsList", {
        query: { status: "open", kind: "expansion", sort: "priority" },
      });
      if (!r?.ok) return routeRefusal("decisionsList", r);
      if (!env.status?.lastRun) {
        return noRunRefusal("Expansion opportunities", [
          "decisionsStatus reported no analysis run has ever finished here",
        ]);
      }

      const cards = r.decisions ?? [];
      // impactBasis is the engine's own sentence about how it got the money figure, and
      // for expansion it can literally say "not estimated: no seat price is set for this
      // workspace". That sentence is shown rather than hidden — it is the reason a column
      // is empty, and the fix for it is one click away in the panel below.
      const unpriced = cards.filter((d) => d.impactAmount == null).length;

      return answer({
        value: count(cards.length),
        unit: cards.length === 1 ? "open expansion is on the table" : "open expansions are on the table",
        sentence: unpriced
          ? `${count(unpriced)} of them carry no money figure, because the seat price is what turns extra seats into an amount.`
          : "Every one of them carries a money figure worked out from the seat price.",
        definition:
          "Open decisions of kind expansion. The amount is (extra seats × seat price × 12), where extra seats comes from the seat-utilisation signal plus a fixed headroom. With no seat price set for the workspace, the engine records no amount at all rather than guessing one.",
        evidence: [
          ["Route", "decisionsList with status=open, kind=expansion, sort=priority"],
          ["As of", r.asOf ?? "not given"],
          ["Rows returned", count(r.total)],
          ["Rows with no money figure", unpriced ? count(unpriced) : "none"],
        ],
        records: {
          columns: ["Decision", "Customer", "Impact", "How that amount was reached", "Owner"],
          total: cards.length,
          note: "",
          rows: cards.map((d) => ({
            go: d.id ? `decisions/${d.id}` : null,
            cells: [
              d.title ?? d.id ?? "—",
              d.accountName ?? "—",
              d.impactLabel ?? "—",
              d.impactBasis ?? "—",
              d.owner || "Unassigned",
            ],
          })),
        },
        // No editable threshold governs expansion: it fires on usage_rise_30d plus
        // seat_util_high or pricing_interest, and none of those three is editable in
        // Settings. The seat price is the one thing here a person can change.
        corrections: [],
        usesSeatPrice: true,
      });
    },
  },

  {
    id: "at-risk",
    text: "Which customers are at risk?",
    keywords: "risk churn leaving unhappy danger losing customers accounts at risk",
    routes: ["decisionsCustomers"],
    async run(ctx, env) {
      const r = await ctx.api("decisionsCustomers", { query: { label: "at_risk", sort: "arr" } });
      if (!r?.ok) return routeRefusal("decisionsCustomers", r);
      if (!r.hasRun) {
        return noRunRefusal("Risk labels", ["decisionsCustomers answered ok, and hasRun was false"]);
      }

      const rows = r.customers ?? [];
      return answer({
        value: count(rows.length),
        unit: rows.length === 1 ? "customer carries an at-risk label" : "customers carry an at-risk label",
        sentence: rows.length
          ? "Highest ARR first. The label comes from the signals in the last run, not from anyone's opinion."
          : "No customer met the at-risk rule in the last run.",
        definition:
          'A customer is labelled "At risk" when the last run found a churn-risk situation for it: usage down past the threshold, AND at least one of a near renewal, rising tickets, a quiet champion or unused seats. One rule sits in front of it — a customer with a failed payment is labelled "Payment issue" instead, even when it also has a churn risk. The label is a snapshot of that run and does not move until the next one.',
        tone: rows.length ? "warn" : "plain",
        evidence: [
          ["Route", "decisionsCustomers with label=at_risk, sort=arr"],
          // decisionsCustomers returns no asOf of its own — it is the only list route that
          // does not. The date comes from decisionsStatus, which reads the same pinned
          // as-of value out of the same workspace, so the two cannot disagree.
          ["As of", env.status?.asOf ?? "not given"],
          ["Customers returned", count(r.total)],
          ["Label set", Object.values(r.labels ?? {}).join(", ") || "not given"],
        ],
        records: customerRecords(ctx, rows),
        corrections: ["usage_drop_30d", "renewal_near", "tickets_up_30d"],
      });
    },
  },

  {
    id: "renewals",
    text: "Which renewals are coming up?",
    keywords: "renewal renew contract expiring expiry coming up soon dates",
    routes: ["decisionsCustomers"],
    async run(ctx, env) {
      const r = await ctx.api("decisionsCustomers", { query: { sort: "renewal" } });
      if (!r?.ok) return routeRefusal("decisionsCustomers", r);

      // The window is the shipped-or-overridden "Renewal near" threshold, read from
      // decisionsSettingsGet. Picking a number here instead would be inventing a
      // definition and then hiding it inside this file.
      const row = (env.thresholds ?? []).find((t) => t.id === "renewal_near");
      if (!row) {
        return refusal({
          reason:
            "The renewal window is a setting, and Vireo could not read the settings for this workspace. It will not substitute a number of its own.",
          checked: ["decisionsSettingsGet did not return the renewal_near threshold"],
          remedies: [{ label: "Try again", kind: "retry" }],
        });
      }

      const days = Number(row.current);
      const all = r.customers ?? [];
      // Renewal dates are imported, not computed by a run, so the guard here is "no
      // customers loaded" rather than "no run yet".
      if (!all.length) {
        return noDataRefusal("Renewal dates", ["decisionsCustomers returned no customer rows at all"]);
      }
      const within = all.filter((c) => c.daysToRenewal != null && c.daysToRenewal >= 0 && c.daysToRenewal <= days);
      const past = all.filter((c) => c.daysToRenewal != null && c.daysToRenewal < 0).length;
      const undated = all.filter((c) => c.daysToRenewal == null).length;

      return answer({
        value: count(within.length),
        unit: `${within.length === 1 ? "renewal falls" : "renewals fall"} inside the next ${count(days)} days`,
        sentence: past
          ? `${count(past)} more renewal dates are already in the past.`
          : "Soonest first.",
        definition: `The window is the "${row.label}" threshold, currently ${count(days)} ${row.unit} (shipped default ${count(row.shipped)}). A customer is counted once by renewal date, whether or not it has an open decision.`,
        evidence: [
          ["Route", "decisionsCustomers with sort=renewal"],
          ["As of", env.status?.asOf ?? "not given"],
          ["Customers scanned", count(all.length)],
          ["Inside the window", count(within.length)],
          ["Renewal date already past", count(past)],
          ["No renewal date on record", count(undated)],
          ["Window applied here", `${count(days)} ${row.unit}, filtered on daysToRenewal from the API`],
        ],
        records: customerRecords(ctx, within),
        corrections: ["renewal_near"],
      });
    },
  },

  {
    id: "payment",
    text: "Who has a payment problem?",
    keywords: "payment invoice billing failed card unpaid money owed collections",
    routes: ["decisionsCustomers", "decisionsList"],
    async run(ctx, env) {
      const [c, d] = await Promise.all([
        ctx.api("decisionsCustomers", { query: { label: "payment_issue", sort: "arr" } }),
        ctx.api("decisionsList", { query: { status: "open", kind: "payment_risk", sort: "priority" } }),
      ]);
      if (!c?.ok) return routeRefusal("decisionsCustomers", c);
      if (!d?.ok) return routeRefusal("decisionsList", d);
      if (!c.hasRun) {
        return noRunRefusal("Payment labels", ["decisionsCustomers answered ok, and hasRun was false"]);
      }

      const rows = c.customers ?? [];
      return answer({
        value: count(rows.length),
        unit: rows.length === 1 ? "customer has a payment problem" : "customers have a payment problem",
        // Not "attached to them": the label needs one failed payment, while a payment_risk
        // DECISION also needs a second signal, so the two counts are related but not the
        // same set. Saying they are the same set would be a small invented fact.
        sentence: `There ${d.total === 1 ? "is" : "are"} ${count(d.total)} open payment-risk ${d.total === 1 ? "decision" : "decisions"}, which is a narrower test: a decision also needs a second signal beside the failed payment.`,
        definition:
          'A customer is labelled "Payment issue" when the last run saw a failed payment on the imported invoice records. That rule is checked before every other label, so an account with both a failed payment and a churn risk appears here and not under "At risk". The decision count beside it is open decisions of kind payment_risk, which is a separate list and can differ from the customer count.',
        tone: rows.length ? "warn" : "plain",
        evidence: [
          ["Route", "decisionsCustomers with label=payment_issue, sort=arr"],
          ["Route", "decisionsList with status=open, kind=payment_risk"],
          ["As of", d.asOf ?? env.status?.asOf ?? "not given"],
          ["Customers labelled", count(c.total)],
          ["Open payment-risk decisions", count(d.total)],
        ],
        records: customerRecords(ctx, rows),
        corrections: [],
      });
    },
  },

  {
    id: "unowned",
    text: "What is nobody working on?",
    keywords: "unassigned nobody owner ownerless orphan who owns nothing assigned",
    routes: ["decisionsList"],
    async run(ctx, env) {
      const r = await ctx.api("decisionsList", {
        query: { status: "open", owner: "unassigned", sort: "priority" },
      });
      if (!r?.ok) return routeRefusal("decisionsList", r);
      if (!env.status?.lastRun) {
        return noRunRefusal("Decisions", ["decisionsStatus reported no analysis run has ever finished here"]);
      }

      const rows = r.decisions ?? [];
      const knownOwners = r.owners ?? [];
      return answer({
        value: count(rows.length),
        unit: rows.length === 1 ? "open decision has no owner" : "open decisions have no owner",
        sentence: knownOwners.length
          ? `${count(knownOwners.length)} people already own something here: ${knownOwners.join(", ")}.`
          : "No owner name appears on any decision in this workspace yet.",
        definition:
          "Unassigned means the owner field is empty. It is not a status — a decision can be accepted, in progress or overdue and still belong to nobody.",
        tone: rows.length ? "warn" : "plain",
        evidence: [
          ["Route", "decisionsList with status=open, owner=unassigned, sort=priority"],
          ["As of", r.asOf ?? "not given"],
          ["Rows returned", count(r.total)],
          ["Owners known across all decisions", knownOwners.length ? knownOwners.join(", ") : "none"],
        ],
        records: decisionRecords(ctx, rows),
        corrections: [],
      });
    },
  },

  {
    id: "stale",
    text: "Whose numbers should I not trust?",
    keywords: "stale old data trust missing outdated gap usage feed broken",
    routes: ["decisionsCustomers"],
    async run(ctx, env) {
      const r = await ctx.api("decisionsCustomers", { query: { sort: "arr" } });
      if (!r?.ok) return routeRefusal("decisionsCustomers", r);
      if (!r.hasRun) {
        return noRunRefusal("Stale-data flags", ["decisionsCustomers answered ok, and hasRun was false"]);
      }

      const all = r.customers ?? [];
      if (!all.length) {
        return noDataRefusal("Data-freshness flags", ["decisionsCustomers returned no customer rows at all"]);
      }
      const stale = all.filter((c) => c.staleData);
      return answer({
        value: count(stale.length),
        unit:
          stale.length === 1
            ? "customer has data Vireo does not trust"
            : "customers have data Vireo does not trust",
        sentence: stale.length
          ? "Every other answer on this page is weaker for these accounts, because the numbers underneath them stopped arriving."
          : "Every customer has recent enough data for the signals to mean something.",
        definition:
          "staleData is set by the last run when an account's usage records stop before the as-of date. The rule lives in the shipped rules file, not in Settings, so it is not editable here.",
        tone: stale.length ? "warn" : "plain",
        evidence: [
          ["Route", "decisionsCustomers with sort=arr, filtered on staleData from the API"],
          ["As of", env.status?.asOf ?? "not given"],
          ["Customers scanned", count(all.length)],
          ["Flagged stale", count(stale.length)],
        ],
        records: customerRecords(ctx, stale),
        corrections: [],
      });
    },
  },

  {
    id: "last-run",
    text: "What did the last analysis do?",
    keywords: "run analysis last model tokens failed when ran history job",
    routes: ["decisionsRunStatus"],
    async run(ctx) {
      const r = await ctx.api("decisionsRunStatus");
      if (!r?.ok) return routeRefusal("decisionsRunStatus", r);
      if (!r.run) {
        return noRunRefusal("Run figures", ["decisionsRunStatus answered ok, and run was null"]);
      }

      // decisionsRunStatus spreads the raw SQLite row, so THIS one is snake_case while
      // every other answer on the page is camelCase. Reading run.decisionsCreated here
      // renders undefined; that trap is documented in the API contract.
      const run = r.run;
      const failed = run.status === "failed";

      return answer({
        value: count(run.decisions_created),
        unit: run.decisions_created === 1 ? "decision was created" : "decisions were created",
        sentence: failed
          ? "The run did not finish. The figures below are as far as it got."
          : `It looked at ${count(run.accounts)} accounts and updated ${count(run.decisions_updated)} existing decisions.`,
        definition:
          "One analysis run reads every account, computes signals, turns the ones over threshold into situations, and asks the model about at most maxReasonedPerRun of them. A decision is created only when a situation has no matching record already.",
        tone: failed ? "danger" : "plain",
        evidence: [
          ["Route", "decisionsRunStatus with no id, which returns the latest run"],
          ["Run id", run.id ?? "—"],
          ["Status", run.status ?? "—"],
          ["Started", whenText(ctx, run.started_at) || "—"],
          ["Finished", run.finished_at ? whenText(ctx, run.finished_at) : "did not finish"],
          ["Model", run.model ?? "none — rules only"],
          ...(failed ? [["Error", String(run.error ?? "no message stored")]] : []),
        ],
        facts: [
          ["Accounts read", count(run.accounts)],
          ["Signals computed", count(run.signals)],
          ["Situations found", count(run.candidates)],
          ["Sent to the model", count(run.reasoned)],
          ["Answered from cache", count(run.cached)],
          ["Decisions created", count(run.decisions_created)],
          ["Decisions updated", count(run.decisions_updated)],
          ["Dropped as not actionable", count(run.dropped_not_actionable)],
          ["Model calls", count(run.llm_calls)],
          ["Model failures", count(run.llm_failures)],
          ["Input tokens", count(run.input_tokens)],
          ["Output tokens", count(run.output_tokens)],
        ],
        corrections: [],
      });
    },
  },
];

const questionById = (id) => QUESTIONS.find((q) => q.id === id) ?? null;

/* ── matching a typed question to the built-in ones ─────────────────────── */
//
// This ranks SUGGESTIONS and nothing else. It never picks a question and never runs one.
// The moment a fuzzy match is allowed to answer, this screen becomes the thing it was
// built to beat.

const STOP = new Set(
  "a an the is are was were do does did i me my our we us you your what which who whom how many much of in on for to and or with at by from show tell give list all any it its that this".split(
    " ",
  ),
);

const wordsOf = (s) => String(s).toLowerCase().match(/[a-z0-9']+/g) ?? [];

function suggestionsFor(typed) {
  const asked = new Set(wordsOf(typed).filter((w) => w.length > 2 && !STOP.has(w)));
  if (!asked.size) return [];
  const scored = QUESTIONS.map((q) => {
    const bag = new Set([...wordsOf(q.text), ...wordsOf(q.keywords)]);
    let hits = 0;
    for (const w of asked) if (bag.has(w)) hits++;
    return { q, score: hits / asked.size };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => s.q);
}

/* ── the analysis run, shared by several remedies ───────────────────────── */

/**
 * Start decisionsRun and poll decisionsRunStatus until it stops. The run holds a
 * workspace lock and can take minutes, so the caller gets a live phase line rather than a
 * frozen button.
 */
async function runAnalysis(ctx, line, isStale) {
  let finished = false;
  line.textContent = "Starting the analysis…";

  const started = ctx
    .api("decisionsRun", { method: "POST" })
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));

  (async () => {
    while (!finished && !isStale()) {
      await sleep(1500);
      if (finished || isStale()) return;
      const s = await ctx.api("decisionsRunStatus").catch(() => null);
      const p = s?.run?.progress;
      if (!p) continue;
      const of = p.of ? ` — ${count(p.reasoned)}/${count(p.of)} reasoned` : "";
      line.textContent = `Analysing: ${p.phase}${of}`;
    }
  })();

  const r = await started;
  finished = true;
  return r;
}

/* ── the correction control ─────────────────────────────────────────────── */
//
// This is the competitive claim made physical. The competitor's answer to a wrong number
// is "go and write better custom instructions" — a different screen, a prose blob, no
// stated link between what you type there and the number that was wrong.
//
// Here the panel opens under the number it belongs to, names the definitions that number
// depends on, and writes the editable ones through decisionsSettingsSet.
//
// ⚠️ decisionsSettingsSet REPLACES settings.thresholds wholesale rather than merging, so
// every save sends the existing overrides plus the edit. Sending only the changed key
// would silently reset the other two to their shipped defaults.

function correctionPanel(ctx, env, ans, onRerun, isStale) {
  const panel = el("div", "panel ak-fix");
  panel.append(el("h4", null, "Which definition made this number?"));

  const relevant = new Set(ans.corrections ?? []);
  const rows = env.thresholds ?? [];

  if (env.settingsError) {
    const e = el("div", "err");
    e.append(el("strong", null, "The definitions could not be read. "));
    e.append(document.createTextNode("Nothing here can be edited until that call works."));
    e.append(el("code", null, env.settingsError));
    panel.append(e);
    return panel;
  }

  panel.append(
    el(
      "p",
      "ak-dim",
      relevant.size
        ? "The highlighted rows are the ones this answer depends on. Change one and the next analysis run uses the new value."
        : "This answer does not depend on a threshold. It is built from statuses, dates and owners, which people set by hand. The thresholds below are shown so you can see that.",
    ),
  );

  // Only the rows the person actually changes are sent, so an untouched threshold keeps
  // whatever it had — including "no override at all", which is not the same as an
  // override that happens to equal the shipped value.
  const edits = new Map();

  for (const t of rows) {
    const row = el("div", `ak-fix-row${relevant.has(t.id) ? " used" : ""}`);

    const left = el("div", "ak-fix-label");
    left.append(el("div", "ak-fix-name", t.label ?? t.id));
    left.append(el("div", "ak-dim", t.help ?? ""));
    if (relevant.has(t.id)) left.append(el("span", "chip accent", "used by this answer"));
    row.append(left);

    const right = el("div", "ak-fix-input");
    const input = el("input", "ak-input");
    input.type = "number";
    input.value = String(t.current);
    input.step = "1";
    input.setAttribute("aria-label", `${t.label ?? t.id} in ${t.unit ?? ""}`);
    input.oninput = () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v !== Number(t.current)) edits.set(t.id, v);
      else edits.delete(t.id);
      save.disabled = edits.size === 0 && !seatChanged();
    };
    right.append(input, el("span", "ak-dim", t.unit ?? ""));
    right.append(el("span", "ak-dim", `shipped: ${count(t.shipped)}`));
    row.append(right);

    panel.append(row);
  }

  // Money answers also lean on the seat price, which is a plain setting rather than a
  // threshold. It is shown only where it can actually move the number.
  let seatInput = null;
  const seatWas = env.settings?.seatPriceMonthly ?? null;
  if (ans.usesSeatPrice) {
    const row = el("div", "ak-fix-row used");
    const left = el("div", "ak-fix-label");
    left.append(el("div", "ak-fix-name", "Seat price per month"));
    left.append(
      el("div", "ak-dim", "Used to turn a seat count into money when an impact figure is estimated from seats."),
    );
    left.append(el("span", "chip accent", "used by this answer"));
    row.append(left);

    const right = el("div", "ak-fix-input");
    seatInput = el("input", "ak-input");
    seatInput.type = "number";
    seatInput.value = seatWas == null ? "" : String(seatWas);
    seatInput.placeholder = "not set";
    seatInput.setAttribute("aria-label", "Seat price per month");
    seatInput.oninput = () => {
      save.disabled = edits.size === 0 && !seatChanged();
    };
    right.append(seatInput, el("span", "ak-dim", env.settings?.currency ?? ""));
    row.append(right);
    panel.append(row);
  }

  const seatChanged = () => {
    if (!seatInput) return false;
    const v = seatInput.value.trim();
    if (v === "") return false;
    return Number.isFinite(Number(v)) && Number(v) !== Number(seatWas);
  };

  // The definitions nobody can edit still get said out loud. A definition you cannot see
  // is the one that makes a number look wrong for no reason.
  const fixedDefs = el("div", "ak-fix-fixed");
  fixedDefs.append(el("span", "col-head", "Set in the rules file, not here"));
  for (const line of [
    "Severity bands (critical / high / medium) and which signals exist at all.",
    "Overdue, waiting and snoozed, which are read from a decision's own dates and status.",
    "Stale data, which fires when an account's usage records stop before the as-of date.",
  ]) {
    fixedDefs.append(el("div", "ak-dim", "· " + line));
  }
  panel.append(fixedDefs);

  const foot = el("div", "ak-row");
  const outcome = el("div", "ak-runline");

  const save = busyButton("Save the definition", "Saving…", "btn btn-primary", async () => {
    outcome.replaceChildren();
    const body = {};
    if (edits.size) {
      // Existing overrides first, then this edit, because the whole object is replaced.
      body.thresholds = { ...(env.settings?.thresholds ?? {}) };
      for (const [k, v] of edits) body.thresholds[k] = v;
    }
    if (seatChanged()) body.seatPriceMonthly = Number(seatInput.value);
    if (!Object.keys(body).length) return;

    let r;
    try {
      r = await ctx.api("decisionsSettingsSet", { method: "POST", body });
    } catch (err) {
      r = { ok: false, error: String(err?.message ?? err) };
    }
    if (isStale()) return;

    if (!r?.ok) {
      const e = el("div", "err");
      e.append(el("strong", null, "The definition was not saved. "));
      e.append(el("code", null, r?.error ?? "no reason given"));
      outcome.append(e);
      return;
    }

    // decisionsSettingsSet returns the merged settings but not the threshold rows, so the
    // rows are recomputed from it: current = override if there is one, else shipped.
    env.settings = r.settings ?? env.settings;
    env.thresholds = (env.thresholds ?? []).map((t) => ({
      ...t,
      current: Number.isFinite(Number(env.settings?.thresholds?.[t.id]))
        ? Number(env.settings.thresholds[t.id])
        : t.shipped,
    }));
    edits.clear();
    save.disabled = true;

    const done = el("div", "ak-saved");
    done.append(
      el(
        "p",
        null,
        "Saved. The answer above was worked out with the old definition. Thresholds change what the NEXT analysis run finds — they do not rewrite decisions that already exist.",
      ),
    );
    const line = el("div", "ak-runline");
    const row = el("div", "ak-row");
    row.append(
      busyButton("Run the analysis now", "Analysing…", "btn", async () => {
        const out = await runAnalysis(ctx, line, isStale);
        if (isStale()) return;
        if (!out?.ok) line.textContent = out?.error ?? "the analysis could not be started";
        else {
          line.textContent = "";
          await onRerun();
        }
      }),
    );
    row.append(button("Ask the question again", "btn ghost", () => onRerun()));
    done.append(row, line);
    outcome.append(done);
  });
  save.disabled = true;

  foot.append(save);
  panel.append(foot, outcome);
  return panel;
}

/* ── "so what" — turning an answer into work ────────────────────────────── */

/**
 * Honest about the one thing it cannot do. There is no route that creates a decision from
 * a question; decisions come from the analysis run. So this says that, points at the
 * records that already exist, and offers the run.
 */
function decisionPanel(ctx, ans, isStale) {
  const panel = el("div", "panel ak-fix");
  panel.append(el("h4", null, "Turn this into work"));
  panel.append(
    el(
      "p",
      "ak-dim",
      "Vireo does not create a decision straight from a question. Decisions are written by the analysis run, which checks every account against the rules — so a decision always has evidence behind it rather than a sentence someone typed.",
    ),
  );

  const rows = ans.records?.rows ?? [];
  if (rows.length) {
    panel.append(
      el(
        "p",
        null,
        `The ${count(Math.min(rows.length, RECORD_CAP))} records above are already links. Open one to give it an owner, a due date or a next step.`,
      ),
    );
  }

  const line = el("div", "ak-runline");
  const row = el("div", "ak-row");
  row.append(
    busyButton("Run the analysis", "Analysing…", "btn", async () => {
      const out = await runAnalysis(ctx, line, isStale);
      if (isStale()) return;
      line.textContent = out?.ok ? "Done. Ask the question again to see the new records." : (out?.error ?? "the analysis could not be started");
    }),
  );
  row.append(button("Open the decisions list", "btn ghost", () => ctx.go("decisions")));
  panel.append(row, line);
  return panel;
}

/* ── rendering a result ─────────────────────────────────────────────────── */

function evidenceBlock(pairs) {
  const wrap = el("div", "ak-evidence");
  wrap.append(el("span", "col-head", "How this was worked out"));
  const grid = el("div", "ak-kv");
  for (const [k, v] of pairs) {
    grid.append(el("div", "ak-k", k));
    grid.append(el("div", "ak-v", String(v)));
  }
  wrap.append(grid);
  return wrap;
}

function factsBlock(pairs) {
  const wrap = el("div", "ak-facts");
  for (const [k, v] of pairs) {
    const cell = el("div", "ak-fact");
    cell.append(el("div", "ak-fact-n", String(v)));
    cell.append(el("div", "ak-fact-k", k));
    wrap.append(cell);
  }
  return wrap;
}

/** The answered case. Evidence and records are inline — never behind a disclosure. */
function answerCard(ctx, q, ans, handlers) {
  const card = el("div", `panel ak-answer ${ans.tone === "danger" ? "bad" : ans.tone === "warn" ? "warn" : ""}`);

  const head = el("div", "ak-answer-head");
  head.append(el("div", "ak-q", q.text));
  const tools = el("div", "ak-row");
  tools.append(button("Save this question", "btn tiny ghost", () => handlers.save(q)));
  tools.append(button("Ask again", "btn tiny ghost", () => handlers.rerun()));
  head.append(tools);
  card.append(head);

  // The headline and the correction control are one row, on purpose: the fix for a wrong
  // number should never be somewhere else on the screen.
  const line = el("div", "ak-headline");
  line.append(el("b", "ak-value", String(ans.value)));
  line.append(el("span", "ak-unit", ans.unit ?? ""));
  const fixBtn = button("Wrong?", "btn tiny", () => handlers.toggleFix());
  fixBtn.title = "See and change the definition this number came from";
  line.append(fixBtn);
  card.append(line);

  if (ans.sentence) card.append(el("p", "ak-sentence", ans.sentence));

  const def = el("div", "ak-def");
  def.append(el("span", "col-head", "What this counts"));
  def.append(el("p", null, ans.definition ?? ""));
  card.append(def);

  if (ans.facts?.length) card.append(factsBlock(ans.facts));
  if (ans.evidence?.length) card.append(evidenceBlock(ans.evidence));
  if (ans.records) card.append(recordsTable(ctx, ans.records));

  const foot = el("div", "ak-row ak-foot");
  foot.append(button("Turn this into work", "btn tiny ghost", () => handlers.toggleWork()));
  card.append(foot);

  return card;
}

/** The refusal case. Its own card, its own wording, its own next step. */
function refusalCard(ctx, q, ref, handlers) {
  const card = el("div", "panel ak-answer refused");

  const head = el("div", "ak-answer-head");
  head.append(el("div", "ak-q", q.text));
  const tools = el("div", "ak-row");
  tools.append(button("Save this question", "btn tiny ghost", () => handlers.save(q)));
  tools.append(button("Try again", "btn tiny ghost", () => handlers.rerun()));
  head.append(tools);
  card.append(head);

  const line = el("div", "ak-headline");
  line.append(el("b", "ak-value ak-refused", "No answer"));
  card.append(line);

  card.append(el("p", "ak-sentence", ref.reason));

  if (ref.checked?.length) {
    const wrap = el("div", "ak-evidence");
    wrap.append(el("span", "col-head", "What Vireo checked before refusing"));
    for (const c of ref.checked) wrap.append(el("div", "ak-dim", "· " + c));
    card.append(wrap);
  }

  if (ref.remedies?.length) {
    const wrap = el("div", "ak-evidence");
    wrap.append(el("span", "col-head", "What would make this answerable"));
    const row = el("div", "ak-row");
    const line2 = el("div", "ak-runline");
    for (const rem of ref.remedies) {
      if (rem.kind === "run") {
        row.append(
          busyButton(rem.label, "Analysing…", "btn", async () => {
            const out = await runAnalysis(ctx, line2, handlers.isStale);
            if (handlers.isStale()) return;
            if (!out?.ok) line2.textContent = out?.error ?? "the analysis could not be started";
            else {
              line2.textContent = "";
              await handlers.rerun();
            }
          }),
        );
      } else if (rem.kind === "retry") {
        row.append(button(rem.label, "btn", () => handlers.rerun()));
      } else if (rem.kind === "workspace") {
        row.append(button(rem.label, "btn", () => handlers.reload()));
      } else if (String(rem.kind).startsWith("go:")) {
        row.append(button(rem.label, "btn ghost", () => ctx.go(String(rem.kind).slice(3))));
      }
    }
    wrap.append(row, line2);
    card.append(wrap);
  }

  return card;
}

/**
 * The typed-question case: the stub threw, and this renders the throw.
 *
 * It is deliberately NOT styled as a data refusal. "Vireo looked and could not answer" and
 * "this build cannot take a typed question at all" are different facts, and merging them
 * would hide a missing feature behind an honest-sounding sentence.
 */
function unwiredCard(ctx, typed, err, handlers) {
  const card = el("div", "panel ak-answer unwired");

  const head = el("div", "ak-answer-head");
  head.append(el("div", "ak-q", typed));
  const tools = el("div", "ak-row");
  tools.append(button("Save this question", "btn tiny ghost", () => handlers.saveTyped(typed)));
  head.append(tools);
  card.append(head);

  const line = el("div", "ak-headline");
  line.append(el("b", "ak-value ak-refused", "Not answered"));
  card.append(line);

  card.append(
    el(
      "p",
      "ak-sentence",
      "Typed questions are not answered in this build. Vireo could guess which of its own questions you meant and answer that one instead, but a confident answer to the wrong question is the failure this screen exists to avoid.",
    ),
  );

  const e = el("div", "err");
  e.append(el("strong", null, "Ask engine not wired. "));
  e.append(document.createTextNode("The exact message from the code path your question reached:"));
  e.append(el("code", null, String(err?.message ?? err)));
  card.append(e);

  const near = suggestionsFor(typed);
  const wrap = el("div", "ak-evidence");
  wrap.append(el("span", "col-head", near.length ? "You might mean one of these" : "Questions Vireo can answer"));
  const row = el("div", "ak-row");
  for (const q of near.length ? near : QUESTIONS.slice(0, 4)) {
    row.append(button(q.text, "btn", () => handlers.ask(q)));
  }
  wrap.append(row);
  card.append(wrap);

  return card;
}

/* ── page ───────────────────────────────────────────────────────────────── */

// render() can be called again on the same root while a fetch is in flight. The later
// render wins; every await checks it still owns the screen before touching the DOM.
let epoch = 0;

export async function render(root, ctx) {
  const mine = ++epoch;
  const isStale = () => mine !== epoch;
  const reload = () => render(root, ctx);

  root.replaceChildren(styles(), skeleton());

  // Saved questions live in ctx.state, which is the shell's shared object. There is no
  // route that stores a question in the workspace, and the page says so rather than
  // implying these survive a restart. localStorage would not help: the server listens on a
  // random port per launch, so the origin — and with it the storage — changes every time.
  const store = (ctx.state.ask ??= { saved: [], draft: "" });

  let status, settingsRes;
  try {
    [status, settingsRes] = await Promise.all([ctx.api("decisionsStatus"), ctx.api("decisionsSettingsGet")]);
  } catch (err) {
    if (isStale()) return;
    root.replaceChildren(styles(), errorPanel("Ask could not load", String(err?.message ?? err), reload));
    return;
  }
  if (isStale()) return;

  if (status?.needsWorkspace) {
    root.replaceChildren(
      styles(),
      emptyPanel(
        "No workspace is open",
        "Ask reads the same records as the rest of Vireo, so it needs a workspace with customer data in it.",
        button("Reload", "btn", reload),
      ),
    );
    return;
  }
  if (!status?.ok) {
    root.replaceChildren(
      styles(),
      errorPanel("Ask could not load", `decisionsStatus said: ${status?.error ?? "no reason given"}`, reload),
    );
    return;
  }

  // Settings failing is survivable: the questions still run, only the correction panel is
  // degraded. It records why instead of rendering an empty editor.
  const env = {
    status,
    settings: settingsRes?.ok ? settingsRes.settings : null,
    thresholds: settingsRes?.ok ? (settingsRes.thresholds ?? []) : [],
    settingsError: settingsRes?.ok ? null : `decisionsSettingsGet said: ${settingsRes?.error ?? "no reason given"}`,
  };

  const wrap = el("div", "ak-wrap");
  root.replaceChildren(styles(), wrap);

  /* heading */
  const head = el("div", "ak-head");
  head.append(el("h1", null, "Ask"));
  if (status.asOf) head.append(el("span", "chip", `as of ${status.asOf}`));
  if (status.demoMode) head.append(el("span", "chip", "Demo data"));
  wrap.append(head);
  wrap.append(
    el(
      "p",
      "ak-lede",
      "Every answer here arrives with the records that produced it and the definition it counted by. When Vireo cannot answer, it says so instead of returning a number that looks right.",
    ),
  );

  /* composer */
  const composer = el("div", "panel ak-composer");
  const ta = el("textarea", "ak-ta");
  ta.rows = 2;
  ta.placeholder = "Ask about your customers…";
  ta.value = store.draft ?? "";
  ta.setAttribute("aria-label", "Ask a question about your customers");
  ta.oninput = () => {
    store.draft = ta.value;
    hint.replaceChildren();
  };
  // Enter submits, Shift+Enter makes a new line. A question is one line far more often
  // than it is two.
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      askBtn.click();
    }
  };

  const hint = el("div", "ak-hint");
  const bar = el("div", "ak-bar");
  const askBtn = button("Ask", "btn btn-primary", async () => {
    const typed = ta.value.trim();
    if (!typed) {
      hint.textContent = "Type a question first.";
      return;
    }
    // The stub is the whole typed path. It throws; the throw is what the person sees.
    try {
      await answerTypedQuestion(ctx, typed);
      // Unreachable while the stub throws. If a real route lands, it returns the same
      // shape the built-ins do and goes through the same renderer.
      hint.textContent = "";
    } catch (err) {
      if (isStale()) return;
      showResult(unwiredCard(ctx, typed, err, handlers));
    }
  });
  bar.append(askBtn);
  bar.append(
    el(
      "span",
      "ak-dim",
      "Typed questions are not answered in this build — pick one below to get a real answer with records.",
    ),
  );
  composer.append(ta, bar, hint);
  wrap.append(composer);

  /* result area */
  const resultHost = el("div", "ak-result");
  const fixHost = el("div");
  const workHost = el("div");
  wrap.append(resultHost, fixHost, workHost);

  const idle = () =>
    emptyPanel(
      "Nothing asked yet",
      "Pick one of the questions below. The answer comes back with its evidence, its definition and the records behind it, all on this screen.",
    );
  resultHost.replaceChildren(idle());

  function showResult(node) {
    fixHost.replaceChildren();
    workHost.replaceChildren();
    resultHost.replaceChildren(node);
    resultHost.scrollIntoView({ block: "nearest" });
  }

  /* saved questions, and the handlers every card shares */
  const savedHost = el("div");

  const handlers = {
    isStale,
    reload,
    rerun: () => (current ? ask(current) : null),
    ask: (q) => ask(q),
    save: (q) => {
      if (!store.saved.some((s) => s.id === q.id)) store.saved.push({ id: q.id, text: q.text, answerable: true });
      paintSaved();
    },
    saveTyped: (text) => {
      if (!store.saved.some((s) => s.text === text)) store.saved.push({ id: null, text, answerable: false });
      paintSaved();
    },
    toggleFix: () => {
      if (fixHost.firstChild) return fixHost.replaceChildren();
      workHost.replaceChildren();
      fixHost.replaceChildren(correctionPanel(ctx, env, currentAnswer, () => ask(current), isStale));
      fixHost.scrollIntoView({ block: "nearest" });
    },
    toggleWork: () => {
      if (workHost.firstChild) return workHost.replaceChildren();
      fixHost.replaceChildren();
      workHost.replaceChildren(decisionPanel(ctx, currentAnswer, isStale));
      workHost.scrollIntoView({ block: "nearest" });
    },
  };

  let current = null;
  let currentAnswer = null;

  /** Run one built-in question and render whichever of the two results comes back. */
  async function ask(q) {
    current = q;
    currentAnswer = null;
    fixHost.replaceChildren();
    workHost.replaceChildren();
    resultHost.replaceChildren(askingPanel(q.text));

    let out;
    try {
      out = await q.run(ctx, env);
    } catch (err) {
      // A thrown error is a broken call, not a refusal, and must not be dressed as one.
      if (isStale()) return;
      showResult(
        errorPanel(
          "That question failed on the way to the data",
          `${q.routes.join(", ")} — ${err?.message ?? err}`,
          () => ask(q),
        ),
      );
      return;
    }
    if (isStale()) return;

    if (out.kind === "refusal") {
      showResult(refusalCard(ctx, q, out, handlers));
      return;
    }
    currentAnswer = out;
    showResult(answerCard(ctx, q, out, handlers));
  }

  /* the built-in question list */
  const menu = el("div", "panel ak-menu");
  const menuHead = el("div", "ak-sec-head");
  menuHead.append(el("h3", null, "Questions Vireo can answer with evidence"));
  menuHead.append(el("span", "ak-note", `${QUESTIONS.length} questions, ${countRoutes()} routes`));
  menu.append(menuHead);
  menu.append(
    el(
      "p",
      "ak-dim",
      "Each one runs named routes with named filters. The routes are printed in the answer so you can check the same numbers yourself.",
    ),
  );
  const menuGrid = el("div", "ak-menu-grid");
  for (const q of QUESTIONS) {
    const b = button(q.text, "ak-qbtn", () => ask(q));
    b.append(el("span", "ak-qroutes", q.routes.join(" · ")));
    menuGrid.append(b);
  }
  menu.append(menuGrid);
  wrap.append(menu);

  /* saved */
  wrap.append(savedHost);
  paintSaved();

  function paintSaved() {
    savedHost.replaceChildren();
    if (!store.saved.length) return;

    const panel = el("div", "panel ak-menu");
    const h = el("div", "ak-sec-head");
    h.append(el("h3", null, "Saved questions"));
    h.append(el("span", "ak-note", "kept for this session only — no route stores a question in the workspace"));
    panel.append(h);

    const list = el("div", "ak-saved-list");
    for (const s of store.saved) {
      const row = el("div", "ak-saved-row");
      const q = s.id ? questionById(s.id) : null;
      if (q) {
        row.append(button(s.text, "ak-link", () => ask(q)));
      } else {
        row.append(el("span", null, s.text));
        row.append(el("span", "chip warn", "not answerable yet"));
        row.append(
          button("Put it back in the box", "btn tiny ghost", () => {
            ta.value = s.text;
            store.draft = s.text;
            ta.focus();
          }),
        );
      }
      row.append(el("div", "ak-grow"));
      row.append(
        button("Remove", "btn tiny ghost", () => {
          store.saved = store.saved.filter((x) => x !== s);
          paintSaved();
        }),
      );
      list.append(row);
    }
    panel.append(list);
    savedHost.append(panel);
  }
}

function countRoutes() {
  const set = new Set();
  for (const q of QUESTIONS) for (const r of q.routes) set.add(r);
  return set.size;
}

/* ── the shell states this page draws ───────────────────────────────────── */

function skeleton() {
  const wrap = el("div", "ak-wrap");
  const a = el("div", "skeleton line");
  a.style.width = "160px";
  a.style.height = "26px";
  wrap.append(a);
  const b = el("div", "skeleton block");
  b.style.height = "96px";
  wrap.append(b);
  const c = el("div", "skeleton block");
  c.style.height = "220px";
  wrap.append(c);
  return wrap;
}

function askingPanel(text) {
  const p = el("div", "panel ak-answer");
  p.append(el("div", "ak-q", text));
  const s = el("div", "skeleton line");
  s.style.width = "40%";
  s.style.height = "30px";
  p.append(s);
  p.append(el("div", "skeleton line"));
  p.append(el("div", "skeleton line"));
  return p;
}

function emptyPanel(heading, body, action) {
  const box = el("div", "empty");
  box.append(el("h3", null, heading));
  box.append(el("p", null, body));
  if (action) box.append(action);
  return box;
}

/** Always says WHAT failed, in the server's own words, and always offers the retry. */
function errorPanel(heading, detail, retry) {
  const box = el("div", "err");
  box.append(el("strong", null, heading + ". "));
  box.append(document.createTextNode("No number is shown, because none came back. What failed:"));
  box.append(el("code", null, detail));
  if (retry) box.append(button("Try again", "btn", retry));
  return box;
}

/* ── styles ─────────────────────────────────────────────────────────────── */

// Layout only, prefixed ak-. Everything with a shared look — .panel .btn .chip .pill
// .empty .err .skeleton .col-head — comes from tokens.css and is NOT restated here: this
// <style> loads after it, so a repeated rule would silently win. Tokens only, no literals.
function styles() {
  return el(
    "style",
    null,
    `
.ak-wrap { display:flex; flex-direction:column; gap:var(--s4); padding-bottom:var(--s6); max-width:1080px; }
.ak-row { display:flex; flex-wrap:wrap; gap:var(--s2); align-items:center; }
.ak-grow { flex:1 1 auto; }
.ak-dim { color:var(--muted); font-size:var(--fs-sm); }
.ak-note { color:var(--muted); font-size:var(--fs-xs); }

.ak-head { display:flex; align-items:center; gap:var(--s2); flex-wrap:wrap; }
.ak-lede { margin:calc(var(--s3) * -1) 0 0; color:var(--muted); font-size:var(--fs-sm); max-width:76ch; }

/* composer */
.ak-composer { display:flex; flex-direction:column; gap:var(--s3); }
.ak-ta {
  width:100%; resize:vertical; min-height:56px;
  background:var(--bg); color:var(--text);
  border:1px solid var(--border); border-radius:var(--radius-sm);
  padding:var(--s3); line-height:var(--lh-body);
}
.ak-ta::placeholder { color:var(--muted); }
.ak-ta:focus-visible { outline:2px solid var(--focus); outline-offset:2px; }
.ak-bar { display:flex; align-items:center; gap:var(--s3); flex-wrap:wrap; }
.ak-hint:empty { display:none; }
.ak-hint { color:var(--warn); font-size:var(--fs-sm); }
.ak-input {
  background:var(--bg); color:var(--text); border:1px solid var(--border);
  border-radius:var(--radius-sm); padding:5px 8px; width:96px; font-size:var(--fs-sm);
  font-variant-numeric:tabular-nums;
}

/* the answer card */
.ak-answer { display:flex; flex-direction:column; gap:var(--s3); border-left-width:3px; }
.ak-answer.warn { border-left-color:var(--warn); }
.ak-answer.bad { border-left-color:var(--danger); }
.ak-answer.refused { border-left-color:var(--muted); border-style:dashed; }
.ak-answer.unwired { border-left-color:var(--danger); }
.ak-answer-head { display:flex; align-items:flex-start; gap:var(--s3); }
.ak-q { flex:1 1 auto; font-size:var(--fs-md); font-weight:600; color:var(--text); }

.ak-headline { display:flex; align-items:baseline; gap:var(--s3); flex-wrap:wrap; }
.ak-value { font-size:var(--fs-2xl); font-weight:650; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; line-height:1.1; }
.ak-value.ak-refused { font-size:var(--fs-xl); color:var(--muted); letter-spacing:-0.01em; }
.ak-unit { color:var(--muted); font-size:var(--fs-md); }
.ak-headline .btn { align-self:center; }
.ak-sentence { margin:0; font-size:var(--fs-sm); color:var(--text); max-width:78ch; }

.ak-def { border-top:1px solid var(--border-soft); padding-top:var(--s3); display:flex; flex-direction:column; gap:var(--s1); }
.ak-def p { margin:0; font-size:var(--fs-sm); color:var(--muted); max-width:78ch; }

.ak-evidence { border-top:1px solid var(--border-soft); padding-top:var(--s3); display:flex; flex-direction:column; gap:var(--s2); }
.ak-kv { display:grid; grid-template-columns:minmax(120px, 200px) 1fr; gap:var(--s1) var(--s3); font-size:var(--fs-sm); }
.ak-k { color:var(--muted); }
.ak-v { color:var(--text); word-break:break-word; }

.ak-facts { display:grid; grid-template-columns:repeat(auto-fill, minmax(132px, 1fr)); gap:var(--s2); }
.ak-fact { border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--s2) var(--s3); background:var(--bg); }
.ak-fact-n { font-size:var(--fs-lg); font-weight:600; font-variant-numeric:tabular-nums; }
.ak-fact-k { font-size:var(--fs-xs); color:var(--muted); }

/* records */
.ak-records { border-top:1px solid var(--border-soft); padding-top:var(--s3); display:flex; flex-direction:column; gap:var(--s2); }
.ak-sec-head { display:flex; align-items:baseline; gap:var(--s3); flex-wrap:wrap; }
.ak-scroll { overflow-x:auto; }
.ak-table { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
.ak-table th { text-align:left; padding:4px var(--s3) 4px 0; border-bottom:1px solid var(--border); white-space:nowrap; }
.ak-table td { padding:7px var(--s3) 7px 0; border-bottom:1px solid var(--border-soft); vertical-align:top; }
.ak-table tbody tr:hover td { background:var(--panel-2); }
.ak-cell-dim { color:var(--muted); font-variant-numeric:tabular-nums; }
.ak-link { background:none; border:0; padding:0; color:var(--text); font:inherit; text-align:left;
  text-decoration:underline; text-decoration-color:var(--border); text-underline-offset:2px; }
.ak-link:hover { text-decoration-color:var(--muted); }

.ak-foot { border-top:1px solid var(--border-soft); padding-top:var(--s3); }

/* correction and work panels — .panel supplies the surface; only the accent edge and the
   stacking are new here. */
.ak-fix { border-left-width:3px; border-left-color:var(--accent);
  display:flex; flex-direction:column; gap:var(--s3); }
.ak-fix p { margin:0; }
.ak-fix-row { display:flex; align-items:center; gap:var(--s4); flex-wrap:wrap;
  border:1px solid var(--border-soft); border-radius:var(--radius-sm); padding:var(--s3); }
.ak-fix-row.used { border-color:var(--border); background:var(--bg); }
.ak-fix-label { flex:1 1 320px; min-width:0; display:flex; flex-direction:column; gap:2px; align-items:flex-start; }
.ak-fix-name { font-size:var(--fs-sm); font-weight:600; }
.ak-fix-input { display:flex; align-items:center; gap:var(--s2); }
.ak-fix-fixed { display:flex; flex-direction:column; gap:2px; border-top:1px solid var(--border-soft); padding-top:var(--s3); }
.ak-saved { display:flex; flex-direction:column; gap:var(--s2); border-top:1px solid var(--border-soft); padding-top:var(--s3); }
.ak-saved p { margin:0; font-size:var(--fs-sm); color:var(--text); max-width:78ch; }
.ak-runline:empty { display:none; }
.ak-runline { font-size:var(--fs-sm); color:var(--muted); }

/* the question menu */
.ak-menu { display:flex; flex-direction:column; gap:var(--s3); }
.ak-menu p { margin:0; }
.ak-menu-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(248px, 1fr)); gap:var(--s2); }
.ak-qbtn { display:flex; flex-direction:column; align-items:flex-start; gap:2px; text-align:left;
  background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm);
  padding:var(--s3); color:var(--text); font-size:var(--fs-sm); font-weight:550; }
.ak-qbtn:hover { border-color:var(--muted); }
.ak-qroutes { font-size:var(--fs-xs); font-weight:400; color:var(--muted); font-family:var(--mono); }

.ak-saved-list { display:flex; flex-direction:column; gap:var(--s2); }
.ak-saved-row { display:flex; align-items:center; gap:var(--s2); flex-wrap:wrap;
  border:1px solid var(--border-soft); border-radius:var(--radius-sm); padding:var(--s2) var(--s3); font-size:var(--fs-sm); }
`,
  );
}
