// ShrimpX V2 — 財務モジュール 型定義（Phase 8A）
//
// 会社ごと・四半期ごとに、既存の事業実績データ（契約履行・原料ロット・生産バッチ・
// 品質調整・意思決定）から原価・運転資本・PL/BS/CFを生成するための型一式。
//
// 【設計原則（実装指示 §1）】
//   - 財務側で販売量・生産量・廃棄量・価格を再計算しない（既存Phaseの実績値が唯一の情報源）。
//   - 金額の基準通貨はUSD（プレーンなUSD額。表示上の百万USD換算は表示層の責務で、
//     内部計算では丸めない）。
//   - 価格はUSD/HOSO換算kg・数量はHOSO換算トンのため、金額換算の×1,000 kg/tonは
//     必ず money.ts の amountFromTonsAndUnitPrice を通す（桁誤り防止）。
//   - NaN/Infinityはスマートコンストラクタ（usd）で拒否する。
//   - 負数を許容する値（現金・利益剰余金・損益・CF）と、負数を許容しない残高
//     （在庫金額・売掛金・買掛金・借入金・数量）を型コメントで区別し、
//     負数禁止の残高は生成箇所の検証関数で拒否する。

import { PeriodV2 } from "../core/period";
import { Product, DemandMarketId } from "../market/types";
import { CompanyId } from "../sales/types";

// ---------------------------------------------------------------------
// 1. USD金額型
// ---------------------------------------------------------------------

declare const usdBrand: unique symbol;

/**
 * プレーンなUSD金額（百万USDではない）。負数を許容する（損益・CF・現金は
 * マイナスになりうる）。負数を許容しない残高は、各生成関数で
 * assertNonNegativeUsd を通して検証する。
 */
export type Usd = number & { readonly [usdBrand]: "Usd" };

export class FinanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinanceValidationError";
  }
}

/** USD金額の唯一の生成経路。NaN/Infinityを拒否する。負数は許容する。 */
export function usd(n: number): Usd {
  if (!Number.isFinite(n)) {
    throw new FinanceValidationError(`Usd金額が有限の数値ではありません: ${n}`);
  }
  return n as Usd;
}

/** 負数を許容しない残高（在庫金額・売掛金・買掛金・借入金等）の検証つき生成。 */
export function nonNegativeUsd(n: number, label: string): Usd {
  const v = usd(n);
  if (v < 0) {
    throw new FinanceValidationError(`${label} は負数を許容しない残高ですが、負の値を受け取りました: ${n}`);
  }
  return v;
}

export function unwrapUsd(v: Usd): number {
  return v as unknown as number;
}

// ---------------------------------------------------------------------
// 2. コスト特性・コストドライバー（Phase 8A追加要件: 固変分解）
// ---------------------------------------------------------------------

/** コスト特性。mixedは必ず固定部分と変動部分を分離して保存する（合計からの再推定禁止）。 */
export type CostBehavior = "variable" | "fixed" | "mixed" | "stepFixed";

/**
 * コストドライバー。Phase 8Aで全部を使う必要はないが、後からドライバーを
 * 追加できるよう文字列リテラルunionとして拡張可能にしておく（実装指示の列挙）。
 */
export type CostDriver =
  | "rawMaterialPurchaseQuantity" // 原料購入量
  | "rawMaterialInputQuantity" // 原料投入量
  | "productionQuantity" // 生産量
  | "reworkQuantity" // 再加工量
  | "discardQuantity" // 廃棄量
  | "salesQuantity" // 販売量
  | "fulfillmentQuantity" // 契約履行量
  | "laborHours" // 労働時間
  | "overtimeHours" // 残業時間
  | "temporaryWorkerHeadcount" // 臨時ワーカー人数
  | "factoryCount" // 工場数
  | "activeEquipmentCapacity" // 稼働設備能力
  | "regularHeadcount" // 正社員数
  | "marketCount" // 市場数
  | "productCount" // 商品数
  | "loanBalance" // 借入残高（支払利息）
  | "fixedAssetBalance" // 固定資産残高（減価償却）
  | "none"; // ドライバーなし（純粋な期間固定費）

