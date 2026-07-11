#!/usr/bin/env node
import { createDefaultEmbedder, createDrizzleIngestStore, ingest } from "@vaz/rag/ingest/index";
import type { Logger } from "@vaz/schemas/deps";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * `@vaz/rag` ingest CLI (R2.6) — `pnpm --filter @vaz/rag ingest <corpus-path>`.
 *
 * The composition root for ingestion: it builds the concrete Drizzle store
 * (over a `pg` Pool) and the env-driven Ollama embedder, then delegates the
 * load→chunk→embed→upsert pipeline to {@link ingest}. The pure
 * argument/env parsing below is unit-tested; the live pipeline is verified
 * against a reachable PostgreSQL + Ollama.
 *
 * `main()` runs only when this file is the process entry (`import.meta.main`),
 * so tests can import the helpers without opening a database connection.
 */

/** Parse CLI arguments: the sole positional is the corpus path (R2.6). */
export function parseIngestArgs(argv: string[]): { corpusPath: string } {
	const corpusPath = argv[0]?.trim();
	if (!corpusPath) {
		throw new Error("usage: pnpm --filter @vaz/rag ingest <corpus-path>");
	}
	return { corpusPath };
}

/** Resolve the PostgreSQL connection string from the environment (fail-fast). */
export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
	const url = env.DATABASE_URL?.trim();
	if (!url) {
		throw new Error(
			"DATABASE_URL is required to ingest (e.g. postgres://vaz:vaz@localhost:5432/vaz)",
		);
	}
	return url;
}

/** A minimal console-backed {@link Logger} for the CLI. */
export function createConsoleLogger(): Logger {
	return {
		debug: (message, fields) => console.debug(message, fields ?? ""),
		info: (message, fields) => console.info(message, fields ?? ""),
		warn: (message, fields) => console.warn(message, fields ?? ""),
		error: (message, fields) => console.error(message, fields ?? ""),
	};
}

/** CLI entry: ingest a corpus end-to-end (R2.6). */
export async function main(
	argv: string[] = process.argv.slice(2),
	env: Record<string, string | undefined> = process.env,
): Promise<void> {
	const { corpusPath } = parseIngestArgs(argv);
	const databaseUrl = resolveDatabaseUrl(env);
	const logger = createConsoleLogger();

	const pool = new Pool({ connectionString: databaseUrl });
	try {
		const db = drizzle(pool);
		const summary = await ingest(corpusPath, {
			store: createDrizzleIngestStore(db),
			embed: createDefaultEmbedder(env),
			logger,
		});
		logger.info(`ingest complete: ${summary.documents} document(s), ${summary.chunks} chunk(s)`);
	} finally {
		await pool.end();
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
