// ShrimpX V2 — Phase SAI-6.1: Situation Diagnosis（不足型／過剰型の6カテゴリ診断）
//
// 【目的】Standard AIが意思決定を行う前に、「何が足りないか」と「何が余っているか」を
// 説明可能な形で診断する。対象は営業・生産能力・Worker・原料・在庫・資金の6カテゴリ。
// 6つを1つの合成pressure scoreへ押し込まず、各指標を独立に保持し、
// shortage(不足) / balanced(均衡) / surplus(余剰) を判定できる構造にする
// （設計レポート docs/standard_ai/TEST14_TURN1_STANDARD_AI_REDESIGN_ANALYSIS.md
// §10・三宅さんの実装指示を参照）。
//
// 【今回のスコープ（重要）】本モジュールは診断専用であり、意思決定（productionPlans・
// domesticPurchasePlan・importOrders・aquacultureStockingPlans・workerAssignments・
// financingRequest・capexDecision）を一切変更しない。診断のために「基本当期生産
// 必要量」「必要原料」「理論必要Worker」を独自に計算するが、これは既存の
// decision/production.ts・decision/procurement.ts・decision/labor.tsの計算とは
// 完全に独立した、診断専用の並行計算である（既存モジュールの計算式・出力は
// 一切変更していない）。SAI-6.4（Inventory & Production Planへの接続）で、
// 実際の生産計画がこの「基本当期生産必要量」を参照するように配線を切り替える
// 予定だが、それは別途指示があるまで着手しない。

import { CompanyFixture } from "../../types";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation, sumProductAmount, zeroProductAmount } from "../types";
import { StandardAiDiagnosticEntry, StandardAiReasonCode } from "../reasonCodes";
import { computeRequiredRegularHeadcount } from "../../workforce";
import { CurrentPeriodDeliveryDemand } from "./currentPeriodDeliveryDemand";
import {
  computeBasicCurrentPeriodProductionRequirement,
  computeEligibleCurrentPeriodDemand,
  computeNormalInventoryTargetByProduct,
} from "./productionRequirement";

const EPSILON = 1e-6;

export type ConstraintState = "shortage" | "balanced" | "surplus" | "unknown";

/** 診断が判定できる制約カテゴリ（不足型／過剰型）。primaryConstraint/secondaryConstraintで使う。 */
export type DiagnosisConstraintCategory =
  | "sales_shortage"
  | "production_capacity_shortage"
  | "production_capacity_surplus"
  | "worker_shortage"
  | "worker_surplus"
  | "raw_material_shortage"
  | "inventory_excess"
  | "liquidity_shortage"
  | "none";

/**
 * 【設計判断】各カテゴリの閾値は、生産・調達等の意思決定パラメータ
 * （STANDARD_AI_PARAMETERS_V1）とは独立した、診断専用の分類しきい値として
 * このファイル内に保持する（診断ロジックが意思決定ロジックの既存パラメータに
 * 依存して意図せず変化することを避けるため）。将来、診断結果を意思決定へ
 * 接続する段階（SAI-6.4以降）で、必要に応じてSTANDARD_AI_PARAMETERS_V1へ
 * 統合するかどうかを再検討する。
 */
export const SITUATION_DIAGNOSIS_THRESHOLDS_V1 = {
  salesShortageRatio: 0.6,
  productionShortageRatio: 0.9,
  productionSurplusRatio: 0.5,
  workerShortageRatio: 1.05,
  workerSurplusRatio: 0.6,
  rawMaterialShortageRatio: 1.0,
  inventoryExcessRatio: 1.5,
  liquidityShortageRatio: 1.0,
} as const;

/**
 * 【unknownの扱い（実装指示§11）】各`*Ratio`フィールドは、分母が実質ゼロ等で
 * 算出不能な場合は推測値（0や1などの捏造値）を作らずNaNを保持する。呼び出し側は
 * 必ず対応する`*State`フィールド（"unknown"）で判定すること（NaNを直接比較・
 * 表示しない）。
 */
