# ゲーム設定スタジオ（Game Profile Editor）— 調査結果と設計案 v0.1

依頼: `ShrimpX ゲーム設定スタジオ（Game Profile）提案`（2026-10-10）§4
範囲: **調査と設計案のみ。コードは変更していない。**
基点: `75e503b84a57ce61aecf574742ff2bde0a015ee7`（UI-TRIAL-1 まで）
作成: 2026-10-10

---

## 0. まず前提の訂正（3点）

提案文の前提のうち、コードを読んで事実と異なる点があった。設計はこの訂正の上に立てる。

### 0-1. 品質管理設備は「未接続」ではない。2つの効果が既に入っている

| 経路 | 実装 | 状態 |
|---|---|---|
| 設備 → 操業リスクの乗算的低減 → 不適合率・重大事故確率の低下 → Quality Score 改善 | `capex/qualityControlEquipmentEffect.ts`（`computeQualityEquipmentRiskMultiplier`）。`companyLab/qualityControlEquipmentState.ts:19` が呼び、`quality/batchAdjustment.ts:64` が参照 | **接続済み**（間接・確率的） |
| 設備の保有そのものに対する市場の直接評価（qualityReputation +4 point が上限） | `companyLab/qualityEquipmentMarketBonus.ts`。`companyLab/runner.ts:176` から呼ぶ | **接続済み**。ただし `marketAllocationMode === "tieredSimultaneousAllocation"` のときだけ適用（legacy では呼ばれない） |
| 生産能力の増加 | `capex/parameters.ts:246` が `capacityIncreaseTonsPerQuarter: 0` | **意図的に0**（設計上の決定。未実装ではない） |

→ 「品質に投資しても報われない」の原因は「未接続」ではなく、**効果が小さく・確率的で・2期後の品質スコアにしか出ないため、32ターンの順位に現れにくい**ことにある。
設計の論点は「つなぐ」ではなく「**決定論的で、プレイヤーに因果が見える効果を足す**」。これは §3 の品質・規制イベントがまさにその形である。

### 0-2. 排水・環境設備は、ほんとうに効果が無い

`environmentalEquipment` を参照しているのは次だけ。

- `capex/parameters.ts:248`（カタログ定義）
- `production/factorySpace.ts:120`（工場スペースを 900 消費する）
- `standardAi/investmentPortfolio.ts:36`（ポートフォリオ区分を "quality" に分類）
- 監査Workbookの辞書・AI会議のプロンプト（表示のみ）

→ 発生するのは**コスト（減価償却＋保守費）とスペース消費だけ**。便益はどこにも無い。
「未接続」はこちらが正しい。

### 0-3. crowding の記録は「無い」のではなく「置き場所が違う」

- AI Analysis Pack（`simulation/aiPack/**`）には crowding の記録が**無い**（指摘どおり）。
- 一方、**監査Workbook（`simulation/auditWorkbook/**`）には入っている**（`rows.ts` / `dictionary.ts` / `types.ts` / `workbook.ts`）。
- さらに `sales/persistedCrowdingDiagnostics.ts` が診断を永続化している。

→ 必要なのは新規計測ではなく、**既にある診断を AI Pack 側へ出すこと**。実装コストは小さい。

---

## 1. 現状の値・ロジックの所在一覧

「形」の列は、Game Profile へ外出しするときの難易度に直結する。
**定数**＝ファイル直書き、**parameters**＝バージョン付きパラメータ束、**Scenario正本**＝シナリオ定義に入っている、の3種類。

### A. 市場×商品の需要・成長・価格・顧客構成・ベトナム産の取り分

