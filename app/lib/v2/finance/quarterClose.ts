// ShrimpX V2 — 財務モジュール 四半期決算（Phase 8A）
//
// 前期の財務状態（CompanyFinanceState）と当期の事業実績（CompanyQuarterBusinessActuals、
// 会社ラボのアダプターが既存Phaseの実績データから抽出したもの）から、当期の
// 財務結果（PL/BS/CF/原価内訳/品質損失/コスト記録/管理会計）と次期の財務状態を
// 生成する純粋関数。販売量・生産量・廃棄量・価格の再計算は一切行わない。
//
// 【会計方針の要点（docs/v2/FINANCIAL_ARCHITECTURE_v0.1.md参照）】
//   - 売上: 契約締結時ではなく、当期の契約履行時に認識（履行数量×契約単価）。
//   - 在庫評価: ロット別実際原価法（既存の原料ロット・完成品ロットがロット単位の
//     取得原価・FIFO消費を持つため、その構造に一致するFIFO系の方法）。
//   - 廃棄: 対応する変動製造原価を在庫に残さず当期の品質損失として認識。
//     固定製造費は良品（販売可能）数量にのみ配賦する。
//   - 再加工: 数量を減らさず、追加加工費のみ当期原価へ計上。
//   - 格落ち: 数量を減らさず、販売時に契約単価×値引率の売上控除として認識。
//     ロット別の格落ち率（Phase 7AがFinishedGoodsLotQualityInfoへ保存済み）で按分。
//   - 契約単価は契約後の原料価格変動で変更しない（契約実績のunitPriceをそのまま使う）。
//   - 現金増減はCF（直接法）と完全に整合し、間接法照合も補助内訳として生成する。

import { PeriodV2, nextPeriod } from "../core/period";
import { Product, DemandMarketId } from "../market/types";
import { CompanyId } from "../sales/types";
import { FinanceParameters } from "./parameters";
import { amountFromPlainTonsAndUsdPerKg } from "./money";
import {
  AbsorptionVariableReconciliation,
  BalanceSheet,
  CapexAdjustment,
  CashFlowStatement,
  CompanyFinanceState,
  CompanyFinancialQuarterResult,
  ContributionMarginByDimension,
  ContributionMarginReport,
  CostOfSalesBreakdown,
  CostRecord,
  FinanceValidationError,
  FinancingAdjustment,
  FinishedGoodsCostLedgerEntry,
  FinishedGoodsUnitCostBreakdown,
  ManufacturingCostBreakdown,
  PayableRecord,
  ProfitAndLossStatement,
  QualityLossBreakdown,
  ReceivableRecord,
  Usd,
  fixedUnitCostPerTon,
  totalUnitCostPerTon,
  usd,
  variableUnitCostPerTon,
} from "./types";

const QUANTITY_EPSILON = 1e-9;
/**
 * 【feature/v2-idle-labor-cost】配属人数（headcount）の集計・比較に使う許容差。
 * 実配属人数は商品×バッチ別の小数（例: 612.282183人）を複数合計するため、
 * QUANTITY_EPSILON(1e-9)では浮動小数点の丸め誤差を僅かに超えて誤検知しうる。
 * 人数スケールの丸め誤差を安全に吸収しつつ、実質的な過剰配属は確実に検出できる値とする。
 */
const HEADCOUNT_EPSILON = 1e-6;

// ---------------------------------------------------------------------
// 1. 入力（会社ラボのアダプターが既存実績データから抽出する）
// ---------------------------------------------------------------------

/** 当期の1件の契約履行使用実績（fulfillmentPlan.usageの1行に対応）。 */
export interface FulfillmentUsageActual {
  readonly contractId: string;
  readonly lotId: string;
  readonly product: Product;
  readonly quantityTons: number;
}

/** 履行に使われた契約の条件（契約実績からの抽出。単価は成約時のまま変更しない）。 */
export interface ContractTermActual {
  readonly contractId: string;
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly unitPriceUsdPerKg: number;
}

/** 当期の1生産バッチぶんの実績（品質調整・原料消費原価込み）。 */
export interface ProductionBatchActual {
  readonly batchId: string;
  readonly factoryId: string;
  readonly product: Product;
  /** 品質調整前の完成品数量（トン）。 */
  readonly originalTons: number;
  /** 品質調整後（廃棄差引後）の完成品数量（トン）。 */
  readonly adjustedTons: number;
  readonly discardTons: number;
  readonly reworkTons: number;
  readonly downgradeTons: number;
  /** このバッチが実際に消費した原料の取得原価合計（USD。ロット別unitCost×消費量×1,000）。 */
  readonly rawMaterialCostUsd: number;
  /** 原料取得原価の調達源泉別内訳（合計はrawMaterialCostUsdと一致）。 */
  readonly rawMaterialCostBySourceUsd: { readonly domestic: number; readonly imported: number; readonly aquaculture: number };
  /** このバッチから生成された完成品ロットID（全量廃棄等でロットが生成されなかった場合はundefined）。 */
  readonly lotId?: string;
  /** ロットの格落ち率（Phase 7AのFinishedGoodsLotQualityInfo.downgradeRatio）。ロットがない場合は0。 */
  readonly downgradeRatio: number;
  /**
   * 【商品別実労務配分（feature/v2-labor-cost-allocation-bridge）】
   * このバッチ（会社×工場×商品）へ実際に配分された常用ワーカー人数
   * （production/allocation.tsのProductionAllocationEntry.labor.assignedRegularHeadcountに対応）。
   * 単位：人。assignedTemporaryHeadcount・appliedOvertimeRateと3項目セットで、
   * 指定するなら3つとも指定し、省略するなら3つとも省略する（一部のみの指定は
   * computeProductionCostingがFinanceValidationErrorとして拒否する）。
   * 3項目とも省略した場合は、後方互換のため従来の数量シェア按分にフォールバックする。
   */
  readonly assignedRegularHeadcount?: number;
  /** このバッチへ実際に配分された臨時ワーカー人数（単位：人）。上記3項目セットの一部。 */
  readonly assignedTemporaryHeadcount?: number;
  /** このバッチへの適用後残業率（単位：比率、0以上。上限クリップは生産層で適用済み）。上記3項目セットの一部。 */
  readonly appliedOvertimeRate?: number;
}

/** 1社・1四半期ぶんの事業実績（財務決算への入力）。 */
export interface CompanyQuarterBusinessActuals {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly fulfillmentUsage: readonly FulfillmentUsageActual[];
  readonly contractTerms: readonly ContractTermActual[];
  readonly batches: readonly ProductionBatchActual[];
  /** 当期の正社員配置人数（意思決定のworkerAssignments合計）。 */
  readonly regularHeadcount: number;
  /** 当期の臨時ワーカー配置人数。 */
  readonly temporaryHeadcount: number;
  /** 当期の適用残業率（残業上限でクリップ済み）。 */
  readonly appliedOvertimeRate: number;
  /** 稼働中の工場数。 */
  readonly activeFactoryCount: number;
  readonly salesForceHeadcount: number;
  readonly procurementHeadcount: number;
  /** 当期の国内原料購入額（当期の新規国内ロットのΣ数量×取得単価×1,000。当四半期に現金払い）。 */
  readonly domesticPurchasesUsd: number;
  /** 当期の輸入発注額（当期の新規輸入ロットのΣ数量×着地単価×1,000。買掛金計上→支払サイト後に決済）。 */
  readonly importOrdersUsd: number;
  /** 当期の養殖収穫認識額（当期の収穫ロットのΣ数量×単位原価×1,000。収穫時に現金払い・在庫計上）。 */
  readonly aquacultureHarvestUsd: number;
  /** 期首の原料在庫金額（前四半期末の実ロットから算出）。 */
  readonly rawMaterialInventoryBeginUsd: number;
  /** 期末の原料在庫金額（当四半期末の実ロットから算出）。 */
  readonly rawMaterialInventoryEndUsd: number;
  /**
   * 当期の完成品ロット別の実消費数量（消費適用前後の実ロット残数量の差分。
   * 生産モジュールのFIFO消費が実際にどのロットから引き当てたかの真実）。
   * COGSはこの実消費×台帳単位原価で認識する（fulfillmentPlan.usageの
   * ロット割付は計画時点のもので、期限切れ処理・集約消費により実消費と
   * ロット単位ではずれうるため、収益・市場帰属にのみ使う）。
   */
  readonly lotConsumption: readonly { readonly lotId: string; readonly quantityTons: number }[];
  /**
   * 当四半期末の当社の完成品ロット実残数量（lotId→残トン、期限切れフラグつき。
   * 台帳との照合・同期・期限切れ廃棄損の検出に使う）。
   */
  readonly finishedGoodsRemainingByLot: readonly {
    readonly lotId: string;
    readonly remainingQuantityTons: number;
    readonly expired: boolean;
  }[];
}

// ---------------------------------------------------------------------
// 2. 内部集計ヘルパー
// ---------------------------------------------------------------------

function assertFiniteNonNegative(n: number, label: string): number {
  if (!Number.isFinite(n)) throw new FinanceValidationError(`${label} が有限の数値ではありません: ${n}`);
  if (n < -QUANTITY_EPSILON) throw new FinanceValidationError(`${label} が負です: ${n}`);
  return Math.max(0, n);
}

/**
 * 【商品別実労務配分】assignedRegularHeadcount/assignedTemporaryHeadcount/appliedOvertimeRateの
 * 実データが使えるかどうかを判定する。3項目は必ずセットで指定されている必要があり
 * （バッチごとに3つとも存在するか、3つとも存在しないかのいずれか）、一部のみの指定は
 * 不完全な実績データとして拒否する。全バッチが3項目とも省略していれば、既存呼び出し元
 * との後方互換のため"legacy"（従来の数量シェア按分）を返す。
 */
