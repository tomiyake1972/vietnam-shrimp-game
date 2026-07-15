# 財務計算仕様

最終更新: 2026-07-15

> **すべての計算式は`claude/turn-processing-engine`ブランチの`app/lib/gameEngine.ts`（`resolveCompanyTurn`関数）にのみ存在します。`main`ブランチにはターン処理・財務計算のコードは一切存在しません。**
> 以下は同関数のコードをそのまま数式化したものです。コードにない数式・想定は一切追加していません。単位は特記なき限り金額は$M（百万ドル）、数量はトン（t）、価格は$/kgです。

## 0. 全体の処理順序

`resolveCompanyTurn(companyId, state, year, quarter, decision)`は、会社の現在の`CompanyState`と当四半期の`CompanyDecision`（未提出なら`undefined`）を受け取り、新しい`CompanyState`と`CompanyTurnResult`を返す純粋関数です。処理順序：

1. 意思決定の有無判定（未提出なら既定値を使用）
2. 生産（養殖投入量の確定）
3. 原料調達
4. 加工（バルク/VAP振り分け）
5. 販売（市場別）
6. 売上原価・加工費の計算
7. 金利・固定費の計算
8. 純利益の計算
9. 財務活動（借入・返済・増資）
10. 貸借対照表の更新
11. 信用スコアの更新

## 1. 意思決定が未提出の場合の既定値

```
submitted = (decision !== undefined)
```

未提出の場合、以下の既定値が適用される（コード内コメント：「保守的な運用」）：

| 項目 | 既定値 |
|---|---|
| 養殖投入量 (phase2_farming) | `farmingArea * 3` |
| 外部調達量 (phase3_procurement) | `0` |
| VAP比率 (phase4_vap_ratio) | `30`（%） |
| 販売数量（各市場） | `0` |
| 短期借入・返済 | `0` |
| 増資 | 申請なし |

`notes`に「意思決定が未提出のため既定値（保守的な運用）を適用しました。」が追加される。

## 2. 生産（養殖）

```
maxFarmingInput = farmingArea × 5
farmingInputRequested = 提出値 or (未提出なら farmingArea × 3)
farmingInput = min(farmingInputRequested, maxFarmingInput)
```

`farmingInputRequested > maxFarmingInput`の場合、上限に丸められ、`notes`に警告が追加される。

- `farmingArea`の単位はha（ヘクタール）と推定されるが、`farmingArea × 5`が「トン」になる根拠（例：ha当たり収量5t）はUIのプレースホルダー文言（`最大 ${farmingArea*5} t`）とコードの一致からのみ確認でき、コード中に単位変換の説明コメントはない。**要確認**。

## 3. 原料調達

```
procurementQty = 提出値 or 0（未提出時）
procurementSource = phase3_source === "contract" ? "contract" : "spot"（デフォルトはspot扱い）
procurementPricePerKg = spot: 2.3 / contract: 1.9
```

- 外部調達量の上限（UIには「0〜3000t」という説明文があるが、コード上に上限のクランプ処理はない）。**コードとUIの不一致（要確認）**：意思決定フォーム側の「0〜3000 t」というplaceholderは目安表示に過ぎず、`resolveCompanyTurn`はこの値を検証・制限しない。

## 4. 加工（原料の使用可能量と製品化）

```
rawMaterialAvailable = farmingInput + procurementQty
rawMaterialUsed = min(rawMaterialAvailable, processingCapacity)
```

`rawMaterialAvailable > processingCapacity`の場合、超過分は在庫繰越されず失われる（`notes`に警告）。

```
vapRatioPct = clamp(提出値 or 30（未提出時）, 0, 100)
rawToVap = rawMaterialUsed × (vapRatioPct / 100)
rawToBulk = rawMaterialUsed − rawToVap
bulkOutput（トン） = rawToBulk / 1.3     // BULK_RAW_PER_PRODUCT_TON
vapOutput（トン）  = rawToVap  / 2.5     // VAP_RAW_PER_PRODUCT_TON
```

## 5. 販売

対象市場と単価（$/kg）：

| 市場キー | 単価($/kg) | 製品区分 |
|---|---|---|
| `EU（バルク）` | 3.8 | バルク |
| `日本（VAP）` | 8.5 | VAP |
| `米国（バルク）` | 3.6 | バルク |
| `国内（スポット）` | 3.2 | バルク |

各市場について（コード内`for`ループでの処理順は上表の順）：

```
requested = 提出値 or 0（未提出時）
available = 製品区分がVAPなら vapRemaining、それ以外は bulkRemaining
sold = min(requested, available)
（bulkRemaining または vapRemaining から sold を減算）
revenue += sold × 単価($/kg) / 1000     // $M換算
```

販売後に`bulkRemaining > 0.01`または`vapRemaining > 0.01`が残っていれば、「未販売の製品は在庫繰越されず機会損失となりました」という`notes`が追加される。**在庫は四半期をまたいで繰り越されない**（明示的なゲーム設計としてコードに実装されている）。

## 6. 売上原価・加工費