/** 勘定科目（原価・費用の分類）。財務会計PLの表示行とは独立した、費用の発生源分類。 */
export type CostAccount =
  | "domesticRawMaterial" // 国内原料費
  | "importedRawMaterial" // 輸入原料費
  | "aquacultureRawMaterial" // 養殖原料費
  | "directLaborRegular" // 直接労務費（正社員）
  | "temporaryWorker" // 臨時ワーカー費
  | "overtime" // 残業費
  | "hosoProcessing" // HOSO加工費（基準加工費）
  | "pdAdditionalProcessing" // PD追加加工費
  | "vapAdditionalProcessing" // VAP追加加工費
  | "factoryFixed" // 工場固定費（賃借・保全・工場管理）
  | "factoryUtility" // 工場ユーティリティ等（その他の製造間接費、混合費）
  | "depreciation" // 減価償却費
  | "rework" // 再加工費
  | "discardLoss" // 廃棄損（品質廃棄・期限切れ廃棄）
  | "downgradeSalesDeduction" // 格落ちによる売上控除
  | "sellingLogistics" // 変動販売物流費
  | "salesForceSalary" // 営業人件費
  | "procurementSalary" // 調達人件費
  | "adminFixed" // 一般管理固定費
  | "interestExpense" // 支払利息
  | "incomeTax"; // 法人税

/** 短期的な削減可能性（意思決定情報。校正しやすいよう3値の定性区分にする）。 */
export type ShortTermReducibility = "reducible" | "partiallyReducible" | "committed";

/**
 * 1件のコスト記録。混合費（mixed）は合計額だけでなく固定部分・変動部分を
 * 分離して保存する（fixedPortion + variablePortion = 合計。二重計上禁止）。
 * 発生元となった実績データへの参照はsourceRefに人間可読の識別子で保持する。
 */
export interface CostRecord {
  readonly account: CostAccount;
  readonly behavior: CostBehavior;
  /** 固定費部分（USD）。variable費では0。 */
  readonly fixedPortion: Usd;
  /** 変動費部分（USD）。fixed/stepFixed費では0。 */
  readonly variablePortion: Usd;
  readonly driver: CostDriver;
  /** ドライバー数量（トン・人数・残高USD等。ドライバーの単位に従う）。 */
  readonly driverQuantity: number;
  /** ドライバー単価（変動費部分 ÷ ドライバー数量。ドライバー数量0の場合は0）。 */
  readonly driverUnitRate: number;
  readonly product?: Product;
  readonly market?: DemandMarketId;
  readonly factoryId?: string;
  readonly period: PeriodV2;
  readonly shortTermReducibility: ShortTermReducibility;
  /** 発生元となった実績データの説明（例: "batches:BAL-F1-hoso-2015Q1"）。 */
  readonly sourceRef: string;
}

// ---------------------------------------------------------------------
// 3. 完成品原価台帳（在庫評価: ロット別実際原価法＝FIFO系）
// ---------------------------------------------------------------------

/**
 * 完成品1ロットぶんの単位原価内訳（USD/HOSO換算トン）。
 * 変動費と固定費（全部原価計算で在庫へ配賦する固定製造費）を分離して保持し、
 * 全部原価計算PLと変動原価計算レポートの利益差異を期末在庫中の固定製造費で
 * 正確に説明できるようにする。
 */
export interface FinishedGoodsUnitCostBreakdown {
  /** 原料費（このロットが実際に消費した原料ロットの取得原価に基づく）。 */
  readonly rawMaterialPerTon: number;
  /** 基準加工費＋PD/VAP追加加工費（変動費）。 */
  readonly processingPerTon: number;
  /** 変動労務費（臨時ワーカー費＋残業費の配賦）。 */
  readonly laborVariablePerTon: number;
  /** 変動ユーティリティ費の配賦。 */
  readonly utilityVariablePerTon: number;
  /** 固定労務費（正社員直接労務費の配賦）。 */
  readonly laborFixedPerTon: number;
  /** 工場固定費の配賦。 */
  readonly factoryFixedPerTon: number;
  /** 固定ユーティリティ費の配賦。 */
  readonly utilityFixedPerTon: number;
  /** 減価償却費の配賦。 */
  readonly depreciationPerTon: number;
}

/**
 * 完成品原価台帳の1エントリ。数量の真実は常にproduction側のFinishedGoodsLotに
 * あり、本台帳は「そのロットの単位原価」だけを追加保持する。毎四半期、実際の
 * ロット残数量と照合し、消費記録で説明できない減少（期限切れ等）は在庫廃棄損
 * として当期認識する（台帳と実在庫の乖離を構造的に禁止する）。
 */
