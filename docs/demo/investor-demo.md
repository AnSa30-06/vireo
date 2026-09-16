# The investor demo, start to finish

*Read this once the night before. Read the "Before the meeting" list again an hour
before. Do not read this during the demo.*

**Total time on screen: about 11 minutes.** That leaves room for questions in a
15-minute slot, and questions are where you win. Do not fill the whole slot.

---

## The one thing to remember

**You are not demonstrating an AI. You are demonstrating a system that refuses to
guess.**

Every time you are tempted to say "the AI works out that…", say instead "the code
computes that, and here is the evidence". The trap section in the middle of this
demo is the strongest moment you have, and it is strong precisely because
**nothing happens**.

---

## Before the meeting

Do all of this an hour before, not five minutes before.

### 1. Load the demo company

Open the app and go to **Data**. Press **Load the demo company**. Wait for it to
finish. It takes under a minute.

Then press **Run the analysis**. Wait for it to finish.

> **Why you do this early:** the first run on a fresh install is the slowest one.
> Doing it in the room is dead air.

### 2. Check the three screens you will show

Click through **Why this exists**, **Today** and **Graph**. Look at each one. If a
screen is empty or says "no data", run the analysis again before you worry.

### 3. Write two numbers on your hand

From the **Today** screen, note:

- how many decisions are waiting
- how much revenue is under review

You will say these out loud in the first minute. **Read them off the screen on the
day** — the demo company is generated fresh, so do not memorise numbers from
practice.

### 4. Close everything else

Close your email, your chat, your other browser tabs. Put the laptop on Do Not
Disturb. A notification popping up mid-demo costs you the room's attention for
thirty seconds.

### 5. Have this ready as a fallback

Keep `docs/pitch/why-not-chatgpt.md` open in a second window, minimised. If the
app fails completely, you talk from that document and the demo becomes a
conversation. That is a recoverable meeting. Fumbling with a broken app is not.

---

## The demo

### Beat 1 — The problem, before you touch the laptop (60 seconds)

Say this without a screen up. Look at them, not the machine.

> "Every company I have talked to has the same problem. The answer to 'which
> customer is about to leave' is already sitting in their spreadsheets. Nobody
> reads five spreadsheets for every customer every week, so nobody finds it until
> the customer is gone.
>
> The obvious fix is to paste the spreadsheet into ChatGPT. That does not work,
> and it does not work in a measurable way. I will show you the number in a
> second."

**Do not apologise for the product being early. Do not say "it's just a prototype".**

### Beat 2 — Why this exists (90 seconds)

Open the **Why this exists** screen.

Point at the comparison. Say:

> "There is a benchmark published this March that tested GPT-5.2, Gemini 3.1 and
> Claude Opus on real financial spreadsheets. The best model scored 82%. On the
> aggregations a business actually runs on — totals by segment, revenue at risk —
> the best three models scored 33%.
>
> The authors' own conclusion is that no model is accurate enough to use without a
> human checking it.
>
> And the problem is not that it says 'I don't know'. The problem is that 82% is
> high enough to trust, and you cannot tell which one in six is wrong."

⚠️ **Lead with 82%, not with 43%.** The 43% figure is GPT-4o from 2024. If anyone
in the room follows this field they will say "that's an old model", and you will
spend two minutes defending a number instead of showing your product. **82% from a
current model is the more frightening statistic anyway** — high enough to rely on,
wrong often enough to cost you a customer.

Then point at the live numbers on the same screen and say:

> "Those figures on the right are not a slide. They are this workspace, right now."

Read the two numbers you wrote on your hand.

**Do not read the whole screen aloud.** They can read. You are pointing.

### Beat 3 — Today (90 seconds)

Open **Today**.

> "This is what the person doing the work sees on a Monday morning. Not a
> dashboard. A short list of decisions, ranked by what they are worth."

Click into the top decision.

> "Every number here opens. Watch."

Click one figure to show the rows it was counted from.

> "That is the whole design. A number you cannot check is a number you have to
> re-do by hand, which is the work we were trying to remove."

### Beat 4 — The traps. This is your best moment. (2 minutes)

Slow down here. This beat is worth the other ten.

> "Now let me show you the part I am actually proud of, and it is the part where
> nothing happens.
>
> Inside this demo company I planted four customers that look like they are in
> trouble. One has a big usage drop — but it is a seasonal one they have had every
> year. One has an angry support ticket — from a person who is not the decision
> maker. One has a failed payment — that was retried and cleared two days later.
> One went quiet — because their whole office is on holiday.
>
> Every one of those sets off an alert in a normal tool. **Every one of them is
> silent here.**"

Show the customers. Show that they carry no open decision.

> "Anyone can build something that flags things. The hard part, and the reason
> people turn these tools off within a month, is not flagging the four that do not
> matter."

**Pause after that.** Let it sit. Do not rush into the next screen.

### Beat 5 — Ask (90 seconds)

Open **Ask**. Type a real question, for example:

> which enterprise customers renew in the next sixty days

Show the answer with its evidence.

Then — and this matters more than the answer — type something the product cannot
do:

> what should our pricing be

