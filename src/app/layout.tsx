import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/assets/styles/global.scss";

export const metadata: Metadata = {
	title: "vaz-ai-next",
	description:
		"Vercel AI SDK + Next.js App Router + Zod — a bleeding-edge AI application architecture",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="ja">
			<body>{children}</body>
		</html>
	);
}
