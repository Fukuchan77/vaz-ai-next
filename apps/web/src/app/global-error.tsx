"use client";

/**
 * Root-level error boundary (App Router `global-error`).
 *
 * Provides a real runtime fallback when a render error escapes every nested
 * boundary. It must be a Client Component and render the document shell itself
 * because it replaces the root layout in that case.
 *
 * NOTE: this does NOT fix the known `next build` prerender failure on
 * Next 16.2.10 × React 19.2 (`useContext` is null inside a `next/dist` chunk for
 * the framework's own `/_global-error` / `/_not-found` pages — verified to
 * reproduce even with these custom boundaries present). That is an upstream
 * issue tracked as a separate follow-up (a Next/React version change); this file
 * only improves the runtime error UX.
 */
export default function GlobalError({
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	return (
		<html lang="ja">
			<body>
				<main>
					<h1>問題が発生しました</h1>
					<p>予期しないエラーが発生しました。時間をおいて再度お試しください。</p>
					<button type="button" onClick={() => reset()}>
						再試行
					</button>
				</main>
			</body>
		</html>
	);
}
