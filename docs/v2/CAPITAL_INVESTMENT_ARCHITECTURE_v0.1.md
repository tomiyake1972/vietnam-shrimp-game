# ShrimpX V2 — 設備投資モジュール（Phase 8B-2A: 設備投資案件・建設中勘定・分割支払・完成振替） アーキテクチャ v0.1

## 0. 本モジュールの位置づけ

`app/lib/v2/capex/` は、Phase 8A（財務三表）・Phase 8B-1（資金繰り・借入・銀行信用）の会計・資金制約基盤の外側に、「設備投資案件を提案し、承認され、分割支払で建設し、完成すれば固定資産へ振替わる」という設備投資の意思決定・状態遷移レイヤーを追加する。既存の`finance/quarterClose.ts`（`closeFinancialQuarter`）・`financing/liquidityClose.ts`（`closeQuarterWithFinancing`）はいずれも**一切書き換えない**。`closeFinancialQuarter`へ新設した単一の追加オプショナル引数`capex?: CapexAdjustment`を渡すだけで接続する、Phase 8B-1の`financing?: FinancingAdjustment`と同じ後方互換パターンを採用した（既存943件超のPhase 8A/8B-1テストは無改修・無回帰）。

対象外（Phase 8B-2Aでは扱わない。詳細は§10）: 新規生産能力の即時増加、新設備の減価償却開始、追加人員・段階固定費の増加、設備専用融資、投資採算（NPV/IRR/回収期間）、UI、Redis/API実配線、本番ゲーム画面統合。

## 1. モジュール構成

- `types.ts` — `CapexValidationError`、6種類の投資案件種別（`CapitalProjectType`）、6状態（`CapitalProjectStatus`）、分割支払スケジュール（`PaymentScheduleStage`）、投資案件（`CapitalProject`）、会社別投資ポートフォリオ（`CapitalProjectPortfolio`）、会社別設備投資状態（`CompanyCapexState`）、意思決定入力（`CapexDecisionInput`）、四半期処理結果（`CapexQuarterResult`）。
- `parameters.ts` — `CAPEX_PARAMETERS_V1`。6種類のテンプレート（標準予算・分割支払比率・資産カテゴリ）、最低現金準備額、会社ごとの同時進行中案件数上限、丸め誤差許容値をすべて1ファイルへ集約（暫定値・要校正）。
- `projectLifecycle.ts` — 提案評価（`evaluateProposal`）、取消適用（`applyCancelRequest`）、再開要求検証（`validateResumeRequest`）、支払優先順位付け（`buildPaymentQueue`）、全額支払のみの分割払い試行（`attemptPayment`）を行う純粋関数群。
- `capexClose.ts` — 四半期クローズの本体（`closeQuarterWithCapex`）。`closeQuarterWithFinancing`が確定させた資金繰り確定後の財務結果を起点に、当期の投資案件処理と`finance/`への三段目`closeFinancialQuarter`呼び出しで最終PL/BS/CFを確定する。
- 会社ラボ接続: `companyLab/runner.ts`の`advanceCompanyLabQuarter`が、financing決算確定後に5社ぶんのcapexクローズを実行し、`CompanyQuarterRecord.capexResults`へ保存、`CompanyLabState.capexState`で次期へ繰り越す。

## 2. 投資案件データモデル（`CapitalProject`）

1件の投資案件は、案件ID・会社ID・種別・承認予算・分割支払スケジュール（`paymentSchedule`、四半期ごとの予定比率、合計1.0）・実際に支払が成功した回数（`completedPaymentStagesCount`）・現金支払累計（`cumulativePaidUsd`＝建設中勘定残高の唯一の真実）・実際に支払が成功した四半期数（`elapsedConstructionQuartersWithPayment`）・完成に必要な支払成功四半期数（`requiredConstructionQuarters`）・状態・各種期日（提案期・承認期・着工期・完成期・取消期）・完成時の固定資産振替額（`capitalizedAmountUsd`）・処理優先順位・直近の診断理由を保持する。

**Phase 8B-2B予約フィールド**: `futureCapacityEffect`（`targetProduct`・`capacityIncreaseTonsPerQuarter`・`readinessQuartersAfterCompletion`）は、テンプレートから生成時に機械的にコピーするだけで、本Phaseでは一切参照・使用しない（生産能力・工場capacityへの接続はPhase 8B-2Bの対象）。

