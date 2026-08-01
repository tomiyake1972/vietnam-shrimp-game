// ShrimpX V2 — 商品戦略プロファイル capex overlay（companyLab検証専用・2026-08-01新規）
//
// 【既知のギャップへの対応】標準AIのdecision/capex.ts（buildStandardAiCapexDecision）は
// HOSO/PD/VAPライン増設・共通前処理能力増設の4種類しか提案しない（実装指示の
// スコープ判断、decision/capex.ts冒頭コメント参照）。pdMechanization（PD専用
// 機械化投資）・qualityControlEquipment（品質管理設備）は一切提案しない。
//
// 【本ファイルの責務】decision/*.ts・policy.tsは一切変更せず（変更禁止）、標準AIが
// 提出したCompanyDecisionInputを「意思決定生成の直後」で受け取り、会社の商品戦略
// プロファイル（standardAi/strategyProfile.ts）がpdMechanization/
// qualityControlEquipmentを必要とする場合にのみ、追加のcapex提案を末尾へ足す
// 別枠のオーバーレイとして実装する。呼び出し元は
// standardAi/autoplay/runCase.ts（strategyProfilesEnabled有効時のみ）。
//
// 【トリガー条件】decision/capex.tsの既存のライン増設トリガーが使う信号（現金/
// 借入健全性・対象商品の完成品在庫が過剰でない）をそのまま鏡写しする。新しい・
// 無関係なトリガーは発明しない。将来情報・他社の非公開情報は一切参照しない
// （fixture・ownState・publicInfo・period・turnという既存4引数+turnのみを使う、
// buildStandardAiObservation/computePressureScoresと同じ情報境界）。
//
// 【2026-08-01追記・キャリブレーション実測に基づく訂正】当初は「前期設備稼働率が
// capexSustainedUtilizationThreshold(0.92)以上」という、decision/capex.tsの
// 会社全体集計（equipmentUtilizationLastQuarter）をそのまま流用していたが、
// 4環境×6seed×32Qの実測の結果、標準初期条件（moderate-pressure候補）では
// 会社全体の設備稼働率が32Q・全環境・全会社を通じて0.50を超えることがほぼ無く
// （実測平均0.38〜0.49、しきい値0.92には遠く及ばない）、この条件が常にfalseで
// 固定され、pdMechanization/qualityControlEquipmentのどちらも一度も提案されない
// （cumulativeCapexPaidUsdが全120ケースで0）という「常時不発」のバグ状態に
// なっていたことが判明した。加えて、decision/capex.tsの実際のライン増設判断は
// 会社全体の稼働率（sustained）と対象商品固有の需要不足（shortfallRatio、商品別の
// 必要量／商品別能力）の両方を要求しており、後者（商品固有の逼迫度）を本ファイルは
// 一切鏡写ししていなかった。そこで、会社全体集計のequipmentUtilizationLastQuarter
// ではなく、対象商品固有の前期稼働率（前期実績生産量／商品別総能力、observation
// が既に保持する既存フィールドのみで算出可能）を「持続的稼働」の判定材料として
// 使うよう訂正する（新しい情報源は増やさない。observation.totalCapacityByProduct・
// observation.lastQuarterActualProductionByProductという既存2フィールドの比を
// 取るだけ）。しきい値OVERLAY_PRODUCT_UTILIZATION_THRESHOLDは、上記実測分布
// （平均0.35〜0.40、最大0.76）から、平均的な四半期では満たされず、需要が伸びた
// 四半期・環境でのみ間欠的に満たされる水準として0.50を採用した
// （decision/capex.ts側のcapexSustainedUtilizationThreshold=0.92は一切変更しない。
// 本ファイル内だけで使う、対象商品限定の別しきい値として新設する）。
//
// 【二重投資の防止】同一会社が既にpdMechanization/qualityControlEquipment案件を
// 保有している場合（cancelled以外の任意のstatus）は、追加提案しない
// （decision/capex.tsのalreadyPlanned判定と同じ意図。ただしこの2種別は
// FutureCapacityEffectPlaceholder.targetProductを持たないため
// observation.activeCapexProjectTargetsでは追跡できず、ownState.capexState.portfolio
// を直接参照する）。

