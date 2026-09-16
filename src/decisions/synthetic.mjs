// The demo company: a synthetic SaaS business with planted situations.
//
// WHY GENERATED AND NOT HAND-WRITTEN. It is reproducible from a seed, it can be
// regenerated relative to today so the demo never looks stale, and it is
// written out as CSV and imported through the REAL importer - so the demo
// exercises the same path a customer's own export takes, rather than a
// shortcut that would hide a bug in the only code that matters.
//
// 🔴 THE FALSE-POSITIVE ACCOUNTS ARE THE POINT. Twelve accounts here each cross
// exactly one threshold while being otherwise healthy. If the system raises a
// decision about any of them, it is a threshold-flagger with a language model
// on top, not a decision system. `scenarios.json` records what each account is
// supposed to produce, and the evaluation harness scores against it.
//
// 🔴 EVERY PIECE OF TEXTURE ADDED HERE IS CHECKED AGAINST THE SIGNAL ENGINE
// FIRST. A richer demo is only richer if it plants nothing by accident: an
// extra failed invoice, a second quiet champion or an open urgent ticket on a
// false-positive account would each turn a trap into a decision and destroy the
// one thing this dataset exists to prove. The rules that keep that from
// happening are written at each place they apply, and the test file asserts
// them at the dataset level.
import fs from "node:fs";
import path from "node:path";
import { toCsv } from "../tools/documents.mjs";
import { addDays, dayOf, daysBetween, humanDate, money } from "./format.mjs";
import { titleFor } from "./decisions.mjs";
import { actionLabel, rules } from "./rules.mjs";
import { computeSignals } from "./signals.mjs";
import { situationsFor } from "./situations.mjs";
import { getSettings, tx } from "./db.mjs";

/** mulberry32: tiny, seedable, and good enough for fake usage curves. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one item, deterministically, from the shared stream. */
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
/** An integer in [lo, hi], inclusive. */
const between = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// --- the vocabulary a real customer list is made of --------------------------
// Names are assembled rather than listed so 150 customers can all be different
// without a 150-line array. The tail is chosen from the account's industry, so
// "Tidewater Freight" is in logistics and "Alderbrook Diagnostics" is not.
const STEMS = [
  "Alderbrook", "Ashgrove", "Beacon", "Bellweather", "Blackthorn", "Bluecrest", "Bridgeport", "Brightwater",
  "Cardinal", "Castlegate", "Cedarline", "Clearfield", "Copperline", "Cranmore", "Crosswind", "Dunmore",
  "Eastgate", "Elmridge", "Fairhaven", "Falconry", "Fernwood", "Foxglove", "Glenmore", "Granite Bay",
  "Greystone", "Halcyon", "Harborview", "Hawthorne", "Highfield", "Hollowell", "Ironwood", "Kestrel",
  "Lakemont", "Larkspur", "Linden", "Longmeadow", "Lumen", "Maplecourt", "Marlowe", "Meridian",
  "Millbrook", "Northwind", "Oakhurst", "Orchid", "Pinnacle", "Quarrystone", "Ravenswood", "Redwood Park",
  "Riverbend", "Sablepoint", "Saltmarsh", "Silverbirch", "Southbank", "Stonebridge", "Summit Row", "Tealwood",
  "Thornbury", "Tidewater", "Vantage", "Wardley", "Westmoor", "Whitfield", "Willowbank", "Wrenfield",
];
const TAILS = {
  logistics: ["Freight", "Logistics", "Haulage", "Distribution", "Supply Co"],
  healthcare: ["Health", "Medical Group", "Diagnostics", "Care Partners", "Clinics"],
  retail: ["Retail Group", "Stores", "Markets", "Trading Co", "Home"],
  fintech: ["Capital", "Financial", "Payments", "Lending", "Treasury"],
  education: ["Academy", "Learning", "Institute", "Education Trust", "Colleges"],
  media: ["Media", "Studios", "Publishing", "Broadcast", "Press"],
  manufacturing: ["Manufacturing", "Industries", "Works", "Fabrication", "Tooling"],
  travel: ["Travel", "Holidays", "Tours", "Hospitality", "Coaches"],
};
const LEGAL = ["", "", "", " Inc.", " LLC", " Ltd", " Group", " Holdings"];

const PEOPLE_FIRST = [
  "Aaron", "Aisha", "Amara", "Anita", "Ben", "Bianca", "Callum", "Carmen", "Chen", "Clara", "Damian", "Daniela",
  "Dev", "Elena", "Emeka", "Farah", "Felix", "Gabriel", "Grace", "Hannah", "Hugo", "Imani", "Ines", "Isaac",
  "Jana", "Joon", "Kai", "Karim", "Laura", "Leo", "Maia", "Marcus", "Mei", "Nadia", "Nikhil", "Nora",
  "Omar", "Priya", "Rafael", "Rhea", "Rosa", "Sam", "Sofia", "Tariq", "Theo", "Vera", "Yusuf", "Zoe",
];
const PEOPLE_LAST = [
  "Abara", "Ahmed", "Bauer", "Bennett", "Bianchi", "Boateng", "Chen", "Costa", "Delacroix", "Duarte", "Ellis",
  "Fitzgerald", "Fontaine", "Garcia", "Grant", "Haddad", "Hoffman", "Ibarra", "Jensen", "Kaur", "Keller",
  "Kovac", "Lindqvist", "Marsh", "Mbeki", "Mehta", "Novak", "Okafor", "Oyelaran", "Petrov", "Quinn", "Rossi",
  "Santos", "Schneider", "Silva", "Tanaka", "Thorne", "Vargas", "Walsh", "Yamamoto",
];

/** The champion is always a decision maker; the rest are the working contacts. */
const CHAMPION_ROLES = ["VP Operations", "Head of Support", "Director of Engineering", "COO", "Head of Product", "IT Director", "Head of Customer Service", "Chief of Staff"];
const OTHER_ROLES = ["Billing", "Operations Analyst", "Support Lead", "Workspace Admin", "Procurement", "Data Analyst", "Team Lead", "Project Manager"];

const INDUSTRIES = ["logistics", "healthcare", "retail", "fintech", "education", "media", "manufacturing", "travel"];
const SEGMENTS = ["enterprise", "mid-market", "small business"];
const PLANS = ["Starter", "Team", "Business"];
const OWNERS = ["Sam Rivera", "Jo Bennett", "Alex Chen", "Priya Nair", "Marco Feliu", "Dana Okonkwo"];

/** Real support topics, so the tickets read like a help desk export. */
const TICKET_SUBJECTS = [
  "CSV export times out on large date ranges",
  "SSO login loops after a password reset",
  "API rate limit hit during the nightly sync",
  "Invoice PDF shows the old billing address",
  "Webhook retries are duplicating records",
  "Reports page is slow for the operations team",
  "Cannot remove a user from the workspace",
  "Data import rejected 400 rows without saying why",
  "Two-factor codes arrive several minutes late",
  "Scheduled report did not send on Monday",
  "Permission change did not apply to the sub-team",
  "Mobile app crashes on the reports tab",
  "Timezone is wrong on the weekly summary",
  "Bulk edit undo does not restore custom fields",
  "Search misses records with accented names",
  "Seat count in billing does not match the admin page",
  "Sandbox environment is out of date",
  "Audit log stops at 1,000 entries",
];
const URGENT_SUBJECTS = [
  "Production sync has been down since this morning",
  "No one on the operations team can log in",
  "Overnight export failed three nights running",
];

/**
 * Events that tell the account's story. None of these kinds is read by the
 * signal engine.
 *
 * ⚠️ THE ENGINE READS EXACTLY THREE EVENT KINDS: `pricing_page_view`,
 * `seat_limit_hit` and `champion_left`. Those three are planted deliberately,
 * per scenario, further down. Nothing in this list may use those strings, or a
 * "nice bit of colour" becomes a signal on an account that was meant to be
 * quiet.
 */