| 値 | 所在 | 形 |
|---|---|---|
| 市場別の潜在需要（CN 380,000 / US 320,000 / EU 260,000 / JP 90,000 / OTHER 150,000） | `scenario/parameters.ts:173` `SCENARIO_INITIAL_STATE_OVERRIDES_V1` | Scenario正本の初期値上書き |
| 同じ比率の需要ウェイト | `market/destinationPricingParameters.ts:66` `DESTINATION_MARKET_DEMAND_WEIGHTS_V1` | 定数（分数で直書き） |
| 需要の成長・変動 | `scenario/types.ts:185` `LongTermTrend`（変数 `REGIONAL_DEMAND` / `CONSUMPTION_GROWTH` / `ECONOMIC_INDEX`）。シナリオ定義 `scenario/definitions/dynamicScenario2.ts` 等 | Scenario正本（キーフレーム＋補間） |
| **商品構成比（市場×商品）** | `market/productLifecycle.ts:72` `PRODUCT_LIFECYCLE_PARAMETERS_V1`、`computeMarketProductMix(turn)`（:190）。シナリオ上書きは `scenario/lifecycle.ts:29` | parameters ＋ Scenario上書き |
| 市場別・商品別の基準価格係数 | `market/destinationPricingParameters.ts:48 / :95 / :115`（Neutral / Initial / Current） | 定数（3テーブル） |
| 顧客構成（価格重視・標準・プレミアムの比率と感度） | `sales/parameters.ts:35` `CUSTOMER_TIER_IDS`、`:45` `CustomerTierParameters`、`:100` `TieredMarketAllocationParameters`、現行値 `:616` `TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1` | parameters。**市場×商品の上書き口が既にある**（`:94` `TieredMarketAllocationOverride`） |
| 集中価格下落（閾値・強さ・下限） | `sales/crowding.ts:58` `CrowdingMarkdownCoefficients`（`threshold` / `lambda` / `gamma` / `floor`）、`:74` `CrowdingPolicy`（`byProduct` ＋ `marketOverrides` ＋ `protectedExternalShare`）、現行値 `:152 / :160` `*_V200_P1` | parameters。**商品別・市場別の上書き口が既にある** |
| ベトナム産が取れる割合 | 直接のパラメータは無い。国別輸出可能供給（`scenario/parameters.ts:173` の国別能力 EC 550,000 / IN 650,000 / ID 350,000 / VN 450,000）と `market/parameters.ts` の国際価格連動・需要再配分（`hosoPriceSelfCorrection.demandReallocationPriceSensitivity`）から**内生的に決まる** | 導出値。`EXPORTABLE_SUPPLY` 変数で直接上書きは可能 |
| ベトナム国内の原料需給 | `market/parameters.ts:183` `MARKET_PARAMETERS_V1.vietnamDomestic` | parameters |

**設計上の重要な発見**: 需要は今「**市場単位（5値）× 商品構成比（ターン依存の比率）**」で表されており、**市場×商品の15マスを絶対量で持つ構造にはなっていない**。
提案文の「15マスを表で編集する」をそのまま作ると、Engine の需要モデルを置き換えることになる。
→ **推奨**: 15マスは「市場需要 × 商品構成比」の**計算結果を表示**し、編集は (a) 市場別の需要、(b) 商品構成比のカーブ、の2層に対して行う。表示は15マスのままにできるので、画面の見た目は提案どおりにできる。

### B. 価格・原料のスケジュール

| 値 | 所在 | 形 |
|---|---|---|
| 販売市場価格指数・原料市場価格指数・配当性向（ターン別） | `companyLab/manualBalance/overrides.ts:46` `ManualBalanceSettings`、`:69` 以降のスケジュール型、解決は `resolveManualBalanceForTurn` | **既に Balance Profile として外出し済み** |
| 操業コストのインフレ | `scenario/types.ts:239` `OperatingCostInflationSettings`（`tracks` ＋ `CostIndexTrack`） | Scenario正本 |
| 原料買付価格指数 | `scenario/types.ts:253` `RawMarketPricingSettings.rawPriceCaptureIndex` | Scenario正本 |
| 国別輸出可能量 | `scenario/parameters.ts:173` ＋ `EXPORTABLE_SUPPLY` トレンド | Scenario正本 |

### C. 設備投資カタログ（10種類）

正本は `capex/parameters.ts:148` `templatesByType`。型は `:34` `CapexProjectTemplate`。
種別は `capex/types.ts:44`（10種類）。

| 種別 | 予算 | 支払比率 | 能力増 | 稼働待機 |
|---|---|---|---|---|
| hosoLineExpansion | $8,000,000 | [1.0]（工期1Qのため一括） | hoso +4,000 t/Q | 1Q |
| pdLineExpansion | $4,000,000 | [0.3, 0.4, 0.3] | pd +350 t/Q | 1Q |
| vapLineExpansion | $6,000,000 | [0.25, 0.35, 0.25, 0.15] | vap +250 t/Q | 2Q |
| coldStorageExpansion | $2,500,000 | [0.5, 0.5] | coldStorage +1,250 t | 1Q |
| freezingPackagingExpansion | $2,800,000 | [0.4, 0.6] | freezingPackaging +800 t/Q | 1Q |
| commonProcessingExpansion | $5,000,000 | [0.3, 0.4, 0.3] | commonProcessing +700 t/Q | 1Q |
| newFactoryConstruction | $22,000,000 | [0.3, 0.35, 0.35] | 工場1棟を追加 | 1Q |
| pdMechanization | $2,500,000 | [0.4, 0.6] | 0（PD労働集約度を下げる） | 1Q |
| qualityControlEquipment | $1,200,000 | [0.6, 0.4] | 0 | 0Q |
| environmentalEquipment | $1,800,000 | [0.5, 0.5] | 0 | 0Q |

