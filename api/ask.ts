/**
 * POST /api/ask { "question": "..." } -> application/x-ndjson stream of AskEvent lines.
 *
 * The ask-rishabh engine with the workplace domain: guard (no private-topic refusals, since pay
 * is the subject), dense retrieval over Neon pgvector reordered by a reranker (the best method
 * in eval/: 100% hit@5 on 101 questions), a per-request canary and output check, and fallbacks
 * at every step: no embedding or no database means keyword search, no reranker means the
 * retrieval order, no model means the extractive answer.
 */
import { neon } from '@neondatabase/serverless';
import { ask, buildIndex, chunk, rateLimit, type AskEvent, type Provider } from 'ask-rishabh';
import corpus from '../data/sections.json' with { type: 'json' };
import { sectionDocs, type Corpus } from '../lib/corpus.ts';
import { WORKPLACE_DOMAIN } from '../lib/domain.ts';
import { bm25, dense, rerank, rerankProvider } from '../lib/search.ts';

const index = buildIndex(chunk(sectionDocs(corpus as Corpus), 1400));
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const ALLOWED_ORIGINS = [/^https:\/\/workplace\.rishabhray\.me$/, /^https:\/\/[a-z0-9-]+-rish-2d06\.vercel\.app$/, /^http:\/\/localhost:\d+$/];

const groq: Provider | null = process.env.GROQ_API_KEY
  ? { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', maxTokens: 1500, extraBody: { reasoning_effort: 'low' } }
  : null;
const gemini: Provider | null = process.env.GEMINI_API_KEY
  ? { name: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', maxTokens: 2500 }
  : null;
// Backups on their own quotas: Groq and Gemini limit tokens per model per day, so a second model
// from each keeps answering when the first runs out or is overloaded
const groqFast: Provider | null = process.env.GROQ_API_KEY
  ? { name: 'groq-fast', baseUrl: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_FAST_MODEL || 'openai/gpt-oss-20b', maxTokens: 1500, extraBody: { reasoning_effort: 'low' } }
  : null;
const gemini2: Provider | null = process.env.GEMINI_API_KEY
  ? { name: 'gemini-2', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest', maxTokens: 2500 }
  : null;
const reranker = process.env.GROQ_API_KEY ? rerankProvider(process.env.GROQ_API_KEY) : null;
const embedder: Provider | null = process.env.GEMINI_API_KEY
  ? { name: 'gemini-embed', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: process.env.GEMINI_API_KEY, model: 'gemini-embedding-001', extraBody: { dimensions: 768 } }
  : null;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function POST(request: Request): Promise<Response> {
  if (!ALLOWED_ORIGINS.some((r) => r.test(request.headers.get('origin') ?? ''))) return json(403, { error: 'Not allowed from this site.' });
  let question: unknown;
  try {
    ({ question } = (await request.json()) as { question?: unknown });
  } catch {
    return json(400, { error: 'Send JSON: {"question": "..."}' });
  }
  const ip = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const limit = await rateLimit(`workplace:${ip}`, { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, limit: 20, windowSeconds: 600 });
  if (!limit.allowed) return json(429, { error: 'That is a lot of questions. Please try again in a few minutes.' });

  const cancel = new AbortController();
  const encoder = new TextEncoder();
  const events = ask(question, {
    index,
    providers: [groq, gemini, groqFast, gemini2].filter((p): p is Provider => Boolean(p)),
    embedder,
    domain: WORKPLACE_DOMAIN,
    signal: cancel.signal,
    // Dense search over Neon, then the reranker reorders the top 15. On this corpus dense beat
    // hybrid: fusing in the weaker BM25 list pulled good results down (see the README)
    search: async (q, vector, k) => {
      const n = reranker ? 15 : k;
      let candidates = bm25(index, q, n);
      if (sql && vector) {
        try {
          candidates = await dense(sql, vector, n);
        } catch {
          // the database is down or slow: keyword search in memory still answers
        }
      }
      return reranker && candidates.length > k ? rerank(reranker, q, candidates, k) : candidates.slice(0, k);
    },
  });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) return controller.close();
        controller.enqueue(encoder.encode(`${JSON.stringify(value satisfies AskEvent)}\n`));
      } catch {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', message: 'Something went wrong.' })}\n`));
        controller.close();
      }
    },
    cancel() {
      cancel.abort();
      void events.return(undefined);
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
}
