// ShrimpX V2 — Company Lab プレイヤー画面（財務・資金・設備投資表示） 抽出用セレクタ
//
// 永続化済みのCompanyQuarterRecord（全5社ぶんの配列）から、特定の1社ぶんの
// 財務結果（PL/BS/CF）・資金繰り結果・設備投資結果だけを取り出す純粋関数群。
// 【重要】ここでは一切の再計算を行わない。永続化された確定値をcompanyIdで
// 検索して返すだけであり、値そのものは finance/financing/capex の各close処理が
// 既に計算済みのものをそのまま使う。

import { CompanyQuarterRecord } from "../../../../lib/v2/companyLab/types";
import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { FinancingQuarterResult } from "../../../../lib/v2/financing/types";
import { CapexQuarterResult } from "../../../../lib/v2/capex";
import { CompanyId } from "../../../../lib/v2/sales/types";

/** 指定四半期記録から、指定会社ぶんのPL/BS/CF結果を抽出する（見つからなければnull）。 */
export function extractCompanyFinancialResult(record: CompanyQuarterRecord, companyId: CompanyId): CompanyFinancialQuarterResult | null {
  return record.financialResults.find((r) => r.companyId === companyId) ?? null;
}

/** 指定四半期記録から、指定会社ぶんの資金繰り結果（信用スコア・借入審査等）を抽出する（見つからなければnull）。 */
export function extractCompanyFinancingResult(record: CompanyQuarterRecord, companyId: CompanyId): FinancingQuarterResult | null {
  return record.financingResults.find((r) => r.companyId === companyId) ?? null;
}

/** 指定四半期記録から、指定会社ぶんの設備投資結果を抽出する（見つからなければnull）。 */
export function extractCompanyCapexResult(record: CompanyQuarterRecord, companyId: CompanyId): CapexQuarterResult | null {
  return record.capexResults.find((r) => r.companyId === companyId) ?? null;
}