テンプレートが持つ項目: `standardBudgetUsd` / `standardConstructionQuarters` / `paymentRatios` / `assetCategory` / `postCompletionReadinessQuarters` / `buildingRatio` / `machineryRatio` / `maintenanceRatePerQuarter` / `futureCapacityEffect` / `newFactoryEffect?`。
償却年数は種別ごとではなく**構成要素ごと**に1か所（`:362` `componentUsefulLifeQuarters: { building: 100, machinery: 40 }`）。
工場スペース消費は別ファイル `production/factorySpace.ts`。

提案文の「ターンによる価格変化」「会社タイプ別の割引」「Standard AI の提案対象か」は、**いずれも現在存在しない**。新規項目になる。

### D. 品質管理設備・排水環境設備と品質スコアの関係

§0-1・§0-2 のとおり。品質スコア側のパラメータは `quality/parameters.ts:16` `QualityParameters`
（`operationalRisk.weights`＝稼働率・残業・臨時工・複雑性・原料鮮度・立ち上げ、`qualityOutcome`、`majorIncident`）。

### E. シナリオイベントとニュース

| 値 | 所在 |
|---|---|
| イベント定義 | `scenario/types.ts:143` `ScenarioEvent`（`eventType` / `targetCountries` / `targetMarkets` / `startTurn` / `durationTurns` / `rampUpTurns` / `recoveryTurns` / `effects` / `informationReleaseIds` / `variationRange`） |
| イベントの効果 | `scenario/types.ts:128` `ScenarioEffect`（`variable` / `mode` / `magnitude`）。動かせる変数は `:26` `ScenarioBaseVariable` の **20種類** |
| 発動エンジン | `scenario/eventEngine.ts` |
| ニュース（情報開示）定義 | `scenario/types.ts:291` `InformationRelease`（`availableFromTurn` / `informationLevel` / 構造化facts / 推定レンジ） |
| ニュース配信 | `scenario/informationEngine.ts:31` `getAvailableInformation` |
| 文面テンプレート | `scenario/definitions/informationTemplates.ts`、`dynamicScenario1News.ts` |
| AI会議への供給 | `companyLab/aiManagementMeeting/scenarioNews.ts:65` |

**重要**: `ScenarioBaseVariable` に **品質・規制・市場アクセスの変数が無い**（`QUALITY_SCORE` はあるが会社別の合否判定ではない）。
提案文 D のイベントは、既存の `ScenarioEffect` では表現できない。**新しい効果の種類が必要**（§3）。

### F. 銀行・金融

正本は `financing/parameters.ts:8` `FinancingParameters`。
- `interestRate`: `baseRateAnnual` / 信用格付（A〜E）別スプレッド / 緊急融資上乗せ / コベナンツ違反上乗せ / 延滞履歴上乗せ / リファイナンス上乗せ / 期間上乗せ
- `creditScore`: 9項目の重み（現金ランウェイ・営業CF・収益性・インタレストカバレッジ・レバレッジ・自己資本比率・返済実績・延滞履歴・顧客信頼）＋格付閾値
- `borrowingCapacity`: 売掛金・原料在庫・輸送中・製品在庫の各ヘアカット、`earningsMultiple`、格付別の自己資本倍率
- `covenant`: 最低自己資本比率 / 最大負債比率 / 最低インタレストカバレッジ / 違反ペナルティ / 連続違反で凍結
- `emergencyLoan`: 金利レンジ / 担保比率上限 / 絶対上限

ロジックは `financing/` の `bankUnderwriting.ts` / `borrowingCapacity.ts` / `covenant.ts` / `creditScore.ts` / `interestRate.ts` / `liquidityClose.ts` / `loanSchedule.ts`。

→ 提案文 F の「承認率」「赤字の期の減額率」「審査結果の理由をプレイヤーに表示する」は**現在無い**。
ただし `bankUnderwriting.ts` は内部で減額の判断をしているので、**理由コードを返す形に変えれば表示できる**見込み（要調査）。

### G. 配当・企業評価

- 配当: `finance/parameters.ts:99` `FinanceParameters` / `:210` `FINANCE_PARAMETERS_V1`、`finance/dividend.ts`、`finance/annualDividend.ts`、`finance/annualDividendGuidance.ts`
- 管理者指定の配当性向: `manualBalance/overrides.ts`（Balance Profile 側）
- TSV: `companyLab/evaluation/evaluationSemantics.ts`。式は **TSV(t) = Dividend Value(t) + Current Company Value(t)**。DCF・15%複利・正常化CFの lookback もここ。全履歴のマージは `evaluationHistory.ts`

### H. 会社の初期条件

