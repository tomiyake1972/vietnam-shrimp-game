// ShrimpX V2 — Phase SAI-3B-1: reason code カタログ（既存registryの参照のみ）
//
// 三宅さんの指示「reason codeの意味は既存レジストリを参照し、Excel側で別定義を
// 作って不整合を起こさないでください」に対応する。コード一覧・ドメイン分類は
// 既存の STANDARD_AI_REASON_CODES（standardAi/reasonCodes.ts）・
// CompanyReasonCode（companyLab/types.ts）・categorizeStandardAiReasonCode /
// categorizeCompanyReasonCode（autoplay/reasonTaxonomy.ts）をそのまま再利用する。
// 説明文（description）は、各registryファイルに既に書かれているインラインコメントを
// そのまま転記したものであり、新しい意味づけを行っていない。

import { STANDARD_AI_REASON_CODES } from "../reasonCodes";
import { CompanyReasonCode } from "../../types";
import { categorizeCompanyReasonCode, categorizeStandardAiReasonCode } from "../autoplay/reasonTaxonomy";

export interface ReasonCodeCatalogEntry {
  readonly code: string;
  readonly source: "standardAi" | "companyLab";
  readonly domain: string;
  readonly description: string;
}

// standardAi/reasonCodes.ts のインラインコメントをそのまま転記（新規の意味づけなし）。
const STANDARD_AI_DESCRIPTIONS: Readonly<Record<string, string>> = {
  CONTRACT_FULFILLMENT_PRIORITY: "未履行契約の履行を優先",
  FINISHED_GOODS_EXCESS: "完成品在庫過剰",
  CAPACITY_CONSTRAINT: "設備・原料・労働能力による制約",
  RAW_MATERIAL_SHORTAGE: "原料不足",
  PROCUREMENT_INCREASED_FOR_SHORTAGE: "原料不足のため調達量を増加",
  PROCUREMENT_REDUCED_FOR_EXCESS: "原料在庫過剰のため調達量を抑制",
  PROCUREMENT_CASH_CONSTRAINED: "資金制約により調達を必要最小限に抑制",
  PRICE_REDUCTION_FOR_EXCESS_STOCK: "完成品在庫過剰のため値引き",
  SALES_REDUCED_FOR_SUPPLY_LIMIT: "供給余力不足のため販売希望量を抑制",
  LOW_ORDER_BOOK_PREMIUM_FLOOR: "市場プレミアムが最低受注水準未満のため販売提案を停止",
  SALES_HEADCOUNT_INSUFFICIENT_TOTAL: "実在する営業人員総数が全市場の必要工数に対し不足",
  VAP_MIX_INCREASES_SALES_EFFORT_NEED: "VAP比率上昇により当該市場の必要営業工数が増加",
  WORKER_CAPACITY_SHORTAGE: "ワーカー能力不足",
  OVERTIME_TEMP_FOR_TRANSIENT_SHORTAGE: "一時的な不足に対する残業・臨時ワーカー対応",
  HIRING_FOR_SUSTAINED_SHORTAGE: "持続的な不足に対する正社員採用",
  HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS: "持続的な過剰人員の縮小",
  CASH_BUFFER_SHORTAGE: "最低現金水準を下回る見込みのため借入",
  WORKING_CAPITAL_ASSESSED: "短期運転資金の必要額と充足状況を評価",
  DEBT_REPAYMENT_SURPLUS: "現金余剰のため任意期限前返済",
  CAPEX_DEFERRED: "設備投資を見送り（既定の正常な結果）",
  CAPEX_PROPOSED: "持続的なボトルネック解消のため設備投資を提案",
  // 【SAI-5】市場・商品志向／ライフサイクル／営業基盤／供給圧力
  MARKET_ORIENTATION_APPLIED: "市場志向倍率による市場間の再配分を適用",
  PRODUCT_ORIENTATION_APPLIED: "商品志向倍率による商品別目標数量の補正を適用",
  LIFECYCLE_GROWTH_PURSUED: "公開ライフサイクルトレンドの成長を捉えるため販売・投資を前傾",
  SALES_BASE_ADVANTAGE: "蓄積した営業基盤の優位を販売計画に反映",
  SUPPLY_PRESSURE_RETREAT: "公開供給圧力の高止まりを受けて販売・投資を抑制",
  CAPEX_DEFERRED_OVERSUPPLY: "供給過剰シグナルにより設備投資を見送り",
  CAPEX_RESUME_PROPOSED: "資金回復により中断中の設備投資案件の再開を提案",
  VAP_GROWTH_ENTRY: "VAP需要の成長局面を捉えるためVAP能力・販売へ参入",
  VAP_OVERSUPPLY_RETREAT: "VAP供給過剰局面のためVAP拡大を抑制",
  PD_CAPACITY_MAINTAINED: "PD能力の維持を選択（VAP転換へ追随しない）",
};

