// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 理由コード
//
// 各意思決定には、人間向けの日本語説明文に加えて、構造化された理由コードを
// 付与する（対象ドメイン・重大度・鍵となる事前値・発火した閾値・結果の意思決定・
// 簡潔な説明をセットで保持する）。これは今回のUI実装の対象ではないが、将来の
// 圧力値フレームワーク・AI取締役会機能・プレイヤー向け説明・テスト結果分析で
// 再利用できるよう、意図的に汎用的な構造にしてある。

export type StandardAiDomain = "procurement" | "sales" | "production" | "labor" | "finance" | "capex" | "diagnosis";

export type StandardAiSeverity = "info" | "warning" | "critical";

/**
 * 理由コード一覧。例示（実装指示）のコードをそのまま採用し、SAI-1の各ドメイン
 * 判断に必要な残りのコードを、同じ命名規則（対象_状態）で追加した。
 */
export type StandardAiReasonCode =
  // --- 契約履行・生産・販売共通 ---
  | "CONTRACT_FULFILLMENT_PRIORITY" // 未履行契約の履行を優先
  | "FINISHED_GOODS_EXCESS" // 完成品在庫過剰
  | "CAPACITY_CONSTRAINT" // 設備・原料・労働能力による制約
  | "SHARED_CAPACITY_CONSTRAINT" // 【2026-08-02新設】共通前処理・凍結包装等の共有ボトルネックの実効能力により生産計画全体を縮小
  // --- 原料調達 ---
  | "RAW_MATERIAL_SHORTAGE" // 原料不足
  | "PROCUREMENT_INCREASED_FOR_SHORTAGE" // 原料不足のため調達量を増加
  | "PROCUREMENT_REDUCED_FOR_EXCESS" // 原料在庫過剰のため調達量を抑制
  | "PROCUREMENT_CASH_CONSTRAINED" // 資金制約により調達を必要最小限に抑制
  // --- 販売 ---
  | "PRICE_REDUCTION_FOR_EXCESS_STOCK" // 完成品在庫過剰のため値引き
  | "SALES_REDUCED_FOR_SUPPLY_LIMIT" // 供給余力不足のため販売希望量を抑制
  | "LOW_ORDER_BOOK_PREMIUM_FLOOR" // 市場プレミアムが最低受注水準未満のため販売提案を停止
  // --- 販売（SAI-2追加作業: 市場別営業配置・商品別営業工数） ---
  | "SALES_HEADCOUNT_INSUFFICIENT_TOTAL" // 実在する営業人員総数が全市場の必要工数に対し不足
  | "VAP_MIX_INCREASES_SALES_EFFORT_NEED" // VAP比率上昇により当該市場の必要営業工数が増加
  // --- 労働 ---
  | "WORKER_CAPACITY_SHORTAGE" // ワーカー能力不足
  | "OVERTIME_TEMP_FOR_TRANSIENT_SHORTAGE" // 一時的な不足に対する残業・臨時ワーカー対応
  | "HIRING_FOR_SUSTAINED_SHORTAGE" // 持続的な不足に対する正社員採用
  | "HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS" // 持続的な過剰人員の縮小
  // --- 資金繰り ---
  | "CASH_BUFFER_SHORTAGE" // 最低現金水準を下回る見込みのため借入
  | "DEBT_REPAYMENT_SURPLUS" // 現金余剰のため任意期限前返済
  // --- 設備投資 ---
  | "CAPEX_DEFERRED" // 設備投資を見送り（既定の正常な結果）
  | "CAPEX_PROPOSED" // 持続的なボトルネック解消のため設備投資を提案
  // --- 【SAI-5】市場・商品志向／ライフサイクル／営業基盤／供給圧力 ---
  | "MARKET_ORIENTATION_APPLIED" // 市場志向倍率による市場間の再配分を適用
  | "PRODUCT_ORIENTATION_APPLIED" // 商品志向倍率による商品別目標数量の補正を適用
  | "LIFECYCLE_GROWTH_PURSUED" // 公開ライフサイクルトレンドの成長を捉えるため販売・投資を前傾
  | "SALES_BASE_ADVANTAGE" // 蓄積した営業基盤の優位を販売計画に反映
  | "SUPPLY_PRESSURE_RETREAT" // 公開供給圧力の高止まりを受けて販売・投資を抑制
  | "CAPEX_DEFERRED_OVERSUPPLY" // 供給過剰シグナルにより設備投資を見送り
  | "CAPEX_RESUME_PROPOSED" // 資金回復により中断中の設備投資案件の再開を提案
  | "VAP_GROWTH_ENTRY" // VAP需要の成長局面を捉えるためVAP能力・販売へ参入
  | "VAP_OVERSUPPLY_RETREAT" // VAP供給過剰局面のためVAP拡大を抑制
  | "PD_CAPACITY_MAINTAINED" // PD能力の維持を選択（VAP転換へ追随しない）
  // --- 【SAI-6.1新設】Situation Diagnosis（不足型／過剰型の6カテゴリ診断） ---
  | "SALES_FORCE_BINDING_CONSTRAINT" // 営業（現実的販売可能量が理論販売機会を大きく下回る）が支配的制約
  | "PRODUCTION_CAPACITY_HEADROOM" // 生産能力に余力がある（過剰型）
  | "PRODUCTION_CAPACITY_BINDING_CONSTRAINT" // 生産能力が支配的制約（不足型）
  | "WORKER_SURPLUS" // Workerに余力がある（過剰型）
  | "WORKER_SHORTAGE_DIAGNOSED" // Worker不足が診断された（不足型。labor.tsの既存WORKER_CAPACITY_SHORTAGEとは独立した診断層側の判定）
  | "INVENTORY_EXCESS" // 完成品在庫が通常在庫目標を大きく超えている（過剰型）
  | "LIQUIDITY_CONSTRAINT" // 資金制約が支配的（不足型）
  | "CURRENT_PERIOD_DELIVERY_DEMAND_PROXY" // currentPeriodDeliveryDemandが暫定proxy（現行salesPlans+当期契約）であることの明示
  | "PRODUCTION_CAPACITY_RECOGNITION_GAP" // Standard AIが参照する能力（ノミナル）と実効能力（0.855係数適用後）に差がある
  // --- 【SAI-6.4修正】原料診断の意味修正（procurement need と supply constraint の分離） ---
  | "RAW_MATERIAL_PROCUREMENT_NEEDED" // 期首在庫＋確定入荷だけでは必要量に届かないが、当期中の通常の追加調達行為で解決可能（ボトルネックではない）
  | "RAW_MATERIAL_SUPPLY_CONSTRAINT_UNKNOWN" // 前四半期の国内市場公開清算結果が観測に存在しない（turn1等）ため、真の供給制約かどうかは不明（原料不足と断定しない）
  | "DOMESTIC_MARKET_PUBLIC_SURPLUS" // 【2026-08-03新設】前四半期の国内市場売れ残り供給が当期の調達不足分を上回る（市場全体は緩い。company-specific availabilityは別途unknown）
  | "DOMESTIC_MARKET_PUBLIC_TIGHT" // 【2026-08-03新設】前四半期の国内市場売れ残り供給が当期の調達不足分に届かない（市場全体もタイト。真の供給制約の可能性）
  | "DOMESTIC_COMPANY_PURCHASE_CAP_UNKNOWN" // 【2026-08-03新設】この会社が実際に国内市場から購入できる上限（買い手シェア上限等）は常にunknown（市場全体がsurplusでも会社個別の確実な調達可能性は保証しない）
  // --- 【SAI-6.4修正】資金診断の意味修正（現金バッファのみでは資金制約と断定しない） ---
  | "CASH_BUFFER_BELOW_TARGET" // 現金が会社規模連動の最低現金バッファを下回るが、借入余力を含めた資金調達力全体は今回未接続のため、これのみでは資金制約と断定しない（primary/secondary制約候補には含めない）
  // --- 【2026-08-03新設・Phase B】Forward Unit Economics 3区分採算分類 ---
  | "FULL_COST_PROFITABLE" // 製造フルコスト（変動費＋配賦固定費）を上回る参照売価で、貢献利益・フルコストマージンともに正
  | "CONTRIBUTION_ONLY_OPPORTUNITY" // 貢献利益は正だが製造フルコスト（配賦固定費込み）は下回る（短期的には受注価値があるが、フルコスト回収には至らない）
  | "UNECONOMIC_NEW_SALES" // 貢献利益自体が負（原料費＋原料以外の変動費すら参照売価で回収できない）で、新規販売は非経済的
  // --- 【2026-08-05新設】営業採用・減員（Standard AI経営ボトルネック判定） ---
  | "SALES_HIRING_PROFITABLE_UNSERVED_OPPORTUNITY" // 収益性のある未充足の販売機会があり、生産・原料・資金のいずれのボトルネックにも達しないため営業採用を提案
  | "SALES_HIRING_BLOCKED_BY_PRODUCTION" // 販売機会はあるが生産能力(binding capacity)に余力がないため営業採用を見送り
  | "SALES_HIRING_BLOCKED_BY_LIQUIDITY" // 追加採用の給与コストが当期の最低現金バッファ余力を超えるため営業採用を見送り
  | "SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY" // 追加販売に必要な新規生産の原料について真の供給制約が診断されているため営業採用を見送り
  | "SALES_HIRING_NOT_ECONOMIC" // 追加1人あたりのmarginal contributionが給与を下回るため営業採用が経済的でない
  | "SALES_FORCE_EXCESS_CAPACITY" // 持続的な営業容量過剰（追加販売機会が乏しく在庫も制約でない）と診断
  | "SALES_LAYOFF_ECONOMIC_AFTER_SEVERANCE" // 退職金を考慮しても節約効果が上回るため営業減員が経済的
  | "SALES_LAYOFF_DEFERRED_STRATEGIC_CAPACITY" // 在庫が販売のボトルネックになっているため、容量過剰に見えても減員を見送り（戦略的容量の保持）
  // --- 【2026-08-05新設】Strategic Intent / Target Scale Band ---
  | "STRATEGIC_TARGET_SCALE_SET" // Strategic Intent（成長姿勢）からTarget Scale Bandを算定した
  | "SALES_CAPACITY_BELOW_TARGET_SCALE" // 現在の実効営業能力（realistic sales相当）がTarget Scale帯のminを下回る
  | "SALES_CAPACITY_WITHIN_TARGET_BAND" // 現在の実効営業能力がTarget Scale帯の範囲内（許容乖離込み）にある
  | "SALES_CAPACITY_ABOVE_TARGET_SCALE" // 現在の実効営業能力がTarget Scale帯のmaxを上回る
  | "PRODUCTION_CAPACITY_BELOW_TARGET_SCALE" // 現在の実効生産能力がTarget Scale（preferred）を下回り、稼働中の設備投資も無い
  | "FUTURE_CAPEX_SUPPORTS_TARGET_SCALE" // 現在の実効生産能力はTarget Scaleに届かないが、稼働中の設備投資案件がありその不足を将来解消する見込み
  | "SALES_HIRING_LIMITED_BY_TARGET_SCALE" // Target Scale帯の上限相当の販売量に既に達しているため、限界利益が正でもこれ以上の営業採用を提案しない
  | "SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION" // 生産能力側がTarget Scaleに届いておらず、かつ近い将来の設備拡張の見込みも無いため、営業採用をTarget Scale方向へ進めることを見送る
  | "FINANCEABLE_SCALE_BELOW_STRATEGIC_TARGET"; // Target Scale自体は維持しつつ、現在の資金体力から見た現実的な規模はそれを下回ると診断する