`companyLab/fixtures.ts:136` `buildCompanyFixtures(startPeriod)`。5社（`:305` `COMPANY_LAB_COMPANY_IDS` = BAL / MASS / JPQ / VAP / CONSV）を**ハードコードで組み立てている**。
補助関数は同ファイルの `factory` / `workerBaseline` / `premiumEconomics` / `productEconomics` / `initialLot`。
財務初期値は `finance/initialState.ts`、借入初期ポートフォリオは `financing/initialPortfolio.ts`、初期契約は `companyLab/initialContracts.ts`。

---

## 2. Game Profile のスキーマ案

### 2-1. 設計の原則（Balance Profile から引き継ぐ）

既存の `manualBalance/profile.ts` 冒頭に書かれている原則は、そのまま Game Profile にも適用すべきである。

1. **Profile は Scenario ではない。** Scenario 定義へ書き込まない。1つの Run は
   `Scenario + Seed + Sales Model + Game Profile + source commit` で再現できる、という関係を保つ。
2. **第二の SSoT を作らない。** ターンごとの実効値を解決するのは既存の Engine 関数だけ。
   Profile は「名前付きで持ち運ぶ入れ物」であり、独自の解決ロジックを持たない。
3. **Profile は予定、実績は別。** そのRunで実際に適用された値の正本は Run 側（`manualBalanceApplied` 相当）に置く。
   Profile を後から編集しても過去 Run の実績は動かない。
4. **既定（現行と同一）Profile は編集不可。** 複製して編集する。

### 2-2. 型（案）

```ts
/** 仕様版。構造や意味が変わったときだけ上げる。未知の版を黙って解釈しない印。 */
export const GAME_PROFILE_SPEC_VERSION = "game-profile-v1";

/** 既定（現行と完全同一）を表す固定ID。これを選んだRunは現行と同じ結果になる。 */
export const DEFAULT_GAME_PROFILE_ID = "default";

export interface GameProfile {
  readonly profileId: string;
  readonly profileName: string;
  readonly description: string;
  readonly specVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 編集不可の既定Profileか。true のものは複製してから編集する。 */
  readonly readOnly: boolean;
  readonly createdFromProfileId?: string;
  readonly createdFromRunId?: string;
  /** このProfileを作成したアプリのcommit（Runの計算commitではない）。取得不能なら "UNKNOWN"。 */
  readonly sourceCommit?: string;

  /** 各タブの中身。省略されたセクションは「既定のまま」を意味する（空オブジェクトと区別する）。 */
  readonly market?: MarketSizeSection;            // A
  readonly schedule?: BalanceScheduleSection;     // B（既存 Balance Profile を内包）
  readonly capexCatalog?: CapexCatalogSection;    // C
  readonly qualityRegulation?: QualityRegulationSection; // D（新規の中核）
  readonly news?: NewsSection;                    // E
  readonly banking?: BankingSection;              // F
  readonly dividendValuation?: DividendValuationSection; // G
  readonly initialConditions?: InitialConditionsSection; // H
}
```

セクションは**すべて「既定からの差分（Partial）」として持つ**。全項目を複製しない。
理由は2つある。(a) 既定Profileで現行と完全一致させる保証が容易になる（§4）。
(b) Engine 側のパラメータが増えたときに Profile が古いままでも壊れない。

