#!/usr/bin/env node
import { createConsoleLogger } from "@vaz/config/logger";
import {
	createAgentServiceParser,
	createDefaultEmbedder,
	createDrizzleIngestStore,
	ingest,
	ingestViaParser,
	resolveAgentServiceUrl,
} from "@vaz/rag/ingest/index";
import { parseInfraEnv } from "@vaz/schemas/infra-env";
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
export function parseIngestArgs(argv: string[]): { corpusPath: string; viaParser?: boolean } {
	const flagIndex = argv.indexOf("--via-parser");
	const viaParser = flagIndex !== -1;
	const positional = viaParser ? [...argv.slice(0, flagIndex), ...argv.slice(flagIndex + 1)] : argv;
	const corpusPath = positional[0]?.trim();
	if (!corpusPath) {
		throw new Error("usage: pnpm --filter @vaz/rag ingest [--via-parser] <corpus-path>");
	}
	return viaParser ? { corpusPath, viaParser } : { corpusPath };
}

/** Resolve the PostgreSQL connection string from the environment (fail-fast). */
export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
	try {
		return parseInfraEnv(env).DATABASE_URL;
	} catch {
		throw new Error(
			"DATABASE_URL is required to ingest (e.g. postgres://vaz:vaz@localhost:5432/vaz)",
		);
	}
}

/** CLI entry: ingest a corpus end-to-end (R2.6). */
export async function main(
	argv: string[] = process.argv.slice(2),
	env: Record<string, string | undefined> = process.env,
): Promise<void> {
	const { corpusPath, viaParser } = parseIngestArgs(argv);
	const databaseUrl = resolveDatabaseUrl(env);
	const logger = createConsoleLogger();

	const pool = new Pool({ connectionString: databaseUrl });
	try {
		const db = drizzle(pool);
		const store = createDrizzleIngestStore(db);
		const embed = createDefaultEmbedder(env);
		const summary = viaParser
			? await ingestViaParser(corpusPath, {
					store,
					embed,
					parse: createAgentServiceParser(resolveAgentServiceUrl(env)),
					logger,
				})
			: await ingest(corpusPath, { store, embed, logger });
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
