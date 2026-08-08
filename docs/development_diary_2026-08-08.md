# ShrimpX V2 開発日誌

**対象期間：2026年8月3日〜8月8日**
**対象フェーズ：Test15統合・Test15画面拡張／Standard AI Training Harness v1（Batch 001・002）／AI経営説明の安定化／Standard AI Q&A（対話レイヤー）MVP**

> **この日誌の記述根拠について**
> 8月7日〜8日ぶんは筆者（Claude Code）が実際に手を動かし、実測値を確認した内容である。
> 8月3日〜6日ぶんは別セッションの作業であり、commitメッセージと成果物ドキュメントから
> 要約している（実測の再確認はしていない）。両者を混同しないよう、節ごとに明示する。

---

## 0. 期間全体の到達点

前回日誌（8月2日・SAI-6.1〜6.3）以降、作業は4本の流れに分かれた。

| 流れ | branch | 状態 |
|---|---|---|
| A. Test15統合と画面拡張 | `feature/v2-test15-integration` | HEAD `1bd8db6`・push済み |
| B. Standard AI Training Harness | `feature/v2-standard-ai-training-harness` | HEAD `5f1332a`・push済み・未merge |
| C. AI経営説明（Explanation）の安定化 | `feature/v2-test15-integration` に含む | 完了 |
| D. Standard AI Q&A（対話）MVP | `feature/v2-standard-ai-explanation-chat-mvp` | HEAD `a65ffa3`・push済み・未merge |

いずれも `develop/v2` / `main` へはmergeしていない。production deployもしていない。
force pushもしていない。

**この期間を通じて一貫していた原則**は次の2点である。

1. **ゲーム環境（market / sales engine / procurement / production / labor / finance /
   capex / game parameters）は変更しない。**
   変更したのは「経営者が何を観測できるか（information set）」「Standard AIの判断ロジック」
   「説明レイヤー」「UI」「Excel出力」だけである。
2. **実測値と推定値を混同しない。**
   仮説は必ずベンチマーク・実ログで検証し、成立しなかったものは棄却として記録する。

---

## 1. Test15統合branchの成立（8月6日〜7日・別セッション）

5本のfeature branchを `feature/v2-test15-integration` へ統合した。

```
adcea3a  feature/v2-sai-salesforce-bottleneck-hiring
57ac20f  feature/v2-financing-credit-diagnosis
c8b040f  feature/v2-sales-effect-diminishing-returns
04f26b9  feature/v2-sales-force-saturation-calibration
fbd8b9f  feature/v2-test15-preflight-calibration
02528aa  統合により失敗した10件のテストを A/B/C 方針で解消
```

### 1.1 営業効果曲線の再校正（9152e8b・099097b）

Test14で「第1ターンに営業を20人増員しても成約増が約2,000tしかない」現象への対応。
処理能力の飽和曲線

```
C(h) = baselineCapacityTons + capacityMaxIncrementTons × h/(h + capacitySaturationHeadcount)
```

を `(M=4800, k=10)` → `(M=24000, k=70)` へ再校正した。**MとkはM/kが原点付近の傾きを
決めるため必ず対で動かす必要がある**という知見が得られている（kだけ動かすと曲線が
全域で沈み、増員の見返りがかえって小さくなることを実測で確認済み）。

### 1.2 統合で失敗したテスト10件の扱い

- develop/v2固有の値を固定していた2件 → `.test.ts` を `.overlay.ts` へ改名し既定globから外す
  （期待値は書き換えない。テストの意味を保つ）
- 営業容量分解6件 → 校正後の実測値へ再ベースライン（旧値もコメントで残す）
- 残り2件 → 採用済み仕様の直接的帰結として更新

---

## 2. Test15画面の拡張（8月7日〜8日）

### 2.1 期初情報3パネルとExcel出力（c891f52・d69648a）

- Turn1期初のBS・償却資産明細・市場情報を画面へ追加。
  評価式は財務エンジンと同一のものを再利用し、独自の評価ロジックは持ち込んでいない。