export interface FinishedGoodsCostLedgerEntry {
  readonly lotId: string;
  readonly companyId: CompanyId;
  readonly product: Product;
  /** 台帳上の残数量（HOSO換算トン。毎四半期、実ロットのremainingQuantityと同期する）。負数禁止。 */
  readonly remainingQuantity: number;
  readonly unitCost: FinishedGoodsUnitCostBreakdown;
  /** このロットの格落ち率（0〜1）。販売時の売上控除の按分に使う。 */
  readonly downgradeRatio: number;
  readonly producedPeriod: PeriodV2;
}

/** 単位原価内訳の変動費合計（USD/トン）。 */
export function variableUnitCostPerTon(u: FinishedGoodsUnitCostBreakdown): number {
  return u.rawMaterialPerTon + u.processingPerTon + u.laborVariablePerTon + u.utilityVariablePerTon;
}

/** 単位原価内訳の固定費合計（USD/トン）。 */
export function fixedUnitCostPerTon(u: FinishedGoodsUnitCostBreakdown): number {
  return u.laborFixedPerTon + u.factoryFixedPerTon + u.utilityFixedPerTon + u.depreciationPerTon;
}

/** 単位原価内訳の総合計（USD/トン、全部原価計算の在庫単価）。 */
export function totalUnitCostPerTon(u: FinishedGoodsUnitCostBreakdown): number {
  return variableUnitCostPerTon(u) + fixedUnitCostPerTon(u);
}

// ---------------------------------------------------------------------
// 4. 売掛金・買掛金（運転資本）
// ---------------------------------------------------------------------

/**
 * 売掛金1件。発生元（契約履行）・金額・発生期・予定決済期を保持する。
 * 金額は格落ち売上控除を差し引いた回収予定額（負数禁止）。
 */
export interface ReceivableRecord {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  /** 回収予定額（USD、売上控除差引後）。 */
  readonly amount: Usd;
  readonly originPeriod: PeriodV2;
  readonly dueSettlementPeriod: PeriodV2;
  /** 発生元の説明（例: "fulfillment:2015Q1"）。 */
  readonly sourceRef: string;
}

export type PayableSource = "importRawMaterial";

/** 買掛金1件。発生元・金額・発生期・予定決済期を保持する（負数禁止）。 */
export interface PayableRecord {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly source: PayableSource;
  readonly amount: Usd;
  readonly originPeriod: PeriodV2;
  readonly dueSettlementPeriod: PeriodV2;
  readonly sourceRef: string;
}

// ---------------------------------------------------------------------
// 5. 会社別の財務状態（四半期をまたいで繰り越す）
// ---------------------------------------------------------------------

/**
 * 1社ぶんの財務状態。advanceCompanyLabQuarterの財務決算処理が、前期の本状態と
 * 当期の事業実績から当期のCompanyFinancialQuarterResultと次期の本状態を生成する。
 *
 * Phase 8Aでは新規借入・返済・設備投資の意思決定は実装しないが、既存借入・
 * 固定資産をPhase 8Bで接続できるよう残高として保持する。
 */
export interface CompanyFinanceState {
  readonly companyId: CompanyId;
  /** 現金（負数を許容する。マイナス＝明示的な資金不足状態であり、勝手な資金注入で隠さない）。 */
  readonly cash: Usd;
  readonly receivables: readonly ReceivableRecord[];
  readonly payables: readonly PayableRecord[];
  /** その他流動資産（Phase 8Aでは定数。負数禁止）。 */
  readonly otherCurrentAssets: Usd;
  /** 固定資産（取得原価総額。負数禁止）。 */
  readonly fixedAssetsGross: Usd;
  /** 減価償却累計額（負数禁止、fixedAssetsGross以下）。 */
  readonly accumulatedDepreciation: Usd;
  /** 短期借入金（Phase 8Aでは返済・新規借入なしの固定残高。負数禁止）。 */
  readonly shortTermLoans: Usd;
  /** 長期借入金（同上。負数禁止）。 */
  readonly longTermLoans: Usd;
  /** その他負債（Phase 8Aでは定数。負数禁止）。 */
  readonly otherLiabilities: Usd;
  /** 資本金（負数禁止）。 */
  readonly capitalStock: Usd;
  /** 利益剰余金（負数を許容する。毎四半期、当期純利益でロールフォワードする）。 */
  readonly retainedEarnings: Usd;
  /** 完成品原価台帳（在庫評価の会社別レジャー）。 */
  readonly finishedGoodsCostLedger: readonly FinishedGoodsCostLedgerEntry[];
}

/** 会社ラボ全体の財務状態（5社ぶん）。 */
export interface FinanceState {
  readonly companies: readonly CompanyFinanceState[];
}

// ---------------------------------------------------------------------
// 6. PL（財務会計: 全部原価計算）
// ---------------------------------------------------------------------

