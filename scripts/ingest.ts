/**
 * Loads the passages into Neon Postgres: text, a generated full-text index, and (when
 * GEMINI_API_KEY is set) a 768-dimension embedding per passage with an HNSW index.
 *
 * Idempotent: passages are upserted by id and any passage no longer in the corpus is removed,
 * so re-running after a new compilation of the Act leaves exactly the current text.
 *
 *   DATABASE_URL=... npm run ingest                    (keys from .env.local if present)
 */
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { embed, type Provider } from 'ask-rishabh';
import { loadCorpus, passages } from '../lib/corpus.ts';
import { loadEnv } from '../lib/env.ts';

loadEnv();
export const EMBED_DIMS = 768;

export function gemini(): Provider | null {
  if (!process.env.GEMINI_API_KEY) return null;
  return {
    name: 'gemini-embed',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001',
    // 768 of the model's 3072 dimensions: plenty for 300 passages, and small enough for HNSW
    extraBody: { dimensions: EMBED_DIMS },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The free tier limits embedding tokens per minute, so the passages go in small, paced batches,
 * and each batch is saved as soon as it is embedded: a rate limit or a crash part-way loses
 * nothing, and the next run carries on from the passages that still have no vector.
 */
async function embedMissing(sql: NeonQueryFunction<false, false>, embedder: Provider, size = 10) {
  const missing = (await sql`SELECT id, title, body FROM passages WHERE embedding IS NULL ORDER BY id`) as { id: string; title: string; body: string }[];
  for (let i = 0; i < missing.length; i += size) {
    const batch = missing.slice(i, i + size);
    let vectors: number[][] | null = null;
    for (let attempt = 0; !vectors; attempt++) {
      try {
        vectors = await embed(embedder, batch.map((p) => `${p.title}\n${p.body}`), { timeoutMs: 60000 });
      } catch (error) {
        if (!/ 429/.test((error as Error).message) || attempt >= 5) throw error;
        console.log(`rate limited, waiting 65 s (${i}/${missing.length} done)`);
        await wait(65000);
      }
    }
    for (const [j, p] of batch.entries()) {
      await sql`UPDATE passages SET embedding = ${`[${vectors[j].join(',')}]`}::vector WHERE id = ${p.id}`;
    }
    console.log(`embedded ${Math.min(i + size, missing.length)}/${missing.length}`);
    await wait(4000);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const sql = neon(process.env.DATABASE_URL);
  const corpus = loadCorpus();
  const items = passages(corpus);

  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql.query(`
    CREATE TABLE IF NOT EXISTS passages (
      id text PRIMARY KEY,
      section text NOT NULL,
      title text NOT NULL,
      url text NOT NULL,
      body text NOT NULL,
      compilation text NOT NULL,
      embedding vector(${EMBED_DIMS}),
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED
    )`);
  await sql`CREATE INDEX IF NOT EXISTS passages_tsv ON passages USING gin (tsv)`;
  await sql`CREATE INDEX IF NOT EXISTS passages_embedding ON passages USING hnsw (embedding vector_cosine_ops)`;

  // Text first. A passage whose wording changed loses its vector, so it is embedded again below
  for (const p of items) {
    await sql`
      INSERT INTO passages (id, section, title, url, body, compilation)
      VALUES (${p.id}, ${p.docId}, ${p.title}, ${p.url}, ${p.text}, ${corpus.compilation})
      ON CONFLICT (id) DO UPDATE SET
        section = EXCLUDED.section, title = EXCLUDED.title, url = EXCLUDED.url, body = EXCLUDED.body,
        compilation = EXCLUDED.compilation,
        embedding = CASE WHEN passages.body = EXCLUDED.body AND passages.title = EXCLUDED.title
                         THEN passages.embedding END`;
  }
  const ids = items.map((p) => p.id);
  const removed = await sql`DELETE FROM passages WHERE NOT (id = ANY(${ids})) RETURNING id`;

  // Embeddings only when a key is set; text and full-text search work without them
  const embedder = gemini();
  if (embedder) await embedMissing(sql, embedder);

  const [{ total, embedded }] = await sql`SELECT count(*)::int AS total, count(embedding)::int AS embedded FROM passages`;
  console.log(`${items.length} passages from ${corpus.sections.length} sections (compilation ${corpus.compilation}); table has ${total}, ${embedded} embedded; removed ${removed.length} stale`);
}

if (process.argv[1]?.endsWith('ingest.ts')) await main();