export interface StandardAiSituationDiagnosis {
  /** 現実的販売可能量（realisticSalesByProduct合計） / 理論販売機会（desiredByProduct合計）。低いほど営業制約が強い。算出不能ならNaN（stateはunknown）。 */
  readonly salesFulfillmentRatio: number;
  readonly salesFulfillmentState: ConstraintState;
  /** 基本当期生産必要量（合計） / Standard AIが現在認識できる生産能力（合計、ノミナル）。高いほど生産能力制約が強い。 */
  readonly productionLoadRatio: number;
  readonly productionLoadState: ConstraintState;
  /** 理論必要Worker / 現在Worker（動的state）。高ければ不足、低すぎれば余剰。 */
  readonly workerLoadRatio: number;
  readonly workerLoadState: ConstraintState;
  /**
   * 【SAI-6.4修正】(当期利用可能原料+当期確実に取得可能な原料) / 必要原料。1未満は
   * 「期首在庫＋確定入荷だけでは足りない＝当期中に追加調達が必要」ことを意味するに
   * すぎず、それ自体はボトルネックではない（通常の調達行為）。真の供給制約かどうかは
   * `rawMaterialSupplyConstraintState`で別途判定する。
   */
  readonly rawMaterialCoverageRatio: number;
  readonly rawMaterialCoverageState: ConstraintState;
  /** rawMaterialCoverageRatio<1のとき true。「調達行為が必要」という中立的な事実であり、単独ではボトルネックと解釈しない。 */
  readonly rawMaterialProcurementNeeded: boolean;
  /**
   * 【SAI-6.4新設】真の原料供給制約（「当期国内市場から現実的に追加調達可能な量」を
   * 超えて必要になる状態）の判定。現行のStandard AI観測（StandardAiObservation）には
   * 国内市場の追加調達可能量・シェア上限（rawMaterials/domesticPurchase.tsの
   * maximumBuyerShare等）が一切露出していないため、今回はこの値を捏造せず常に
   * "unknown"を返す（=原料不足と断定しない）。将来、当該情報がobservationへ
   * 追加された場合にのみ"shortage"等を判定できるようにする受け皿。
   */
  readonly rawMaterialSupplyConstraintState: ConstraintState;
  /** 期首完成品在庫(通常在庫扱い分) / 通常在庫目標。高すぎる場合に在庫過多。 */
  readonly inventoryExcessRatio: number;
  readonly inventoryExcessState: ConstraintState;
  /** 現金 / 会社規模連動の最低現金バッファ。低いほど資金制約が強い（借入余力は今回未接続、§19の未確定事項）。 */
  readonly liquidityCoverageRatio: number;
  readonly liquidityCoverageState: ConstraintState;

  /** 今期の主要制約（上位1件）。複数該当が無ければ"none"。 */
  readonly primaryConstraint: DiagnosisConstraintCategory;
  /** 今期の第2の制約（上位2件目）。無ければ"none"。 */
  readonly secondaryConstraint: DiagnosisConstraintCategory;

  /** SAI-6.3で構築したcurrentPeriodDeliveryDemand（当期納品需要）そのもの。 */
  readonly currentPeriodDeliveryDemandByProduct: ProductAmount;
  readonly deliveryDemandSource: CurrentPeriodDeliveryDemand["source"];

  /** 生産能力の余力（能力合計－基本当期生産必要量合計）。負なら能力不足。 */
  readonly productionCapacityHeadroom: number;
  /** Workerの余力（現在Worker－理論必要Worker）。負なら不足。 */
  readonly workerHeadroom: number;

  /** 診断専用に算出した「基本当期生産必要量」（商品別。§12.1の概念式、戦略先行生産は含まない）。 */
  readonly basicCurrentPeriodProductionRequirementByProduct: ProductAmount;
  /** 診断専用に算出した必要原料量（歩留まり1.0基準、既存procurement.tsと同じ前提）。 */
  readonly requiredRawMaterial: number;
  /** 診断専用に算出した理論必要Worker（会社全体、工場別配分の合計）。 */
  readonly requiredWorker: number;