```
farmingCost      = farmingInput   × 1.5（$/kg） / 1000     // FARMING_COST_PER_KG
procurementCost  = procurementQty × procurementPricePerKg / 1000
processingCost   = rawMaterialUsed × 0.4（$/kg） / 1000     // PROCESSING_COST_PER_KG
cogs = farmingCost + procurementCost     // processingCostはcogsに含まれず別項目として保持される
```

## 7. 金利・固定費

```
debtBefore = totalAssets − equity
interestExpense = debtBefore × 0.02     // INTEREST_RATE_QUARTERLY（四半期2%）
overhead = 1.2 + processingCapacity × 0.00005     // OVERHEAD_BASE_M + OVERHEAD_PER_CAPACITY_TON
```

## 8. 純利益

```
netIncome = revenue − cogs − processingCost − interestExpense − overhead
```

## 9. 財務活動（フェーズ6）

```
borrow = 提出値 or 0（未提出時）
repayRequested = 提出値 or 0（未提出時）
repay = min(repayRequested, max(debtBefore, 0))
```

`repayRequested > repay`の場合、「返済希望額が残債務を上回ったため、残債務までの返済としました。」と`notes`に追加。

```
equityInjection = 0
if submitted かつ phase6_equity が空でない:
    equityInjection = (creditScore >= 60) ? 10 : 5     // EQUITY_RAISE_CREDIT_THRESHOLD, DEFAULT_EQUITY_RAISE_*_CREDIT_M
```

- 増資先の選択肢（中東SWF／日本商社／アジア戦略投資家）は**UI上は3種類存在するが、どれを選んでも効果は同一**（`equityRaiseRequested`の値そのものは`notes`の表示文言にのみ使われ、金額計算には影響しない）。**要確認/未実装**：投資家ごとの条件差（金利、出資比率、希薄化等）は実装されていない。

## 10. 貸借対照表（BS）の更新

```
cash         = state.cash + netIncome + borrow − repay + equityInjection
equity       = state.equity + netIncome + equityInjection
totalAssets  = state.totalAssets + netIncome + borrow − repay + equityInjection
debtAfter    = max(0, debtBefore + borrow − repay)
debtEquityRatio = equity > 0 ? debtAfter / equity : 99     // equity<=0のフォールバック値
```

すべて小数点2桁に丸め（`round2`、`Math.round(n * 100) / 100`）。

- **未実装**：正式な減価償却スケジュール（固定資産の簿価管理）。`totalAssets`は純利益・借入・返済・増資の増減分だけがそのまま反映される単純化されたモデル。
- **未実装**：運転資本（売掛金・買掛金）のモデル化。売上・費用は即座に現金化される前提。
- **未実装**：税金の計算・控除。
- **未実装**：配当の支払い。

## 11. 信用スコアの更新

```
creditScoreDelta = 0
creditScoreDelta += (netIncome > 0) ? +2 : −3
if cash < 0: creditScoreDelta += −10
creditScoreDelta += (debtEquityRatio_new > debtEquityRatio_old) ? −2 : +1
creditScore = clamp(round(state.creditScore + creditScoreDelta), 0, 100)
```

現金がマイナスになった場合、`notes`に「⚠️ 現金がマイナスになりました。資金繰りに注意してください。」が追加されるが、**ゲームの続行を妨げる処理（ゲームオーバー等）はない**。

## 12. P&L / CF の様式化された出力

`CompanyTurnResult`（`app/lib/gameTypes.ts`）として保持されるのは以下のみ：

- `revenue`, `cogs`, `processingCost`, `interestExpense`, `overhead`, `netIncome`
- `rawMaterialAvailable`, `rawMaterialUsed`, `productOutput{bulk, vap}`, `salesByMarket`
- `stateBefore`, `stateAfter`（`CompanyState`のスナップショット）
- `notes`（文字列配列の警告・補足）

正式なP&L様式（売上高／売上総利益／営業利益／経常利益／当期純利益の段階表示）、正式なBS様式（勘定科目別内訳）、正式なCF計算書（営業/投資/財務CFの区分）は**未実装**。上記フィールドの値を画面側（`app/gm/[gameCode]/page.tsx`, `CompanyDashboard.tsx`）で単純に並べて表示しているのみ。

## 13. 未実装項目（コード上に該当箇所なし。全文検索で確認済み）

以下はユーザーから提示された仕様確認観点だが、`app/`配下を"event|worker|quality|CTS|QRP|covenant|dividend|tax|depreciation|人件費|物流費|販管費"等で全文検索した結果、該当する実装は一切存在しなかった：

- 人件費（人件費として独立した費目。`overhead`に含まれるかは不明・要確認）
- 物流費（独立した費目としては存在しない）
- 販管費（`overhead`という汎用の固定費のみで、営業費・管理費の内訳区分はない）
- 減価償却
- 金融費用のうち`interestExpense`以外の項目（手数料等）
- 税金
- 運転資金（AR/AP）の管理
- 借入枠（上限）の設定・チェック
- コベナント（財務制限条項）
- 配当
- ゲームオーバー条件（破産・強制清算等）

これらは**将来的な仕様として提案するものではなく**、単に「現状のコードに存在しない」という事実の記録である。