import { CompanyDecisionInput, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "./types";
import { PeriodV2 } from "../core/period";
import { CapexProjectProposalInput, CapitalProjectType } from "../capex/types";
import { buildStandardAiObservation } from "./standardAi/observation";
import { computePressureScores, PressureScores } from "./standardAi/pressures";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "./standardAi/parameters";
import { StandardAiObservation } from "./standardAi/types";
import { resolveStrategyProfile, StrategyProfile } from "./standardAi/strategyProfile";

const EPSILON = 1e-6;

/**
 * 【2026-08-01追記】対象商品固有の「持続的稼働」しきい値。
 * decision/capex.tsのcapexSustainedUtilizationThreshold(0.92、会社全体集計向け)
 * とは別物で、本ファイルのpdMechanization/qualityControlEquipmentトリガーのみで
 * 使う。実測（4環境×6seed×32Q、moderate-pressure候補）の対象商品別稼働率
 * （前期実績生産量／商品別総能力）の分布（平均0.35〜0.40、最大0.76）に基づき、
 * 平均的な四半期では満たさず、需要が伸びた四半期・環境でのみ間欠的に満たされる
 * 水準として選定した。
 */
const OVERLAY_PRODUCT_UTILIZATION_THRESHOLD = 0.5;

function cashAndBorrowingSafe(observation: StandardAiObservation, pressures: PressureScores, params: StandardAiParameters): boolean {
  return observation.cashUsd > pressures.targetMinimumCashUsd * params.capexCashSafetyMultiple && pressures.borrowingPressure < 1;
}

/**
 * 対象商品固有の「前期、持続的に稼働していたか」を、observationが既に保持する
 * 既存2フィールド（商品別総能力・前期実績生産量）の比だけから判定する
 * （新規の情報源を増やさない）。前期実績が無い（turn1等）場合はfalse
 * （decision/capex.tsのhadPriorQuarterUtilizationと同じ「未知なら見送り」規約）。
 */
function productSustained(observation: StandardAiObservation, product: "pd" | "vap"): boolean {
  const capacity = observation.totalCapacityByProduct[product];
  if (!(capacity > EPSILON)) return false;
  const lastQuarterProduced = observation.lastQuarterActualProductionByProduct[product];
  if (lastQuarterProduced === undefined) return false;
  const utilization = lastQuarterProduced / capacity;
  return utilization >= OVERLAY_PRODUCT_UTILIZATION_THRESHOLD;
}

/**
 * 商品戦略プロファイルが要求するcapex追加提案一覧を組み立てる（純粋関数・決定論的）。
 * プロファイルがpdMechanization/qualityControlEquipmentのいずれも要求しない場合、
 * またはトリガー条件を満たさない場合は空配列を返す。
 *
 * 【二重投資の防止】activeProjectTypesは、同一会社が既に保有している（cancelled
 * 以外の任意のstatusの）案件種別の集合。呼び出し元（applyStrategyProfileCapexOverlay）
 * がownState.capexState.portfolio.projectsから構築する。
 */
export function buildStrategyProfileCapexOverlayProposals(
  profile: StrategyProfile,
  observation: StandardAiObservation,
  pressures: PressureScores,
  activeProjectTypes: ReadonlySet<CapitalProjectType>,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): readonly CapexProjectProposalInput[] {
  if (!profile.capexOverlay.pdMechanization && !profile.capexOverlay.qualityControlEquipment) return [];

  const safe = cashAndBorrowingSafe(observation, pressures, params);

  const proposals: CapexProjectProposalInput[] = [];

  if (profile.capexOverlay.pdMechanization) {
    const pdCapacity = observation.totalCapacityByProduct.pd;
    const noExcess =
      pdCapacity <= EPSILON ||
      observation.finishedGoodsByProduct.pd <= pdCapacity * params.finishedGoodsTargetQuarters * params.excessInventoryRatioForDiscount;
    // 【2026-08-01訂正】会社全体集計のsustained（前述のとおり実測上ほぼ常にfalse）
    // ではなく、PD固有のproductSustainedを使う。
    if (pdCapacity > EPSILON && productSustained(observation, "pd") && noExcess && safe && !activeProjectTypes.has("pdMechanization")) {
      proposals.push({ projectType: "pdMechanization" });
    }
  }

  if (profile.capexOverlay.qualityControlEquipment) {
    const vapCapacity = observation.totalCapacityByProduct.vap;
    const noExcess =
      vapCapacity <= EPSILON ||
      observation.finishedGoodsByProduct.vap <= vapCapacity * params.finishedGoodsTargetQuarters * params.excessInventoryRatioForDiscount;
    // 【2026-08-01訂正】会社全体集計のsustainedではなく、VAP固有のproductSustainedを使う。
    if (vapCapacity > EPSILON && productSustained(observation, "vap") && noExcess && safe && !activeProjectTypes.has("qualityControlEquipment")) {
      proposals.push({ projectType: "qualityControlEquipment" });
    }
  }

  return proposals;
}

/**
 * 標準AIが提出したCompanyDecisionInputへ、商品戦略プロファイルのcapex追加提案を
 * 合成する（既存のnewProjectProposalsは一切変更せず、末尾へ追加するだけ）。
 * decision/*.ts・policy.tsは一切呼び出さない・変更しない。fixture・ownState・
 * publicInfo・period・turnという既存4引数+turn以外の情報源には一切アクセスしない
 * （buildStandardAiObservationと同じ情報境界）。
 */
export function applyStrategyProfileCapexOverlay(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number,
  decision: CompanyDecisionInput
): CompanyDecisionInput {
  const profile = resolveStrategyProfile(fixture.companyId);
  if (!profile.capexOverlay.pdMechanization && !profile.capexOverlay.qualityControlEquipment) return decision;

  const params = STANDARD_AI_PARAMETERS_V1;
  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, period, turn);
  const pressures = computePressureScores(observation, fixture, params);
  const activeProjectTypes = new Set<CapitalProjectType>(
    ownState.capexState.portfolio.projects.filter((p) => p.status !== "cancelled").map((p) => p.projectType)
  );

  const overlayProposals = buildStrategyProfileCapexOverlayProposals(profile, observation, pressures, activeProjectTypes, params);
  if (overlayProposals.length === 0) return decision;
  return {
    ...decision,
    capexDecision: {
      ...decision.capexDecision,
      newProjectProposals: [...decision.capexDecision.newProjectProposals, ...overlayProposals],
    },
  };
}
