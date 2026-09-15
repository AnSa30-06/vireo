# What everything does

This page explains the demo company and every feature, in simple English. Each sentence gives
one fact.

---

## What Vireo does

Vireo reads spreadsheets about your customers. It then gives you a short list of customers that
need your attention this week.

Each item on that list is a **decision**. A decision has an owner, a due date, a status, and the
evidence that produced it. A decision comes back to you if you do not handle it.

Vireo does not send email to your customers. It does not change your data. It reads, and it tells
you what it found.

---

## The demo company

The demo company is a made-up software business with **48 customers**. It exists so that you can
see the product work before you import your own data.

To load it, open **Data** and select the demo company. Then open **Today** and select **Run
analysis**.

### What is inside it

The 48 customers are not random. Each one is planted with a known situation, and the count of each
is fixed:

| How many | What is planted | What Vireo must do |
|---|---|---|
| 29 | Healthy customers | Nothing |
| 4 | Clear churn risk | Raise a decision, high or critical |
| 2 | Subtle churn risk | Raise a decision, medium or more |
| 3 | Expansion opportunity | Raise a decision |
| 3 | Payment problem | Raise a decision |
| **4** | **Traps** | **Nothing** |
| 1 | A decision you dismissed, and nothing changed | Stay quiet |
| 1 | A decision you dismissed, and it got worse | Come back |
| 1 | Usage data that stopped arriving | Say the data is stale |

### The four traps are the important part

Four customers look alarming and are fine. Each one has exactly one warning sign and no second
one:

1. One customer has a spike in support tickets.
2. One customer has a short dip in usage.
3. One customer has a renewal date that is close.
4. One customer has a champion who went quiet.

**Vireo must raise nothing for these four.** One warning sign on its own is not a problem. A tool
that reports all four is a tool you stop reading after a week.

### What the demo run produces

The numbers below come from a real run on the demo company:

- **15 decisions** in total. 13 are open. 2 are dismissed.
- By type: **9 churn risks**, **3 payment problems**, **3 expansion opportunities**.
- By severity: **5 critical**, **6 high**, **2 medium**, **2 low**.
- The largest single item is **$73,500** of annual contract value at risk.

---

## Every screen

### Today

Today shows the decisions that need you now. It gives a real count and the revenue under review.

Each decision is a card. A card shows the title, the evidence, the owner, the due date, and the
status. Select a card to open the decision in full.

### Decisions

Decisions shows every decision in the workspace. You can filter by status, severity, type, owner,
and sort order.

The database does the filtering. The count you see is the count the database agrees with.

### One decision

This screen shows one decision in full: the reasoning, the recommended action, the history, and
the evidence.

Every status change is a control on this screen. You can accept, start, mark as waiting, snooze,
resolve with an outcome, dismiss with a reason, reopen, and add a note.

The evidence panel is on the right. It holds a dot grid, where one dot is one person, and a trend
line. If a gap exists in the data, the trend line breaks. Vireo does not draw through a gap,
because a drawn gap is a number that nobody measured.

### Customers

Customers shows every customer, with a filter and a state label. Select a customer to see their
metrics, their signals, and their decisions.

### Ask

Ask answers a question about your customers, in plain English.

Vireo can answer **9 questions**. Each one has a database query that a person wrote by hand. A
model chooses which of the 9 questions you asked. The model never writes the query.

If none of the 9 fits your question, Vireo refuses. The refusal says what it checked and what you
can ask instead. A refusal is better than a number that looks right and is wrong.

Ask works with no model and no internet. It then matches your words against the 9 questions, and
the answer says that this is what happened.

### Segments

A segment is a saved group of customers, built from rules. You can build the rules by hand, or
describe the group in words.

If you describe a group in words, Vireo shows you the rules it wrote. You confirm them before they
are saved. A rule you cannot see is a rule you cannot trust.

The count updates before you save, so you can try a rule first.

### Dashboards

A **metric** is a saved number. A **chart** is a metric with a shape. A **dashboard** is an
ordered set of charts.

Every metric shows the definition it counted by, next to the number. Select **edit** to change
that definition where you are looking at it.