const STORY_EVENTS = [
  { kind: "onboarding_completed", detail: "Rollout finished for the first two teams." },
  { kind: "qbr_held", detail: "Quarterly business review with the operations team." },
  { kind: "integration_connected", detail: "Connected the Salesforce integration." },
  { kind: "integration_connected", detail: "Connected the Slack integration." },
  { kind: "feature_adopted", detail: "Started using scheduled reports." },
  { kind: "feature_adopted", detail: "Started using the approvals workflow." },
  { kind: "training_session", detail: "Admin training for a new group of users." },
  { kind: "nps_response", detail: "NPS 9: saves the team about a day a week." },
  { kind: "nps_response", detail: "NPS 7: likes the product, finds reporting hard." },
  { kind: "nps_response", detail: "NPS 4: reporting is hard to use." },
  { kind: "support_survey", detail: "Support rated 5 out of 5 after a ticket." },
  { kind: "webinar_attended", detail: "Two people attended the product webinar." },
  { kind: "renewal_signed", detail: "Signed a twelve month renewal." },
  { kind: "team_added", detail: "A second department started using the workspace." },
];

/**
 * Scenario mix. Each `count` is a BASE count, multiplied by the dataset's
 * `scale`, so the proportions - and above all the ratio of traps to real
 * situations - are identical at every size. The default demo is scale 3.
 * `expect` is what the evaluation harness scores the system against.
 */
const MIX = [
  { scenario: "healthy", count: 28, expect: { kind: null } },
  { scenario: "churn_clear", count: 4, expect: { kind: "churn_risk", minSeverity: "high" } },
  { scenario: "churn_subtle", count: 2, expect: { kind: "churn_risk", minSeverity: "medium" } },
  { scenario: "expansion", count: 3, expect: { kind: "expansion", minSeverity: "low" } },
  { scenario: "payment", count: 3, expect: { kind: "payment_risk", minSeverity: "medium" } },
  { scenario: "fp_ticket_spike", count: 1, expect: { kind: null } },
  { scenario: "fp_brief_dip", count: 1, expect: { kind: null } },
  { scenario: "fp_renewal_only", count: 1, expect: { kind: null } },
  { scenario: "fp_champion_quiet", count: 1, expect: { kind: null } },
  { scenario: "dismissed_unchanged", count: 1, expect: { kind: "churn_risk", suppressed: true } },
  { scenario: "dismissed_worse", count: 1, expect: { kind: "churn_risk", minSeverity: "high" } },
  { scenario: "stale_data", count: 1, expect: { kind: null } },
  { scenario: "healthy", count: 1, expect: { kind: null } },
];

/** The hard-cases-only dataset: near misses and subtle risk, nothing obvious. */
const EDGE_MIX = [
  { scenario: "healthy", count: 8, expect: { kind: null } },
  { scenario: "churn_subtle", count: 4, expect: { kind: "churn_risk", minSeverity: "medium" } },
  { scenario: "fp_ticket_spike", count: 2, expect: { kind: null } },
  { scenario: "fp_brief_dip", count: 2, expect: { kind: null } },
  { scenario: "fp_renewal_only", count: 2, expect: { kind: null } },
  { scenario: "fp_champion_quiet", count: 2, expect: { kind: null } },
];

/** How many accounts a mix produces at a given scale. */
const sizeOf = (mix, scale) => mix.reduce((n, row) => n + row.count * scale, 0);

/**
 * 🔴 TWO SIZES, AND THE DIFFERENCE IS DELIBERATE.
 *
 * `variant()` builds the SHIPPED demo: 144 customers and a year of daily usage,
 * which is what an investor sees and what `decisionsSeedDemo` seeds. A bare
 * `generate()` builds the FIXTURE size: one of everything in the mix and four
 * months, which is what the engine's own tests use.
 *
 * They are separate because a fixture is not a demo. Every test that needs a
 * workspace pays for the dataset it asks for, and at demo size one test file
 * went from 3 seconds to 36 - for 96 extra customers that prove nothing the
 * first 48 did not. Measured 2026-09-17. Four months is the smallest span that
 * still contains both 30-day windows, the recovered dip at day -52 and enough
 * history either side to look like data.
 */
const DEFAULT_SCALE = 1;
const DEFAULT_DAYS = 120;
const DEMO_SCALE = 3;
const DEMO_DAYS = 365;

/**
 * How the last 30 days compare with the 30 before them, per scenario.
 *
 * 🔴 THIS IS A RATIO OF WINDOW MEANS, NOT A SLOPE, and the difference is the
 * bug this table exists to prevent. The first version of this generator ramped
 * a decline across the whole 30-day window: "down 50%" by the last day, which
 * is only **-24% on the mean** - just under the -25% threshold. Every planted
 * churn account produced its renewal, ticket and champion signals and no usage
 * signal, so the churn rule (which requires usage) never fired and the demo
 * data quietly proved nothing. Measured 2026-09-09.
 *
 * Stating the ratio the SIGNAL will measure keeps the dataset honest about what
 * it is planting.
 *
 * WHAT THE SIGNAL ACTUALLY MEASURES, over all 144 customers and all seven
 * possible as-of weekdays (measured 2026-09-17, and asserted in
 * tests/unit/decisions-demo.test.mjs):
 *
 *   healthy      +10% .. +17%   churn_clear  -50% .. -44%
 *   churn_subtle -31% .. -27%   expansion    +76% .. +85%
 *   payment      -19% .. -15%   dismissed_worse -62% .. -59%
 *
 * The gap between the stated ratio and the measured one is the 4-day ramp: it
 * sits inside the recent window and lifts its mean, so 0.70 measures as about
 * -28.5% rather than -30%. churn_subtle therefore clears the -25% threshold by
 * only 2 points, and it is the entry to check first if anything here is ever
 * retuned.
 */
const RATIO = {
  healthy: 1.14,
  churn_clear: 0.5, // -50%: band 2
  churn_subtle: 0.7, // -30%: band 1, and nothing else dramatic
  expansion: 1.85, // +85%: band 2
  payment: 0.82, // -18%: deliberately ABOVE the churn threshold, so payment_risk stands alone
  fp_ticket_spike: 1.05,
  fp_brief_dip: 1.0, // the dip is inserted below and has recovered
  fp_renewal_only: 1.1,
  fp_champion_quiet: 1.25,
  dismissed_unchanged: 0.62, // -38%, the same as when it was dismissed
  // -70%: band 3, clearly worse than when it was dismissed.
  // ⚠️ 0.30, NOT THE 0.36 THIS STARTED AT. The 4-day ramp lifts the recent
  // mean, so 0.36 measured between -64% and -59% depending on the account and
  // the as-of weekday - straddling the -60% band-3 boundary. Planted data must
  // not sit ON a threshold: the scenario says "band 3" and it was band 3 about
  // half the time. Measured 2026-09-17.
  dismissed_worse: 0.3,
  stale_data: 1.0,
};

/**
 * Weekday multipliers, Sunday first, summing to exactly 7 so a whole week
 * averages to 1. A B2B tool is quiet at the weekend and a flat line for 365
 * days looks like a test fixture rather than a business.
 *
 * ⚠️ IT BIASES THE TWO WINDOWS THE SIGNAL COMPARES, AND THE SIZE OF THAT BIAS
 * IS WHY THESE NUMBERS ARE SHALLOW. A 30-day window is four whole weeks plus
 * two days, so the recent window and the baseline window contain a different
 * pair of extra weekdays. Worst case the two means differ by
 * (2.13 - 1.70) / 30 = 1.4% before any real change - which every entry in RATIO
 * clears by at least 3 points. Deepen the weekend and you eat that margin:
 * fp_champion_quiet at 1.25 would drift towards the +30% rise threshold and
 * start raising an expansion it was planted not to raise. The test file checks
 * the measured ratio for all seven possible as-of weekdays.
 */