```ts
/** A. 市場規模。15マスを絶対量で持たず、既存の2層構造（市場需要 × 商品構成比）に合わせる。 */
export interface MarketSizeSection {
  /** 市場別の潜在需要（t/年）。省略した市場は既定のまま。 */
  readonly regionalDemandTonsPerYear?: Partial<Readonly<Record<DemandMarketId, number>>>;
  /** 需要の成長。既存 LongTermTrend のキーフレームと同じ形で持つ（新しい補間を作らない）。 */
  readonly demandTrendKeyframes?: Partial<Readonly<Record<DemandMarketId, readonly LongTermTrendKeyframe[]>>>;
  /** 商品構成比のカーブ。既存 ProductLifecycleParameters の差分。 */
  readonly productLifecycle?: Partial<ProductLifecycleParameters>;
  /** 市場×商品の基準価格係数。既存の3テーブルと同じ形。 */
  readonly destinationPriceCoefficients?: Partial<DestinationMarketPriceCoefficientTable>;
  /** 顧客構成。既存 TieredMarketAllocationParameters の差分（market×product の override 口を再利用）。 */
  readonly tieredAllocation?: Partial<TieredMarketAllocationParameters>;
  /** 集中価格下落。既存 CrowdingPolicy の差分（byProduct / marketOverrides をそのまま使う）。 */
  readonly crowding?: Partial<CrowdingPolicy>;
  /** 国別輸出可能供給の直接指定（EXPORTABLE_SUPPLY 相当）。 */
  readonly exportableSupplyTonsPerYear?: Partial<Readonly<Record<CountryId, number>>>;
}

/** B. 既存 Balance Profile をそのまま内包する（移行を壊さないため）。 */
export interface BalanceScheduleSection {
  /** 既存 ManualBalanceSchedule をそのまま持つ。解決は resolveManualBalanceForTurn のみ。 */
  readonly manualBalance?: ManualBalanceSchedule;
  readonly operatingCostInflation?: Partial<OperatingCostInflationSettings>;
  readonly rawMarketPricing?: Partial<RawMarketPricingSettings>;
}

/** C. 設備投資カタログ。既存 CapexProjectTemplate の差分 ＋ 新規3項目。 */
export interface CapexCatalogSection {
  readonly templates?: Partial<Readonly<Record<CapitalProjectType, Partial<CapexProjectTemplate>>>>;
  readonly componentUsefulLifeQuarters?: Partial<{ building: number; machinery: number }>;
  readonly factorySpaceCost?: Partial<Readonly<Record<CapitalProjectType, number>>>;
  /** 新規: 建設費のターン依存。年率インフレ、または期間指定の割増・割引。 */
  readonly budgetSchedule?: readonly CapexBudgetAdjustment[];
  /** 新規: 会社タイプ別の割引（0.3 = 30%安い）。 */
  readonly companyDiscounts?: readonly CapexCompanyDiscount[];
  /** 新規: Standard AI が提案対象にするか（未指定は従来どおり全種別が対象）。 */
  readonly standardAiEligibleTypes?: readonly CapitalProjectType[];
}

export interface CapexBudgetAdjustment {
  readonly projectTypes: readonly CapitalProjectType[] | "all";
  readonly fromTurn: number;
  readonly toTurn: number;
  /** 乗数。1.2 = +20%。年率インフレで表したい場合は annualInflationRate を使う。 */
  readonly multiplier?: number;
  readonly annualInflationRate?: number;
  readonly note: string;
}

export interface CapexCompanyDiscount {
  readonly companyId: CompanyId;
  readonly projectTypes: readonly CapitalProjectType[];
  /** 0.3 = 30%割引。 */
  readonly discountRatio: number;
  readonly note: string;
}
```

品質・規制イベント（D）とニュース（E）は §3 で扱う。F・G・H は既存 parameters の `Partial` で足りる。

```ts
export interface BankingSection {
  readonly financing?: Partial<FinancingParameters>;
  /** 新規: 申請額に対する承認額の上限（%）。 */
  readonly approvalRatioCap?: number;
  /** 新規: 赤字の期の減額率。 */
  readonly lossQuarterReductionRatio?: number;
  /** 新規: 審査結果の理由をプレイヤーへ表示するか。 */
  readonly discloseUnderwritingReason?: boolean;
}

export interface DividendValuationSection {
  readonly finance?: Partial<FinanceParameters>;
  /** TSVの重み・評価方法。既存 evaluationSemantics の定数を外出しする。 */
  readonly valuation?: Partial<ValuationParameters>;
}

export interface InitialConditionsSection {
  /** 会社ごとの初期値の差分。fixtures.ts の組み立て結果に対する上書き。 */
  readonly byCompany?: Partial<Readonly<Record<CompanyId, CompanyInitialOverride>>>;
}
```

### 2-3. Balance Profile との統合方法

**Balance Profile を捨てない。Game Profile の1セクションとして内包する。**

| 方針 | 内容 |
|---|---|
| 既存Profileの読み込み | `BalanceProfile`（`balance-profile-v1`）を読んだら、`GameProfile.schedule.manualBalance` へ入れた Game Profile として扱う。既存Profileの JSON はそのまま取り込める |
| 既存Profileの保存 | Game Profile のうち `schedule.manualBalance` だけを持つものは、Balance Profile としても書き出せる（研修中の運用を壊さない） |
| 解決 | ターン別の指数・配当性向の解決は**これまでどおり `resolveManualBalanceForTurn` だけ**が行う。Game Profile 側に解決ロジックを作らない |
| 画面 | 既存の Balance 画面は Game Profile Editor の「B. 価格・原料のスケジュール」タブになる。移行期は両方から同じ値を触れてよい |

### 2-4. Run・AI Analysis Pack への記録方法

既存の `appliedBalanceProfile` が良い前例になっている（`manualBalance/profile.ts:141` `AppliedBalanceProfileRef`）。
同じ形を踏む。

```ts
export interface AppliedGameProfileRef {
  readonly appliedGameProfileId: string;
  readonly appliedGameProfileName: string;
  readonly appliedGameProfileSpecVersion: string;
  /** コピー時点の中身の指紋。手動変更の有無を照合する。 */
  readonly appliedGameProfileFingerprint: string;
  /** セクション単位の指紋。どのタブが既定と違うかを一覧できる。 */
  readonly sectionFingerprints: Readonly<Record<GameProfileSectionKey, string>>;
}
```