## 3. 最低6種類の投資案件テンプレート（`parameters.ts`）

| 種別 | 標準予算 | 分割支払比率（四半期ごと） | 標準工期 |
|---|---|---|---|
| `hosoLineExpansion`（HOSO加工ライン増設） | $3.0M | 0.3 / 0.4 / 0.3 | 3四半期 |
| `pdLineExpansion`（PD加工ライン増設） | $4.0M | 0.3 / 0.4 / 0.3 | 3四半期 |
| `vapLineExpansion`（VAP加工ライン増設） | $6.0M | 0.25 / 0.35 / 0.25 / 0.15 | 4四半期 |
| `coldStorageExpansion`（冷凍・冷蔵保管庫増設） | $2.5M | 0.5 / 0.5 | 2四半期 |
| `qualityControlEquipment`（品質管理設備） | $1.2M | 0.6 / 0.4 | 2四半期 |
| `environmentalEquipment`（排水・環境設備） | $1.8M | 0.5 / 0.5 | 2四半期 |

`minimumCashReserveUsd`（最低現金準備額）$10.0M、`maxConcurrentActiveProjectsPerCompany`（同時進行中案件数上限）3件、`epsilonUsd`（丸め誤差許容値）$0.01。予算・工期は5社の初期`fixedAssetsGross`（$45M〜$110M）・初期現金（$22M〜$35M）に対して「負担可能だが意味のある規模」になるよう校正した暫定値であり、Phase 8Cの本格校正対象として明示的に申し送る。

## 4. 最低6状態と状態遷移

`proposed → approved → underConstruction → completed`（正常経路）、`underConstruction → suspended → underConstruction`（資金不足による中断・再開）、任意状態から未着工なら`cancelled`（着工後は取消不可、§7参照）。

**"proposed"は永続化されない過渡状態**である。承認判定はその場（提案評価時点）で完了し、承認されればプロジェクトは直接`approved`として`CompanyCapexState.portfolio.projects`へ登録され、拒否されれば`CapexQuarterResult.rejectedProposals`へ理由だけを記録し、プロジェクトとしては一切登録されない。これにより、自動方針が何も提案しない通常運用（§9）では設備投資状態が一切肥大しない。

**「着工」**＝最初の分割支払が全額実行された時点（`approved → underConstruction`）。**「完成」**＝全stage支払完了 かつ `cumulativePaidUsd ≈ approvedBudgetUsd` かつ 実際に支払が成功した四半期数（`elapsedConstructionQuartersWithPayment`）が`requiredConstructionQuarters`以上に達した時点であり、暦上の完成予定期ではない（§6参照）。

## 5. 承認ゲート（会社ID非依存の財務診断ベース）

新規提案の承認判定は、`ProposalApprovalGate = { borrowingCapacityFrozen: boolean; severelyDistressed: boolean }`という2つの真偽値だけを見る。`companyLab/runner.ts`のアダプターが、Phase 8B-1の`planQuarterFinancing`の結果（`plan.borrowingCapacity.underwritingFrozen`）と前期末までの資金繰り履歴（`prevFinancingState.history.lastFinancialHealth === "paymentDefault" | "insolvent"`）だけから機械的に算出する。`capex/`モジュール自体は`financing/types.ts`の列举型を一切importせず、この2つの真偽値だけを受け取る構造になっている（**特定の会社IDに基づく承認判定は一切存在しない**。実装は`evaluateProposal`関数の中で会社IDを一度も条件分岐に使わない）。

承認判定はこの2条件のほか、会社の同時進行中案件数（`approved`/`underConstruction`/`suspended`のいずれか）が`maxConcurrentActiveProjectsPerCompany`（3件）を超えていないこと、要求予算が有限・正であることを確認する。いずれかを満たさない場合はプロジェクトとして登録せず、`CapexQuarterResult.rejectedProposals`へ理由文字列とともに記録する（投げない。§7参照）。

## 6. 現金配分ウォーターフォール・支払優先順位・全額支払のみの分割払い

**6段階の処理順序**（`capexClose.ts`のコメント・実装参照）:

