# "Why not just upload the spreadsheet to ChatGPT?"

You will be asked this in the first three minutes. This page is the answer, with
the evidence behind it.

The short version: **a general model reading a spreadsheet is measured at roughly
half of human accuracy on realistic tables, and it collapses exactly where the
money is — on aggregation and on large files.** We do not ask a model to read the
table. We compute the answer, and use the model only to explain it.

---

## 1. The measured case

These are published benchmarks, not our opinion.

### Real-world table questions: models score about half of human

**TableBench** (arXiv:2408.09174, 886 questions across 18 fields, built
specifically because "academic benchmarks" did not reflect industry use):

| | Overall score |
|---|---|
| Humans | **85.91** |
| GPT-4o | **42.73** |
| GPT-4-Turbo | **40.38** |

These are the **Direct Prompting** column of the paper's Table 4 — the model
answering without being walked through intermediate steps. The paper's own
summary: *"the most advanced model, GPT-4, achieves only a modest score compared
to humans."*

⚠️ **Say "GPT-4o, 2024" when you quote this.** Newer models score better, and
somebody who follows the field will know that. The next benchmark is the one to
lead with, because it is recent and it tests the current models.

### On financial spreadsheets, accuracy collapses with complexity — and this is 2026 models

**FinSheet-Bench** (arXiv:2603.07316, March 2026) tests ten model configurations
from OpenAI, Google and Anthropic — including **GPT-5.2 with reasoning, Gemini 3.1
Pro and Claude Opus 4.6 with thinking** — on private-equity fund templates.

The best model overall, Gemini 3.1 Pro, scores **82.4%**. That is roughly one
error in every six questions. Then it comes apart by task:

| Task | All models | Best three models |
|---|---|---|
| Simple lookup | **89.1%** | 93.6% |
| Complex aggregation | **19.6%** | **33.3%** |

And by file size: the simplest file scores **86.2%**, the largest (152 companies,
8 funds) scores **48.6%** averaged across all models.

Read that twice. **Aggregation is the operation a business actually needs** —
totals by segment, revenue at risk, how a cohort moved — and even the three
strongest models available get it right one time in three.

⭐ **The strongest line you have is the paper's own conclusion, not a number:**

> *"no standalone model achieves error rates low enough for unsupervised use in
> professional finance applications."*

That is a 2026 paper, testing 2026 models, saying the thing this product exists to
fix. Quote it exactly.

### It cannot reliably find a single cell

**SUC benchmark** (Sui et al., WSDM 2024, arXiv:2305.13062), direct cell lookup —
"what is the value at this row and column":

| | Accuracy |
|---|---|
| GPT-3.5 | **44%** |
| GPT-4 | **73.34%** |

A spreadsheet formula does this in microseconds, exactly, every time.

Two more findings from the same work:

- **Take away the one worked example and accuracy falls 30.38%.** The paper:
  *"performance drops significantly when it is in a zero-shot setting, with an
  overall accuracy decrease of 30.38% on all tasks using HTML format."* The
  structural understanding is scaffolded by demonstration, not internalised.
- **How you write the table down changes the score by 6.76%.** Serialising it as
  HTML beats plain text with separators by that much. The model's accuracy
  depends on a formatting choice made before it ever saw a number.

### Long tables break it outright

The TMLR survey on LLMs and tabular data (arXiv:2402.17944) reports performance
degrading **towards random beyond about 1,000 tokens** of table. Large context
windows do not fix this: attention cost grows with the square of the length, and
the accuracy does not follow the window size.

A thousand tokens is roughly **forty rows**. A real customer book is thousands.

---

## 2. What this means for the person doing the work

The failure is not that it says "I do not know". The failure is that **it gives
you a number, in a confident sentence, and the number is wrong.**

You cannot tell which answers are the 42% and which are the 58%. Every figure has
to be checked by hand, which is the work you were trying to avoid. One wrong
number that reaches a customer conversation costs more trust than ten right ones
build.

And a chat has no memory of a decision. You ask, you get an answer, you close the
tab. Next month nobody knows the question was asked, what was decided, whether it
was done, or whether it worked.

---

## 3. What we do instead

**We never ask a model to read the table.**

### The numbers are computed, not generated

Every signal — usage down 38%, renewal in 21 days, three failed payments, the
champion inactive for 30 days — is computed by code against a real database.
Same data in, same number out, every time. There is no sampling, no temperature,
no context window.

The model is given the *finished facts* and asked only to write the explanation.
It never sees the table, so it cannot misread it.

### The model works inside a fixed catalogue

