// ShrimpX V2 — Management Console: Game Setup / Scenario Selection（Phase 8）
//
// ゲーム開始前の条件設定画面。ここを開いただけ・条件を選んだだけでは
// Simulation Runは作られない。「この条件でゲーム開始」を押したときだけ
// 新しいRunを生成する（指示§H）。

import { Suspense } from "react";
import { SetupScreen } from "./SetupScreen";

export const metadata = {
  title: "Game Setup | ShrimpX 経営管制室",
};

export default function SetupPage() {
  return (
    <Suspense fallback={null}>
      <SetupScreen />
    </Suspense>
  );
}
