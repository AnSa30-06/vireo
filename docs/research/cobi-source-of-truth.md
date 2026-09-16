# Cobi: the source of truth for the Ledgerline clone

*Collected 2026-09-15 by live scrape of `hellocobi.com`, `docs.hellocobi.com` (all 66 pages
indexed in their own `llms.txt`), `app.hellocobi.com`, and category research into why tools of
this kind fail. **This document is the specification.** Where Ledgerline and this document disagree,
this document wins. Where this document is silent, it says so rather than guessing.*

**Facts** are quoted or closely paraphrased from a named source. **Read** is our analysis and
carries no authority of its own.

---

## 1. What Cobi actually is

There are two Cobis, and the gap between them is the opportunity.

**Fact, the marketing.** *"AI Decision Stack for Customer Intelligence. Stop Guessing What Your
Customers Want. Cobi reads their actual behaviour, tells you what they care about right now, and
shows you exactly what to do about it."* Four pillars are named on the homepage: **Clarity,
Insight, Action, Autonomy**. Source: [hellocobi.com](https://www.hellocobi.com/).

**Fact, the documentation.** *"Cobi is an AI-powered data analytics platform that lets you ask
questions about your data in plain English, no SQL required. Connect your database and the Data
Assistant handles the rest."* Source:
[introduction](https://docs.hellocobi.com/introduction.md).

**Fact, the *Act* pillar.** *"Build an audience for your next move. **Coming next:** share useful
context with your team and prepare customer messages for your connected channels."* Source:
[hellocobi.com](https://www.hellocobi.com/).

**Read.** The shipped product is a text-to-SQL assistant with saved analysis, scheduled reports
and segments. The "decision stack" is a direction of travel. The word *decision* does not appear
anywhere in 66 pages of documentation; neither do *alert*, *notification*, *evidence* or *next
best action*. **Act is labelled "Coming next" by Cobi itself.** That is the hole the clone fills.

---

## 2. The real feature surface

The pricing page is the honest specification — it is what they meter, therefore what exists.
Source: [pricing](https://www.hellocobi.com/pricing).

| Capability group | The actual features | Starter $19 | Pro $49 | Team $59/seat |
|---|---|---|---|---|
| **Answers from your data** | Ask in plain English using your own business terms | 100 questions/mo | 300/mo | 400/seat, pooled |
| | Knowledge base items (definitions + data source context) | 10 | 25 | 100 |
| **Metrics, charts, dashboards** | Saved metrics | 10 | 25 | 25/seat → 150 |
| | Saved charts | 10 | 100 | 500 |
| | Saved dashboards | 1 | 10 | 100 |
| | Charts per dashboard | 10 | 25 | 50 |
| **Stories and reporting** | Stories per month | — | 5 | 5/seat → 50 |
| | Weekly scheduled Stories | — | yes | yes |
| | PDF export | — | yes | yes |
| **Agentic analysis** | Proactive analysis run across the workspace between your questions | — | Weekly | Daily suggestions, weekly data scans |
| **Data** | Data sources (apps, databases, uploaded CSVs) | 1 | 2 | 5, shared |
| | CSV upload · App connectors · Database connections · Manual data sync | yes | yes | yes |
| **Audiences** | Saved segments | 10 | 25 | 25/seat → 250 |
| | **Create segments with AI** — describe a customer group, it becomes segment criteria | yes | yes | yes |
| **Workspace** | Seats; shared workspace; admin and member roles | 1 | 1 | 2+ |
| | Pooled allowances, centralised billing | — | — | yes |
| | Embedded chat | — | add-on | yes |
| **Enterprise** | Deployment options and data residency | — | — | "Let's talk" |

**Read.** The unit of value they sell is **a question**. Not a decision, not an outcome. Every
limit in that table counts stored artefacts or questions asked.

---

## 3. How it works, mechanically

### 3.1 Getting data in — two routes

**Fact.** *"There are two ways to get your data into Cobi."* Either connect a live database that
Cobi queries in real time, or push records to a hosted Data API. Source:
[introduction](https://docs.hellocobi.com/introduction.md).

**Fact, connectors.** Documented: **PostgreSQL 12+, MySQL 8.0+, MongoDB** (Atlas SRV and
self-hosted). *"All database connections are **read-only**. Cobi will never modify your data."*
Connection form fields: Connection Name, Host, Port, Database Name, Username, Password, then
**Test Connection** → **Save Changes**. Firewall access is by **IP allowlisting** (addresses given
by support, per region); SSH tunnels and bastion hosts are "contact support". Source:
[connectors overview](https://docs.hellocobi.com/platform/data-connectors/overview.md).

⚠️ **The 30-logo integrations wall on the homepage — Snowflake, BigQuery, Databricks, Stripe,
HubSpot, Salesforce, Shopify, Zendesk, Intercom, Mailchimp, Kafka, ClickHouse and more — is not
matched by the documentation, which documents exactly three.** Source:
[homepage](https://www.hellocobi.com/) vs [llms.txt](https://docs.hellocobi.com/llms.txt).

**Fact, the Data API.** `POST /v1/data/:type` at `api.hellocobi.com`, Bearer auth, **batches of up
to 5,000 records**. Types: customers, transactions, offers, shops, branches, categories,
shop-categories, tags, shop-tags, keywords, shop-keywords, student-favourites, institutes,
courses, user-interactions (items: TAG, OFFER, SHOP, KEYWORD). Dependencies are ordered — shops
before branches. Responses carry `request_id`, per-batch `status`, and `success | partial | error`.
Source: [data API overview](https://docs.hellocobi.com/api-reference/data/overview.md),
[quickstart](https://docs.hellocobi.com/quickstart.md).

**Read.** That record list is a **student-discount / loyalty-wallet schema**, not a general
business one. `student_favourites`, `institutes`, `courses` and the required Customer fields
(`customer_id`, `user_id`, `region`) give the real origin away.

### 3.2 Teaching it the business — the part that matters most

**Fact, Custom Instructions.** Free text you write, holding business context, key terminology,
revenue sources, query guidance, status-code meanings, and join rules. Their own example:
*"'Active users' = users who have logged in within the last 30 days (check `last_login` column)"*
and *"Payment status 1 = paid, 0 = unpaid"*. Reached via **Developer → Data Connectors → [source]
→ Custom Instructions tab**. Source:
[custom instructions](https://docs.hellocobi.com/platform/custom-instructions.md).

**Fact, Learned Information.** *"Cobi automatically builds **Learned Information** as you interact
with the Data Assistant"* — table and column descriptions, relationships, common query patterns.
It is viewable and **editable** in its own tab. Source: same page.

**Fact, the failure path they document.** If Cobi gets it wrong: clarify instructions, add
examples, *"Correct any Learned Information that may be inaccurate"*, rephrase the question. And
instructions only take effect in a **new conversation**. Source: same page.

**Read.** Cobi's answer to wrongness is "write better instructions". The burden is on the user, the
fix is invisible, and a stale Learned Information row silently poisons every future answer.

### 3.3 Where you use it — three channels

| Channel | What it does | Source |
|---|---|---|
| **Data Assistant** | The web app chat, at `app.hellocobi.com` | [introduction](https://docs.hellocobi.com/introduction.md) |
| **Embed widget** | `app.hellocobi.com/embed/chat` in an iframe | [chat widget](https://docs.hellocobi.com/platform/channels/embed-chat-widget.md) |
| **Slack** | Mention, DM, thread follow-ups, `/cobi` | [slack](https://docs.hellocobi.com/platform/channels/slack/overview.md) |

**Fact, Slack.** One command, `/cobi`, with subcommands `help`, `status`, `link` (private) and
`ask`, `chart`, `table` (public thread). It replies **in a thread**, attaches a chart image or a
table/CSV artifact, offers an **Open Cobi** button, and collects 👍/👎 feedback. *"Cobi is designed
to stay quiet in normal channel conversation."* Source:
[slash commands](https://docs.hellocobi.com/platform/channels/slack/slash-commands.md),
[using cobi](https://docs.hellocobi.com/platform/channels/slack/using-cobi.md).

**Fact, embed widget.** Embed keys are created in **Developer → Channels**. Fields: Name, Data
Source, Data Scope (optional), Allowed Origins (optional), Expiry Date (optional), Chat History
(optional). *"The full API key is only shown once at creation time."* URL parameters: `key`,
`scopeId`, `theme` (`light`/`dark`/`system`), `chatHistory`, `userId`. **Rate limit 1,000 requests
per hour**, returning `429` with `Retry-After`. Keys are hashed at rest, only the first 18
characters stored. Source:
[chat widget](https://docs.hellocobi.com/platform/channels/embed-chat-widget.md).

**Fact, Data Scopes** — their multi-tenant security model, and genuinely the best-engineered thing
they document. A scope names (a) which **tables** a key may query and (b) a **row-level filter**:
a *scope table* and *scope column*, so a query is rewritten as `WHERE outlets.id = 'outlet_42'`.
The creation wizard is three steps: **Name/Description → Row-level scope + Table access → Review
scope**. Table access separates **Related tables** ("contain a foreign key referencing the scope
column … safest to include") from **Other tables** ("will not be row-filtered"). Enforcement is
server-side and *"cannot be bypassed by modifying the iframe URL"*. A scope on a key is
**permanent** — change means a new key. Source:
[data scopes](https://docs.hellocobi.com/platform/channels/data-scopes.md).

⚠️ **A documented footgun:** *"Deleting a scope does not automatically revoke the embed keys
assigned to it. Those keys will revert to having no scope, potentially exposing more data than
intended."* Source: same page.

### 3.4 The recommendation engine

**Fact.** `GET /v1/recommendations/customers/{id}` and `/segments/{id}`. Returns an array of
`{ name, student_id, offers[] }` — **offer UUIDs and nothing else**. 1,000 requests/minute.
Source: [recommendations](https://docs.hellocobi.com/api-reference/recommendations/overview.md).

**Read.** No score, no reason, no confidence, no explanation. The response literally still calls
the subject `student_id`. This is a consumer offer-ranker, unrelated to the "decision stack".

---

## 4. The UI, as far as it can be established

`app.hellocobi.com` is behind a login wall (`/auth/sign-in`, `/auth/sign-up`) and returned no
usable HTML to a scrape. **The interface below is reconstructed from documented navigation paths,
not from seeing it. Anything not listed here is unknown and must not be invented.**

**Known, because the docs give click paths:**

- A **left sidebar** with a **Developer** section containing **Data Connectors** and **Channels**.
- **Data Connectors**: an **Add Data Source** button; a connection form; a modal per source with
  tabs **Custom Instructions** and **Learned Information**; **Test Connection**, **Save Changes**,
  **Delete Connection**.
- **Channels**: **Create Embed Key**, a **Scopes** tab, **Create Scope**, a multi-step wizard with
  **Next** buttons and a **Review scope** summary, and a **Filter tables** search box.
- Light / dark / system theming is a first-class concept (the embed takes it as a parameter).

**Known, from the marketing hero** — one concrete answer rendering, worth copying because it is
their single best idea:

> *"How many new customers transacted again?"* → *"36 of 120 customers transacted again"*,
> shown as a dot grid split 36 / 84, captioned **"One dot, one person."**

Source: [hellocobi.com](https://www.hellocobi.com/).

**Also named on the marketing site:** customer state chips — High value, New user, Activated,
At risk, Retained, Power user, Upsell ready, Dormant.

---

## 5. Who they sell to (ICP)

**Fact, stated.** *"Product marketing, growth and customer experience teams"* at *"organizations
with multiple products, propositions and customer segments"*. Geography: *"the Middle East remains
our immediate focus"*, then North and Sub-Saharan Africa, then the US. Source:
[press](https://www.hellocobi.com/press).

**Fact, revealed.** The one contracted deployment is **eNovate** (eFinance, Egypt), five years,
starting with the **Rize youth digital wallet**, initial deployment Q1 2026. Every other
enterprise name is attached to the words *"to explore"*. Source:
[press](https://www.hellocobi.com/press), [TechAfrica News](https://techafricanews.com/2026/02/17/enovate-and-cobi-integrate-ai-intelligence-to-transform-egypts-digital-payment-experience/).

**Fact, the pricing ICP.** Starter and Pro are explicitly *"For individuals"*. Team is *"For teams
sharing data, business context, metrics, and dashboards."* Source:
[pricing](https://www.hellocobi.com/pricing).

**Read — the ICP splits in three and they have not chosen:**

1. **Sold to**: a growth/product-marketing individual at $19–49, self-serve, credit card.
2. **Deployed for**: GCC/Egypt consumer fintech, on-premises Helm chart, five-year contracts.
3. **Priced for**: a single seat. There is no decision-ownership model because there is no team
   model below $59.

**The clone should target (1)** — the self-serve operator who has customer data in a spreadsheet
or a database and no analyst.

---

## 6. Weaknesses to fix — the actual brief

No Cobi review exists on G2, Capterra or Product Hunt (searched 2026-09-15; also searched
2026-09-09). So the weaknesses come from two places: what their own documentation admits, and what
the category is measured to get wrong.

### 6.1 Category failures, measured

| Finding | Source |
|---|---|
| **"Text-to-SQL accuracy collapses from 86% on academic benchmarks to 0–6% on real enterprise databases (Spider 2.0). The issue is architectural."** | [Text-to-SQL Alternative](https://www.google.com/search?q=text-to-sql+accuracy+collapses+spider+2.0) (search result, 2026-08-01) |
| *"An accuracy of 80% or even 90% is, unfortunately, not enough. You cannot compromise on accuracy because it immediately erodes trust."* | "Why 90% Accuracy in Text-to-SQL is 100% Useless" |
| *"A single plausible-looking wrong number erodes more trust than ten correct answers build."* | "Why Text-to-SQL Accuracy Decides Whether Users Trust AI" |
| Failures are structural: domain-specific metrics the model cannot interpret, and **non-determinism** — the same question answered twice differently | "Why text-to-SQL fails" |
| *"AI data analytics tools must operate on structured business definitions rather than raw database schemas."* | "AI Data Analytics Tools in 2026" |
| "Can you verify why AI gave that answer" is a recurring, unmet user demand | search result title, 2026-09-15 |

### 6.2 Cobi's own admitted weaknesses

| Weakness | Evidence |
|---|---|
| Integrations wall advertises ~30 sources; docs support **3** | homepage vs llms.txt |
| *Act* — the entire third pillar — is **"Coming next"** | homepage |
| No decision object: no owner, due date, status, reminder, audit trail or outcome anywhere in 66 doc pages | llms.txt, full-text absence of "decision"/"alert"/"evidence" |
| Recommendations return bare UUIDs with no reason or score | recommendations overview |
| Deleting a data scope silently **widens** the access of every key using it | data scopes |
| Custom Instructions only apply to a **new** conversation | custom instructions |
| Correcting a wrong answer is manual prose editing by the user | custom instructions |
| ISO 27001 *"In progress"*, GDPR *"Coming soon"* | [trust centre](https://trust.hellocobi.com/) |
| Homepage claims 12x / 68% / 3.8x / 89% with **no method and no source** | homepage |
| Priced per **question**, which penalises exploration — the thing the product is for | pricing |

### 6.3 What the clone must therefore do differently

1. **Never present a number without the evidence that produced it**, one click away.
2. **Determinism where determinism is possible.** Thresholds and metrics are computed by code, not
   by a model. The model explains; it does not count.
3. **A decision is an object**, not a message: it has an owner, a status, a due date, an audit
   trail and a recorded outcome.
4. **Business definitions are structured records**, not a free-text blob — versioned, testable, and
   able to say when they were last correct.
5. **Say "I don't know."** An explicit refusal beats a plausible wrong number.
6. **Do not meter curiosity.** Questions must not be the unit of price.
7. **Correcting the system must take one click** from the wrong answer, not an essay in a settings
   tab.
8. **Ship the connectors you advertise**, or advertise only what ships.

---

## 7. What is deliberately NOT known

Honesty about gaps, so nothing here gets invented later:

- **The real UI.** Never seen. Login-walled. Section 4 is reconstruction from click paths only.
- **Screenshots.** The docs reference images (`/images/platform/data-connector-form.png`) but every
  one is commented out in the published markdown.
- **What "Stories" actually look like.** Named in pricing and on the homepage, documented nowhere.
- **What "agentic analysis" actually does.** Sold at two tiers, documented nowhere.
- **What the "app connectors" are.** Metered in pricing, absent from the docs.
- **Any customer review, rating or public complaint.** None exists.
- **Retention periods, hosting regions, subprocessor list detail.** Behind "Request access".