  /**
   * 【設計判断・実装指示の要請】Standard AIが現在認識できる生産能力（ノミナル）と、
   * 将来利用すべき実効能力（0.855係数＝baseUtilizationRate×equipmentAvailabilityRate
   * 適用後）の差。今回はゲーム側の能力定義・意思決定ロジックのいずれも変更しない
   * （実効能力を使うのはSAI-6.4以降の別途判断）。差が実質的に無い場合（能力定義が
   * 未接続等）はundefined。
   */
  readonly capacityRecognitionGap?: {
    readonly nominalCapacityTotal: number;
    readonly effectiveCapacityTotal: number;
  };
}

export interface SituationDiagnosisResult {
  readonly diagnosis: StandardAiSituationDiagnosis;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

function classify(ratio: number | undefined, shortageIf: (r: number) => boolean, surplusIf?: (r: number) => boolean): ConstraintState {
  if (ratio === undefined || !Number.isFinite(ratio)) return "unknown";
  if (shortageIf(ratio)) return "shortage";
  if (surplusIf && surplusIf(ratio)) return "surplus";
  return "balanced";
}

/** 基本当期生産必要量を各工場へ能力シェアで配分し、理論必要Workerを合算する（labor.tsと同じ配分方式の再利用。独自の推定方式は増設しない）。 */
function computeRequiredWorkerTotal(fixture: CompanyFixture, observation: StandardAiObservation, basicRequirementByProduct: ProductAmount): number {
  const capacityTotals = observation.totalCapacityByProduct;
  let total = 0;
  for (const baseline of fixture.workerBaseline) {
    const factoryObs = observation.factories.find((f) => f.factoryId === baseline.factoryId);
    if (!factoryObs) continue;
    const quantityByProduct = zeroProductAmount();
    for (const product of ["hoso", "pd", "vap"] as const) {
      const companyCapacity = capacityTotals[product];
      const share = companyCapacity > EPSILON ? factoryObs.capacityByProduct[product] / companyCapacity : 0;
      quantityByProduct[product] = basicRequirementByProduct[product] * share;
    }
    const required = computeRequiredRegularHeadcount({
      quantityByProduct,
      skillByProduct: factoryObs.skillByProduct,
      attendanceRate: factoryObs.attendanceRate,
      appliedOvertimeRate: 0,
      temporaryHeadcount: 0,
    });
    total += required.requiredRegularHeadcount;
  }
  return total;
}

export function buildStandardAiSituationDiagnosis(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  desiredByProduct: ProductAmount,
  realisticSalesByProduct: ProductAmount,
  deliveryDemand: CurrentPeriodDeliveryDemand,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): SituationDiagnosisResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const T = SITUATION_DIAGNOSIS_THRESHOLDS_V1;

  // --- 1. 営業（Sales Fulfillment Ratio） ---
  const theoreticalSalesOpportunity = sumProductAmount(desiredByProduct);
  const realisticSalesTotal = sumProductAmount(realisticSalesByProduct);
  const salesFulfillmentRatio = theoreticalSalesOpportunity > EPSILON ? realisticSalesTotal / theoreticalSalesOpportunity : NaN;
  const salesFulfillmentState = classify(Number.isFinite(salesFulfillmentRatio) ? salesFulfillmentRatio : undefined, (r) => r < T.salesShortageRatio);

  // --- 基本当期生産必要量（SAI-6.4：productionRequirement.tsの共通実装を診断側でも再利用する。
  // 実際の生産計画（decision/production.ts）はSAI-6.4でこの同じ実装に配線されるため、
  // ここで別式を持つと将来の実装ズレを起こす） ---
  const normalInventoryTargetByProduct = computeNormalInventoryTargetByProduct(observation, params);
  const eligibleDemandByProduct = computeEligibleCurrentPeriodDemand(deliveryDemand);
  const basicRequirementByProduct = computeBasicCurrentPeriodProductionRequirement(
    eligibleDemandByProduct,
    normalInventoryTargetByProduct,
    observation.finishedGoodsByProduct
  );
  const basicRequirementTotal = sumProductAmount(basicRequirementByProduct);

