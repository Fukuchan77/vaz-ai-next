/**
 * Shared helpers for the leaf-level env schemas (`env.ts`/`auth-env.ts`/
 * `infra-env.ts`, R3.5). Single-defines what used to be two identical copies
 * of {@link emptyToUndefined} (`env.ts` and `auth-env.ts`).
 */

/** Treat an empty string as unset (guards against blank values in `.env`). */
export function emptyToUndefined(value: string | undefined): string | undefined {
	return value === "" ? undefined : value;
}
