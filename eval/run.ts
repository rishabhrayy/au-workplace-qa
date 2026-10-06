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
import { bm25, dense, hybrid, memoryIndex, METHODS, postgresFts, rerank, type Method } from '../lib/search.ts';
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

// Question embeddings, computed once and shared by every method that uses them
const vectors = new Map<string, number[]>();
if (embedder) {
  const all = questions.map((q) => q.q);
  const out = await embed(embedder, all, { timeoutMs: 60000 });
  all.forEach((q, i) => vectors.set(q, out[i]));
}

async function search(method: Method, q: string, k = 5): Promise<Hit[]> {
  const v = vectors.get(q) ?? null;
  if (method === 'bm25') return bm25(index, q, k);
  if (method === 'postgres-fts') return postgresFts(sql, q, k);
  if (method === 'dense') return v ? dense(sql, v, k) : [];
  if (method === 'hybrid') return hybrid(index, sql, q, v, k);
  return rerank(groq!, q, await hybrid(index, sql, q, v, 15), k);
}

const available = METHODS.filter((m) => (m === 'dense' || m === 'hybrid' ? embedder : m === 'hybrid-rerank' ? embedder && groq : true));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const rows: Record<string, { hit5: number; mrr: number; ms: number; misses: string[] }> = {};

for (const method of available) {
  let hits = 0;
  let reciprocal = 0;
  let time = 0;
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
  }
  rows[method] = { hit5: hits / answerable.length, mrr: reciprocal / answerable.length, ms: time / answerable.length, misses };
}

console.log(`\nRetrieval on ${answerable.length} questions (Fair Work Act 2009, ${index.passages.length} passages)\n`);
console.log(`${'method'.padEnd(15)}${'hit@5'.padStart(8)}${'MRR'.padStart(8)}${'ms/query'.padStart(10)}`);
for (const [m, r] of Object.entries(rows)) console.log(`${m.padEnd(15)}${pct(r.hit5).padStart(8)}${r.mrr.toFixed(3).padStart(8)}${r.ms.toFixed(0).padStart(10)}`);
const skipped = METHODS.filter((m) => !available.includes(m));
if (skipped.length) console.log(`(skipped without keys: ${skipped.join(', ')})`);
if (process.argv.includes('--misses')) for (const [m, r] of Object.entries(rows)) console.log(`\n${m} misses:\n  ${r.misses.join('\n  ')}`);

// --- full answers ---
if (process.argv.includes('--answers')) {
  if (!groq) throw new Error('--answers needs GROQ_API_KEY');
  const method: Method = available.includes('hybrid-rerank') ? 'hybrid-rerank' : available.at(-1)!;
  let factOk = 0;
  let withNumbers = 0;
  let unsupported = 0;
  let honest = 0;
  const notes: string[] = [];
  for (const q of questions) {
    let text = '';
    let mode = '';
    let used: Hit[] = [];
    const events: AskEvent[] = [];
    for await (const e of ask(q.q, {
      providers: [groq],
      domain: WORKPLACE_DOMAIN,
      search: async (question, _v, k) => (used = await search(method, question, k)),
    })) events.push(e);
    for (const e of events) {
      if (e.type === 'delta') text += e.text;
      if (e.type === 'replace') text = e.text;
      if (e.type === 'done') mode = e.mode;
    }
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
    await new Promise((r) => setTimeout(r, 1500)); // stay inside the free tier's rate limits
  }
  console.log(`\nAnswers with ${method}:`);
  console.log(`  fact accuracy           ${pct(factOk / answerable.length)} (${factOk}/${answerable.length})`);
  console.log(`  unsupported numbers     ${unsupported} of ${withNumbers} answers that state a number`);
  console.log(`  honest when not in Act  ${honest}/${questions.length - answerable.length}`);
  if (notes.length) console.log(`\n${notes.join('\n')}`);
}