  // --- 2. 生産能力（Production Load Ratio） ---
  // 【2026-08-02・能力認識監査Phase 3対応】従来はここでnominalCapacityTotal（名目、
  // capex加算後だが稼働率・設備利用可能率未適用）をProduction Load Ratioの分母に
  // 使っており、これがTest14 Turn2で「24,000t生産可能」という過大な能力認識の
  // 根本原因の一つだった（PRODUCTION_CAPACITY_RECOGNITION_GAPとして差分は診断情報
  // に出していたが、比率計算自体には反映していなかった）。今回、observation側に
  // 追加したtotalEffectiveCapacityByProduct/totalEffectiveCommonProcessingCapacity/
  // totalEffectiveFreezingPackagingCapacity（いずれもproduction/capacity.tsの
  // calculateFactoryEffectiveCapacityをそのまま再利用して算出。新しい能力算出ロジックは
  // 増設していない）を使い、「実効能力」（商品別稼働率適用後）と「共有ボトルネックの
  // 実効能力」（共通前処理・凍結包装）のうち最も厳しい値を「binding capacity」として
  // Production Load Ratioの分母に採用する。
  const nominalCapacityTotal = sumProductAmount(observation.totalCapacityByProduct);
  const effectiveCapacityTotal = sumProductAmount(observation.totalEffectiveCapacityByProduct);
  const bindingCapacityTotal = Math.min(
    effectiveCapacityTotal,
    observation.totalEffectiveCommonProcessingCapacity > EPSILON ? observation.totalEffectiveCommonProcessingCapacity : effectiveCapacityTotal,
    observation.totalEffectiveFreezingPackagingCapacity > EPSILON ? observation.totalEffectiveFreezingPackagingCapacity : effectiveCapacityTotal
  );
  const productionLoadRatio = bindingCapacityTotal > EPSILON ? basicRequirementTotal / bindingCapacityTotal : NaN;
  const productionLoadState = classify(
    Number.isFinite(productionLoadRatio) ? productionLoadRatio : undefined,
    (r) => r > T.productionShortageRatio,
    (r) => r < T.productionSurplusRatio
  );
  const productionCapacityHeadroom = bindingCapacityTotal - basicRequirementTotal;

  // 【実装指示§4対応、2026-08-02更新】能力認識ギャップの明示。今回からProduction Load
  // Ratio自体がbindingCapacityTotal（実効・共有ボトルネック考慮後）を使うようになった
  // ため、このdiagnosticは「差はもう意思決定へ反映済みである」ことを明示する内容へ更新する
  // （ゲーム側の能力定義・engine本体は変更していない。既存の共有関数を再利用しただけ）。
  let capacityRecognitionGap: StandardAiSituationDiagnosis["capacityRecognitionGap"];
  if (nominalCapacityTotal > EPSILON && Math.abs(nominalCapacityTotal - bindingCapacityTotal) > nominalCapacityTotal * 0.01) {
    capacityRecognitionGap = { nominalCapacityTotal, effectiveCapacityTotal: bindingCapacityTotal };
    diagnostics.push({
      code: "PRODUCTION_CAPACITY_RECOGNITION_GAP",
      domain: "diagnosis",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { nominalCapacityTotal, effectiveCapacityTotal: bindingCapacityTotal },
      message:
        `設備の名目能力合計（${Math.round(nominalCapacityTotal)}t）は、稼働率・設備利用可能率および共通前処理・凍結` +
        `包装の共有ボトルネックを反映した実行可能な生産上限（binding capacity、合計${Math.round(
          bindingCapacityTotal
        )}t）より大きい。2026-08-02の能力認識監査対応以降、Production Load Ratio・生産計画（decision/production.ts）は` +
        `いずれもこのbinding capacityを使う（名目値をそのまま生産可能量として扱わない）。`,
    });
  }

