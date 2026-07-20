// ShrimpX V2 — 財務モジュール 5社の初期財務状態（Phase 8A）
//
// 会社ラボの5社テスト用フィクスチャ（本番会社設定ではない）に対応する、
// 暫定の初期財務状態。会社アーキタイプと大きく矛盾しない設定にする：
//   BAL   バランス型         — 中庸な資産・負債構成
//   MASS  大量生産・価格競争型 — 最大の固定資産と借入（設備先行投資型）
//   JPQ   日本・品質志向型     — 中規模資産・控えめな借入
//   VAP   VAP特化型          — VAP設備への投資でやや大きい固定資産
//   CONSV 保守的・財務慎重型   — 高い現金・最小の借入（無借金に近い）
//
// 【開始時の貸借一致の保証】
//   原料在庫の初期金額は、フィクスチャの初期原料ロット（実データ）の
//   Σ(残数量 × 取得単価 × 1,000)から算出する（帳簿と実在庫の一致を構造的に保証）。
//   完成品在庫・売掛金・買掛金は開始時0（ゲーム開始前の取引履歴を持たないため。
//   型・決済スケジュール構造は保持しており、1四半期目から自然に発生する）。
//   利益剰余金は「資産合計 − 負債合計 − 資本金」の残差として決定し、
//   開始時点で 資産 = 負債 + 純資産 が厳密に成立することを構造的に保証する。

import { PeriodV2 } from "../core/period";
import { unwrapUnit } from "../core/units";
import { RawMaterialLot } from "../rawMaterials/types";
import { CompanyId } from "../sales/types";
import { KG_PER_HOSO_EQ_TON } from "./money";
import { CompanyFinanceState, FinanceValidationError, ReceivableRecord, nonNegativeUsd, usd } from "./types";

/** 1社ぶんの初期財務フィクスチャ（原料在庫・利益剰余金以外の暫定値）。 */
export interface InitialFinanceFixture {
  readonly companyId: CompanyId;
  readonly cash: number;
  /**
   * ゲーム開始前（前四半期）の販売に対応する初期売掛金。開始四半期に回収される。
   * 継続企業として開始するための残高であり、これがないと1四半期目に
   * 「売上は翌期回収・費用は当期支払」の片側だけが発生し、実際には存在しない
   * 巨額の初期資金流出（コールドスタート）が生じてしまう。
   */
  readonly initialAccountsReceivable: number;
  readonly otherCurrentAssets: number;
  readonly fixedAssetsGross: number;
  readonly shortTermLoans: number;
  readonly longTermLoans: number;
  readonly otherLiabilities: number;
  readonly capitalStock: number;
}

/** 5社の初期財務フィクスチャ（すべてUSD。暫定値・要校正）。 */
export const INITIAL_FINANCE_FIXTURES_V1: readonly InitialFinanceFixture[] = [
  { companyId: "BAL", cash: 30_000_000, initialAccountsReceivable: 70_000_000, otherCurrentAssets: 5_000_000, fixedAssetsGross: 90_000_000, shortTermLoans: 20_000_000, longTermLoans: 30_000_000, otherLiabilities: 5_000_000, capitalStock: 50_000_000 },
  { companyId: "MASS", cash: 30_000_000, initialAccountsReceivable: 45_000_000, otherCurrentAssets: 4_000_000, fixedAssetsGross: 110_000_000, shortTermLoans: 35_000_000, longTermLoans: 45_000_000, otherLiabilities: 6_000_000, capitalStock: 40_000_000 },
  { companyId: "JPQ", cash: 25_000_000, initialAccountsReceivable: 40_000_000, otherCurrentAssets: 3_000_000, fixedAssetsGross: 70_000_000, shortTermLoans: 10_000_000, longTermLoans: 20_000_000, otherLiabilities: 3_000_000, capitalStock: 45_000_000 },
  { companyId: "VAP", cash: 22_000_000, initialAccountsReceivable: 45_000_000, otherCurrentAssets: 3_000_000, fixedAssetsGross: 85_000_000, shortTermLoans: 15_000_000, longTermLoans: 30_000_000, otherLiabilities: 4_000_000, capitalStock: 40_000_000 },
  { companyId: "CONSV", cash: 35_000_000, initialAccountsReceivable: 28_000_000, otherCurrentAssets: 2_000_000, fixedAssetsGross: 45_000_000, shortTermLoans: 0, longTermLoans: 8_000_000, otherLiabilities: 2_000_000, capitalStock: 50_000_000 },
];

