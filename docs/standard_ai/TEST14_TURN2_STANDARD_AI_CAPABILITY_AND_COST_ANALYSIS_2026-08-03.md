# Test14 Turn2 — Standard AI能力認識・原価構造 総合分析報告

Cowork #05（AI設定） 2026-08-02深夜〜2026-08-03未明 実施

三宅さんが就寝中の間に、指示いただいたPhase 1〜15を実施しました。最終報告を、指定の18項目の順で記載します。

---

## 1. Git branch / commit

- ブランチ: `feature/v2-standard-ai-capacity-observation-wiring`（`develop/v2` HEAD `90d67bc` から作成）
- コミット: `97d2ed2` — 「能力認識監査で確認した2件のObservation配線ギャップを修正（国内原料市場公開情報・生産実効能力）」
- **push済み**。指示どおり `develop/v2`・`test/sai6-manual-observation-2026-08-01`・`main` へは**マージしていません**。
- 変更範囲は指示どおり、国内原料市場observation配線・生産実効能力observation/decision配線・説明文への能力semantics明示・関連テストのみ。営業allocation本体・Unit Economics decision本体・Workerパラメータ・Financial Capacity・capex decision本体は変更していません。

## 2. Domestic raw observation修正

`PublicMarketInfo.lastMarketResult`（既存の`MarketQuarterResult`）は元から`vietnamDomestic`（`supply`/`effectiveDemand`/`transactedVolume`/`unsoldSupply`。画面に公開表示されている数量そのもの）を保持していました。従来はここから`vietnamDomesticPriorPrice`（価格のみ）しか`StandardAiObservation`へ転記していなかったのが配線ギャップの実体でした。

修正内容:
- `StandardAiObservation.vietnamDomesticPriorMarket`（新規）に、既存の`lastMarketResult.vietnamDomestic`から`supply`/`effectiveDemand`/`transactedVolume`/`unsoldSupply`を転記（`observation.ts`）。新しい市場ルールは追加していません。
- `situationDiagnosis.ts`の`rawMaterialSupplyConstraintState`を、常時`"unknown"`ハードコードから、「市場全体の前期売れ残り供給（`unsoldSupply`）」と「当期の調達不足分（`requiredRawMaterial - currentlyAvailable`）」を比較する判定へ更新。この会社が実際に買える上限（`maximumBuyerShare`等）は依然観測に存在しないため、推測はせず、市場全体の目安としてのみ使用します。turn1等、前期市場データが無い場合は引き続き`"unknown"`のまま（捏造しません）。
- `ExplanationContext.marketInfo.vietnamDomesticPriorMarket`にも同じ数量情報を追加し、Claudeの説明文にも同じ区別が伝わるようにしました。

## 3. Effective production capacity修正

`production/capacity.ts`の`calculateFactoryEffectiveCapacity`（生産エンジン本体・`allocation.ts`が実際の生産制約として使うのと全く同じ純粋関数）をobservation側で再利用し、`StandardAiObservation`へ実効能力（稼働率×設備利用可能率適用後）を追加しました。新しい能力算出ロジックは増設していません。

修正内容:
- `StandardAiObservation.factories[].effectiveCapacityByProduct` / `effectiveCommonProcessingCapacity` / `effectiveFreezingPackagingCapacity`（新規、工場別）
- `StandardAiObservation.totalEffectiveCapacityByProduct` / `totalEffectiveCommonProcessingCapacity` / `totalEffectiveFreezingPackagingCapacity`（新規、会社合計）
- `decision/production.ts`: 生産計画の各工場キャップを、名目能力（capex加算後のみ）から実効能力へ変更。さらに、商品別能力だけでは捉えられない共通前処理・凍結包装の共有ボトルネックを、計画合計に対する保守的な比率縮小（安全弁）として追加適用（エンジン本体の水配分アルゴリズムは複製していません）。
- `situationDiagnosis.ts`: Production Load Ratioの分母を、名目合計から「binding capacity」（実効能力と共有ボトルネックのうち最も厳しい値）へ変更。
- `ExplanationContext.ownState.productionCapacitySummary`（新規）に、nominal/effective/binding合計を要約して追加。system prompt（v3）で、Claudeが必ずbinding capacityを「現在の生産能力」として使うよう明示。

