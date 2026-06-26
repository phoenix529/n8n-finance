-- Executado uma única vez, no primeiro boot do Postgres (banco vazio).
-- Habilita pgvector (usado pela camada RAG). O schema estrela vem em 10_schema.sql.
CREATE EXTENSION IF NOT EXISTS vector;
