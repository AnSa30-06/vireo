// The manual, inside the app.
//
// 🔴 WHY THIS IS A SCREEN AND NOT A LINK TO docs/. Fifteen markdown files sit
// next to the installed program, and nobody has ever opened them. A feature
// only reachable by finding a folder on disk is not finished: the person using
// this has the window open, and the answer has to be in the window.
//
// Written for someone who has never heard of an API key. Every section answers
// a question a real person asks, in the order they ask it.
//
// Content lives as data so it can be searched, and so adding a section is a
// data change rather than DOM plumbing.

/** A section is {id, title, blurb?, blocks: [...]}. Blocks render in order. */
export const MANUAL = [
  {
    id: "what",
    title: "What this is",
    blocks: [
      { p: "Decisions reads spreadsheets about your customers and tells you which ones need your attention this week, why, and what to do about it." },
      { p: "You already have the answer in your data. Your billing system knows about the failed payment. Your product knows usage is down. Your help desk knows tickets are up. Your CRM knows the renewal is in six weeks. Nobody reads all four for every customer every week, so problems get noticed at the renewal call." },
      { p: "This reads all four for every customer, every time you run it, and hands you only the ones worth your time." },
      {
        callout: "The two rules it will not break",
        kind: "fact",
        items: [
          "Every number on the screen was computed from your data, not written by an AI. The software does the arithmetic. The AI only reads sentences the software wrote, and only writes the explanation. If it produces a number that is not in your data, the answer is thrown away and it is asked again.",
          "One thing changing is never a decision. A customer whose tickets went up is watched, not raised. It takes several things moving together. That rule is in the code, not in the AI's judgement, so it holds even when the AI is unavailable.",
        ],
      },
    ],
  },
  {
    id: "start",
    title: "Getting started in five minutes",
    blocks: [
      {
        steps: [
          ["Name your workspace", "A workspace is one company's data. You can have several; they never share anything."],
          ["Load the demo company", "48 made-up customers with realistic problems planted in them. None of your data is used. Do this first even if you have your own data — it takes one click and shows you what the product does before you spend time on file formats."],
          ["Run the analysis", "It reads every customer, works out what changed, then asks the AI about the ones that matter. It can take a minute on free models."],
          ["Open the first decision", "Read why it was raised and what the evidence is."],
          ["Handle it", "Accept it, snooze it, or dismiss it. Then record what actually happened when you are done."],
        ],
      },
      { p: "That is the whole product. Everything below is detail." },
    ],
  },
  {
    id: "loop",
    title: "How it works, in six steps",
    blocks: [
      {
        table: {
          head: ["Step", "Who does it", "What happens"],
          rows: [
            ["1. Import", "You", "You point it at a folder of spreadsheets. Every row is checked. A row it cannot read is rejected and counted, never guessed at."],
            ["2. Signals", "The software", "Eleven things are worked out for every customer — usage up or down, renewal date, ticket volume, seat use, failed payments, a quiet main contact. All arithmetic, no AI."],
            ["3. Situations", "The software", "Signals are combined by rule. One alone is watched. Several together become something worth a decision."],
            ["4. Reasoning", "The AI", "Only the situations that survived step 3, and only the most serious ones. The AI explains what it means and picks one action from a fixed list."],
            ["5. You", "You", "Accept, snooze or dismiss. Draft an email, create a task."],
            ["6. Follow-up", "The software", "It reminds you until you close it, then asks what happened."],
          ],
        },
      },
      {
        callout: "What this costs to run",
        kind: "rec",
        items: [
          "Steps 1 to 3 cost nothing at all — no AI is involved.",
          "Step 4 sends up to ten short fact sheets, which you can change in Settings.",
          "Running it again with nothing changed costs zero: unchanged situations are not sent.",
        ],
      },
    ],
  },
  {
    id: "signals",
    title: "The eleven things it looks at",
    blurb: "All computed from your spreadsheets. Each gets a level from 0 to 3 and one sentence of plain English, and that sentence is the only thing the AI is ever shown about that number.",
    blocks: [
      {
        table: {
          head: ["Signal", "What it measures", "Counts when"],
          rows: [
            ["Usage down", "Average daily active users, last 30 days against the 30 before", "down 25% or more"],
            ["Usage up", "The same, upward", "up 30% or more"],
            ["Usage down this week", "Last 7 days against the previous four weeks", "down 40% or more"],
            ["Renewal approaching", "Days until the renewal date", "within 90 days"],
            ["Support tickets up", "Tickets opened in 30 days against the 30 before", "up 50%, and at least 3"],
            ["Seats under-used", "Seats used against seats bought", "half the seats or fewer"],
            ["Seats nearly full", "The same, at the other end", "90% or more"],
            ["Payment failed", "Failed invoices, attempts, and size", "one failed attempt"],
            ["Champion inactive", "Days since your main contact did anything", "14 days"],
            ["Pricing interest", "Pricing page views in the last two weeks", "one view"],
            ["Data is stale", "How long ago your usage data stops", "more than 7 days"],
          ],
        },
      },
      {
        callout: "Two rules that stop false alarms",
        kind: "guess",
        items: [
          "A day with no row is missing, not zero. A gap in your reporting is not a collapse in usage.",
          "If your usage data is out of date, the usage signals are marked unreliable and are not acted on. The customer page says so.",
        ],
      },
      { p: "You can move three of these lines in Settings: usage down, renewal approaching, and support tickets up." },
      { warn: "These thresholds were chosen as sensible starting points. They have not been calibrated against real churn data. Run it on your own customers, look at what it raised, and adjust." },
    ],
  },
  {
    id: "situations",
    title: "What becomes a decision",
    blocks: [
      {
        table: {
          head: ["Kind", "Needs"],
          rows: [
            ["Churn risk", "Usage down, plus one of: renewal near, tickets up, champion quiet, seats under-used"],
            ["Expansion", "Usage up, plus one of: seats nearly full, pricing page viewed"],
            ["Payment problem", "A failed payment, plus usage down or a quiet champion. Three failed attempts stands on its own."],
            ["Company-wide change", "The same change at 40% or more of your customers at once"],
          ],
        },
      },
      { p: "The last one matters most. If usage drops for most of your customers in the same week, that is one thing that happened to your product or your market, not thirty customers each deciding to leave. It raises ONE decision, and each customer's own usage signal is discounted so nobody gets blamed individually." },
      { p: "How serious a decision is comes from adding up the signal levels. It is arithmetic, not judgement, so the order on your screen is always explainable. How much money is at stake is also computed — their annual value for a churn risk, the unpaid amount for a payment problem, the extra seats for an expansion. If it cannot work out a figure it says so rather than estimating one." },
    ],
  },
  {
    id: "reading",
    title: "Reading a decision",
    blurb: "Every block on the decision page has a coloured label. Always read the label first.",
    blocks: [
      {
        kinds: [
          ["fact", "Observed fact", "Measured from your data. Cannot be wrong unless your data is."],
          ["ai", "AI interpretation", "What a model thinks it means. Can be plausible and wrong."],
          ["guess", "Hypothesis", "A guess, and labelled as one."],
          ["rec", "Recommendation", "What to do next, chosen from a fixed list."],
        ],
      },
      { p: "The panel called \"Everything we looked at\" shows every signal on that customer, including the ones the recommendation ignored. That is the honest one. If the story does not match the evidence, you will see it there." },
      {
        callout: "What the AI is not allowed to do",
        kind: "fact",
        items: [
          "Use any number that is not in your data.",
          "Cite a signal that does not exist.",
          "Recommend an action outside the offered list.",
          "Blame the economy, a competitor or the news — it has no information about the outside world.",
          "Write a guess as a certainty.",
        ],
      },
      { p: "An answer that breaks any of those is thrown away and asked for again. If it fails twice, the decision is still raised from the rules alone and says \"the AI could not explain this one\". You never lose a decision because a model was busy." },
    ],
  },
  {
    id: "handling",
    title: "Handling one",
    blocks: [
      {
        table: {
          head: ["Action", "What it does"],
          rows: [
            ["Accept and assign", "You are taking it on. A due date is set for you from how serious it is: 2 days for critical, 5 for high, 10 for medium, 21 for low."],
            ["Snooze", "Not now. Pick a date. It comes back then — and comes back early if the customer gets worse."],
            ["Dismiss", "Not a real problem. You say why. It will not be raised again for two weeks unless things worsen, and the AI is shown your reason next time so it does not repeat itself."],
            ["Draft an email", "The AI writes a short message from this decision. You edit it and send it from your own mail program."],
            ["Create a task", "Records what needs doing, who is doing it, and by when. It lives here, in the decision's history."],
            ["Record the outcome", "What actually happened. This closes the decision."],
          ],
        },
      },
      {
        callout: "Nothing here sends anything",
        kind: "rec",
        items: [
          "There is no code in this product that can send an email, post to Slack, or write to your CRM.",
          "\"Open in my mail app\" hands the text to your own mail program, exactly like clicking an email link on a web page.",
          "Only one email per customer is prepared per fortnight, so two decisions on one account do not produce two unrelated notes in the same week.",
        ],
      },
      { p: "Recording the outcome is the most valuable thing you will type into this product. It is shown to the AI next time something happens on that customer, and it is the only way to find out in three months whether any of this worked." },
    ],
  },
  {
    id: "screens",
    title: "Every screen",
    blocks: [
      {
        table: {
          head: ["Screen", "What it is for"],
          rows: [
            ["Today", "What needs your attention now. Six tiles, then cards grouped by what state they are in. Start here every morning."],
            ["Decisions", "Every decision ever, with filters by status, severity, kind and owner. Go here to find something specific, or to review what you dismissed."],
            ["Customers", "Everyone you imported, with a state label. Open one to see every signal on them, and the answer to \"why was nothing raised about this account?\""],
            ["Activity", "What the system did and what you did, newest first. Every analysis run shows how many model calls it made and what it cost."],
            ["Settings", "Owners, business context, thresholds, privacy, demo mode, and importing data."],
          ],
        },
      },
      { p: "On the Customers list, a customer marked \"Watching\" has something moving that did not add up to a decision. That is deliberate, and it is what stops the product crying wolf." },
    ],
  },
  {
    id: "data",
    title: "Using your own data",
    blurb: "A folder with six spreadsheet files in it, saved as CSV. Only the first two are required.",
    blocks: [
      {
        table: {
          head: ["File", "One row per", "Key columns"],
          rows: [
            ["accounts.csv", "customer", "account_id, name, arr, plan, seats_purchased, renewal_date, owner, created_at"],
            ["usage_daily.csv", "customer per day", "account_id, day, active_users, sessions, seats_used"],
            ["contacts.csv", "person", "contact_id, account_id, role, is_champion, last_active_at"],
            ["tickets.csv", "support ticket", "ticket_id, account_id, opened_at, closed_at, priority"],
            ["invoices.csv", "invoice", "invoice_id, account_id, due_at, status, amount, attempts"],
            ["events.csv", "notable moment", "event_id, account_id, at, kind"],
          ],
        },
      },
      {
        callout: "The quickest way to start",
        kind: "rec",
        items: [
          "Settings > Data > Download blank templates writes all six files with the right column names and an example row.",
          "Fill them in, then import that folder.",
          "Send at least 60 days of usage. It compares the last 30 days with the 30 before, and needs 20 days of rows in each.",
        ],
      },
      {
        table: {
          head: ["Rule", "Why"],
          rows: [
            ["Dates are YYYY-MM-DD", "01/09/2026 is rejected because nobody can tell if that is January or September."],
            ["Numbers are plain", "50000, not $50,000 — though symbols and commas are stripped where they appear."],
            ["Extra columns are ignored", "Export more than you need. Nothing else is stored."],
            ["A bad row is rejected and counted", "Never guessed at, never turned into a zero. The reason is shown."],
            ["Importing again replaces the data", "Your decisions, notes and outcomes are kept."],
          ],
        },
      },
      { p: "Read the import report. \"12,000 read, 400 used\" is telling you something important about your export, not about this product." },
    ],
  },
  {
    id: "privacy",
    title: "Privacy",
    blocks: [
      { p: "Everything runs on your computer. There is no account, no server belonging to this product, and your files are never uploaded." },
      { p: "The only thing that leaves your machine is a short fact sheet about ONE customer, sent to an AI model, and only when you run an analysis or ask for an email draft." },
      {
        callout: "What is in that fact sheet",
        kind: "fact",
        items: [
          "The sentences the software wrote, like \"Average daily active users fell 45% over the last 30 days\".",
          "Their annual value, plan, renewal date and how long they have been a customer.",
          "NOT their name — by default they are sent as a code like A-17.",
          "NOT any person's name — contacts are described by job title.",
          "NOT any row from your spreadsheets, ticket text, or notes.",
        ],
      },
      { p: "To use it with no AI at all, open a terminal and run vireo decisions run --no-model. Every decision is still found. Only the written explanation is missing." },
      { p: "To delete everything, use Settings > Delete this workspace. It removes the data, every decision, the history and the outcomes." },
    ],
  },
  {
    id: "problems",
    title: "When something does not work",
    blocks: [
      {
        table: {
          head: ["What you see", "What it means"],
          rows: [
            ["No decisions after a run", "Often the right answer. Check the Customers page — if everyone is \"Healthy\", nothing changed. If you have under 60 days of usage data, no usage signal can be produced at all."],
            ["\"The AI could not explain this one\"", "The model was busy or unavailable. The decision is still real — the evidence and money were computed. Click Try the AI again, or add a free provider key to make it reliable."],
            ["The analysis seems stuck", "Free models can take a minute or more per decision. The progress line says which part it is on."],
            ["The import was refused", "The message names the file and the column. Column names are matched exactly, in lower case."],
            ["The same decision keeps coming back", "It should not. If you dismissed it and it returned, the situation got worse than when you dismissed it. That is deliberate."],
            ["The date at the top is wrong", "You are in demo mode, which freezes the date so you can move it forward. Settings > Demo mode."],
            ["The numbers look wrong", "Open the decision and read \"Everything we looked at\" — each line says what was measured and what the threshold is. Then check the customer page for when your usage data ends."],
          ],
        },
      },
      { p: "Everything is slow, or models keep failing? Add one free provider key. Vireo works with no key at all, but only a handful of free models still answer and they are slow. Open the main Vireo window and use the Free capacity page." },
    ],
  },
  {
    id: "limits",
    title: "What this cannot do",
    blurb: "The honest list. Read it before relying on this for anything that matters.",
    blocks: [
      {
        callout: "Known limits",
        kind: "guess",
        items: [
          "The thresholds were chosen, not calibrated against real churn data, and this has never been run on a real company's export.",
          "No live connections. No Stripe, HubSpot, Salesforce or Intercom. You export CSV files and import a folder.",
          "It only runs while the app is open. Reminders and snooze expiry happen while Vireo is running.",
          "It cannot send anything, anywhere.",
          "Two actions only: draft an email, create a task.",
          "Four kinds of situation. It will not find a support quality problem or an onboarding failure.",
          "It reads numbers and dates, never the words in your tickets, emails or call notes.",
          "It does not predict anything. \"Money at stake\" is what they currently pay you, not a forecast.",
          "One person, one computer. No accounts, no sharing.",
        ],
      },
      { p: "The interpretation, the possible causes and the recommended action are written by a language model and can be plausible and wrong. The figures cannot — they are computed and checked. If a recommendation looks wrong, it probably is. Dismiss it and say why." },
    ],
  },
];

