import type { Metadata } from "next";
import "./globals.css";
import { appEnvironment, isProduction } from "./lib/env";
import EnvironmentBanner from "./components/EnvironmentBanner";

export const metadata: Metadata = {
  title: "ベトナムエビ輸出事業",
  description: "経営シミュレーションゲーム",
};

// env.tsの判定はモジュール読み込み時に確定する。動的セグメントを持たないページ
// （/ 等）はNext.jsが静的プリレンダリング対象と判断することがあり、その場合
// isProduction等がビルド実行時点の環境変数で固定され、実際のデプロイ環境と
// 食い違いうる（実データ検証で確認済み：production向けに起動したサーバーでも
// staging向けにビルドした場合は環境バナーがSTAGINGのまま出てしまう）。
// ルートレイアウトで強制的に動的レンダリングにし、アプリ全体でこのリスクを排除する。
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {!isProduction && <EnvironmentBanner appEnvironment={appEnvironment} />}
        {children}
      </body>
    </html>
  );
}
