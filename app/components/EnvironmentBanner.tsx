import type { AppEnvironment } from "../lib/env";

// 表示するかどうかは、呼び出し元（app/layout.tsx）がサーバー側の isProduction を見て決める
// （production のときはそもそもこのコンポーネントを描画しない）。このコンポーネント自体は
// クライアント側の値を信用せず、渡された環境名を表示するだけの純粋な表示コンポーネントとする。
const LABELS: Record<AppEnvironment, string> = {
  production: "PRODUCTION",
  staging: "STAGING",
  preview: "PREVIEW",
  development: "DEVELOPMENT",
};

export default function EnvironmentBanner({ appEnvironment }: { appEnvironment: AppEnvironment }) {
  return (
    <div className="sticky top-0 z-[100] w-full bg-amber-500 text-black px-3 py-1.5 text-center text-xs sm:text-sm font-bold tracking-wide shadow-md">
      <span className="inline-block">
        ⚠️ {LABELS[appEnvironment]} / TEST ENVIRONMENT — この環境（{appEnvironment}）のデータは本番環境とは別です
      </span>
    </div>
  );
}