/** 売上原価の内訳（販売した完成品に含まれる原価＋当期認識の品質費用）。 */
export interface CostOfSalesBreakdown {
  /** 販売分に含まれる原料費。 */
  readonly rawMaterialCost: Usd;
  /** 販売分に含まれる加工費（基準＋PD/VAP追加、変動ユーティリティ含む）。 */
  readonly processingCost: Usd;
  /**
   * 販売分に含まれる人件費（変動労務＋固定労務の配賦）。
   * 【feature/v2-idle-labor-cost】正社員の固定労務費については、実際に商品・生産バッチへ
   * 配属された（productiveな）人数ぶんのみが含まれる。未配属・遊休の正社員給与は
   * ここには一切含まれず、下のidleLaborCostへ分離して当期費用として認識する。
   */
  readonly laborCost: Usd;
  /** 販売分に含まれる工場固定費（固定ユーティリティ・減価償却の配賦を含む）。 */
  readonly factoryFixedCost: Usd;
  /** 当期の再加工費（期間費用。数量は失われないため在庫評価には含めない）。 */
  readonly reworkCost: Usd;
  /** 当期の廃棄損（品質廃棄＋原料/完成品の期限切れ廃棄。在庫には残さない）。 */
  readonly discardLoss: Usd;
  /** 生産ゼロ等で在庫へ配賦されなかった固定製造費（当期の期間費用として認識）。 */
  readonly unabsorbedFixedManufacturingCost: Usd;
  /**
   * 【feature/v2-idle-labor-cost】遊休労務費（未吸収固定製造費の一種）。
   * (会社全体の正社員数 − 実際に商品・生産バッチへ配属された正社員数) × 正社員1人当たり
   * 四半期給与。未配属正社員の給与は発生しているが製造原価（商品別単位原価・完成品在庫）へは
   * 一切吸収せず、発生した四半期に全額を売上原価区分の独立項目として費用化する。
   * 販売数量に関わらず当期全額を認識するため、後の四半期に在庫を販売してもここへは
   * 再計上されない。実労務データが無い"legacy"モードでは、未配属人数を信頼できる形で
   * 算定できないため常に0（従来どおり正社員給与を全額商品原価へ配賦する）。
   */
  readonly idleLaborCost: Usd;
}

/** 財務会計PL（全部原価計算）。 */
export interface ProfitAndLossStatement {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** 売上高（契約単価×履行数量の総額）。 */
  readonly grossRevenue: Usd;
  /** 格落ち・品質関連売上控除（負数禁止、控除額を正の値で保持）。 */
  readonly qualitySalesDeduction: Usd;
  /** 純売上高（= grossRevenue - qualitySalesDeduction）。 */
  readonly netRevenue: Usd;
  readonly costOfSales: CostOfSalesBreakdown;
  /** 売上原価合計（costOfSalesの全項目の合計）。 */
  readonly totalCostOfSales: Usd;
  /** 売上総利益（= netRevenue - totalCostOfSales）。 */
  readonly grossProfit: Usd;
  /** 販売費及び一般管理費（営業・調達人件費＋一般管理固定費＋変動販売物流費）。 */
  readonly sellingGeneralAdmin: Usd;
  /** 営業利益。 */
  readonly operatingProfit: Usd;
  /** 支払利息（既存借入に対する簡易利息）。 */
  readonly interestExpense: Usd;
  /** 税引前利益。 */
  readonly profitBeforeTax: Usd;
  /** 法人税（税引前利益が正の場合のみ。繰越欠損金はPhase 8B以降）。 */
  readonly incomeTax: Usd;
  /** 当期純利益。 */
  readonly netIncome: Usd;
}

// ---------------------------------------------------------------------
// 7. BS
// ---------------------------------------------------------------------

