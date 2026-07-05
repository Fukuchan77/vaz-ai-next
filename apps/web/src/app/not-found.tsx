/**
 * 404 boundary (App Router `not-found`).
 *
 * Renders inside the root layout, so it only needs its own content (no
 * `<html>`/`<body>`). Provides a real runtime 404 page.
 *
 * NOTE: like `global-error`, this does not fix the upstream Next 16.2.10 ×
 * React 19.2 `/_not-found` prerender failure (see global-error.tsx) — it only
 * improves the runtime UX.
 */
export default function NotFound() {
	return (
		<main>
			<h1>ページが見つかりません</h1>
			<p>お探しのページは存在しないか、移動した可能性があります。</p>
		</main>
	);
}