- Turn1の国内原料参考価格を明示。既存の `clearVietnamRawMarket()` にシナリオ定義の
  入力をそのまま渡して清算させ、その結果を読み出すだけにした（新しい価格を作っていない）。
  baselineシナリオでの実測値は **$2.90/kg**。
- 導入ターンの購入成立ルール（`guaranteedFulfillmentBidFloor`）を turn1 のみ適用。
  turn2以降・industryLab等の既存呼び出しは挙動が一切変わらない。

### 2.2 データブックを管理会計＋意思決定ワーキングブックへ拡張（0730bf5・4971c97）

シート数 16 → 18。既存シートは削除・改変していない。

- 製造原価計算書: 調達元別の原料調達、商品別の当期実納入数量、商品別の期末製品在庫を追記
- 新規「固変分解」シート: Turn×Market×Product の限界利益明細＋固定費の2区分表示
- 新規「意思決定計算」シート: 実績(水色)／入力(黄)／数式(薄灰)の色分け、
  生産予定欄を空欄で生成し、入力に反応して在庫・受注残・必要Worker・原料過不足が再計算される

**受注→納入タイミングの事前調査**で、`planContractFulfillment` は納期で対象を絞らず
（`isFulfillableContract` は status のみで判定）、完成品在庫がある限り当期成約分も
当期中に充当されることを確認した。そのため「期首成約残（納期=当期・必須）」と
「新規販売希望（納期=翌期・任意）」を義務の性質が異なる別行に分けた。

### 2.3 実データ出力で判明した2件の参照ミス（de79468）

**合成データでは検出できず、実際にBAL/Turn2のブックを生成して目視して初めて分かった。**

1. 実効設備能力が常に「－」だった
   → `processingCapacity.${product}Capacity` は存在しない。正しくは
   `companyTotals[].poolKey` に紐づく `currentEffectiveTons`。
   修正後: HOSO 8,550 / PD 6,840 / VAP 5,130 t/四半期
2. 国内原料の参考単価が「－」だった
   → `RawMaterialLot.source` の実際の値は `"domestic"` であり `"domesticPurchase"` ではなかった
   （import / aquaculture は一致していたためその2つだけ値が出ていた）。
   修正後: 国内調達 $2.359/kg、加重平均 $3.127/kg

**教訓**: 実データを一度は目で見るまで「出力できている」と判断してはいけない。
両方について回帰テストを追加した（未知のsourceが来たら失敗する形にしてある）。

---

## 3. Standard AI Training Harness v1（8月8日・別セッション）

`feature/v2-standard-ai-training-harness`（未merge）。

### 3.1 Batch 001（ee8745a）

- `training/fingerprint.ts`: standardAi配下を除くゲームエンジン実装の内容ハッシュ。
  AIだけを変更したBefore/After比較が「同じ世界での比較」であることの機械的な証明になる。
  全ベンチマークで `environmentFingerprint=aabcadf67e6f4444` が不変であることを確認。
- `training/benchmark.ts`: quick(8Q×3seed) / standard(32Q×10seed) / deep(32Q×50seed)。
  Redis・Repository・永続化層へ一切依存せず、Test15の保存データに触れない。
- `training/audit.ts`: 監査ルール A01-A14。各findingを
  `AI_LOGIC_DEFECT` / `MANAGEMENT_JUDGMENT_REVIEW` / `ENVIRONMENT_ISSUE_CANDIDATE` に分類。

**Cycle 1の結果（重要）**

| 候補 | 判定 | 実測 |
|---|---|---|
| C02 国内買付の提示価格を需給に応じ引き上げる | **棄却** | 原料不足が全く改善せず（BAL 3,077→3,077t）、営業利益が -180.9M → -507.6M へ悪化。revert |
| C03 生産計画を原料調達可能性で上限する | 採用 | `decision/production.ts` が原料入手可能性を一切参照していなかった |

「提示価格0が原料不足の原因」という一見もっともらしい仮説が、実測で完全に否定された。
**この棄却の記録自体が成果物**である（同じ仮説を再び試さないため）。

