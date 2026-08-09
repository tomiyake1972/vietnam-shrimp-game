// ShrimpX V2 — AI Analysis Pack: 05_Data_Dictionary.md
//
// 主要フィールドの定義・単位・出所・true/observable 区分をまとめる。
// 生成AIを使わない固定テキスト（定数だけ実際の値を差し込む）。

import { MAJOR_CHANGE_THRESHOLDS } from "./changeLog";
import { AiAnalysisPackContext } from "./types";

interface DictionaryEntry {
  readonly field: string;
  readonly japanese: string;
  readonly definition: string;
  readonly unit: string;
  readonly source: string;
  readonly layer: "TRUE_WORLD" | "OBSERVABLE" | "AI_INTERNAL" | "DECISION" | "RESULT" | "STATE" | "METADATA";
  readonly nullableReason: string;
}

const ENTRIES: readonly DictionaryEntry[] = [
  {
    field: "world.turns[].trueWorld.marketProducts[].trueDemandTons",
    japanese: "対象需要（真値）",
    definition: "その四半期に、その市場×商品でベトナム産5社が獲得対象にできた需要。配分計算が実際に使った値。",
    unit: "HOSO換算トン",
    source: "salesRecord.allocations[].targetDemand",
    layer: "TRUE_WORLD",
    nullableReason: "その市場×商品の配分結果が記録されていない四半期。",
  },
  {
    field: "world.turns[].standardAiObservable.marketProducts[].observableDemandTons",
    japanese: "観測需要（遅行公開値）",
    definition:
      "プレイヤーと Standard AI が実際に見られた需要。既定で2四半期前の実績（開始直後は初期市場情報）。trueDemandTons と同じ量を精度違いで測ったものではなく、時点が違う。",
    unit: "HOSO換算トン",
    source: "companyLab/marketDemandObservation.ts",
    layer: "OBSERVABLE",
    nullableReason: "観測需要が公開されていない四半期。",
  },
  {
    field: "world.turns[].trueWorld.producerCountries[]",
    japanese: "産地国データ",
    definition:
      "産地国（VN / EC / IN / ID）の生産量・輸出可能供給・配分需要・FOB価格。**消費市場ごとの産地国シェアではない**（その概念はエンジンに存在しない）。",
    unit: "トン / USD per kg / 比率",
    source: "marketInput.countries + marketResult.hosoPrices",
    layer: "TRUE_WORLD",
    nullableReason: "その国の当該項目が記録されていない場合。",
  },
  {
    field: "companies[].turns[].beginningState / endingState",
    japanese: "期首状態 / 期末状態",
    definition:
      "その四半期の処理**前**と**後**の会社状態。同じ形にしてあるので Beginning → Decision → Result → Ending を同じ軸で比較できる。能力・工場スペースはゲーム本体と同じ関数（computeEffectiveFactories / factorySpace.ts）で導出した値。",
    unit: "USD / トン / 人 / スペース単位",
    source: "CompanyLabState（実行中に capture）",
    layer: "STATE",
    nullableReason: "schemaVersion 1 で保存された古い実行には capture が存在しないため全項目 null。",
  },
  {
    field: "companies[].turns[].observed",
    japanese: "Standard AI が見た値",
    definition: "Standard AI が意思決定の前に実際に持っていた観測値（前期稼働率・想定原料価格・最低現金バッファ目標・市場価格順など）。",
    unit: "項目ごと（unit フィールド参照）",
    source: "StandardAiQuarterDiagnostics.pressures",
    layer: "OBSERVABLE",
    nullableReason: "その値が算出できなかった四半期（値キーそのものを省略する）。",
  },
  {
    field: "companies[].turns[].diagnosis.primaryConstraint / secondaryConstraint",
    japanese: "Standard AI の主要制約 / 第2の制約",
    definition: "Standard AI 自身の状況診断（Situation Diagnosis）が選んだ制約カテゴリ。AI の内部認識であり、実績としての律速とは別物。",
    unit: "カテゴリ名",
    source: "StandardAiQuarterDiagnostics.situationDiagnosis",
    layer: "AI_INTERNAL",
    nullableReason: "診断が記録されていない四半期。",
  },
  {
    field: "companies[].turns[].diagnosis.commercialBottleneck",
    japanese: "実績としての律速要因",
    definition:
      "確定実績の3つの不足量（原料・設備・労働）の大小比較で決まる、実際に生産を律速した要因。同点は 原料 → 設備 → 労働 の順。生成AIによる分類ではない。AI の内部認識（primaryConstraint）とは別概念。",
    unit: "rawMaterial / equipment / labor / none",
    source: "companySummaries の各 shortfall",
    layer: "RESULT",
    nullableReason: "その会社の四半期実績が無い場合。",
  },
  {
    field: "companies[].turns[].wanted.desiredSalesByMarketProduct[].desiredTonsBeforeEffortConstraint",
    japanese: "営業工数制約前の販売希望量",
    definition: "営業人員の工数制約を適用する**前**に Standard AI が出した希望販売量。実際に提出した販売計画（decision）との差が、営業制約による縮小量になる。",
    unit: "HOSO換算トン",
    source: "StandardAiQuarterDiagnostics.salesWishByMarketProduct",
    layer: "AI_INTERNAL",
    nullableReason: "その市場×商品に希望が無かった場合。",
  },
  {
    field: "companies[].turns[].constraints.actionConstraintCodes",
    japanese: "行動を止めた制約（理由コード）",
    definition:
      "Standard AI 自身が付けた理由コード。設備投資については CAPEX_PROPOSED / CAPEX_DEFERRED / CAPEX_DEFERRED_OVERSUPPLY があり、keyValues に各ゲート（financialGate・inventoryGate・ongoingProjectGate・shortfallGate・sustainedGate）の合否が入る。",
    unit: "コード",
    source: "StandardAiQuarterDiagnostics.entries",
    layer: "AI_INTERNAL",
    nullableReason: "理由コードが付かなかった四半期。",
  },
  {
    field: "companies[].turns[].decision.salesAllocationByMarket",
    japanese: "市場別営業人員配置",
    definition:
      "会社×市場の営業人員数。同一市場内の全商品は同じ人数を共有する（sales/salesForce.ts が検証）。合計が総人数に満たない差分は `UNALLOCATED`（未配置）として明示する。engine は「配置合計 ≦ 実在人数」しか要求しておらず、未配置が出るのは正常。",
    unit: "人",
    source: "CompanyDecisionInput.salesPlans[].salesForceHeadcount",
    layer: "DECISION",
    nullableReason: "意思決定が記録されていない四半期。",
  },
  {
    field: "companies[].turns[].financialResult.productEconomics[]",
    japanese: "商品別採算",
    definition:
      "商品別の純売上高・変動費・限界利益・限界利益率・直接固定費。財務モジュールの管理会計レポート（contributionMargin.byProduct）そのままで、この Pack で推測配賦はしていない。",
    unit: "USD / 比率 / トン",
    source: "CompanyFinancialQuarterResult.contributionMargin.byProduct",
    layer: "RESULT",
    nullableReason: "純売上高0の四半期は比率が定義されないため null（0で埋めない）。",
  },
  {
    field: "companies[].turns[].financialResult.totalFixedCostUsd",
    japanese: "固定費合計",
    definition: "固定製造費 ＋ 固定人件費（営業・調達）＋ 固定販管費。これ以外の費用分類は作っていない。",
    unit: "USD",
    source: "ContributionMarginReport",
    layer: "RESULT",
    nullableReason: "財務結果が記録されていない四半期。",
  },
  {
    field: "companies[].turns[].capitalProjects[]",
    japanese: "設備投資案件",
    definition: "期末時点で会社が保持している案件（提案中・建設中・完成・取消）。工期は「支払が成功した四半期数」で進む（暦期間ではない）。",
    unit: "USD / 四半期",
    source: "CapexState.portfolio.projects",
    layer: "STATE",
    nullableReason: "案件が1件も無い場合は空配列。",
  },
  {
    field: "standardAiProposableCapexTypes",
    japanese: "Standard AI が提案しうる投資種別",
    definition:
      "Standard AI の設備投資判断モジュールが提案しうる種別の全て。ここに無い種別（新工場建設・PD省人化など）は、この Standard AI からは**構造的に一度も提案されない**。これはこの実行の結果ではなくコード上の性質である。",
    unit: "種別名",
    source: "standardAi/decision/capex.ts の定数",
    layer: "METADATA",
    nullableReason: "なし。",
  },
];

