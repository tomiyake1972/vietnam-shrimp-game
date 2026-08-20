// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 理由コード
//
// 各意思決定には、人間向けの日本語説明文に加えて、構造化された理由コードを
// 付与する（対象ドメイン・重大度・鍵となる事前値・発火した閾値・結果の意思決定・
// 簡潔な説明をセットで保持する）。これは今回のUI実装の対象ではないが、将来の
// 圧力値フレームワーク・AI取締役会機能・プレイヤー向け説明・テスト結果分析で
// 再利用できるよう、意図的に汎用的な構造にしてある。

export type StandardAiDomain = "procurement" | "sales" | "production" | "labor" | "finance" | "capex" | "diagnosis" | "crisis" | "profile";

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
  | "CAPEX_DEFERRED_INSUFFICIENT_SPACE" // 【Phase 6D-1新設】既存増設候補が工場スペース不足のため提案しない（承認ゲートで却下され続ける空提案を出さない）
  // --- 原料調達 ---
  | "RAW_MATERIAL_SHORTAGE" // 原料不足
  | "PROCUREMENT_INCREASED_FOR_SHORTAGE" // 原料不足のため調達量を増加
  | "PROCUREMENT_REDUCED_FOR_EXCESS" // 原料在庫過剰のため調達量を抑制
  | "PROCUREMENT_CASH_CONSTRAINED" // 資金制約により調達を必要最小限に抑制
  // --- 販売 ---
  | "PRICE_REDUCTION_FOR_EXCESS_STOCK" // 完成品在庫過剰のため値引き
  | "SALES_REDUCED_FOR_SUPPLY_LIMIT" // 供給余力不足のため販売希望量を抑制
  | "LOW_ORDER_BOOK_PREMIUM_FLOOR" // 市場プレミアムが最低受注水準未満のため販売提案を停止
  | "MARKET_ALLOCATION_BY_OBSERVED_OPPORTUNITY"
  /** 市場別の機会スコアの内訳（観測需要・獲得可能需要・期待貢献・重み）。説明可能性のための一次情報。 */
  | "MARKET_OPPORTUNITY_COMPONENTS"
  /** 営業能力の総量・使用量・未使用量（採りすぎ／遊休の機械的検出用）。 */
  | "SALES_CAPACITY_UTILIZATION" // 【Batch 002】観測需要（2Q遅行）と採算性から市場別按分重みを決定
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
  | "WORKING_CAPITAL_ASSESSED" // 【Test16】短期運転資金（原料調達・人件費・買掛・元利返済 vs 現金・売掛回収）の評価
  | "DEBT_REPAYMENT_SURPLUS" // 現金余剰のため任意期限前返済
  // --- 設備投資 ---
  | "CAPEX_DEFERRED" // 設備投資を見送り（既定の正常な結果）
  | "CAPEX_PROPOSED" // 持続的なボトルネック解消のため設備投資を提案
  // --- 【Phase DIV-3／DIV-4】Standard AI配当ポリシー ---
  | "DIVIDEND_PROPOSED" // 基準配当ルールの全条件を満たしたため配当を実施
  | "DIVIDEND_SKIPPED_NOT_ANNUAL_PERIOD" // 【DIV-4】当期が年度末（Q4）ではないため配当を検討しない
  | "DIVIDEND_SKIPPED_NOT_HEALTHY" // 前Turnの財務健全性がhealthyでない（未確定を含む）ため配当を見送り
  | "DIVIDEND_SKIPPED_CRISIS" // 【DIV-4】Crisis State（LIQUIDITY_STRESS/SEVERE_DISTRESS）のため配当を見送り
  | "DIVIDEND_SKIPPED_CAPEX_PLANNED" // 当期に新規設備投資（増設・新工場）を提案しているため配当を見送り
  | "DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS" // 【DIV-4】直近確定四半期の当期純利益が正でないため配当を見送り（累計利益は取り崩さない）
  | "DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS" // 分配可能利益（または配当可能上限）が正でないため配当を見送り
  | "DIVIDEND_SKIPPED_INVALID_FINANCIAL_INPUT" // 【INT-NA】配当判定の入力（分配可能利益・現金・当期純利益）が有限数でないため配当を見送り
  | "DIVIDEND_LIMITED_BY_DISTRIBUTABLE_EARNINGS" // 【DIV-4】当期純利益基準の配当額が累計分配可能利益を超えたため、分配可能利益まで縮小
  | "DIVIDEND_LIMITED_BY_MAX" // 基準配当額が配当可能上限（min(Cash, 分配可能利益)）を超えたため上限でクランプ
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
  | "FINANCEABLE_SCALE_BELOW_STRATEGIC_TARGET" // Target Scale自体は維持しつつ、現在の資金体力から見た現実的な規模はそれを下回ると診断する
  // --- 【2026-08-09新設】Vision駆動の戦略成長・新工場判断 ---
  // 【重要】ここは「建てた理由」だけでなく「建てなかった理由」も等しく記録する。
  // 見送りは異常ではなく、経営判断としての正常な結果である。
  | "VISION_GROWTH_GAP" // Visionの参照成長軌道に対して現在の持続可能規模が不足している
  | "VISION_ON_TRACK" // Visionの参照成長軌道に対して遅れていない（成長投資を急ぐ理由が無い）
  | "GROWTH_PRESSURE_HIGH" // 志に対する遅れが大きく、成長投資を検討する段階にある
  | "GROWTH_PRESSURE_LOW" // 志に対する遅れが小さく、成長投資を検討する段階にない
  | "NEW_FACTORY_MONITORING" // 新工場は候補として認識しているが、まだ検討段階に入っていない
  | "NEW_FACTORY_CONSIDERING" // 新工場を具体的に検討している（一部ゲート未充足）
  | "NEW_FACTORY_PROPOSED" // 新工場建設を提案した
  | "NEW_FACTORY_DEFERRED_FINANCE" // 資金・財務健全性の条件を満たさないため新工場を見送り
  | "NEW_FACTORY_DEFERRED_MARKET" // 需要・受注の裏づけが不足するため新工場を見送り
  | "NEW_FACTORY_DEFERRED_LABOR" // 労働力の裏づけが不足するため新工場を見送り
  | "NEW_FACTORY_DEFERRED_RAW" // 原料供給の裏づけが不足するため新工場を見送り
  | "NEW_FACTORY_DEFERRED_EXISTING_SPACE" // 既存工場にまだ増設余地があるため新工場を見送り
  | "NEW_FACTORY_DEFERRED_EXISTING_EXPANSION" // 既存増設で当面のgapを埋められるため新工場を見送り
  | "NEW_FACTORY_NOT_NEEDED" // Visionに対して規模が足りており、新工場を必要としない
  // --- 【Strategic Posture・先行能力投資型戦略】Forward Capacity Gapに基づく新工場判断 ---
  | "NEW_FACTORY_STRATEGIC_FORWARD_GAP" // 工場完成時点で能力不足が見込まれる（Forward Capacity Gapが存在する）
  | "NEW_FACTORY_STRATEGIC_PROPOSED" // Forward Capacity Gapを根拠に新工場建設を先行提案した
  | "NEW_FACTORY_STRATEGIC_GAP_INSUFFICIENT" // 完成時点でも既存増設で賄える見込みのため、先行提案しない
  | "NEW_FACTORY_STRATEGIC_DEFERRED_GROWTH_EVIDENCE" // 観測できる自社・市場の成長根拠が乏しいため先行提案しない
  | "NEW_FACTORY_STRATEGIC_DEFERRED_FINANCE" // 財務ゲート（既存の新工場finance gateと同一）を満たさないため先行提案しない
  | "NEW_FACTORY_STRATEGIC_DEFERRED_ACTIVATION" // 完成後にWorker・設備を実際に入れられる見込みが立たないため先行提案しない
  // --- 【2026-08-09・Phase 6新設】Vision駆動の商業成長 ---
  | "VISION_COMMERCIAL_GROWTH_PRESSURE" // 志に対して販売規模が遅れており、商業的な成長圧力がある
  | "COMMERCIAL_SCALE_BELOW_VISION_PATH" // 現在の販売規模が Vision の参考成長軌道を下回る
  | "COMMERCIAL_AMBITION_EXPANDED" // 志と観測できる採算つき機会を理由に、目指す販売規模を引き上げた
  | "COMMERCIAL_AMBITION_HELD_MARKET_WEAK" // 観測できる採算つき市場機会が乏しいため、販売規模拡大を見送った
  | "COMMERCIAL_AMBITION_HELD_MARGIN_WEAK" // 採算が薄いため、量的拡大を見送った
  | "COMMERCIAL_AMBITION_HELD_INVENTORY" // 完成品在庫が過剰なため、まず売り切ることを優先した
  | "COMMERCIAL_GROWTH_ON_TRACK" // 志の軌道に乗っており、規模拡大を急がない
  | "PROFITABLE_MARKET_OPPORTUNITY_AVAILABLE" // 観測上、採算の取れる未獲得の市場機会が存在する
  | "UNSERVED_PROFITABLE_OPPORTUNITY" // 取りたかったが取れなかった採算つき機会がある
  | "UNSERVED_BY_SALES_CAPACITY" // 未充足機会の主因が営業能力
  | "UNSERVED_BY_PRODUCTION_CAPACITY" // 未充足機会の主因が生産能力（新工場の根拠になりうる）
  | "UNSERVED_BY_LABOR" // 未充足機会の主因が労働力
  | "UNSERVED_BY_RAW_MATERIAL" // 未充足機会の主因が原料
  | "UNSERVED_BY_MARKET_COMPETITION" // 提出したが市場競争で取れなかった
  // --- 【Phase 6C】Commercial Commitment / 過剰提出の制御（#05 §14） ---
  | "COMMERCIAL_COMMITMENT_SET" // 今期どこまで市場へ取りに行くかを決めた
  | "SALES_SUBMISSION_LIMITED_BY_RECENT_CONVERSION" // 直近の成約率が低いため提出量を抑えた
  | "SALES_SUBMISSION_LIMITED_BY_SALES_CAPACITY" // 営業組織が捌ける案件量で提出量が決まった
  | "SALES_SUBMISSION_LIMITED_BY_MARKET_OPPORTUNITY" // 観測できる採算つき機会で提出量が決まった
  | "SALES_SUBMISSION_EXPANDED_FOR_GROWTH" // 成長のため志を上回る量を取りに行った
  | "PRODUCTION_LIMITED_TO_CONFIRMED_DEMAND" // 生産は確定需要（受注残）中心に絞った
  | "PRODUCTION_INCLUDES_EXPECTED_CONVERSION" // 生産に期待成約分を織り込んだ
  | "PRODUCTION_REDUCED_FOR_FINISHED_GOODS" // 完成品在庫があるため生産を抑えた
  | "OVER_SUBMISSION_RISK_HIGH" // 提出量に対する成約率が低い状態が続いている
  // --- 【Standard AI Crisis Management・Phase CM-1】資金繰り危機時の受注抑制 ---
  | "CRISIS_LIQUIDITY_STRESS" // 調達能力が大きく低下しているが完全支払不能ではない
  | "CRISIS_UNDERWRITING_FROZEN" // 銀行の通常融資審査が凍結している（前Turn時点）
  | "CRISIS_PROCUREMENT_BLOCKED" // 前Turnの原料調達がほぼ完全に止まっていた（scaleRatio≈0または輸入停止）
  | "CRISIS_NEW_SALES_SUPPRESSED" // 危機のため新規Commercial Commitmentを縮小・停止した（既存Backlogは維持）
  | "CRISIS_CAPEX_PAUSED" // 危機のため新規設備投資提案（新工場含む）を停止した（着工済み案件は維持）
  | "CRISIS_SALES_HIRING_STOPPED" // 危機のため営業採用を停止した
  | "CRISIS_VAP_DEV_PAUSED" // 【Phase CE-2】危機のため新規VAP商品開発支出を停止した（既存スコアの蓄積は取り消さない）
  // --- Shadow Growth Pressure（Phase SAI-GROW-1・診断専用。Decisionには未接続） ---
  | "GROWTH_PRESSURE_LOW"
  | "GROWTH_PRESSURE_MODERATE"
  | "GROWTH_PRESSURE_HIGH"
  | "GROWTH_PRESSURE_URGENT"
  | "GROWTH_OPPORTUNITY_AVAILABLE" // 観測上、現在取りに行っている量を超える採算つき機会がある
  | "GROWTH_OPPORTUNITY_SUPPRESSED_BY_SUBMISSION_CAP" // 現行の提出上限（AI側の控えめ係数）で観測機会を捨てている
  | "GROWTH_BLOCKED_BY_COMMERCIAL"
  | "GROWTH_BLOCKED_BY_PRODUCTION_CAPACITY"
  | "GROWTH_BLOCKED_BY_RAW_MATERIAL"
  | "GROWTH_BLOCKED_BY_LABOR"
  | "GROWTH_BLOCKED_BY_FINANCE"
  | "GROWTH_BLOCKED_BY_MARGIN"
  | "GROWTH_BLOCKED_BY_INVENTORY"
  | "GROWTH_NO_MARKET_OPPORTUNITY"
  | "GROWTH_BLOCKED_BY_ENGINE_CAP" // 営業能力engineの漸近上限に当たっている（Standard AIでは解消できない）
  | "EXTERNAL_ENGINE_CAPACITY_LIMIT" // 同上（engine側の制約であることを明示する併記コード）
  | "COMMERCIAL_CAPACITY_CONSTRAINED_BY_CURRENT_PRODUCTION" // 営業採用が現在の生産能力で止められている（実装指示§21）
  | "GROWTH_PRESSURE_BLOCKED_BY_SELF_REFERENTIAL_CAPACITY_GATE" // 需要根拠が自社販売目標の自己参照で低くなっている（実装指示§22）
  // --- Adaptive Opportunity Share（Phase SAI-GROW-2・Commercialのみへ接続） ---
  | "GROWTH_SHARE_HELD_LOW" // Growth Pressureが低く、機会shareを現行値のまま据え置いた
  | "GROWTH_SHARE_EXPANDED_MODERATE"
  | "GROWTH_SHARE_EXPANDED_HIGH"
  | "GROWTH_SHARE_REDUCED_BY_CONVERSION" // 直近の成約率悪化により拡張幅を縮小
  | "GROWTH_SHARE_REDUCED_BY_MARGIN" // 採算悪化（またはvalue志向の採算条件）により拡張幅を縮小
  | "GROWTH_SHARE_REDUCED_BY_INVENTORY"
  // --- Adaptive Growth Step（Phase SAI-GROW-3A） ---
  | "GROWTH_STEP_LIMIT_EXPANDED" // observable evidenceが揃ったため1四半期の伸び幅上限を拡大した
  | "GROWTH_STEP_LIMIT_BINDING"
  // --- Liquidity SSoT / Investment Discipline（Phase SAI-GROW-3B-1） ---
  | "CAPEX_DEFERRED_LIQUIDITY" // 投資後にProtected Funding Requirementを割るため見送り
  | "CAPEX_DEFERRED_COMMITTED_PAYMENTS" // 既承認案件の今後の支払で余力が無いため見送り
  | "LIQUIDITY_ASSESSED"
  | "SURVIVAL_MODE"
  | "RECOVERY_MODE"
  | "PRODUCTION_REDUCED_BY_LIQUIDITY"
  | "PROCUREMENT_REDUCED_BY_LIQUIDITY"
  | "WORKFORCE_REDUCED_FOR_SURVIVAL"
  | "SALES_FORCE_REDUCED_FOR_SURVIVAL"
  | "GROWTH_PAUSED_FOR_RECOVERY"
  | "DELIVERABLE_COMMITMENT_ASSESSED"
  | "DELIVERABLE_LIMIT_PRODUCTION"
  | "DELIVERABLE_LIMIT_RAW_MATERIAL"
  | "DELIVERABLE_LIMIT_BACKLOG"
  | "DELIVERABLE_LIMIT_LIQUIDITY"
  | "GROWTH_ROUTE_NONE"
  | "GROWTH_ROUTE_PRODUCTION_CAPEX"
  | "GROWTH_ROUTE_WORKFORCE"
  | "GROWTH_ROUTE_PROCUREMENT"
  | "GROWTH_ROUTE_LIQUIDITY"
  | "GROWTH_ROUTE_SALES_HIRING"
  | "GROWTH_ROUTE_BACKLOG_RECOVERY"
  // --- Strategy Profile Quantification（Phase SP-Q1） ---
  | "PROFILE_BIAS_APPLIED" // 会社別ManagementProfile/OrientationProfileのバイアスをStandardAiParametersへ適用した（mode=ONの時のみ）
  // --- 【Standard AI Capability Expansion・Phase CE-1】PD機械化 ---
  | "PD_MECH_CONSIDERED" // PD機械化候補として工場を評価対象に含めた
  | "PD_MECH_LOW_UTILIZATION" // PD稼働率が低く機械化を検討する段階にないため候補から外した
  | "PD_MECH_PAYBACK_UNATTRACTIVE" // 想定回収期間がしきい値を超えるため候補から外した
  | "PD_MECH_ALREADY_ACTIVE" // 当該工場は既に機械化案件が進行中／完了しているため重複提案しない
  | "PD_MECH_FINANCE_BLOCKED" // 財務ゲート（現金・借入余力）を満たさないため見送り
  | "PD_MECH_PROPOSED" // PD機械化案件を提案（経済性・戦略適合を踏まえて工場を選定）
  | "PD_MECH_DEFERRED" // 当期はPD機械化案件を見送り（既定の正常な結果）
  // --- 【Standard AI Capability Expansion・Phase CE-2】VAP商品開発 ---
  | "VAP_DEV_CONSIDERED" // VAP商品開発費（tier選択）を検討対象に含めた
  | "VAP_DEV_LOW_OPPORTUNITY" // VAP稼働率が低く、商品開発を検討する段階にないため見送り
  | "VAP_DEV_LOW_MARGIN" // VAP市場プレミアムが最低受注水準未満で採算が立たないため見送り
  | "VAP_DEV_INTENSITY_EVALUATED" // 【Phase PC-2A新設】headroom・VAP事業規模・affordabilityからInvestment Intensityを算出し、候補tierを導出した
  | "VAP_DEV_PAYBACK_UNATTRACTIVE" // どのtierも現在のVAP事業規模に対して支出が過大（affordability基準未達）のため見送り
  | "VAP_DEV_ALREADY_ACTIVE" // VAP商品開発スコアが既に高く、ヘッドルームが乏しいため新規支出を見送り
  | "VAP_DEV_FINANCE_BLOCKED" // 財務ゲート（現金・借入余力）を満たさないtierを見送り
  | "VAP_DEV_PROPOSED" // VAP商品開発費のtierを選択して提案
  | "VAP_DEV_DEFERRED" // 当期はVAP商品開発費tier=0（既定の正常な結果）
  // --- 【Standard AI Capability Expansion・Phase CE-3】品質管理設備（qualityControlEquipment） ---
  | "QUALITY_EQUIP_CONSIDERED" // 品質管理設備の投資候補として工場を評価対象に含めた
  | "QUALITY_EQUIP_LOW_NEED" // Quality Needスコアがしきい値未満のため候補から外した
  | "QUALITY_EQUIP_LOW_EXPOSURE" // 品質リスク・品質敏感生産の露出が小さく、優先度が低いため候補から外した
  | "QUALITY_EQUIP_ALREADY_ACTIVE" // 当該工場には既に品質管理設備が稼働中／導入進行中のため重複提案しない
  | "QUALITY_EQUIP_FINANCE_BLOCKED" // 財務ゲート（現金・借入余力）を満たさないため見送り
  | "QUALITY_EQUIP_PROPOSED" // 品質管理設備を提案（Quality Need・経済性・戦略適合を踏まえて工場を選定）
  | "QUALITY_EQUIP_DEFERRED" // 当期はいずれの工場もQuality Need条件を満たさないため見送り（既定の正常な結果）
  // --- 【Standard AI Factory Activation・Phase FA-1】新工場の戦力化 ---
  | "FACTORY_ACTIVATION_LABOR_BASELINE_SYNTHESIZED" // 新設Factoryぶんの労働baselineを合成した（既存Factoryの平均skillを流用）
  | "FACTORY_ACTIVATION_CONSIDERED" // Factory Activation候補として評価対象に含めた
  | "FACTORY_ACTIVATION_BOTTLENECK_COMMON" // 共通前処理能力がボトルネックと診断
  | "FACTORY_ACTIVATION_BOTTLENECK_PRODUCT_LINE" // 商品別ラインがボトルネックと診断
  | "FACTORY_ACTIVATION_BOTTLENECK_LABOR" // 労働力がボトルネックと診断
  | "FACTORY_ACTIVATION_NONE_NEEDED"; // 当該Factoryは十分に戦力化済み（追加のActivation不要）

