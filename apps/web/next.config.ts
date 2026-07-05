import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// React Compiler による自動メモ化(手動 useMemo/useCallback を不要にする)
	reactCompiler: true,
	sassOptions: {
		// Carbon Design System v1.x が Sass モダン API 非対応のため一時的に抑制
		// Carbon アップデート後に解消されたら順次削除する
		silenceDeprecations: ["color-functions", "global-builtin", "import"],
	},
};

export default nextConfig;
