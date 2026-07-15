import type { Metadata } from "next";
import "./globals.css";
import { appEnvironment, isProduction } from "./lib/env";
import EnvironmentBanner from "./components/EnvironmentBanner";

export const metadata: Metadata = {
  title: "ベトナムエビ輸出事業",
  description: "経営シミュレーションゲーム",
};

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