### 3.2 Batch 002（5f1332a）

市場需要の2四半期遅行公開とJP19問題の解消。

- **市場エンジンの変更は不要だった**。per market × product の真の需要は既に
  `MarketProductAllocationResult.targetDemand` として `state.history` に保存されていた。
  新設した `marketDemandObservation.ts` は既存の履歴を読むだけである。
- `PublicMarketInfo.observedMarketDemand` を新設し、プレイヤーUIとStandard AI Observationが
  **同一のオブジェクトから分岐する**構造にした（AIだけが別経路で需要を読むことはできない）。
- `decision/sales.ts` の「前期価格首位の市場へ50%、残り均等」という規模非依存の按分を廃止し、
  観測需要 × `maximumSupplierShare` × 期待貢献利益 による機会スコア按分へ変更。
- fingerprint を `gameMechanics` / `informationSet` / `standardAi` の3層へ分離。

**ゲームメカニクス不変の証明方法**: AIの決定を記録し、`git stash` で変更を退避して
旧エンジン上でリプレイしたところ、双方とも `6764e40ad66a01b923f71c7159ed380e` で一致した。

### 3.3 この期間に発見した構造的な問題（未修正・記録のみ）

- **観測需要が内生的**: 市場ウェイトが消費者の希望購入量から導出されている
  （MJ-005 / `ENVIRONMENT_ISSUE_CANDIDATE`）。
- **capex funnelが構造的に到達不能**: 219/219 が `sustained` ゲート
  （全社稼働率 ≥ 0.92）で落ちる。1,600 company-quarter の実測で最大値は 0.877。
  閾値の引き下げは禁止事項のため行っていない。

---

## 4. AI経営説明（Explanation）の安定化（8月8日・本セッション）

### 4.1 Turn4の「経営説明の生成に失敗しました」の原因特定

**推測ではなくVercelランタイムログの実測値で確定させた。**

| # | 原因 | 実ログ |
|---|---|---|
| A | max_tokens到達による打ち切り | `stopReason=max_tokens outputTokens=2000 maxTokens=2000`、`dataLimitations` が丸ごと欠落 |
| B | 応答形式の不一致 | attempt2で `recommendations` が array ではなく string |
| C | timeout | 25,003ms で失敗。正常時latencyは 18,922ms / 19,686ms（余裕5〜6秒しかなかった） |

あわせて、Batch 002 がこの失敗と無関係であること（該当branchが未merge、
4フィールドすべてについて変更ファイル0件）も確認した。

### 4.2 修正（1bd8db6）

- `EXPLANATION_MAX_OUTPUT_TOKENS`: 2000 → **4096**
- `EXPLANATION_CLAUDE_TIMEOUT_MS`: 25,000 → **40,000ms**（クライアント側60秒の内側を維持）
- `normalizeExplanationToolInput` を拡張。ただし救済は
  **「値がstringで、trim後に `[` で始まり、JSON.parseの結果がArray」のときだけ**。
  単純stringの配列化・schema不明値の強制変換・invalid JSONの黙殺は行わず、Zod検証も緩めない。
- 失敗ログ強化（attempt / model / maxTokens / timeoutMs / elapsedMs / token数 /
  stopReason / promptVersion / contextSchemaVersion / contextHash / failureCause）。
  **usageが取れない場合は `(不明)` と書き、0で埋めない。推定値は必ず
  `estimatedInputTokens` という別fieldにする。**
- UIへ `errorCategory` を日本語ラベルで表示（内部stack・秘密情報は出さない）。
- retry policy自体は変更していない。

### 4.3 余裕の実測

```
設定: model=claude-haiku-4-5-20251001 maxTokens=4096 timeoutMs=40000

turn | 診断件数 | context字数 | 推定inputTok | 出力側の余裕
  1  |    23    |    15,779   |    5,635     | +1,796tok（使用率56%）
  4  |    31    |    18,913   |    6,755     | +1,796tok（使用率56%）
  6  |    30    |    18,562   |    6,629     | +1,796tok（使用率56%）

必要出力量の上限側見積り 2,300tok（実ログから）
  旧 maxTokens=2000 → 不足（実際に打ち切り発生）
  新 maxTokens=4096 → 余裕 1,796tok
timeout: 実測latency 18.9〜19.7秒 / 旧25秒（余裕5〜6秒）→ 新40秒（余裕約20秒）
```