- `SimulationRun`（`simulation/types.ts:63`）へ `appliedGameProfile?: AppliedGameProfileRef` を追加する。
  既存の `appliedBalanceProfile`（:100）・`runCreatedByCommit`・`calculationCommitHistory`・
  `gameParameterVersion` / `scenarioVersion` / `standardAiVersion` / `strategyProfileVersion` と並べる。
- 実際に各ターンへ適用された値は、`SimulationSession.manualBalanceApplied`（:245）と同じ考え方で
  `gameProfileApplied` として別に持つ。**Profile を後から編集しても過去Runの実績は動かない。**
- AI Analysis Pack は既に版情報を出している（`aiPack/context.ts:478-480`、`summary.ts:57/74`、
  `workbook.ts:59/66`）。ここへ `appliedGameProfile` の ID・名前・指紋・セクション指紋を**行追加するだけ**でよい。
- 併せて §0-3 の crowding 診断（`sales/persistedCrowdingDiagnostics.ts`、監査Workbook側に既にある）を
  AI Pack へも出す。

---

## 3. 品質・規制イベントの設計案

### 3-1. なぜ既存の ScenarioEffect では足りないか

既存 `ScenarioEffect` は `{ variable, mode, magnitude }` であり、動かせるのは
`ScenarioBaseVariable` の20変数（国別能力・疾病圧力・地域需要・物流能力など）。
いずれも**シナリオ全体・国単位・市場単位**にかかる。

品質・規制イベントが必要とするのは「**会社ごとに合否を判定し、不合格の会社だけに影響を与える**」であり、
これは既存の形では表現できない。**新しい効果の種類**として足す必要がある。

### 3-2. 型（案）

```ts
export interface QualityRegulationSection {
  readonly events?: readonly QualityRegulationEvent[];
  /** 品質管理設備の平常時の効果。既存の2経路（§0-1）の強さを調整できるようにする。 */
  readonly equipmentSteadyStateEffect?: {
    /** 既存 qualityEquipmentMarketBonus の full effect（既定 4 point）。 */
    readonly qualityReputationBonusPoints?: number;
    /** 既存 qualityControlEquipmentEffect の risk multiplier の強さ。 */
    readonly operationalRiskMultiplier?: number;
    /** 新規: プレミアム顧客の獲得率への加点。 */
    readonly premiumTierAcquisitionBonus?: number;
  };
}

export interface QualityRegulationEvent {
  readonly eventId: string;
  readonly kind:
    | "importInspectionTightening"   // 輸入検査の強化
    | "residueRegulation"            // 残留薬品規制
    | "qualityIncident"              // 品質事故
    | "certificationRequirement"     // 認証要件の導入
    | "effluentRegulation";          // 排水規制
  readonly triggerTurn: number;
  readonly targetMarkets: readonly DemandMarketId[];
  readonly targetProducts: readonly Product[];

  /** 合格条件。すべて満たす必要があるか、いずれかで足りるかを選ぶ。 */
  readonly passCondition: {
    readonly mode: "all" | "any";
    readonly requireQualityEquipmentOperational?: boolean;
    readonly requireEnvironmentalEquipmentOperational?: boolean;
    readonly minQualityScore?: number;
  };

  /** 不合格の会社への影響。 */
  readonly failureEffect: {
    /** 成約量を減らす（0.6 = −60%）。 */
    readonly contractedVolumeReductionRatio?: number;
    /** 市場アクセスを停止する期間（四半期）。 */
    readonly marketAccessSuspensionQuarters?: number;
    /** 価格の値引き（0.1 = −10%）。 */
    readonly priceMarkdownRatio?: number;
    /** 在庫の廃棄（対象商品の期末在庫に対する比率）。 */
    readonly inventoryDiscardRatio?: number;
    readonly fineUsd?: number;
  };

  /** 合格した会社への恩恵。 */
  readonly passBenefit?: {
    readonly premiumTierShareBonus?: number;
    /** 不合格の会社から需要を移すか。 */
    readonly absorbFailedDemand?: boolean;
  };

  readonly durationQuarters: number;
  readonly recovery: "immediate" | "gradual";

  /** 予兆ニュース。備えた会社が報われる設計にするために使う。 */
  readonly forewarning?: {
    readonly leadQuarters: number;
    readonly informationLevel: InformationLevel;  // 既存の型を再利用
    readonly newsId: string;
  };
}
```

### 3-3. 設定例（提案文の例をそのまま表現できる）