export const STANDARD_AI_REASON_CODES: readonly StandardAiReasonCode[] = [
  "CONTRACT_FULFILLMENT_PRIORITY",
  "FINISHED_GOODS_EXCESS",
  "CAPACITY_CONSTRAINT",
  "SHARED_CAPACITY_CONSTRAINT",
  "RAW_MATERIAL_SHORTAGE",
  "PROCUREMENT_INCREASED_FOR_SHORTAGE",
  "PROCUREMENT_REDUCED_FOR_EXCESS",
  "PROCUREMENT_CASH_CONSTRAINED",
  "PRICE_REDUCTION_FOR_EXCESS_STOCK",
  "SALES_REDUCED_FOR_SUPPLY_LIMIT",
  "LOW_ORDER_BOOK_PREMIUM_FLOOR",
  "SALES_HEADCOUNT_INSUFFICIENT_TOTAL",
  "VAP_MIX_INCREASES_SALES_EFFORT_NEED",
  "WORKER_CAPACITY_SHORTAGE",
  "OVERTIME_TEMP_FOR_TRANSIENT_SHORTAGE",
  "HIRING_FOR_SUSTAINED_SHORTAGE",
  "HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS",
  "CASH_BUFFER_SHORTAGE",
  "DEBT_REPAYMENT_SURPLUS",
  "CAPEX_DEFERRED",
  "CAPEX_PROPOSED",
  "MARKET_ORIENTATION_APPLIED",
  "PRODUCT_ORIENTATION_APPLIED",
  "LIFECYCLE_GROWTH_PURSUED",
  "SALES_BASE_ADVANTAGE",
  "SUPPLY_PRESSURE_RETREAT",
  "CAPEX_DEFERRED_OVERSUPPLY",
  "CAPEX_RESUME_PROPOSED",
  "VAP_GROWTH_ENTRY",
  "VAP_OVERSUPPLY_RETREAT",
  "PD_CAPACITY_MAINTAINED",
  "SALES_FORCE_BINDING_CONSTRAINT",
  "PRODUCTION_CAPACITY_HEADROOM",
  "PRODUCTION_CAPACITY_BINDING_CONSTRAINT",
  "WORKER_SURPLUS",
  "WORKER_SHORTAGE_DIAGNOSED",
  "INVENTORY_EXCESS",
  "LIQUIDITY_CONSTRAINT",
  "CURRENT_PERIOD_DELIVERY_DEMAND_PROXY",
  "PRODUCTION_CAPACITY_RECOGNITION_GAP",
  "RAW_MATERIAL_PROCUREMENT_NEEDED",
  "RAW_MATERIAL_SUPPLY_CONSTRAINT_UNKNOWN",
  "DOMESTIC_MARKET_PUBLIC_SURPLUS",
  "DOMESTIC_MARKET_PUBLIC_TIGHT",
  "DOMESTIC_COMPANY_PURCHASE_CAP_UNKNOWN",
  "CASH_BUFFER_BELOW_TARGET",
  "FULL_COST_PROFITABLE",
  "CONTRIBUTION_ONLY_OPPORTUNITY",
  "UNECONOMIC_NEW_SALES",
  "SALES_HIRING_PROFITABLE_UNSERVED_OPPORTUNITY",
  "SALES_HIRING_BLOCKED_BY_PRODUCTION",
  "SALES_HIRING_BLOCKED_BY_LIQUIDITY",
  "SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY",
  "SALES_HIRING_NOT_ECONOMIC",
  "SALES_FORCE_EXCESS_CAPACITY",
  "SALES_LAYOFF_ECONOMIC_AFTER_SEVERANCE",
  "SALES_LAYOFF_DEFERRED_STRATEGIC_CAPACITY",
  "STRATEGIC_TARGET_SCALE_SET",
  "SALES_CAPACITY_BELOW_TARGET_SCALE",
  "SALES_CAPACITY_WITHIN_TARGET_BAND",
  "SALES_CAPACITY_ABOVE_TARGET_SCALE",
  "PRODUCTION_CAPACITY_BELOW_TARGET_SCALE",
  "FUTURE_CAPEX_SUPPORTS_TARGET_SCALE",
  "SALES_HIRING_LIMITED_BY_TARGET_SCALE",
  "SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION",
  "FINANCEABLE_SCALE_BELOW_STRATEGIC_TARGET",
];

/** 1件の意思決定理由（診断用。会社ラボの既存CompanyReasonEntryとは独立した、SAI-1専用の詳細版）。 */
export interface StandardAiDiagnosticEntry {
  readonly code: StandardAiReasonCode;
  readonly domain: StandardAiDomain;
  readonly companyId: string;
  readonly severity: StandardAiSeverity;
  /** この判断の鍵となる事前値（診断・監査用。単位はkeyValueUnitsを参照）。 */
  readonly keyValues?: Readonly<Record<string, number>>;
  /** 発火した閾値（該当する場合）。 */
  readonly threshold?: number;
  /** 結果として生成された意思決定の簡潔な要約（例: "VAP生産を+120トン増"）。 */
  readonly decisionSummary?: string;
  /** 人間向けの簡潔な日本語説明。 */
  readonly message: string;
}
