// ShrimpX V2 — 32Q Management Console Phase 2: 共有 analytics layer の型
//
// 【このレイヤーの役割】
// 確定済みの CompanyQuarterRecord（＝ゲームエンジンが既に出した実績）から、
// **画面・将来のxlsx exporter・テストが共通で使える long-format の事実表**を作る。
//
// 【絶対に守る規約】
//  1. ここでゲームの計算をやり直さない。記録から値を取り出すだけ。
//  2. 取得できない値は null のままにする（0 で埋めない・推測値を作らない）。
//  3. TRUE WORLD（実際に成立した需給）と OBSERVABLE（プレイヤー・Standard AI が
//     見られる遅行情報）を **同じ系列として混ぜない**。必ず visibility で区別する。
//  4. 生成AIを呼ばない。分類・要約はすべて決定論的な写像である。
//
// 【long-format にした理由】
// 32Q × 5社 × 複数指標を、画面ごとに別の集計器を書かずに扱うため。
// 同じ行集合を「Excelの1シート＝1行1事実」としてそのまま出力できる形にしてある
// （xlsx exporter は本Phaseでは実装しないが、後から追加してもこの型を変えずに済む）。

import { DemandMarketId, Product } from "../../../market/types";

/** 本 dataset のスキーマ版。保存済み Simulation Run の互換判定に使う。 */
export const SIMULATION_ANALYTICS_SCHEMA_VERSION = "simulationAnalytics-v1";

/**
 * 情報の見え方。
 *  - trueWorld  … 実際に成立した値（ゲーム内部の真実）。Game Owner だけが見る。
 *  - observable … プレイヤー・Standard AI が実際に見られる遅行公開情報。
 *
 * 【Standard AI へ TRUE WORLD を流さない】この区別は表示のためのラベルであり、
 * Standard AI の入力は従来どおり buildPublicMarketInfo 経由の observable のみである
 * （本 analytics layer は意思決定経路に一切登場しない）。
 */
export type MetricVisibility = "trueWorld" | "observable";

/** 1行＝「あるターンの、ある会社の、ある指標の値」。 */
export interface CompanyMetricFact {
  readonly turn: number;
  readonly companyId: string;
  readonly metric: CompanyMetricKey;
  readonly value: number | null;
}

/** 会社指標のキー（画面・exporter の双方がこの一覧だけを使う）。 */
export type CompanyMetricKey =
  | "revenue"
  | "operatingProfit"
  | "netIncome"
  | "cash"
  | "debt"
  | "hosoProduced"
  | "pdProduced"
  | "vapProduced"
  | "newContractedQuantity"
  | "fulfilledQuantity"
  | "outstandingQuantity"
  | "domesticPurchaseQuantity"
  | "rawMaterialInventory"
  | "finishedGoodsInventory"
  | "equipmentUtilizationRate"
  | "laborUtilizationRate"
  | "overtimeRate"
  | "rawMaterialShortfall"
  | "equipmentShortfall"
  | "laborShortfall"
  | "salesHeadcount"
  | "hosoCapacity"
  | "pdCapacity"
  | "vapCapacity"
  | "commonCapacity";

/** 表示順・exporter の列順を一元管理する（画面ごとに順序を作らない）。 */
export const COMPANY_METRIC_KEYS: readonly CompanyMetricKey[] = [
  "revenue",
  "operatingProfit",
  "netIncome",
  "cash",
  "debt",
  "hosoProduced",
  "pdProduced",
  "vapProduced",
  "newContractedQuantity",
  "fulfilledQuantity",
  "outstandingQuantity",
  "domesticPurchaseQuantity",
  "rawMaterialInventory",
  "finishedGoodsInventory",
  "equipmentUtilizationRate",
  "laborUtilizationRate",
  "overtimeRate",
  "rawMaterialShortfall",
  "equipmentShortfall",
  "laborShortfall",
  "salesHeadcount",
  "hosoCapacity",
  "pdCapacity",
  "vapCapacity",
  "commonCapacity",
];

export const COMPANY_METRIC_LABELS: Readonly<Record<CompanyMetricKey, string>> = {
  revenue: "売上高",
  operatingProfit: "営業利益",
  netIncome: "当期純利益",
  cash: "現金",
  debt: "借入残高",
  hosoProduced: "HOSO生産量",
  pdProduced: "PD生産量",
  vapProduced: "VAP生産量",
  newContractedQuantity: "新規成約量",
  fulfilledQuantity: "納品量",
  outstandingQuantity: "未履行残",
  domesticPurchaseQuantity: "国内原料買付量",
  rawMaterialInventory: "原料在庫",
  finishedGoodsInventory: "製品在庫",
  equipmentUtilizationRate: "設備稼働率",
  laborUtilizationRate: "労働稼働率",
  overtimeRate: "残業率",
  rawMaterialShortfall: "原料不足",
  equipmentShortfall: "設備能力不足",
  laborShortfall: "労働力不足",
  salesHeadcount: "営業人員",
  hosoCapacity: "HOSO能力",
  pdCapacity: "PD能力",
  vapCapacity: "VAP能力",
  commonCapacity: "共通処理能力",
};

