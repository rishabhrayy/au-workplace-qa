/**
 * Loads the passages into Neon Postgres: text, a generated full-text index, and (when
 * GEMINI_API_KEY is set) a 768-dimension embedding per passage with an HNSW index.
 *
 * Idempotent: passages are upserted by id and any passage no longer in the corpus is removed,
 * so re-running after a new compilation of the Act leaves exactly the current text.
 *
 *   DATABASE_URL=... npm run ingest                    (keys from .env.local if present)
 */
import { neon } from '@neondatabase/serverless';
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

  // Embeddings only when a key is set; text and full-text search work without them
  const embedder = gemini();
  const vectors = embedder ? await embed(embedder, items.map((p) => `${p.title}\n${p.text}`), { timeoutMs: 60000 }) : null;

  for (const [i, p] of items.entries()) {
    const vector = vectors ? `[${vectors[i].join(',')}]` : null;
    await sql`
      INSERT INTO passages (id, section, title, url, body, compilation, embedding)
      VALUES (${p.id}, ${p.docId}, ${p.title}, ${p.url}, ${p.text}, ${corpus.compilation}, ${vector}::vector)
      ON CONFLICT (id) DO UPDATE SET
        section = EXCLUDED.section, title = EXCLUDED.title, url = EXCLUDED.url, body = EXCLUDED.body,
        compilation = EXCLUDED.compilation,
        embedding = COALESCE(EXCLUDED.embedding, passages.embedding)`;
  }
  const ids = items.map((p) => p.id);
  const removed = await sql`DELETE FROM passages WHERE NOT (id = ANY(${ids})) RETURNING id`;
  const [{ total, embedded }] = await sql`SELECT count(*)::int AS total, count(embedding)::int AS embedded FROM passages`;
  console.log(`${items.length} passages from ${corpus.sections.length} sections (compilation ${corpus.compilation}); table has ${total}, ${embedded} embedded; removed ${removed.length} stale`);
}

if (process.argv[1]?.endsWith('ingest.ts')) await main();
