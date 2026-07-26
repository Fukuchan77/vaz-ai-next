"use client";

/**
 * Root-level error boundary (App Router `global-error`).
 *
 * Provides a real runtime fallback when a render error escapes every nested
 * boundary. It must be a Client Component and render the document shell itself
 * because it replaces the root layout in that case.
 *
 * NOTE: `next build` fails to prerender the framework's own `/_global-error`
 * page (`useContext` is null inside a `next/dist` chunk) only when `NODE_ENV`
 * is left as the non-standard "development" value during a production build —
 * Next itself warns about this. This is not fixed here; the build path is
 * fixed instead — `mise run build` ([tasks.build] in mise.toml) and the CI
 * `e2e` job's `Build` step (.github/workflows/tests.yml) both set
 * `NODE_ENV=production` explicitly, regardless of the invoking shell's value.
 * This file only improves the runtime error UX.
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