> "It refuses. It tells you what it checked and why it cannot answer. That is
> deliberate. The model is never allowed to write a query or invent a number — it
> only picks from a fixed list of questions and fills in the blanks. If nothing
> fits, you get nothing.
>
> An honest refusal is the feature. It is the direct answer to the 43%."

### Beat 6 — The graph (2 minutes)

Open **Graph**.

> "This is the part a bigger context window cannot copy.
>
> When you paste a spreadsheet into a chat, the model gets a flat block of text. It
> has to work out which column is a key and which rows relate, from the characters.
> That is exactly what the 43% measures.
>
> We do not do that. We build a linked model of the business — customers joined to
> their contacts, tickets, invoices, usage and past decisions — computed once, in
> code, exactly."

Click a customer node. Show its neighbours. Show its timeline.

> "That timeline is every event across five separate spreadsheets, in order, for
> one customer. No chat window can answer that at all, because it never had the
> relationships in the first place."

If you have time, show two accounts that moved together.

> "These two moved at the same time. They share an owner. That is a common cause,
> not two coincidences — and you can only see it if the data is a graph."

### Beat 7 — It remembers (60 seconds)

Open a customer with history.

> "Last quarter somebody made a decision about this account. What they decided,
> what happened, and whether it worked, is all still here.
>
> A chat has no memory. You ask, you get an answer, you close the tab, and next
> month nobody knows the question was ever asked."

### Beat 8 — Close (45 seconds)

Stop sharing the screen. Look at them.

> "So: the numbers are computed in code, not generated. The model only writes the
> explanation. Every figure opens onto its evidence. The relationships are held as
> a graph. And it refuses rather than guesses.
>
> It runs on a laptop, offline, on your own data. Nothing leaves the machine."

Then stop talking.

**Silence after a close is not awkward. It is the offer.**

---

## Questions you will be asked, and the answers

### "Why can't ChatGPT do this?"

The one-sentence answer, memorised:

> "The best frontier model tested on real financial spreadsheets this year scored
> 82%, and 33% on aggregations. The paper's own conclusion is that no model is
> accurate enough to use unsupervised. So we never let a model near the
> arithmetic."

If they push, the longer answer is in `docs/pitch/why-not-chatgpt.md`. The source
is FinSheet-Bench, arXiv:2603.07316, March 2026. **Know that reference by heart** —
being able to name the paper ends the argument faster than any number.

### "Isn't this just Gainsight / ChurnZero?"

> "Those are for companies with a customer success team and a data engineer. They
> need integrations, a rollout and a budget. This reads six spreadsheets and works
> in an afternoon. Different customer."

### "What if the data is messy?"

**Be honest.** Say:

> "It needs the columns named. If the file is a mess, it tells you which rows it
> skipped and why, rather than quietly dropping them. It will not guess what a
> column means."

### "How do you make money?"

Do not invent a number you have not thought about. It is fine to say:

> "It is a per-seat tool for small B2B teams. I have not set the price yet — I am
> still working out whether the wedge is churn or renewals."

**An honest "I don't know yet" costs you nothing at this stage. A made-up number
you cannot defend costs you the meeting.**

### "Is the AI part real?"

> "The model does one job: it turns the facts we computed into a sentence a human
> reads. Everything measurable is code. If the model is down, you still get every
> number — you just get them without the write-up."

Then show it, if they want: turn the model off in **Settings** and the numbers are
all still there.

### "What is left to build?"

Answer straight. The honest limits are on the **Why this exists** screen, and
pointing at them is stronger than hiding them:

- it answers a fixed catalogue of questions, not open-ended ones
- it needs the data in a known shape
- the benchmark numbers are about general models, not a measurement of this product
- there is no published benchmark of our own yet — the planted traps are the start
  of one

---

## If something breaks

**Do not debug in the room.** Every second spent looking at an error is a second
they spend deciding you are not ready.

| What happens | What you do |
|---|---|
| A screen is blank | Refresh once. If it is still blank, move to the next beat and come back at the end. |
| The analysis has not run | Say "let me use the one I ran earlier", and go to Decisions, which already has results. |
| The model is not answering | **Use it.** Say: "this is the offline case — watch, every number is still here." Then carry on. It is a better demo than the working one. |
| The app will not open at all | Close the laptop. Talk from the pitch document. You lose the screen, not the meeting. |

**The model being down is not a failure. It is a feature you can demonstrate.**
Practise saying that sentence so it sounds planned, because it is.

---

## What not to do

- **Do not say "just" or "simply".** It makes hard work sound easy and cheap.
- **Do not read the screen aloud.** Point at it and say what it means.
- **Do not open Settings, Embed or Dashboards** unless they ask. They are real
  features, they are not the story, and every extra screen dilutes the four
  minutes that matter.
- **Do not promise a feature that does not exist.** If they ask for something,
  say "not yet" and write it down in front of them. Writing it down is worth more
  than saying yes.
- **Do not run over.** Finish early and let them talk.

---

## The rehearsal

Do this twice, out loud, with a timer, the night before.

The first run will take 18 minutes and you will feel bad about it. The second will
take 12. That is normal — the first one is where you find the sentences that do not
work out loud.

**Time beat 4 separately.** If the trap section takes less than 90 seconds, you are
rushing the best part.