  // --- 3. Worker（Worker Load Ratio） ---
  const requiredWorker = computeRequiredWorkerTotal(fixture, observation, basicRequirementByProduct);
  const currentWorker = observation.regularHeadcountTotal;
  const workerLoadRatio = currentWorker > EPSILON ? requiredWorker / currentWorker : NaN;
  const workerLoadState = classify(
    Number.isFinite(workerLoadRatio) ? workerLoadRatio : undefined,
    (r) => r > T.workerShortageRatio,
    (r) => r < T.workerSurplusRatio
  );
  const workerHeadroom = currentWorker - requiredWorker;

  // --- 4. 原料（Raw Material Coverage Ratio） ---
  // 【SAI-6.4修正】growingAquaculture（未収穫）は当期利用可能原料に含めない。inTransitImportは
  // availableFromPeriod（既存フィールド）が当期以前のものだけを「当期確実に取得可能」に含める。
  // rawMaterialCoverageRatioが1未満でも、それは「期首在庫＋確定入荷だけでは足りない」という
  // 事実（＝通常の調達行為が必要）であり、ボトルネックではない。Test14 Turn1のように国内市場
  // から追加調達できる状況では「原料不足」と断定してはならない（三宅さんの指摘・調査結果）。
  const requiredRawMaterial = basicRequirementTotal; // 歩留まり1.0基準（既存procurement.tsと同じ前提）
  const currentlyAvailable = observation.rawMaterialAvailable + observation.rawMaterialCertainInboundThisPeriod;
  const rawMaterialCoverageRatio = requiredRawMaterial > EPSILON ? currentlyAvailable / requiredRawMaterial : NaN;
  const rawMaterialCoverageState = classify(Number.isFinite(rawMaterialCoverageRatio) ? rawMaterialCoverageRatio : undefined, (r) => r < T.rawMaterialShortageRatio);
  const rawMaterialProcurementNeeded = Number.isFinite(rawMaterialCoverageRatio) && rawMaterialCoverageRatio < T.rawMaterialShortageRatio;
  const rawMaterialShortfall = Math.max(0, requiredRawMaterial - currentlyAvailable);

  // 【2026-08-02・能力認識監査Phase 2・4対応】従来はrawMaterialSupplyConstraintStateを
  // 常にunknownで固定していた（当時はStandardAiObservationに国内市場の追加調達可能量が
  // 一切露出していなかったため）。今回observationへvietnamDomesticPriorMarket（前四半期の
  // ベトナム国内未凍結原料市場の公開清算結果：supply/effectiveDemand/transactedVolume/
  // unsoldSupply。既にPublicMarketInfo.lastMarketResultに存在していた値をそのまま転記した
  // だけであり、新しい市場ルールは追加していない）を追加したため、この判定を更新する。
  //
  // 【重要・意図的な保守性】maximumBuyerShare・approvedPurchaseCap・company-specific
  // purchase capacityといった、ゲーム側でまだ公開・確定していない「この会社が実際に買える
  // 上限」は依然として観測に存在せず、推測で作らない（実装指示の明示的な禁止事項）。
  // したがって「前四半期、市場全体でどれだけ農家の供給が売れ残ったか（unsoldSupply）」を
  // 「当期、市場全体にどれだけ買う余地があるかの目安（前期ベースの参考値）」として使い、
  // 会社個別の購買上限は一切仮定しない。この目安が今期の必要調達量（不足分＝
  // rawMaterialShortfall）を上回る場合にのみ「真の供給制約ではない（surplus）」と判定し、
  // 下回る場合にのみ「真の供給制約の可能性がある（shortage）」と判定する。市場公開情報が
  // 存在しない場合（turn1等）は、引き続きunknownのまま（捏造しない）。
  let rawMaterialSupplyConstraintState: ConstraintState = "unknown";
  if (!rawMaterialProcurementNeeded) {
    // 調達行為自体が不要（期首在庫＋確定入荷だけで足りる）場合、真の供給制約も当然発生しない。
    rawMaterialSupplyConstraintState = "balanced";
  } else if (observation.vietnamDomesticPriorMarket) {
    rawMaterialSupplyConstraintState = observation.vietnamDomesticPriorMarket.unsoldSupply >= rawMaterialShortfall ? "surplus" : "shortage";
  }