Every number has a link to the rows behind it.

If a chart holds more points than it can draw, it says how many are missing. A chart must never
disagree with the number above it in silence.

### Stories

A story is a report that you can run again. Each run is stored with its date, and a stored run
never changes.

A story can run itself every week. You can export a story as a web page that prints to PDF from
the browser.

### Embed

Embed puts a question box on another web page.

You create a **key**. The key decides what the box can read. The full key is shown once, at the
moment you create it.

A **data scope** limits a key further. A scope names which questions the key can answer and which
rows it can see. The server enforces the scope. Editing the address of the box cannot widen it.

If you widen a scope while a live key uses it, Vireo refuses. It names the keys first, and waits
for you to confirm.

### Data

Data brings customer data in. Drop files on the page, or select a folder on this computer.

Vireo reads the header rows before it imports anything. It then tells you what is wrong, per
file, before the import.

After an import, Vireo shows what it read, what it skipped, and the reason for each skip.

### Settings

Settings holds the thresholds, the demo clock, and the business definitions.

The demo clock pins a date. You can then move the date forward by hand, and watch reminders and
nudges happen. If the clock is pinned, the top bar says so.

---

## The 11 signals

A signal is one measured fact about one customer. Vireo computes all 11 signals with code, not
with a model. The same data always gives the same signal.

| Signal | What it measures |
|---|---|
| Usage down | Active users fell over the last 30 days, against the 30 days before |
| Usage up | Active users rose over the last 30 days |
| Usage down this week | Active users fell over the last 7 days, against the 28 days before |
| Renewal approaching | The renewal date is near |
| Support tickets up | Ticket count rose over the last 30 days |
| Seats under-used | Few of the purchased seats were used in the last 7 days |
| Seats nearly full | Almost all purchased seats are in use |
| Payment failed | A payment did not go through in the last 30 days |
| Champion inactive | The main contact has not been active |
| Pricing interest | Somebody viewed the pricing page in the last 14 days |
| Data is stale | The usage data stops before today |

Each signal has bands. A band sets how serious the signal is. For example, "Usage down" has bands
at **-25%**, **-40%** and **-60%**.

You can change every threshold in Settings. The shipped value is shown next to the value you set.

---

## What becomes a decision

A single signal is never a decision. Vireo raises a decision only when signals combine.

There are **4 kinds** of decision:

| Kind | It needs this | And at least one of these |
|---|---|---|
| Churn risk | Usage down | Renewal approaching, Support tickets up, Champion inactive, Seats under-used |
| Expansion | Usage up | Seats nearly full, Pricing interest |
| Payment problem | Payment failed | Usage down, Champion inactive |
| Company-wide change | The same movement across many customers at once | — |

The severity comes from a score. The score is the sum of the bands of the signals that matched.
A score of **8** is critical. A score of **6** is high. A score of **4** is medium.

The model does not choose the severity. Code chooses it, so the same evidence always gives the
same answer.

---

## The 6 actions

Vireo recommends one action per decision. It chooses from a fixed list of 6:

1. Executive outreach call
2. Technical health review with the customer
3. Start the renewal conversation early
4. Contact the billing owner about the failed payment
5. Contact the account owner about adding seats
6. Keep watching; no action yet

The model cannot invent a seventh action. If it tries, Vireo rejects the answer.

---

## The life of a decision

A decision moves through these statuses: **new**, **accepted**, **in progress**, **waiting**,
**snoozed**, **resolved**, **dismissed**.

Some rules hold this together:

- If you dismiss a decision and nothing changes, it stays quiet for 14 days.
- If you dismiss a decision and it gets worse, it comes back.
- If a decision waits for more than 7 days, Vireo nudges you once.
- If a decision passes its due date, Vireo reminds you once a day, not once a run.
- If you resolve a decision, you must record the outcome.
- If you dismiss a decision, you must give a reason.

---

## What Vireo will not do

- It will not send email to your customers.
- It will not change your data. Every database connection is read-only.
- It will not show a number without the evidence behind it.
- It will not invent an answer. If it cannot answer, it says so.
- It will not load anything from the internet. The app works with no network.
