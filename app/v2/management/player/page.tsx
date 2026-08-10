// ShrimpX V2 — PLAYER Company Workspace（Phase 8）
//
// Manual Override（会社ごとのSTANDARD_AI/PLAYER切替）でPLAYERへ切り替えた会社を、
// 「単に数字を入力するだけ」ではなく、財務・販売・生産・在庫・市場・投資状況を
// 通常プレイ同様に確認した上で意思決定できる画面。

import { Suspense } from "react";
import { PlayerWorkspace } from "./PlayerWorkspace";

export const metadata = {
  title: "PLAYER Company Workspace | ShrimpX 経営管制室",
};

export default function PlayerWorkspacePage() {
  return (
    <Suspense fallback={null}>
      <PlayerWorkspace />
    </Suspense>
  );
}
