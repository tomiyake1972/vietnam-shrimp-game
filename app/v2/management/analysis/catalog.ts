// ShrimpX V2 — 分析項目のカタログ（Analysis Home の索引と、各画面のナビの唯一の情報源）
//
// 【1画面＝1URL】各分析は独立した route を持つ。Analysis Home はそこへの索引であり、
// 「詳細を見る画面」ではない。リンクは通常の <a href> として描くため、
// Ctrl+Click・中クリック・「新しいタブで開く」がそのまま使える。

export interface AnalysisItem {
  readonly path: string;
  readonly label: string;
  /** 未実装のものは false。索引には出すが、中身があるように見せない。 */
  readonly implemented: boolean;
  readonly note?: string;
}

export interface AnalysisCategory {
  readonly key: string;
  readonly label: string;
  readonly items: readonly AnalysisItem[];
}

const BASE = "/v2/management/analysis";

export const ANALYSIS_CATEGORIES: readonly AnalysisCategory[] = [
  {
    key: "market",
    label: "市場",
    items: [
      { path: `${BASE}/prices`, label: "市場別 × 商品別 価格推移", implemented: true },
      { path: `${BASE}/market`, label: "商品別需要推移（TRUE / OBSERVABLE）", implemented: true },
      { path: `${BASE}/market`, label: "GLOBAL PRODUCER DATA（産地国）", implemented: true },
    ],
  },
  {
    key: "profitability",
    label: "収益性",
    items: [
      { path: `${BASE}/contribution`, label: "各社 × 商品別 限界利益率", implemented: true },
      { path: `${BASE}/fixed-cost`, label: "各社 固定費推移", implemented: true },
      { path: `${BASE}/overview`, label: "営業利益・純利益推移（Overview）", implemented: true },
    ],
  },
  {
    key: "sales",
    label: "営業",
    items: [
      { path: `${BASE}/sales-headcount`, label: "各社 総営業人員数推移", implemented: true },
      { path: `${BASE}/sales-allocation`, label: "各社 市場別 営業人員配置", implemented: true },
      { path: `${BASE}/ai-trace`, label: "販売トレース（希望 → 計画 → 成約）", implemented: true },
      { path: "", label: "Sales Capacity / Hiring Diagnostics", implemented: false, note: "営業工数換算能力の専用画面は今後のPhase" },
    ],
  },
  {
    key: "operations",
    label: "生産・オペレーション",
    items: [
      { path: `${BASE}/bottleneck`, label: "律速ヒートマップ・遷移", implemented: true },
      { path: `${BASE}/overview`, label: "生産量・稼働率・能力（Overview の指標切替）", implemented: true },
      { path: "", label: "工場別オペレーション詳細", implemented: false, note: "今後のPhase" },
    ],
  },
  {
    key: "investment",
    label: "投資",
    items: [
      { path: `${BASE}/ai-trace`, label: "投資トレース（案件・状態遷移・却下理由）", implemented: true },
      { path: "", label: "設備能力の増設経路・投資回収", implemented: false, note: "今後のPhase" },
    ],
  },
  {
    key: "finance",
    label: "財務",
    items: [
      { path: `${BASE}/overview`, label: "現金・借入残高推移（Overview の指標切替）", implemented: true },
      { path: "", label: "PL / BS / CF 明細", implemented: false, note: "今後のPhase" },
    ],
  },
  {
    key: "standardAi",
    label: "Standard AI",
    items: [{ path: `${BASE}/ai-trace`, label: "AI Trace（6段階）", implemented: true }],
  },
  {
    key: "scenario",
    label: "Scenario",
    items: [{ path: "", label: "シナリオイベント・環境変化", implemented: false, note: "今後のPhase" }],
  },
];

/** Quick Navigation（1クリックで主要分析へ）。 */
export const QUICK_NAVIGATION: readonly { readonly path: string; readonly label: string; readonly testId: string }[] = [
  { path: `${BASE}/prices`, label: "商品別価格", testId: "quicknav-prices" },
  { path: `${BASE}/contribution`, label: "商品別限界利益", testId: "quicknav-contribution" },
  { path: `${BASE}/fixed-cost`, label: "固定費", testId: "quicknav-fixed-cost" },
  { path: `${BASE}/sales-headcount`, label: "営業人数", testId: "quicknav-sales-headcount" },
  { path: `${BASE}/sales-allocation`, label: "営業配置", testId: "quicknav-sales-allocation" },
];