  if (rawMaterialProcurementNeeded) {
    diagnostics.push({
      code: "RAW_MATERIAL_PROCUREMENT_NEEDED",
      domain: "diagnosis",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { rawMaterialCoverageRatio, currentlyAvailable, requiredRawMaterial },
      message:
        `期首利用可能原料＋当期確実に取得可能な原料（${Math.round(currentlyAvailable)}t）が必要原料（${Math.round(
          requiredRawMaterial
        )}t）に届かないため、当期中の追加調達（国内購入・輸入等）が必要（procurement needed）。これは通常の調達行為であり、` +
        `それ自体をボトルネックとは診断しない。`,
    });
    if (observation.vietnamDomesticPriorMarket) {
      diagnostics.push({
        code: "RAW_MATERIAL_SUPPLY_CONSTRAINT_ASSESSED",
        domain: "diagnosis",
        companyId: fixture.companyId,
        severity: rawMaterialSupplyConstraintState === "shortage" ? "warning" : "info",
        keyValues: {
          rawMaterialShortfall,
          domesticUnsoldSupply: observation.vietnamDomesticPriorMarket.unsoldSupply,
        },
        message:
          rawMaterialSupplyConstraintState === "surplus"
            ? `前四半期のベトナム国内市場の売れ残り供給（unsold supply、${Math.round(
                observation.vietnamDomesticPriorMarket.unsoldSupply
              )}t）が当期の追加調達必要量（不足分、${Math.round(
                rawMaterialShortfall
              )}t）を上回るため、期首在庫だけでは不足していても真の供給制約とは診断しない（surplus）。` +
              `（注：この会社が実際に購入できる上限（買い手シェア上限等）は現行観測に無いため未考慮。市場全体の目安のみ）。`
            : `前四半期のベトナム国内市場の売れ残り供給（${Math.round(
                observation.vietnamDomesticPriorMarket.unsoldSupply
              )}t）が当期の追加調達必要量（${Math.round(
                rawMaterialShortfall
              )}t）に届かないため、真の供給制約（shortage）の可能性がある。`,
      });
    } else {
      diagnostics.push({
        code: "RAW_MATERIAL_SUPPLY_CONSTRAINT_UNKNOWN",
        domain: "diagnosis",
        companyId: fixture.companyId,
        severity: "info",
        message:
          "前四半期のベトナム国内市場の公開清算結果（vietnamDomesticPriorMarket）が観測に存在しないため（turn1等）、" +
          "真の供給制約（raw material supply constraint）かどうかは不明（unknown）。原料不足と断定していない。",
      });
    }
  }

  // --- 5. 在庫（Inventory Excess Ratio） ---
  const normalInventoryTargetTotal = sumProductAmount(normalInventoryTargetByProduct);
  const openingFinishedGoodsTotal = sumProductAmount(observation.finishedGoodsByProduct);
  const inventoryExcessRatio = normalInventoryTargetTotal > EPSILON ? openingFinishedGoodsTotal / normalInventoryTargetTotal : NaN;
  // 【命名の注意】在庫については「多すぎる」ことが問題（過剰型）なので、
  // classify()の第3引数（surplusIf）へ過多しきい値を渡す。「shortage」は
  // 発火させない（在庫が少なすぎることは今回のTest14 Turn1診断の対象外。
  // §17の将来教師ケース「在庫過多」参照）。
  const inventoryExcessState = classify(
    Number.isFinite(inventoryExcessRatio) ? inventoryExcessRatio : undefined,
    () => false,
    (r) => r > T.inventoryExcessRatio
  );