回帰テスト `explanationStability.test.ts` を新設し、「出力余裕が上限の70%以下」
「timeoutが実測latencyの2倍以上」「失敗してもStandard AIの意思決定が不変」
「UIがerrorCategoryを表示」を継続監視する形にした。
**「一度成功した」を成功条件にしない**という方針をテストの形で固定したことになる。

---

## 5. Standard AI Q&A（対話レイヤー）MVP（8月8日・本セッション）

`feature/v2-standard-ai-explanation-chat-mvp`（未merge）。
設計の詳細は `docs/standard_ai/STANDARD_AI_EXPLANATION_CHAT_MVP.md` に分離した。

### 5.1 位置づけ

```
Standard AI = 意思決定主体
Claude       = 説明主体
```

Claudeは営業人数・配分・調達・生産・労務・借入・capexのいずれも新しく決めない。
「なぜその判断になったのか」を説明するだけである。

### 5.2 意思決定を変更**できない**ことの構造的保証

これはプロンプトのお願いではなく、構造で担保した。

1. `StandardAiChatPanel` は `draft` / `setDraft` を props に持たない
2. APIハンドラーは decision を返さない
3. 出力スキーマに数値提案のフィールドが存在しない
   （`answerKind` / `conclusion` / `evidence` / `supplement` /
   `relatedReasonCodes` / `limitations` の6つのみ・テストで固定）

### 5.3 情報境界

Claudeへ渡すのは既存 `ExplanationContext`（加工なし）と `situationDiagnosis` の素通しだけ。
回帰テストで機械的に確認していること:

- トップレベルキーが5つから増えていない
- `future` / `forecast` / `shock` / `randomEvent` / `trueDemand` / `allocationResult` 等の
  キー名がcontext全体の**再帰走査**で一切出現しない
- 他社のcompanyIdが直列化結果に一切出現しない（自社IDは出現＝テストが空振りでない）

### 5.4 「分からない」と言えること

本機能の目的は「Standard AIを賢そうに見せること」ではなく、
**人間が判断を問い、矛盾を発見し、批判できるようにすること**である。したがって:

- 根拠がログに無ければ `answerKind = insufficient_evidence` として
  「この点はStandard AIの判断ログからは確認できません」と答える
- Standard AIを擁護しない。根拠が弱ければ「ご指摘は妥当です」
  「この部分はヒューリスティック依存です」と答えてよい
- 比較候補は現行のStandard AIが保存していないため、
  「他にどんな選択肢があったの？」には常に「記録が保存されていません」としか答えない
  （代替案の創作は明示的に禁止）

### 5.5 Human Challenge Log

将来 Training Harness へ `HUMAN_AI_CHALLENGE` として戻すための記録。
`labId` / `companyId` / `turn` / `contextHash` / `question` / `answer`（構造化のまま）/
`relatedReasonCodes` / `challengeType` / `timestamp`。
`challengeType` はキーワードによる決定論的分類であり意味理解ではないため、
原文を必ず併せて保存しHarness側で再分類できるようにしてある。
**MVPでは自動学習・自動修正は一切行わない。**

### 5.6 実context確認（Turn4相当）

```
primaryConstraint=sales_shortage / secondaryConstraint=production_capacity_surplus
3質問とも 入力約20,300字 / 推定7,250tok
参照可能な reason code（contextに実在）:
  SALES_FORCE_BINDING_CONSTRAINT / SALES_HIRING_PROFITABLE_UNSERVED_OPPORTUNITY /
  SALES_HIRING_DEFERRED_UNTIL_CAPACITY_EXPANSION / CAPEX_DEFERRED /
  PRODUCTION_CAPACITY_HEADROOM ほか
意思決定オブジェクト不変: true / 他社IDの混入: なし
```

