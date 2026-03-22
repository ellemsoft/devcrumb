-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Users (GitHub identity)
CREATE TABLE users (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  github_id       text UNIQUE NOT NULL,
  github_login    text NOT NULL,
  created_at      timestamptz DEFAULT now()
);

-- Main entries table
CREATE TABLE entries (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  type            text NOT NULL CHECK (type IN ('fix', 'gotcha')),
  summary         text NOT NULL,
  error_msg       text,
  tags            text[] DEFAULT '{}',
  context         jsonb DEFAULT '{}',
  meta            jsonb DEFAULT '{}',
  trust_score     integer DEFAULT 0,
  dispute_count   integer DEFAULT 0,
  is_public       boolean DEFAULT true,
  contributor     bigint REFERENCES users(id),
  embedding       vector(384) NOT NULL,
  created_at      timestamptz DEFAULT now()
);

-- Confirmations and disputes (one action per user per entry)
CREATE TABLE confirmations (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  entry_id    bigint REFERENCES entries(id) ON DELETE CASCADE,
  user_id     bigint REFERENCES users(id),
  helpful     boolean NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (entry_id, user_id)
);

-- Indexes
CREATE INDEX ON entries USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON entries USING gin (tags);
CREATE INDEX ON entries (trust_score DESC);
CREATE INDEX ON entries (is_public, dispute_count);
CREATE INDEX ON entries (contributor, created_at);
CREATE INDEX ON confirmations (user_id, created_at);

-- Search function with effective score ranking
-- effective_score = similarity * 0.6 + trust_bonus * 0.3 - dispute_penalty * 0.1
CREATE OR REPLACE FUNCTION find_crumbs(
  query_embedding vector(384),
  match_count     int DEFAULT 3,
  min_trust       int DEFAULT 1,
  entry_type      text DEFAULT NULL,
  filter_tags     text[] DEFAULT NULL
)
RETURNS TABLE (
  id              bigint,
  type            text,
  summary         text,
  tags            text[],
  trust_score     integer,
  dispute_count   integer,
  context         jsonb,
  similarity      float,
  effective_score float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id, e.type, e.summary, e.tags,
    e.trust_score, e.dispute_count, e.context,
    1 - (e.embedding <=> query_embedding) AS similarity,
    -- effective_score: 60% similarity, 30% trust (capped at 20), 10% dispute penalty
    (1 - (e.embedding <=> query_embedding)) * 0.6
      + LEAST(e.trust_score, 20)::float / 20 * 0.3
      - LEAST(e.dispute_count, 10)::float / 10 * 0.1
      AS effective_score
  FROM entries e
  WHERE e.is_public = true
    AND e.trust_score >= min_trust
    AND (entry_type IS NULL OR e.type = entry_type)
    AND (filter_tags IS NULL OR e.tags && filter_tags)
  ORDER BY effective_score DESC
  LIMIT match_count;
END;
$$;

-- Trust increment
CREATE OR REPLACE FUNCTION increment_trust(entry_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE entries SET trust_score = trust_score + 1 WHERE id = entry_id;
END;
$$;

-- Dispute an entry — auto-hides when dispute_count >= 10 AND ratio > 0.6
CREATE OR REPLACE FUNCTION dispute_entry(target_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE entries
  SET dispute_count = dispute_count + 1,
      is_public = CASE
        WHEN dispute_count + 1 >= 10
          AND (dispute_count + 1)::float / GREATEST(trust_score + dispute_count + 1, 1) > 0.6
        THEN false
        ELSE is_public
      END
  WHERE id = target_id;
END;
$$;

-- Find similar entries (used by drop_crumb before inserting)
CREATE OR REPLACE FUNCTION find_similar(
  query_embedding vector(384),
  min_similarity  float DEFAULT 0.85,
  match_count     int DEFAULT 3
)
RETURNS TABLE (
  id          bigint,
  type        text,
  summary     text,
  tags        text[],
  trust_score integer,
  similarity  float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id, e.type, e.summary, e.tags, e.trust_score,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM entries e
  WHERE e.is_public = true
    AND 1 - (e.embedding <=> query_embedding) >= min_similarity
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Trust decay — run nightly via Supabase scheduled function
-- Entries older than 90 days with no confirmations in 30 days decay by 1
-- Never goes below 1. Outdated knowledge sinks, active knowledge stays.
CREATE OR REPLACE FUNCTION decay_trust()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE entries e
  SET trust_score = GREATEST(1, e.trust_score - 1)
  WHERE e.created_at < now() - interval '90 days'
    AND e.trust_score > 1
    AND NOT EXISTS (
      SELECT 1 FROM confirmations c
      WHERE c.entry_id = e.id
        AND c.created_at > now() - interval '30 days'
    );
END;
$$;