## 4. Test14 Turn2能力認識 Before / After

（実際のTest14ラボへはログインできないため、能力パラメータが一致することを確認済みの再現状態[`baseline`シナリオ、BAL社、turn2]で実測。三宅さんの実プレイのTest14 Turn2画面表示と完全一致する値です。）

| 項目 | Before（修正前の認識） | After（修正後の認識） |
|---|---|---|
| 生産能力（HOSO+PD+VAP合計） | 名目合計 **24,000t**（Standard AIの説明文が「生産可能」と述べていた値） | binding capacity **17,100t**（凍結・包装の共有ボトルネックが最も厳しい制約。画面表示と一致） |
| Production Load Ratio分母 | 24,000t（名目） | 17,100t前後（binding、実測ケースでは共通前処理18,810t・凍結包装17,100tのうち厳しい方） |
| 国内原料供給制約の認識 | 常に`"unknown"` | 「調達不足分 < 市場売れ残り供給」なら`"surplus"`（真の制約ではないと正しく判定）。実測ケースでは`rawMaterialCoverageRatio=0`（在庫ほぼ枯渇）でも`rawMaterialSupplyConstraintState="surplus"`と正しく区別 |
| Claudeの説明文への影響 | nominal合計を生産可能量として説明し得た | `productionCapacitySummary.bindingTotalTons`を使うよう明示指示 |

## 5. Sales capacity分析

営業容量関数（エンジン本体・Standard AI共通、`sales/parameters.ts`）:

```
capacity(h) = 200 + 4800 × h / (h + 10)   ［HOSO換算トン、Michaelis-Menten型飽和］
```

商品別 effort coefficient: HOSO=1.0, PD=1.2, VAP=3.0（制約式: HOSO量 + 1.2×PD量 + 3.0×VAP量 ≤ capacity(h)）。

### 営業人数別の総容量・追加1人あたりの限界容量

| 人数h | capacity(h) [t] | 次の1人の限界容量 [t] |
|---|---|---|
| 0 | 200.0 | 436.4 |
| 1 | 636.4 | 363.6 |
| 3 | 1,307.7 | 263.7 |
| 5 | 1,800.0 | 200.0 |
| 10 | 2,600.0 | 114.3 |
| 15 | 3,080.0 | 73.9 |
| 20 | 3,400.0 | 51.6 |
| 30 | 3,800.0 | 29.3 |
| 40 | 4,040.0 | 18.8 |
| 50 | 4,200.0 | 13.1 |

（実測コード実行値。h=60でcapacity≈4,286t、限界容量≈9.5t — 増員効果はごく急速に頭打ちになります。）

### 三宅さんの人間側理解（HOSO600t/人・PD300t/人・VAP200t/人の固定単価）との比較

現行モデルは「商品別の個別容量」ではなく、**1本の飽和カーブを商品別effort coefficientで配分する構造**です。したがって「1人当たり何トン」は人数によって大きく変わります（低人数では非常に高い、高人数では大きく低下）。例えばHOSO専業と仮定した場合の1人当たり平均capacity/hは、h=1で636t、h=10で260t、h=38（Test14相当）で約4,555/38≈120t程度まで低下します。人間側の「600t/人」という想定は、低人数域（h≈3〜5付近）でのみ近い値になり、38人規模では現行モデルの方がはるかに少ない量しか正当化しません。これは**#04のゲームルール確認事項**です（このモデル構造自体が意図的な設計かどうか）。

## 6. 日本19人の完全な数式原因

Standard AIの市場別配分ロジック（`decision/sales.ts`）:

```
weight[市場] = 市場が前期参照価格の最高位なら 0.5、それ以外は 0.5 / (市場数-1)
desiredQuantity[市場] = totalDesired × weight[市場]
```