/* ── rendering ──────────────────────────────────────────────────────────── */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function kindChip(kind) {
  const map = { fact: "Observed fact", ai: "AI interpretation", guess: "Hypothesis", rec: "Recommendation" };
  return el("span", `kind ${kind}`, map[kind] ?? kind);
}

function renderBlock(b) {
  if (b.p) return el("p", null, b.p);

  if (b.warn) {
    const d = el("div", "banner");
    d.append(el("span", "grow", b.warn));
    return d;
  }

  if (b.callout) {
    const box = el("div", "act");
    const h = el("div", "h");
    h.append(document.createTextNode(b.callout));
    if (b.kind) h.append(kindChip(b.kind));
    box.append(h);
    const ul = el("ul", "ev");
    for (const item of b.items ?? []) ul.append(el("li", null, item));
    box.append(ul);
    return box;
  }

  if (b.steps) {
    const wrap = el("div", null);
    b.steps.forEach(([title, body], i) => {
      const row = el("div", "sig-row");
      const s = el("div", "s");
      s.append(el("b", null, `${i + 1}. ${title}`));
      s.append(document.createElement("br"));
      s.append(document.createTextNode(body));
      row.append(s);
      wrap.append(row);
    });
    return wrap;
  }

  if (b.kinds) {
    const wrap = el("div", null);
    for (const [cls, label, meaning] of b.kinds) {
      const row = el("div", "sig-row");
      const s = el("div", "s", meaning);
      row.append(s);
      const c = el("div", "band");
      c.append(kindChip(cls));
      row.append(c);
      wrap.append(row);
    }
    return wrap;
  }

  if (b.table) {
    const scroll = el("div", null);
    scroll.style.overflowX = "auto";
    const t = el("table", "tbl");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of b.table.head) hr.append(el("th", null, h));
    thead.append(hr);
    t.append(thead);
    const body = el("tbody");
    for (const r of b.table.rows) {
      const tr = el("tr");
      for (const cell of r) tr.append(el("td", null, cell));
      body.append(tr);
    }
    t.append(body);
    scroll.append(t);
    return scroll;
  }

  return el("p", "note", JSON.stringify(b));
}