When you type a question, the model's only job is to choose which of a fixed set
of questions you asked and fill in the parameters. It never writes a query. An
answer it returns that is not in the catalogue is rejected before anything runs.

If nothing fits, it refuses and says what it checked. **An honest refusal is a
feature.** That is the direct answer to the 42%: we would rather return nothing
than return a plausible wrong number.

### Every number carries its evidence

Each figure opens onto the rows it was counted from, and the definition it was
counted by. You can check any answer in one click. With a chat window you cannot
check anything without redoing the work yourself.

### The data is a graph, not a dump

This is the part that a bigger context window cannot replicate.

When you paste a spreadsheet into a chat, the model gets a flat block of text
with no idea which column is a key, which rows relate, or what happened before
what. It has to infer structure from the characters, which is precisely what the
44%-cell-lookup number measures.

We build a **linked model of the business** instead: customers joined to their
contacts, their tickets, their invoices, their usage history, their events and
their past decisions, with typed relationships between them. Questions that a
flat table cannot answer become ordinary graph queries:

- which customers share a champion who has gone quiet
- what else was happening in the weeks before this account's usage fell
- which accounts moved together, and therefore have a common cause
- what we decided last time this happened to this customer, and whether it worked

That structure is computed once, exactly, and stays. It is memory and it is
context, and neither is a prompt.

---

## 4. The honest limits

An investor will respect this more than a clean sweep.

- **A general model is better at open-ended questions.** Ask "what should our
  pricing strategy be" and ChatGPT is more useful. We answer a fixed catalogue
  about your own customers, exactly, and refuse the rest.
- **We need your data in a known shape.** Six spreadsheets with named columns.
  ChatGPT will take anything, and be confidently wrong about it.
- **The benchmark numbers above are about general models reading raw tables.**
  They are not a measurement of our product. They are the reason our product is
  built the way it is.
- **We have not published our own benchmark yet.** The demo company has planted
  situations with known right answers — including four traps that must produce
  nothing — which is the beginning of one, not the end.

---

## 5. The sentence to say out loud

> A benchmark published this March tested GPT-5.2, Gemini 3.1 and Claude Opus on
> real financial spreadsheets. The best model got 82%. On the aggregations a
> business actually runs on, the best three got 33%. The authors' own conclusion
> is that no model is accurate enough to use unsupervised. So we do not let a
> model near the arithmetic. We compute every number in code, keep the
> relationships between your customers as a graph, and use the model only to
> explain what was found — with the evidence attached, so you can check it in one
> click.

**Why this version and not the 42% one.** "ChatGPT is right 42% of the time"
sounds stronger and is easier to knock down: it is a 2024 model, and anyone who
follows the field will say so. **82% from a 2026 frontier model is the more
frightening number**, because it is high enough to trust and wrong often enough to
hurt you — and you cannot tell which answer is which.

---

## Sources

| Claim | Source | Checked |
|---|---|---|
| Human 85.91, GPT-4o 42.73, GPT-4-Turbo 40.38 — Direct Prompting, Table 4 | TableBench, arXiv:2408.09174 (AAAI 2025) | ✅ primary |
| Best model 82.4% (Gemini 3.1 Pro); simple lookup 89.1% / 93.6%; complex aggregation 19.6% / 33.3%; 86.2% → 48.6% by file size; "no standalone model achieves error rates low enough for unsupervised use" | FinSheet-Bench, arXiv:2603.07316 (Mar 2026) | ✅ primary |
| Cell lookup 44.00% (GPT-3.5) / 73.34% (GPT-4); −30.38% zero-shot on all tasks; +6.76% for HTML over text-with-separators | Sui et al., WSDM 2024, arXiv:2305.13062 | ✅ primary |
| Degrades towards random beyond ~1,000 tokens of table | Fang et al., TMLR 2024, arXiv:2402.17944 | abstract only |
| 96% token reduction from structural encoding | SpreadsheetLLM / SheetCompressor, Microsoft, arXiv:2407.09025 | abstract only |

**Where the numbers came from.** The first three rows were read off each paper's
own results tables on 17 September 2026 and match to the decimal place. An earlier
draft of this page took them from a secondary analysis, and that draft got two
things wrong, both of which an investor could have caught:

1. It called the TableBench figures plain "accuracy". They are **Direct Prompting
   overall scores** from Table 4. Anyone opening the paper sees a different-looking
   table and concludes you did not read it.
2. It described the 6.76% as **the spread between HTML, XML, JSON and Markdown**.
   It is not. It is the gain from using HTML over plain text with separators.

**The last two rows are still from abstracts only.** Open those papers before you
quote a figure from them.
