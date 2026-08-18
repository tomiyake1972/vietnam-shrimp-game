// ShrimpX V2 — Shared Game Knowledge Registry: ルール本体（Phase M2.8）
//
// 【全entryの原則】
//  1. 変わり得る数値は書かない。`{{key}}` として dynamicValues.ts が現在の
//     parameterから解決する（実装指示§5）。
//  2. sourceReference には、そのルールが実装されている実ファイルを書く（§32）。
//  3. 一般的な経営常識でゲームルールの空白を埋めない。分からないことは
//     「現行ルール上確認できない」と書く（§31）。
//  4. AIが誤読しやすい点は semanticWarnings に明示する。

import { KnowledgeEntry } from "./types";

const V = "gk-v1";

export const GAME_KNOWLEDGE_ENTRIES: readonly KnowledgeEntry[] = [
  // =====================================================================
  // SALES（実装指示§6・§7・§8。今回の最優先ドメイン）
  // =====================================================================
  {
    id: "SALES.SALESPERSON_CAPACITY",
    domain: "SALES",
    title: "営業1人当たりの販売能力（固定値は存在しない）",
    summary:
      "ShrimpXには「営業1人＝何トン」という固定パラメータは存在しない。販売能力は会社全体の営業組織能力の飽和曲線で決まり、商品構成によって実際に売れるトン数が変わる。",
    explanation: [
      "【ルール】営業能力は市場ごとに湧くものではなく、**会社の営業組織**が1つ持つ。",
      "会社全体の営業工数能力は、営業人員数 h に対する飽和曲線で決まる:",
      "  capacity(h) = {{salesCompanyBaselineCapacityTons}} + {{salesCompanyCapacityMaxIncrementTons}} × h / (h + {{salesCompanyCapacitySaturationHeadcount}})  【単位: 営業工数トン／四半期】",
      "この値は「工数トン」であり、そのまま販売可能トン数ではない。商品ごとに営業工数の重みが違う:",
      "  HOSO = {{salesEffortCoefficientHoso}} / PD = {{salesEffortCoefficientPd}} / VAP = {{salesEffortCoefficientVap}}（工数トン／実トン）",
      "実際に売れるトン数 ≒ 営業工数能力 ÷ 商品構成の加重平均工数係数。",
      "したがって同じ人数でも、HOSO中心なら多く、VAP中心なら少なくなる。",
      "会社全体の能力は、各市場の営業工数需要の比率で市場へ配分される。市場を増やしても会社の総能力は増えない。",
      "現在の曲線での実測値: h=30で約{{salesCapacityAt30}}、h=60で約{{salesCapacityAt60}}、h=100で約{{salesCapacityAt100}} 工数トン／四半期。",
    ].join("\n"),
    ruleType: "FORMULA",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/sales/salesCapacityModel.ts (companySalesOrganizationCapacity / computeMarketSalesCapacities), app/lib/v2/sales/parameters.ts (salesEffortCoefficients)",
    appliesToRoles: ["CEO", "COMMERCIAL"],
    keywords: ["営業", "営業能力", "営業人員", "販売能力", "一人当たり", "1人当たり", "何トン", "sales", "salesperson", "capacity", "headcount", "productivity", "per person"],
    dynamicValues: [
      "salesCompanyBaselineCapacityTons",
      "salesCompanyCapacityMaxIncrementTons",
      "salesCompanyCapacitySaturationHeadcount",
      "salesEffortCoefficientHoso",
      "salesEffortCoefficientPd",
      "salesEffortCoefficientVap",
      "salesCapacityAt30",
      "salesCapacityAt60",
      "salesCapacityAt100",
    ],
    semanticWarnings: [
      "「当期の販売実績 ÷ 営業人数」を営業1人当たりの能力として提示してはいけない。実績は需要・価格競争力・生産能力・在庫でも決まるため、能力値ではなく結果値である。",
      "営業能力は上限であって、その量が必ず売れることを意味しない。実際の成約量は市場需要・価格・信頼・品質との競争で決まる。",
      "固定の tons/person パラメータは存在しない。存在しないことを明言してよい。",
    ],
    version: V,
  },
  {
    id: "SALES.CAPACITY_VS_ACTUAL",
    domain: "SALES",
    title: "営業能力（上限）と販売実績（結果）の区別",
    summary: "販売実績は営業能力の下限でも上限でもない。実績が能力を大きく下回ることは、需要不足・生産制約・在庫不足でも起こる。",
    explanation: [
      "営業能力（capacity）は「その四半期に営業組織が扱える最大の工数量」であり、成約を保証しない。",
      "実際の成約量は、提出した販売計画（submitted）に対して、市場需要・価格・カバレッジ・顧客信頼・品質・納期信頼性の合成競争力で決まる。",
      "そのため、以下は別の量である:",
      "  1. 売りたい量（Commercial Ambition）",
      "  2. 今期取りに行くと決めた量（Commercial Commitment / 提出量）",
      "  3. 実際に成約した量（contracted）",
      "  4. 実際に納品した量（delivered）",
      "実績から能力を逆算する場合は、必ず「これは実績値であり能力値ではない」と明示する。",
    ].join("\n"),
    ruleType: "INTERPRETATION",
    sourceType: "FORMAL_SPEC",
    sourceReference: "app/lib/v2/sales/allocation.ts, app/lib/v2/companyLab/vision/commercialCommitment.ts",
    appliesToRoles: ["CEO", "COMMERCIAL"],
    keywords: ["実績", "能力", "成約", "提出", "ambition", "commitment", "contracted", "delivered", "actual", "capacity"],
    semanticWarnings: ["実績÷人数を能力として扱わない。"],
    version: V,
  },
  {
    id: "SALES.MARKET_AND_PRODUCT_ASSIGNMENT",
    domain: "SALES",
    title: "営業人員は市場単位（商品別の人数は存在しない）",
    summary: "営業人員の配置は市場単位。同じ市場のHOSO/PD/VAPは同一の営業チームを共有し、商品別に別々の人数を置くことはできない。",
    explanation: [
      "営業人員は市場（DemandMarket）ごとに配置する。1人は1つの市場にのみ配置でき、複数市場の掛け持ちはできない。",
      "同一市場内の複数商品は同じ営業チームを共有するため、販売計画の各行（市場×商品）には**同じ人数**を書く必要がある（不一致は入力エラー）。",
      "商品ごとの負荷差は人数ではなく、営業工数係数（HOSO {{salesEffortCoefficientHoso}} / PD {{salesEffortCoefficientPd}} / VAP {{salesEffortCoefficientVap}}）で表現される。",
      "全市場への配置合計が実在する営業人員数を超えることはできない。下回る（未配置が出る）ことは正常である。",
    ].join("\n"),
    ruleType: "CONSTRAINT",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/sales/salesForce.ts (validateSalesForceHeadcountBudget), app/lib/v2/sales/marketEffort.ts",
    appliesToRoles: ["CEO", "COMMERCIAL", "COO"],
    keywords: ["営業配置", "市場別", "商品別", "何人", "配置", "market", "assignment", "allocation", "headcount"],
    dynamicValues: ["salesEffortCoefficientHoso", "salesEffortCoefficientPd", "salesEffortCoefficientVap"],
    version: V,
  },
  {
    id: "SALES.COVERAGE_VS_CAPACITY",
    domain: "SALES",
    title: "カバレッジ（競争力）と処理能力（数量上限）は別の仕組み",
    summary: "営業人員は「市場カバレッジ（成約競争力の一因子）」と「処理能力（数量上限）」の2つに別々に効く。両者は別の曲線で、混同してはいけない。",
    explanation: [
      "1. カバレッジ: coverage(h) = {{salesCoverageBaselineAtZeroHeadcount}} + (1 − {{salesCoverageBaselineAtZeroHeadcount}}) × h/(h + {{salesCoverageSaturationHeadcount}})。",
      "   0〜1のスコアで、価格・顧客関係・品質・納期信頼性と合成されて「成約の取り合い」の重みになる。半飽和点が小さいため少人数でも早く飽和する。",
      "2. 処理能力: SALES.SALESPERSON_CAPACITY の飽和曲線。こちらは数量の上限。",
      "つまり、人を増やす効果は「競争で勝ちやすくなる」ことと「扱える量が増える」ことの2経路があり、前者は早く頭打ちになる。",
    ].join("\n"),
    ruleType: "DEFINITION",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/sales/salesForce.ts (salesCoverageScore / processingCapacity), app/lib/v2/sales/parameters.ts (competitivenessWeights)",
    appliesToRoles: ["COMMERCIAL", "CEO"],
    keywords: ["カバレッジ", "coverage", "競争力", "逓減", "diminishing", "saturation", "飽和"],
    dynamicValues: ["salesCoverageBaselineAtZeroHeadcount", "salesCoverageSaturationHeadcount"],
    semanticWarnings: ["カバレッジは0〜1のスコアであり、トン数ではない。"],
    version: V,
  },

  // =====================================================================
  // LABOR（実装指示§9・§10）
  // =====================================================================
  {
    id: "LABOR.WORKER_PRODUCTIVITY",
    domain: "LABOR",
    title: "Worker 1人当たりの生産力と商品別労務負荷",
    summary:
      "常用Worker 1人の基準生産力は {{regularEfficiencyPerHeadTons}} HOSO換算トン／四半期。商品別の労務集約度係数（HOSO {{hosoLaborCoefficient}} / PD {{pdLaborCoefficient}} / VAP {{vapLaborCoefficient}}）で割った値が実効生産力になる。",
    explanation: [
      "【基準】常用Worker: {{regularEfficiencyPerHeadTons}} トン／人／四半期、臨時Worker: {{temporaryEfficiencyPerHeadTons}} トン／人／四半期。",
      "【商品別の負荷差】同じ数量でも商品によって必要な人手が違う。労務集約度係数:",
      "  HOSO = {{hosoLaborCoefficient}} / PD = {{pdLaborCoefficient}} / VAP = {{vapLaborCoefficient}}",
      "実効生産力 = 基準生産力 ÷ 労務集約度係数。現在値では常用1人あたり",
      "  HOSO 約{{hosoEffectiveTonsPerRegularHead}}t / PD 約{{pdEffectiveTonsPerRegularHead}}t / VAP 約{{vapEffectiveTonsPerRegularHead}}t（／四半期）。",
      "【必要人数】必要Worker = 数量 ÷ (実効生産力 × 出勤率 × 技能 × 残業係数)。",
      "残業は上限 {{overtimeRateCap}}、残業ぶんの効率は {{overtimeEfficiencyFactor}} 倍で効く。",
      "【集中生産効果】1商品へ生産を集中させると実効係数が下がる（同じ数量をより少ない人手で作れる）方向の補正が掛かる。",
      "【PD省人化投資】PD機械化のCAPEXが稼働している工場では、PDの労務集約度係数がその工場だけ下がる。",
    ].join("\n"),
    ruleType: "FORMULA",
    sourceType: "CODE",
    sourceReference:
      "app/lib/v2/production/labor.ts (effectiveEfficiencyPerHeadTons / requiredHeadcountForQuantityWithConcentration), app/lib/v2/production/parameters.ts (labor), app/lib/v2/production/concentration.ts",
    appliesToRoles: ["COO", "CEO"],
    keywords: ["worker", "ワーカー", "作業員", "人員", "何人", "生産", "労務", "labor", "productivity", "headcount", "PD", "VAP", "HOSO", "残業", "overtime"],
    dynamicValues: [
      "regularEfficiencyPerHeadTons",
      "temporaryEfficiencyPerHeadTons",
      "hosoLaborCoefficient",
      "pdLaborCoefficient",
      "vapLaborCoefficient",
      "hosoEffectiveTonsPerRegularHead",
      "pdEffectiveTonsPerRegularHead",
      "vapEffectiveTonsPerRegularHead",
      "overtimeRateCap",
      "overtimeEfficiencyFactor",
    ],
    semanticWarnings: [
      "Worker能力があっても、設備能力（product line / common processing）を超えて生産することはできない。両方の最小値が実際の生産量になる。",
      "臨時Workerは即時利用できるが、常用より基準効率が低い。",
    ],
    version: V,
  },
  {
    id: "LABOR.UTILIZATION_SEMANTICS",
    domain: "LABOR",
    title: "設備稼働率と労働稼働率は別の指標",
    summary: "equipment utilization と labor utilization は別々に計算される。片方が高くても、もう片方に余力があることがある。",
    explanation: [
      "設備稼働率 = 実際の生産量 ÷ 工場の有効設備能力。",
      "労働稼働率 = 実際の生産量 ÷ 有効労働能力。",
      "残業率はさらに別の指標であり、労働稼働率の一部ではない。",
      "「工場は満杯か」という問いには、どのcapacity poolの話か（common / hoso / pd / vap / freezing）と、設備・労働のどちらの制約かを区別して答える必要がある。",
    ].join("\n"),
    ruleType: "DEFINITION",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/production/types.ts (FactoryLoadMetrics / CompanyLoadMetrics)",
    appliesToRoles: ["COO", "CEO", "CFO"],
    keywords: ["稼働率", "utilization", "満杯", "余力", "設備", "労働", "残業", "equipment", "labor", "overtime"],
    semanticWarnings: ["equipment utilization と labor utilization を1つの「稼働率」へまとめて語らない。"],
    version: V,
  },

  // =====================================================================
  // FINANCE（実装指示§11・§12・§21）
  // =====================================================================
  {
    id: "FINANCE.AR_SETTLEMENT",
    domain: "FINANCE",
    title: "売掛金（AR）の回収タイミング",
    summary: "売掛金は納品（履行）の {{arCollectionQuarters}}後に現金化される。顧客信頼（Trust）が回収時期を遅らせる仕組みは存在しない。",
    explanation: [
      "【ルール】ARの回収サイトは全市場共通で {{arCollectionQuarters}}。当四半期に履行した売上は、当四半期中には現金化されない。",
      "【売上と現金は別】Revenue / Operating Profit は発生主義で当四半期に計上される。現金は上記のサイトで遅れて入る。",
      "したがって「営業利益が出ているのに現金が増えない」ことは正常であり、異常ではない。",
      "【Trustは無関係】ShrimpXには、顧客信頼や納期遵守率が売掛金の回収時期を遅らせる仕組みは存在しない。",
    ].join("\n"),
    ruleType: "TIMING",
    sourceType: "PARAMETER",
    sourceReference: "app/lib/v2/finance/parameters.ts (workingCapital.arCollectionQuarters), app/lib/v2/finance/quarterClose.ts",
    appliesToRoles: ["CFO", "CEO"],
    keywords: ["売掛金", "AR", "回収", "入金", "いつ", "receivable", "collection", "cash", "現金化"],
    dynamicValues: ["arCollectionQuarters"],
    semanticWarnings: [
      "「Trustが下がると回収が遅れる」は一般的な商習慣の推論であり、ShrimpXのルールではない。",
      "Operating Profit を AR の回収タイミングで説明してはいけない（発生主義とキャッシュの混同）。",
    ],
    version: V,
  },
  {
    id: "FINANCE.AP_SETTLEMENT",
    domain: "FINANCE",
    title: "買掛金（AP）の支払タイミング（ARと対称ではない）",
    summary:
      "国内原料は {{apDomesticPaymentQuarters}}に現金払い、輸入原料は発注から {{apImportPaymentQuarters}}後に支払う。ARの回収サイトと同じだと推測してはいけない。",
    explanation: [
      "【国内原料】支払サイト {{apDomesticPaymentQuarters}}。買い付けたその四半期に現金が出る（ベトナムの養殖農家への即金性の高い実務を反映）。",
      "【輸入原料】支払サイト {{apImportPaymentQuarters}}。発注時に買掛金として計上し、そのサイト後に現金が出る。",
      "【重要な非対称】売掛金の回収は {{arCollectionQuarters}} だが、国内原料の支払は当四半期である。つまり国内買付を増やすと、",
      "その四半期の現金は先に出て、対応する売上の入金は後になる（運転資金の悪化として現れる）。",
    ].join("\n"),
    ruleType: "TIMING",
    sourceType: "PARAMETER",
    sourceReference: "app/lib/v2/finance/parameters.ts (workingCapital.apDomesticPaymentQuarters / apImportPaymentQuarters)",
    appliesToRoles: ["CFO", "COO", "CEO"],
    keywords: ["買掛金", "AP", "支払", "payable", "payment", "いつ払う", "原料代", "現金支出"],
    dynamicValues: ["apDomesticPaymentQuarters", "apImportPaymentQuarters", "arCollectionQuarters"],
    semanticWarnings: ["APサイトをARと同じだと推測しない。国内と輸入でもサイトが異なる。"],
    version: V,
  },
  {
    id: "FINANCE.ACCOUNTING_SEMANTICS",
    domain: "FINANCE",
    title: "損益・キャッシュ・負債の用語定義",
    summary: "Revenue / Gross Profit / Operating Profit / Net Income は発生主義のP&L、Cash Flow は現金の動き、有利子負債と負債合計は別概念。",
    explanation: [
      "P&L（発生主義）: Revenue（純売上高） → Gross Profit（− 売上原価） → Operating Profit（− 販管費） → Net Income（− 支払利息 − 法人税）。法人税率は {{incomeTaxRate}}。",
      "Cash Flow: 営業CF / 投資CF / 財務CF の3区分。現金増減 = この3つの合計。",
      "有利子負債 = 短期借入金 + 長期借入金。四半期利率は短期 {{shortTermInterestRatePerQuarter}} / 長期 {{longTermInterestRatePerQuarter}}。",
      "負債合計 = 有利子負債 + 買掛金 + 未払利息 + その他負債。**有利子負債とは別の概念**であり、混同してはいけない。",
      "遊休労務費（idle labor cost）は、生産へ配属されなかった正社員の給与であり、商品原価へ配賦されず当四半期に全額費用化される。",
    ].join("\n"),
    ruleType: "DEFINITION",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/finance/types.ts (ProfitAndLossStatement / BalanceSheet / CashFlowStatement), app/lib/v2/finance/parameters.ts",
    appliesToRoles: ["CFO", "CEO"],
    keywords: ["営業利益", "純利益", "売上", "キャッシュフロー", "負債", "借入", "利息", "税", "revenue", "profit", "cash flow", "debt", "liabilities"],
    dynamicValues: ["incomeTaxRate", "shortTermInterestRatePerQuarter", "longTermInterestRatePerQuarter"],
    semanticWarnings: ["有利子負債（interest-bearing debt）と負債合計（total liabilities）を同じ数字として扱わない。"],
    version: V,
  },
  {
    id: "FINANCE.DIVIDEND_POLICY",
    domain: "FINANCE",
    title: "配当ルール（Playerの自由 と Standard AIの年1回ポリシーは別）",
    summary:
      "ゲームルール上、Playerは任意のTurnに任意額を配当できる。Standard AIだけが「年度末Q4のみ・当期純利益の {{dividendBasePayoutPercent}}%」という保守的な自社ポリシーで動く。",
    explanation: [
      "【ゲーム共通ルール（Player含む）】配当可能額の上限 = min(現金, 分配可能利益)。上限を超える要求は部分執行されず全額拒否される。",
      "分配可能利益はゲーム開始後に稼いだ利益の累計であり、ゲーム開始時点の利益剰余金は配当できない。",
      "配当した現金はその四半期の調達・投資に使えなくなる。Playerは毎Turn自由に配当額を入力できる。",
      "【Standard AIのポリシー（DIV-4）】Standard AIは年度末（Q4）にだけ配当を検討し、次の条件をすべて満たす場合のみ配当する:",
      "  1. 年度末（Q4）である  2. 財務健全性が healthy  3. Crisis State が NORMAL",
      "  4. 当期の新規CAPEX提案が0件  5. 直近確定四半期の当期純利益 > 0  6. 分配可能利益 > 0  7. 配当可能上限 > 0",
      "配当額 = 直近確定四半期の当期純利益 × {{dividendBasePayoutRatio}}（経営性格により ±5% の範囲で前後する）。上限で必ずクランプされる。",
      "配当の算定基準は当期純利益という**フロー**であり、累計の分配可能利益（ストック）ではない。ストックは上限としてのみ働く。",
      "Q4で条件を満たさなければその年度は無配であり、翌Q1へ繰り越して配当することはない。",
    ].join("\n"),
    ruleType: "CONSTRAINT",
    sourceType: "CODE",
    sourceReference:
      "app/lib/v2/finance/dividend.ts (computeMaxDividendUsd / resolveDividendDecision), app/lib/v2/companyLab/standardAi/decision/dividend.ts, docs/v2/standard_ai_dividend_policy_div3_div4.md",
    appliesToRoles: ["CFO", "CEO"],
    keywords: ["配当", "dividend", "株主還元", "payout", "分配可能利益", "DIV-4"],
    dynamicValues: ["dividendBasePayoutRatio", "dividendBasePayoutPercent"],
    semanticWarnings: [
      "「Standard AIは年1回しか配当しない」ことを「Playerも年1回しか配当できない」と説明してはいけない。両者は別のレイヤーである。",
      "配当の算定基準を累計の分配可能利益だと説明しない（それは上限であって基準ではない）。",
    ],
    version: V,
  },

  // =====================================================================
  // PROCUREMENT（実装指示§13・§14）
  // =====================================================================
  {
    id: "PROCUREMENT.DOMESTIC_TIMING",
    domain: "PROCUREMENT",
    title: "国内買付原料のタイミング",
    summary: "国内買付は当四半期に入庫し、**その四半期の生産にそのまま使える**。現金も当四半期に出る（支払サイト {{apDomesticPaymentQuarters}}）。",
    explanation: [
      "Turn N で国内買付を決定すると、Turn N の市場清算で配分された量が Turn N の在庫として入庫し、availableFromPeriod は Turn N である。",
      "つまり **Turn N の生産にそのまま使える**（リードタイムなし）。",
      "現金は支払サイト {{apDomesticPaymentQuarters}} により Turn N に出る。",
      "ただし希望量が必ず取れるわけではない。国内市場の供給総量に対して5社が提示価格と調達カバレッジで競争し、配分される。",
    ].join("\n"),
    ruleType: "TIMING",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/rawMaterials/inventory.ts (availableFromPeriod = allocation.period), app/lib/v2/rawMaterials/domesticPurchase.ts, app/lib/v2/finance/parameters.ts",
    appliesToRoles: ["COO", "CFO", "CEO"],
    keywords: ["国内", "買付", "domestic", "原料", "いつ使える", "調達", "procurement", "在庫"],
    dynamicValues: ["apDomesticPaymentQuarters"],
    version: V,
  },
  {
    id: "PROCUREMENT.IMPORT_TIMING",
    domain: "PROCUREMENT",
    title: "輸入原料のタイミング（リードタイムあり）",
    summary:
      "輸入は標準リードタイム {{importStandardLeadTimeTurns}}ターン。Turn N に発注すると Turn N+{{importStandardLeadTimeTurns}} に到着し、その四半期から生産に使える。支払は発注から {{apImportPaymentQuarters}}後。",
    explanation: [
      "Turn N で輸入を発注すると、標準リードタイム {{importStandardLeadTimeTurns}} ターン後の Turn N+{{importStandardLeadTimeTurns}} に到着する（注文ごとにリードタイムを指定した場合はその値）。",
      "到着した四半期から availableFromPeriod となり、その四半期の生産に使える。**到着前の輸送中在庫は生産に使えない**。",
      "現金は発注時に買掛金として計上され、支払サイト {{apImportPaymentQuarters}} 後に出る。つまり「現金が出る時期」と「使える時期」は一致しない。",
      "「輸入予定」「発注済み」「輸送中」「到着済み」「使用可能」「期末在庫」はすべて別の量であり、混同してはいけない。",
    ].join("\n"),
    ruleType: "TIMING",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/rawMaterials/imports.ts (resolveArrivalPeriod), app/lib/v2/rawMaterials/parameters.ts (imports.standardLeadTimeTurns), app/lib/v2/finance/parameters.ts",
    appliesToRoles: ["COO", "CFO", "CEO"],
    keywords: ["輸入", "import", "リードタイム", "lead time", "いつ使える", "いつ届く", "到着", "輸送中", "in transit", "原料"],
    dynamicValues: ["importStandardLeadTimeTurns", "apImportPaymentQuarters"],
    semanticWarnings: ["輸送中（in transit）の量を「現在使える在庫」として扱わない。"],
    version: V,
  },
  {
    id: "PROCUREMENT.AQUACULTURE_TIMING",
    domain: "PROCUREMENT",
    title: "自社養殖原料のタイミング",
    summary: "池入れした四半期の**翌四半期**に収穫され、その四半期から使える。収穫量は疾病圧力・養殖強度・バイオセキュリティで変動する（確定量ではない）。",
    explanation: [
      "Turn N に池入れ（stocking）すると、収穫は Turn N+{{aquacultureHarvestLagTurns}} になり、その四半期から生産に使える。",
      "収穫量は池入れ量そのものではない。養殖強度（intensity）が高いほど予定生産量は増えるが疾病脆弱性も増し、バイオセキュリティ水準がその影響を緩和する。",
      "したがって養殖原料は、国内買付・輸入と違って**入手量が不確実**である。",
      "養殖の想定単価は {{aquacultureUnitCostUsdPerHosoEqKg}} USD/HOSO換算kg。",
    ].join("\n"),
    ruleType: "TIMING",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/rawMaterials/aquaculture.ts (resolveHarvestPeriod = nextPeriod(stockingPeriod)), app/lib/v2/rawMaterials/parameters.ts (aquaculture)",
    appliesToRoles: ["COO", "CEO"],
    keywords: ["養殖", "aquaculture", "池入れ", "収穫", "harvest", "いつ", "自給", "疾病"],
    dynamicValues: ["aquacultureHarvestLagTurns", "aquacultureUnitCostUsdPerHosoEqKg"],
    semanticWarnings: ["養殖の収穫量を池入れ量と同一視しない（疾病等で変動する）。"],
    version: V,
  },
  {
    id: "PROCUREMENT.TERMINOLOGY",
    domain: "PROCUREMENT",
    title: "調達用語の区別（予定・発注済み・輸送中・到着・使用可能・期末在庫）",
    summary: "調達の各段階は別々の量である。特に「輸入予定」と「現在使える在庫」を同じものとして語ってはいけない。",
    explanation: [
      "planned procurement … 意思決定として希望した量（取れる保証はない）",
      "ordered … 実際に発注した量（輸入のみ）",
      "in transit … 発注済みだが未到着の量。**生産に使えない**",
      "arrived … その四半期に到着した量",
      "available … 生産に投入できる状態の在庫（availableFromPeriod <= 当四半期）",
      "ending inventory … 生産投入・期限切れ処理の後に残った期末在庫",
    ].join("\n"),
    ruleType: "DEFINITION",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/rawMaterials/types.ts (RawMaterialLot.status / availableFromPeriod), app/lib/v2/rawMaterials/runner.ts",
    appliesToRoles: ["COO", "CFO", "CEO"],
    keywords: ["在庫", "調達", "予定", "発注", "輸送中", "到着", "使用可能", "inventory", "in transit", "arrived", "available"],
    version: V,
  },

  // =====================================================================
  // CONTRACT（実装指示§15）
  // =====================================================================
  {
    id: "CONTRACT.BACKLOG_SEMANTICS",
    domain: "CONTRACT",
    title: "受注残（Backlog）と延滞（Overdue）は別物",
    summary: "Backlogは未履行の契約残高全体。そのうち納期を過ぎたものだけがOverdue。将来納期のbacklogは健全であり、需要の可視性でもある。",
    explanation: [
      "BACKLOG … 未履行の契約残高の合計。これ自体は延滞ではない。",
      "DUE_THIS_TURN … 当四半期が納期の未履行残。",
      "FUTURE_DUE … 納期がまだ先の未履行残（Healthy Forward Backlog）。",
      "OVERDUE … 納期を過ぎても履行できていない残。**これだけが延滞である**。",
      "Healthy Forward Backlog の増加は必ずしも悪ではない。将来の需要が確定しているという情報でもある。",
      "顧客信頼（Trust）や納期信頼性への影響は、納期が到来した義務（due obligation）を履行できたかどうかに基づく。将来納期の残高では下がらない。",
    ].join("\n"),
    ruleType: "DEFINITION",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/sales/types.ts (SalesContract.dueDate / status), app/lib/v2/sales/backlog.ts, app/lib/v2/quality/deliveryObservation.ts",
    appliesToRoles: ["COMMERCIAL", "CEO", "CFO", "COO"],
    keywords: ["受注残", "backlog", "延滞", "overdue", "納期", "due", "未履行", "契約"],
    semanticWarnings: [
      "overdueが0のbacklog増加を「納期遅延」「期限オーバー」と呼んではいけない。",
      "backlog全体をoverdueとして扱わない。",
    ],
    version: V,
  },

  // =====================================================================
  // CAPACITY / PRODUCTION（実装指示§16・§17）
  // =====================================================================
  {
    id: "CAPACITY.POOL_SEMANTICS",
    domain: "CAPACITY",
    title: "生産能力プールの種類（商品ライン能力の合計 ≠ 会社の共通能力）",
    summary: "能力は common processing / HOSO / PD / VAP / freezing-packaging の別プールに分かれる。商品ライン能力の合計と共通前処理能力は別物で、小さい方が実際の制約になる。",
    explanation: [
      "common processing capacity … 全商品が共有する前処理能力。会社の総生産量の天井になる。",
      "HOSO / PD / VAP capacity … 商品別の専用加工ライン能力。",
      "freezing & packaging capacity … 凍結・包装の**処理能力（フロー）**。四半期あたりの処理量上限。",
      "cold storage capacity … 冷凍・冷蔵の**保管能力（ストック）**。同時に保管できる量であり、フローとは別概念。",
      "生産量は、原料 → 共通前処理 → 凍結包装 → 商品ライン → 労働 の各段階の最小値で決まる。",
      "したがって「商品ライン能力の合計 = 会社の生産能力」ではない。共通前処理がボトルネックなら、ライン能力に余力があっても作れない。",
    ].join("\n"),
    ruleType: "DEFINITION",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/production/types.ts (Factory / ProductionAllocationEntry.stages), app/lib/v2/production/allocation.ts",
    appliesToRoles: ["COO", "CEO"],
    keywords: ["生産能力", "capacity", "工場", "満杯", "ボトルネック", "共通前処理", "ライン", "凍結", "保管", "common", "freezing", "cold storage"],
    semanticWarnings: [
      "product-line capacity の合計を company-wide common capacity と同一視しない。",
      "凍結・包装能力（フロー）と冷蔵保管能力（ストック）を混同しない。",
    ],
    version: V,
  },

  // =====================================================================
  // CAPEX（実装指示§18・§19）
  // =====================================================================
  {
    id: "CAPEX.PROJECT_SEMANTICS",
    domain: "CAPEX",
    title: "設備投資の種類とリードタイム",
    summary: "設備投資は提案 → 承認 → 建設（分割払い）→ 完成 → 稼働という段階を踏み、決定した四半期にすぐ能力が増えることはない。",
    explanation: [
      "案件種別: 新工場建設 / HOSOライン増設 / PDライン増設 / VAPライン増設 / 共通前処理能力増設 / 凍結包装能力増設 / 冷蔵保管増設 / 品質管理設備 / 環境設備 / PD省人化投資。",
      "各案件には必要建設四半期数があり、支払いはその期間に分割して発生する。支払いができなかった四半期は建設が進まない。",
      "完成した四半期に建設仮勘定から固定資産へ振り替えられ、そこから能力として使えるようになる。",
      "したがって Turn N に投資を決めても、能力が増えるのは完成後の Turn である（具体的な必要四半期数・金額は案件種別ごとのparameterで決まる）。",
      "工場スペースにも上限があり、既存工場に余地が無ければ増設案件は却下される（新工場が必要になる）。",
      "PD省人化投資は生産能力そのものを増やさない。対象工場のPD労務集約度係数だけを下げる（同じ量をより少ない人手で作れるようになる）。",
    ].join("\n"),
    ruleType: "TIMING",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/capex/types.ts (CapitalProjectType / CapitalProjectStatus), app/lib/v2/capex/capexClose.ts, app/lib/v2/capex/parameters.ts",
    appliesToRoles: ["COO", "CFO", "CEO"],
    keywords: ["設備投資", "CAPEX", "投資", "工場", "増設", "リードタイム", "lead time", "新工場", "機械化", "完成", "稼働"],
    semanticWarnings: ["投資を決定した四半期に能力が増えると説明してはいけない。"],
    version: V,
  },
  {
    id: "CAPEX.NEW_FACTORY",
    domain: "CAPEX",
    title: "新工場の建設と立ち上げ",
    summary: "新工場は建設完了後に稼働開始し、その時点ではWorkerがまだ配置されていない。能力を実際に使うには人員配置が必要になる。",
    explanation: [
      "新工場は capex 案件として提案・承認・建設され、完成した四半期から会社の実効工場（effective factories）に加わる。",
      "稼働開始直後の新工場には、まだ常用Workerの記録が無い。設備能力があってもWorkerを配置しなければ生産できない。",
      "1社あたりの工場数には上限がある。また、既存工場にスペース余地があるうちは、既存増設が優先される設計になっている。",
      "工場数・上限・建設費・必要四半期数はいずれもparameterおよびRunの実状態から取得すべき値であり、固定値として記憶しない。",
    ].join("\n"),
    ruleType: "CONSTRAINT",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/capex/factoryConstruction.ts, app/lib/v2/companyLab/standardAi/decision/newFactory.ts",
    appliesToRoles: ["COO", "CEO", "CFO"],
    keywords: ["新工場", "new factory", "建設", "工場数", "稼働開始", "立ち上げ", "ramp"],
    version: V,
  },

  // =====================================================================
  // QUALITY / TRUST（実装指示§20）
  // =====================================================================
  {
    id: "QUALITY_TRUST.SEMANTICS",
    domain: "QUALITY_TRUST",
    title: "品質スコア・顧客信頼・納期遵守の関係",
    summary: "品質スコアと顧客信頼と納期信頼性は別々の指標で、それぞれ別の要因で動く。成約競争力には効くが、売掛金の回収時期には影響しない。",
    explanation: [
      "Quality Score … 商品別の品質。生産時の操業リスク（無理な増産・原料の鮮度・設備水準）で上下する。",
      "Customer Trust … 市場別の顧客信頼。取引の積み重ねと納期遵守で上下する。",
      "Delivery Reliability … 市場別の納期信頼性。納期が到来した義務をどれだけ履行できたかで決まる。",
      "これら3つは、価格・カバレッジと合成されて**成約の競争力**に効く。",
      "品質管理設備（Quality Control Equipment）のCAPEXは品質側に効く投資である。",
      "【重要】これらが売掛金の回収時期・支払条件を変える仕組みはShrimpXに存在しない。",
    ].join("\n"),
    ruleType: "DEFINITION",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/quality/ (qualityScore / deliveryObservation), app/lib/v2/sales/parameters.ts (competitivenessWeights)",
    appliesToRoles: ["COMMERCIAL", "COO", "CEO"],
    keywords: ["品質", "quality", "信頼", "trust", "納期", "delivery", "顧客", "reliability"],
    semanticWarnings: ["Trust低下 → 売掛金回収遅延、のような一般常識の因果を作らない（ShrimpXには存在しない）。"],
    version: V,
  },

  // =====================================================================
  // STANDARD AI（実装指示§23）
  // =====================================================================
  {
    id: "STANDARD_AI.ROLE",
    domain: "STANDARD_AI",
    title: "Standard AI とは何か",
    summary: "Standard AIは、5社を自動運転する決定論的なルールベースの経営方針。最強のAIでも個性を演じるAIでもなく、比較のためのベースラインである。",
    explanation: [
      "Standard AIは全社共通の同一判断ロジック・同一閾値・同一情報範囲で動く。会社ごとに結果が違うのは、各社の実際の状態と、小幅な経営性格バイアス（原則±5%、最大±10%）の差によるものである。",
      "Standard AIが見られるのは、自社の状態と公開情報（遅行する市場情報）だけであり、他社の非公開計画や未来のシナリオは構造的に受け取れない。",
      "判断の流れ: 観測 → 状況診断（不足型/過剰型） → Vision に対する成長圧力 → 売りたい量（Ambition） → 取りに行く量（Commitment） → 販売・生産・調達・労務・投資・資金・配当の各意思決定。",
      "Crisis Gate: 資金繰り危機の兆候があるとき、新規の販売コミットメント・設備投資提案・営業採用・VAP開発支出・配当を止める安全層が働く。",
      "Standard AIの提案は提案であって、実際に適用された結果とは別である。",
    ].join("\n"),
    ruleType: "DEFINITION",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/companyLab/standardAi/policy.ts, app/lib/v2/companyLab/standardAi/managementProfile.ts, app/lib/v2/companyLab/standardAi/crisisState.ts",
    appliesToRoles: ["CEO", "CFO", "COO", "COMMERCIAL"],
    keywords: ["Standard AI", "スタンダードAI", "AI", "提案", "なぜ", "判断", "方針", "ベースライン"],
    semanticWarnings: ["内部実装の詳細をPlayerへ長々と説明しない。判断の大枠と根拠だけを短く述べる。"],
    version: V,
  },
  {
    id: "STANDARD_AI.SALES_HEADCOUNT_LOGIC",
    domain: "STANDARD_AI",
    title: "Standard AI が営業人数をどう決めるか",
    summary: "必要人数・経済的に欲しい人数・組織上の上限・資金上の上限を別々に算出し、その最小値へ寄せる。採用しなかった場合も必ず理由コードが残る。",
    explanation: [
      "Standard AIは営業採用を次の観点で分けて評価する:",
      "  currentHeadcount（現在人数） / requiredHeadcount（必要人数） / unconstrainedEconomicDesiredHeadcount（採算上欲しい人数） /",
      "  organizationallyAllowedHeadcount（組織上許される人数） / financiallyAllowedHeadcount（資金上許される人数）",
      "採用しない場合の理由は、生産能力に余力が無い／資金余力が無い／原料供給が不確実／限界利益が給与を下回る／Target Scale帯に既に達している 等の理由コードとして残る。",
      "「人が足りない」と「増やしたくない」は別の状態として区別されている。",
    ].join("\n"),
    ruleType: "INTERPRETATION",
    sourceType: "CODE",
    sourceReference: "app/lib/v2/companyLab/standardAi/decision/salesForceHiring.ts",
    appliesToRoles: ["COMMERCIAL", "CEO", "CFO"],
    keywords: ["営業採用", "採用", "人数", "hiring", "headcount", "Standard AI", "増員"],
    version: V,
  },
];