export function buildDataDictionaryMarkdown(context: AiAnalysisPackContext): string {
  const lines: string[] = [];
  lines.push("# ShrimpX AI Analysis Pack — Data Dictionary");
  lines.push("");
  lines.push(`Pack schema version: \`${context.schemaVersion}\``);
  lines.push("");
  lines.push("## Layers");
  lines.push("");
  lines.push("| Layer | Meaning |");
  lines.push("|---|---|");
  lines.push("| TRUE_WORLD | What actually happened. Only the Game Owner sees this. |");
  lines.push("| OBSERVABLE | What the Standard AI could actually see at that turn (market demand is lagged by 2 quarters). |");
  lines.push("| AI_INTERNAL | The Standard AI's own diagnosis / desired action / constraints. |");
  lines.push("| DECISION | What was actually submitted to the game engine. |");
  lines.push("| RESULT | What happened as a consequence (execution + financial). |");
  lines.push("| STATE | Company state at the beginning / end of the quarter. |");
  lines.push("| METADATA | Properties of the run or of the code, not of a specific quarter. |");
  lines.push("");
  lines.push("**Never compare a decision against TRUE_WORLD alone.** A decision that looks wrong in hindsight may have been reasonable given the OBSERVABLE layer at that turn.");
  lines.push("");

  lines.push("## Units");
  lines.push("");
  lines.push("| Suffix | Unit |");
  lines.push("|---|---|");
  lines.push("| `...Tons` | HOSO換算トン（HOSO-equivalent metric tons） |");
  lines.push("| `...Usd` | USD（絶対額。百万USD表記ではない） |");
  lines.push("| `...UsdPerKg` | USD per HOSO-equivalent kg |");
  lines.push("| `...Ratio` / `...Rate` | 比率（0〜1。パーセントではない） |");
  lines.push("| `...Headcount` / `...Count` | 人数・件数 |");
  lines.push("| `...Units` | 工場スペース単位（ゲーム内の抽象単位） |");
  lines.push("");

  lines.push("## Fields");
  lines.push("");
  lines.push("| Field | 日本語 | Layer | Unit | Definition | Source | Null になる理由 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const e of ENTRIES) {
    lines.push(`| \`${e.field}\` | ${e.japanese} | ${e.layer} | ${e.unit} | ${e.definition} | ${e.source} | ${e.nullableReason} |`);
  }
  lines.push("");

  lines.push("## Major Change Log thresholds");
  lines.push("");
  lines.push("`04_Event_Change_Log.csv` and `majorChanges` only record changes that cross these thresholds. **Raw values for every turn remain in the timelines** — nothing is lost, only the change log is filtered.");
  lines.push("");
  lines.push("| Metric group | Threshold |");
  lines.push("|---|---|");
  lines.push(`| Headcount (sales headcount, market allocation) | absolute ≥ ${MAJOR_CHANGE_THRESHOLDS.headcountAbsolute} person |`);
  lines.push(`| Capacity (tons) | absolute ≥ ${MAJOR_CHANGE_THRESHOLDS.capacityTons} t |`);
  lines.push(`| Money (cash, debt) | relative ≥ ${MAJOR_CHANGE_THRESHOLDS.moneyRelative * 100}% AND absolute ≥ ${MAJOR_CHANGE_THRESHOLDS.moneyAbsoluteUsd.toLocaleString()} USD |`);
  lines.push(`| Market price | relative ≥ ${MAJOR_CHANGE_THRESHOLDS.priceRelative * 100}% |`);
  lines.push(`| Market demand | relative ≥ ${MAJOR_CHANGE_THRESHOLDS.demandRelative * 100}% |`);
  lines.push("| Bottleneck transition / capex event / scenario event | no threshold — always recorded |");
  lines.push("");

  lines.push("## Data availability");
  lines.push("");
  lines.push("| Field | Availability | Reason |");
  lines.push("|---|---|---|");
  for (const note of context.dataAvailability) {
    lines.push(`| \`${note.field}\` | ${note.availability} | ${note.reason} |`);
  }
  lines.push("");
  lines.push("`AVAILABLE` = recorded by the engine. `DERIVED` = deterministically derived from recorded values. `NOT_RECORDED` = the concept exists but this run/dataset does not carry it. `NOT_AVAILABLE` = the concept does not exist in the engine at all.");
  lines.push("");

  return lines.join("\n");
}
