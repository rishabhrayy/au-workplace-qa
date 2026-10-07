/**
 * Compares the retrieval methods on the 105-question set, and optionally scores full answers.
 *
 *   npm run eval                    every method the available keys allow
 *   npm run eval -- --answers       also answer each question and score the answers (needs keys)
 *
 * Retrieval: hit@5 (a passage from an expected section in the top 5), MRR, and latency.
 * Answers: fact accuracy (the answer contains the key facts), unsupported numbers (a number in
 * the answer that appears in none of the retrieved passages), and honesty on questions the Act
 * does not answer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { ask, embed, type AskEvent, type Hit, type Provider } from 'ask-rishabh';
import { loadCorpus, passages } from '../lib/corpus.ts';
import { WORKPLACE_DOMAIN } from '../lib/domain.ts';
import { loadEnv } from '../lib/env.ts';
import { bm25, dense, hybrid, memoryIndex, METHODS, postgresFts, rerank, rerankProvider, type Method } from '../lib/search.ts';
import { gemini } from '../scripts/ingest.ts';

loadEnv();
type Q = { q: string; expect?: string[]; facts?: string[]; notInAct?: boolean };
const here = import.meta.dirname;
const { questions } = JSON.parse(fs.readFileSync(path.join(here, 'questions.json'), 'utf8')) as { questions: Q[] };
const answerable = questions.filter((q) => !q.notInAct);

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const sql = neon(process.env.DATABASE_URL);
const index = memoryIndex(passages(loadCorpus()));
const embedder = gemini();
const groq: Provider | null = process.env.GROQ_API_KEY
  ? { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', maxTokens: 1500, extraBody: { reasoning_effort: 'low' } }
  : null;

// Question embeddings, computed once and kept on disk: the free tier allows 1,000 embedding
// inputs a day, so re-running the eval should not spend 105 of them each time
const CACHE = path.join(here, '.cache', 'question-vectors.json');
const vectors = new Map<string, number[]>(fs.existsSync(CACHE) ? Object.entries(JSON.parse(fs.readFileSync(CACHE, 'utf8'))) : []);
const unembedded = questions.map((q) => q.q).filter((q) => !vectors.has(q));
if (embedder && unembedded.length) {
  try {
    // batches of 20 with a pause, and a minute's wait on a 429: the per-minute limit counts inputs
    for (let i = 0; i < unembedded.length; i += 20) {
      const batch = unembedded.slice(i, i + 20);
      for (let attempt = 0; ; attempt++) {
        try {
          const out = await embed(embedder, batch, { timeoutMs: 60000 });
          batch.forEach((q, j) => vectors.set(q, out[j]));
          break;
        } catch (error) {
          if (!/ 429/.test((error as Error).message) || attempt >= 3) throw error;
          await new Promise((r) => setTimeout(r, 65000));
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(Object.fromEntries(vectors)));
  } catch (error) {
    console.log(`question embeddings unavailable (${(error as Error).message.slice(0, 60)}...), dense methods skipped`);
  }
}
// Dense search is only a fair comparison once every passage has its vector
const [{ total, embedded }] = (await sql`SELECT count(*)::int AS total, count(embedding)::int AS embedded FROM passages`) as { total: number; embedded: number }[];
const denseReady = questions.every((q) => vectors.has(q.q)) && total > 0 && embedded === total;
if (!denseReady) console.log(`dense methods skipped: ${embedded}/${total} passages embedded, ${vectors.size}/${questions.length} questions`);

let rerankFailures = 0;
const reranker = groq ? rerankProvider(groq.apiKey) : null;
const reranked = (q: string, candidates: Hit[], k: number) => rerank(reranker!, q, candidates, k, { onFail: () => rerankFailures++, retries: 4 });

// A dropped connection to Neon retries rather than ending a long run
async function search(method: Method, q: string, k = 5): Promise<Hit[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await searchOnce(method, q, k);
    } catch (error) {
      if (attempt >= 3 || !/fetch failed|ECONNRESET|connecting/i.test(String(error))) throw error;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
}

async function searchOnce(method: Method, q: string, k = 5): Promise<Hit[]> {
  const v = vectors.get(q) ?? null;
  if (method === 'bm25') return bm25(index, q, k);
  if (method === 'postgres-fts') return postgresFts(sql, q, k);
  if (method === 'bm25-rerank') return reranked(q, bm25(index, q, 15), k);
  if (method === 'dense') return v ? dense(sql, v, k) : [];
  if (method === 'dense-rerank') return v ? reranked(q, await dense(sql, v, 15), k) : [];
  if (method === 'hybrid') return hybrid(index, sql, q, v, k);
  return reranked(q, await hybrid(index, sql, q, v, 15), k);
}

const needs = { dense: denseReady, 'dense-rerank': denseReady && Boolean(groq), hybrid: denseReady, 'bm25-rerank': Boolean(groq), 'hybrid-rerank': denseReady && Boolean(groq) } as Partial<Record<Method, boolean>>;
const available = METHODS.filter((m) => needs[m] ?? true);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const rows: Record<string, { hit5: number; mrr: number; ms: number; rerankFailures: number; misses: string[] }> = {};
// --methods bm25,bm25-rerank runs a subset
const only = process.argv.find((a) => a.startsWith('--methods='))?.slice(10).split(',');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const method of available.filter((m) => !only || only.includes(m))) {
  let hits = 0;
  let reciprocal = 0;
  let time = 0;
  const failuresBefore = rerankFailures;
  const misses: string[] = [];
  for (const q of answerable) {
    const t0 = performance.now();
    const ranked = (await search(method, q.q)).map((h) => h.passage.docId);
    time += performance.now() - t0;
    const rank = ranked.findIndex((s) => q.expect!.includes(s));
    if (rank > -1) {
      hits++;
      reciprocal += 1 / (rank + 1);
    } else misses.push(`${q.q} -> ${ranked.slice(0, 3).join(', ') || 'nothing'}`);
    if (method.endsWith('rerank')) await wait(1000); // pacing; a 429 is waited out inside rerank
  }
  const n = answerable.length;
  rows[method] = { hit5: hits / n, mrr: reciprocal / n, ms: time / n, rerankFailures: rerankFailures - failuresBefore, misses };
}

console.log(`\nRetrieval on ${answerable.length} questions (Fair Work Act 2009, ${index.passages.length} passages)\n`);
console.log(`${'method'.padEnd(15)}${'hit@5'.padStart(8)}${'MRR'.padStart(8)}${'ms/query'.padStart(10)}`);
for (const [m, r] of Object.entries(rows)) {
  const note = r.rerankFailures ? `  (reranker failed ${r.rerankFailures}x, fell back to input order)` : '';
  console.log(`${m.padEnd(15)}${pct(r.hit5).padStart(8)}${r.mrr.toFixed(3).padStart(8)}${r.ms.toFixed(0).padStart(10)}${note}`);
}
const skipped = METHODS.filter((m) => !available.includes(m));
if (skipped.length) console.log(`(skipped: ${skipped.join(', ')})`);
const RESULTS = path.join(here, 'results', `retrieval-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
const previous = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf8')) : {};
fs.writeFileSync(RESULTS, `${JSON.stringify({ ...previous, ...rows }, null, 2)}\n`);
if (process.argv.includes('--misses')) for (const [m, r] of Object.entries(rows)) console.log(`\n${m} misses:\n  ${r.misses.join('\n  ')}`);

// --- full answers ---
if (process.argv.includes('--answers')) {
  if (!groq) throw new Error('--answers needs GROQ_API_KEY');
  const method: Method = available.includes('hybrid-rerank') ? 'hybrid-rerank' : available.at(-1)!;
  let factOk = 0;
  let withNumbers = 0;
  let unsupported = 0;
  let honest = 0;
  let fallbacks = 0;
  const notes: string[] = [];
  for (const q of questions) {
    let text = '';
    let mode = '';
    let used: Hit[] = [];
    // A rate-limited model gives the no-model fallback: wait for the minute to roll over and ask
    // again, so the score is about the answers, not the free tier's quota
    for (let attempt = 0; attempt < 4; attempt++) {
      text = '';
      const events: AskEvent[] = [];
      try {
        for await (const e of ask(q.q, {
          providers: [groq],
          domain: WORKPLACE_DOMAIN,
          search: async (question, _v, k) => (used = await search(method, question, k)),
        })) events.push(e);
      } catch (error) {
        // one failed question (a database or network blip) must not end a 40-minute run
        console.error(`  error on "${q.q}": ${(error as Error).message.slice(0, 120)}`);
        mode = 'error';
        await wait(10000);
        continue;
      }
      for (const e of events) {
        if (e.type === 'delta') text += e.text;
        if (e.type === 'replace') text = e.text;
        if (e.type === 'done') mode = e.mode;
      }
      if (mode !== 'fallback') break;
      await wait(30000);
    }
    if (mode === 'fallback' || mode === 'error') fallbacks++;
    console.error(`  ${questions.indexOf(q) + 1}/${questions.length} ${mode}`);
    const flat = text.toLowerCase().replace(/[‘’]/g, "'");
    if (q.notInAct) {
      const says = /not (in|covered|set out|specified|stated)|doesn'?t (say|set|specify|cover)|does not (say|set|specify|cover|state)|isn'?t (in|covered|set)|no (figure|amount|rate|percentage)|fair work commission|award/i.test(flat);
      if (says && !/\$\s?\d/.test(flat)) honest++;
      else notes.push(`GUESSED  ${q.q} -> ${text.slice(0, 140)}`);
      continue;
    }
    const ok = (q.facts ?? []).every((f) => flat.includes(f.toLowerCase().replace(/[‘’]/g, "'")));
    if (ok) factOk++;
    else notes.push(`MISSED  ${q.q} [${q.facts?.join(', ')}] (${mode}) -> ${text.slice(0, 140)}`);
    // numbers in the answer must come from the passages it was given
    const source = used.map((h) => h.passage.text + h.passage.title).join(' ').toLowerCase();
    const numbers = (flat.match(/\b\d+(?:\.\d+)?\b/g) ?? []).filter((n) => !/^\[?\d\]?$/.test(n) || Number(n) > 9);
    const claims = numbers.filter((n) => !text.includes(`[${n}]`));
    if (claims.length) {
      withNumbers++;
      if (claims.some((n) => !source.includes(n))) {
        unsupported++;
        notes.push(`UNSUPPORTED NUMBER  ${q.q} -> ${claims.filter((n) => !source.includes(n)).join(', ')}`);
      }
    }
    await wait(15000); // about four answers a minute fits the free tier's 8,000 tokens
  }
  console.log(`\nAnswers with ${method}:`);
  console.log(`  fact accuracy           ${pct(factOk / answerable.length)} (${factOk}/${answerable.length})`);
  console.log(`  unsupported numbers     ${unsupported} of ${withNumbers} answers that state a number`);
  console.log(`  honest when not in Act  ${honest}/${questions.length - answerable.length}`);
  if (fallbacks) console.log(`  (${fallbacks} answers were the no-model fallback or an error after 4 tries)`);
  const ANSWERS = path.join(here, 'results', `answers-${method}-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(ANSWERS, `${JSON.stringify({ method, factAccuracy: factOk / answerable.length, factOk, answerable: answerable.length, unsupported, withNumbers, honest, notInAct: questions.length - answerable.length, fallbacks, notes }, null, 2)}
`);
  if (notes.length) console.log(`\n${notes.join('\n')}`);
}