/**
 * 原料ロット一覧から、財務上の原料在庫金額（USD）を算出する。
 * 対象は「取得原価を既に認識しているロット」= status "available"（使用可能）と
 * "inTransitImport"（輸送中輸入。発注時に在庫・買掛金を認識する会計方針のため）。
 * "growingAquaculture"（養殖中）は収穫時に一括認識する方針のため含めない
 * （Phase 8Aの簡略化。§FINANCIAL_ARCHITECTURE文書参照）。
 */
export function rawMaterialInventoryValueUsd(lots: readonly RawMaterialLot[], companyId: CompanyId): number {
  let total = 0;
  for (const lot of lots) {
    if (lot.companyId !== companyId) continue;
    if (lot.status !== "available" && lot.status !== "inTransitImport") continue;
    total += unwrapUnit(lot.remainingQuantity) * KG_PER_HOSO_EQ_TON * unwrapUnit(lot.unitCost);
  }
  return total;
}

/**
 * 1社ぶんの初期財務状態を構築する。開始時点で 資産 = 負債 + 純資産 が
 * 厳密に成立する（利益剰余金を残差として決定するため）。
 * startPeriodは初期売掛金の回収予定期（＝開始四半期。前四半期販売分が
 * 開始四半期に回収される継続企業の前提）に使う。
 */
export function buildInitialCompanyFinanceState(
  companyId: CompanyId,
  initialRawMaterialLots: readonly RawMaterialLot[],
  startPeriod: PeriodV2
): CompanyFinanceState {
  const fixture = INITIAL_FINANCE_FIXTURES_V1.find((f) => f.companyId === companyId);
  if (!fixture) {
    throw new FinanceValidationError(`初期財務フィクスチャが定義されていない会社IDです: ${companyId}`);
  }
  const rawMaterialInventory = rawMaterialInventoryValueUsd(initialRawMaterialLots, companyId);

  const totalAssets = fixture.cash + fixture.initialAccountsReceivable + rawMaterialInventory + fixture.otherCurrentAssets + fixture.fixedAssetsGross;
  const totalLiabilities = fixture.shortTermLoans + fixture.longTermLoans + fixture.otherLiabilities;
  const retainedEarnings = totalAssets - totalLiabilities - fixture.capitalStock;

  const initialReceivables: ReceivableRecord[] =
    fixture.initialAccountsReceivable > 0
      ? [
          {
            id: `${companyId}-AR-initial`,
            companyId,
            // 市場帰属は存在しない（ゲーム開始前の販売の合算残高）ため、便宜上"OTHER"を
            // 使う。回収スケジュール以外には使用しない（sourceRef参照）。
            market: "OTHER",
            amount: nonNegativeUsd(fixture.initialAccountsReceivable, "初期売掛金"),
            originPeriod: startPeriod,
            dueSettlementPeriod: startPeriod,
            sourceRef: "initial:pre-game-sales",
          },
        ]
      : [];

  return {
    companyId,
    cash: usd(fixture.cash),
    receivables: initialReceivables,
    payables: [],
    otherCurrentAssets: nonNegativeUsd(fixture.otherCurrentAssets, "その他流動資産"),
    fixedAssetsGross: nonNegativeUsd(fixture.fixedAssetsGross, "固定資産（取得原価）"),
    accumulatedDepreciation: nonNegativeUsd(0, "減価償却累計額"),
    shortTermLoans: nonNegativeUsd(fixture.shortTermLoans, "短期借入金"),
    longTermLoans: nonNegativeUsd(fixture.longTermLoans, "長期借入金"),
    otherLiabilities: nonNegativeUsd(fixture.otherLiabilities, "その他負債"),
    capitalStock: nonNegativeUsd(fixture.capitalStock, "資本金"),
    retainedEarnings: usd(retainedEarnings),
    finishedGoodsCostLedger: [],
  };
}