/** 単位。Excel 出力時に列ヘッダーへ添える。 */
export const COMPANY_METRIC_UNITS: Readonly<Record<CompanyMetricKey, string>> = {
  revenue: "USD",
  operatingProfit: "USD",
  netIncome: "USD",
  cash: "USD",
  debt: "USD",
  hosoProduced: "t",
  pdProduced: "t",
  vapProduced: "t",
  newContractedQuantity: "t",
  fulfilledQuantity: "t",
  outstandingQuantity: "t",
  domesticPurchaseQuantity: "t",
  rawMaterialInventory: "t",
  finishedGoodsInventory: "t",
  equipmentUtilizationRate: "ratio",
  laborUtilizationRate: "ratio",
  overtimeRate: "ratio",
  rawMaterialShortfall: "t",
  equipmentShortfall: "t",
  laborShortfall: "t",
  salesHeadcount: "人",
  hosoCapacity: "t",
  pdCapacity: "t",
  vapCapacity: "t",
  commonCapacity: "t",
};

/** 市場×商品の指標キー。 */
export type MarketMetricKey = "demandQuantity" | "price" | "contractedQuantity" | "externalOptionQuantity";

/**
 * 1行＝「あるターンの、ある市場×商品の、ある指標の値（その見え方つき）」。
 *
 * demandQuantity は visibility によって出所が異なる。
 *  - trueWorld  … salesRecord.allocations[].targetDemand（その四半期に実際に
 *                 ベトナム産が獲得対象にできた需要）。
 *  - observable … marketDemandObservation の2四半期遅行公開値。
 * **両者は別の系列であり、同じ折れ線として繋がない。**
 */
export interface MarketMetricFact {
  readonly turn: number;
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly metric: MarketMetricKey;
  readonly value: number | null;
  readonly visibility: MetricVisibility;
  /** observable の場合、その値が何ターンの実績か（初期市場情報なら null）。 */
  readonly sourceTurn: number | null;
}

/**
 * 産地国の供給データ（GLOBAL PRODUCER DATA）。
 *
 * 【重要・誤認防止】これは **産地国（EC/IN/ID/VN）の生産・輸出能力**であり、
 * 「どの消費市場をどの産地が何％取ったか」という market-country supply share では**ない**。
 * ゲームエンジンは市場×産地国の供給内訳を持っておらず、今回それを捏造しない。
 */
export interface ProducerCountryFact {
  readonly turn: number;
  readonly country: string;
  readonly metric: ProducerCountryMetricKey;
  readonly value: number | null;
}

export type ProducerCountryMetricKey =
  | "production"
  | "exportableSupply"
  | "allocatedDemand"
  | "utilizationRatio"
  | "hosoFobPrice";

export const PRODUCER_COUNTRY_METRIC_LABELS: Readonly<Record<ProducerCountryMetricKey, string>> = {
  production: "生産量（HOSO換算t）",
  exportableSupply: "輸出可能供給量（t）",
  allocatedDemand: "配分需要（t）",
  utilizationRatio: "需給比（配分需要÷輸出可能供給）",
  hosoFobPrice: "HOSO FOB価格（USD/kg）",
};

/**
 * 律速要因の種類。
 *
 * 【生成AIによる分類をしない】この判定は companySummaries に既に記録されている
 * 3つの不足量（原料・設備・労働）の大小比較だけで決まる、完全に決定論的な写像である。
 */
export type BottleneckKind = "rawMaterial" | "equipment" | "labor" | "none";

export const BOTTLENECK_LABELS: Readonly<Record<BottleneckKind, string>> = {
  rawMaterial: "原料不足",
  equipment: "設備能力不足",
  labor: "労働力不足",
  none: "律速なし",
};

export const BOTTLENECK_COLORS: Readonly<Record<BottleneckKind, string>> = {
  rawMaterial: "#f59e0b",
  equipment: "#ef4444",
  labor: "#8b5cf6",
  none: "#1e293b",
};

