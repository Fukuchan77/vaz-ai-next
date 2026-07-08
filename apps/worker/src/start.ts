import type { Logger } from "@vaz/schemas/deps";
import { createAuditSink } from "./audit";
import { createJobEventSink } from "./events";
import { createInngestEngine, registerJobFunction } from "./inngest";
import { buildWorkerDeps } from "./main";
import { createJobEventPublisher } from "./publisher";
import { createAuditLogStore, createJobEventStore } from "./stores";

/**
 * `apps/worker` process entry — the composition root (R3.1). Wires the concrete
 * infrastructure (Postgres via `pg`+Drizzle, Redis, the Inngest engine) into the
 * engine-agnostic pieces and connects the worker to the Inngest Connect gateway,
 * then stays alive until graceful shutdown. This is the Dockerfile CMD target.
 *
 * Like `@vaz/rag`'s ingest CLI, the pure env parsing ({@link resolveWorkerEnv})
 * is unit-tested; the live boot ({@link main}) opens real connections and is
 * verified against a running stack (deferred — Task 8.1 FLAG / Task 15 E2E). The
 * heavy infra deps are dynamic-imported inside `main()` so importing this module
 * (for the env test) never loads them.
 */

/** Resolved worker runtime configuration (fail-fast on missing DATABASE_URL). */
export interface WorkerEnv {
	databaseUrl: string;
	redisUrl: string;
	/** Stable Connect instance id (defaults to the machine hostname when unset). */
	instanceId: string | undefined;
}

/** Resolve worker config from the environment. `DATABASE_URL` is required. */
export function resolveWorkerEnv(env: Record<string, string | undefined> = process.env): WorkerEnv {
	const databaseUrl = env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error(
			"DATABASE_URL is required to start the worker (e.g. postgres://vaz:vaz@db:5432/vaz)",
		);
	}
	return {
		databaseUrl,
		redisUrl: env.REDIS_URL?.trim() || "redis://redis:6379",
		instanceId: env.WORKER_INSTANCE_ID?.trim() || undefined,
	};
}

/** Console-backed {@link Logger} honoring the R4.7 privacy contract (message + fields only). */
export function createConsoleLogger(): Logger {
	return {
		debug: (message, fields) => (fields ? console.debug(message, fields) : console.debug(message)),
		info: (message, fields) => (fields ? console.info(message, fields) : console.info(message)),
		warn: (message, fields) => (fields ? console.warn(message, fields) : console.warn(message)),
		error: (message, fields) => (fields ? console.error(message, fields) : console.error(message)),
	};
}

/**
 * Boot the worker: build stores + sinks over Postgres/Redis, register the durable
 * job function on the Inngest engine, and connect via the Connect (WebSocket)
 * gateway. `connect()` installs SIGINT/SIGTERM handlers itself; we await
 * `connection.closed` to keep the process alive, then release the pools.
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
	const { databaseUrl, redisUrl, instanceId } = resolveWorkerEnv(env);
	const logger = createConsoleLogger();

	// Heavy infra deps are loaded here (not at module top) so the env parsing above
	// stays unit-testable without pulling pg / redis / the Inngest SDK.
	const { Pool } = await import("pg");
	const { drizzle } = await import("drizzle-orm/node-postgres");
	const { createClient } = await import("redis");
	const { connect } = await import("inngest/connect");

	const pool = new Pool({ connectionString: databaseUrl });
	const db = drizzle(pool);

	const redisClient = createClient({ url: redisUrl });
	redisClient.on("error", (error) => logger.error("redis client error", { error: String(error) }));
	await redisClient.connect();

	// deps (ADR-3): worker-path audit DB sink injected; the event sink persists
	// progress to Postgres + publishes to Redis for SSE (R3.6 / R5.5).
	const audit = createAuditSink(
		{ db, logger, now: () => new Date() },
		{ store: createAuditLogStore(db) },
	);
	const deps = buildWorkerDeps({ db, logger, audit });
	const emit = createJobEventSink(deps, {
		store: createJobEventStore(db),
		publisher: createJobEventPublisher(redisClient),
	});

	const engine = await createInngestEngine();
	const fn = registerJobFunction(engine, deps, { emit });

	const connection = await connect({ apps: [{ client: engine, functions: [fn] }], instanceId });
	logger.info("worker connected to Inngest", {
		connectionId: connection.connectionId,
		instanceId: instanceId ?? "(hostname)",
	});

	await connection.closed; // stay alive until graceful shutdown (connect handles SIGINT/SIGTERM)
	await redisClient.quit();
	await pool.end();
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack : error);
		process.exitCode = 1;
	});
}