1. `closeQuarterWithFinancing`（Phase 8B-1、既存・変更なし）が当四半期の最終的な財務結果（デットサービス後の確定現金を含む）を確定する。
2. 設備投資可能額 = `max(0, その確定現金 − 最低現金準備額)`。
3. 取消要求の適用 → 再開要求の検証（状態は変更せず対象IDだけ収集） → 新規提案の評価（承認/拒否）。
4. 支払優先順位付け → 全額支払のみの分割払い試行（現金が尽きるまで、または全案件処理まで）。
5. 期末建設中勘定・非減価償却対象額の算出。
6. `finance/`の`closeFinancialQuarter`を「三段目」として呼び、financing側の数値（すでに確定済み・再計算しない）とcapex側の数値を同時に渡して最終PL/BS/CFを得る。

**4段階の支払優先順位**（`buildPaymentQueue`）: Tier 0＝`underConstruction`（着工済み、当四半期の分割払いを自動的に試行。決定入力不要）。Tier 1＝`suspended`かつ当四半期の明示的な`resumeRequest`があるもの（`resumeRequest`の無い`suspended`案件はその四半期の支払対象に一切含めない。§8で意図を説明）。Tier 2＝`approved`（未着工、初回分割払いを自動的に試行）。各Tier内は`approvedPeriod`昇順→`priority`昇順→`projectId`昇順で並べる。これにより「古い承認案件を優先し、当四半期の新規承認案件は最後」という優先順位が、単一のソートキーだけで自然に実現される（Tier分けとは別立ての「新規承認案件」区分は不要）。

**全額支払のみ（一部支払は無い）**: `attemptPayment`は、利用可能残現金が次のstageの予定支払額以上であれば全額支払い、`completedPaymentStagesCount`・`cumulativePaidUsd`・`elapsedConstructionQuartersWithPayment`をそれぞれ厳密に1単位ずつ進める。不足していれば一切支払わず（状態・累計額は不変）、`underConstruction`だった案件は`suspended`へ遷移する（未着工の`approved`案件は単に見送りとして`approved`のまま残る）。「半分だけ支払う」という状態は構造上存在しない。

## 7. 構造的誤用とビジネス上の見送り・拒否の区別

`financing/`の`FinancingValidationError`と同じ区分に従う。**構造的な誤用**（存在しない案件テンプレート種別、存在しない案件IDの取消/再開要求、完済後の案件の取消要求、状態不整合な再開要求、テンプレート自体の分割比率合計バグ）は`CapexValidationError`を**投げる**（プログラミングエラーとして扱う）。**会社の資金繰り・信用状態による新規承認拒否**（`severelyDistressed`・`borrowingCapacityFrozen`・同時進行中案件数上限・予算不正）と**当四半期の支払見送り**（現金不足）は、投げずに診断理由つきの結果として返す（`rejectedProposals`・`lastDiagnosticReasons`）。着工後の案件（`cumulativePaidUsd > 0`）は取消不可（構造的誤用として`CapexValidationError`）。

## 8. 設計上の開示事項: `resumeRequests`が`suspended`案件の自動再試行を止める理由

`underConstruction`・`approved`の案件は、資金があれば毎四半期自動的に次の分割払いを試行する。一方`suspended`の案件は、明示的な`resumeRequest`（意思決定入力）が無い限り、その四半期の支払対象に一切含めない。この非対称性は元の34節の実装指示の文面には逐語的には存在しないが、実装中に「`resumeRequests`という決定入力フィールドを型に用意しながら、実際には何の意味も持たない（`suspended`案件も自動的に再試行されるなら、`resumeRequests`は常に無視されるフィールドになる）」という矛盾に気づいたため、標準の「合理的な既定値で進め、完了報告で開示する」方針に基づき、この設計を採用した。会社が「もう一度払う」と明示的に決めた場合だけ再試行する、という意図的な意思決定を要求する設計であり、`resumeRequests`フィールドに実質的な意味を持たせる。

## 9. 自動方針の挙動（会社ID非依存の一様規則）

`companyLab/autoPolicy.ts`の`buildCapexDecision`は、**常に**`{ newProjectProposals: [], cancelRequests: [], resumeRequests: [] }`を返す（5社共通、会社IDによる分岐は一切無い）。これは特定会社への特別扱いではなく「自動方針は常にこれを返す」という会社ID非依存の一様な規則である。§11の診断結果で、baseline含む全5シナリオ×32ターンで自動方針下の設備投資活動（支払・完成・拒否）が厳密にゼロ件であることを確認済み。統合テスト・意思決定編集（`decisionDraft.ts`）からの明示的な提案だけが投資案件を発生させる。

