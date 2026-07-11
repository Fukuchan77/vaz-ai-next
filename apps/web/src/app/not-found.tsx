/**
 * 404 boundary (App Router `not-found`).
 *
 * Renders inside the root layout, so it only needs its own content (no
 * `<html>`/`<body>`). Provides a real runtime 404 page.
 *
 * NOTE: like `global-error`, this does not change the `/_not-found` prerender
 * behavior (see global-error.tsx for the non-standard-`NODE_ENV` cause) — it
 * only improves the runtime UX.
 */
export default function NotFound() {
	return (
		<main>
			<h1>ページが見つかりません</h1>
			<p>お探しのページは存在しないか、移動した可能性があります。</p>
		</main>
	);
}