/**
 * Render the manual into `wrap`.
 * @param {HTMLElement} wrap
 * @param {(hash: string) => void} go router, so the contents list can jump
 */
export function renderManual(wrap, go) {
  const intro = el("div", "block");
  intro.append(el("h3", null, "How to use Decisions"));
  intro.append(
    el(
      "p",
      null,
      "The whole thing, on one page. If you read one section, read \"Getting started in five minutes\".",
    ),
  );
  const toc = el("div", "pill-row");
  for (const s of MANUAL) {
    const b = el("button", "btn", s.title);
    b.onclick = () => {
      const target = document.getElementById(`help-${s.id}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    toc.append(b);
  }
  intro.append(toc);
  wrap.append(intro);

  for (const section of MANUAL) {
    const box = el("div", "block");
    box.id = `help-${section.id}`;
    box.append(el("h3", null, section.title));
    if (section.blurb) box.append(el("p", "note", section.blurb));
    for (const b of section.blocks) box.append(renderBlock(b));
    wrap.append(box);
  }

  const foot = el("div", "block");
  foot.append(el("h3", null, "More detail"));
  foot.append(
    el(
      "p",
      "note",
      "Fifteen longer pages ship with the program, in the docs/decisions folder where Vireo is installed. They cover the same ground with more examples. Settings shows the exact folder your data is in.",
    ),
  );
  wrap.append(foot);
}
