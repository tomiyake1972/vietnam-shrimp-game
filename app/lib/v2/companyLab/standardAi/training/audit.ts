// ShrimpX V2 — Standard AI Training Harness: 経営矛盾の自動検出（Audit Rules）
//
// 【目的】benchmark.ts が記録した decision / result だけを入力として、
// 「経営者として矛盾した意思決定」を機械的に検出する。
//
// 【この層の原則】
//   - Level A（A01〜A14）は「明白な矛盾」だけを扱う。判定に使う閾値は、可能なかぎり
//     ゲーム環境の実測値（市場需要・在庫・能力）との比較で決め、恣意的なhard-coded
//     マジックナンバーを判定の主役にしない。
//   - Level B（経営判断の領域）は「誤り」と断定しない。事実と数値だけを添えて
//     MANAGEMENT_JUDGMENT_REVIEW として提示し、判断は人間へ返す。
//   - ゲーム環境の側に問題があるように見えても、ここで環境を変更しない。
//     ENVIRONMENT_ISSUE_CANDIDATE として分類するだけ。

import { CompanyQuarterRecordRow } from "./benchmark";

export type FindingSeverity = "P0" | "P1" | "P2" | "P3";

export type FindingClassification =
  | "STANDARD_AI_BUG"
  | "STANDARD_AI_DESIGN_WEAKNESS"
  | "ENVIRONMENT_ISSUE_CANDIDATE"
  | "MANAGEMENT_JUDGMENT_REVIEW"
  | "DATA_OR_MEASUREMENT_ISSUE"
  | "FALSE_POSITIVE";

export interface AuditFinding {
  readonly findingId: string;
  readonly severity: FindingSeverity;
  readonly company: string;
  readonly quarter: number;
  readonly seed: string;
  readonly rule: string;
  /** 何が観測されたか（数値つきの事実）。 */
  readonly observation: string;
  /** AIが実際に下した意思決定。 */
  readonly decision: string;
  /** その結果どうなったか。 */
  readonly result: string;
  /** 反実仮想（別の意思決定ならどうなったと考えられるか）。算出できない場合はnull。 */
  readonly counterfactual: string | null;
  readonly suspectedRootCause: string;
  readonly relevantFiles: readonly string[];
  /** 0〜1。検出ルールがこのケースを正しく捉えている確信度。 */
  readonly confidence: number;
  readonly classification: FindingClassification;
}

const EPSILON = 1e-6;