```ts
{
  eventId: "eu-residue-2026",
  kind: "residueRegulation",
  triggerTurn: 14,
  targetMarkets: ["EU"],
  targetProducts: ["hoso", "pd", "vap"],
  passCondition: { mode: "all", requireQualityEquipmentOperational: true },
  failureEffect: { contractedVolumeReductionRatio: 0.6 },
  passBenefit: { absorbFailedDemand: true },
  durationQuarters: 3,
  recovery: "immediate",
  forewarning: { leadQuarters: 2, informationLevel: "SUGGESTIVE", newsId: "eu-residue-forewarning" },
}
```

T12 に予兆ニュース、T14 に発動、品質管理設備が未稼働の会社は EU 向け成約が3期間 −60%。

### 3-4. どの計算に接続するのが自然か

3つの候補を比べた。**推奨は (2) の `credibleOffer` 段**。

| 候補 | 接続先 | 評価 |
|---|---|---|
| (1) 三層配分の効用 | `sales/tieredAllocation.ts` の効用関数に合否項を足す | 「プレミアム顧客が逃げる」を自然に書ける。ただし効果量が配分の非線形を通るため、**「−60%」を指定しても結果が −60% にならない**。GMが数値を決めづらい |
| (2) **成約可能量（credibleOffer）** | `sales/credibleOffer.ts`。合否判定の結果を、その会社・市場・商品の提示可能量に対する上限として掛ける | **−60% が素直に −60% として出る**。既に crowding が同じ段で乗数を掛けており（`sales/crowdingLayer.ts`）、**同じ場所に層をもう1枚足す形**になる。市場アクセス停止も「上限0」で表現できる |
| (3) 品質スコア | `quality/batchAdjustment.ts` 経由 | 既存の間接経路と二重計上になりやすく、効果が2期遅れる。**予兆→対策→結果の因果がプレイヤーに見えない** |

**推奨の形**

- 合否判定は**販売計画の確定前**に行い、その結果（会社×市場×商品の合否と乗数）を
  `crowdingLayer.ts` と同じ「層」として `credibleOffer` に適用する。
- 「不合格の会社から需要が移る」は、crowding が既に持っている
  `protectedExternalShare` と同じ考え方で、**解放された需要を合格した会社へ再配分**する。
- 平常時の効果（§3-2 の `equipmentSteadyStateEffect`）は既存2経路の強さを調整するだけにし、
  **新しい経路を作らない**（二重計上を避ける）。
- 排水・環境設備（§0-2）は、`effluentRegulation` の合格条件に使うことで**初めて便益を持つ**。
  これが「コストだけの投資」を解消する最小の方法である。
- 診断の記録は crowding と同じ場所（`persistedCrowdingDiagnostics.ts` に倣った
  `persistedRegulationDiagnostics.ts`）へ置き、監査Workbook と AI Pack の両方へ出す。

---

## 4. 既定Profileで現行と完全一致させる回帰テストの方法

**原則**: 「既定Profileを選んだRunは、Game Profile 機能が無かったときと**ビット単位で同じ**結果になる」ことを、
人の目視ではなく機械で保証する。既存コードベースに同じ趣旨の前例が複数ある
（`qualityEquipmentMarketBonus.ts` の「legacy では呼ばれないため既存Scenarioの挙動はビット単位で不変」）。

### 4-1. 4層で守る

| 層 | 方法 |
|---|---|
| **(a) 型の層** | 全セクションを `Partial`（省略＝既定）にする。既定Profile は**全セクション省略**（＝空の `GameProfile`）と定義する。これにより「既定Profile を適用する」＝「何も適用しない」がコードの形として同じになる |
| **(b) 適用関数の層** | `applyGameProfile(params, profile)` が、`profile` のセクションが省略なら**入力オブジェクトの参照をそのまま返す**（新しいオブジェクトを作らない）。単体テストで `assert.strictEqual(applied, original)`（参照同一）を検査する。これが通れば、既定で値が変わる余地が構造的に無い |
| **(c) スナップショットの層** | 既定Profile と Profile 未指定で、**同じ Scenario・同じ Seed・同じ Sales Model で 32Turn を回し、Run の全出力を突き合わせる**。比較対象は `buildDatasetFromSession` の結果（既に全ターン・全社の記録を持っている）。現行の `scripts/int1/run32TurnRegression.ts` と `smoke32Turn.ts` が同じことをしているので、**その仕組みを再利用する** |
| **(d) 否定対照（negative control）** | 既定Profile の1項目だけを変えた Profile で (c) を回し、**必ず差分が出ること**を確認する。差分が出なければ、その項目は実は Engine へ繋がっていない（＝実装漏れ）。UI-TRIAL-1 と BW-1 で使った手法と同じ |

### 4-2. 対象シナリオ

既定Profileでの一致は、**現在使っている全シナリオ × 全 Sales Model**で確認する。
最低でも次の組み合わせ。

- baseline / legacyWaterfall
- dynamicScenario2 / tiered-v200-candidate
- dynamicScenario2 / tiered-v200-crowding-v1（研修で使う組み合わせ）