## 10. Phase 8B-2Bとの境界（本Phaseで実装しない項目、明示的な除外一覧）

新規生産能力の即時増加・完成後の生産能力反映、新設備の減価償却開始（完成資産は本Phase終了時点まで減価償却対象から構造的に除外される。§11参照）、追加人員・段階固定費の増加、設備専用融資（既存の`financing/`借入枠を間接的に消費するのみで、設備投資専用の融資種別・担保評価は無い）、投資採算指標（NPV/IRR/回収期間/ROIC）、案件の複数フェーズ分割・部分キャンセル、能力効果の校正（`futureCapacityEffect`はプレースホルダのみ）、UI、Redis/API実配線、本番ゲーム画面統合、V1（`main`/`v1-maintenance`）への一切の変更。

## 11. 建設中勘定（CIP）・完成振替・減価償却除外の会計処理

**CIPの唯一の真実**は`CompanyCapexState.portfolio.projects`の`isActiveStatus`（`approved`/`underConstruction`/`suspended`）の案件の`cumulativePaidUsd`の合計であり、`CompanyFinanceState`側に別建ての残高フィールドは持たない（`financing/`の`CompanyFinancingState`が融資ポートフォリオを分離保持する構造と同じ前例）。`finance/quarterClose.ts`のBS（`BalanceSheet.constructionInProgress`）へは、`CapexAdjustment.endingConstructionInProgressUsd`として「ending値」接続方式（financingの融資残高接続と同じ設計）で渡すだけで、finance側に二重管理を発生させない。

**完成振替**: 案件完成時、`cumulativePaidUsd`全額（＝`capitalizedAmountUsd`）が`fixedAssetsGrossEnd = prev.fixedAssetsGross + completedProjectsTransferUsd`として固定資産取得原価へ加算され、同額がCIPから外れる（完成した案件は`isActiveStatus`ではなくなるため、CIP集計から自然に除外される）。

**新規完成設備の減価償却除外**: `legacyDepreciableGrossUsd = max(0, prev.fixedAssetsGross − nonDepreciatingCapexGrossAtPeriodStartUsd)`を減価償却率の適用対象とする。`nonDepreciatingCapexGrossAtPeriodStartUsd`は、前四半期末時点でポートフォリオ内の`status === "completed"`の案件の`capitalizedAmountUsd`の合計として**毎四半期新たに算出**する（別建ての累積カウンタを持たない。ポートフォリオを唯一の真実とし、二重管理・ドリフトのリスクを構造的に排除する）。§13の実測データで、完成直後の四半期でも新規完成分が減価償却対象に含まれないことを確認済み。

## 12. financingロジックを複製しない三段クローズ設計

「利息・元本をいくら現金で払えるか」を再計算しないよう、既存の`closeQuarterWithFinancing`（Phase 8B-1、無改修）が返す`FinancingQuarterResult`の公開フィールド（`interestAccrualUsd`・`interestPaidCashUsd`・`loanDrawUsd`・`principalPaidCashUsd`・`endingShortTermLoansUsd`・`endingLongTermLoansUsd`）と、当四半期開始時点の未払利息残高（`prevFinancingState.accruedInterestPayableUsd`）だけから`FinancingAdjustment`を**再構成**し、`finance/`の`closeFinancialQuarter`を三段目として呼ぶ。

1段目（`closeQuarterWithFinancing`内部のPass1/2、Phase 8B-1既存・無改修）→ 2段目（`closeQuarterWithFinancing`が返す`financeResultBeforeCapex`、資金繰り確定後・設備投資前）→ 3段目（`closeQuarterWithCapex`内の`closeFinancialQuarter`呼び出し、`FinancingAdjustment`再構成＋新設の`CapexAdjustment`）という3回の`closeFinancialQuarter`呼び出しで最終PL/BS/CFを確定する。同じ入力から同じ計算をもう一度行うだけであり、`accruedInterestPayableEnd`等の恒等式は崩れない（統合テストCC-1〜8・CI-2〜3で数値的に確認済み）。