「なぜ工場を増設しないの？」に対して、`CAPEX_DEFERRED` と
`PRODUCTION_CAPACITY_HEADROOM`、`secondaryConstraint=production_capacity_surplus` が
揃っており、**理由を創作しなくても答えられる根拠が実在する**ことを確認した。

---

## 6. 品質ゲート（本セッション末時点）

| 項目 | `feature/v2-test15-integration` | `feature/v2-standard-ai-explanation-chat-mvp` |
|---|---|---|
| `npm test` | 2,471 pass / 0 fail | **2,490 pass / 0 fail** |
| `npx tsc --noEmit` | エラー0 | エラー0 |
| `npm run lint` | error 0（既存warning 7件） | error 0（既存warning 7件） |
| `npm run build` | 成功 | 成功（新route登録を確認） |

`npm run build` はローカルで素のまま実行すると `STAGING_KV_REST_API_URL` 未設定で
失敗するが、これはサンドボックス環境固有の制約であり、プレースホルダ値を与えると成功する
（前回日誌と同一の既知の制約）。

---

## 7. Preview 環境

| branch | 判別用の別名 |
|---|---|
| Test15統合 | `...-git-feature-v2-test-1beb93-...` |
| Training Harness | `...-git-feature-v2-stan-3c8b89-...` |
| Q&A MVP | `...-git-feature-v2-stan-ad4aaa-...` |

Training Harness と Q&A MVP はどちらも `feature-v2-stan` で始まるため、
**末尾のハッシュで見分ける必要がある**。実際、Q&A MVP の確認時に
Test15統合branchのPreviewを開いてしまい「緑のボタンが無い」となる事例が発生した。

---

## 8. この期間に得られた運用上の教訓

1. **仮説は必ず実測で検証し、棄却も記録する。**
   C02（買付価格引き上げ）は、もっともらしいが実測では完全に否定された。
   棄却の記録が無ければ同じ仮説を何度も試すことになる。
2. **実データを一度は目で見る。**
   Test15データブックの2件の参照ミスは、合成データのテストをすべて通過していた。
3. **失敗原因はログの実測値で確定させる。過去報告からの推測をしない。**
   Turn4のExplanation失敗は、3つの独立した原因が同時に存在していた。
   推測で1つだけ直していたら再発していた。
4. **`git add -A` を使わない。**
   別branchの生成物（約350万行のベンチマーク出力）を誤って混入させた（0b8d802で除去）。
   force pushが禁止されているため、履歴からは消せず削除commitで対応した。
5. **安全性はプロンプトではなく構造で担保する。**
   Q&Aの「意思決定を変更しない」は、propsを渡さない・decisionを返さない・
   出力スキーマにフィールドを置かない、という3重の構造で保証している。
6. **`(不明)` と `0` を区別する。**
   実測できなかった値を0で埋めると、後から実測値と推定値の区別がつかなくなる。

---

## 9. 次にやること（提案・未着手）

1. **Q&A MVPの実機確認**（Preview `...ad4aaa...`）。実APIでの回答内容は未検証。
   §25の3質問＋「その判断、変じゃない？」で、弱点を認めるかを確認する。
2. **reason code照合バリデーション**（Q&A Phase 2最優先）。
   回答の `relatedReasonCodes` が `diagnosticEntries` に実在するかをサーバー側で照合し、
   実在しないコードを含む回答を弾く。ハルシネーション対策の機械化として費用対効果が最も高い。
3. **rejected candidates の記録**。Standard AIが採用しなかった候補を構造化して残せば、
   「他の選択肢は？」に実データで答えられるようになる。
4. **capex funnel（MJ / 稼働率0.92ゲート）と観測需要の内生性（MJ-005）の扱い**の判断。
   いずれも `ENVIRONMENT_ISSUE_CANDIDATE` であり、ゲーム環境側の変更を伴うため
   実装判断は保留している。
5. **Training Harness branch（Batch 002）のmerge可否判断**。