  // --- 6. 資金（Liquidity Coverage Ratio） ---
  // 【SAI-6.4修正】cash/targetMinimumCashは「手元現金バッファ」の指標であって、
  // 会社全体の資金調達能力（借入余力を含む）ではない。調査の結果、
  // financing/borrowingCapacity.tsのcomputeBorrowingCapacity()は既存の資金調達力
  // 計算式として存在するが、その入力（担保価値・EBITDA相当・自己資本・信用区分等）は
  // 現行のStandardAiObservation/CompanyFixture/ownStateには露出しておらず、
  // 今回新規にバランスシート項目をobservationへ配線することはスコープ外（Financial
  // Capacity forward simulation本体は今回実装しない指示のため）。したがって、
  // liquidityCoverageRatioが低いことだけをもって「資金制約（primary/secondary候補）」
  // と断定せず、CASH_BUFFER_BELOW_TARGETという中立的なwarning情報に留める。
  const liquidityCoverageRatio = pressures.targetMinimumCashUsd > EPSILON ? observation.cashUsd / pressures.targetMinimumCashUsd : NaN;
  const liquidityCoverageState = classify(Number.isFinite(liquidityCoverageRatio) ? liquidityCoverageRatio : undefined, (r) => r < T.liquidityShortageRatio);
  if (Number.isFinite(liquidityCoverageRatio)) {
    diagnostics.push({
      code: "CASH_BUFFER_BELOW_TARGET",
      domain: "diagnosis",
      companyId: fixture.companyId,
      severity: liquidityCoverageState === "shortage" ? "warning" : "info",
      keyValues: { liquidityCoverageRatio, cashUsd: observation.cashUsd, targetMinimumCashUsd: pressures.targetMinimumCashUsd },
      message:
        "Liquidity Coverage Ratio = 現金 / 会社規模連動の最低現金バッファ（手元現金バッファのみの簡易指標）。" +
        "借入余力（computeBorrowingCapacity相当）は今回Standard AI観測に未接続のため、この比率単独では資金制約と断定せず、" +
        "primary/secondary制約候補には含めない。",
    });
  }

  // --- 主要制約・第2制約の判定（複合制約・上位2件方式） ---
  type Scored = { category: DiagnosisConstraintCategory; score: number; code: StandardAiReasonCode; message: string };
  const candidates: Scored[] = [];
  if (salesFulfillmentState === "shortage") {
    candidates.push({
      category: "sales_shortage",
      score: (T.salesShortageRatio - salesFulfillmentRatio) / T.salesShortageRatio,
      code: "SALES_FORCE_BINDING_CONSTRAINT",
      message: `現実的販売可能量（${Math.round(realisticSalesTotal)}t）が理論販売機会（${Math.round(
        theoreticalSalesOpportunity
      )}t）を大きく下回るため、営業が支配的な制約と診断する（Sales Fulfillment Ratio=${salesFulfillmentRatio.toFixed(2)}）。`,
    });
  }
  if (productionLoadState === "shortage") {
    candidates.push({
      category: "production_capacity_shortage",
      score: (productionLoadRatio - T.productionShortageRatio) / T.productionShortageRatio,
      code: "PRODUCTION_CAPACITY_BINDING_CONSTRAINT",
      message: `基本当期生産必要量（${Math.round(basicRequirementTotal)}t）が実行可能な生産上限（binding capacity、${Math.round(
        bindingCapacityTotal
      )}t）に対し高水準のため、生産能力が制約となりうる（Production Load Ratio=${productionLoadRatio.toFixed(2)}）。`,
    });
  } else if (productionLoadState === "surplus") {
    candidates.push({
      category: "production_capacity_surplus",
      score: (T.productionSurplusRatio - productionLoadRatio) / T.productionSurplusRatio,
      code: "PRODUCTION_CAPACITY_HEADROOM",
      message: `実行可能な生産上限（binding capacity、${Math.round(bindingCapacityTotal)}t）に対し基本当期生産必要量（${Math.round(
        basicRequirementTotal
      )}t）は小さく、生産能力に余力がある（Production Load Ratio=${productionLoadRatio.toFixed(2)}）。`,
    });
  }
  if (workerLoadState === "shortage") {
    candidates.push({
      category: "worker_shortage",
      score: (workerLoadRatio - T.workerShortageRatio) / T.workerShortageRatio,
      code: "WORKER_SHORTAGE_DIAGNOSED",
      message: `理論必要Worker（${Math.round(requiredWorker)}人）が現在Worker（${Math.round(
        currentWorker
      )}人）を上回るため、Worker不足と診断する（Worker Load Ratio=${workerLoadRatio.toFixed(2)}）。`,
    });
  } else if (workerLoadState === "surplus") {
    candidates.push({
      category: "worker_surplus",
      score: (T.workerSurplusRatio - workerLoadRatio) / T.workerSurplusRatio,
      code: "WORKER_SURPLUS",
      message: `現在Worker（${Math.round(currentWorker)}人）が理論必要Worker（${Math.round(
        requiredWorker
      )}人）を大きく上回るため、Worker余剰と診断する（Worker Load Ratio=${workerLoadRatio.toFixed(2)}）。`,
    });
  }
  // 【SAI-6.4修正】rawMaterialCoverageState==="shortage"（期首在庫＋確定入荷だけでは
  // 不足）だけではprimary/secondary候補へ入れない。「真の供給制約」
  // （rawMaterialSupplyConstraintState==="shortage"）だけを候補にする。現行の
  // Standard AI観測では国内追加調達可能量が不明なため、rawMaterialSupplyConstraintState
  // は常にunknownであり、この節は今回発火しない（将来、当該情報が観測へ追加された
  // 場合の受け皿として構造だけを残す）。
  if (rawMaterialSupplyConstraintState === "shortage") {
    candidates.push({
      category: "raw_material_shortage",
      score: 1 - rawMaterialCoverageRatio,
      code: "RAW_MATERIAL_SHORTAGE",
      message: `真の原料供給制約（当期国内市場からの追加調達可能量を超えて必要）と診断する（Raw Material Coverage Ratio=${rawMaterialCoverageRatio.toFixed(2)}）。`,
    });
  }
  if (inventoryExcessState === "surplus") {
    candidates.push({
      category: "inventory_excess",
      score: (inventoryExcessRatio - T.inventoryExcessRatio) / T.inventoryExcessRatio,
      code: "INVENTORY_EXCESS",
      message: `期首完成品在庫（合計${Math.round(openingFinishedGoodsTotal)}t）が通常在庫目標（合計${Math.round(
        normalInventoryTargetTotal
      )}t）を大きく超えるため、在庫過多と診断する（Inventory Excess Ratio=${inventoryExcessRatio.toFixed(2)}）。`,
    });
  }
  // 【SAI-6.4修正】liquidityCoverageState==="shortage"（手元現金バッファ不足）だけでは
  // primary/secondary候補へ入れない。借入余力を含めた資金調達力全体が今回未接続のため、
  // CASH_BUFFER_BELOW_TARGETという中立的なwarningに留める（上記で発火済み）。