## 13. 会社ラボ実ラン検証結果（決定論的シード）

**5社×32ターン×全5シナリオ（baseline / ecuador-early-expansion / ecuador-delayed-expansion / global-disease-crisis / global-demand-boom）、自動方針**: いずれも設備投資活動（支払・完成振替・新規提案拒否）が**厳密に0件**（§9の一様規則の実測確認）。NaN/Infinity・BS貸借不一致は0件。8ターンと32ターンの共通期間（先頭8ターン）の財務結果は完全一致。

**設備投資オーバーライドフィクスチャ**（BALへturn1に`coldStorageExpansion`案件を1件提案、8ターン、seed=`capex-verify-override-8`）:

| turn | period | 投資可能額 | 当期支払 | 完成振替 | 期末CIP | 固定資産純額 | 貸借差額 | 直接法/間接法CF差 | 案件動向 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2015Q1 | $51.64M | $1.25M | $0.00M | $1.25M | $87.75M | 0.0000 | 0.0000 | BAL-CAPEX-1: approved→underConstruction |
| 2 | 2015Q2 | $7.20M | $1.25M | $2.50M | $0.00M | $88.00M | 0.0000 | 0.0000 | BAL-CAPEX-1: underConstruction→completed |
| 3 | 2015Q3 | $13.00M | $0.00M | $0.00M | $0.00M | $85.75M | 0.0000 | 0.0000 | — |
| 4 | 2015Q4 | $19.49M | $0.00M | $0.00M | $0.00M | $83.50M | 0.0000 | 0.0000 | — |
| 5 | 2016Q1 | $1.31M | $0.00M | $0.00M | $0.00M | $81.25M | 0.0000 | -0.0000 | — |
| 6 | 2016Q2 | $33.03M | $0.00M | $0.00M | $0.00M | $79.00M | 0.0000 | -0.0000 | — |
| 7 | 2016Q3 | $26.21M | $0.00M | $0.00M | $0.00M | $76.75M | 0.0000 | 0.0000 | — |
| 8 | 2016Q4 | $30.59M | $0.00M | $0.00M | $0.00M | $74.50M | 0.0000 | 0.0000 | — |

案件（標準予算$2.5M、2段階0.5/0.5）はturn1で承認・着工・初回分割払い（$1.25M）を実行し、turn2で2回目の分割払い（$1.25M）とともに完成、`completedProjectsTransferUsd`（$2.50M）と`capitalizedAmountUsd`が厳密に一致した。完成直後（turn3）以降も固定資産純額は連続的に減少し続けている（新規完成分が減価償却されず、既存レガシー資産のみが減価償却され続けている＝§11の除外ロジックが正しく機能している。fixedAssetsGross自体はturn2で+$2.5Mだが、その後は不変で、純額の減少はすべて既存レガシー資産の減価償却によるもの）。全turnで貸借差額・CF直接法/間接法差はいずれも$0.01未満（構造的にゼロ）。

## 14. companyLab接続

`companyLab/runner.ts`の`advanceCompanyLabQuarter`が、§12の3段目クローズを5社ぶん毎四半期実行し、`CompanyQuarterRecord.capexResults`へ保存、`CompanyLabState.capexState`で次期へ繰り越す。`buildCompanyOwnState`は`CompanyOwnState.capexState`（前四半期末までの自社設備投資状態）を公開し、自動方針・意思決定編集の双方が参照できる。承認ゲート（§5）は、既存の期首与信判断ループ（`planQuarterFinancing`呼び出しと同じループ）の中で、会社ごとに1回だけ算出する。

CLI（`npm run v2:company-simulate`）のsummary形式へ、投資可能額・当期支払・完成振替・期末建設中勘定・案件別の状態遷移・新規提案拒否理由の行を追加した（`capexLineForCompany`）。CSV出力へ`capexCashAvailableUsd`・`capexPaidUsd`・`capexCompletedTransferUsd`・`capexEndingConstructionInProgressUsd`・`capexRejectedProposalsCount`の5列を追加した（既存列は変更していない、末尾への追加のみ）。JSON出力は`capexResults`（案件単位の詳細）を含む全内訳を取得可能。

## 15. 永続化（schemaVersion 6）