const WEEKDAY = [0.85, 1.06, 1.07, 1.06, 1.06, 1.05, 0.85];

/** How many days at the end of the history the two comparison windows cover. */
const WINDOW_TAIL = 60;

/**
 * The daily active-user curve for one scenario, ending at `asOf`.
 *
 * The last 30 days sit at `base * ratio`, the 30 before them at `base`, with a
 * short ramp at the boundary so the line looks like a business rather than a
 * step function. Everything OLDER than those 60 days carries the twelve-month
 * story: a growth trend from the account's first day, and sometimes a seasonal
 * lull.
 *
 * 🔴 THE TREND STOPS DEAD AT `days - WINDOW_TAIL`. Both windows the signal
 * compares must sit at exactly `base` and `base * ratio`, or the RATIO table
 * above stops describing what the signal will measure - which is the whole bug
 * that table exists to prevent. A twelve-month chart that drifts through the
 * comparison windows would move every planted change by an unknown amount.
 */
function usageCurve({ scenario, base, days, rand, cohort, firstIndex, startShare, dip, weekdayOfFirstDay }) {
  let ratio = RATIO[scenario] ?? 1;
  // The company-wide variant: everyone's recent window drops by the same amount,
  // healthy accounts included. Each account then shows the usage signal while
  // its own score stays below the churn threshold - which is the whole point:
  // one company-wide decision, not thirty individual ones.
  //
  // ⚠️ 0.6, NOT THE 0.65 THIS STARTED AT. Cohort detection needs the usage
  // signal to actually fire on the healthy accounts: 1.14 x 0.65 = -25.9%,
  // which is 0.9 points from the -25% threshold and INSIDE the 1.4% the weekly
  // pattern can move a 30-day mean. On some as-of weekdays the drop would have
  // measured -24.8%, no account would have fired, and the company-wide variant
  // would have quietly become the ordinary one. 1.14 x 0.6 = -31.6%, which is
  // clear of the threshold and still short of band 2 at -40%.
  if (cohort) ratio *= 0.6;

  const out = [];
  const rampDays = 4;
  const trendEnd = days - WINDOW_TAIL;
  const trendSpan = Math.max(1, trendEnd - firstIndex);

  for (let dayIndex = 0; dayIndex < days; dayIndex++) {
    let level;
    const intoWindow = dayIndex - (days - 30);
    if (intoWindow < 0) {
      level = base; // the baseline window and everything older
    } else if (intoWindow < rampDays) {
      level = base * (1 + (ratio - 1) * ((intoWindow + 1) / rampDays));
    } else {
      level = base * ratio;
    }

    // The twelve-month story, applied ONLY before the comparison windows.
    if (dayIndex < trendEnd) {
      const t = Math.min(1, Math.max(0, (dayIndex - firstIndex) / trendSpan));
      const eased = t * (2 - t); // fast at first, flattening out: a rollout
      level = base * (startShare + (1 - startShare) * eased);
      if (dip && dayIndex >= dip.from && dayIndex < dip.from + dip.length) level *= dip.depth;
    }

    // A dip that RECOVERED: down hard a month ago, normal now. It sits in the
    // BASELINE window, so both 30-day means barely move and nothing fires.
    if (scenario === "fp_brief_dip" && dayIndex >= days - 52 && dayIndex <= days - 45) level = base * 0.45;

    const weekday = WEEKDAY[(weekdayOfFirstDay + dayIndex) % 7];
    const noise = 1 + (rand() - 0.5) * 0.1;
    out.push(Math.max(0, Math.round(level * weekday * noise)));
  }
  return out;
}

/**
 * Generate the dataset in memory.
 * @param {{seed?: number, scale?: number, days?: number, asOf?: string, cohort?: boolean, variant?: string}} opts
 */
