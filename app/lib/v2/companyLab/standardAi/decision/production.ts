// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 生産ドメイン
// 【SAI-6.4改訂】生産計画の営業側inputを、工場能力起点の理論希望量
// （desiredByProduct）から、Standard AI内部の当期納品需要
// （currentPeriodDeliveryDemand、SAI-6.3）を起点とした「基本当期生産必要量」
// （diagnosis/productionRequirement.tsの共通実装、policy.ts側で算出）へ切り替える。
//
// 【基本方針（改訂）】
//   - 生産必要量 = 基本当期生産必要量（＝当期納品需要＋通常安全在庫目標－期首完成品
//     在庫。呼び出し側のpolicy.tsで算出済み）。当期納品需要は既にrealisticSales
//     ByProduct（現実的販売可能量）＋outstandingContractByProduct（既存契約）を
//     含んでいるため、ここで未履行契約残・完成品在庫を再度加算・減算しない
//     （二重計上防止。実装指示C-2）。
//   - 優先順位: 未履行契約がある商品を最優先、次に在庫が目標を下回る商品、
//     残りは通常優先度（全社共通の規則。会社IDによる分岐はしない）。
//     ※優先順位付けのためだけにbacklog（未履行契約残）・在庫超過比率は参照するが、
//       生産必要量そのものの計算には使わない。
//   - 各工場の商品別能力でキャップし、複数工場保有時は能力比で按分する。

import { hosoEqTons, unwrapUnit } from "../../../core/units";
import { CompanyProductionPlanEntry } from "../../../production/types";
import { CompanyFixture } from "../../types";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation, sumProductAmount, zeroProductAmount } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

const EPSILON = 1e-6;

export interface ProductionPlanResult {
  readonly productionPlans: readonly CompanyProductionPlanEntry[];
  readonly neededByProduct: ProductAmount;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

/**
 * @param finalProductionRequirementByProduct SAI-6.4：policy.tsが
 *   diagnosis/productionRequirement.tsの共通実装で算出した、商品別の
 *   最終生産必要量（基本当期生産必要量＋戦略先行生産調整。今回は戦略先行生産は常に0）。
 *   当期納品需要（既存契約分を含む）・通常在庫目標・期首完成品在庫は、この値の
 *   計算時点で既に反映済みであり、本関数の内部では再加算・再減算しない。
 */
/**
 * 【SAI-T1】当期に現実に確保できる原料量（HOSO換算トン）の上限を返す。
 *
 * = 手元で使える原料 ＋ 当期到着が確定している輸入 ＋ 当期の資金で買い増せる量
 *
 * 【資金の定義】当期に支払いへ充当できるのは現金だけではないため、既存の観測値
 * receivablesDueThisPeriodUsd（当期決済予定の売掛金＝当期の確定入金）を加え、
 * payablesDueThisPeriodUsd（当期決済予定の買掛金＝先に出ていく確定支出）を
 * 差し引いた正味の流動資源を使う。現金残高だけを見ると、入出金のタイミングだけで
 * 計画上限が四半期ごとに大きく振れ、健全な会社の生産計画まで振り子状に
 * 揺らしてしまう（実測で確認した）。
 *
 * 「市場にどれだけ供給があるか」「自社がどれだけ配分されるか」は仮定しない
 * （観測に無い値を捏造しないため、その分はここでは制約せず、実際の配分結果に
 * 委ねる）。したがってこれは真の調達可能量の **上限側の見積り** であり、
 * 資金的に無理のない範囲の計画を不必要に縮めることはない。
 *
 * 参照価格が観測できない（turn1等）場合はundefinedを返し、従来どおり無制約とする。
 */
function computeRawMaterialFeasibilityCeiling(observation: StandardAiObservation): number | undefined {
  const referencePriceUsdPerKg = observation.vietnamDomesticPriorPrice;
  if (referencePriceUsdPerKg === undefined || referencePriceUsdPerKg <= EPSILON) return undefined;
  const onHand = observation.rawMaterialAvailable + observation.rawMaterialCertainInboundThisPeriod;
  // 正味の流動資源。債務超過等でマイナスなら買い増せる量は0。
  const usableFunds = Math.max(
    0,
    observation.cashUsd + observation.receivablesDueThisPeriodUsd - observation.payablesDueThisPeriodUsd
  );
  const affordableTons = usableFunds / (referencePriceUsdPerKg * 1000);
  return onHand + affordableTons;
}

export function buildStandardAiProductionPlans(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  finalProductionRequirementByProduct: ProductAmount
): ProductionPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const backlog = observation.outstandingContractByProduct;
  const fg = observation.finishedGoodsByProduct;
  const capacityTotals = observation.totalCapacityByProduct;