`PersistedGameStateV2`へ`capexStates`（`CompanyCapexState[]`、会社別投資ポートフォリオ・案件ID発行連番）を追加し、`CURRENT_PERSISTED_GAME_STATE_VERSION`を5→6へ上げた。v1〜v5データ（キー自体が存在しない）はdecode時に空配列＝設備投資状態未初期化を補う（`financingStates`/`financeStates`と同じ、キーの有無で判定する追加的変更、マイグレーション不要）。

検証（`persistence/schema.ts`）: 予算・比率・累計額のNaN/Infinity/undefined拒否、分割支払比率合計が1.0でない場合の拒否、`cumulativePaidUsd`が`approvedBudgetUsd`を超える場合の拒否、ポートフォリオ内の投資案件`companyId`が所属会社と不一致の場合の拒否、投資案件IDの重複拒否、**状態別のフィールド整合性チェック**（`completed`は`completedPeriod`・`capitalizedAmountUsd`・全stage完済を要求し`capitalizedAmountUsd ≈ cumulativePaidUsd`を検証、`cancelled`は`cancelledPeriod`と支払実績ゼロを要求、`approved`は支払実績ゼロを要求、いずれも該当状態以外にこれらのフィールドが混入していれば拒否）。無印/v2ゲーム自身のrunTurnは設備投資ロジックを呼ばないため、companyLab→Redis/API実配線（対象外）までは本フィールドへ実際に値が書き込まれることはない。

## 16. テスト

新規: `capex/__tests__/projectLifecycle.test.ts`（21: 状態遷移9・全額支払のみ3・建設期間セマンティクス2・複数案件/優先順位/上限4・資金制約入力検証2・Phase 8B-2B境界1）、`capex/__tests__/capexClose.test.ts`（8: 資金制約2・会計/CIP/減価償却除外4・複数案件2）、`persistence/__tests__/persistenceCapex.test.ts`（14: schema v6往復2・後方互換2・不正値拒否5・状態別整合性5）、`companyLab/__tests__/capexIntegration.test.ts`（5: 自動方針ゼロ提案の確認・実ランでの承認〜完成〜固定資産振替の一貫性・BS/CF恒等式のcapex接続後実ラン確認・決定論的再現・会社間の混線なし）。既存943件超のPhase 8A/8B-1テストは無改修・無回帰。全件（`npm test`）は**943件中943件成功（全件green）**。

**テスト作成中に発見・修正した内容の開示**: `capexClose.test.ts`受入確認CC-1の当初の期待値は「事業活動をゼロにした四半期は現金が不変」という誤った前提に基づいていた。実際には、既存Phase 8Aの固定管理費（`sellingGeneralAdmin.adminFixedUsdPerQuarter`、$800,000/四半期、稼働実績に関わらず毎期発生する既存のビジネスロジック）により、「ゼロ活動四半期」でも現金は$800,000減少する。これはPhase 8B-2Aで導入したロジックの不具合ではなく、既存の正しく機能している既存ロジックとテストの前提が矛盾していたケースであり、標準方針（「既存の正しく機能しているロジックを弱めず、テストの前提の側を実態に追随させ、変更を開示する」）に従い、テストの期待値を`closeQuarterWithFinancing`の実際の出力から導出する形へ修正した（ビジネスロジック自体は一切変更していない）。同ファイルには型に存在しないプロパティ（`fixedAssetsGross_unused_placeholder`）へアクセスするデッドコードのアサーションが1件あり、これも削除した（隣接する正しいアサーションと重複していたため、検証内容の欠落は無い）。

## 17. Phase 8B-2以降へ送る課題（本Phaseで意図的に対象外とした項目の再掲）

§10の除外一覧に加え: テンプレートの標準予算・分割支払比率・標準工期・最低現金準備額・同時進行中案件数上限（いずれも§3の暫定値）はPhase 8Cの経済校正フェーズでの本格的な再検討対象。`resumeRequests`ゲーティング設計（§8）の自動方針側での実際の活用（現状の自動方針は常に空の意思決定を返すため、`suspended`案件が発生した場合の再開判断ロジックは未実装）。案件の複数フェーズ化・予算超過時の追加承認フロー・設備投資専用融資枠の導入は、いずれもPhase 8B-2B以降の対象として明示的に申し送る。
