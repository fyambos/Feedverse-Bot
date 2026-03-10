You are helping generate writing prompts for a dataset of **romance roleplay / fanfiction scenario hooks**.

Pretend you are writing prompts for a **Tumblr fanfiction prompt blog**.  
Write like a **fanfic prompt moderator**, not like an AI.

The prompts should feel like something a writer would immediately want to turn into a fic.

---

## INPUT

You will receive JSON objects with:

- `universeId`
- `dynamicId`
- `summaries` (5 placeholder strings)

Your task is to **replace the placeholders with 5 original summaries**.

---

## STRICT FORMAT RULES

- Keep the JSON structure **exactly the same**.
- Only replace the text **inside the summaries array**.
- Do **NOT** modify `universeId` or `dynamicId`.
- Do **NOT** add commentary, explanation, headings, or markdown.
- Output **valid JSON only**.

---

## CORE STYLE (VERY IMPORTANT)

Write prompts that feel like they came from:

- Tumblr prompt blogs  
- Pinterest writing prompts  
- RP prompt threads  
- fanfiction communities  

The prompts should be:

- short  
- natural  
- slightly casual  
- hook-based  
- story-starting situations  

They should **immediately suggest a romance story**.

---

## ROMANCE REQUIREMENT (CRITICAL)

Every prompt **must clearly contain romantic tension**.

The situation should involve things like:

- attraction  
- flirting  
- pining  
- mistaken romance  
- romantic scandal  
- fake relationships  
- hidden feelings  
- forbidden relationships  
- emotional tension between two people  

Avoid prompts that are only plot events.

BAD example:

"a royal sibling discovers a secret in the palace."

GOOD example:

"a prince discovers the court gossip anonymously writing love confessions about him."

---

## STRUCTURE RULES

Each summary must:

- be **standalone**
- make sense **without the others**
- be **1 sentence**
- be **romance-oriented**
- be **a specific situation**
- be **different from the other four**

Do NOT write five variations of the same idea.

Example of BAD repetition:

- "two students fall in love..."
- "two students slowly fall in love..."
- "two students start falling in love..."

---

## VARIETY RULE

Within each pack of 5 summaries:

- vary the situation  
- vary the phrasing  
- vary the sentence structure  

Avoid starting every prompt with the same pattern.

BAD examples (DO NOT DO THIS):
- generic summaries
- overly formal language
- repetitive templates
- "this story explores..." phrasing
- structured or corporate tone
---

## HOOK RULE (IMPORTANT)

Each prompt should feel like a **story hook**.

It should make someone think:

*"oh that would be a good fic."*

Good hooks often include:

- mistaken identity  
- anonymous messages  
- accidental confessions  
- fake dating situations  
- secret relationships  
- public scandals  
- hidden identities  
- forced proximity  

---

## LENGTH

Keep summaries short.

Ideal length:

**10–20 words**

Avoid long complex sentences.

---

## NO META TEXT

Do NOT include:

- emojis  
- explanation  
- commentary  
- headings  
- markdown formatting  

Only return the JSON objects.

---

## EXAMPLE OF A GOOD RESULT

```json
{
  "universeId": "college",
  "dynamicId": "accidental_text",
  "summaries": [
    "a student accidentally texts the wrong number complaining about their roommate.",
    "someone sends a dramatic rant about their day to a stranger instead of their friend.",
    "a mistaken text turns into a late night conversation with someone they barely know.",
    "two strangers keep texting after one wrong-number message started everything.",
    "a college student accidentally messages someone in their class instead of their best friend."
  ]
}

Now generate the summaries for the JSON blocks I provide.