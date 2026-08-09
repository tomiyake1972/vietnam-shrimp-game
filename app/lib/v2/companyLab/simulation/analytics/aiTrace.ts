// ShrimpX V2 — 32Q Management Console Phase 2: Standard AI 思考トレース（6段階）
//
// 【新しい巨大な logging system を作らない】
// Standard AI は既に generateStandardAiDecisionWithDiagnostics の中で
// observation / pressures / situationDiagnosis / salesWish / decision を計算している。
// このモジュールは **その値を段階ごとに詰め替えるだけ** であり、
// 新たな推論・要約・生成AI呼び出しは一切行わない。
//
// 【捏造しない】診断に存在しない項目は null のままにする。
// StandardAiSituationDiagnosis の各 *Ratio は算出不能時に NaN を保持する規約のため、
// 必ず対応する *State（"unknown"）で判定してから表示する（NaN を直接出さない）。

import { CompanyQuarterRecord } from "../../types";
import { DemandMarketId, Product } from "../../../market/types";
import { unwrapUnit } from "../../../core/units";
import type { StandardAiQuarterDiagnostics } from "../../standardAi/policy";
import { AI_TRACE_STAGES, AiTraceFact, AiTraceItem, AiTraceStage } from "./types";

/**
 * 1ターン・1社ぶんの「Standard AI が実際に持っていた値」。
 * 巨大な diagnostics をそのまま保存すると 32Q×5社で保存量が膨らむため、
 * トレース表示に使う項目だけを実行時に抜き出して保持する。
 */
export interface SimulationAiTurnTrace {
  readonly turn: number;
  readonly companyId: string;
  /** ① 何を見たか。 */
  readonly observed: readonly AiTraceItem[];
  /** ② どう診断したか。 */
  readonly diagnosed: readonly AiTraceItem[];
  /** ③ 何をしたかったか。 */
  readonly wanted: readonly AiTraceItem[];
  /** ④ 何に阻まれたか。 */
  readonly constrained: readonly AiTraceItem[];
  /** ⑤ 何を決めたか。 */
  readonly decided: readonly AiTraceItem[];
  /** 販売トレース用の「営業工数制約前の希望量」。 */
  readonly salesWish: readonly {
    readonly market: DemandMarketId;
    readonly product: Product;
    readonly desiredQuantityBeforeEffortConstraint: number;
  }[];
}

/** 値・単位・補足のうち、実際にあるものだけをキーとして持つ（保存量を膨らませない）。 */
function item(label: string, value: number | null, unit?: string, text?: string | null): AiTraceItem {
  const out: { label: string; value?: number; unit?: string; text?: string } = { label };
  if (value !== null && Number.isFinite(value)) out.value = value;
  if (unit !== undefined) out.unit = unit;
  if (text !== undefined && text !== null) out.text = text;
  return out;
}

function textItem(label: string, text: string): AiTraceItem {
  return { label, text };
}

/** *Ratio は *State が "unknown" のとき数値を出さない（NaN を出さない）。 */
function ratioItem(label: string, ratio: number, state: string): AiTraceItem {
  if (state === "unknown" || !Number.isFinite(ratio)) return { label, unit: "ratio", text: state };
  return { label, value: ratio, unit: "ratio", text: state };
}

/**
 * 理由コードのうち、人間向けメッセージまで保存する件数の上限。
 *
 * 【コードそのものは絶対に落とさない】上限を超えた分も
 * 「[severity] code」という項目として必ず残し、長いメッセージだけを省略する。
 * 投資を見送った理由（CAPEX_DEFERRED 等）が末尾に並ぶことがあり、
 * 件数で切り捨てると「なぜ投資しなかったか」が追えなくなるため。
 */
const MAX_REASON_MESSAGES_PER_STAGE = 12;

const OMITTED_MESSAGE_TEXT = "（メッセージは保存量の上限により省略。コードと severity は保持している）";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function sumProducts(byProduct: Readonly<Record<string, number>> | undefined): number | null {
  if (!byProduct) return null;
  let total = 0;
  for (const p of PRODUCTS) total += Number(byProduct[p] ?? 0);
  return Number.isFinite(total) ? total : null;
}

/**
 * Standard AI の診断から、表示に使う項目だけを抜き出す。
 * シミュレーション実行の各ターンで呼ばれる（実行後に diagnostics を保持しない）。
 */
