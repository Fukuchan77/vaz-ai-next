import type { Logger } from "@vaz/schemas/deps";

/**
 * Console-backed {@link Logger} honoring the R4.7 privacy contract: it records
 * only the message and explicitly-passed fields — raw prompts / tool I/O are
 * never forwarded here. Single implementation (R3.1) replacing what used to
 * be four independent copies: `apps/web/src/app/api/chat/route.ts` (inline),
 * `apps/worker/src/start.ts`, `apps/worker/src/main.ts` (`buildWorkerDeps`'s
 * default), and `packages/rag/bin/ingest.ts`.
 */
export function createConsoleLogger(): Logger {
	return {
		debug: (message, fields) => (fields ? console.debug(message, fields) : console.debug(message)),
		info: (message, fields) => (fields ? console.info(message, fields) : console.info(message)),
		warn: (message, fields) => (fields ? console.warn(message, fields) : console.warn(message)),
		error: (message, fields) => (fields ? console.error(message, fields) : console.error(message)),
	};
}