export const STANDARD_AI_REASON_CODES: readonly StandardAiReasonCode[] = [
  "CONTRACT_FULFILLMENT_PRIORITY",
  "FINISHED_GOODS_EXCESS",
  "CAPACITY_CONSTRAINT",
  "SHARED_CAPACITY_CONSTRAINT",
  "CAPEX_DEFERRED_INSUFFICIENT_SPACE",
  "RAW_MATERIAL_SHORTAGE",
  "PROCUREMENT_INCREASED_FOR_SHORTAGE",
  "PROCUREMENT_REDUCED_FOR_EXCESS",
  "PROCUREMENT_CASH_CONSTRAINED",
  "PRICE_REDUCTION_FOR_EXCESS_STOCK",
  "SALES_REDUCED_FOR_SUPPLY_LIMIT",
  "LOW_ORDER_BOOK_PREMIUM_FLOOR",
  "MARKET_ALLOCATION_BY_OBSERVED_OPPORTUNITY",
  "MARKET_OPPORTUNITY_COMPONENTS",
  "SALES_CAPACITY_UTILIZATION",
  "SALES_HEADCOUNT_INSUFFICIENT_TOTAL",
  "VAP_MIX_INCREASES_SALES_EFFORT_NEED",
  "WORKER_CAPACITY_SHORTAGE",
  "OVERTIME_TEMP_FOR_TRANSIENT_SHORTAGE",
  "HIRING_FOR_SUSTAINED_SHORTAGE",
  "HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS",
  "CASH_BUFFER_SHORTAGE",
  "WORKING_CAPITAL_ASSESSED",
  "DEBT_REPAYMENT_SURPLUS",
  "CAPEX_DEFERRED",
  "CAPEX_PROPOSED",
  "MARKET_ORIENTATION_APPLIED",
  "PRODUCT_ORIENTATION_APPLIED",
  "LIFECYCLE_GROWTH_PURSUED",
  "SALES_BASE_ADVANTAGE",
  "SUPPLY_PRESSURE_RETREAT",
  "DIVIDEND_PROPOSED",
  "DIVIDEND_SKIPPED_NOT_ANNUAL_PERIOD",
  "DIVIDEND_SKIPPED_NOT_HEALTHY",
  "DIVIDEND_SKIPPED_CRISIS",
  "DIVIDEND_SKIPPED_CAPEX_PLANNED",
  "DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS",
  "DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS",
  "DIVIDEND_SKIPPED_INVALID_FINANCIAL_INPUT",
  "DIVIDEND_LIMITED_BY_DISTRIBUTABLE_EARNINGS",
  "DIVIDEND_LIMITED_BY_MAX",
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
  "VISION_GROWTH_GAP",
  "VISION_ON_TRACK",
  "GROWTH_PRESSURE_HIGH",
  "GROWTH_PRESSURE_LOW",
  "NEW_FACTORY_MONITORING",
  "NEW_FACTORY_CONSIDERING",
  "NEW_FACTORY_PROPOSED",
  "NEW_FACTORY_DEFERRED_FINANCE",
  "NEW_FACTORY_DEFERRED_MARKET",
  "NEW_FACTORY_DEFERRED_LABOR",
  "NEW_FACTORY_DEFERRED_RAW",
  "NEW_FACTORY_DEFERRED_EXISTING_SPACE",
  "NEW_FACTORY_DEFERRED_EXISTING_EXPANSION",
  "NEW_FACTORY_NOT_NEEDED",
  "NEW_FACTORY_STRATEGIC_FORWARD_GAP",
  "NEW_FACTORY_STRATEGIC_PROPOSED",
  "NEW_FACTORY_STRATEGIC_GAP_INSUFFICIENT",
  "NEW_FACTORY_STRATEGIC_DEFERRED_GROWTH_EVIDENCE",
  "NEW_FACTORY_STRATEGIC_DEFERRED_FINANCE",
  "NEW_FACTORY_STRATEGIC_DEFERRED_ACTIVATION",
  "VISION_COMMERCIAL_GROWTH_PRESSURE",
  "COMMERCIAL_SCALE_BELOW_VISION_PATH",
  "COMMERCIAL_AMBITION_EXPANDED",
  "COMMERCIAL_AMBITION_HELD_MARKET_WEAK",
  "COMMERCIAL_AMBITION_HELD_MARGIN_WEAK",
  "COMMERCIAL_AMBITION_HELD_INVENTORY",
  "COMMERCIAL_GROWTH_ON_TRACK",
  "PROFITABLE_MARKET_OPPORTUNITY_AVAILABLE",
  "UNSERVED_PROFITABLE_OPPORTUNITY",
  "UNSERVED_BY_SALES_CAPACITY",
  "UNSERVED_BY_PRODUCTION_CAPACITY",
  "UNSERVED_BY_LABOR",
  "UNSERVED_BY_RAW_MATERIAL",
  "UNSERVED_BY_MARKET_COMPETITION",
  "COMMERCIAL_COMMITMENT_SET",
  "SALES_SUBMISSION_LIMITED_BY_RECENT_CONVERSION",
  "SALES_SUBMISSION_LIMITED_BY_SALES_CAPACITY",
  "SALES_SUBMISSION_LIMITED_BY_MARKET_OPPORTUNITY",
  "SALES_SUBMISSION_EXPANDED_FOR_GROWTH",
  "PRODUCTION_LIMITED_TO_CONFIRMED_DEMAND",
  "PRODUCTION_INCLUDES_EXPECTED_CONVERSION",
  "PRODUCTION_REDUCED_FOR_FINISHED_GOODS",
  "OVER_SUBMISSION_RISK_HIGH",
  "CRISIS_LIQUIDITY_STRESS",
  "CRISIS_UNDERWRITING_FROZEN",
  "CRISIS_PROCUREMENT_BLOCKED",
  "CRISIS_NEW_SALES_SUPPRESSED",
  "CRISIS_CAPEX_PAUSED",
  "CRISIS_SALES_HIRING_STOPPED",
  "CRISIS_VAP_DEV_PAUSED",
  "PROFILE_BIAS_APPLIED",
  "PD_MECH_CONSIDERED",
  "PD_MECH_LOW_UTILIZATION",
  "PD_MECH_PAYBACK_UNATTRACTIVE",
  "PD_MECH_ALREADY_ACTIVE",
  "PD_MECH_FINANCE_BLOCKED",
  "PD_MECH_PROPOSED",
  "PD_MECH_DEFERRED",
  "VAP_DEV_CONSIDERED",
  "VAP_DEV_LOW_OPPORTUNITY",
  "VAP_DEV_LOW_MARGIN",
  "VAP_DEV_INTENSITY_EVALUATED",
  "VAP_DEV_PAYBACK_UNATTRACTIVE",
  "VAP_DEV_ALREADY_ACTIVE",
  "VAP_DEV_FINANCE_BLOCKED",
  "VAP_DEV_PROPOSED",
  "VAP_DEV_DEFERRED",
  "QUALITY_EQUIP_CONSIDERED",
  "QUALITY_EQUIP_LOW_NEED",
  "QUALITY_EQUIP_LOW_EXPOSURE",
  "QUALITY_EQUIP_ALREADY_ACTIVE",
  "QUALITY_EQUIP_FINANCE_BLOCKED",
  "QUALITY_EQUIP_PROPOSED",
  "QUALITY_EQUIP_DEFERRED",
  "FACTORY_ACTIVATION_LABOR_BASELINE_SYNTHESIZED",
  "FACTORY_ACTIVATION_CONSIDERED",
  "FACTORY_ACTIVATION_BOTTLENECK_COMMON",
  "FACTORY_ACTIVATION_BOTTLENECK_PRODUCT_LINE",
  "FACTORY_ACTIVATION_BOTTLENECK_LABOR",
  "FACTORY_ACTIVATION_NONE_NEEDED",
  "GROWTH_PRESSURE_LOW",
  "GROWTH_PRESSURE_MODERATE",
  "GROWTH_PRESSURE_HIGH",
  "GROWTH_PRESSURE_URGENT",
  "GROWTH_OPPORTUNITY_AVAILABLE",
  "GROWTH_OPPORTUNITY_SUPPRESSED_BY_SUBMISSION_CAP",
  "GROWTH_BLOCKED_BY_COMMERCIAL",
  "GROWTH_BLOCKED_BY_PRODUCTION_CAPACITY",
  "GROWTH_BLOCKED_BY_RAW_MATERIAL",
  "GROWTH_BLOCKED_BY_LABOR",
  "GROWTH_BLOCKED_BY_FINANCE",
  "GROWTH_BLOCKED_BY_MARGIN",
  "GROWTH_BLOCKED_BY_INVENTORY",
  "GROWTH_NO_MARKET_OPPORTUNITY",
  "GROWTH_BLOCKED_BY_ENGINE_CAP",
  "EXTERNAL_ENGINE_CAPACITY_LIMIT",
  "COMMERCIAL_CAPACITY_CONSTRAINED_BY_CURRENT_PRODUCTION",
  "GROWTH_PRESSURE_BLOCKED_BY_SELF_REFERENTIAL_CAPACITY_GATE",
  "GROWTH_SHARE_HELD_LOW",
  "GROWTH_SHARE_EXPANDED_MODERATE",
  "GROWTH_SHARE_EXPANDED_HIGH",
  "GROWTH_SHARE_REDUCED_BY_CONVERSION",
  "GROWTH_SHARE_REDUCED_BY_MARGIN",
  "GROWTH_SHARE_REDUCED_BY_INVENTORY",
  "GROWTH_STEP_LIMIT_EXPANDED",
  "GROWTH_STEP_LIMIT_BINDING",
  "CAPEX_DEFERRED_LIQUIDITY",
  "CAPEX_DEFERRED_COMMITTED_PAYMENTS",
  "LIQUIDITY_ASSESSED",
  "SURVIVAL_MODE",
  "RECOVERY_MODE",
  "PRODUCTION_REDUCED_BY_LIQUIDITY",
  "PROCUREMENT_REDUCED_BY_LIQUIDITY",
  "WORKFORCE_REDUCED_FOR_SURVIVAL",
  "SALES_FORCE_REDUCED_FOR_SURVIVAL",
  "GROWTH_PAUSED_FOR_RECOVERY",
  "DELIVERABLE_COMMITMENT_ASSESSED",
  "DELIVERABLE_LIMIT_PRODUCTION",
  "DELIVERABLE_LIMIT_RAW_MATERIAL",
  "DELIVERABLE_LIMIT_BACKLOG",
  "DELIVERABLE_LIMIT_LIQUIDITY",
  "GROWTH_ROUTE_NONE",
  "GROWTH_ROUTE_PRODUCTION_CAPEX",
  "GROWTH_ROUTE_WORKFORCE",
  "GROWTH_ROUTE_PROCUREMENT",
  "GROWTH_ROUTE_LIQUIDITY",
  "GROWTH_ROUTE_SALES_HIRING",
  "GROWTH_ROUTE_BACKLOG_RECOVERY",
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
  /**
   * 【Phase CE-1.1・指示§16-17】この判断がFactory単位の場合、対象FactoryId。
   * keyValuesはRecord<string, number>限定のため、factoryIdのような文字列識別子を
   * 保持できなかった（従来はdecisionSummary文字列の先頭"<factoryId>: "を
   * パースして復元していた）。ここへfirst-classなoptionalフィールドとして追加し、
   * 文字列parseへの依存を解消する。既存のdiagnostics生成コードは何も変更しなくても
   * 動く（省略時undefined）ため、後方互換を壊さない。
   */
  readonly targetFactoryId?: string;
  /** 結果として生成された意思決定の簡潔な要約（例: "VAP生産を+120トン増"）。 */
  readonly decisionSummary?: string;
  /** 人間向けの簡潔な日本語説明。 */
  readonly message: string;
}
