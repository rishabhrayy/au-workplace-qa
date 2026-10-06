import type { NeonQueryFunction } from '@neondatabase/serverless';
import { buildIndex, fuse, retrieve, tokenize, type Hit, type Passage, type Provider, type SearchIndex } from 'ask-rishabh';

/**
 * The retrieval methods being compared. Each takes a question (and its embedding, if there is
 * one) and returns ranked passages. They share one corpus so the comparison is like for like.
 */
export type Method = 'bm25' | 'postgres-fts' | 'bm25-rerank' | 'dense' | 'hybrid' | 'hybrid-rerank';
export const METHODS: Method[] = ['bm25', 'postgres-fts', 'bm25-rerank', 'dense', 'hybrid', 'hybrid-rerank'];

type Row = { id: string; section: string; title: string; url: string; body: string; score: number };
const toHit = (r: Row): Hit => ({ passage: { id: r.id, docId: r.section, title: r.title, url: r.url, text: r.body }, score: Number(r.score) });

export function memoryIndex(passages: Passage[]): SearchIndex {
  return buildIndex(passages);
}

/** 1. BM25 in memory (the engine's keyword search, with its query expansion) */
export const bm25 = (index: SearchIndex, q: string, k: number) => retrieve(index, q, null, k);

/**
 * 2. Postgres full-text search. Questions are long and conversational, so the terms are OR-ed
 * (AND would match almost nothing) and ranked by ts_rank_cd, which rewards terms close together.
 */
export async function postgresFts(sql: NeonQueryFunction<false, false>, q: string, k: number): Promise<Hit[]> {
  const terms = [...new Set(tokenize(q))].filter((t) => /^[a-z0-9]+$/.test(t));
  if (!terms.length) return [];
  const query = terms.join(' | ');
  const rows = (await sql`
    SELECT id, section, title, url, body, ts_rank_cd(tsv, to_tsquery('english', ${query})) AS score
    FROM passages WHERE tsv @@ to_tsquery('english', ${query})
    ORDER BY score DESC LIMIT ${k}`) as Row[];
  return rows.map(toHit);
}

/** 3. Dense retrieval: cosine distance over 768-dimension embeddings, via the HNSW index */
export async function dense(sql: NeonQueryFunction<false, false>, vector: number[], k: number): Promise<Hit[]> {
  const rows = (await sql`
    SELECT id, section, title, url, body, 1 - (embedding <=> ${`[${vector.join(',')}]`}::vector) AS score
    FROM passages WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${`[${vector.join(',')}]`}::vector LIMIT ${k}`) as Row[];
  return rows.map(toHit);
}

/** 4. Hybrid: BM25 and dense lists merged by reciprocal rank fusion */
export async function hybrid(index: SearchIndex, sql: NeonQueryFunction<false, false>, q: string, vector: number[] | null, k: number) {
  const keyword = bm25(index, q, 15);
  if (!vector) return keyword.slice(0, k);
  return fuse([keyword, await dense(sql, vector, 15)], 60, k);
}

/**
 * 5. Hybrid, then a language model reorders the top 15 by how directly each passage answers the
 * question. Falls back to the hybrid order if the model fails, so a reranker outage never
 * costs an answer.
 *
 * The free tier allows 8,000 tokens a minute per model, so each passage is cut to its first
 * 350 characters (the section title plus its opening rule is what decides relevance), and the
 * reranker runs on a smaller model than the answers so the two do not share a quota.
 */
export type RerankOptions = {
  onFail?: (e: Error) => void;
  /** Wait out a rate limit and try again, up to this many times. The eval does; a live request should not */
  retries?: number;
};

export async function rerank(provider: Provider, q: string, candidates: Hit[], k: number, opts: RerankOptions = {}): Promise<Hit[]> {
  if (candidates.length <= 1) return candidates.slice(0, k);
  const list = candidates.map((h, i) => `[${i + 1}] ${h.passage.title}\n${h.passage.text.slice(0, 350)}`).join('\n\n');
  try {
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await rerankRequest(provider, q, list);
      if (res.status !== 429 || attempt >= (opts.retries ?? 0)) break;
      const after = Number(res.headers.get('retry-after')) || 20;
      await new Promise((r) => setTimeout(r, (after + 1) * 1000));
    }
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const order = (JSON.parse(json.choices[0].message.content).ranking as number[]).map((n) => candidates[n - 1]).filter(Boolean);
    const seen = new Set(order.map((h) => h.passage.id));
    return [...order, ...candidates.filter((h) => !seen.has(h.passage.id))].slice(0, k);
  } catch (error) {
    opts.onFail?.(error as Error);
    return candidates.slice(0, k);
  }
}

function rerankRequest(provider: Provider, q: string, list: string) {
  return fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0,
      max_tokens: provider.maxTokens ?? 1500,
      response_format: { type: 'json_object' },
      ...provider.extraBody,
      messages: [
        {
          role: 'system',
          content:
            'You rank passages of Australian workplace law by how directly they answer a question. Reply with JSON only: {"ranking": [passage numbers, most relevant first]}. Include every passage number once.',
        },
        { role: 'user', content: `Question: ${q}\n\nPassages:\n\n${list}` },
      ],
    }),
    });
}

/** The reranker's model: small and fast, on its own quota so it never starves the answers */
export const rerankProvider = (apiKey: string): Provider => ({
  name: 'groq-rerank',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey,
  model: process.env.GROQ_RERANK_MODEL || 'openai/gpt-oss-20b',
  maxTokens: 1000,
  extraBody: { reasoning_effort: 'low' },
});
