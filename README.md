# Workplace Q&A

[![CI](https://github.com/rishabhrayy/au-workplace-qa/actions/workflows/ci.yml/badge.svg)](https://github.com/rishabhrayy/au-workplace-qa/actions/workflows/ci.yml) [![Live](https://img.shields.io/badge/live-workplace.rishabhray.me-2f5d50)](https://workplace.rishabhray.me) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Plain-English answers about Australian leave, notice, redundancy and unfair dismissal, from the **Fair Work Act 2009** itself, with the section behind every claim. Try it at **[workplace.rishabhray.me](https://workplace.rishabhray.me)**.

It runs on the same engine as the assistant on my portfolio ([ask-rishabh](https://github.com/rishabhrayy/ask-rishabh)). The point of this repo is the comparison: six ways of finding the right section of the Act, measured on the same 101 questions, and the winner is what the live site uses.

> Not legal advice. A portfolio project that summarises the law in general terms. For your situation, contact the Fair Work Ombudsman on 13 13 94. Not affiliated with, or endorsed by, the Fair Work Ombudsman, the Fair Work Commission or the Commonwealth.

## Results

101 questions people actually ask ("How many sick days do I get a year?", "Do casuals get redundancy pay?"), each labelled with the sections that answer it. Hit@5 is how often a correct section is in the top five passages; MRR rewards putting it first (1.0 means always first).

| Method | Hit@5 | MRR |
|---|---|---|
| Postgres full-text search | 53.5% | 0.390 |
| BM25 keywords | 82.2% | 0.641 |
| BM25, then a model reranks the top 15 * | 87.1% | 0.817 |
| Hybrid: BM25 and embeddings, rank fusion | 93.1% | 0.772 |
| Embeddings alone (pgvector) | 97.0% | 0.927 |
| **Embeddings, then the reranker (live)** | **100%** | **0.967** |

Measured 6 and 7 October 2026 on compilation 73 of the Act. Embeddings: Gemini `gemini-embedding-001` at 768 dimensions. Reranker: Qwen 3.8 27B on Groq with reasoning off; * the BM25 row used gpt-oss-20b, measured the day before the switch. Raw results, including every miss, are in [`eval/results/`](eval/results/).

Hybrid plus the reranker is not in the table yet. Its run hit the reranker's daily token limit and fell back on 63 of 101 questions, and the eval reports a run like that instead of scoring it. One full reranked run uses about a day of the free tier, so it is next on the list.

What I took from it:

- **Keywords lose on vocabulary.** People say "holiday", "sick child" and "fired"; the Act says "annual leave", "personal/carer's leave" and "termination". Almost every BM25 miss is one of those gaps, and embeddings close them.
- **Hybrid was worse than embeddings alone here.** On my portfolio, keywords matter (names like "FIT5120" mean nothing to an embedding model), so hybrid wins. On legal text written in different words from the questions, fusing in the weaker keyword list pulled good results down. The right method depends on the corpus, which is why it is measured rather than assumed.
- **Postgres full-text search came last**, behind BM25 over the same text. Long conversational questions match too loosely when their words are OR-ed, and ranking by term proximity does not fix that.
- **The reranker earns its half second.** On top of embeddings it put a correct section in the top five for every question, and first more often (MRR 0.927 to 0.967). The live answer, including the model writing it, takes about 2 to 3 seconds.

I wrote the questions and checked every expected fact against the Act's text automatically ([`eval/check.ts`](eval/check.ts)) before running any method, and did not tune query expansion on these questions, so the keyword numbers are not flattered by the test set.

## How a question is answered

```text
question
  -> guard          length cap, injection and extraction patterns     (pay questions are welcome here)
  -> embed          Gemini, 768 dimensions                            (fails? keyword search)
  -> retrieve       pgvector on Neon, top 15                          (database down? keyword search)
  -> rerank         Qwen on Groq orders the 15, keeps 5               (fails? the retrieval order)
  -> answer         gpt-oss-120b on Groq, then Gemini                 (cites [n] and "(s 117)")
  -> every model down? the sentences from the Act that best match the question, cited
```

The model is told to answer only from the numbered passages, to quote numbers exactly as the Act states them, and to say so when the Act does not cover something. Most dollar figures, like minimum wages and award rates, are set by the Fair Work Commission rather than the Act, so the honest answer to "What is the minimum wage?" is that the Act does not set the figure.

## Data

The Act comes from the Federal Register of Legislation's API (`npm run fetch`), under [CC BY 4.0](data/README.md): 161 sections on the National Employment Standards, notice and redundancy, unfair dismissal, casual employment, payment of wages and the right to disconnect, split into 245 passages. Each passage carries its division's name, so "annual leave" finds sections that only say "the leave".

I first planned to use the Fair Work Ombudsman's guidance pages. Their site turns away automated requests, and I was not going to disguise a crawler as a browser to get round that, so this uses the legislation itself, which is published for exactly this kind of reuse.

## Run it

```bash
npm install
npm run fetch          # download and parse the Act
npm run ingest         # load passages and embeddings into Postgres (DATABASE_URL, GEMINI_API_KEY)
npm run eval           # compare every method the available keys allow
npm run eval -- --answers   # also write and score full answers (GROQ_API_KEY)
npm test               # 13 tests, no keys needed
```

Keys go in `.env.local` (git-ignored). Ingest is resumable: it saves each batch of embeddings as it goes and only embeds passages that have none, so a free-tier quota can be spread across runs.

## What I would do differently

- **Budget the free tiers before the first run.** Gemini allows 1,000 embedding inputs a day per project and Groq 200,000 tokens a day per model. A day of evals used both up, and a reasoning model used thousands of hidden tokens per ranking. The reranker now runs with reasoning off, at about 1,500 tokens a call.
- **Score answers, not only retrieval, from the start.** Retrieval is the part that is easy to measure; whether the final answer is right and cites the right section is what a visitor sees.
- **Re-check against each new compilation.** The Act changes; the test set's facts are verified against compilation 73, and `npm run fetch` plus `eval/check.ts` would catch a fact that moved.

## Licence

Code: [MIT](LICENSE). The Act's text: CC BY 4.0, see [data/README.md](data/README.md).