export function generate(opts = {}) {
  const seed = opts.seed ?? 20260909;
  const rand = rng(seed);
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const days = opts.days ?? DEFAULT_DAYS;
  const cohort = opts.cohort === true;
  const isEdge = opts.variant === "edge";
  const scale = Math.max(1, Math.round(opts.scale ?? DEFAULT_SCALE));
  const mix = isEdge ? EDGE_MIX : MIX;

  const plan = [];
  for (const row of mix) for (let i = 0; i < row.count * scale; i++) plan.push(row);

  // Every account shares one list of day strings and one weekday phase: the
  // dates are the same for all of them, and building 50,000 Date objects per
  // account instead of once is most of what a year of daily usage would cost.
  const dayStrings = [];
  for (let k = 0; k < days; k++) dayStrings.push(addDays(asOf, -(days - 1 - k)));
  const weekdayOfFirstDay = new Date(dayStrings[0] + "T00:00:00Z").getUTCDay();

  const accounts = [];
  const usage = [];
  const contacts = [];
  const tickets = [];
  const invoices = [];
  const events = [];
  const scenarios = [];
  const usedNames = new Set();

  plan.forEach((entry, i) => {
    const id = `ACC-${String(i + 1).padStart(3, "0")}`;
    const { scenario } = entry;
    const industry = pick(rand, INDUSTRIES);

    // A different name for every customer: a list that repeats reads as a bug.
    let name = "";
    for (let attempt = 0; attempt < 12 && !name; attempt++) {
      const candidate = `${pick(rand, STEMS)} ${pick(rand, TAILS[industry])}${pick(rand, LEGAL)}`;
      if (!usedNames.has(candidate)) name = candidate;
    }
    if (!name) name = `${pick(rand, STEMS)} ${pick(rand, TAILS[industry])} ${id}`;
    usedNames.add(name);

    // ARR on a log-normal-ish spread: a few big accounts, many small ones.
    //
    // 🔴 THE FLOOR IS A MEASUREMENT PROBLEM, NOT A TASTE ONE. Seats come from
    // ARR and the daily active-user count comes from seats, so a $8,500 account
    // used to produce a curve of 3 or 4 users a day - and a 30-day mean of
    // three-ish integers cannot express a 30% fall. Measured 2026-09-17 at the
    // old floor: churn_subtle was planted at -30% and the six accounts measured
    // anywhere from -32% to -20%, so two of them fell the wrong side of the
    // -25% threshold and raised nothing. The dataset said it had planted six
    // subtle churn risks and had planted four. Rounding noise scales with 1/base.
    const arr = Math.round((18000 + Math.exp(rand() * 3.6) * 4200) / 500) * 500;
    const seats = Math.max(5, Math.round(arr / 1400));
    const planName = arr > 90000 ? PLANS[2] : arr > 30000 ? PLANS[1] : PLANS[0];
    // Segment follows the money, the way a real CRM's does. A $150k "small
    // business" is the sort of detail that makes a demo audience stop listening.
    const segment = arr > 90000 ? SEGMENTS[0] : arr > 30000 ? SEGMENTS[1] : SEGMENTS[2];

    // Most customers are established; a few joined this quarter, so the
    // "New" lifecycle label has someone to point at. Only healthy accounts are
    // ever made new: a short history means the baseline window is incomplete,
    // and a planted change would then measure nothing.
    const isNewCustomer = scenario === "healthy" && rand() < 0.07;
    const tenure = isNewCustomer ? between(rand, 34, 88) : 120 + Math.floor(rand() * 900);
    const createdAt = addDays(asOf, -tenure);

    // Renewal timing carries the scenario: churn accounts renew soon, healthy
    // ones do not, and fp_renewal_only renews soon while being perfectly well.
    let renewalIn;
    if (scenario === "churn_clear") renewalIn = 20 + Math.floor(rand() * 30);
    else if (scenario === "churn_subtle") renewalIn = 60 + Math.floor(rand() * 25);
    else if (scenario === "fp_renewal_only") renewalIn = 18;
    else if (scenario === "dismissed_unchanged" || scenario === "dismissed_worse") renewalIn = 35 + Math.floor(rand() * 20);
    else renewalIn = 120 + Math.floor(rand() * 240);

    accounts.push({
      account_id: id,
      name,
      arr,
      plan: planName,
      seats_purchased: seats,
      renewal_date: addDays(asOf, renewalIn),
      owner: rand() < 0.82 ? pick(rand, OWNERS) : "",
      segment,
      industry,
      created_at: createdAt,
    });

    // --- usage ---------------------------------------------------------------
    const base = Math.max(3, Math.round(seats * (0.45 + rand() * 0.3)));
    const firstIndex = Math.max(0, days - tenure);
    const startShare = 0.5 + rand() * 0.4; // where the twelve months began
    // A quiet fortnight somewhere in the year - a holiday period, a plant
    // shutdown. It is placed at least 100 days before `asOf`, so it is nowhere
    // near either window the signal compares.
    const dipFirst = firstIndex + 10;
    const dipLast = days - 100;
    const dip = dipFirst < dipLast && rand() < 0.45
      ? { from: between(rand, dipFirst, dipLast), length: between(rand, 9, 18), depth: 0.62 + rand() * 0.16 }
      : null;
    const curve = usageCurve({
      scenario,
      base,
      days,
      rand,
      cohort: cohort && scenario === "healthy",
      firstIndex,
      startShare,
      dip,
      weekdayOfFirstDay,
    });
    const stopAt = scenario === "stale_data" ? 15 : 0; // stop 15 days before asOf
    const stopBefore = stopAt ? addDays(asOf, -stopAt) : null;
    curve.forEach((v, k) => {
      const day = dayStrings[k];
      if (k < firstIndex) return; // the customer did not exist yet
      if (stopBefore && day > stopBefore) return;
      let seatsUsed = Math.min(seats, Math.round(v * 1.1));
      if (scenario === "expansion") seatsUsed = Math.min(Math.round(seats * 1.05), Math.round(v * 1.35));
      if (scenario === "churn_clear") seatsUsed = Math.round(seats * 0.32);
      usage.push({ account_id: id, day, active_users: v, sessions: Math.round(v * (2 + rand())), seats_used: seatsUsed });
    });

    // --- contacts ------------------------------------------------------------
    const championQuietDays =
      scenario === "churn_clear" ? 15 + Math.floor(rand() * 25)
        : scenario === "fp_champion_quiet" ? 20
          : scenario === "dismissed_worse" ? 34
            : scenario === "payment" ? 16
              : Math.floor(rand() * 6);
    const person = () => `${pick(rand, PEOPLE_FIRST)} ${pick(rand, PEOPLE_LAST)}`;
    contacts.push({
      contact_id: `${id}-C1`,
      account_id: id,
      name: person(),
      role: pick(rand, CHAMPION_ROLES),
      is_champion: "true",
      last_active_at: addDays(asOf, -championQuietDays),
    });
    // 🔴 EXACTLY ONE CHAMPION PER ACCOUNT. `champion_inactive` fires on the
    // QUIETEST champion, so a second champion who happens to be quiet would
    // raise a signal on an account that was planted to be silent - including
    // every false-positive trap.
    const extraContacts = 1 + (seats > 25 ? 1 : 0) + (rand() < 0.4 ? 1 : 0);
    for (let c = 0; c < extraContacts; c++) {
      contacts.push({
        contact_id: `${id}-C${c + 2}`,
        account_id: id,
        name: person(),
        role: c === 0 ? "Billing" : pick(rand, OTHER_ROLES),
        is_champion: "false",
        last_active_at: addDays(asOf, -Math.floor(rand() * 20)),
      });
    }

    // --- tickets -------------------------------------------------------------
    const priorCount = Math.max(1, Math.round(seats / 12));
    let currentCount = priorCount;
    if (scenario === "churn_clear") currentCount = priorCount * 2 + 3;
    if (scenario === "churn_subtle") currentCount = priorCount + Math.ceil(priorCount * 0.6) + 1;
    if (scenario === "fp_ticket_spike") currentCount = priorCount + 3;
    if (scenario === "dismissed_worse") currentCount = priorCount * 2 + 2;
    const push = (n, from, to, urgent = false) => {
      for (let k = 0; k < n; k++) {
        const at = addDays(asOf, -(from + Math.floor(rand() * (to - from))));
        const isUrgent = urgent && k === 0;
        tickets.push({
          ticket_id: `${id}-T${tickets.length}`,
          account_id: id,
          // 🔴 AN OPEN `urgent` TICKET IS A PLANTED SIGNAL, NOT COLOUR. It pushes
          // a band-2 ticket rise to band 3, so it is written only where the
          // scenario asks for one. Everything else closes, whatever its priority.
          opened_at: at,
          closed_at: isUrgent ? "" : addDays(at, 1 + Math.floor(rand() * 5)),
          priority: isUrgent ? "urgent" : rand() < 0.25 ? "high" : rand() < 0.3 ? "low" : "normal",
          subject: isUrgent ? pick(rand, URGENT_SUBJECTS) : pick(rand, TICKET_SUBJECTS),
        });
      }
    };
    push(priorCount, 31, 60);
    push(currentCount, 0, 30, scenario === "churn_clear");
    // The rest of the year, so a twelve-month support history exists to look at.
    // `tickets_up_30d` compares day 0-29 with day 30-59 and `urgentOpen` looks no
    // further back than 59 days, so nothing here can reach a signal.
    const historic = Math.max(1, Math.min(3, Math.round(priorCount * 0.6)));
    for (let m = 2; m < Math.floor(days / 30); m++) push(between(rand, 0, historic), m * 30 + 1, m * 30 + 30);

    // --- invoices ------------------------------------------------------------
    // Billed on the 12th of the month, not exactly 30 days ago: an invoice due
    // on the window boundary lands one day OUTSIDE the 30-day payment window
    // and the failure is never seen. Measured 2026-09-09 - all three planted
    // payment accounts produced no payment signal at all.
    //
    // 🔴 `payment_failed` LOOKS FOR status = "failed" WITH A DUE DATE IN THE
    // LAST 30 DAYS, and at band 2 it needs no corroborating signal to become a
    // payment_risk decision. So a "failed" status inside that window is planted
    // ONLY on the payment scenario. The dunning texture below - late payments,
    // and a failure months ago that was recovered - is all outside the window
    // or carries status "paid", which no signal reads.
    const months = Math.max(3, Math.floor(days / 30));
    const latePayer = rand() < 0.14;
    const historicFailureMonth = !scenario.startsWith("fp_") && scenario !== "payment" && rand() < 0.22
      ? between(rand, 4, Math.max(5, months - 1))
      : 0;
    for (let m = 1; m <= months; m++) {
      const due = addDays(asOf, -(m * 30 - 18));
      if (due > asOf) continue; // not billed yet
      if (addDays(asOf, -tenure) > due) continue; // before the customer joined
      const failing = scenario === "payment" && m === 1;
      const recovered = m === historicFailureMonth;
      const lateDays = failing ? 0 : recovered ? between(rand, 9, 16) : latePayer ? between(rand, 8, 20) : between(rand, 0, 4);
      invoices.push({
        invoice_id: `${id}-I${m}`,
        account_id: id,
        due_at: due,
        amount: Math.round(arr / 12),
        status: failing ? "failed" : "paid",
        // ⚠️ THREE ATTEMPTS, NOT TWO OR THREE. At two the payment signal is
        // band 2, the score is 3 with the quiet champion, and severity comes out
        // "low" - below the "medium" this scenario says it plants. The old code
        // picked 2 or 3 at random, so half the planted payment accounts failed
        // their own expectation. Measured 2026-09-17.
        attempts: failing ? 3 : recovered ? 2 : latePayer ? 1 : 0,
        paid_at: failing ? "" : addDays(due, lateDays),
      });
    }

    // --- events --------------------------------------------------------------
    // The account's own story over twelve months. None of these kinds is read
    // by the signal engine - see the note on STORY_EVENTS.
    const storyCount = between(rand, 3, 7);
    const spread = Math.max(30, Math.min(tenure, days) - 10);
    for (let k = 0; k < storyCount; k++) {
      const story = pick(rand, STORY_EVENTS);
      events.push({
        event_id: `${id}-S${k}`,
        account_id: id,
        at: addDays(asOf, -between(rand, 5, spread)),
        kind: story.kind,
        detail: story.detail,
      });
    }
    if (scenario === "expansion") {
      const n = 2 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) {
        events.push({ event_id: `${id}-E${k}`, account_id: id, at: addDays(asOf, -(1 + Math.floor(rand() * 13))), kind: "pricing_page_view", detail: "Viewed the plan comparison page." });
      }
      events.push({ event_id: `${id}-EL`, account_id: id, at: addDays(asOf, -4), kind: "seat_limit_hit", detail: "Tried to invite a user past the seat limit." });
    }
    if (scenario === "dismissed_worse") {
      events.push({ event_id: `${id}-EC`, account_id: id, at: addDays(asOf, -12), kind: "champion_left", detail: "The champion left the company." });
    }

    scenarios.push({
      account_id: id,
      name,
      scenario,
      expect: entry.expect,
      arr,
      note:
        scenario.startsWith("fp_")
          ? "One metric moves; the account is otherwise healthy. NO decision should be raised."
          : scenario === "stale_data"
            ? "Usage data stops 15 days early. Usage signals must be marked unreliable and raise nothing."
            : scenario === "dismissed_unchanged"
              ? "A dismissed decision exists and nothing got worse. It must stay suppressed."
              : scenario === "dismissed_worse"
                ? "A dismissed decision exists and the account got worse. A new decision must be raised."
                : "",
    });
  });

  return {
    asOf,
    seed,
    cohort,
    days,
    scale,
    files: {
      "accounts.csv": accounts,
      "usage_daily.csv": usage,
      "contacts.csv": contacts,
      "tickets.csv": tickets,
      "invoices.csv": invoices,
      "events.csv": events,
    },
    workspace: { name: cohort ? "Demo Company (company-wide event)" : "Demo Company", currency: "USD", seat_price_monthly: 25, as_of: asOf },
    scenarios,
  };
}