  candidates.sort((a, b) => b.score - a.score);
  const primary = candidates[0];
  const secondary = candidates[1];
  if (primary) {
    diagnostics.push({
      code: primary.code,
      domain: "diagnosis",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { score: primary.score },
      decisionSummary: `主要制約: ${primary.category}`,
      message: primary.message,
    });
  }
  if (secondary) {
    diagnostics.push({
      code: secondary.code,
      domain: "diagnosis",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { score: secondary.score },
      decisionSummary: `第2制約: ${secondary.category}`,
      message: secondary.message,
    });
  }

  const diagnosis: StandardAiSituationDiagnosis = {
    salesFulfillmentRatio,
    salesFulfillmentState,
    productionLoadRatio,
    productionLoadState,
    workerLoadRatio,
    workerLoadState,
    rawMaterialCoverageRatio,
    rawMaterialCoverageState,
    rawMaterialProcurementNeeded,
    rawMaterialSupplyConstraintState,
    inventoryExcessRatio,
    inventoryExcessState,
    liquidityCoverageRatio,
    liquidityCoverageState,
    primaryConstraint: primary?.category ?? "none",
    secondaryConstraint: secondary?.category ?? "none",
    currentPeriodDeliveryDemandByProduct: deliveryDemand.byProduct,
    deliveryDemandSource: deliveryDemand.source,
    productionCapacityHeadroom,
    workerHeadroom,
    basicCurrentPeriodProductionRequirementByProduct: basicRequirementByProduct,
    requiredRawMaterial,
    requiredWorker,
    capacityRecognitionGap,
  };

  return { diagnosis, diagnostics };
}
