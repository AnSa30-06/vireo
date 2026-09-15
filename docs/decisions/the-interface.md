# The Decisions interface

There are two browser surfaces in this app, and they are not the same thing.

| | where | what it is |
|---|---|---|
| The agent | `/` | the chat-and-code workspace, the original product |
| **Decisions** | `/v2/` | the customer decision system described here |

`/v2/` is a separate set of files under `src/ui/public/v2/`. It shares the server, the token and
the route table with the agent UI, and nothing else — no CSS, no JavaScript, no layout.

---

## The idea the screens are built around

A recommendation shown once and forgotten is what a dashboard already does. **A decision here is a
record**: it has an owner, a due date, a status, a history and — when it ends — a recorded outcome.
It comes back if you ignore it.

That is the whole difference from the products this one is modelled on, and it is why the list is
laid out like a table of work items rather than a feed of alerts.

The second rule is that **no number appears without the evidence that produced it**. Every figure
on a decision opens onto the signals it was computed from. When the model cannot write a brief, the
page says so in those words and still shows the evidence, rather than inventing prose.

---

## The screens

**Today** — the landing page. What needs you this week, and nothing else. It states a real count
and the revenue under review, both read from the workspace.

**Decisions** — everything, filtered. Status, severity, kind, owner and sort. The filtering happens
in SQL on the server, so the count you see is the count the database agrees with.

**One decision** — the full record: the reasoning, the recommended action, the history, and the
evidence rail. Every status change the engine allows is a control here — accept, start, mark
waiting, snooze, resolve with an outcome, dismiss with a reason, reopen, add a note.

**Customers** — the list, filterable by state, and one customer's metrics, signals and decisions.

**Ask** — a question about your customers in plain English.

**Segments** — saved customer groups, with the matching count previewed before you save.

**Dashboards** — saved metrics, saved charts and boards. Each metric shows the **definition it
counted by**, right next to the number and editable in one click. A wrong number is fixed where
you are looking at it, not in a settings page somewhere else.

**Stories** — a report you can run again. Each run is stored with its date and **never changes
afterwards**, so last month's story still says what it said last month. A story can run itself
weekly, and exports as a self-contained HTML file that prints to PDF from the browser.

**Embed** — a question box for another page, with **data scopes**: which questions a key may
answer and a row filter so each caller sees only their own rows. All of it enforced on the server.

**Data** — getting data in. Drop files on the page or point it at a folder; either way you see what
was read, what was skipped and why, per file.

**Settings** — thresholds, the demo clock, and the business definitions.

---

## The evidence rail

Two visuals, both drawn as inline SVG with no library.

**The dot grid.** One dot is one person. Filled for the affected group, hollow for the rest. Above a
few hundred it switches to one dot per N and says so in the caption, because four thousand circles
is not a chart. It carries a text alternative stating the real ratio, since a dot grid means nothing
to a screen reader.

**The sparkline.** A trend line, no axes. A gap in the data **breaks the line** rather than drawing
through it — an interpolated gap is a number nobody measured.

---

## Things worth knowing

**The demo clock.** Settings can pin the date and advance it by hand. Everything the engine stamps
uses that pinned date, so advancing nine days really does fire a seven-day reminder. When the clock
is pinned the top bar says so — without that, a pinned clock looks like a broken app.

**No workspace is not an error.** Most routes cannot answer until a workspace is selected, so the
shell asks for one instead of letting every page render its own failure.

**Nothing loads from the internet.** The server sends a content-security-policy that permits only
same-origin resources, and `tests/unit/v2-ui.test.mjs` fails if any file references an external URL.
The app works with no network and no model configured.

**A request body must be `application/json`.** This looks like hygiene and is a security control.
A cross-origin request escapes its browser safety check only while it stays "simple", and a JSON
content type is not simple — the browser preflights it, this server answers with nothing, and the
request never happens. Before that check existed, a `text/plain` POST from any website, carrying a
leaked token, executed the route. `tests/unit/server-csrf.test.mjs` holds the line.

**Widening a data scope asks first.** Deleting a scope already refused while live keys pointed at
it; editing one did not, and the two are the same leak. A change that grants a scope *more* than it
has now names the keys it would affect and waits. Narrowing never asks, because a guard that
blocked every edit would push people to delete and recreate instead.

**A chart says what it did not draw.** Long histories are capped, and the cap keeps the most recent
buckets and prints how many are missing. A picture that quietly disagrees with the number above it
is the exact failure this product argues against.

---

## For anyone editing it

Every page is an ES module with exactly this shape:

```js
export const title = "Today";
export async function render(root, ctx) { ... }
```

`root` is an element you own; clear it first, because `render` may be called again on the same one.
`ctx` gives you `api(name, {body, query})`, `go(route)`, a shared `state` object, `fmt` helpers, and
the parsed `route` and `params`.

`tests/unit/v2-ui.test.mjs` will fail the build if a page calls a route that does not exist, assigns
`innerHTML` from a value, chains off `Node.append()` (it returns undefined and has broken a page
here before), references an external URL, or forgets its `render` export.