export function resolveLaborAllocationMode(batches: readonly ProductionBatchActual[]): "actual" | "legacy" {
  let anyComplete = false;
  let anyMissing = false;
  for (const b of batches) {
    const present = [b.assignedRegularHeadcount, b.assignedTemporaryHeadcount, b.appliedOvertimeRate].filter((v) => v !== undefined).length;
    if (present === 3) {
      anyComplete = true;
      assertFiniteNonNegative(b.assignedRegularHeadcount as number, `バッチ ${b.batchId} の assignedRegularHeadcount`);
      assertFiniteNonNegative(b.assignedTemporaryHeadcount as number, `バッチ ${b.batchId} の assignedTemporaryHeadcount`);
      assertFiniteNonNegative(b.appliedOvertimeRate as number, `バッチ ${b.batchId} の appliedOvertimeRate`);
    } else if (present === 0) {
      anyMissing = true;
    } else {
      throw new FinanceValidationError(
        `バッチ ${b.batchId}: assignedRegularHeadcount/assignedTemporaryHeadcount/appliedOvertimeRateは3項目すべて指定するか、すべて省略する必要があります（実際の指定数: ${present}）。`
      );
    }
  }
  if (anyComplete && anyMissing) {
    throw new FinanceValidationError(
      "一部の生産バッチにのみ実労務配分データ（assignedRegularHeadcount等）が存在します。会社×四半期の全バッチで一貫している必要があります。"
    );
  }
  return anyComplete ? "actual" : "legacy";
}

interface ProductionCostingResult {
  readonly newLedgerEntries: readonly FinishedGoodsCostLedgerEntry[];
  /** 廃棄数量の変動製造原価相当（品質廃棄損）。 */
  readonly qualityDiscardLoss: number;
  /** 当期の再加工費。 */
  readonly reworkCost: number;
  /** 在庫へ配賦されなかった製造費（生産ゼロ時の固定費・変動労務等）。 */
  readonly unabsorbedManufacturingCost: number;
  /** うち固定費部分（利益差異調整の恒等式検証に使う）。 */
  readonly unabsorbedFixedPortion: number;
  /** 当期に完成品在庫へ配賦した固定製造費。 */
  readonly fixedAbsorbedIntoInventory: number;
  readonly manufacturing: ManufacturingCostBreakdown;
  readonly discardTonsTotal: number;
  readonly reworkTonsTotal: number;
  /** 商品別の当期発生変動品質費（再加工費＋品質廃棄損。商品別限界利益の帰属用）。 */
  readonly variableQualityCostByProduct: ReadonlyMap<Product, number>;
  /**
   * 【商品別実労務配分】当期のovertimeCost算定に実際に使われた「労務相当量」。
   * "actual"モード: Σ_b(assignedRegularHeadcount_b × appliedOvertimeRate_b)。
   * "legacy"モード: actuals.appliedOvertimeRate × actuals.regularHeadcount（従来どおり）。
   * overtimeCost = overtimeLaborEquivalent × regularWorkerSalaryUsdPerQuarter × overtimePremiumFactor
   * が両モードで厳密に成り立つ（管理会計コスト記録のdriverQuantity/driverUnitRateに使う）。
   */
  readonly overtimeLaborEquivalent: number;
}

/**
 * 当期の生産実績から、新規完成品ロットの単位原価（変動費・固定費分離）と
 * 当期の期間費用（再加工費・品質廃棄損・未配賦製造費）を算出する。
 *
 * 【配賦規則（文書化済み）】
 *   - 変動労務費・変動ユーティリティ費: バッチの品質調整前数量（originalTons）比で配賦
 *     （作業量は廃棄前の生産量に対応するため）。
 *   - 固定製造費（正社員労務・工場固定費・固定ユーティリティ・減価償却）:
 *     バッチの品質調整後数量（adjustedTons）比で配賦し、販売可能数量にのみ吸収させる。
 *     会社全体の調整後数量が0（実質生産ゼロ）の場合は全額を当期の期間費用として認識する
 *     （生産量が減っただけで固定費が消えない＝段階固定費の性質を保持）。
 *   - 廃棄損: バッチ別の変動製造原価単価 × 廃棄数量（固定費は含めない）。
 */
