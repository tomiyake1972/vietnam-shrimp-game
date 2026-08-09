// ShrimpX V2 — 32Q Management Console（Phase 1）
//
// Game Owner / test environment 専用画面。既存の Player 画面
// （/v2/company-lab/play）とは独立しており、そちらの動作を変更しない。

import { ManagementConsole } from "./components/ManagementConsole";

export const metadata = {
  title: "ShrimpX 経営管制室 | 32Q Management Console",
};

export default function ManagementConsolePage() {
  return <ManagementConsole />;
}