### 4-3. 注意点

- (c) のスナップショットは**ファイルへ焼き付けない**。焼き付けると、意図した変更のときに
  「スナップショットを更新する」作業が発生し、事故を見逃す。**同一プロセス内で2回回して突き合わせる**形にする。
- 浮動小数の比較は厳密一致（`===`）で行う。許容誤差を入れると (b) の保証が意味を失う。
- Profile の指紋（`appliedGameProfileFingerprint`）は、既定Profileでも**安定した固定値**になることを検査する。

---

## 5. 管制室のタブが裏に回ると進行が遅くなる問題

### 5-1. 原因（コードで特定済み）

`app/v2/management/components/ManagementConsole.tsx` は `"use client"` であり、
**32ターンの計算はブラウザの中で回っている**（`advanceSimulationTurn` をループで呼ぶ）。
そのループの中に次の1行がある。

```
app/v2/management/components/ManagementConsole.tsx:736
  await new Promise((r) => requestAnimationFrame(() => r(null)));
```

これは「ブラウザへ制御を戻して進捗表示を実際に描画させる」ための待機である。
`requestAnimationFrame` は**タブが非表示のとき、ブラウザが発火を止める／大幅に間引く**。
結果、ターンごとにこの待機が数秒〜十数秒に伸びる。提案文の「1ターン約110秒（前面なら数秒）」はこれで説明がつく。

**つまり原因は「計算が遅い」ではなく「1ターンごとに描画フレームを待っている」ことである。**

### 5-2. 対策案（3段階。軽いものから）

| 案 | 内容 | 効果 | コスト |
|---|---|---|---|
| **案1（最小）** `requestAnimationFrame` をやめる | 進捗を返す待機を `setTimeout(0)` またはメッセージチャネル（`MessagePort.postMessage`）に置き換える。どちらも非表示タブで止まらない（`setTimeout` は1秒以上に間引かれる環境があるため、`MessageChannel` のほうが確実） | 裏タブでの遅延は**ほぼ解消する**見込み。ゲーム計算には一切触らない | 小。1行＋ヘルパー。影響範囲が狭く、32Turn回帰テストで同一結果を確認できる |
| **案2** Web Worker へ計算を移す | `advanceSimulationTurn` を Worker 内で回し、UIスレッドは進捗の受信だけにする。Engine は純粋関数の集まりなので Worker へ載せやすい | UIが固まらなくなる副次効果もある。ただし**Worker も非表示タブで間引かれる環境がある**ため、案1を入れずに案2だけでは不十分 | 中。セッション状態の受け渡し（structured clone）とバンドル構成の変更が要る |
| **案3** サーバー側で一括実行 | 「全社AIで32ターンを回す」をサーバーのジョブにする。**すでに土台がある**: `companyLab/standardAi/autoplay/runBatch.ts` / `runCase.ts` と CLI（`autoplay/cli/`）が、画面なしで一括実行する仕組みを持っている | タブを閉じても進む。§2-3 の「プレビュー」「A/B比較」に必要 | 大。実行時間の制約（Vercel のサーバーレス実行時間上限）と、途中状態の保存・再開が要る |

**推奨の順序**

1. **まず案1を入れる。** 原因が特定できており、1行の置き換えで効く。
   回帰テストは「32Turnの結果が変わらないこと」だけで足りる。研修前に入れられる。
2. 研修本番の運用（GMがタブを切り替える）に不安が残るなら案2を足す。
3. 案3は Game Profile の「プレビュー」「A/B比較」とセットで、フェーズ3として扱う。
   既存の autoplay をサーバー経路から呼べるようにするのが最短。

---

## 6. 実装順序への意見

提案文の3フェーズに大きな異論は無い。順序について2点だけ変える。

| | 提案文 | 本案 |
|---|---|---|
| 裏タブ問題 | フェーズ3（検証機能と一緒） | **フェーズ0（今すぐ）**。原因が1行に特定できており、研修の進行そのものに関わる |
| 排水・環境設備 | 言及なし | **フェーズ2でDと同時**。`effluentRegulation` の合格条件に使うことで初めて便益を持つ。今は純粋な損失である |

フェーズ1で「今コードにある値を外へ出すだけ」にする方針は正しい。
ただし §1-A のとおり、**市場規模の15マスは絶対量で持たれていない**。
フェーズ1では「市場別需要 ＋ 商品構成比」を外出しし、15マスは計算結果の表示にとどめるのが安全である。

---

## 7. この調査で変更していないもの

コードは1行も変更していない。この文書だけを追加した。
Scenario値・市場係数・AI戦略・ゲーム計算・保存形式・Redisキー・TTL はいずれも未変更。
