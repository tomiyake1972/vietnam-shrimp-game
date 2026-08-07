// ShrimpX V2 — Phase SAI-1.5: 5社の初期条件比較表
//
// fixtures.ts・finance/initialState.ts・initialContracts.tsが既に持っている値を
// そのまま読み取って一覧化するだけ（新しい初期値をここで作らない・重複定義しない）。

import { PeriodV2 } from "../../../core/period";
import { unwrapUnit } from "../../../core/units";
import { CompanyId } from "../../../sales/types";
import { buildCompanyFixtures } from "../../fixtures";
import { INITIAL_FINANCE_FIXTURES_V1, buildInitialCompanyFinanceState } from "../../../finance/initialState";
import { unwrapUsd } from "../../../finance/types";
import { generateInitialContracts } from "../../initialContracts";
import { InitialConditionRow } from "./types";

const COMPANY_IDS: readonly CompanyId[] = ["BAL", "MASS", "JPQ", "VAP", "CONSV"];

export function buildInitialConditionRows(startPeriod: PeriodV2): InitialConditionRow[] {
  const fixtures = buildCompanyFixtures(startPeriod);
  const fixtureById = new Map(fixtures.map((f) => [f.companyId, f]));
  const financeById = new Map(COMPANY_IDS.map((id) => [id, INITIAL_FINANCE_FIXTURES_V1.find((f) => f.companyId === id)!]));
  const financeStateById = new Map(
    fixtures.map((f) => [f.companyId, buildInitialCompanyFinanceState(f.companyId, f.initialRawMaterialLots, startPeriod)])
  );
  const contracts = generateInitialContracts(startPeriod);

  const row = (attribute: string, unit: string, note: string, fn: (id: CompanyId) => number | string): InitialConditionRow => ({
    attribute,
    unit,
    note,
    valueByCompany: Object.fromEntries(COMPANY_IDS.map((id) => [id, fn(id)])) as Record<CompanyId, number | string>,
  });

  const contractTonsByCompany = (id: CompanyId) => contracts.filter((c) => c.companyId === id).reduce((s, c) => s + unwrapUnit(c.originalQuantity), 0);
  const contractValueByCompany = (id: CompanyId) =>
    contracts.filter((c) => c.companyId === id).reduce((s, c) => s + unwrapUnit(c.originalQuantity) * unwrapUnit(c.unitPrice) * 1000, 0);

  const rows: InitialConditionRow[] = [
    row("初期現金", "Usd", "現金圧力(cashPressure)の起点。低いほど初期からCASH_BUFFER_SHORTAGEが出やすい。", (id) => financeById.get(id)!.cash),
    row(
      "初期売掛金",
      "Usd",
      "Q1のキャッシュインフローの大きさに影響（財務会計上の残高であり、AI判断への直接入力ではない）。",
      (id) => financeById.get(id)!.initialAccountsReceivable
    ),
    row("初期買掛金", "Usd", "全社ゲーム開始前の取引履歴なしのため一律0（finance/initialState.tsの構造的制約）。", () => 0),
    row(
      "初期短期借入金",
      "Usd",
      "borrowingPressureの起点。既存借入が多い会社ほど新規借入余地・DEBT_REPAYMENT_SURPLUSの発生タイミングに影響。",
      (id) => financeById.get(id)!.shortTermLoans
    ),
    row("初期長期借入金", "Usd", "同上（借入圧力の起点）。", (id) => financeById.get(id)!.longTermLoans),
    row(
      "初期純資産（derived）",
      "Usd",
      "資産=負債+純資産の残差として算出。covenant（自己資本比率等）判定の起点。",
      (id) => {
        const fs = financeStateById.get(id)!;
        return unwrapUsd(fs.capitalStock) + unwrapUsd(fs.retainedEarnings);
      }
    ),
    row(
      "初期原料在庫（数量）",
      "HosoEqTons",
      "rawMaterialInventoryPosition・原料在庫圧力の起点。多いほど初期数四半期のRAW_MATERIAL_SHORTAGEが出にくい。",
      (id) => fixtureById.get(id)!.initialRawMaterialLots.reduce((s, l) => s + unwrapUnit(l.remainingQuantity), 0)
    ),
    row("初期完成品在庫", "HosoEqTons", "全社ゲーム開始前の生産実績なしのため一律0（finance/initialState.tsの構造的制約）。", () => 0),
    row("初期未履行契約（数量合計）", "HosoEqTons", "contractFulfillmentPressureの起点。多いほど初期からCONTRACT_FULFILLMENT_PRIORITYが強く働く。", contractTonsByCompany),
    row("初期未履行契約（想定売上）", "Usd", "初期の履行圧力の金額換算（参考値）。", contractValueByCompany),
    row(
      "初期正社員数",
      "Count",
      "労働能力圧力(WORKER_CAPACITY_SHORTAGE)の起点。工場能力に対し少ないほど残業・臨時ワーカー・採用が早期に発生。",
      (id) => fixtureById.get(id)!.workerBaseline.reduce((s, w) => s + w.regularHeadcount, 0)
    ),
    row("HOSO加工能力", "HosoEqTons/四半期", "生産・原料需要の上限。equipmentUtilizationLastQuarter・CAPACITY_CONSTRAINTに影響。", (id) =>
      fixtureById.get(id)!.factories.reduce((s, f) => s + unwrapUnit(f.hosoCapacity), 0)
    ),
    row("PD加工能力", "HosoEqTons/四半期", "同上（PD特化会社ほど大きい）。", (id) => fixtureById.get(id)!.factories.reduce((s, f) => s + unwrapUnit(f.pdCapacity), 0)),
    row("VAP加工能力", "HosoEqTons/四半期", "同上（VAP特化会社ほど大きい）。", (id) => fixtureById.get(id)!.factories.reduce((s, f) => s + unwrapUnit(f.vapCapacity), 0)),
    row(
      "共通加工能力（commonProcessing）",
      "HosoEqTons/四半期",
      "HOSO/PD/VAPに共通の前段階能力。これが商品別能力より小さい会社では、商品別能力だけを見た判断が過大評価になり得る（AI側の潜在的な見落とし候補）。",
      (id) => fixtureById.get(id)!.factories.reduce((s, f) => s + unwrapUnit(f.commonProcessingCapacity), 0)
    ),
    row("養殖能力", "HosoEqTons/四半期", "自社養殖による調達余地。procurement.tsのaquaculture上限計算の起点。", (id) => unwrapUnit(fixtureById.get(id)!.aquacultureCapacity)),
    row("営業人員数", "Count", "salesForceHeadcountTotal。販売計画のカバレッジ上限（sales.tsのbudget検証対象）。", (id) => fixtureById.get(id)!.salesForceHeadcountTotal),
    row("調達人員数", "Count", "procurementHeadcountTotal。固定費（SG&A給与）にのみ影響、AI調達量そのものは制約しない。", (id) => fixtureById.get(id)!.procurementHeadcountTotal),
    row(
      "固定資産（取得原価）",
      "Usd",
      "会社規模の代理指標。減価償却費・目標最低現金バッファ推定（estimateQuarterlyScaleUsd）には直接使っていない点に注意（能力ベースで別途推定）。",
      (id) => financeById.get(id)!.fixedAssetsGross
    ),
    row(
      "品質スコア（初期・全社共通）",
      "Score0to100",
      "全社×全商品で85（quality/parameters.ts）と統一。会社間の初期競争力差は品質からは生じない。",
      () => 85
    ),
    row(
      "顧客信頼・納期信頼性（初期・全社共通）",
      "Score0to100",
      "全社×全市場で50（中立値、quality/parameters.ts）と統一。会社間の初期競争力差はここからも生じない。",
      () => 50
    ),
  ];
  return rows;
}