  // 【SAI-6.4】neededByProductは、もはや「desiredByProduct+backlog-fg」を計算しない。
  // 呼び出し側（policy.ts）がcurrentPeriodDeliveryDemand起点で算出した値をそのまま使う
  // （二重計上防止。実装指示C-2）。優先順位付け・診断メッセージのためにbacklog・fgは
  // 引き続き参照するが、量そのものには影響させない。
  // 【SAI-T1（Training Harness Cycle 1）】原料調達可能性による生産計画の上限。
  //
  // 【対象欠陥】従来、生産計画は設備能力と販売需要だけで決まり、「その原料を実際に
  // 入手できるか」を一切考慮していなかった。Training Harness baseline（32Q×10seed）
  // では、現金が枯渇したMASSが原料在庫0のまま29,070トンの生産計画を立て続け、
  // その架空の計画から逆算した必要人員（>2,100人）を根拠にworker_shortageと自己診断し、
  // 常用2,100人・臨時735人を20四半期にわたり保持したまま生産量0を続けた
  // （四半期あたり210万USDの遊休労務費が資金枯渇をさらに悪化させる正のフィードバック）。
  // 生産計画が実行不能であることが、労働・調達・販売の全ての下流判断を汚染していた。
  //
  // 【観測境界】使うのは既存の観測値のみ（新しい情報源・ゲームルールは追加しない）:
  //   - rawMaterialAvailable / rawMaterialCertainInboundThisPeriod（当期確実に使える原料）
  //   - cashUsd（当期の支払能力）と vietnamDomesticPriorPrice（前期の公開参照価格）
  // 「買えない原料は生産計画に載せない」という当然の制約であり、市場の供給量・
  // 買付ルール・シェア上限には一切触れていない。
  const feasibility = computeRawMaterialFeasibilityCeiling(observation);
  const requestedTotal = sumProductAmount(finalProductionRequirementByProduct);
  let neededByProduct: ProductAmount = finalProductionRequirementByProduct;
  if (feasibility !== undefined && requestedTotal > feasibility + EPSILON) {
    // 商品構成は変えず、比例配分で全体を実行可能な水準まで縮める
    // （どの商品を削るかという経営判断はここでは行わない）。
    const scale = feasibility / requestedTotal;
    const scaled = zeroProductAmount();
    for (const product of ["hoso", "pd", "vap"] as const) {
      scaled[product] = finalProductionRequirementByProduct[product] * scale;
    }
    neededByProduct = scaled;
    diagnostics.push({
      code: "PRODUCTION_LIMITED_BY_RAW_MATERIAL_FEASIBILITY",
      domain: "production",
      companyId: fixture.companyId,
      severity: "warning",
      keyValues: { requestedTotal, feasibleTotal: feasibility, scale },
      message: `当期に確実に入手・購入できる原料量（${Math.round(feasibility)}トン）を上回る生産計画（${Math.round(
        requestedTotal
      )}トン）は実行できないため、生産計画を実行可能な水準へ縮小する。`,
    });
  }
  for (const product of ["hoso", "pd", "vap"] as const) {
    if (backlog[product] > EPSILON) {
      diagnostics.push({
        code: "CONTRACT_FULFILLMENT_PRIORITY",
        domain: "production",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { outstandingQuantity: backlog[product], plannedQuantity: neededByProduct[product] },
        message: `${product.toUpperCase()}の未履行契約残（${Math.round(backlog[product])}トン）を優先して生産計画に織り込む。`,
      });
    } else if (fg[product] > capacityTotals[product] * 0.001 && pressures.finishedGoodsExcessRatioByProduct[product] > 1) {
      diagnostics.push({
        code: "FINISHED_GOODS_EXCESS",
        domain: "production",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { finishedGoodsInventory: fg[product], excessRatio: pressures.finishedGoodsExcessRatioByProduct[product] },
        message: `${product.toUpperCase()}の完成品在庫が目標を上回るため、生産を抑制する。`,
      });
    }
  }