export function extractAiTurnTrace(diagnostics: StandardAiQuarterDiagnostics): SimulationAiTurnTrace {
  const p = diagnostics.pressures;
  const d = diagnostics.situationDiagnosis;
  const decision = diagnostics.decision;

  // --- ① OBSERVED: 意思決定の前に AI が持っていた観測値 ---
  const observed: AiTraceItem[] = [
    item("前期の設備稼働率", p.equipmentUtilizationLastQuarter, "ratio", p.hadPriorQuarterUtilization ? null : "前期実績なし（中立値0.7）"),
    item("前期の労働稼働率", p.laborUtilizationLastQuarter, "ratio"),
    item("想定原料価格", p.expectedRawPriceUsdPerKg, "USD/kg"),
    item("最低現金バッファ目標", p.targetMinimumCashUsd, "USD"),
    textItem("価格の高い市場順", p.marketPriceRanking.join(" > ")),
  ];

  // --- ② DIAGNOSED: 診断（Situation Diagnosis と圧力スコア） ---
  const diagnosed: AiTraceItem[] = [
    item("契約履行圧力", p.contractFulfillmentPressure, "0-1"),
    item("現金圧力", p.cashPressure, "0-1"),
    item("借入圧力", p.borrowingPressure, "0-1"),
    item("原料在庫ポジション", p.rawMaterialInventoryPosition, "四半期"),
  ];
  if (d) {
    diagnosed.push(
      textItem("主要制約", d.primaryConstraint),
      textItem("第2の制約", d.secondaryConstraint),
      ratioItem("販売充足率", d.salesFulfillmentRatio, d.salesFulfillmentState),
      ratioItem("生産負荷率", d.productionLoadRatio, d.productionLoadState),
      ratioItem("Worker負荷率", d.workerLoadRatio, d.workerLoadState),
      ratioItem("原料充足率", d.rawMaterialCoverageRatio, d.rawMaterialCoverageState),
      ratioItem("在庫過多率", d.inventoryExcessRatio, d.inventoryExcessState),
      ratioItem("流動性充足率", d.liquidityCoverageRatio, d.liquidityCoverageState)
    );
  }

  // --- ③ WANTED: 制約適用前の希望 ---
  const wishTotal = diagnostics.salesWishByMarketProduct.reduce((s, w) => s + w.desiredQuantityBeforeEffortConstraint, 0);
  const wanted: AiTraceItem[] = [
    item("販売希望量（営業工数制約前）", wishTotal, "t"),
  ];
  if (d) {
    wanted.push(
      item("当期の基本生産必要量", sumProducts(d.basicCurrentPeriodProductionRequirementByProduct as unknown as Record<string, number>), "t"),
      item("必要原料量", d.requiredRawMaterial, "t"),
      item("理論必要Worker", d.requiredWorker, "人")
    );
  }
  wanted.push(item("希望借入額", decision.financingRequest?.desiredAmountUsd ?? null, "USD"));
  wanted.push(item("投資提案件数", decision.capexDecision?.newProjectProposals?.length ?? 0, "件"));

  // --- ④ CONSTRAINED: 希望と実提出の差 ---
  const plannedTotal = decision.salesPlans.reduce((s, plan) => s + (Number(unwrapUnit(plan.desiredQuantity as never)) || 0), 0);
  const constrained: AiTraceItem[] = [
    item("販売計画量（提出値）", plannedTotal, "t"),
    item("営業工数制約による縮小量", Number.isFinite(wishTotal - plannedTotal) ? wishTotal - plannedTotal : null, "t"),
  ];
  if (d) {
    constrained.push(
      item("生産能力の余力", d.productionCapacityHeadroom, "t", d.productionCapacityHeadroom < 0 ? "能力不足" : null),
      item("Workerの余力", d.workerHeadroom, "人", d.workerHeadroom < 0 ? "不足" : null)
    );
  }
  // 理由コードは Standard AI が既に付けているものをそのまま並べる（要約しない）。
  // コードは全件残し、上限を超えた分はメッセージだけを省略する。
  diagnostics.entries.forEach((entry, index) => {
    constrained.push(textItem(`[${entry.severity}] ${entry.code}`, index < MAX_REASON_MESSAGES_PER_STAGE ? entry.message : OMITTED_MESSAGE_TEXT));
  });

  // --- ⑤ DECIDED: 実際にゲームへ提出した値 ---
  const productionTotal = decision.productionPlans.reduce((s, plan) => s + (Number(unwrapUnit(plan.desiredQuantity as never)) || 0), 0);
  const decided: AiTraceItem[] = [
    item("販売計画合計", plannedTotal, "t"),
    item("生産計画合計", productionTotal, "t"),
    item("国内買付希望量", Number(unwrapUnit(decision.domesticPurchasePlan?.desiredQuantity as never)) || null, "t"),
    item("輸入発注件数", decision.importOrders.length, "件"),
    item("借入希望額", decision.financingRequest?.desiredAmountUsd ?? null, "USD"),
    item("営業人員 採用", decision.salesForceHireCount ?? 0, "人"),
    item("営業人員 減員", decision.salesForceLayoffCount ?? 0, "人"),
    item("VAP商品開発費", decision.vapProductDevelopmentSpendUsd ?? 0, "USD"),
  ];

  return {
    turn: diagnostics.turn,
    companyId: diagnostics.companyId,
    observed,
    diagnosed,
    wanted,
    constrained,
    decided,
    salesWish: diagnostics.salesWishByMarketProduct.map((w) => ({
      market: w.market,
      product: w.product,
      desiredQuantityBeforeEffortConstraint: w.desiredQuantityBeforeEffortConstraint,
    })),
  };
}