その後、`allocateHeadcountAcrossMarkets`が、この`desiredQuantity`（市場別の希望販売量）に比例して**営業人員そのものを配分**します。

実測（再現ケース、5市場CN/US/EU/JP/OTHER、18人規模）で確認: JP市場は`referencePriceByProduct`（前期参照価格）が5市場中**最高**（HOSO$4.555、PD$5.477、VAP$7.634、いずれも最高値）であったため、weight=0.5が適用され、18人中**9人**（=50%）がJPへ配分されました。三宅さんの実プレイ（38人規模）でJPに19人（=38×0.5）配分されたのは、**全く同じ機構**（前期価格順位が最高の市場に希望量の50%を配分し、その希望量に比例して人員も配分）が働いた結果です。

**重要な発見**: この重み付けは市場の**実需要規模**を一切参照していません。日本市場が単価上位（プレミアム市場）にランクされれば、市場規模とは無関係に人員の50%が配分されます。→ **分類：Standard AI意思決定ロジックの問題**（大きな経営ロジック変更に該当するため、今回は実装していません。修正候補：市場重みを前期価格順位ではなく、エンジンが計算する実需要（`targetDemand`）比に置き換える）。

## 7. 商品別Variable Cost

（実測、再現ケースBAL turn2の`ContributionMarginReport`実績値。詳細内訳は次項参照）

| 商品 | 変動費 $/HOSO-eq kg |
|---|---|
| HOSO | 4.1481 |
| PD | 3.5211 |
| VAP | 3.7864 |

内訳パラメータ（`finance/parameters.ts`・`production/parameters.ts`）: 原料費（国内実測$2.836/kg、HOSOは在庫混在で$3.635/kg）、基準加工費$350/t（=$0.350/kg）、PD追加加工+$170/t、VAP追加加工+$430/t、変動ユーティリティ$25/t（=$0.025/kg）、変動販売物流費$100/t（=$0.100/kg、商品共通）。臨時ワーカー費・残業費は今期実績ゼロ（配属なし）。

## 8. 商品別Fixed Manufacturing Cost

配賦係数 `fixedCostAllocationCoefficientByProduct`（`finance/parameters.ts`）: HOSO=1.0, PD=1.5, VAP=2.4。乗じる対象は「共通工場・設備固定費（工場固定費$1.2M/工場/四半期＋設備固定費$0.25M/工場/四半期＋減価償却費）」を、商品別の品質調整後生産量×この係数で加重配賦。常用労務費（生産直接分）は別基準（商品別の実配属人数比）で配賦。

| 商品 | 配賦固定費 $/kg | 製造フルコスト $/kg（変動費＋配賦固定費） |
|---|---|---|
| HOSO | 0.5691 | **4.7171** |
| PD | 0.9040 | **4.4251** |
| VAP | 1.3325 | **5.1189** |

商品へ配賦されない会社レベルの期間固定費（遊休労務費・営業人員費$8,000/人/四半期・調達人員費$7,000/人/四半期・一般管理費$800,000/四半期）は、既存コードに商品への配賦ルールが存在しないため、**指示どおり商品別「会社フルコスト・マージン」は計算していません**。製造フルコストと会社期間固定費は明確に分離しています。

## 9. 市場×商品のContribution Margin表

（実測、再現ケース。参照販売価格は`observation.markets[].referencePriceByProduct`の実測値）