  // 優先順位: 未履行契約がある商品を最優先(1)、在庫不足(目標未満)の商品を次点(2)、それ以外(3)。
  const priorityByProduct: ProductAmount = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    if (backlog[product] > EPSILON) priorityByProduct[product] = 1;
    else if (pressures.finishedGoodsExcessRatioByProduct[product] < 1) priorityByProduct[product] = 2;
    else priorityByProduct[product] = 3;
  }

  // 【2026-08-02・能力認識監査Phase 3対応】従来はここでfixture.factories（capex加算前の
  // 名目能力）を直接読み、稼働率・設備利用可能率（baseUtilizationRate×
  // equipmentAvailabilityRate＝0.855）を一切適用していなかった（Test14 Turn2で
  // 24,000tが生産可能と誤認識していた根本原因）。observation.factories[].
  // effectiveCapacityByProductは、production/capacity.tsのcalculateFactoryEffectiveCapacity
  // （生産エンジン本体・allocation.tsが実際の生産制約として使うのと同じ純粋関数）を
  // 適用済みの実効能力であり、これをそのまま使う（新しい能力算出ロジックは増設しない）。
  const plans: CompanyProductionPlanEntry[] = [];
  let anyCapacityConstraint = false;
  for (const factoryObs of observation.factories) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      const capacity = factoryObs.effectiveCapacityByProduct[product];
      if (capacity <= EPSILON || neededByProduct[product] <= EPSILON) continue;
      // 【重要】シェア（share）自体は名目capacityByProduct（=能力の相対比。
      // observation.factories[].capacityByProduct、capex加算後の名目値）で按分する。
      // 各工場の実効能力比は名目能力比と（全工場が同じbaseUtilizationRate・
      // equipmentAvailabilityRateを持つ限り）同一であるため、名目比で按分しても
      // 実効capacityでキャップする限り結果は変わらない。既存の按分方式は変更しない
      // （実装指示Phase 3「新しいロジックを作らない」）。
      const share = capacityTotals[product] > EPSILON ? factoryObs.capacityByProduct[product] / capacityTotals[product] : 0;
      const desired = Math.min(capacity, neededByProduct[product] * share);
      if (desired <= EPSILON) continue;
      if (neededByProduct[product] * share > capacity + EPSILON) anyCapacityConstraint = true;
      plans.push({
        companyId: fixture.companyId,
        factoryId: factoryObs.factoryId,
        product,
        desiredQuantity: hosoEqTons(Math.round(desired * 100) / 100),
        priority: priorityByProduct[product],
      });
    }
  }

  // 【2026-08-02・能力認識監査Phase 3対応】共通前処理（commonProcessing）・凍結包装
  // （freezingPackaging）は、HOSO/PD/VAP商品別能力とは別に、3商品合計へ効く共有の
  // ボトルネックである（production/allocation.tsの段階3〜4が実際に使う制約と同じ
  // 意味）。エンジン本体の水配分（water-filling）アルゴリズムをここで複製する
  // （新しい配分ロジックを作る）のではなく、既に商品別能力でキャップ済みの計画合計が
  // 共有ボトルネックを超える場合にだけ、全商品を同一比率で単純に縮小する保守的な
  // 安全弁として実装する（実際の配分順序・優先度による精緻な配分はエンジン本体
  // （allocation.ts）が別途行う。ここでの目的は「Standard AIが共有ボトルネックを
  // 超える生産量を『実行可能』として意思決定・原価計算・説明に使ってしまうこと」を
  // 防ぐことに限定する）。
  const totalDesired = sumProductAmount(
    plans.reduce(
      (acc, p) => {
        acc[p.product] += unwrapUnit(p.desiredQuantity);
        return acc;
      },
      zeroProductAmount()
    )
  );
  const sharedCaps: { readonly label: string; readonly cap: number }[] = [
    { label: "共通前処理", cap: observation.totalEffectiveCommonProcessingCapacity },
    { label: "凍結・包装", cap: observation.totalEffectiveFreezingPackagingCapacity },
  ];
  let scaleFactor = 1;
  const bindingCaps: string[] = [];
  for (const { label, cap } of sharedCaps) {
    if (cap > EPSILON && totalDesired * scaleFactor > cap + EPSILON) {
      scaleFactor = Math.min(scaleFactor, cap / totalDesired);
      bindingCaps.push(label);
    }
  }
  let finalPlans = plans;
  if (scaleFactor < 1) {
    finalPlans = plans.map((p) => ({
      ...p,
      desiredQuantity: hosoEqTons(Math.round(unwrapUnit(p.desiredQuantity) * scaleFactor * 100) / 100),
    }));
    anyCapacityConstraint = true;
    diagnostics.push({
      code: "SHARED_CAPACITY_CONSTRAINT",
      domain: "production",
      companyId: fixture.companyId,
      severity: "warning",
      keyValues: { totalDesired, scaleFactor },
      message:
        `商品別実効能力の合計だけでは足りず、共有ボトルネック（${bindingCaps.join(
          "/"
        )}）の実効能力がさらに強い制約となるため、生産計画全体を比率${scaleFactor.toFixed(
          3
        )}で縮小した（簡易な保守的キャップ。工場・優先度別の精緻な配分は生産エンジン本体が別途行う）。`,
    });
  }

  if (anyCapacityConstraint) {
    diagnostics.push({
      code: "CAPACITY_CONSTRAINT",
      domain: "production",
      companyId: fixture.companyId,
      severity: "warning",
      message: "設備能力（実効能力・共有ボトルネック含む）が必要生産量を下回るため、当期の生産計画は能力上限でキャップされる。",
    });
  }

  return { productionPlans: finalPlans, neededByProduct, diagnostics };
}