/** 1行＝「あるターンの、ある会社の律速状況」。 */
export interface BottleneckFact {
  readonly turn: number;
  readonly companyId: string;
  readonly primary: BottleneckKind;
  readonly rawMaterialShortfall: number;
  readonly equipmentShortfall: number;
  readonly laborShortfall: number;
  /** 3不足量の合計に対する主要因の比率（合計0なら null）。 */
  readonly primaryShare: number | null;
}

/**
 * Standard AI の思考6段階。
 *
 * 【新しい巨大な logging system を作らない】6段階は、Standard AI が意思決定の
 * 過程で**既に計算している値**（StandardAiQuarterDiagnostics）と、四半期確定後の
 * 実績（CompanyQuarterRecord）を、段階ごとに詰め替えているだけである。
 * 新たな推論・要約・生成は一切行わない。
 */
export type AiTraceStage = "OBSERVED" | "DIAGNOSED" | "WANTED" | "CONSTRAINED" | "DECIDED" | "RESULT";

export const AI_TRACE_STAGES: readonly AiTraceStage[] = ["OBSERVED", "DIAGNOSED", "WANTED", "CONSTRAINED", "DECIDED", "RESULT"];

export const AI_TRACE_STAGE_LABELS: Readonly<Record<AiTraceStage, string>> = {
  OBSERVED: "① 何を見たか（OBSERVED）",
  DIAGNOSED: "② どう診断したか（DIAGNOSED）",
  WANTED: "③ 何をしたかったか（WANTED）",
  CONSTRAINED: "④ 何に阻まれたか（CONSTRAINED）",
  DECIDED: "⑤ 何を決めたか（DECIDED）",
  RESULT: "⑥ 結果どうなったか（RESULT）",
};

/**
 * AI Trace の1項目。value か text のいずれか（または両方）が入る。
 *
 * 【フィールドを optional にしてある理由】32Q×5社×6段階ぶん保存するため、
 * `"value":null,"unit":null,"text":null` のような空キーが保存量の大半を占めてしまう。
 * 値が無い項目はキー自体を持たせない（JSON.stringify が undefined を落とす）。
 * 「値が無い」ことの意味は null と同じであり、画面側は `?? null` で受ける。
 */
export interface AiTraceItem {
  readonly label: string;
  readonly value?: number;
  readonly unit?: string;
  /** 数値で表せない事実（診断ラベル・理由コード等）。生成文ではない。 */
  readonly text?: string;
}

/** 1行＝「あるターンの、ある会社の、ある段階」。 */
export interface AiTraceFact {
  readonly turn: number;
  readonly companyId: string;
  readonly stage: AiTraceStage;
  readonly items: readonly AiTraceItem[];
}

/** 販売・採用・投資の個別トレース（AI Trace の下に並べる詳細）。 */
export interface SalesTraceFact {
  readonly turn: number;
  readonly companyId: string;
  readonly market: DemandMarketId;
  readonly product: Product;
  /** 営業工数制約を適用する**前**の希望量。 */
  readonly wishedQuantity: number | null;
  /** 実際に提出された販売計画量。 */
  readonly plannedQuantity: number | null;
  /** 実際に成約した量。 */
  readonly contractedQuantity: number | null;
}

export interface HiringTraceFact {
  readonly turn: number;
  readonly companyId: string;
  readonly salesForceHireCount: number;
  readonly salesForceLayoffCount: number;
  readonly endingSalesHeadcount: number | null;
  readonly totalTemporaryWorkers: number;
  readonly averageOvertimeRate: number | null;
}

export interface InvestmentTraceFact {
  readonly turn: number;
  readonly companyId: string;
  readonly projectId: string;
  readonly projectType: string;
  /** capex/capexClose.ts が記録した状態遷移をそのまま載せる。 */
  readonly status: string;
  readonly budgetUsd: number | null;
  readonly note: string | null;
}

/** Simulation Run 1本ぶんの事実表一式。 */
export interface SimulationAnalyticsDataset {
  readonly schemaVersion: string;
  readonly turns: readonly number[];
  readonly companies: readonly { readonly companyId: string; readonly displayName: string; readonly color: string }[];
  readonly companyMetrics: readonly CompanyMetricFact[];
  readonly marketMetrics: readonly MarketMetricFact[];
  readonly producerCountryMetrics: readonly ProducerCountryFact[];
  readonly bottlenecks: readonly BottleneckFact[];
  readonly aiTrace: readonly AiTraceFact[];
  readonly salesTrace: readonly SalesTraceFact[];
  readonly hiringTrace: readonly HiringTraceFact[];
  readonly investmentTrace: readonly InvestmentTraceFact[];
}