export interface BalanceSheet {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** 現金（負数許容＝明示的な資金不足状態）。 */
  readonly cash: Usd;
  readonly accountsReceivable: Usd;
  readonly rawMaterialInventory: Usd;
  readonly finishedGoodsInventory: Usd;
  readonly otherCurrentAssets: Usd;
  /** 固定資産（純額 = 取得原価 - 減価償却累計額）。 */
  readonly fixedAssetsNet: Usd;
  /**
   * 建設中の設備投資案件の累計支払額（未完成、Phase 8B-2A）。まだ固定資産へ
   * 振替えていない金額であり、完成した時点でfixedAssetsNet側へ移る（減価償却は
   * 完成後も開始しない。finance/types.tsのCapexAdjustmentコメント参照）。
   * capex未指定（Phase 8A/8B-1互換の呼び出し）では常に0。
   */
  readonly constructionInProgress: Usd;
  readonly totalAssets: Usd;
  readonly accountsPayable: Usd;
  readonly shortTermLoans: Usd;
  readonly longTermLoans: Usd;
  /**
   * 未払利息（Phase 8B-1）。当期発生した支払利息のうち、資金制約により
   * 現金で支払えなかった分（次期以降に繰り越す負債）。financing未指定
   * （Phase 8A互換の呼び出し）では常に0。
   */
  readonly accruedInterestPayable: Usd;
  readonly otherLiabilities: Usd;
  readonly totalLiabilities: Usd;
  readonly capitalStock: Usd;
  readonly retainedEarnings: Usd;
  readonly totalEquity: Usd;
  readonly totalLiabilitiesAndEquity: Usd;
  /** 貸借差額（totalAssets - totalLiabilitiesAndEquity。許容誤差内で0であること）。 */
  readonly balanceDifference: Usd;
}

// ---------------------------------------------------------------------
// 8. CF（主表: 直接法。補助内訳として間接法照合を持つ）
// ---------------------------------------------------------------------

/** 営業活動によるCFの直接法内訳。 */
export interface OperatingCashFlowDirect {
  /** 顧客からの回収（当期に決済期が到来した売掛金の回収額）。 */
  readonly receiptsFromCustomers: Usd;
  /** 原料仕入の支払（国内即金＋輸入買掛決済＋養殖収穫時認識）。負の値（支出）で保持。 */
  readonly paymentsForRawMaterials: Usd;
  /** 労務・加工・工場運営費の支払（減価償却は非現金のため含まない）。負の値。 */
  readonly paymentsForManufacturing: Usd;
  /** 販売費及び一般管理費の支払。負の値。 */
  readonly paymentsForSellingGeneralAdmin: Usd;
  /** 支払利息。負の値。 */
  readonly interestPaid: Usd;
  /** 法人税の支払。負の値。 */
  readonly incomeTaxPaid: Usd;
}

/** 間接法による営業CFの照合（補助内訳。直接法の営業CFと一致すること）。 */
export interface OperatingCashFlowIndirectReconciliation {
  readonly netIncome: Usd;
  readonly depreciationAddback: Usd;
  /** 売掛金の増加（マイナス要因を正の増加額として保持）。 */
  readonly increaseInReceivables: Usd;
  /** 買掛金の増加（プラス要因を正の増加額として保持）。 */
  readonly increaseInPayables: Usd;
  /** 在庫（原料＋完成品）の増加（マイナス要因を正の増加額として保持）。 */
  readonly increaseInInventory: Usd;
  /**
   * 未払利息の増加（Phase 8B-1。プラス要因を正の増加額として保持。
   * financing未指定では常に0）。
   */
  readonly increaseInAccruedInterestPayable: Usd;
  /** 間接法による営業CF（= netIncome + depreciation - ΔAR + ΔAP - ΔInventory + Δ未払利息）。 */
  readonly operatingCashFlowIndirect: Usd;
}

export interface CashFlowStatement {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly operatingDirect: OperatingCashFlowDirect;
  /** 営業活動によるCF（直接法合計）。 */
  readonly operatingCashFlow: Usd;
  /** 投資活動によるCF（Phase 8Aでは新規投資なしのため0）。 */
  readonly investingCashFlow: Usd;
  /** 財務活動によるCF（Phase 8Aでは新規借入・返済なしのため0）。 */
  readonly financingCashFlow: Usd;
  /** 現金増減（= CFO + CFI + CFF）。 */
  readonly netCashChange: Usd;
  readonly openingCash: Usd;
  readonly closingCash: Usd;
  readonly indirectReconciliation: OperatingCashFlowIndirectReconciliation;
  /** 直接法CFOと間接法CFOの差（許容誤差内で0であること）。 */
  readonly directIndirectDifference: Usd;
}

// ---------------------------------------------------------------------
// 9. 品質損失内訳・原価内訳（報告用）
// ---------------------------------------------------------------------

