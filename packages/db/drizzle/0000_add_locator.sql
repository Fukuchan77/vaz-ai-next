-- Req 4.3: add an optional page→section→char position anchor to `chunk`.
-- Nullable, no default other than NULL — existing rows (and the default,
-- non-parser ingest path) are unaffected and remain byte-compatible.
ALTER TABLE "chunk" ADD COLUMN "locator" text;