/** Column order per file, so an EMPTY table still writes a valid header row. */
const HEADERS = {
  "accounts.csv": ["account_id", "name", "arr", "plan", "seats_purchased", "renewal_date", "owner", "segment", "industry", "created_at"],
  "usage_daily.csv": ["account_id", "day", "active_users", "sessions", "seats_used"],
  "contacts.csv": ["contact_id", "account_id", "name", "role", "is_champion", "last_active_at"],
  "tickets.csv": ["ticket_id", "account_id", "opened_at", "closed_at", "priority", "subject"],
  "invoices.csv": ["invoice_id", "account_id", "due_at", "amount", "status", "attempts", "paid_at"],
  "events.csv": ["event_id", "account_id", "at", "kind", "detail"],
};

/**
 * ⚠️ A file with no rows still needs its HEADER. The first version returned an
 * empty string for an empty table, and the `edge` dataset - which plants no
 * events at all - then failed to import with "events.csv is missing the columns
 * event_id, account_id, at, kind". A valid file that happens to be empty is a
 * normal thing for a real customer to export, so the importer is right and the
 * writer was wrong.
 */
function recordsToCsv(name, records) {
  const headers = HEADERS[name] ?? [...new Set(records.flatMap((r) => Object.keys(r)))];
  return toCsv([headers, ...records.map((r) => headers.map((h) => r[h] ?? ""))]);
}

/** Write a generated dataset to a folder, ready for importFolder(). */
export function writeDataset(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, records] of Object.entries(data.files)) {
    fs.writeFileSync(path.join(dir, name), recordsToCsv(name, records), "utf8");
  }
  fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify(data.workspace, null, 2));
  fs.writeFileSync(path.join(dir, "scenarios.json"), JSON.stringify({ asOf: data.asOf, seed: data.seed, cohort: data.cohort, accounts: data.scenarios }, null, 2));
  return dir;
}

/** The three named variants, at demo size, generated relative to `asOf`. */
export function variant(name, asOf) {
  const full = { asOf, scale: DEMO_SCALE, days: DEMO_DAYS };
  if (name === "demo-cohort") return generate({ ...full, cohort: true, seed: 20260909 });
  if (name === "edge") return generate({ asOf, days: DEMO_DAYS, variant: "edge", seed: 771 });
  return generate({ ...full, seed: 20260909 });
}

/** The descriptions the UI shows. Counted from the mix so they cannot drift. */
export const VARIANTS = {
  demo: `${sizeOf(MIX, DEMO_SCALE)} customers and a year of daily usage: healthy, at-risk, expanding and false-positive accounts`,
  "demo-cohort": `The same ${sizeOf(MIX, DEMO_SCALE)} customers, with a change that hits most of them at once`,
  edge: `${sizeOf(EDGE_MIX, 1)} customers built only from the hard cases: subtle risk and near-misses`,
};

/** The seeded decisions the two "dismissed" scenarios need to exist. */
export function seedPriorDecisions(db, data) {
  const rows = data.scenarios.filter((s) => s.scenario.startsWith("dismissed_"));
  const out = [];
  for (const s of rows) {
    out.push({
      accountId: s.account_id,
      kind: "churn_risk",
      reason: s.scenario === "dismissed_unchanged" ? "Seasonal dip, confirmed with the customer" : "Thought it was a seasonal dip",
      daysAgo: 10,
    });
  }
  return out;
}

// --- the work the team already did ------------------------------------------
//
// 🔴 WHY THIS SECTION WRITES RAW ROWS AND NOT JUST DECISION ROWS.
//
// The first version of `seedHistory` wrote its evidence sentences from a fixed
// table of seven statements. They were fiction, and the customer page put the
// fiction next to the record it contradicted: "38 of 40 seats are in use" on an
// account that had bought 24, "the champion (VP Operations) has not been
// active" on an account whose champion is a Director of Engineering, and a
// payment "due 12 May 2026" on a decision that had been closed in November
// 2025. Measured on a real workspace, 2026-09-17: 25 decisions, 46 evidence
// rows, SEVEN distinct sentences between them, eight of which appeared twice on
// the same customer.
//
// So nothing here asserts a number any more. A history episode is planted in
// the customer's OWN usage, ticket and invoice rows, and then the LIVE signal
// engine is replayed against those rows at the date the decision opened. The
// statements, bands, severity, impact and title all come out of
// `computeSignals` and `situationsFor` - the same two functions the product
// runs every day - so a sentence on the screen can always be checked against
// the row beneath it, because the row is where it came from.

/**
 * 🔴 HOW FAR BACK EVERY PLANTED ROW SITS, AND WHY THE NUMBER IS 90.
 *
 * Planting raw rows means writing into the same tables the live engine reads,
 * so the demo's twelve false-positive traps are one careless date away from
 * being woken up. The furthest back the engine ever looks is 60 days:
 * `usage_drop_30d`'s baseline window ends 59 days before `asOf`, and
 * `tickets_up_30d`'s prior window does the same. 90 leaves a month of margin.
 *
 * Every history decision therefore OPENS at least `HISTORY_NEWEST` days ago,
 * and its own evidence windows reach back 59 days further still. The test file
 * measures the newest planted row directly rather than trusting this comment.
 */
const HISTORY_SAFE_DAYS = 90;
/** The newest, and the oldest, a past decision may have been opened. */
const HISTORY_NEWEST = HISTORY_SAFE_DAYS + 5;
const HISTORY_OLDEST = 300;
/** Days of history a customer needs BEFORE a decision can open on them. */
const HISTORY_RUNWAY = 65;
/** The shapes a past decision comes in. One per customer at most. */
const HISTORY_KINDS = ["churn_risk", "expansion", "payment_risk"];