/** 当期の品質損失の財務内訳（Phase 7A実績からの金額換算。二重計上禁止）。 */
export interface QualityLossBreakdown {
  /** 廃棄数量の変動製造原価相当（在庫に残さず当期認識）。 */
  readonly qualityDiscardLoss: Usd;
  /** 原料の期限切れ廃棄損。 */
  readonly rawMaterialExpiryLoss: Usd;
  /** 完成品の期限切れ等による在庫廃棄損。 */
  readonly finishedGoodsWriteOffLoss: Usd;
  /** 再加工費（数量は失われない。追加加工費のみ）。 */
  readonly reworkCost: Usd;
  /** 格落ちによる売上控除（販売時に認識。数量は失われない）。 */
  readonly downgradeSalesDeduction: Usd;
  readonly discardQuantityTons: number;
  readonly reworkQuantityTons: number;
  readonly downgradeQuantitySoldTons: number;
}

/** 当期に発生した製造原価の内訳（発生ベース。在庫振替前）。 */
export interface ManufacturingCostBreakdown {
  readonly domesticRawMaterialCost: Usd;
  readonly importedRawMaterialCost: Usd;
  readonly aquacultureRawMaterialCost: Usd;
  /**
   * 当期の正社員給与総額（会社全体のregularHeadcount×1人当たり四半期給与。未配属・遊休分を
   * 含む会社全体の現金支出・コミットメント総額）。CF（労務費現金支出）やコスト記録
   * （directLaborRegular、stepFixed）はこの総額ベースのまま変更しない。
   * 【feature/v2-idle-labor-cost】常に productiveRegularLaborCost + idleLaborCost と一致する。
   */
  readonly regularLaborCost: Usd;
  /**
   * 【feature/v2-idle-labor-cost】regularLaborCostのうち、実際に商品・生産バッチへ配属された
   * （productiveな）正社員ぶんのみ。商品別製造原価・完成品在庫へ配賦されるのはこの金額のみ。
   * "legacy"モードではregularLaborCostと完全に一致する（後方互換、未配属人数を算定しないため）。
   */
  readonly productiveRegularLaborCost: Usd;
  /**
   * 【feature/v2-idle-labor-cost】regularLaborCostのうち、未配属・遊休の正社員ぶん
   * （= regularLaborCost − productiveRegularLaborCost）。製品原価・完成品在庫へは一切含めず、
   * 発生四半期にCostOfSalesBreakdown.idleLaborCostとして全額費用化する。"legacy"モードでは常に0。
   */
  readonly idleLaborCost: Usd;
  readonly temporaryWorkerCost: Usd;
  readonly overtimeCost: Usd;
  readonly hosoProcessingCost: Usd;
  readonly pdAdditionalProcessingCost: Usd;
  readonly vapAdditionalProcessingCost: Usd;
  readonly factoryFixedCost: Usd;
  readonly utilityFixedCost: Usd;
  readonly utilityVariableCost: Usd;
  readonly depreciationCost: Usd;
  readonly reworkCost: Usd;
}

// ---------------------------------------------------------------------
// 10. 管理会計（限界利益・損益分岐点・利益差異調整）
// ---------------------------------------------------------------------

/** 商品別・市場別の限界利益（直接帰属可能な範囲のみ。共通固定費は配賦しない）。 */
export interface ContributionMarginByDimension {
  readonly key: string;
  readonly grossRevenue: Usd;
  readonly salesDeduction: Usd;
  readonly netRevenue: Usd;
  readonly variableCost: Usd;
  readonly contributionMargin: Usd;
  /** 純売上高0の場合はundefined。 */
  readonly contributionMarginRatio?: number;
  /** この単位に直接帰属できる固定費（Phase 8Aでは0が基本。構造として保持）。 */
  readonly directFixedCost: Usd;
}