function computeProductionCosting(
  actuals: CompanyQuarterBusinessActuals,
  params: FinanceParameters,
  depreciationUsd: number,
  processingRateByProduct: Readonly<Record<Product, number>>
): ProductionCostingResult {
  const totalOriginalTons = actuals.batches.reduce((s, b) => s + b.originalTons, 0);
  const totalAdjustedTons = actuals.batches.reduce((s, b) => s + b.adjustedTons, 0);

  // --- 会社レベルの当期発生製造費 ---
  // 【商品別実労務配分（feature/v2-labor-cost-allocation-bridge, 2コミット目）】
  // assignedRegularHeadcount/assignedTemporaryHeadcount/appliedOvertimeRateが全バッチで
  // 揃っている場合（"actual"モード）、残業費総額はバッチ別の実配属人数×適用残業率を
  // 直接積み上げて算出する：
  //   overtimeWeight_b = assignedRegularHeadcount_b × appliedOvertimeRate_b
  //   overtimeLaborEquivalent = Σ_b overtimeWeight_b
  //   overtimeCost_total = overtimeLaborEquivalent × regularWorkerSalaryUsdPerQuarter × overtimePremiumFactor
  // 「会社全体の残業率（生産量加重平均）×全社regularHeadcount」という従来式は、
  // 生産量加重平均だった残業率を人員数ベースの総額へ掛け合わせる際に単位が不整合になり、
  // 商品別残業率が乖離するケース（overtimeRateOverride）で残業費総額を誤らせるため採用しない。
  // 未配属・遊休の常用人員には残業は発生しない、という前提をバッチ別の実配属人数を
  // 直接使うことで保証する（一方、正社員給与そのものは全常用人員（遊休含む）に対して
  // 発生するため、regularLaborCostは従来どおりactuals.regularHeadcount基準のまま変更しない）。
  // 3項目が全バッチで欠落している場合（"legacy"モード）は、後方互換のため従来の
  // 会社全体平均残業率×全社regularHeadcountの式をそのまま使う。
  const laborMode = resolveLaborAllocationMode(actuals.batches);

  // regularLaborCostは会社全体の正社員給与総額（会社全体regularHeadcount×1人当たり四半期給与）。
  // 未配属・遊休ぶんも含む会社全体の現金支出・コミットメント総額であり、CF（労務費現金支出）や
  // コスト記録（directLaborRegular、stepFixed、driverQuantity=actuals.regularHeadcount）は
  // 引き続きこの総額をそのまま使う（【feature/v2-idle-labor-cost】給与支出総額自体は変更しない）。
  const regularLaborCost = actuals.regularHeadcount * params.labor.regularWorkerSalaryUsdPerQuarter;
  const temporaryWorkerCost = actuals.temporaryHeadcount * params.labor.temporaryWorkerCostUsdPerQuarter;

  // 【feature/v2-idle-labor-cost】"actual"モードでは、regularLaborCostのうち実際に商品・生産
  // バッチへ配属された（productiveな）人数ぶんだけを商品原価へ吸収し、残り（未配属・遊休人員の
  // 給与）は商品原価・完成品在庫へは一切含めず、発生四半期の「遊休労務費」として即時費用化する。
  // "legacy"モードでは未配属人数を信頼できる形で算定できないため、後方互換として全額を
  // productiveとみなす（idleLaborCost=0、従来どおり全額を商品原価へ配賦）。
  const totalAssignedRegular =
    laborMode === "actual" ? actuals.batches.reduce((s, b) => s + (b.assignedRegularHeadcount as number), 0) : 0;
  if (laborMode === "actual" && totalAssignedRegular > actuals.regularHeadcount + HEADCOUNT_EPSILON) {
    throw new FinanceValidationError(
      `商品・生産バッチへの実配属正社員数合計(${totalAssignedRegular})が、会社全体の正社員数(${actuals.regularHeadcount})を上回っています。過剰配属です: ${actuals.companyId} ${actuals.period}`
    );
  }
  const productiveRegularHeadcount = laborMode === "actual" ? Math.min(totalAssignedRegular, actuals.regularHeadcount) : actuals.regularHeadcount;
  const productiveRegularLaborCost = productiveRegularHeadcount * params.labor.regularWorkerSalaryUsdPerQuarter;
  const idleRegularHeadcount = Math.max(0, actuals.regularHeadcount - productiveRegularHeadcount);
  const idleLaborCost = idleRegularHeadcount * params.labor.regularWorkerSalaryUsdPerQuarter;

  // バッチ別の残業労務相当量（overtimeWeight）。"legacy"モードでは使わないため0にしておく
  // （後段のallocOvertimeCost算出はlaborModeで明示的に分岐するので、ここが0でも legacy側の
  // 計算には影響しない）。
  const overtimeWeightByBatch = actuals.batches.map((b) =>
    laborMode === "actual" ? (b.assignedRegularHeadcount as number) * (b.appliedOvertimeRate as number) : 0
  );
  const actualModeOvertimeLaborEquivalent = overtimeWeightByBatch.reduce((s, w) => s + w, 0);
  // 管理会計コスト記録（driverQuantity等）向けに、実際にovertimeCostの算定へ使った
  // 労務相当量を両モードで統一的に持つ（overtimeCost = これ×単価×割増率 が常に成り立つ）。
  const overtimeLaborEquivalent =
    laborMode === "actual" ? actualModeOvertimeLaborEquivalent : actuals.appliedOvertimeRate * actuals.regularHeadcount;

  const overtimeCost = overtimeLaborEquivalent * params.labor.regularWorkerSalaryUsdPerQuarter * params.labor.overtimePremiumFactor;

  const factoryFixedCost = actuals.activeFactoryCount * params.manufacturing.factoryFixedCostUsdPerQuarter;
  const utilityFixedCost = actuals.activeFactoryCount * params.manufacturing.factoryUtilityFixedUsdPerQuarter;
  const utilityVariableCost = totalOriginalTons * params.manufacturing.factoryUtilityVariableUsdPerTon;

  const variableLaborTotal = temporaryWorkerCost + overtimeCost;
  // 固定製造費のうち、常用労務費（productiveRegularLaborCost。遊休分を除く）は実配属人数
  // ベースで、それ以外（工場固定費・固定ユーティリティ・減価償却＝nonLaborFixedManufacturingTotal）
  // は従来どおり数量調整後シェア（adjustedShare）で配賦する（固定製造費の按分基準を
  // 労務部分とそれ以外で明示的に分離する）。遊休労務費(idleLaborCost)はここに含めず、
  // 常に当期の期間費用（CostOfSalesBreakdown.idleLaborCost）として別建てで認識する。
  const nonLaborFixedManufacturingTotal = factoryFixedCost + utilityFixedCost + depreciationUsd;
  const fixedManufacturingTotal = productiveRegularLaborCost + nonLaborFixedManufacturingTotal;

  // --- 加工費（商品別・変動費）。基準（HOSO水準）＋PD/VAP追加分に分解して記録する ---
  const hosoRate = processingRateByProduct.hoso;
  let hosoProcessingCost = 0;
  let pdAdditionalProcessingCost = 0;
  let vapAdditionalProcessingCost = 0;
  for (const b of actuals.batches) {
    const rate = processingRateByProduct[b.product];
    hosoProcessingCost += b.originalTons * hosoRate;
    if (b.product === "pd") pdAdditionalProcessingCost += b.originalTons * (rate - hosoRate);
    if (b.product === "vap") vapAdditionalProcessingCost += b.originalTons * (rate - hosoRate);
  }

  const reworkTonsTotal = actuals.batches.reduce((s, b) => s + b.reworkTons, 0);
  const reworkCost = reworkTonsTotal * params.manufacturing.reworkCostUsdPerTon;
  const discardTonsTotal = actuals.batches.reduce((s, b) => s + b.discardTons, 0);

  let rawDomestic = 0;
  let rawImported = 0;
  let rawAquaculture = 0;
  for (const b of actuals.batches) {
    rawDomestic += b.rawMaterialCostBySourceUsd.domestic;
    rawImported += b.rawMaterialCostBySourceUsd.imported;
    rawAquaculture += b.rawMaterialCostBySourceUsd.aquaculture;
  }

  // --- バッチ別の変動製造原価 → 廃棄損・ロット単位原価 ---
  const newLedgerEntries: FinishedGoodsCostLedgerEntry[] = [];
  let qualityDiscardLoss = 0;
  let unabsorbedVariable = 0;
  let fixedAbsorbedIntoInventory = 0;
  const variableQualityCostByProduct = new Map<Product, number>();
  const addQualityCost = (product: Product, amount: number) => {
    variableQualityCostByProduct.set(product, (variableQualityCostByProduct.get(product) ?? 0) + amount);
  };
  for (const b of actuals.batches) {
    addQualityCost(b.product, b.reworkTons * params.manufacturing.reworkCostUsdPerTon);
  }

  if (totalOriginalTons <= QUANTITY_EPSILON) {
    // 実質生産ゼロ: 変動労務・変動ユーティリティも配賦先がないため期間費用とする。
    unabsorbedVariable = variableLaborTotal + utilityVariableCost;
  }

  // --- バッチ別の配賦シェア ---
  // 常用労務費（固定費のうち労務部分）は、"actual"モードでは下のループ内で
  // assignedRegularHeadcount_b×単価を直接計算する（totalAssignedRegularは上で計算済み）。
  // 臨時ワーカー費（変動費の一部）: 実配属人数の比、フォールバックは品質調整前数量シェア(originalShare)。
  const totalAssignedTemporary =
    laborMode === "actual" ? actuals.batches.reduce((s, b) => s + (b.assignedTemporaryHeadcount as number), 0) : 0;

  for (let batchIndex = 0; batchIndex < actuals.batches.length; batchIndex++) {
    const b = actuals.batches[batchIndex];
    const originalShare = totalOriginalTons > QUANTITY_EPSILON ? b.originalTons / totalOriginalTons : 0;
    const adjustedShare = totalAdjustedTons > QUANTITY_EPSILON ? b.adjustedTons / totalAdjustedTons : 0;

    const temporaryWorkerShare =
      laborMode === "actual" && totalAssignedTemporary > QUANTITY_EPSILON
        ? (b.assignedTemporaryHeadcount as number) / totalAssignedTemporary
        : originalShare;
    const allocTemporaryWorkerCost = temporaryWorkerCost * temporaryWorkerShare;
    // 残業費はバッチ別overtimeWeightから直接計算する（総額をΣ overtimeWeightで割ってから
    // 掛け直すのではなく、各バッチのoverwtimeWeight_b×単価×割増率を直接積み上げることで、
    // Σ allocOvertimeCost_b = overtimeCost_total（会社全体の残業費総額）を計算誤差なく保証する）。
    const allocOvertimeCost =
      laborMode === "actual"
        ? overtimeWeightByBatch[batchIndex] * params.labor.regularWorkerSalaryUsdPerQuarter * params.labor.overtimePremiumFactor
        : overtimeCost * originalShare;
    const allocVariableLabor = allocTemporaryWorkerCost + allocOvertimeCost;
    const allocVariableUtility = utilityVariableCost * originalShare;
    const processingCost = b.originalTons * processingRateByProduct[b.product];
    const batchVariableTotal = b.rawMaterialCostUsd + processingCost + allocVariableLabor + allocVariableUtility;

    const variableUnitPerTon = b.originalTons > QUANTITY_EPSILON ? batchVariableTotal / b.originalTons : 0;
    const batchDiscardLoss = b.discardTons * variableUnitPerTon;
    qualityDiscardLoss += batchDiscardLoss;
    addQualityCost(b.product, batchDiscardLoss);

    // 在庫化される変動費 = batchVariableTotal − batchDiscardLoss（廃棄分を除いた残り）。
    // 下のunitCostは各構成要素へ良品率(goodRatio)を掛けることで、この合計を
    // adjustedTonsあたりへ厳密に展開している。
    // 【feature/v2-idle-labor-cost】"actual"モードでは、このバッチへ実際に配属された正社員
    // 人数×単価を直接計算する（productiveRegularLaborCostをシェアで割ってから掛け直すのでは
    // なく直接積み上げることで、Σ allocRegularLaborCost_b = productiveRegularLaborCost が
    // 計算誤差なく保証される。未配属人員の給与はここに一切含まれない＝idleLaborCostへ分離済み）。
    // "legacy"モードではproductiveRegularLaborCost(===regularLaborCost)を数量調整後シェアで
    // 配賦する従来どおりの計算（この場合、遊休の概念自体が無いため変更なし）。
    const allocRegularLaborCost =
      laborMode === "actual"
        ? (b.assignedRegularHeadcount as number) * params.labor.regularWorkerSalaryUsdPerQuarter
        : productiveRegularLaborCost * adjustedShare;
    const allocNonLaborFixed = nonLaborFixedManufacturingTotal * adjustedShare;
    const allocFixed = allocRegularLaborCost + allocNonLaborFixed;

    if (b.adjustedTons > QUANTITY_EPSILON && b.lotId !== undefined) {
      const perTon = (v: number) => v / b.adjustedTons;
      // 変動費の内訳をトンあたりへ展開（合計 = inventoriableVariable / adjustedTons）。
      const goodRatio = b.originalTons > QUANTITY_EPSILON ? b.adjustedTons / b.originalTons : 1;
      const unitCost: FinishedGoodsUnitCostBreakdown = {
        rawMaterialPerTon: perTon(b.rawMaterialCostUsd * goodRatio),
        processingPerTon: perTon(processingCost * goodRatio),
        laborVariablePerTon: perTon(allocVariableLabor * goodRatio),
        utilityVariablePerTon: perTon(allocVariableUtility * goodRatio),
        laborFixedPerTon: perTon(allocRegularLaborCost),
        factoryFixedPerTon: perTon(allocNonLaborFixed * (nonLaborFixedManufacturingTotal > 0 ? factoryFixedCost / nonLaborFixedManufacturingTotal : 0)),
        utilityFixedPerTon: perTon(allocNonLaborFixed * (nonLaborFixedManufacturingTotal > 0 ? utilityFixedCost / nonLaborFixedManufacturingTotal : 0)),
        depreciationPerTon: perTon(allocNonLaborFixed * (nonLaborFixedManufacturingTotal > 0 ? depreciationUsd / nonLaborFixedManufacturingTotal : 0)),
      };
      fixedAbsorbedIntoInventory += allocFixed;
      newLedgerEntries.push({
        lotId: b.lotId,
        companyId: actuals.companyId,
        product: b.product,
        remainingQuantity: b.adjustedTons,
        unitCost,
        downgradeRatio: b.downgradeRatio,
        producedPeriod: actuals.period,
      });
    } else if (b.adjustedTons > QUANTITY_EPSILON && b.lotId === undefined) {
      throw new FinanceValidationError(
        `品質調整後数量が正(${b.adjustedTons})なのに完成品ロットIDがないバッチです（原価の在庫振替先がありません）: ${b.batchId}`
      );
    } else {
      // 全量廃棄バッチ（adjustedTons≈0）: 変動費は上のbatchDiscardLossで全額認識済み
      // （variableUnit×discardTons = batchVariableTotal になる）。固定費は
      // adjustedShare=0のため配賦されず、他バッチへ配賦されるか未配賦扱いになる。
    }
  }

  const unabsorbedFixedPortion = totalAdjustedTons <= QUANTITY_EPSILON ? fixedManufacturingTotal : 0;
  const unabsorbedManufacturingCost = unabsorbedFixedPortion + unabsorbedVariable;

  const manufacturing: ManufacturingCostBreakdown = {
    domesticRawMaterialCost: usd(rawDomestic),
    importedRawMaterialCost: usd(rawImported),
    aquacultureRawMaterialCost: usd(rawAquaculture),
    regularLaborCost: usd(regularLaborCost),
    productiveRegularLaborCost: usd(productiveRegularLaborCost),
    idleLaborCost: usd(idleLaborCost),
    temporaryWorkerCost: usd(temporaryWorkerCost),
    overtimeCost: usd(overtimeCost),
    hosoProcessingCost: usd(hosoProcessingCost),
    pdAdditionalProcessingCost: usd(pdAdditionalProcessingCost),
    vapAdditionalProcessingCost: usd(vapAdditionalProcessingCost),
    factoryFixedCost: usd(factoryFixedCost),
    utilityFixedCost: usd(utilityFixedCost),
    utilityVariableCost: usd(utilityVariableCost),
    depreciationCost: usd(depreciationUsd),
    reworkCost: usd(reworkCost),
  };

  return {
    newLedgerEntries,
    qualityDiscardLoss,
    reworkCost,
    unabsorbedManufacturingCost,
    unabsorbedFixedPortion,
    fixedAbsorbedIntoInventory,
    manufacturing,
    discardTonsTotal,
    reworkTonsTotal,
    variableQualityCostByProduct,
    overtimeLaborEquivalent,
  };
}