/**
 * The oldest `daysAgo` a decision on this customer may open.
 *
 * 🔴 A DECISION CANNOT OPEN BEFORE ITS CUSTOMER EXISTED. The old version
 * ignored `created_at` entirely and put decisions dated 2025-12-15 and
 * 2026-01-29 on a customer created 2026-06-26 - and that customer was ACC-001,
 * the first row in the list and the one a viewer clicks first. The generator
 * plants a few deliberately new customers (`isNewCustomer`), and they are
 * exactly the accounts that cannot carry a past decision: this returns a number
 * below `HISTORY_NEWEST` for them, which is how they fall out of eligibility.
 *
 * The runway is 65 days rather than 60 because the engine also refuses to
 * measure a window with fewer than `minDays` rows in it.
 */
function oldestOpening(account, asOf) {
  const tenure = daysBetween(account.created_at, asOf);
  if (!Number.isFinite(tenure)) return -1;
  return Math.min(HISTORY_OLDEST, tenure - HISTORY_RUNWAY);
}

/** Mean of one metric over the `days` days ENDING on `end`, as signals.mjs measures it. */
function meanOver(db, accountId, metric, end, days) {
  const rows = db
    .prepare("SELECT value FROM metric_daily WHERE account_id = ? AND metric = ? AND day >= ? AND day <= ?")
    .all(accountId, metric, addDays(end, -(days - 1)), end);
  return { mean: rows.length ? rows.reduce((a, r) => a + Number(r.value), 0) / rows.length : null, days: rows.length };
}

/**
 * Move one account's usage across a window, with a short entry ramp so the
 * chart shows a business rather than a step - the same 4-day ramp `usageCurve`
 * uses for the planted change at the end of the year.
 *
 * ⚠️ `seats_used` is never allowed above `seats_purchased`. A customer cannot
 * use a seat they have not bought, and both seat signals divide by that number,
 * so a curve that breaks the invariant reports more than 100% utilisation.
 */
function moveUsage(db, accountId, from, to, factor, { seats = null, ramp = 4, seatsFactor = null } = {}) {
  const rows = db
    .prepare("SELECT day, metric, value FROM metric_daily WHERE account_id = ? AND day >= ? AND day <= ? ORDER BY day")
    .all(accountId, from, to);
  const upd = db.prepare("UPDATE metric_daily SET value = ? WHERE account_id = ? AND day = ? AND metric = ?");
  for (const r of rows) {
    const into = daysBetween(from, r.day) ?? 0;
    const want = r.metric === "seats_used" && seatsFactor != null ? seatsFactor : factor;
    const f = into < ramp ? 1 + (want - 1) * ((into + 1) / ramp) : want;
    let v = Math.max(0, Math.round(Number(r.value) * f));
    if (r.metric === "seats_used" && Number.isFinite(Number(seats))) v = Math.min(Number(seats), v);
    upd.run(v, accountId, r.day, r.metric);
  }
  return rows.length;
}

/** Every row the engine reads for one account, re-read AFTER the planting. */
function rowsFor(db, accountId) {
  return {
    metrics: db.prepare("SELECT * FROM metric_daily WHERE account_id = ?").all(accountId),
    tickets: db.prepare("SELECT * FROM ticket WHERE account_id = ?").all(accountId),
    invoices: db.prepare("SELECT * FROM invoice WHERE account_id = ?").all(accountId),
    contacts: db.prepare("SELECT * FROM contact WHERE account_id = ?").all(accountId),
    events: db.prepare("SELECT * FROM event WHERE account_id = ?").all(accountId),
  };
}

/**
 * Plant the raw rows one episode rests on.
 *
 * Returns false when this customer's data cannot carry it - in which case
 * nothing has been written, and the caller writes no decision rather than a
 * decision the rows do not support.
 */