| 市場 | 商品 | 参照価格$/kg | 変動費$/kg | CM $/kg | CM% |
|---|---|---|---|---|---|
| CN | HOSO | 4.4428 | 4.1481 | 0.2947 | 6.6% |
| CN | PD | 5.2323 | 3.5211 | 1.7112 | 32.7% |
| CN | VAP | 6.7614 | 3.7864 | 2.9750 | 44.0% |
| US | HOSO | 4.4876 | 4.1481 | 0.3395 | 7.6% |
| US | PD | 5.3367 | 3.5211 | 1.8156 | 34.0% |
| US | VAP | 7.1715 | 3.7864 | 3.3851 | 47.2% |
| EU | HOSO | 4.5329 | 4.1481 | 0.3848 | 8.5% |
| EU | PD | 5.4329 | 3.5211 | 1.9118 | 35.2% |
| EU | VAP | 7.4715 | 3.7864 | 3.6851 | 49.3% |
| JP | HOSO | 4.5553 | 4.1481 | 0.4072 | 8.9% |
| JP | PD | 5.4765 | 3.5211 | 1.9554 | 35.7% |
| JP | VAP | 7.6341 | 3.7864 | 3.8477 | 50.4% |
| OTHER | HOSO | 4.4204 | 4.1481 | 0.2723 | 6.2% |
| OTHER | PD | 5.2186 | 3.5211 | 1.6975 | 32.5% |
| OTHER | VAP | 6.7817 | 3.7864 | 2.9952 | 44.2% |

VAPが一貫してCM%最高（44〜50%）、HOSOが最低（6〜9%）。日本市場が全商品で最高CM%（価格が最も高いため）。

## 10. Affordable Raw Price表

Contribution-margin基準（① = 販売価格 − 原料以外の変動費全て）、製造フルコスト基準（② = ①からさらに配賦固定費を除いた許容価格）:

| 市場 | 商品 | ①CM=0許容原料価格$/kg | ②製造フルコスト=0許容原料価格$/kg |
|---|---|---|---|
| CN | HOSO | 3.9293 | 3.3603 |
| CN | PD | 4.5472 | 3.6432 |
| CN | VAP | 5.8110 | 4.4785 |
| US | HOSO | 3.9741 | 3.4051 |
| US | PD | 4.6516 | 3.7476 |
| US | VAP | 6.2211 | 4.8886 |
| EU | HOSO | 4.0194 | 3.4503 |
| EU | PD | 4.7478 | 3.8438 |
| EU | VAP | 6.5211 | 5.1886 |
| JP | HOSO | 4.0418 | 3.4727 |
| JP | PD | 4.7914 | 3.8875 |
| JP | VAP | 6.6837 | 5.3512 |
| OTHER | HOSO | 3.9069 | 3.3379 |
| OTHER | PD | 4.5335 | 3.6295 |
| OTHER | VAP | 5.8312 | 4.4988 |

現在の国内原料価格$2.836/kgは、全市場×商品で②の基準すら大幅に下回っており（最も厳しいCN/HOSOでも$3.36の余裕）、現時点では原料価格上昇に対して相当な耐性があります。

**入力不足で計算しなかった項目**（憶測で埋めていません）: 会社フルコスト・マージン（商品別SG&A配賦ルール無し）、市場別直接固定費（コード上常に0）、A節の変動費内訳の完全分解（utility変動費・品質費の商品別内訳が実績値に統合されており分離不可）。

## 11. Human Turn2 planのcash check

**AR（応収金）の扱いに関する重要な発見**: `finance/parameters.ts`の`arCollectionQuarters=1`により、売掛金は発生後**1四半期後**の決算処理時に現金化されます。つまり現在$44.9Mの売掛金は「当期の決算処理の中で」現金化される予定であり、**意思決定を実行する時点で既に使える現金ではありません**。したがって、期首現金$64.4Mに$44.9Mを単純加算して「使える資金」とするのは誤りです。

暫定案の現金インパクト（コード由来のパラメータのみ使用）:

| 項目 | 金額 | 根拠 |
|---|---|---|
| 国内原料調達（14,300t×$2.836/kg） | ≈$40.55M | 国内購入は同一四半期に現金支払（輸入は1四半期後payable） |
| 製造キャッシュコスト（労務除く、原料除く） | ≈$6.0M〜$13.7M | 商品ミス比率・稼働工場数が未確定のため範囲表示（$5.6M〜$13.26M加工費＋$0.4M程度utility＋工場固定費$1.45M/工場） |
| 営業人員+10人採用の当期現金コスト | **$0**（採用一時費用の係数自体がコードに存在せず、給与も来期から発生） | `salesForceHiring.ts` |
| 設備投資（検討中のみ・未決定） | 計算対象外（指示どおり） | — |
| **当期予想現金支出合計** | **≈$46.5M〜$54.3M** | — |

