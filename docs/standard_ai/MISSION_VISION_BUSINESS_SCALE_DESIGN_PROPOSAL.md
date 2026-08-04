# Mission / Vision / Business Scale Profile 設計提案（合意事項メモ）

2026-08-04 Cowork #05（AI設定） 三宅さんとの設計議論の合意事項

**位置づけ**: 本文書はまだ実装指示ではない。Standard AI診断基盤（Phase B〜F）の上位に置く「企業理念→経営方針→事業規模診断→シナリオ評価」という階層構造について、三宅さんとClaude（Cowork #05）の間で合意した設計方針を記録したものである。実装は本文書のあとの回で、下記の段階順に着手する。

## 1. 既存コードとの関係（今回の議論で確認済みの重要な事実）

`managementProfile.ts`（Phase SAI-4、経営性格プロファイル：balanced/growth/conservative/valueAdded/opportunistic、±5〜10%の小幅バイアス、安全ガードは対象外）と`orientationProfile.ts`（Phase SAI-5A、市場・商品志向プロファイル：市場別・商品別の重み付け）が既に存在し、`policy.ts`の`resolveParams`という単一の注入フックを通じて全社共通ロジック（`decision/*.ts`は一切companyId分岐を持たない）へ適用されている。

今回設計するMission/Vision/Strategic Principles/Business Scale Profileは、この既存2層をゼロから置き換えるものではなく、(a) 既存2層に「なぜこの数値バイアスなのか」という意味付けを与える、(b) 既存2層の上に「事業規模の現在地」と「Visionとの進捗差」という新しい診断入力を追加する、という位置づけである。

## 2. 全体構造（合意版）

```
Mission（何のために存在する会社か）
  ↓
Vision（5〜7年後にどこへ行くか）
  ↓
Vision Progress Diagnosis（今、その道筋に対して進んでいるか遅れているか）
  ↓
Strategic Principles（既存のManagementProfile/OrientationProfileに意味を与える）
  ↓
Business Scale Profile（Sales/Production/Labor/Raw/Financeの現在の企業体力）
  ↓
Conservative / Base / Growth Scenario
  ↓
Scenario Evaluation（Vision・利益・財務安全性・戦略整合性から比較）
  ↓
意思決定（本ラウンドでは未接続）
```

## 3. 前回提案からの3点の修正（三宅さんの指摘、採用）

### 3.1 Vision軌道は単線ではなく「達成帯」を持つ

三宅さんのVisionは「5〜7年で規模倍増」であり、固定CAGR（例: 7年=2.6%/四半期）を1本の基準線として課すのは機械的すぎる。代わりに、5年ライン（≈3.5%/四半期）と7年ライン（≈2.5%/四半期）の間を「達成帯」として持ち、現在の実績がこの帯に対してどこにあるかで評価する。

- 5年ラインより速い → **Ahead**
- 5〜7年ラインの帯内 → **On Track**
- 7年ラインより遅い → **Behind**

### 3.2 利益80Mは単四半期ではなくTrailing 4 Quartersで見る

エビ産業の四半期変動を考慮し、単一四半期の利益で「Vision未達」と判断しない。Visionの二大指標は次の2つとする。

- 事業規模: 年間換算またはTrailing 4Q販売量
- 収益力: Trailing 4Q税引後利益

### 3.3 Vision進捗診断は単一スコアへ潰さない

Claudeの前回提案（「単一の追加入力」）を修正し、少なくとも次の4つを分離して保持する。

- Scale trajectory gap（事業規模の進捗差）
- Profit trajectory gap（収益力の進捗差）
- Future capacity readiness（将来の成長に対する能力の準備度）
- Financial readiness（投資・成長に使える財務余力）

この分離により、「売上規模はVisionより遅れているが利益はVisionより進んでいる。設備は2年後の成長には不足。財務には投資余力あり」というような組み合わせを表現でき、「利益力を維持しながら能力投資を行い、次の成長に備える」という、単純な「安売りして販売量を増やせ」ではない判断が可能になる。これが今回目指す経営AIの核心的な価値である。

## 4. 実装段階（合意版、全段階が診断専用）

1. **第1段階**: Business Scale Profile — Sales/Production/Labor/Raw/Financeの5つの企業体力を診断（診断専用、既存モジュールの出力集約が中心）。
2. **第2段階**: Conservative / Base / Growth Scenario の生成（診断専用）。
3. **第3段階**: Mission / Visionのデータ構造（テキスト＋Vision達成帯の2大指標）。
4. **第4段階**: Vision Progress Diagnosis（§3.1〜3.3の設計を反映、4分離指標）。
5. **第5段階**: 既存Management/Orientation Profileとの接続（Mission/Visionによる意味付け。数値ロジック自体は既存の安全弁付きバイアス機構を流用）。
6. **第6段階**: Scenario Evaluation（Principlesによる支持/反対フラグ付け、単一合成スコアへは潰さない）。
7. **第7段階**: 本番decisionへの接続（本ラウンドでは着手しない）。

**Business Scale Profileを最初に置く理由**: Mission/Visionは「会社がどこへ行きたいか」、Business Scale Profileは「今どこにいるか」。現在地が診断できていなければVisionとの差（進捗診断）自体が測れないため、依存関係上Business Scale Profileが必ず先行する。

## 5. 将来展望として合意した副次効果

現行の5社差別化（balanced/growth/conservative/valueAdded/opportunistic × 市場・商品志向）は、単なる係数差ではなく「各社の暗黙のMission/Vision」の数値化だったと捉え直せる。将来、5社それぞれに簡潔なMission/Vision文を後付けで与えれば、「なぜGrowth社はGrowth型なのか」を説明できるようになり、5社差別化が係数差から企業戦略差へ昇格する。これはゲームデザインとしても価値が高いと合意した。

## 6. 次のアクション

**2026-08-04更新: 第1段階（Business Scale Profile）着手・完了。** `diagnosis/businessScaleProfile.ts`（5軸、単一値へ潰さない）・`diagnosis/businessScaleScenarios.ts`（Conservative/Base/Growth、型と生成ルール案）を実装し、テスト18件・全2194件pass・tsc/lintクリーンを確認して`feature/v2-standard-ai-unit-economics-shadow-allocation`へpush済み。実測38人ケースへの適用結果は`TEST14_TURN2_BUSINESS_SCALE_PROFILE.md`・`TEST14_TURN2_BUSINESS_SCALE_SCENARIOS.md`、既存Profile監査は`EXISTING_MANAGEMENT_ORIENTATION_PROFILE_AUDIT.md`、Mission/Vision/Policyドラフトと将来のVision Progress Diagnosis設計は`STANDARD_COMPANY_MISSION_VISION_POLICY_DRAFT.md`、observation gapと#04引き渡しは`BUSINESS_SCALE_OBSERVATION_GAPS_AND_04_HANDOFF.md`を参照。

次回は第2段階以降（Mission/Visionデータ構造の実装、Vision Progress Diagnosisモジュールの実装）に進む前に、三宅さんの確認・優先順位付けを待つ。本番decisionへの接続（第7段階）は依然未着手。