function plantEpisode(db, { kind, account, day, key, rand }) {
  const id = account.id;
  const recentFrom = addDays(day, -29);
  const baseFrom = addDays(day, -59);
  const baseTo = addDays(day, -30);
  const seats = Number(account.seats_purchased) || 0;

  // Both windows must actually hold data, or the engine refuses to measure them
  // (`minDays`) and the episode would produce no usage signal at all.
  const before = meanOver(db, id, "active_users", baseTo, 30);
  const after = meanOver(db, id, "active_users", day, 30);
  if (!(before.days >= 20 && after.days >= 20 && before.mean > 0)) return false;

  if (kind === "churn_risk") {
    // Down by 40-56%. The figure is never stated here: it is measured back off
    // the rows by the signal engine, weekday pattern, rounding and all.
    moveUsage(db, id, recentFrom, day, 0.44 + rand() * 0.16, { seats });

    // Support volume rises with the trouble. `tickets_up_30d` needs a non-zero
    // prior window to have a percentage at all, so an empty one is topped up
    // first - and every planted ticket is CLOSED, because an open `urgent`
    // ticket is a planted signal in its own right.
    const count = (from, to) =>
      db.prepare("SELECT COUNT(*) n FROM ticket WHERE account_id = ? AND opened_at >= ? AND opened_at <= ?").get(id, from, to).n;
    const insT = db.prepare(
      "INSERT OR REPLACE INTO ticket (id, account_id, opened_at, closed_at, priority, subject) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let made = 0;
    const addTickets = (n, from, span) => {
      for (let k = 0; k < n; k++) {
        const opened = addDays(from, Math.floor(rand() * span));
        insT.run(
          `${id}-TH${key}-${made++}`,
          id,
          opened,
          addDays(opened, 1 + Math.floor(rand() * 5)),
          rand() < 0.3 ? "high" : "normal",
          pick(rand, TICKET_SUBJECTS),
        );
      }
    };
    const priorNow = count(baseFrom, baseTo);
    if (priorNow < 2) addTickets(2 - priorNow, baseFrom, 30);
    const prior = count(baseFrom, baseTo);
    addTickets(Math.max(0, Math.max(5, prior * 2 + 1) - count(recentFrom, day)), recentFrom, 30);
    return true;
  }

  if (kind === "expansion") {
    // Up by 75-115%, and the seats fill up with the people using them.
    //
    // ⚠️ THE SEAT CURVE IS AIMED AT A SHARE, NOT MULTIPLIED BY A CONSTANT.
    // `seats_used` is capped at `seats_purchased`, so any large multiplier
    // pins every account to exactly 100% and every expansion in the history
    // then reads "87 of 87 seats are in use (100%)". Aiming at 90-99% of the
    // seats they bought keeps the accounts different from each other, and the
    // sentence is still measured back off the rows afterwards.
    const used = meanOver(db, id, "seats_used", day, 7);
    // 0.92 to 1.00: `seat_util_high` bands at 90 and 100, so this straddles the
    // boundary and the history carries both a "nearly full" and a "full" story
    // rather than one severity repeated.
    const share = 0.92 + rand() * 0.08;
    const seatsFactor = used.mean > 0 && seats > 0 ? (seats * share) / used.mean : null;
    moveUsage(db, id, recentFrom, day, 1.75 + rand() * 0.4, { seats, seatsFactor });
    return true;
  }

  if (kind === "payment_risk") {
    // 🔴 A REAL INVOICE, OR NO PAYMENT STORY AT ALL. The old text quoted a due
    // date belonging to no row on the account, and dated AFTER the decision it
    // was evidence for had been closed. This takes the invoice the account
    // actually has inside the decision's own 30-day window, and fails the
    // episode when there is none.
    const inv = db
      .prepare("SELECT * FROM invoice WHERE account_id = ? AND due_at >= ? AND due_at <= ? ORDER BY due_at DESC LIMIT 1")
      .get(id, recentFrom, day);
    if (!inv) return false;
    db.prepare("UPDATE invoice SET status = 'failed', attempts = 3, paid_at = '' WHERE id = ?").run(inv.id);
    return true;
  }

  return false;
}

/**
 * What a person wrote when they closed it. Prose, not evidence: it says what
 * turned out to be behind the numbers, and asserts no figure of its own.
 *
 * ⚠️ NO JOB TITLE FROM `CHAMPION_ROLES` OR `OTHER_ROLES` MAY APPEAR HERE, even
 * as an ordinary noun. The test that catches a decision naming another
 * customer's champion works by looking for every role in the dataset in
 * everything the page shows, so "Procurement had already budgeted for it" reads
 * as a claim about a contact who does not exist on that account - and it did,
 * until this comment was written.
 */
const HISTORY_NOTES = {
  churn_risk: [
    "Two teams had been reorganised and nobody had rebuilt their reports. We rebuilt them and the usage came back.",
    "They had moved one department onto another tool for a quarter. The pilot ended and they came back to us.",
    "Their nightly export was timing out, which is what the tickets were about. Fixed in the next release.",
  ],
  expansion: [
    "They added a second department and bought the extra seats in the same week.",
    "Their finance team had already budgeted for it. The call only had to ask.",
    "They took the extra seats on a twelve month term rather than monthly.",
  ],
  payment_risk: [
    "An expired card. The billing contact updated it the same day and the re-issued invoice cleared.",
    "The card belonged to somebody who had left. A new one was on file within the week.",
    "Their finance team had changed bank and nobody had told billing. Paid on the next cycle.",
  ],
};

const HISTORY_RATIONALE = {
  churn_risk: "A call from the account owner is the fastest way to find out whether the team changed or the product stopped fitting.",
  expansion: "Ask before they hit the limit, rather than after somebody cannot be invited.",
  payment_risk: "Almost every failure of this kind is an expired card, and it is fixed in one message.",
};

const HISTORY_ACTION = {
  churn_risk: { action: "exec_outreach", kind: "draft_email" },
  expansion: { action: "expansion_call", kind: "task" },
  payment_risk: { action: "billing_contact", kind: "task" },
};

const HISTORY_RESULT = { churn_risk: "renewed", expansion: "expanded", payment_risk: "payment_recovered" };

/**
 * A closed history for a handful of customers: decisions raised months ago,
 * worked, resolved, and with the outcome recorded.
 *
 * WHY IT IS SEEDED AT ALL. Everything else in this file is raw data that the
 * engine turns into decisions. This is the one part the engine cannot produce,
 * because it is the record of what a PERSON did - and it is the thing a chat
 * window cannot show: the product remembers that this customer was at risk in
 * June, who handled it, and that they renewed.
 *
 * 🔴 EVERY SEEDED DECISION IS `resolved`, NEVER `dismissed`. A dismissed
 * decision suppresses a new one on the same account and kind for
 * `dismissedSuppressDays`, so seeding one here would silently cancel a planted
 * scenario. The two deliberately dismissed accounts are seeded elsewhere (by
 * decisionsSeedDemo) and are skipped here.
 *
 * 🔴 AND NONE OF THEM LANDS ON A TRAP. An fp_ account with a decision row - of
 * any status - reads as a raised decision to anything counting rows per
 * account, including the evaluation harness and the test that guards the traps.
 *
 * ⭐ SOME OF THEM CLOSED THIS MONTH, AND THAT IS NOT DECORATION.
 * `decisionsOverview` counts `resolvedThisMonth` over the last 30 days only, so
 * a history that is entirely ten months old leaves that tile on zero and the
 * "Resolved" section empty - which is exactly where the demo script points.
 * Roughly a third of the chosen customers therefore carry a long-running
 * decision that OPENED outside the 90-day guard and was CLOSED inside the last
 * month. A renewal save that ran for three months is an ordinary thing; a
 * planted usage drop three weeks ago is a corrupted dataset.
 *
 * @returns {number} how many decisions were written
 */
export function seedHistory(db, data, asOf = data.asOf) {
  // ⭐ ONE TRANSACTION, FOR TWO REASONS. Measured on a file-backed workspace,
  // 2026-09-17: 3,195ms without it and 186ms with it, because about 24,000
  // usage rows are rewritten one statement at a time. And it means a failure
  // half way through leaves the workspace as it was, rather than with a
  // customer's usage moved and no decision on file to explain why.
  return tx(db, () => seedHistoryRows(db, data, asOf));
}

function seedHistoryRows(db, data, asOf) {
  const rand = rng((data.seed ?? 0) ^ 0x51f0a3);
  const settings = getSettings(db);
  const R = rules();

  // Re-seeding the demo re-imports every raw table from scratch, so a history
  // left over from an earlier seed describes rows that no longer exist. Clearing
  // it also makes this function safe to call twice: planting MOVES usage rows in
  // place, and a second pass over already-moved rows would move them again.
  db.prepare("DELETE FROM decision WHERE id LIKE 'dec_hist%'").run();
  db.prepare("DELETE FROM run WHERE id LIKE 'run_hist%'").run();

  const accounts = new Map(db.prepare("SELECT * FROM account").all().map((a) => [a.id, a]));
  const eligible = data.scenarios.filter((s) => {
    if (s.scenario.startsWith("fp_") || s.scenario.startsWith("dismissed_") || s.scenario === "stale_data") return false;
    const a = accounts.get(s.account_id);
    return !!a && oldestOpening(a, asOf) >= HISTORY_NEWEST;
  });
  if (!eligible.length) return 0;

  // A tenth of the customer base, so the "resolved" history is visible without
  // the queue looking like a graveyard.
  const wanted = Math.max(3, Math.round(eligible.length * 0.1));
  const chosen = [];
  const step = Math.max(1, Math.floor(eligible.length / wanted));
  for (let i = 0; i < eligible.length && chosen.length < wanted; i += step) chosen.push(eligible[i]);

  const insDecision = db.prepare(
    `INSERT OR REPLACE INTO decision (id, account_id, fingerprint, kind, title, severity, confidence, status,
       owner, due_at, impact_amount, impact_basis, currency, why_it_matters, recommended_action_id,
       recommended_action_text, rationale, reasoning_source, first_run_id, last_run_id, created_at, updated_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'resolved', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rule_only', ?, ?, ?, ?, ?)`,
  );
  const insEvidence = db.prepare(
    "INSERT OR REPLACE INTO decision_evidence (decision_id, signal_id, rank, statement, kind) VALUES (?, ?, ?, ?, ?)",
  );
  const insEvent = db.prepare(
    "INSERT OR REPLACE INTO decision_event (id, decision_id, at, actor, kind, data_json) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insAction = db.prepare(
    "INSERT OR REPLACE INTO action (id, decision_id, account_id, kind, status, payload_json, created_at, done_at) VALUES (?, ?, ?, ?, 'done', ?, ?, ?)",
  );
  const insOutcome = db.prepare(
    `INSERT INTO outcome (decision_id, result, note, recorded_at, arr_after) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(decision_id) DO UPDATE SET result = excluded.result, note = excluded.note,
       recorded_at = excluded.recorded_at, arr_after = excluded.arr_after`,
  );
  // 🔴 A REAL RUN, AND REAL SIGNAL ROWS, OR THE PAGE COUNTS ITSELF TWICE.
  // `decisionsGet` reads the signals of `last_run_id`, and falls back to the
  // LATEST run when that column is null. With the column null and the cited ids
  // belonging to no row, the header rendered "Evidence cited: 2 of 1 signals"
  // while the coverage grid under it rendered "0 of 1 signals cited", and the
  // page then offered today's signal as "1 other signal on this customer" under
  // a decision closed ten months earlier. Measured on dec_histACC011_0.
  const insRun = db.prepare(
    `INSERT OR REPLACE INTO run (id, started_at, finished_at, as_of, status, accounts, signals, candidates,
       reasoned, cached, decisions_created, decisions_updated)
     VALUES (?, ?, ?, ?, 'done', 1, ?, ?, 0, 0, 1, 0)`,
  );
  const insSignal = db.prepare(
    `INSERT OR REPLACE INTO signal (id, run_id, account_id, kind, band, direction, value, baseline, change_pct,
       window_days, statement, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const stamp = (daysAgo, hour) => `${addDays(asOf, -daysAgo)}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  let written = 0;

  chosen.forEach((s, index) => {
    const account = accounts.get(s.account_id);
    const oldest = oldestOpening(account, asOf);

    const recent = index % 3 === 0;
    const opens = [];
    let at = Math.min(oldest, recent ? between(rand, HISTORY_NEWEST, 125) : between(rand, 130, 210));
    for (let n = 0; n < between(rand, 1, 3) && at <= oldest; n++) {
      opens.push(at);
      at += between(rand, 70, 110); // far enough apart that two windows never overlap
    }
    opens.reverse(); // oldest first, so the customer's timeline reads downwards

    // A different shape each time, so two decisions on one customer cannot
    // repeat each other's evidence even before the periods differ.
    const kinds = [...HISTORY_KINDS];
    for (let k = kinds.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [kinds[k], kinds[j]] = [kinds[j], kinds[k]];
    }

    opens.forEach((openedDaysAgo, n) => {
      const key = `${s.account_id.replace(/\W/g, "")}_${n}`;
      const id = `dec_hist${key}`;
      const runIdent = `run_hist${key}`;
      const openedDay = addDays(asOf, -openedDaysAgo);
      const kind = kinds[n % kinds.length];

      if (!plantEpisode(db, { kind, account, day: openedDay, key, rand })) return;

      // 🔴 THE LIVE ENGINE, REPLAYED AT THE DATE THE DECISION OPENED. Nothing
      // below writes a sentence, a band, a severity or a figure of its own.
      const rows = rowsFor(db, account.id);
      const signals = computeSignals({ account, ...rows, asOf: openedDay, settings })
        .filter((x) => x.band >= 1)
        .map((x, k) => ({ ...x, id: `sig_hist${key}_${k}` }));
      const { situations } = situationsFor({ account, signals, asOf: openedDay, settings });
      const situation = situations.find((x) => x.kind === kind);
      if (!situation) return;

      insRun.run(runIdent, `${openedDay}T07:00:00.000Z`, `${openedDay}T07:04:00.000Z`, openedDay, signals.length, situations.length);
      for (const sig of signals) {
        insSignal.run(
          sig.id, runIdent, account.id, sig.kind, sig.band, sig.direction, sig.value, sig.baseline,
          sig.changePct, sig.windowDays, sig.statement, JSON.stringify(sig.detail ?? {}),
        );
      }

      const isNewest = n === opens.length - 1;
      const worked = recent && isNewest ? between(rand, openedDaysAgo - 28, openedDaysAgo - 16) : between(rand, 4, 11);
      const closedDaysAgo = openedDaysAgo - worked;
      const owner = account.owner || pick(rand, OWNERS);
      const champion = rows.contacts.find((c) => Number(c.is_champion) === 1) ?? rows.contacts[0] ?? null;
      const cfg = HISTORY_ACTION[kind];
      const impact = situation.impact;
      const result = HISTORY_RESULT[kind];
      const arrAfter =
        kind === "expansion" ? Math.round(Number(account.arr) + (Number(impact.amount) || 0)) : Math.round(Number(account.arr));

      // Why it mattered, said only about what the evidence above established.
      const statementOf = (k) => situation.signals.find((x) => x.kind === k)?.statement ?? null;
      const why =
        kind === "churn_risk"
          ? `${statementOf("usage_drop_30d")} It was not the only thing moving on this customer in the 30 days to ${humanDate(openedDay)}, which is why it was raised rather than watched.`
          : kind === "expansion"
            ? `${statementOf("usage_rise_30d")} ${statementOf("seat_util_high") ?? ""}`.trim()
            : `${statementOf("payment_failed")} Nobody had contacted the billing owner.`;

      insDecision.run(
        id,
        account.id,
        `${account.id}:${kind}`,
        kind,
        titleFor({ kind, accountName: account.name, signals: situation.signals }),
        situation.severity,
        "medium",
        owner,
        addDays(asOf, -(openedDaysAgo - 5)),
        impact.amount,
        impact.basis,
        impact.currency,
        why,
        cfg.action,
        actionLabel(cfg.action),
        HISTORY_RATIONALE[kind],
        runIdent,
        runIdent,
        stamp(openedDaysAgo, 8),
        stamp(closedDaysAgo, 16),
        stamp(closedDaysAgo, 16),
      );
      situation.signals.forEach((sig, k) => insEvidence.run(id, sig.id, k, sig.statement, sig.kind));

      const note = pick(rand, HISTORY_NOTES[kind]);
      let evNo = 0;
      const log = (daysAgo, hour, actor, evKind, payload) =>
        insEvent.run(`evt_hist${key}_${evNo++}`, id, stamp(daysAgo, hour), actor, evKind, payload == null ? null : JSON.stringify(payload));
      log(openedDaysAgo, 8, "system", "created", {
        severity: situation.severity,
        score: situation.score,
        signals: situation.signals.map((x) => `${x.kind}:${x.band}`),
        source: "rule_only",
      });
      log(openedDaysAgo, 9, "user", "status", { from: "new", to: "accepted" });
      log(openedDaysAgo, 9, "user", "owner", { from: null, to: owner });
      log(openedDaysAgo - 1, 10, "user", "action_prepared", { kind: cfg.kind });
      log(closedDaysAgo + 1, 11, "user", "action_done", { kind: cfg.kind });
      log(closedDaysAgo, 15, "user", "note", { text: note });
      log(closedDaysAgo, 16, "user", "resolved", { result });
      log(closedDaysAgo, 16, "user", "outcome", { result, arrAfter });

      // 🔴 THE ACTION IS ALWAYS OLDER THAN THE OUTREACH COOLDOWN.
      // `outreachConflict` refuses a new draft email when one was prepared for
      // this customer inside `outreachCooldownDays` (14). A recent seeded email
      // would make the demo's own "Draft an email" button refuse to work. Every
      // decision here opens at least 95 days ago, so this holds by
      // construction - and it is CHECKED here rather than assumed, because the
      // day somebody shortens `HISTORY_NEWEST` is the day it stops holding.
      const actionAge = openedDaysAgo - 1;
      const actionKind = cfg.kind === "draft_email" && actionAge <= R.limits.outreachCooldownDays ? "task" : cfg.kind;
      const dueAt = addDays(asOf, -(openedDaysAgo - 5));
      const payload =
        actionKind === "draft_email"
          ? {
              subject: `Checking in on how ${account.name} is using the platform`,
              // The real champion, by the name their own contact row gives.
              body: `Hello ${champion?.name ?? "there"},\n\nWe noticed the team has been in less often over the last month. Could we find 20 minutes to go through what changed?\n\n${owner}`,
              source: "template",
              to: "",
              accountName: account.name,
              dueAt,
            }
          : {
              title:
                kind === "expansion"
                  ? `Talk to ${account.name} about extra seats`
                  : kind === "payment_risk"
                    ? `Ask ${account.name}'s billing contact to update the card`
                    : `Run a technical health review with ${account.name}`,
              owner,
              dueAt,
              // The real champion, with the job title the contact row gives them.
              note: champion ? `${champion.name} (${champion.role}) is the champion on this account.` : "",
            };
      insAction.run(`act_hist${key}`, id, account.id, actionKind, JSON.stringify(payload), stamp(actionAge, 10), stamp(closedDaysAgo + 1, 11));
      insOutcome.run(id, result, note, stamp(closedDaysAgo, 16), arrAfter);
      written++;
    });
  });

  return written;
}