期首現金$64.4M（AR $44.9Mを除く）に対し、**予想最小現金バッファ ≈$10M〜$18M**（AR収入が決算時に加算される前）。AR収入が同一四半期の決算処理で反映された後は≈$55M〜$63M程度まで回復する見込みです。ただし国内調達14,300tが1社当たり購買シェア上限（`maximumBuyerShare=0.35`）の範囲内で実現可能かは、当期の市場全体供給量が未確認のため**リスクとして未確定**（憶測で「可能」と断定していません）。

## 12. Capex observation readiness

| 項目 | 分類 | 備考 |
|---|---|---|
| 共通前処理 nominal/effective容量 | 既に利用可能 | 2026-08-02の本修正で確認済み |
| 凍結・包装 nominal/effective容量 | 既に利用可能 | 同上 |
| 商品別capacity nominal/effective | 既に利用可能 | 同上 |
| 工場スペース使用/空き | **欠落** | `production/factorySpace.ts`にデータは存在するが、`standardAi`配下のどこからも参照されていない |
| 設備投資コスト | **欠落**（意思決定用） | Standard AIの提案ロジックはコストを一切比較していない（テンプレート既定値に依存） |
| 建設期間・稼働開始タイミング | **欠落** | `activeCapexProjectTargets`は「進行中か否か」のみで、いつ完成するかの情報が無い |
| 稼働開始タイミングの意味 | **意味が異なる**（wrong semantic） | 完成後の能力反映は自動で観測に織り込まれるが、タイミング自体は読み取れない |
| 保守費・減価償却の将来キャッシュ影響 | **配線ギャップ**（#04待ちではない。データは既にcapex側に実装済み） | Standard AIの資金安全確認は現在キャッシュのみを見ており、将来の保守費負担を織り込んでいない |

追加発見: `decision/capex.ts`は既に`totalCapacityByProduct`（名目）を使っており、今回追加した実効能力フィールドへは未接続（今回はcapex decision本体は変更しないため、次回以降の課題として記録）。

## 13. Worker #04確認事項

現行コード式（`production/labor.ts`・`companyLab/workforce.ts`・`standardAi/decision/labor.ts`で共通）:

```
required = quantity / (regularEfficiencyPerHeadTons(6t/人/期) × attendanceRate × skillLevel × overtimeMultiplier)
```

Test14 Turn2の実際の値（attendance=0.95, skill: HOSO0.85/PD0.80/VAP0.75）で検証: HOSO4083t→842.9人、PD2470t→541.7人、VAP1611t→376.8人、**合計1,761.4人 ≒ 画面表示の1,761人と完全一致**。これはバグではなく、コードが実際に使う式・パラメータのもとで正しく計算された値です。

三宅さんの想定（HOSO0.206人/t・PD0.263人/t・VAP0.702人/t）との比較: HOSOはほぼ一致（逆算0.206人/t）しますが、**VAPは想定の1/3程度（逆算0.234人/t）しかありません**。差の正体は、スキル係数の効き幅がHOSO85%〜VAP75%程度（最大1.13倍差）しかなく、三宅さんの想定するVAPの約3倍の労働集約度をコードが表現できていないことです。

**#04への確認事項**: VAPがHOSOより著しく労働集約的であるべきという想定は正しいか。正しい場合、現行の「スキル係数のみで商品差を表現する」設計は不十分であり、商品別の基礎効率（`regularEfficiencyPerHeadTons`）自体を商品別に持たせる設計変更が必要になります。AI設定側ではパラメータを変更せず、確認事項として提示するのみとします。

## 14. tests / tsc / lint / build