function fid(rule: string, row: CompanyQuarterRecordRow): string {
  return `${rule}:${row.seed}:${row.companyId}:T${row.turn}`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------
// A01: 機会の小さい市場への営業集中
// ---------------------------------------------------------------------

/**
 * A01 SALES_FORCE_CONCENTRATION_WITHOUT_OPPORTUNITY
 *
 * 【判定の考え方】「営業配置比率が50%」そのものを不正としない（指示§7）。
 * 次の2つが同時に成り立つときだけ矛盾とみなす。
 *   (a) ある市場への営業配置比率が、その市場の「現実に取り得る機会」の比率を大きく上回る
 *   (b) 他市場に未充足の機会（希望量を満たせていない、かつ需要が残っている）が存在する
 *
 * 【「現実に取り得る機会」の定義】その市場×商品の対象需要 × 買い占め防止シェア上限
 * （ゲーム環境が定める maximumSupplierShare）。1社が制度上取り得る最大量であり、
 * ここで新しい経済モデルを発明していない。
 */
function auditA01(row: CompanyQuarterRecordRow, maximumSupplierShare: number): AuditFinding[] {
  const totalHeadcount = row.decision.salesForceTotalAssigned;
  if (totalHeadcount <= 0) return [];

  const opportunityByMarket = new Map<string, number>();
  const allocatedByMarket = new Map<string, number>();
  const desiredByMarket = new Map<string, number>();
  for (const a of row.result.allocationsByMarketProduct) {
    opportunityByMarket.set(a.market, (opportunityByMarket.get(a.market) ?? 0) + a.targetDemand * maximumSupplierShare);
    allocatedByMarket.set(a.market, (allocatedByMarket.get(a.market) ?? 0) + a.allocatedQuantity);
    desiredByMarket.set(a.market, (desiredByMarket.get(a.market) ?? 0) + a.desiredQuantity);
  }
  const totalOpportunity = [...opportunityByMarket.values()].reduce((s, v) => s + v, 0);
  if (totalOpportunity <= EPSILON) return [];

  const findings: AuditFinding[] = [];
  for (const [market, headcount] of Object.entries(row.decision.salesHeadcountByMarket)) {
    const headcountShare = headcount / totalHeadcount;
    const opportunityShare = (opportunityByMarket.get(market) ?? 0) / totalOpportunity;
    // 配置比率が機会比率の2倍以上、かつ配置比率が30%以上のときだけ候補にする
    // （小さな市場に1〜2人置いただけで大量に検出されるのを防ぐ）。
    if (headcountShare < 0.3 || opportunityShare <= EPSILON || headcountShare < opportunityShare * 2) continue;

    // (b) 他市場に未充足の機会があるか（希望量が機会に届いていない市場が存在するか）。
    const starved = [...opportunityByMarket.entries()]
      .filter(([m]) => m !== market)
      .filter(([m, opp]) => opp - (desiredByMarket.get(m) ?? 0) > 1000)
      .map(([m, opp]) => `${m}(未充足機会 ${Math.round(opp - (desiredByMarket.get(m) ?? 0))}t)`);
    if (starved.length === 0) continue;

    const allocated = allocatedByMarket.get(market) ?? 0;
    const opportunity = opportunityByMarket.get(market) ?? 0;
    findings.push({
      findingId: fid("A01", row),
      severity: "P1",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A01_SALES_FORCE_CONCENTRATION_WITHOUT_OPPORTUNITY",
      observation:
        `市場${market}へ営業${headcount}/${totalHeadcount}人（${pct(headcountShare)}）を配置したが、` +
        `${market}の取り得る機会は全市場の${pct(opportunityShare)}（${Math.round(opportunity)}t）しかない。` +
        `未充足の機会が残る市場: ${starved.join(", ")}`,
      decision: `営業配分 ${JSON.stringify(row.decision.salesHeadcountByMarket)}`,
      result: `${market}での成約は${Math.round(allocated)}t（機会${Math.round(opportunity)}tの${pct(opportunity > 0 ? allocated / opportunity : 0)}）。会社全体の成約は${Math.round(row.result.newContractedQuantity)}t。`,
      counterfactual:
        `営業を機会比率どおりに配分した場合、${market}の配置は約${Math.round(totalHeadcount * opportunityShare)}人で足り、` +
        `差分の約${Math.round(headcount - totalHeadcount * opportunityShare)}人を未充足市場へ回せた。`,
      suspectedRootCause:
        "decision/sales.ts の市場別按分が「前期参照価格ランキング首位へ一律50%、残りを均等割り」という価格のみの規則で、" +
        "市場規模（対象需要）を一切考慮していない。営業人員はこの希望量に比例配分されるため、価格が最も高い市場へ人員が集中する。",
      relevantFiles: [
        "app/lib/v2/companyLab/standardAi/decision/sales.ts",
        "app/lib/v2/companyLab/standardAi/pressures.ts",
        "app/lib/v2/companyLab/standardAi/types.ts",
      ],
      confidence: 0.9,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------
// A02: シェア上限到達後の営業増員
// ---------------------------------------------------------------------

function auditA02(row: CompanyQuarterRecordRow, maximumSupplierShare: number): AuditFinding[] {
  if (row.decision.salesForceHireCount <= 0) return [];
  // 全市場×商品で、実際のシェアが上限の90%以上に達している比率。
  const rows = row.result.allocationsByMarketProduct.filter((a) => a.targetDemand > EPSILON);
  if (rows.length === 0) return [];
  const atCeiling = rows.filter((a) => a.marketShare >= maximumSupplierShare * 0.9);
  const atCeilingVolumeShare =
    rows.reduce((s, a) => s + a.allocatedQuantity, 0) > EPSILON
      ? atCeiling.reduce((s, a) => s + a.allocatedQuantity, 0) / rows.reduce((s, a) => s + a.allocatedQuantity, 0)
      : 0;
  if (atCeilingVolumeShare < 0.8) return [];

  return [
    {
      findingId: fid("A02", row),
      severity: "P2",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A02_SALES_FORCE_AFTER_SHARE_CEILING",
      observation: `成約量の${pct(atCeilingVolumeShare)}が買い占め防止シェア上限（${pct(maximumSupplierShare)}）の90%以上に達している。`,
      decision: `営業人員を${row.decision.salesForceHireCount}人追加採用した。`,
      result: `当期成約 ${Math.round(row.result.newContractedQuantity)}t。シェア上限に張り付いているため、追加人員による販売増分は限定的。`,
      counterfactual: "採用を見送れば、翌期以降の営業人件費（1人あたり四半期給与）を回避できた。",
      suspectedRootCause:
        "営業採用の判断が「営業充足率が低い」という自社側の指標だけで行われ、市場シェア上限への到達（＝これ以上取れない）を条件に含めていない可能性。",
      relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/sales.ts", "app/lib/v2/companyLab/standardAi/decision/labor.ts"],
      confidence: 0.6,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

// ---------------------------------------------------------------------
// A03 / A04: 完成品在庫の過剰と積み上がり
// ---------------------------------------------------------------------

function auditA03(row: CompanyQuarterRecordRow): AuditFinding[] {
  const planned = Object.values(row.decision.plannedProductionByProduct).reduce((s, v) => s + v, 0);
  const fg = row.result.finishedGoodsInventory;
  const contracted = row.result.newContractedQuantity;
  // 完成品在庫が当期成約の2四半期分を超えているのに、さらに成約量を大きく超える生産を計画している。
  if (fg <= contracted * 2 || contracted <= EPSILON) return [];
  if (planned <= contracted * 1.5) return [];

  return [
    {
      findingId: fid("A03", row),
      severity: "P2",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A03_PRODUCTION_WITH_EXCESS_FG",
      observation: `期末完成品在庫 ${Math.round(fg)}t は当期成約 ${Math.round(contracted)}t の${(fg / contracted).toFixed(1)}四半期分。`,
      decision: `生産計画 ${Math.round(planned)}t（当期成約の${(planned / contracted).toFixed(1)}倍）を提出した。`,
      result: `完成品在庫はさらに積み上がる方向。設備稼働率 ${pct(row.result.equipmentUtilizationRate)}。`,
      counterfactual: `生産を当期成約相当（約${Math.round(contracted)}t）へ抑えれば、在庫評価額と原料支出を圧縮できた。`,
      suspectedRootCause:
        "生産計画の起点が当期納品需要ではなく能力・目標規模側にあり、在庫水準による下方修正が弱い可能性（SAI-6.4で一部修正済みの領域）。",
      relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/production.ts"],
      confidence: 0.7,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

function auditA04(rows: readonly CompanyQuarterRecordRow[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  // 同一 seed × company の時系列で、完成品在庫が3四半期連続増加し、かつ生産計画が減っていない。
  const byKey = new Map<string, CompanyQuarterRecordRow[]>();
  for (const r of rows) {
    const key = `${r.seed}::${r.companyId}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
  }
  for (const series of byKey.values()) {
    const sorted = [...series].sort((a, b) => a.turn - b.turn);
    for (let i = 3; i < sorted.length; i++) {
      const w = sorted.slice(i - 3, i + 1);
      const increasing = w.every((r, idx) => idx === 0 || r.result.finishedGoodsInventory > w[idx - 1].result.finishedGoodsInventory + 1);
      if (!increasing) continue;
      const plannedFirst = Object.values(w[0].decision.plannedProductionByProduct).reduce((s, v) => s + v, 0);
      const plannedLast = Object.values(w[w.length - 1].decision.plannedProductionByProduct).reduce((s, v) => s + v, 0);
      if (plannedLast < plannedFirst * 0.95) continue; // 生産を減らしているなら矛盾ではない
      const last = w[w.length - 1];
      findings.push({
        findingId: fid("A04", last),
        severity: "P2",
        company: last.companyId,
        quarter: last.turn,
        seed: last.seed,
        rule: "A04_REPEATED_FG_ACCUMULATION",
        observation: `完成品在庫が4四半期連続で増加（${w.map((r) => Math.round(r.result.finishedGoodsInventory)).join(" → ")}t）。`,
        decision: `同期間の生産計画は ${Math.round(plannedFirst)}t → ${Math.round(plannedLast)}t で減少していない。`,
        result: `在庫が滞留し、運転資金と保管負担が増える。`,
        counterfactual: "在庫増加が続いた時点で生産計画を成約水準へ引き下げれば、滞留を止められた。",
        suspectedRootCause: "在庫水準の時系列トレンドを生産計画へフィードバックする経路が無く、単一四半期の判断に閉じている可能性。",
        relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/production.ts"],
        confidence: 0.65,
        classification: "STANDARD_AI_DESIGN_WEAKNESS",
      });
      break; // 同一系列で1件出せば十分（同じ問題の重複報告を避ける）
    }
  }
  return findings;
}

// ---------------------------------------------------------------------
// A05 / A06: 原料調達と生産の不整合
// ---------------------------------------------------------------------

function auditA05(row: CompanyQuarterRecordRow): AuditFinding[] {
  const planned = Object.values(row.decision.plannedProductionByProduct).reduce((s, v) => s + v, 0);
  const procured = row.decision.domesticPurchaseQuantity + row.decision.importOrderedQuantity;
  const inventory = row.result.rawMaterialInventory;
  // 原料在庫が生産計画の2四半期分以上あるのに、さらに生産計画を超える調達をしている。
  if (planned <= EPSILON || inventory < planned * 2 || procured <= planned) return [];
  return [
    {
      findingId: fid("A05", row),
      severity: "P2",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A05_PROCUREMENT_WITHOUT_PRODUCTION_NEED",
      observation: `期末原料在庫 ${Math.round(inventory)}t は生産計画 ${Math.round(planned)}t の${(inventory / planned).toFixed(1)}四半期分。`,
      decision: `さらに ${Math.round(procured)}t を調達（国内${Math.round(row.decision.domesticPurchaseQuantity)}t＋輸入${Math.round(row.decision.importOrderedQuantity)}t）。`,
      result: `原料在庫が積み上がり、現金 ${Math.round(row.result.cash)} を圧迫する。`,
      counterfactual: `調達を生産計画相当（約${Math.round(planned)}t）へ抑えれば、超過分の原料支出を回避できた。`,
      suspectedRootCause: "原料調達の目標が在庫カバー四半期数で決まる一方、既存在庫が十分な場合の下方修正が効いていない可能性。",
      relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/procurement.ts"],
      confidence: 0.7,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

function auditA06(row: CompanyQuarterRecordRow): AuditFinding[] {
  if (row.result.rawMaterialShortfall <= EPSILON) return [];
  const planned = Object.values(row.decision.plannedProductionByProduct).reduce((s, v) => s + v, 0);
  const produced = Object.values(row.result.producedByProduct).reduce((s, v) => s + v, 0);
  // 原料不足で実生産が計画を大きく下回っているのに、調達を増やしていない。
  if (produced >= planned * 0.8) return [];
  if (row.decision.domesticPurchaseQuantity + row.decision.importOrderedQuantity >= planned) return [];
  return [
    {
      findingId: fid("A06", row),
      severity: "P1",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A06_PRODUCTION_WITH_RAW_SHORTAGE",
      observation: `原料不足による生産機会損失 ${Math.round(row.result.rawMaterialShortfall)}t。実生産 ${Math.round(produced)}t は計画 ${Math.round(planned)}t の${pct(planned > 0 ? produced / planned : 0)}。`,
      decision: `当期の原料調達は ${Math.round(row.decision.domesticPurchaseQuantity + row.decision.importOrderedQuantity)}t で、生産計画 ${Math.round(planned)}t に足りない。`,
      result: `生産が原料で頭打ちになり、契約履行能力が下がる。`,
      counterfactual: `調達を生産計画に見合う水準へ引き上げれば、機会損失 ${Math.round(row.result.rawMaterialShortfall)}t を減らせた可能性がある。`,
      suspectedRootCause: "生産計画と原料調達計画が同一四半期内で整合していない（生産側が調達可能量を制約として織り込んでいない）可能性。",
      relevantFiles: [
        "app/lib/v2/companyLab/standardAi/decision/production.ts",
        "app/lib/v2/companyLab/standardAi/decision/procurement.ts",
      ],
      confidence: 0.7,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

// ---------------------------------------------------------------------
// A07 / A13: 履行能力を超える受注
// ---------------------------------------------------------------------

function auditA07(row: CompanyQuarterRecordRow): AuditFinding[] {
  const contracted = row.result.newContractedQuantity;
  const produced = Object.values(row.result.producedByProduct).reduce((s, v) => s + v, 0);
  const available = produced + row.result.finishedGoodsInventory;
  if (contracted <= EPSILON || available >= contracted) return [];
  if (row.result.overdueQuantity <= EPSILON) return [];
  return [
    {
      findingId: fid("A07", row),
      severity: "P1",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A07_SALES_WITHOUT_DELIVERY_CAPABILITY",
      observation: `当期成約 ${Math.round(contracted)}t に対し、生産 ${Math.round(produced)}t ＋ 期末在庫 ${Math.round(row.result.finishedGoodsInventory)}t しかない。延滞 ${Math.round(row.result.overdueQuantity)}t が発生。`,
      decision: `販売希望量の合計は ${Math.round(row.decision.salesPlans.reduce((s, p) => s + p.desiredQuantity, 0))}t。`,
      result: `受注残 ${Math.round(row.result.outstandingQuantity)}t、延滞 ${Math.round(row.result.overdueQuantity)}t。納期信頼性の低下につながる。`,
      counterfactual: "受注量を履行可能量まで抑えれば、延滞と信頼低下を避けられた。",
      suspectedRootCause: "販売計画が生産・原料の制約を織り込まずに立てられている可能性。",
      relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/sales.ts"],
      confidence: 0.75,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

function auditA13(rows: readonly CompanyQuarterRecordRow[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const byKey = new Map<string, CompanyQuarterRecordRow[]>();
  for (const r of rows) {
    const key = `${r.seed}::${r.companyId}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
  }
  for (const series of byKey.values()) {
    const sorted = [...series].sort((a, b) => a.turn - b.turn);
    for (let i = 2; i < sorted.length; i++) {
      const w = sorted.slice(i - 2, i + 1);
      if (!w.every((r) => r.result.overdueQuantity > EPSILON)) continue;
      const first = w[0].result.newContractedQuantity;
      const last = w[w.length - 1].result.newContractedQuantity;
      if (last <= first) continue; // 受注を絞っているなら矛盾ではない
      const lastRow = w[w.length - 1];
      findings.push({
        findingId: fid("A13", lastRow),
        severity: "P1",
        company: lastRow.companyId,
        quarter: lastRow.turn,
        seed: lastRow.seed,
        rule: "A13_CONTRACT_FAILURE_REPEATED",
        observation: `3四半期連続で延滞が発生（${w.map((r) => Math.round(r.result.overdueQuantity)).join(" → ")}t）。`,
        decision: `同期間の新規成約は ${Math.round(first)}t → ${Math.round(last)}t と増加している。`,
        result: `延滞が解消しないまま受注が積み上がる。`,
        counterfactual: "延滞が続いた時点で受注を抑え、制約（原料・生産・労働）の解消を優先すべきだった。",
        suspectedRootCause: "延滞の継続を販売計画へフィードバックする経路が無い可能性。",
        relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/sales.ts"],
        confidence: 0.7,
        classification: "STANDARD_AI_DESIGN_WEAKNESS",
      });
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------
// A08 / A09: 労働
// ---------------------------------------------------------------------

function auditA08(row: CompanyQuarterRecordRow): AuditFinding[] {
  if (row.result.laborShortfall <= EPSILON) return [];
  const plannedVap = row.decision.plannedProductionByProduct.vap ?? 0;
  const producedVap = row.result.producedByProduct.vap ?? 0;
  // 労働不足が出ているのに、労働集約度の高いVAPの生産計画を実績より大きく積んでいる。
  if (plannedVap <= producedVap * 1.2) return [];
  return [
    {
      findingId: fid("A08", row),
      severity: "P2",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A08_LABOR_SHORTAGE_IGNORED",
      observation: `労働力不足による生産機会損失 ${Math.round(row.result.laborShortfall)}t、労働稼働率 ${pct(row.result.laborUtilizationRate)}、残業率 ${pct(row.result.overtimeRate)}。`,
      decision: `労働集約度が最も高いVAPの生産計画 ${Math.round(plannedVap)}t（実績 ${Math.round(producedVap)}t の${(plannedVap / Math.max(producedVap, 1)).toFixed(1)}倍）。`,
      result: `労働制約が解消しないまま、労働集約的な商品の計画だけが拡大している。`,
      counterfactual: "Worker採用または商品構成の見直し（VAP比率の抑制）で、労働制約と計画の整合を取れた。",
      suspectedRootCause: "商品別労働集約度（HOSO:PD:VAP=1.0:1.2:3.0）を生産計画の商品配分へ織り込めていない可能性。",
      relevantFiles: [
        "app/lib/v2/companyLab/standardAi/decision/production.ts",
        "app/lib/v2/companyLab/standardAi/decision/labor.ts",
      ],
      confidence: 0.6,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

function auditA09(rows: readonly CompanyQuarterRecordRow[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const byKey = new Map<string, CompanyQuarterRecordRow[]>();
  for (const r of rows) {
    const key = `${r.seed}::${r.companyId}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
  }
  for (const series of byKey.values()) {
    const sorted = [...series].sort((a, b) => a.turn - b.turn);
    for (let i = 3; i < sorted.length; i++) {
      const w = sorted.slice(i - 3, i + 1);
      // 遊休労務費が営業利益の絶対値に対して重い状態が4四半期続き、Worker人数が減っていない。
      const heavy = w.every((r) => r.result.idleLaborCost > Math.abs(r.result.operatingProfit) * 0.5 && r.result.idleLaborCost > 100_000);
      if (!heavy) continue;
      const firstWorkers = w[0].decision.totalRegularWorkers;
      const lastWorkers = w[w.length - 1].decision.totalRegularWorkers;
      if (lastWorkers < firstWorkers * 0.95) continue;
      const last = w[w.length - 1];
      findings.push({
        findingId: fid("A09", last),
        severity: "P2",
        company: last.companyId,
        quarter: last.turn,
        seed: last.seed,
        rule: "A09_IDLE_LABOR_NOT_CORRECTED",
        observation: `遊休労務費が4四半期連続で重い（${w.map((r) => Math.round(r.result.idleLaborCost)).join(" → ")} USD）。労働稼働率 ${pct(last.result.laborUtilizationRate)}。`,
        decision: `同期間の常用Worker数は ${firstWorkers} → ${lastWorkers} 人で減っていない。`,
        result: `稼働していない人員の固定費が損益を圧迫し続ける。`,
        counterfactual: `Worker数を稼働水準に合わせて調整すれば、四半期あたり約 ${Math.round(last.result.idleLaborCost)} USD の遊休費を圧縮できた。`,
        suspectedRootCause: "Worker人数の下方調整（減員）の判断条件が弱く、遊休が続いても人員が維持される可能性。",
        relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/labor.ts"],
        confidence: 0.65,
        classification: "STANDARD_AI_DESIGN_WEAKNESS",
      });
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------
// A10 / A11 / A12: 投資
// ---------------------------------------------------------------------

function auditA10(row: CompanyQuarterRecordRow): AuditFinding[] {
  if (row.decision.capexProposals.length === 0 || row.result.underConstructionProjectIds.length === 0) return [];
  // 建設中の案件があるのに、同じ種別を再提案している。
  const duplicated = row.decision.capexProposals.filter((p) => row.result.underConstructionProjectIds.some((id) => id.includes(p.projectType)));
  if (duplicated.length === 0) return [];
  return [
    {
      findingId: fid("A10", row),
      severity: "P1",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A10_CAPEX_DUPLICATION",
      observation: `建設中の案件 ${row.result.underConstructionProjectIds.join(", ")} がある。`,
      decision: `同じ種別の投資を再提案: ${duplicated.map((p) => p.projectType).join(", ")}`,
      result: `建設中勘定 ${Math.round(row.result.constructionInProgressUsd)} USD。二重投資により現金が拘束される。`,
      counterfactual: "既存案件の完成を待ってから次を提案すれば、現金拘束を避けられた。",
      suspectedRootCause: "投資提案の判断が、自社の進行中ポートフォリオ（capexState）を条件に含めていない可能性。",
      relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/capex.ts"],
      confidence: 0.75,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

function auditA11(row: CompanyQuarterRecordRow): AuditFinding[] {
  if (row.decision.capexProposals.length === 0) return [];
  // 設備稼働率が低く、かつ営業側も機会を取り切れていない（＝能力ではなく営業が制約）のに能力拡張。
  if (row.result.equipmentUtilizationRate >= 0.5) return [];
  const expansion = row.decision.capexProposals.filter((p) => p.projectType.includes("Expansion") || p.projectType.includes("Construction"));
  if (expansion.length === 0) return [];
  return [
    {
      findingId: fid("A11", row),
      severity: "P2",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A11_CAPEX_WITHOUT_CAPACITY_PRESSURE",
      observation: `設備稼働率 ${pct(row.result.equipmentUtilizationRate)}（能力に大きな余剰）。設備能力不足による機会損失は ${Math.round(row.result.equipmentShortfall)}t。`,
      decision: `能力拡張投資を提案: ${expansion.map((p) => p.projectType).join(", ")}`,
      result: `建設中勘定 ${Math.round(row.result.constructionInProgressUsd)} USD。`,
      counterfactual: "能力ではなく営業・原料が制約であれば、そちらへ資源を振り向ける方が成約増につながった可能性がある。",
      suspectedRootCause: "投資判断が能力の逼迫度（equipmentShortfall・稼働率）を十分な条件にしていない可能性。",
      relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/capex.ts"],
      confidence: 0.6,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

function auditA12(row: CompanyQuarterRecordRow): AuditFinding[] {
  const distress = row.result.paymentDefault || row.result.insolvent || row.result.cash <= 0 || row.result.emergencyBorrowingUsd > 0;
  if (!distress) return [];
  const growth = row.decision.capexProposals.length > 0 || row.decision.vapProductDevelopmentSpendUsd > 0;
  if (!growth) return [];
  return [
    {
      findingId: fid("A12", row),
      severity: "P0",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A12_GROWTH_INVESTMENT_DURING_FINANCIAL_DISTRESS",
      observation:
        `資金逼迫: 現金 ${Math.round(row.result.cash)} USD, 緊急融資 ${Math.round(row.result.emergencyBorrowingUsd)} USD, ` +
        `支払不能 ${row.result.paymentDefault}, 債務超過 ${row.result.insolvent}。`,
      decision: `成長投資を実行: capex提案 ${row.decision.capexProposals.length}件, VAP開発費 ${Math.round(row.decision.vapProductDevelopmentSpendUsd)} USD。`,
      result: `建設中勘定 ${Math.round(row.result.constructionInProgressUsd)} USD が現金を拘束したまま。`,
      counterfactual: "資金逼迫時は非必須の成長投資を停止すれば、支払不能・緊急融資を回避できた可能性がある。",
      suspectedRootCause: "投資判断の資金制約チェックが、支払不能・緊急融資の発生水準まで踏み込んでいない可能性。",
      relevantFiles: [
        "app/lib/v2/companyLab/standardAi/decision/capex.ts",
        "app/lib/v2/companyLab/standardAi/decision/finance.ts",
      ],
      confidence: 0.8,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

// ---------------------------------------------------------------------
// A14: 営業増員の限界貢献が負
// ---------------------------------------------------------------------

function auditA14(row: CompanyQuarterRecordRow, salesForceSalaryUsdPerQuarter: number): AuditFinding[] {
  if (row.decision.salesForceHireCount <= 0) return [];
  // 営業充足に余裕がある（希望量をほぼ満たせている）のに採用している。
  const totalDesired = row.decision.salesPlans.reduce((s, p) => s + p.desiredQuantity, 0);
  const totalAllocated = row.result.allocationsByMarketProduct.reduce((s, a) => s + a.allocatedQuantity, 0);
  if (totalDesired <= EPSILON) return [];
  const fillRatio = totalAllocated / totalDesired;
  if (fillRatio < 0.95) return [];
  const cost = row.decision.salesForceHireCount * salesForceSalaryUsdPerQuarter;
  return [
    {
      findingId: fid("A14", row),
      severity: "P2",
      company: row.companyId,
      quarter: row.turn,
      seed: row.seed,
      rule: "A14_MARGINAL_SALESFORCE_VALUE_NEGATIVE",
      observation: `販売希望量 ${Math.round(totalDesired)}t に対し成約 ${Math.round(totalAllocated)}t（充足率 ${pct(fillRatio)}）。営業は制約になっていない。`,
      decision: `営業人員を${row.decision.salesForceHireCount}人採用（四半期人件費 約${Math.round(cost)} USD の増加）。`,
      result: `当期営業利益 ${Math.round(row.result.operatingProfit)} USD。`,
      counterfactual: `採用を見送れば、四半期あたり約 ${Math.round(cost)} USD の人件費増を回避できた。`,
      suspectedRootCause: "営業採用が「充足率が低いとき」ではなく規模目標側から駆動されている可能性。",
      relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/sales.ts"],
      confidence: 0.6,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

// ---------------------------------------------------------------------
// Level B: 経営判断レビュー（誤りと断定しない）
// ---------------------------------------------------------------------

function auditLevelB(row: CompanyQuarterRecordRow): AuditFinding[] {
  const findings: AuditFinding[] = [];
  // 市場集中: 事実だけを提示する（集中戦略そのものは正当な経営判断でありうる）。
  const total = row.decision.salesForceTotalAssigned;
  if (total > 0) {
    const top = Object.entries(row.decision.salesHeadcountByMarket).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / total >= 0.4) {
      findings.push({
        findingId: fid("B_MARKET_CONCENTRATION", row),
        severity: "P3",
        company: row.companyId,
        quarter: row.turn,
        seed: row.seed,
        rule: "B_STRATEGIC_MARKET_CONCENTRATION",
        observation: `市場${top[0]}へ営業の${pct(top[1] / total)}（${top[1]}/${total}人）を配置している。`,
        decision: `営業配分 ${JSON.stringify(row.decision.salesHeadcountByMarket)}`,
        result: `当期成約 ${Math.round(row.result.newContractedQuantity)}t、平均単価 ${row.result.newContractedAveragePrice.toFixed(2)} USD/kg。`,
        counterfactual: null,
        suspectedRootCause:
          "集中の是非は経営判断（高単価市場への特化 vs 分散）であり、自動判定しない。A01が同時に出ている場合のみ機会との不整合として扱う。",
        relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/sales.ts"],
        confidence: 0.4,
        classification: "MANAGEMENT_JUDGMENT_REVIEW",
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------
// 【Batch 002】観測需要の利用に関する監査（A15 / A16）
// ---------------------------------------------------------------------

const MARKETS = ["CN", "US", "EU", "JP", "OTHER"] as const;

function headcountShares(row: CompanyQuarterRecordRow): Record<string, number> {
  const hc = row.decision.salesHeadcountByMarket;
  const total = Object.values(hc).reduce((s, v) => s + v, 0);
  const out: Record<string, number> = {};
  for (const m of MARKETS) out[m] = total > 0 ? (hc[m] ?? 0) / total : 0;
  return out;
}

/**
 * A15: 2四半期遅れの観測需要へ過剰反応して、営業配置が四半期ごとに大きく振動していないか。
 *
 * 遅行情報は本質的にノイズを含む。それに毎期フルに追随すると、実際の市場は動いて
 * いないのに配置だけが揺れ、営業基盤・顧客関係の蓄積を自ら壊すことになる。
 * ここでは「連続する四半期で、いずれかの市場の営業人員シェアが25ポイント超動いた」
 * 場合を過剰反応の候補として拾う。
 */
function auditA15(rows: readonly CompanyQuarterRecordRow[]): AuditFinding[] {
  const SHARE_SWING_THRESHOLD = 0.25;
  const findings: AuditFinding[] = [];
  const byKey = new Map<string, CompanyQuarterRecordRow[]>();
  for (const row of rows) {
    const key = `${row.seed}|${row.companyId}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(row);
  }
  for (const series of byKey.values()) {
    const sorted = [...series].sort((a, b) => a.turn - b.turn);
    for (let i = 1; i < sorted.length; i++) {
      const prev = headcountShares(sorted[i - 1]);
      const cur = headcountShares(sorted[i]);
      let worstMarket = "";
      let worstSwing = 0;
      for (const m of MARKETS) {
        const swing = Math.abs(cur[m] - prev[m]);
        if (swing > worstSwing) {
          worstSwing = swing;
          worstMarket = m;
        }
      }
      if (worstSwing <= SHARE_SWING_THRESHOLD) continue;
      const row = sorted[i];
      findings.push({
        findingId: `A15-${row.seed}-${row.companyId}-${row.turn}`,
        rule: "A15_STALE_MARKET_INFORMATION_OVERREACTION",
        severity: "P2",
        seed: row.seed,
        company: row.companyId,
        quarter: row.turn,
        observation: `${worstMarket}市場の営業人員シェアが前四半期の${(prev[worstMarket] * 100).toFixed(0)}%から${(cur[worstMarket] * 100).toFixed(0)}%へ${(worstSwing * 100).toFixed(0)}ポイント動いた（観測需要は2四半期遅れであり、実市場が同じだけ動いた証拠は無い）。`,
        decision: `営業配置 ${JSON.stringify(row.decision.salesHeadcountByMarket)}（観測需要の出所: ${row.decision.marketDemandObservationSource ?? "不明"}）`,
        result: `新規成約 ${Math.round(row.result.newContractedQuantity)}t`,
        counterfactual: "遅行情報の変動へ毎期フル追随せず、配置変更を平滑化すれば、営業基盤・顧客関係の蓄積を保てた可能性がある。",
        suspectedRootCause: "市場別按分重みが当期の観測値だけで決まり、前期配置からの継続性を考慮していない。",
        relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/sales.ts"],
        confidence: 0.5,
        classification: "STANDARD_AI_DESIGN_WEAKNESS",
      });
    }
  }
  return findings;
}

/**
 * A16: 市場×商品別の観測需要が利用可能なのに、営業配分が実質的に価格順位だけで
 * 決まっていないか。
 *
 * 判定は「観測需要が公開されている」かつ「営業人員シェアと観測需要シェアの
 * 順位相関が低い」かつ「最大シェアの市場が観測需要では最大でない」場合。
 * Batch 002以降でこのruleが多発する場合、観測を配線したのに判断側が使っていない
 * ことを意味する（配線と判断の乖離を検出するためのrule）。
 */
function auditA16(row: CompanyQuarterRecordRow): AuditFinding[] {
  const observed = row.decision.observedDemandByMarket;
  if (!observed || Object.keys(observed).length === 0) return [];
  const demandTotals: Record<string, number> = {};
  let demandSum = 0;
  for (const m of MARKETS) {
    const byProduct = observed[m];
    const total = byProduct ? Object.values(byProduct).reduce((s, v) => s + v, 0) : 0;
    demandTotals[m] = total;
    demandSum += total;
  }
  if (demandSum <= 0) return [];

  const shares = headcountShares(row);
  const totalHeadcount = Object.values(row.decision.salesHeadcountByMarket).reduce((s, v) => s + v, 0);
  if (totalHeadcount <= 0) return [];

  const topByHeadcount = MARKETS.reduce((a, b) => (shares[a] >= shares[b] ? a : b));
  const topByDemand = MARKETS.reduce((a, b) => (demandTotals[a] >= demandTotals[b] ? a : b));
  const demandShareOfTopHeadcount = demandTotals[topByHeadcount] / demandSum;

  // 「最も人を置いた市場」が観測需要では最大でなく、かつその市場の需要シェアが
  // 人員シェアの半分未満（＝規模に対して明らかに置きすぎ）の場合のみ指摘する。
  if (topByHeadcount === topByDemand) return [];
  if (demandShareOfTopHeadcount >= shares[topByHeadcount] * 0.5) return [];

  return [
    {
      findingId: `A16-${row.seed}-${row.companyId}-${row.turn}`,
      rule: "A16_MARKET_SIZE_IGNORED",
      severity: "P1",
      seed: row.seed,
      company: row.companyId,
      quarter: row.turn,
      observation: `観測需要（${row.decision.marketDemandObservationSource ?? "不明"}）では${topByDemand}が最大（${Math.round(demandTotals[topByDemand])}t）だが、営業人員は${topByHeadcount}へ最も多く（${(shares[topByHeadcount] * 100).toFixed(0)}%）配置している。${topByHeadcount}の観測需要シェアは${(demandShareOfTopHeadcount * 100).toFixed(0)}%に過ぎない。`,
      decision: `営業配置 ${JSON.stringify(row.decision.salesHeadcountByMarket)}`,
      result: `新規成約 ${Math.round(row.result.newContractedQuantity)}t`,
      counterfactual: `観測需要と採算性で按分していれば、${topByDemand}へより多くの営業力が向き、同じ人員でより多くの成約機会に接触できた可能性がある。`,
      suspectedRootCause: "市場×商品別の観測需要が公開されているにもかかわらず、市場別按分が価格順位など規模非依存の規則で決まっている。",
      relevantFiles: ["app/lib/v2/companyLab/standardAi/decision/sales.ts", "app/lib/v2/companyLab/marketDemandObservation.ts"],
      confidence: 0.7,
      classification: "STANDARD_AI_DESIGN_WEAKNESS",
    },
  ];
}

// ---------------------------------------------------------------------
// 【Batch 002 §H】Constraint Chain（制約の移り変わり）
// ---------------------------------------------------------------------

export type BottleneckCategory =
  | "MARKET"
  | "SALES_FORCE"
  | "PRODUCTION_CAPACITY"
  | "RAW_MATERIAL"
  | "LABOR"
  | "CASH"
  | "BORROWING"
  | "INVENTORY"
  | "NONE";

/**
 * Standard AI自身の診断（primaryConstraint / secondaryConstraint）を、共通の
 * ボトルネック語彙へ写像する。新しい診断ロジックは作らず、既存の診断結果を
 * 読み替えるだけ（AIが何を制約と考えていたかを、そのまま時系列で追うため）。
 */
export function toBottleneckCategory(constraint: string | null): BottleneckCategory {
  if (!constraint) return "NONE";
  const c = constraint.toLowerCase();
  if (c.includes("sales_shortage") || c.includes("sales_force")) return "SALES_FORCE";
  if (c.includes("production_capacity")) return "PRODUCTION_CAPACITY";
  if (c.includes("raw")) return "RAW_MATERIAL";
  if (c.includes("worker") || c.includes("labor")) return "LABOR";
  if (c.includes("liquidity") || c.includes("cash")) return "CASH";
  if (c.includes("borrow")) return "BORROWING";
  if (c.includes("inventory")) return "INVENTORY";
  if (c.includes("market")) return "MARKET";
  return "NONE";
}

export interface ConstraintChainEntry {
  readonly seed: string;
  readonly companyId: string;
  readonly turn: number;
  readonly primary: BottleneckCategory;
  readonly secondary: BottleneckCategory;
}

export interface ConstraintMigration {
  readonly from: BottleneckCategory;
  readonly to: BottleneckCategory;
  readonly count: number;
}

/** company-quarterごとのボトルネックと、その遷移回数を集計する。 */
export function buildConstraintChain(rows: readonly CompanyQuarterRecordRow[]): {
  readonly entries: readonly ConstraintChainEntry[];
  readonly primaryCounts: Readonly<Record<string, number>>;
  readonly migrations: readonly ConstraintMigration[];
} {
  const entries: ConstraintChainEntry[] = rows.map((row) => ({
    seed: row.seed,
    companyId: row.companyId,
    turn: row.turn,
    primary: toBottleneckCategory(row.decision.primaryConstraint),
    secondary: toBottleneckCategory(row.decision.secondaryConstraint),
  }));

  const primaryCounts: Record<string, number> = {};
  for (const e of entries) primaryCounts[e.primary] = (primaryCounts[e.primary] ?? 0) + 1;

  const migrationCounts = new Map<string, number>();
  const byKey = new Map<string, ConstraintChainEntry[]>();
  for (const e of entries) {
    const key = `${e.seed}|${e.companyId}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(e);
  }
  for (const series of byKey.values()) {
    const sorted = [...series].sort((a, b) => a.turn - b.turn);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1].primary === sorted[i].primary) continue;
      const key = `${sorted[i - 1].primary}>${sorted[i].primary}`;
      migrationCounts.set(key, (migrationCounts.get(key) ?? 0) + 1);
    }
  }
  const migrations = [...migrationCounts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split(">") as [BottleneckCategory, BottleneckCategory];
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);

  return { entries, primaryCounts, migrations };
}

// ---------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------

export interface AuditOptions {
  /** ゲーム環境が定める買い占め防止シェア上限（sales/parameters.ts の maximumSupplierShare）。 */
  readonly maximumSupplierShare: number;
  /** 営業1人あたり四半期人件費（financing/finance parameters）。A14の限界貢献の判定に使う。 */
  readonly salesForceSalaryUsdPerQuarter: number;
  /** Level Bを含めるか（既定: 含める）。 */
  readonly includeLevelB?: boolean;
}

export function auditBenchmarkRows(rows: readonly CompanyQuarterRecordRow[], options: AuditOptions): readonly AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const row of rows) {
    findings.push(...auditA01(row, options.maximumSupplierShare));
    findings.push(...auditA02(row, options.maximumSupplierShare));
    findings.push(...auditA03(row));
    findings.push(...auditA05(row));
    findings.push(...auditA06(row));
    findings.push(...auditA07(row));
    findings.push(...auditA08(row));
    findings.push(...auditA10(row));
    findings.push(...auditA11(row));
    findings.push(...auditA12(row));
    findings.push(...auditA14(row, options.salesForceSalaryUsdPerQuarter));
    findings.push(...auditA16(row));
    if (options.includeLevelB !== false) findings.push(...auditLevelB(row));
  }
  // 時系列を要するルール
  findings.push(...auditA04(rows));
  findings.push(...auditA09(rows));
  findings.push(...auditA13(rows));
  findings.push(...auditA15(rows));

  return findings.sort((a, b) => {
    const order: Record<FindingSeverity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
    return order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule) || a.findingId.localeCompare(b.findingId);
  });
}

/** severity別・rule別の集計（scorecard用）。 */
export interface FindingSummary {
  readonly total: number;
  readonly bySeverity: Readonly<Record<FindingSeverity, number>>;
  readonly byRule: Readonly<Record<string, number>>;
}

export function summarizeFindings(findings: readonly AuditFinding[]): FindingSummary {
  const bySeverity: Record<FindingSeverity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const byRule: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] += 1;
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  }
  return { total: findings.length, bySeverity, byRule };
}