/** 変動原価計算ベースの限界利益レポート（管理会計）。 */
export interface ContributionMarginReport {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly grossRevenue: Usd;
  readonly salesDeduction: Usd;
  readonly netRevenue: Usd;
  /** 変動原料費（販売分に含まれる原料費）。 */
  readonly variableRawMaterialCost: Usd;
  /** 変動加工費（販売分の基準・追加加工費＋変動ユーティリティ）。 */
  readonly variableProcessingCost: Usd;
  /** 変動労務費（販売分の臨時ワーカー費・残業費配賦）。 */
  readonly variableLaborCost: Usd;
  /** 変動品質費（当期の再加工費＋廃棄損の変動費相当）。 */
  readonly variableQualityCost: Usd;
  /** 変動販売費（販売物流費）。 */
  readonly variableSellingCost: Usd;
  readonly totalVariableCost: Usd;
  readonly contributionMargin: Usd;
  /** 純売上高0の場合はundefined。 */
  readonly contributionMarginRatio?: number;
  /** 固定製造費（当期発生額: 正社員労務費＋工場固定費＋固定ユーティリティ＋減価償却）。 */
  readonly fixedManufacturingCost: Usd;
  /** 固定人件費（営業・調達人件費）。 */
  readonly fixedPersonnelCost: Usd;
  /** 固定販管費（一般管理固定費）。 */
  readonly fixedSellingAdminCost: Usd;
  readonly totalFixedCost: Usd;
  /** 管理会計上の営業利益（= contributionMargin - totalFixedCost）。 */
  readonly managementOperatingProfit: Usd;
  /** 損益分岐点売上高（= totalFixedCost ÷ 限界利益率。限界利益率が0以下ならundefined）。 */
  readonly breakEvenRevenue?: Usd;
  /** 安全余裕額（= netRevenue - breakEvenRevenue）。 */
  readonly marginOfSafety?: Usd;
  /** 安全余裕率（= marginOfSafety / netRevenue）。 */
  readonly marginOfSafetyRatio?: number;
  /** 経営レバレッジ（= contributionMargin / managementOperatingProfit。営業利益が0以下ならundefined）。 */
  readonly operatingLeverage?: number;
  /** 損益分岐点計算の前提となった商品構成（純売上高構成比）。 */
  readonly assumedProductMix: readonly { readonly product: Product; readonly netRevenueShare: number }[];
  readonly byProduct: readonly ContributionMarginByDimension[];
  readonly byMarket: readonly ContributionMarginByDimension[];
  /** 商品・市場へ配賦していない共通固定費（= totalFixedCost - 各直接固定費の合計）。 */
  readonly commonFixedCost: Usd;
  /**
   * 商品別へ直接帰属できない共通変動費（原料の期限切れ廃棄損等）。
   * Σ(商品別限界利益) = 全社限界利益 + commonVariableCost が成立する
   * （共通変動費を商品別へ恣意的に配賦しない）。
   */
  readonly commonVariableCost: Usd;
}

/** 全部原価計算と変動原価計算の営業利益差異調整表。 */
export interface AbsorptionVariableReconciliation {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** 期首完成品在庫に含まれていた固定製造費。 */
  readonly fixedCostInOpeningInventory: Usd;
  /** 当期に完成品在庫へ配賦した固定製造費。 */
  readonly fixedCostAbsorbedIntoInventory: Usd;
  /** 当期販売により在庫から売上原価へ費用化した固定製造費。 */
  readonly fixedCostReleasedThroughSales: Usd;
  /** 在庫廃棄（期限切れ等）により在庫から費用化した固定製造費。 */
  readonly fixedCostReleasedThroughWriteOff: Usd;
  /** 期末完成品在庫に残る固定製造費。 */
  readonly fixedCostInClosingInventory: Usd;
  /** 財務会計（全部原価計算）上の営業利益。 */
  readonly absorptionOperatingProfit: Usd;
  /** 変動原価計算上の営業利益。 */
  readonly variableCostingOperatingProfit: Usd;
  /** 両者の差額（= 期末在庫中固定製造費 - 期首在庫中固定製造費 と一致すること）。 */
  readonly profitDifference: Usd;
}

// ---------------------------------------------------------------------
// 11. 四半期財務結果（会社ラボのCompanyQuarterRecordへ保存する単位）
// ---------------------------------------------------------------------

export interface CompanyFinancialQuarterResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly profitAndLoss: ProfitAndLossStatement;
  readonly balanceSheet: BalanceSheet;
  readonly cashFlow: CashFlowStatement;
  readonly manufacturingCost: ManufacturingCostBreakdown;
  readonly qualityLoss: QualityLossBreakdown;
  readonly costRecords: readonly CostRecord[];
  readonly contributionMargin: ContributionMarginReport;
  readonly absorptionVariableReconciliation: AbsorptionVariableReconciliation;
  /** 現金がマイナス（資金不足）の場合true。勝手な資金注入で隠さず明示的に記録する。 */
  readonly cashShortfall: boolean;
  /** 資金不足額（現金がマイナスの場合の絶対値。それ以外は0）。 */
  readonly cashShortfallAmount: Usd;
  /** 債務超過（純資産がマイナス）の場合true。 */
  readonly negativeEquity: boolean;
}

// ---------------------------------------------------------------------
// 12. 資金繰り調整（Phase 8B-1）。closeFinancialQuarterへの追加的・任意の入力。
// ---------------------------------------------------------------------

