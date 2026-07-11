import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// React Compiler auto-memoization (removes the need for manual useMemo/useCallback).
	reactCompiler: true,
	sassOptions: {
		// Carbon Design System v1.x does not support the Sass modern API; silence
		// these deprecations for now and remove entries as Carbon updates resolve them.
		silenceDeprecations: ["color-functions", "global-builtin", "import"],
	},
};

export default nextConfig;
