// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） 会社選択肢
//
// 会社選択肢はUIへ重複ハードコードせず、既存のbuildCompanyFixtures（実際の
// fixture生成関数）から生成する（指示§8.1「会社選択肢はUIに重複ハードコードせず、
// 既存configまたはサーバー側の正規データから生成してください」）。既存の仮UI
// （app/v2/company-lab/page.tsx）のCOMPANY_OPTIONS定義と同じ手法を踏襲する。

import { INITIAL_PERIOD_V2 } from "../../../../lib/v2/core/period";
import { buildCompanyFixtures } from "../../../../lib/v2/companyLab";

export interface CompanyOptionForUi {
  readonly companyId: string;
  readonly displayName: string;
}

/**
 * Period値は初期原料在庫の記録用にしか使わないため、選択肢の表示名を得るためだけの
 * 呼び出しでは仮のINITIAL_PERIOD_V2で構わない（実際のラボ作成時は
 * initializeCompanyLabが本当の開始Periodでfixturesを作り直す。既存page.tsxの
 * COMPANY_OPTIONS定義と同じ前提）。
 */
export function listCompanyOptionsForUi(): readonly CompanyOptionForUi[] {
  return buildCompanyFixtures(INITIAL_PERIOD_V2).map((f) => ({ companyId: f.companyId, displayName: f.displayName }));
}