/**
 * financing/（Phase 8B-1）が算出した、当期の借入・返済・利息の会計三表への
 * 反映内容。closeFinancialQuarterの任意引数として渡す。
 *
 * 【後方互換の設計原則】この引数を渡さない場合、closeFinancialQuarterは
 * Phase 8Aと完全に同一の計算（既存借入残高×固定利率の簡易利息、
 * financingCashFlow=0、借入残高は前期から不変）を行う。既存830件超のテストは
 * 一切この引数を渡さないため、挙動・数値は一切変化しない。
 *
 * 【二重計上防止の設計】元本の返済・借入実行はBSの借入残高（financing側の
 * 融資ポートフォリオが唯一の真実）とCFのfinancingCashFlowだけに反映し、
 * PLには一切計上しない（元本はPL費用にしない、という実装指示を型レベルで
 * 強制する：本インターフェースに元本相当のPL項目を持たせていない）。
 * 延滞元本は融資ポートフォリオ側（financing/types.tsのLoanRecord）で
 * 「返済されなかった残高がそのまま残る」というnull-opとして表現され、
 * BS側に別建ての残高として二重計上しない（docs/v2/FINANCIAL_ARCHITECTURE_v0.1.md
 * 追記§資金繰り参照）。
 */
export interface FinancingAdjustment {
  /** 当期発生した支払利息合計（通常融資＋緊急融資＋延滞加算。発生主義でPLへ計上）。 */
  readonly interestExpenseUsd: number;
  /** 当期に現金で実際に支払った利息（資金制約で全額を払えない場合はinterestExpenseUsdより小さい）。 */
  readonly interestPaidCashUsd: number;
  /** 当期の新規借入実行額（通常融資＋緊急融資の合計。CFFのプラス）。 */
  readonly loanDrawUsd: number;
  /** 当期に現金で実際に支払った元本返済額（CFFのマイナス。PLには計上しない）。 */
  readonly principalRepaymentCashUsd: number;
  /** 融資ポートフォリオから算出した期末短期借入金残高（BS shortTermLoansを置き換える）。 */
  readonly endingShortTermLoansUsd: number;
  /** 融資ポートフォリオから算出した期末長期借入金残高（BS longTermLoansを置き換える）。 */
  readonly endingLongTermLoansUsd: number;
  /** 期首未払利息残高（前期から繰り越し。financing側のCompanyFinancingState.accruedInterestPayableUsdと一致する）。 */
  readonly beginningAccruedInterestPayableUsd: number;
}

// ---------------------------------------------------------------------
// 13. 設備投資調整（Phase 8B-2A）。closeFinancialQuarterへの追加的・任意の入力。
// ---------------------------------------------------------------------

/**
 * capex/（Phase 8B-2A）が算出した、当期の設備投資案件の支払・完成振替の
 * 会計三表への反映内容。closeFinancialQuarterの任意引数として渡す。
 *
 * 【後方互換の設計原則】この引数を渡さない場合、closeFinancialQuarterは
 * Phase 8A/8B-1と完全に同一の計算を行う（investingCashFlow=0、
 * constructionInProgress=0、fixedAssetsGrossは前期から不変）。既存テストは
 * 一切この引数を渡さないため、挙動・数値は一切変化しない。
 *
 * 【新規完成設備が即時に減価償却されない設計】nonDepreciatingCapexGrossAtPeriodStartUsd
 * は、prev.fixedAssetsGrossのうち「過去の四半期にcapex経由で完成振替された、
 * まだ減価償却を開始していない金額」を表す。closeFinancialQuarterはこの値を
 * prev.fixedAssetsGrossから除いた残り（レガシー資産分）だけに減価償却率を
 * 適用する（実装指示「新規完成設備の減価償却が未開始であること」。Phase 8B-2Bで
 * 新設備の減価償却開始・稼働開始を接続する前提の、意図的な暫定境界）。
 */
export interface CapexAdjustment {
  /** 当期の設備投資案件への現金支払額合計（CFIのマイナス）。 */
  readonly capexPaymentCashUsd: number;
  /** 当期に完成し固定資産（fixedAssetsGross）へ振替えた金額合計（当期のCIPからの振替）。 */
  readonly completedProjectsTransferUsd: number;
  /** capexポートフォリオから算出した期末建設中勘定残高（BS constructionInProgressを置き換える）。 */
  readonly endingConstructionInProgressUsd: number;
  /**
   * prev.fixedAssetsGrossのうち、capex経由で完成済みかつまだ減価償却対象と
   * なっていない金額（当期の減価償却率計算のベースから除外する）。
   */
  readonly nonDepreciatingCapexGrossAtPeriodStartUsd: number;
}