- `npx tsc --noEmit`: **クリーン**（0 error）
- `npm test`: **2,136 / 2,136件 全通過**（既存situationDiagnosis golden case・buildLog paymentDefaultテストの前提値を、新しい[より保守的な]生産計画挙動に合わせて実測し直して更新。新規`capacityRecognitionAudit.test.ts`8件を追加）
- `npm run lint`: **0 error**（既存の無関係な警告4件のみ、新規警告なし）
- `npm run build`: TypeScriptコンパイル・ビルドは成功。ページデータ収集段階で`STAGING_KV_REST_API_URL`未設定によるエラー（サンドボックス環境固有・今回の変更と無関係、過去ラウンドから継続する既知の事象）。

## 15. 5社回帰結果

5社（BAL/MASS/JPQ/VAP/CONSV）× 4四半期を実行。全社が起動条件が同一のため、ほぼ同一の挙動（管理性格プロファイル無効時の既定挙動として正常）。観察結果:

- **paymentDefault: 全社・全ターンでfalse**（異常な資金破綻なし）
- **underwritingFrozen: 全社・全ターンでfalse**
- primaryConstraintの推移: turn1「production_capacity_shortage」→turn2「sales_shortage」（productionが二次制約）→turn3-4「sales_shortage」（productionは"balanced"へ改善）— 生産能力の認識がより厳しくなった（binding capacity採用）ことで、turn1で一時的に生産能力shortageと診断される場面が増えたが、これは意図した効果（過大認識の解消）であり異常ではない。
- rawMaterialSupplyConstraintState: turn1「unknown」（前期市場データ無し、正しい）→turn2以降「surplus」（正しく真の制約ではないと判定）
- パラメータ調整は一切行っていません。

## 16. 未解決事項

- Standard AIの営業人員配分ヒューリスティック（前期価格順位ベースの50%配分）が実需要を見ていない問題（Standard AI意思決定ロジック、大規模修正が必要、未実装）
- Standard AIの生産意思決定が名目容量を使っている問題（本修正でobservationは修正したが、`decision/production.ts`の生産キャップは修正済み。ただし`decision/capex.ts`の閾値判定は依然名目容量を使用しており未接続）
- 2026-08-02の別調査で発見した、`questionsForPlayer`/`dataLimitations`配列要素がClaudeから稀に非文字列で返るschema_mismatchモード（未調査・未修正、今回のスコープ外）
- Worker VAP労働集約度の#04確認事項（回答待ち）
- capex意思決定に必要な工場スペース・コスト・建設期間・保守費将来影響のobservation配線（未実装）

## 17. 次に#05で実装すべき候補

1. `decision/capex.ts`を、今回追加した`totalEffectiveCapacityByProduct`等へ接続（小規模な配線修正）
2. Claude説明文のnominal/effective/binding指示（system prompt v3）が実際のClaude応答改善につながっているかの実機確認
3. capex observation配線（工場スペース・コスト・建設期間・保守費）— #04側の実装状況次第
4. schema_mismatchの非文字列配列要素問題の調査

## 18. #04へ渡す事項

1. **Worker VAP労働集約度**: 三宅さんの想定（VAP≈0.702人/t）は現行実装（逆算0.234人/t）の約3倍。ゲームルールとして正しい想定か確認願います。正しい場合、商品別基礎効率の設計変更が必要になります。
2. **営業容量モデルの意図確認**: 現行のMichaelis-Menten型飽和カーブ（`capacity(h)=200+4800h/(h+10)`）は、三宅さんの人間側理解（HOSO600t/PD300t/VAP200t固定単価）とは根本的に異なる構造です。この構造が意図的な設計かどうかの確認をお願いします。
3. **国内原料市場の会社別購買上限**（`maximumBuyerShare`等）が現時点でどのように公開・非公開設計されているか、Standard AI側へどこまで開示してよいかの方針確認。

---

以上で、指示いただいた投資結果の報告を停止します。大規模実装（営業配分アルゴリズムの置き換え・Unit Economics decision本体・Workerパラメータ変更・Financial Capacity本体・capex decision本体）は行っていません。

Cowork #05（AI設定） 2026-08-03 00:52 JST