// ---------------------------------------------------------------------
// 3. 四半期決算本体
// ---------------------------------------------------------------------

export interface QuarterCloseOutput {
  readonly result: CompanyFinancialQuarterResult;
  readonly nextState: CompanyFinanceState;
}

/**
 * 1社・1四半期ぶんの財務決算を実行する純粋関数。
 * processingRateByProductはproduction/parameters.tsのbaseProcessingCostUsdPerTonを
 * そのまま渡す（加工費単価の情報源を重複定義しないため、引数で注入する）。
 *
 * financing（Phase 8B-1、任意）: financing/liquidityClose.tsが算出した当期の
 * 借入・返済・利息の反映内容。省略時はPhase 8Aと完全に同一の計算になる
 * （後方互換。types.tsのFinancingAdjustmentコメント参照）。
 *
 * capex（Phase 8B-2A、任意）: capex/capexClose.tsが算出した当期の設備投資
 * 案件の支払・完成振替の反映内容。省略時はPhase 8A/8B-1と完全に同一の計算に
 * なる（後方互換。types.tsのCapexAdjustmentコメント参照）。
 */
export function closeFinancialQuarter(
  prev: CompanyFinanceState,
  actuals: CompanyQuarterBusinessActuals,
  params: FinanceParameters,
  processingRateByProduct: Readonly<Record<Product, number>>,
  financing?: FinancingAdjustment,
  capex?: CapexAdjustment
): QuarterCloseOutput {
  if (prev.companyId !== actuals.companyId) {
    throw new FinanceValidationError(`財務状態と実績データの会社IDが一致しません: ${prev.companyId} vs ${actuals.companyId}`);
  }
  const period = actuals.period;
  const companyId = actuals.companyId;

  // --- 減価償却（定額法・純額フロア） ---
  // 【Phase 8B-2A】capex指定時は、prev.fixedAssetsGrossのうち過去にcapex経由で
  // 完成振替された未減価償却分（nonDepreciatingCapexGrossAtPeriodStartUsd）を
  // 減価償却率の適用対象（レガシー資産分）から除外する（新規完成設備の減価償却が
  // 未開始であることの構造的な保証。types.tsのCapexAdjustmentコメント参照）。
  const legacyDepreciableGrossUsd = capex
    ? Math.max(0, (prev.fixedAssetsGross as number) - capex.nonDepreciatingCapexGrossAtPeriodStartUsd)
    : (prev.fixedAssetsGross as number);
  const fixedAssetsNetBefore = (prev.fixedAssetsGross as number) - (prev.accumulatedDepreciation as number);
  const legacyDepreciationUsd = Math.min(
    legacyDepreciableGrossUsd * params.finance.depreciationRatePerQuarter,
    Math.max(0, fixedAssetsNetBefore)
  );
  // 【Phase 8B-2B】新規completed資産の定額法減価償却費（capex/capacityEffect.tsの
  // computeCapexAssetsDepreciationUsdが算出済み。案件別にcapitalizedAmountUsd÷
  // usefulLifeQuartersを稼働開始四半期から耐用年数分だけ計上する構造のため、
  // 単独でも取得原価を超えない）。既存レガシー資産の定率法計算式（上記）は
  // 一切変更せず、その計算結果へ単純加算するだけで両者を混在させない。
  const capexAssetsDepreciationUsd = capex ? capex.capexAssetsDepreciationUsd : 0;
  const depreciationUsd = legacyDepreciationUsd + capexAssetsDepreciationUsd;

  // --- 生産原価計算 ---
  const costing = computeProductionCosting(actuals, params, depreciationUsd, processingRateByProduct);

  // --- 台帳の準備（前期繰越＋当期新規ロット） ---
  const contractById = new Map(actuals.contractTerms.map((c) => [c.contractId, c]));
  const ledgerById = new Map<string, { entry: FinishedGoodsCostLedgerEntry; remaining: number }>();
  for (const e of prev.finishedGoodsCostLedger) ledgerById.set(e.lotId, { entry: e, remaining: e.remainingQuantity });
  for (const e of costing.newLedgerEntries) ledgerById.set(e.lotId, { entry: e, remaining: e.remainingQuantity });

  // --- 収益認識・格落ち売上控除（fulfillmentPlan.usage＝契約単位の履行実績から） ---
  let grossRevenue = 0;
  let qualitySalesDeduction = 0;
  let downgradeQuantitySoldTons = 0;
  let soldTonsTotal = 0;

  interface DimensionAgg {
    grossRevenue: number;
    deduction: number;
    variableCost: number;
    soldTons: number;
  }
  const byProductAgg = new Map<Product, DimensionAgg>();
  const byMarketAgg = new Map<DemandMarketId, DimensionAgg>();
  /** 市場×商品の履行数量（市場別変動費の按分に使う）。 */
  const marketProductTons = new Map<DemandMarketId, Map<Product, number>>();
  const dim = <K>(m: Map<K, DimensionAgg>, k: K): DimensionAgg => {
    let v = m.get(k);
    if (!v) {
      v = { grossRevenue: 0, deduction: 0, variableCost: 0, soldTons: 0 };
      m.set(k, v);
    }
    return v;
  };

  const arByMarket = new Map<DemandMarketId, number>();

  for (const u of actuals.fulfillmentUsage) {
    const contract = contractById.get(u.contractId);
    if (!contract) {
      throw new FinanceValidationError(`履行実績の契約条件が見つかりません: ${u.contractId}`);
    }
    const lot = ledgerById.get(u.lotId);
    if (!lot) {
      throw new FinanceValidationError(`履行実績の完成品原価台帳エントリが見つかりません: ${u.lotId}`);
    }

    const revenue = amountFromPlainTonsAndUsdPerKg(u.quantityTons, contract.unitPriceUsdPerKg) as number;
    // 格落ち品がどの契約履行へ使われたかは一意に追跡できないため、計画時点の
    // ロット割付（usage）×そのロットの格落ち率で按分する（文書化済みの按分方法）。
    const downgradeSold = u.quantityTons * lot.entry.downgradeRatio;
    const deduction =
      (amountFromPlainTonsAndUsdPerKg(downgradeSold, contract.unitPriceUsdPerKg) as number) * params.quality.downgradePriceDiscountRatio;

    grossRevenue += revenue;
    qualitySalesDeduction += deduction;
    downgradeQuantitySoldTons += downgradeSold;
    soldTonsTotal += u.quantityTons;

    const p = dim(byProductAgg, u.product);
    p.grossRevenue += revenue;
    p.deduction += deduction;
    p.soldTons += u.quantityTons;
    const mk = dim(byMarketAgg, contract.market);
    mk.grossRevenue += revenue;
    mk.deduction += deduction;
    mk.soldTons += u.quantityTons;
    let mp = marketProductTons.get(contract.market);
    if (!mp) {
      mp = new Map();
      marketProductTons.set(contract.market, mp);
    }
    mp.set(u.product, (mp.get(u.product) ?? 0) + u.quantityTons);

    arByMarket.set(contract.market, (arByMarket.get(contract.market) ?? 0) + revenue - deduction);
  }

  // --- COGS（実ロット消費差分＝生産モジュールのFIFO消費の真実から） ---
  let cogsRawMaterial = 0;
  let cogsProcessing = 0;
  let cogsLaborVariable = 0;
  let cogsLaborFixed = 0;
  let cogsFactoryFixedGroup = 0; // 工場固定費＋固定ユーティリティ＋減価償却の配賦
  let fixedReleasedThroughSales = 0;
  /** 商品別の実消費変動製造原価と実消費数量（商品別限界利益・市場別按分の基礎）。 */
  const actualVariableCostByProduct = new Map<Product, number>();
  const actualConsumedTonsByProduct = new Map<Product, number>();

  for (const c of actuals.lotConsumption) {
    if (c.quantityTons <= QUANTITY_EPSILON) continue;
    const lot = ledgerById.get(c.lotId);
    if (!lot) {
      throw new FinanceValidationError(`実消費された完成品ロットの原価台帳エントリが見つかりません: ${c.lotId}`);
    }
    if (lot.remaining < c.quantityTons - 1e-6) {
      throw new FinanceValidationError(`完成品原価台帳の残数量(${lot.remaining})を超える実消費(${c.quantityTons})です: ${c.lotId}`);
    }
    lot.remaining = Math.max(0, lot.remaining - c.quantityTons);

    const uc = lot.entry.unitCost;
    cogsRawMaterial += c.quantityTons * uc.rawMaterialPerTon;
    cogsProcessing += c.quantityTons * (uc.processingPerTon + uc.utilityVariablePerTon);
    cogsLaborVariable += c.quantityTons * uc.laborVariablePerTon;
    cogsLaborFixed += c.quantityTons * uc.laborFixedPerTon;
    cogsFactoryFixedGroup += c.quantityTons * (uc.factoryFixedPerTon + uc.utilityFixedPerTon + uc.depreciationPerTon);
    fixedReleasedThroughSales += c.quantityTons * fixedUnitCostPerTon(uc);

    const product = lot.entry.product;
    actualVariableCostByProduct.set(product, (actualVariableCostByProduct.get(product) ?? 0) + c.quantityTons * variableUnitCostPerTon(uc));
    actualConsumedTonsByProduct.set(product, (actualConsumedTonsByProduct.get(product) ?? 0) + c.quantityTons);
  }

  // 商品別・市場別の変動費: 商品別は実消費原価で厳密に帰属し、市場別は
  // 「商品別の実消費平均変動単価 × 市場×商品の履行数量」で按分する
  // （実消費のロット→市場対応は存在しないため。按分方法は文書化済み）。
  for (const [product, agg] of byProductAgg) {
    const mfgVariable = actualVariableCostByProduct.get(product) ?? 0;
    agg.variableCost += mfgVariable + agg.soldTons * params.sellingGeneralAdmin.sellingLogisticsUsdPerTon;
  }
  for (const [market, mp] of marketProductTons) {
    const agg = byMarketAgg.get(market);
    if (!agg) continue;
    for (const [product, tons] of mp) {
      const consumedTons = actualConsumedTonsByProduct.get(product) ?? 0;
      const avgVariablePerTon = consumedTons > QUANTITY_EPSILON ? (actualVariableCostByProduct.get(product) ?? 0) / consumedTons : 0;
      agg.variableCost += tons * avgVariablePerTon;
    }
    agg.variableCost += agg.soldTons * params.sellingGeneralAdmin.sellingLogisticsUsdPerTon;
  }

  // --- 台帳と実ロット残数量の照合・同期（期限切れ等の在庫廃棄損を検出） ---
  const actualRemainingByLot = new Map(actuals.finishedGoodsRemainingByLot.map((l) => [l.lotId, l.expired ? 0 : l.remainingQuantityTons]));
  let finishedGoodsWriteOffLoss = 0;
  let finishedGoodsWriteOffVariable = 0;
  let fixedReleasedThroughWriteOff = 0;
  const nextLedger: FinishedGoodsCostLedgerEntry[] = [];
  for (const { entry, remaining } of ledgerById.values()) {
    const actualRemaining = actualRemainingByLot.get(entry.lotId) ?? 0;
    if (actualRemaining > remaining + 1e-4) {
      throw new FinanceValidationError(
        `完成品原価台帳(${remaining})より実ロット残(${actualRemaining})が大きく、原価を説明できません: ${entry.lotId}`
      );
    }
    const writeOffTons = Math.max(0, remaining - actualRemaining);
    if (writeOffTons > QUANTITY_EPSILON) {
      finishedGoodsWriteOffLoss += writeOffTons * totalUnitCostPerTon(entry.unitCost);
      finishedGoodsWriteOffVariable += writeOffTons * variableUnitCostPerTon(entry.unitCost);
      fixedReleasedThroughWriteOff += writeOffTons * fixedUnitCostPerTon(entry.unitCost);
    }
    if (actualRemaining > QUANTITY_EPSILON) {
      nextLedger.push({ ...entry, remainingQuantity: actualRemaining });
    }
  }

  // --- 原料在庫フロー（実ロット準拠）と期限切れ廃棄損 ---
  const rawPurchasesTotal = actuals.domesticPurchasesUsd + actuals.importOrdersUsd + actuals.aquacultureHarvestUsd;
  const rawConsumedTotal =
    (costing.manufacturing.domesticRawMaterialCost as number) +
    (costing.manufacturing.importedRawMaterialCost as number) +
    (costing.manufacturing.aquacultureRawMaterialCost as number);
  const rawFlowResidual = actuals.rawMaterialInventoryBeginUsd + rawPurchasesTotal - rawConsumedTotal - actuals.rawMaterialInventoryEndUsd;
  if (rawFlowResidual < -1) {
    throw new FinanceValidationError(
      `原料在庫フローが負の残差です（期首${actuals.rawMaterialInventoryBeginUsd} + 仕入${rawPurchasesTotal} - 消費${rawConsumedTotal} - 期末${actuals.rawMaterialInventoryEndUsd} = ${rawFlowResidual}）。在庫評価の整合が崩れています: ${companyId} ${period}`
    );
  }
  /** 期首+仕入−消費−期末の残差＝ロット期限切れ等による原料の在庫廃棄損（実ロット準拠の残差法）。 */
  const rawMaterialExpiryLoss = Math.max(0, rawFlowResidual);

  // --- 労務・SG&A・利息・税 ---
  const laborCashTotal =
    (costing.manufacturing.regularLaborCost as number) +
    (costing.manufacturing.temporaryWorkerCost as number) +
    (costing.manufacturing.overtimeCost as number);
  const processingCashTotal =
    (costing.manufacturing.hosoProcessingCost as number) +
    (costing.manufacturing.pdAdditionalProcessingCost as number) +
    (costing.manufacturing.vapAdditionalProcessingCost as number) +
    (costing.manufacturing.reworkCost as number);
  const utilityCashTotal = (costing.manufacturing.utilityFixedCost as number) + (costing.manufacturing.utilityVariableCost as number);
  const factoryFixedCashTotal = costing.manufacturing.factoryFixedCost as number;
  // 【Phase 8B-2B】稼働中capex資産の固定保守費（発生と同時に全額現金支出。
  // capex未指定時は常に0）。完成品原価・在庫を経由しないため、
  // computeProductionCosting/costing.manufacturing側には存在しない独立の
  // 現金支出項目として直接ここへ加算する。
  const capexMaintenanceCostUsd = capex ? capex.capexMaintenanceCostUsd : 0;

  const salesForceCost = actuals.salesForceHeadcount * params.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter;
  const procurementCost = actuals.procurementHeadcount * params.sellingGeneralAdmin.procurementSalaryUsdPerQuarter;
  const adminFixed = params.sellingGeneralAdmin.adminFixedUsdPerQuarter;
  const sellingLogistics = soldTonsTotal * params.sellingGeneralAdmin.sellingLogisticsUsdPerTon;
  const sgaTotal = salesForceCost + procurementCost + adminFixed + sellingLogistics;

  // 【Phase 8B-1】financingが指定されれば融資ポートフォリオ由来の実発生利息を使う。
  // 省略時はPhase 8Aの簡易計算（既存借入残高×固定利率）のまま（後方互換）。
  const interestExpense = financing
    ? financing.interestExpenseUsd
    : (prev.shortTermLoans as number) * params.finance.shortTermInterestRatePerQuarter +
      (prev.longTermLoans as number) * params.finance.longTermInterestRatePerQuarter;
  // 当期に現金で実際に支払った利息（資金制約で未払が生じる場合はinterestExpense未満）。
  // financing省略時は常に全額現金払い（Phase 8Aと同一）。
  const interestPaidCash = financing ? financing.interestPaidCashUsd : interestExpense;
  const accruedInterestPayableBegin = financing ? financing.beginningAccruedInterestPayableUsd : 0;
  const accruedInterestPayableEnd = accruedInterestPayableBegin + interestExpense - interestPaidCash;

  // --- PL ---
  const netRevenue = grossRevenue - qualitySalesDeduction;
  const discardLossTotal = costing.qualityDiscardLoss + rawMaterialExpiryLoss + finishedGoodsWriteOffLoss;
  // 【feature/v2-idle-labor-cost】未配属・遊休正社員給与は、販売数量や在庫の有無に関わらず
  // 発生四半期に全額を売上原価区分の独立項目として費用化する（製品原価・完成品在庫には
  // 一切含めない。costing.manufacturing.idleLaborCostは既にlaborFixedPerTon等の商品別単位
  // 原価には含まれていない、完全に別建ての金額）。
  const idleLaborCost = costing.manufacturing.idleLaborCost as number;
  // 【Phase 8B-2B】稼働中capex資産の固定保守費。idleLaborCostと同様、販売数量・
  // 在庫の有無に関わらず発生四半期に全額を売上原価区分の独立項目として費用化
  // する（完成品原価・単位原価台帳・完成品在庫には一切含めない）。
  const costOfSales: CostOfSalesBreakdown = {
    rawMaterialCost: usd(cogsRawMaterial),
    processingCost: usd(cogsProcessing),
    laborCost: usd(cogsLaborVariable + cogsLaborFixed),
    factoryFixedCost: usd(cogsFactoryFixedGroup),
    reworkCost: usd(costing.reworkCost),
    discardLoss: usd(discardLossTotal),
    unabsorbedFixedManufacturingCost: usd(costing.unabsorbedManufacturingCost),
    idleLaborCost: usd(idleLaborCost),
    capexMaintenanceCost: usd(capexMaintenanceCostUsd),
  };
  const totalCostOfSales =
    cogsRawMaterial +
    cogsProcessing +
    cogsLaborVariable +
    cogsLaborFixed +
    cogsFactoryFixedGroup +
    costing.reworkCost +
    discardLossTotal +
    costing.unabsorbedManufacturingCost +
    idleLaborCost +
    capexMaintenanceCostUsd;
  const grossProfit = netRevenue - totalCostOfSales;
  const operatingProfit = grossProfit - sgaTotal;
  const profitBeforeTax = operatingProfit - interestExpense;
  const incomeTax = Math.max(0, profitBeforeTax) * params.finance.incomeTaxRate;
  const netIncome = profitBeforeTax - incomeTax;

  const profitAndLoss: ProfitAndLossStatement = {
    companyId,
    period,
    grossRevenue: usd(grossRevenue),
    qualitySalesDeduction: usd(qualitySalesDeduction),
    netRevenue: usd(netRevenue),
    costOfSales,
    totalCostOfSales: usd(totalCostOfSales),
    grossProfit: usd(grossProfit),
    sellingGeneralAdmin: usd(sgaTotal),
    operatingProfit: usd(operatingProfit),
    interestExpense: usd(interestExpense),
    profitBeforeTax: usd(profitBeforeTax),
    incomeTax: usd(incomeTax),
    netIncome: usd(netIncome),
  };

  // --- 売掛金・買掛金の決済と新規発生 ---
  const collectedReceivables = prev.receivables.filter((r) => r.dueSettlementPeriod <= period);
  const remainingReceivables = prev.receivables.filter((r) => r.dueSettlementPeriod > period);
  const receiptsFromCustomers = collectedReceivables.reduce((s, r) => s + (r.amount as number), 0);

  const settledPayables = prev.payables.filter((p) => p.dueSettlementPeriod <= period);
  const remainingPayables = prev.payables.filter((p) => p.dueSettlementPeriod > period);
  const apSettlementsPaid = settledPayables.reduce((s, p) => s + (p.amount as number), 0);

  let arDuePeriod = period;
  for (let i = 0; i < params.workingCapital.arCollectionQuarters; i++) arDuePeriod = nextPeriod(arDuePeriod);
  const newReceivables: ReceivableRecord[] = [...arByMarket.entries()]
    .filter(([, amount]) => amount > QUANTITY_EPSILON)
    .map(([market, amount]) => ({
      id: `${companyId}-AR-${period}-${market}`,
      companyId,
      market,
      amount: usd(assertFiniteNonNegative(amount, `売掛金 ${companyId} ${market}`)),
      originPeriod: period,
      dueSettlementPeriod: arDuePeriod,
      sourceRef: `fulfillment:${period}:${market}`,
    }));

  let apImportDuePeriod = period;
  for (let i = 0; i < params.workingCapital.apImportPaymentQuarters; i++) apImportDuePeriod = nextPeriod(apImportDuePeriod);
  const newPayables: PayableRecord[] =
    actuals.importOrdersUsd > QUANTITY_EPSILON
      ? [
          {
            id: `${companyId}-AP-${period}-import`,
            companyId,
            source: "importRawMaterial",
            amount: usd(assertFiniteNonNegative(actuals.importOrdersUsd, `買掛金（輸入） ${companyId}`)),
            originPeriod: period,
            dueSettlementPeriod: apImportDuePeriod,
            sourceRef: `importOrders:${period}`,
          },
        ]
      : [];

  // --- 現金（直接法CFと完全一致する現金台帳） ---
  const paymentsForRawMaterials = actuals.domesticPurchasesUsd + actuals.aquacultureHarvestUsd + apSettlementsPaid;
  // 【Phase 8B-2B】稼働中capex資産の固定保守費は、発生と同時に全額現金支出される
  // 独立の製造関連キャッシュアウトとして加算する（営業CF区分。実装指示§5
  // 「営業CF...へ接続」）。
  const paymentsForManufacturing = laborCashTotal + processingCashTotal + utilityCashTotal + factoryFixedCashTotal + capexMaintenanceCostUsd;
  // 利息は発生額(interestExpense)ではなく実際の現金支払額(interestPaidCash)を減算する
  // （financing省略時はinterestPaidCash===interestExpenseのためPhase 8Aと同一）。
  const operatingCashFlow =
    receiptsFromCustomers - paymentsForRawMaterials - paymentsForManufacturing - sgaTotal - interestPaidCash - incomeTax;
  // 【Phase 8B-2A】capex指定時は当期の設備投資現金支払額のマイナス。省略時は0（Phase 8A/8B-1同一）。
  // capexPaymentCashUsd=0のとき"-0"（負のゼロ）にならないよう正規化する（-0===0だが、
  // deepEqual等の厳密比較・CLI表示で"-0"となる紛らしさを避けるための数値衛生上の措置。
  // 会計上の意味は一切変えない）。
  const investingCashFlowRaw = capex ? -capex.capexPaymentCashUsd : 0;
  const investingCashFlow = investingCashFlowRaw === 0 ? 0 : investingCashFlowRaw;
  // 【Phase 8B-1】financing指定時は借入実行(+)・元本返済(-)の純額。省略時は0（Phase 8A同一）。
  const financingCashFlow = financing ? financing.loanDrawUsd - financing.principalRepaymentCashUsd : 0;
  const netCashChange = operatingCashFlow + investingCashFlow + financingCashFlow;
  const openingCash = prev.cash as number;
  const closingCash = openingCash + netCashChange;

  // --- BS ---
  const arEnd = remainingReceivables.reduce((s, r) => s + (r.amount as number), 0) + newReceivables.reduce((s, r) => s + (r.amount as number), 0);
  const apEnd = remainingPayables.reduce((s, p) => s + (p.amount as number), 0) + newPayables.reduce((s, p) => s + (p.amount as number), 0);
  const finishedGoodsInventoryEnd = nextLedger.reduce((s, e) => s + e.remainingQuantity * totalUnitCostPerTon(e.unitCost), 0);
  const accumulatedDepreciationEnd = (prev.accumulatedDepreciation as number) + depreciationUsd;
  // 【Phase 8B-2A】capex指定時は当期完成振替分をfixedAssetsGrossへ加算する。省略時はprevから不変（Phase 8A/8B-1同一）。
  const fixedAssetsGrossEnd = (prev.fixedAssetsGross as number) + (capex ? capex.completedProjectsTransferUsd : 0);
  const fixedAssetsNet = fixedAssetsGrossEnd - accumulatedDepreciationEnd;
  const constructionInProgressEnd = capex ? capex.endingConstructionInProgressUsd : 0;
  const retainedEarningsEnd = (prev.retainedEarnings as number) + netIncome;

  // 【Phase 8B-1】financing指定時は融資ポートフォリオ由来の期末残高を使う。省略時はprevから不変（Phase 8A同一）。
  const endingShortTermLoans = financing ? financing.endingShortTermLoansUsd : (prev.shortTermLoans as number);
  const endingLongTermLoans = financing ? financing.endingLongTermLoansUsd : (prev.longTermLoans as number);

  const totalAssets =
    closingCash +
    arEnd +
    actuals.rawMaterialInventoryEndUsd +
    finishedGoodsInventoryEnd +
    (prev.otherCurrentAssets as number) +
    fixedAssetsNet +
    constructionInProgressEnd;
  const totalLiabilities =
    apEnd + endingShortTermLoans + endingLongTermLoans + accruedInterestPayableEnd + (prev.otherLiabilities as number);
  const totalEquity = (prev.capitalStock as number) + retainedEarningsEnd;
  const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;

  const balanceSheet: BalanceSheet = {
    companyId,
    period,
    cash: usd(closingCash),
    accountsReceivable: usd(assertFiniteNonNegative(arEnd, "売掛金残高")),
    rawMaterialInventory: usd(assertFiniteNonNegative(actuals.rawMaterialInventoryEndUsd, "原料在庫金額")),
    finishedGoodsInventory: usd(assertFiniteNonNegative(finishedGoodsInventoryEnd, "完成品在庫金額")),
    otherCurrentAssets: prev.otherCurrentAssets,
    fixedAssetsNet: usd(assertFiniteNonNegative(fixedAssetsNet, "固定資産純額")),
    constructionInProgress: usd(assertFiniteNonNegative(constructionInProgressEnd, "建設中勘定残高")),
    totalAssets: usd(totalAssets),
    accountsPayable: usd(assertFiniteNonNegative(apEnd, "買掛金残高")),
    shortTermLoans: usd(assertFiniteNonNegative(endingShortTermLoans, "短期借入金残高")),
    longTermLoans: usd(assertFiniteNonNegative(endingLongTermLoans, "長期借入金残高")),
    accruedInterestPayable: usd(assertFiniteNonNegative(accruedInterestPayableEnd, "未払利息残高")),
    otherLiabilities: prev.otherLiabilities,
    totalLiabilities: usd(totalLiabilities),
    capitalStock: prev.capitalStock,
    retainedEarnings: usd(retainedEarningsEnd),
    totalEquity: usd(totalEquity),
    totalLiabilitiesAndEquity: usd(totalLiabilitiesAndEquity),
    balanceDifference: usd(totalAssets - totalLiabilitiesAndEquity),
  };

  // --- CF（間接法照合つき） ---
  const arBegin = prev.receivables.reduce((s, r) => s + (r.amount as number), 0);
  const apBegin = prev.payables.reduce((s, p) => s + (p.amount as number), 0);
  const finishedGoodsInventoryBegin = prev.finishedGoodsCostLedger.reduce((s, e) => s + e.remainingQuantity * totalUnitCostPerTon(e.unitCost), 0);
  const increaseInReceivables = arEnd - arBegin;
  const increaseInPayables = apEnd - apBegin;
  const increaseInInventory =
    actuals.rawMaterialInventoryEndUsd + finishedGoodsInventoryEnd - actuals.rawMaterialInventoryBeginUsd - finishedGoodsInventoryBegin;
  // 未払利息の増加は、純利益が発生主義の全額利息を控除しているのに対し、
  // 現金は実際の支払額しか減らしていない差額を足し戻す調整（増加したAPを
  // 足し戻すのと同じ理屈）。financing省略時は常に0（Phase 8Aと同一の恒等式）。
  const increaseInAccruedInterestPayable = accruedInterestPayableEnd - accruedInterestPayableBegin;
  const operatingCashFlowIndirect =
    netIncome + depreciationUsd - increaseInReceivables + increaseInPayables - increaseInInventory + increaseInAccruedInterestPayable;

  const cashFlow: CashFlowStatement = {
    companyId,
    period,
    operatingDirect: {
      receiptsFromCustomers: usd(receiptsFromCustomers),
      paymentsForRawMaterials: usd(-paymentsForRawMaterials),
      paymentsForManufacturing: usd(-paymentsForManufacturing),
      paymentsForSellingGeneralAdmin: usd(-sgaTotal),
      interestPaid: usd(-interestPaidCash),
      incomeTaxPaid: usd(-incomeTax),
    },
    operatingCashFlow: usd(operatingCashFlow),
    investingCashFlow: usd(investingCashFlow),
    financingCashFlow: usd(financingCashFlow),
    netCashChange: usd(netCashChange),
    openingCash: usd(openingCash),
    closingCash: usd(closingCash),
    indirectReconciliation: {
      netIncome: usd(netIncome),
      depreciationAddback: usd(depreciationUsd),
      increaseInReceivables: usd(increaseInReceivables),
      increaseInPayables: usd(increaseInPayables),
      increaseInInventory: usd(increaseInInventory),
      increaseInAccruedInterestPayable: usd(increaseInAccruedInterestPayable),
      operatingCashFlowIndirect: usd(operatingCashFlowIndirect),
    },
    directIndirectDifference: usd(operatingCashFlow - operatingCashFlowIndirect),
  };

  // --- 品質損失内訳 ---
  const qualityLoss: QualityLossBreakdown = {
    qualityDiscardLoss: usd(costing.qualityDiscardLoss),
    rawMaterialExpiryLoss: usd(rawMaterialExpiryLoss),
    finishedGoodsWriteOffLoss: usd(finishedGoodsWriteOffLoss),
    reworkCost: usd(costing.reworkCost),
    downgradeSalesDeduction: usd(qualitySalesDeduction),
    discardQuantityTons: costing.discardTonsTotal,
    reworkQuantityTons: costing.reworkTonsTotal,
    downgradeQuantitySoldTons,
  };

  // --- 管理会計: 限界利益レポート ---
  const variableRawMaterialCost = cogsRawMaterial;
  const zeroProductionVariable = costing.unabsorbedManufacturingCost - costing.unabsorbedFixedPortion;
  const variableProcessingCost = cogsProcessing + (zeroProductionVariable > 0 ? costing.manufacturing.utilityVariableCost as number : 0);
  const variableLaborCost = cogsLaborVariable + (zeroProductionVariable > 0 ? (costing.manufacturing.temporaryWorkerCost as number) + (costing.manufacturing.overtimeCost as number) : 0);
  const variableQualityCost = costing.reworkCost + costing.qualityDiscardLoss + rawMaterialExpiryLoss + finishedGoodsWriteOffVariable;
  const variableSellingCost = sellingLogistics;
  const totalVariableCost = variableRawMaterialCost + variableProcessingCost + variableLaborCost + variableQualityCost + variableSellingCost;
  const contributionMarginValue = netRevenue - totalVariableCost;
  const contributionMarginRatio = netRevenue > QUANTITY_EPSILON ? contributionMarginValue / netRevenue : undefined;

  const fixedManufacturingCost =
    (costing.manufacturing.regularLaborCost as number) +
    (costing.manufacturing.factoryFixedCost as number) +
    (costing.manufacturing.utilityFixedCost as number) +
    depreciationUsd;
  const fixedPersonnelCost = salesForceCost + procurementCost;
  const fixedSellingAdminCost = adminFixed;
  const totalFixedCost = fixedManufacturingCost + fixedPersonnelCost + fixedSellingAdminCost;
  const managementOperatingProfit = contributionMarginValue - totalFixedCost;

  const breakEvenRevenue =
    contributionMarginRatio !== undefined && contributionMarginRatio > QUANTITY_EPSILON ? totalFixedCost / contributionMarginRatio : undefined;
  const marginOfSafety = breakEvenRevenue !== undefined ? netRevenue - breakEvenRevenue : undefined;
  const marginOfSafetyRatio = marginOfSafety !== undefined && netRevenue > QUANTITY_EPSILON ? marginOfSafety / netRevenue : undefined;
  const operatingLeverage = managementOperatingProfit > QUANTITY_EPSILON ? contributionMarginValue / managementOperatingProfit : undefined;

  const productNetRevenueTotal = [...byProductAgg.values()].reduce((s, v) => s + v.grossRevenue - v.deduction, 0);
  const assumedProductMix = [...byProductAgg.entries()]
    .map(([product, v]) => ({
      product,
      netRevenueShare: productNetRevenueTotal > QUANTITY_EPSILON ? (v.grossRevenue - v.deduction) / productNetRevenueTotal : 0,
    }))
    .sort((a, b) => a.product.localeCompare(b.product));

  const byProduct: ContributionMarginByDimension[] = [...byProductAgg.entries()]
    .map(([product, v]) => {
      const productQuality = costing.variableQualityCostByProduct.get(product) ?? 0;
      const netRev = v.grossRevenue - v.deduction;
      const variableCost = v.variableCost + productQuality;
      return {
        key: product,
        grossRevenue: usd(v.grossRevenue),
        salesDeduction: usd(v.deduction),
        netRevenue: usd(netRev),
        variableCost: usd(variableCost),
        contributionMargin: usd(netRev - variableCost),
        contributionMarginRatio: netRev > QUANTITY_EPSILON ? (netRev - variableCost) / netRev : undefined,
        directFixedCost: usd(0),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const byMarket: ContributionMarginByDimension[] = [...byMarketAgg.entries()]
    .map(([market, v]) => {
      const netRev = v.grossRevenue - v.deduction;
      return {
        key: market,
        grossRevenue: usd(v.grossRevenue),
        salesDeduction: usd(v.deduction),
        netRevenue: usd(netRev),
        variableCost: usd(v.variableCost),
        contributionMargin: usd(netRev - v.variableCost),
        contributionMarginRatio: netRev > QUANTITY_EPSILON ? (netRev - v.variableCost) / netRev : undefined,
        directFixedCost: usd(0),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  // 商品別へ帰属できない共通変動費: 全量廃棄バッチ以外にも、商品へ帰属済みの
  // 品質費（rework+qualityDiscard、商品別Mapに帰属済み）を除いた残り。
  // = 原料期限切れ廃棄損 + 完成品在庫廃棄損の変動部分 + 生産ゼロ時の未配賦変動費。
  const commonVariableCost = rawMaterialExpiryLoss + finishedGoodsWriteOffVariable + Math.max(0, zeroProductionVariable);

  const contributionMargin: ContributionMarginReport = {
    companyId,
    period,
    grossRevenue: usd(grossRevenue),
    salesDeduction: usd(qualitySalesDeduction),
    netRevenue: usd(netRevenue),
    variableRawMaterialCost: usd(variableRawMaterialCost),
    variableProcessingCost: usd(variableProcessingCost),
    variableLaborCost: usd(variableLaborCost),
    variableQualityCost: usd(variableQualityCost),
    variableSellingCost: usd(variableSellingCost),
    totalVariableCost: usd(totalVariableCost),
    contributionMargin: usd(contributionMarginValue),
    contributionMarginRatio,
    fixedManufacturingCost: usd(fixedManufacturingCost),
    fixedPersonnelCost: usd(fixedPersonnelCost),
    fixedSellingAdminCost: usd(fixedSellingAdminCost),
    totalFixedCost: usd(totalFixedCost),
    managementOperatingProfit: usd(managementOperatingProfit),
    breakEvenRevenue: breakEvenRevenue !== undefined ? usd(breakEvenRevenue) : undefined,
    marginOfSafety: marginOfSafety !== undefined ? usd(marginOfSafety) : undefined,
    marginOfSafetyRatio,
    operatingLeverage,
    assumedProductMix,
    byProduct,
    byMarket,
    commonFixedCost: usd(totalFixedCost),
    commonVariableCost: usd(commonVariableCost),
  };

  // --- 全部原価計算と変動原価計算の利益差異調整 ---
  const fixedCostInOpeningInventory = prev.finishedGoodsCostLedger.reduce((s, e) => s + e.remainingQuantity * fixedUnitCostPerTon(e.unitCost), 0);
  const fixedCostInClosingInventory = nextLedger.reduce((s, e) => s + e.remainingQuantity * fixedUnitCostPerTon(e.unitCost), 0);
  const absorptionVariableReconciliation: AbsorptionVariableReconciliation = {
    companyId,
    period,
    fixedCostInOpeningInventory: usd(fixedCostInOpeningInventory),
    fixedCostAbsorbedIntoInventory: usd(costing.fixedAbsorbedIntoInventory),
    fixedCostReleasedThroughSales: usd(fixedReleasedThroughSales),
    fixedCostReleasedThroughWriteOff: usd(fixedReleasedThroughWriteOff),
    fixedCostInClosingInventory: usd(fixedCostInClosingInventory),
    absorptionOperatingProfit: usd(operatingProfit),
    variableCostingOperatingProfit: usd(managementOperatingProfit),
    profitDifference: usd(operatingProfit - managementOperatingProfit),
  };

  // --- コスト記録（固変分解・ドライバーつき） ---
  const costRecords = buildCostRecords(actuals, params, costing, {
    sellingLogistics,
    salesForceCost,
    procurementCost,
    adminFixed,
    interestExpense,
    incomeTax,
    depreciationUsd,
    soldTonsTotal,
    qualitySalesDeduction,
    rawMaterialExpiryLoss,
    finishedGoodsWriteOffLoss,
    downgradeQuantitySoldTons,
    loanBalance: endingShortTermLoans + endingLongTermLoans,
    fixedAssetsGross: prev.fixedAssetsGross as number,
  });

  // --- 次期状態 ---
  // shortTermLoans/longTermLoansは、financing指定時は融資ポートフォリオ由来の
  // 期末残高（endingShortTermLoans/endingLongTermLoans、上のBSと同一値）を
  // 引き継ぐ。これにより翌期のprev.shortTermLoans/longTermLoansは常に
  // 融資ポートフォリオと一致する（BSの借入残高との二重管理を避ける）。
  const nextState: CompanyFinanceState = {
    companyId,
    cash: usd(closingCash),
    receivables: [...remainingReceivables, ...newReceivables],
    payables: [...remainingPayables, ...newPayables],
    otherCurrentAssets: prev.otherCurrentAssets,
    fixedAssetsGross: usd(fixedAssetsGrossEnd),
    accumulatedDepreciation: usd(accumulatedDepreciationEnd),
    shortTermLoans: usd(endingShortTermLoans),
    longTermLoans: usd(endingLongTermLoans),
    otherLiabilities: prev.otherLiabilities,
    capitalStock: prev.capitalStock,
    retainedEarnings: usd(retainedEarningsEnd),
    finishedGoodsCostLedger: nextLedger,
  };

  const result: CompanyFinancialQuarterResult = {
    companyId,
    period,
    profitAndLoss,
    balanceSheet,
    cashFlow,
    manufacturingCost: costing.manufacturing,
    qualityLoss,
    costRecords,
    contributionMargin,
    absorptionVariableReconciliation,
    cashShortfall: closingCash < 0,
    cashShortfallAmount: usd(closingCash < 0 ? -closingCash : 0),
    negativeEquity: totalEquity < 0,
  };

  return { result, nextState };
}

// ---------------------------------------------------------------------
// 4. コスト記録の生成（固変分解・限界利益管理の基礎データ）
// ---------------------------------------------------------------------

interface CostRecordContext {
  readonly sellingLogistics: number;
  readonly salesForceCost: number;
  readonly procurementCost: number;
  readonly adminFixed: number;
  readonly interestExpense: number;
  readonly incomeTax: number;
  readonly depreciationUsd: number;
  readonly soldTonsTotal: number;
  readonly qualitySalesDeduction: number;
  readonly rawMaterialExpiryLoss: number;
  readonly finishedGoodsWriteOffLoss: number;
  readonly downgradeQuantitySoldTons: number;
  readonly loanBalance: number;
  readonly fixedAssetsGross: number;
}

function buildCostRecords(
  actuals: CompanyQuarterBusinessActuals,
  params: FinanceParameters,
  costing: ProductionCostingResult,
  ctx: CostRecordContext
): readonly CostRecord[] {
  const period = actuals.period;
  const m = costing.manufacturing;
  const totalOriginalTons = actuals.batches.reduce((s, b) => s + b.originalTons, 0);
  const rate = (amount: number, qty: number) => (qty > QUANTITY_EPSILON ? amount / qty : 0);
  const v = (n: number): Usd => usd(n);
  const zero = usd(0);

  const records: CostRecord[] = [
    {
      account: "domesticRawMaterial",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: m.domesticRawMaterialCost,
      driver: "rawMaterialInputQuantity",
      driverQuantity: totalOriginalTons,
      driverUnitRate: rate(m.domesticRawMaterialCost as number, totalOriginalTons),
      period,
      shortTermReducibility: "reducible",
      sourceRef: `batches.rawMaterialConsumed(domestic):${period}`,
    },
    {
      account: "importedRawMaterial",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: m.importedRawMaterialCost,
      driver: "rawMaterialInputQuantity",
      driverQuantity: totalOriginalTons,
      driverUnitRate: rate(m.importedRawMaterialCost as number, totalOriginalTons),
      period,
      shortTermReducibility: "partiallyReducible",
      sourceRef: `batches.rawMaterialConsumed(import):${period}`,
    },
    {
      account: "aquacultureRawMaterial",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: m.aquacultureRawMaterialCost,
      driver: "rawMaterialInputQuantity",
      driverQuantity: totalOriginalTons,
      driverUnitRate: rate(m.aquacultureRawMaterialCost as number, totalOriginalTons),
      period,
      shortTermReducibility: "partiallyReducible",
      sourceRef: `batches.rawMaterialConsumed(aquaculture):${period}`,
    },
    {
      account: "directLaborRegular",
      behavior: "stepFixed",
      fixedPortion: m.regularLaborCost,
      variablePortion: zero,
      driver: "regularHeadcount",
      driverQuantity: actuals.regularHeadcount,
      driverUnitRate: 0,
      period,
      shortTermReducibility: "committed",
      sourceRef: `decisions.workerAssignments(regular):${period}`,
    },
    {
      account: "temporaryWorker",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: m.temporaryWorkerCost,
      driver: "temporaryWorkerHeadcount",
      driverQuantity: actuals.temporaryHeadcount,
      driverUnitRate: params.labor.temporaryWorkerCostUsdPerQuarter,
      period,
      shortTermReducibility: "reducible",
      sourceRef: `decisions.workerAssignments(temporary):${period}`,
    },
    {
      account: "overtime",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: m.overtimeCost,
      driver: "overtimeHours",
      // 【商品別実労務配分】"actual"モードでは実配属人数×適用残業率の合計（労務相当量）、
      // "legacy"モードでは従来どおり会社全体平均残業率×全社regularHeadcountを使う。
      // いずれのモードでも m.overtimeCost = driverQuantity × 単価 × 割増率 が厳密に成り立つ。
      driverQuantity: costing.overtimeLaborEquivalent,
      driverUnitRate: rate(m.overtimeCost as number, costing.overtimeLaborEquivalent),
      period,
      shortTermReducibility: "reducible",
      sourceRef: `companyLoadMetrics.overtimeRate:${period}`,
    },
    {
      account: "hosoProcessing",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: m.hosoProcessingCost,
      driver: "productionQuantity",
      driverQuantity: totalOriginalTons,
      driverUnitRate: rate(m.hosoProcessingCost as number, totalOriginalTons),
      period,
      shortTermReducibility: "reducible",
      sourceRef: `batches(baseProcessing):${period}`,
    },
    {
      account: "pdAdditionalProcessing",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: m.pdAdditionalProcessingCost,
      driver: "productionQuantity",
      driverQuantity: actuals.batches.filter((b) => b.product === "pd").reduce((s, b) => s + b.originalTons, 0),
      driverUnitRate: rate(m.pdAdditionalProcessingCost as number, actuals.batches.filter((b) => b.product === "pd").reduce((s, b) => s + b.originalTons, 0)),
      product: "pd",
      period,
      shortTermReducibility: "reducible",
      sourceRef: `batches(pdAdditional):${period}`,
    },
    {
      account: "vapAdditionalProcessing",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: m.vapAdditionalProcessingCost,
      driver: "productionQuantity",
      driverQuantity: actuals.batches.filter((b) => b.product === "vap").reduce((s, b) => s + b.originalTons, 0),
      driverUnitRate: rate(m.vapAdditionalProcessingCost as number, actuals.batches.filter((b) => b.product === "vap").reduce((s, b) => s + b.originalTons, 0)),
      product: "vap",
      period,
      shortTermReducibility: "reducible",
      sourceRef: `batches(vapAdditional):${period}`,
    },
    {
      account: "factoryFixed",
      behavior: "stepFixed",
      fixedPortion: m.factoryFixedCost,
      variablePortion: zero,
      driver: "factoryCount",
      driverQuantity: actuals.activeFactoryCount,
      driverUnitRate: 0,
      period,
      shortTermReducibility: "committed",
      sourceRef: `fixtures.factories(active):${period}`,
    },
    {
      // 混合費: 固定部分と変動部分を分離して保存する（合計からの再推定禁止）。
      account: "factoryUtility",
      behavior: "mixed",
      fixedPortion: m.utilityFixedCost,
      variablePortion: m.utilityVariableCost,
      driver: "productionQuantity",
      driverQuantity: totalOriginalTons,
      driverUnitRate: params.manufacturing.factoryUtilityVariableUsdPerTon,
      period,
      shortTermReducibility: "partiallyReducible",
      sourceRef: `factories+batches(utility):${period}`,
    },
    {
      account: "depreciation",
      behavior: "fixed",
      fixedPortion: v(ctx.depreciationUsd),
      variablePortion: zero,
      driver: "fixedAssetBalance",
      driverQuantity: ctx.fixedAssetsGross,
      driverUnitRate: 0,
      period,
      shortTermReducibility: "committed",
      sourceRef: `financeState.fixedAssetsGross:${period}`,
    },
    {
      account: "rework",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: m.reworkCost,
      driver: "reworkQuantity",
      driverQuantity: costing.reworkTonsTotal,
      driverUnitRate: params.manufacturing.reworkCostUsdPerTon,
      period,
      shortTermReducibility: "reducible",
      sourceRef: `qualityAdjustments.reworkQuantity:${period}`,
    },
    {
      account: "discardLoss",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: v(costing.qualityDiscardLoss + ctx.rawMaterialExpiryLoss + ctx.finishedGoodsWriteOffLoss),
      driver: "discardQuantity",
      driverQuantity: costing.discardTonsTotal,
      driverUnitRate: rate(costing.qualityDiscardLoss, costing.discardTonsTotal),
      period,
      shortTermReducibility: "reducible",
      sourceRef: `qualityAdjustments.discardQuantity+lotExpiry:${period}`,
    },
    {
      account: "downgradeSalesDeduction",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: v(ctx.qualitySalesDeduction),
      driver: "salesQuantity",
      driverQuantity: ctx.downgradeQuantitySoldTons,
      driverUnitRate: rate(ctx.qualitySalesDeduction, ctx.downgradeQuantitySoldTons),
      period,
      shortTermReducibility: "reducible",
      sourceRef: `fulfillmentUsage×downgradeRatio:${period}`,
    },
    {
      account: "sellingLogistics",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: v(ctx.sellingLogistics),
      driver: "salesQuantity",
      driverQuantity: ctx.soldTonsTotal,
      driverUnitRate: params.sellingGeneralAdmin.sellingLogisticsUsdPerTon,
      period,
      shortTermReducibility: "reducible",
      sourceRef: `fulfillmentUsage:${period}`,
    },
    {
      account: "salesForceSalary",
      behavior: "stepFixed",
      fixedPortion: v(ctx.salesForceCost),
      variablePortion: zero,
      driver: "regularHeadcount",
      driverQuantity: actuals.salesForceHeadcount,
      driverUnitRate: 0,
      period,
      shortTermReducibility: "committed",
      sourceRef: `fixtures.salesForceHeadcountTotal:${period}`,
    },
    {
      account: "procurementSalary",
      behavior: "stepFixed",
      fixedPortion: v(ctx.procurementCost),
      variablePortion: zero,
      driver: "regularHeadcount",
      driverQuantity: actuals.procurementHeadcount,
      driverUnitRate: 0,
      period,
      shortTermReducibility: "committed",
      sourceRef: `fixtures.procurementHeadcountTotal:${period}`,
    },
    {
      account: "adminFixed",
      behavior: "fixed",
      fixedPortion: v(ctx.adminFixed),
      variablePortion: zero,
      driver: "none",
      driverQuantity: 0,
      driverUnitRate: 0,
      period,
      shortTermReducibility: "committed",
      sourceRef: `parameters.adminFixed:${period}`,
    },
    {
      account: "interestExpense",
      behavior: "fixed",
      fixedPortion: v(ctx.interestExpense),
      variablePortion: zero,
      driver: "loanBalance",
      driverQuantity: ctx.loanBalance,
      driverUnitRate: 0,
      period,
      shortTermReducibility: "committed",
      sourceRef: `financeState.loans:${period}`,
    },
    {
      account: "incomeTax",
      behavior: "variable",
      fixedPortion: zero,
      variablePortion: v(ctx.incomeTax),
      driver: "none",
      driverQuantity: 0,
      driverUnitRate: 0,
      period,
      shortTermReducibility: "committed",
      sourceRef: `profitBeforeTax×taxRate:${period}`,
    },
  ];

  return records;
}