/**
 * ⑥ RESULT は四半期確定後にしか分からないため、確定済み記録から作る。
 * ここでも新しい計算はせず、companySummaries に既にある値を取り出すだけ。
 */
function buildResultItems(record: CompanyQuarterRecord | undefined, companyId: string): readonly AiTraceItem[] {
  if (!record) return [textItem("結果", "この四半期の確定記録がありません")];
  const summary = record.companySummaries.find((s) => s.companyId === companyId);
  const fin = record.financialResults?.find((f) => f.companyId === companyId);
  if (!summary) return [textItem("結果", "この会社の確定記録がありません")];
  const num = (v: unknown) => {
    const x = Number(unwrapUnit(v as never));
    return Number.isFinite(x) ? x : null;
  };
  const items: AiTraceItem[] = [
    item("新規成約量", num(summary.newContractedQuantity), "t"),
    item("納品量", num(summary.fulfilledQuantity), "t"),
    item("HOSO生産", num(summary.hosoProduced), "t"),
    item("PD生産", num(summary.pdProduced), "t"),
    item("VAP生産", num(summary.vapProduced), "t"),
    item("原料不足", num(summary.rawMaterialShortfall), "t"),
    item("設備能力不足", num(summary.equipmentShortfall), "t"),
    item("労働力不足", num(summary.laborShortfall), "t"),
    item("売上高", Number(fin?.profitAndLoss?.netRevenue) || null, "USD"),
    item("営業利益", Number(fin?.profitAndLoss?.operatingProfit) || null, "USD"),
  ];
  // 実績側の理由コードも同じ方針（コードは全件、メッセージだけ上限で省略）。
  summary.reasonCodes.forEach((reason, index) => {
    items.push(textItem(reason.code, index < MAX_REASON_MESSAGES_PER_STAGE ? reason.message : OMITTED_MESSAGE_TEXT));
  });
  return items;
}

/** 6段階すべての行を組み立てる。 */
export function buildAiTraceFacts(
  traces: readonly SimulationAiTurnTrace[],
  history: readonly CompanyQuarterRecord[]
): readonly AiTraceFact[] {
  const recordByTurn = new Map(history.map((r) => [r.turn, r]));
  const facts: AiTraceFact[] = [];
  for (const trace of traces) {
    const byStage: Readonly<Record<AiTraceStage, readonly AiTraceItem[]>> = {
      OBSERVED: trace.observed,
      DIAGNOSED: trace.diagnosed,
      WANTED: trace.wanted,
      CONSTRAINED: trace.constrained,
      DECIDED: trace.decided,
      RESULT: buildResultItems(recordByTurn.get(trace.turn), trace.companyId),
    };
    for (const stage of AI_TRACE_STAGES) {
      facts.push({ turn: trace.turn, companyId: trace.companyId, stage, items: byStage[stage] });
    }
  }
  return facts;
}
