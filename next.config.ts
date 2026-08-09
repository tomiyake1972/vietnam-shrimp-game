import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    /**
     * 【AI Analysis Pack のみが使う】export した Pack に「どのコードから出た記録か」を
     * 残すためのビルド時情報。Vercel が用意する VERCEL_GIT_* をそのまま写すだけで、
     * 秘密情報は一切含まない（コミットSHAとブランチ名のみ）。
     * ローカルビルド等で未設定の場合は "UNKNOWN"（捏造しない）。
     */
    NEXT_PUBLIC_SOURCE_COMMIT: process.env.VERCEL_GIT_COMMIT_SHA ?? "UNKNOWN",
    NEXT_PUBLIC_SOURCE_BRANCH: process.env.VERCEL_GIT_COMMIT_REF ?? "UNKNOWN",
  },
};

export default nextConfig;