// companyLab/types.ts のインラインコメントをそのまま転記（新規の意味づけなし）。
const COMPANY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  LOW_PRICE_WON_SHARE: "安値提示により成約増",
  SALES_FORCE_SHORTAGE: "営業能力不足",
  DOMESTIC_COMPETITION_INTENSE: "国内買付競争激化",
  RAW_MATERIAL_SHORTAGE: "原料不足",
  IMPORT_IN_TRANSIT: "輸入到着待ち",
  EQUIPMENT_CAPACITY_SHORTAGE: "設備能力不足",
  LABOR_SHORTAGE: "ワーカー不足",
  OVERTIME_CAP_REACHED: "残業上限到達",
  VAP_SUPPLY_INCREASE_LOWERS_PREMIUM: "VAP供給増加によるプレミアム低下",
  PD_SUPPLY_INCREASE_LOWERS_PREMIUM: "PD供給増加によるプレミアム低下",
  OVER_CONTRACTED_OVERDUE: "契約過多による納期超過",
  DISEASE_HARVEST_LOSS: "疾病による養殖収穫減",
  AQUACULTURE_HARVEST_ON_TRACK: "養殖収穫が計画どおり",
  SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY: "市場別営業工数換算能力の不足により販売計画が縮小された",
};

const COMPANY_REASON_CODES: readonly CompanyReasonCode[] = [
  "LOW_PRICE_WON_SHARE",
  "SALES_FORCE_SHORTAGE",
  "DOMESTIC_COMPETITION_INTENSE",
  "RAW_MATERIAL_SHORTAGE",
  "IMPORT_IN_TRANSIT",
  "EQUIPMENT_CAPACITY_SHORTAGE",
  "LABOR_SHORTAGE",
  "OVERTIME_CAP_REACHED",
  "VAP_SUPPLY_INCREASE_LOWERS_PREMIUM",
  "PD_SUPPLY_INCREASE_LOWERS_PREMIUM",
  "OVER_CONTRACTED_OVERDUE",
  "DISEASE_HARVEST_LOSS",
  "AQUACULTURE_HARVEST_ON_TRACK",
  "SALES_PLAN_REDUCED_FOR_EFFORT_CAPACITY",
];

/** 既存2レジストリ（StandardAiReasonCode・CompanyReasonCode）に定義済みの
 *  全コードのカタログ（説明文・ドメイン分類つき）。新しいコードは作らない。 */
export const REASON_CODE_CATALOG: readonly ReasonCodeCatalogEntry[] = [
  ...STANDARD_AI_REASON_CODES.map((code) => ({
    code,
    source: "standardAi" as const,
    domain: categorizeStandardAiReasonCode(code),
    description: STANDARD_AI_DESCRIPTIONS[code] ?? "(説明未登録)",
  })),
  ...COMPANY_REASON_CODES.map((code) => ({
    code,
    source: "companyLab" as const,
    domain: categorizeCompanyReasonCode(code),
    description: COMPANY_DESCRIPTIONS[code] ?? "(説明未登録)",
  })),
];

const CATALOG_BY_CODE_AND_SOURCE = new Map<string, ReasonCodeCatalogEntry>(
  REASON_CODE_CATALOG.map((e) => [`${e.source}::${e.code}`, e])
);

/** ログ中に実際に出現したコード・sourceから、カタログ情報を引く。
 *  未登録のコード（将来の拡張等）が来た場合は捏造せず"(説明未登録)"を返す。 */
export function lookupReasonCode(code: string, source: string): ReasonCodeCatalogEntry {
  const found = CATALOG_BY_CODE_AND_SOURCE.get(`${source}::${code}`);
  if (found) return found;
  // sourceが不明・省略されている既存ログとの互換のため、source非依存でも探索する。
  const anySource = REASON_CODE_CATALOG.find((e) => e.code === code);
  if (anySource) return anySource;
  return { code, source: source as "standardAi" | "companyLab", domain: "other", description: "(説明未登録: 既存レジストリに見つかりません)" };
}
