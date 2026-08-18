# ShrimpX V2 — Standard AI配当ポリシー（DIV-3）設計協議のための提案

宛先: ChatGPT（#04/#05横断・評価システム担当）
起票: Claude Code（実装担当）
対象ブランチ: `feature/v2-32q-management-console`（HEAD `dfa709b`時点）

## 0. この提案の位置づけ

TSV正式化（Dividend Value年率15%複利 + Enterprise Value 10年10%DCF）の実装指示§25で、
「Standard AI配当ポリシー設計はDIV-3として次Phaseへ持ち越し、今回は勝手に実装しない」
と明示的に留保されている。この文書はその設計協議のための**たたき台**であり、実装は
別途正式な指示を受けてから行う。

## 1. なぜ今、この協議が必要か

現行のTSV評価（第一目標）は「配当した瞬間はTSVがほぼ不変、以後15%で複利する」という
設計であり、これはPlayerにとって有効な資本配分レバーとして機能している。しかし
Standard AI 5社は全社配当0に固定されているため、以下の非対称性が構造的に存在する。

- PlayerがTSVランキングで上位を狙う手段は「配当タイミングの最適化」を含むが、
  AI企業には同じ手段が存在しない（比較対象として機能しない）。
- ベンチマーク（`docs/v2/reports/tsv_leaderboard_benchmark_output.txt`）で確認した
  とおり、強い会社（バランス型）が全額配当を続けると、Turn32時点でTSVが
  無配当ケース比+33.2%まで伸びる。AIがこの手段を一切使わないと、Player有利な
  比較になりやすく、「ゲームとしての公平な競争」という観点で違和感が生まれうる。
- 一方で§20（前回指示）は「強いAI配当ポリシーを作らない」ことも明確に求めている
  （配当メカニクス導入直後にAIが不適切な大量配当をする事態を避けるため）。

この2つの要請（①AIも一定の配当を行い比較の土台を作る／②過度に強いAIにしない）を
両立させる設計を、実装着手前に合意したい。

## 2. 既存アーキテクチャの棚卸し（設計の土台になる部分）

Standard AIには、すでに「小幅な経営性格バイアス」という確立された仕組みがある
（`app/lib/v2/companyLab/standardAi/managementProfile.ts`）。

- `ManagementProfileId`: `"balanced" | "growth" | "conservative" | "valueAdded" | "opportunistic"`
  の5種類。5社（MASS/JPQ/VAP/CONSV/BAL）に既定マッピング済み。
- 各プロファイルは、販売積極性・値引き許容度・輸入依存度・在庫是正速度・
  CAPEXハードル（`capexHurdleBiasRatio`）等を、基準値に対して**原則±5%、
  最大でも±10%**というルールで小幅に調整する仕組みで統一されている
  （`TYPICAL_BIAS_RATIO` / `MAX_BIAS_RATIO`。この上限を超えるバイアスは
  実装時に例外を投げて自動的に弾かれる）。
- 財務健全性のSSoTは`FinancialHealthStatus.primary`
  （`"healthy"|"watch"|"stressed"|"covenantBreach"|"paymentArrears"|"insolvent"|"paymentDefault"`。
  `app/lib/v2/financing/types.ts`）であり、EVAL-1の`distressTurnCount`もこの値を
  そのまま読んでいる。
- 分配可能利益（`CompanyFinanceState.distributableEarnings`）・配当エンジン
  （`app/lib/v2/finance/dividend.ts`の`resolveDividendDecision`/
  `computeMaxDividendUsd`）はPlayer/AI共通で、AIに配当をさせる場合も
  新しい会計ロジックは一切不要（既存のmaxDividend＝min(Cash,
  distributableEarnings)がそのまま働く）。

**結論**: 新しい「AI配当エンジン」を作る必要はない。既存の
ManagementProfileバイアス方式に「配当性向（dividendPropensityRatio等）」の
1軸を追加し、既存の財務健全性ゲートと組み合わせるだけで実装できる見込み。

## 3. 候補案

### 案A（現状維持）: AI配当は今後も常に0

- 長所: リスクゼロ。TSV公平性の懸念だけが残る。
- 短所: 協議の目的（AIも比較対象にする）を満たさない。

### 案B（前回指示が示していた最小案）: 条件付き少額配当

前回のDIV-1指示§20が例示していた最小ポリシー：
「十分なcashバッファ・非distress・当期CAPEX予定なし・前期分配可能利益が正、
の条件をすべて満たす場合のみ、少額の配当を許可」。

- 実装イメージ: `financialHealth.primary === "healthy"` かつ 直近Turnの新規CAPEX
  提案が0件 かつ `distributableEarnings`が一定閾値（例: 直近四半期売上高の
  一定割合）を上回る場合のみ、`distributableEarnings`の小さな一部
  （例: 10〜20%）を配当する。
- 長所: 既存の「安全側に倒す」フィルタ思想と自然に整合。実装リスクが低い。
- 短所: 発火頻度が低く、Player有利な非対称性の是正効果が限定的になりうる
  （5社中、健全なアーキタイプだけが時々配当する程度）。

### 案C（ManagementProfile拡張案・本提案の推奨）: プロファイル別「配当性向」バイアス

`ManagementProfile`へ新しい比率バイアス`dividendPropensityRatio`
（既存の±5%/±10%ルールと同じ枠組み）を追加し、以下の基準配当ルールに
乗算する形で5社の差を作る。

1. **基準配当ルール（全社共通・案Bのロジックをベースにする）**:
   `financialHealth.primary === "healthy"` かつ 当期CAPEX新規提案なし
   かつ `distributableEarnings > 0` の場合のみ、
   `baseDividendUsd = distributableEarnings × BASE_PAYOUT_RATIO`
   （`BASE_PAYOUT_RATIO`は小さい値、例: 15%程度を初期候補とし、
   後述§5のベンチマークで調整）。
2. **プロファイル別バイアス**: `dividendPropensityRatio`は既存の
   `capexHurdleBiasRatio`と対になる設計とし、
   `conservative`（保守的・財務慎重水産）は配当性向をやや高く
   （＝再投資よりCashを厚めに配りたい保守性格として自然）、
   `growth`/`valueAdded`（成長・高付加価値志向）は配当性向をやや低く
   （＝再投資優先）といった、既存の経営性格の物語と矛盾しない方向で
   ±5〜10%の範囲に収める。
3. **上限は必ずPlayerと同じ`computeMaxDividendUsd`でクランプ**
   （AI専用の別上限を作らない＝会計整合性の単一ソースを維持）。

- 長所: 既存の「経営性格の違いを小幅バイアスで表現する」設計思想と完全に整合。
  5社の配当行動に自然な差が出るため、TSV Leaderboardが「どの経営性格が
  現在のTSV評価で有利か」を示す、意図された比較機能として働く。
- 短所: 新しいプロファイルフィールドの追加のため、既存の
  `ManagementProfile`テスト・診断（`AppliedManagementBiasItem`等）へも
  小さな追加作業が発生する（ただし既存パターンの踏襲であり大きなリスクではない）。

### 案D（アグレッシブ案・非推奨）: TSV最大化を目的関数にした最適化AI

各Turnで複数のシミュレーションを内部的に試算し、TSVを最大化する配当額を
選ぶような「強いAI」。

- 前回指示§20「強い/積極的な配当AIを作らない」に明確に反するため、
  この協議では**候補として提示するが推奨しない**。

## 4. 推奨: 案C＋案Bのハイブリッド

- ベースは案B（財務健全性・CAPEX予定・分配可能利益による安全側フィルタ）を
  そのまま踏襲し、AIが不適切なタイミングで配当しないことを担保する。
- その上に、既存`ManagementProfile`の枠組みで`dividendPropensityRatio`を
  1軸追加し、5社に小さな配当行動の差を持たせることで、TSV Leaderboardの
  比較機能としての意味を回復する。
- 新しい会計・評価ロジックは一切追加しない（`finance/dividend.ts`・
  `evaluationSemantics.ts`はどちらも無変更で動作する）。

## 5. 協議していただきたい論点

1. **`BASE_PAYOUT_RATIO`の初期値**: distributableEarningsの何%を基準配当と
   するか（案では15%を仮置き）。ベンチマーク（`tsvLeaderboardBenchmark.ts`を
   拡張し、AI配当ON/OFFの32Turn比較を追加する想定）で調整可能。
2. **発火条件の厳格さ**: 「当期CAPEX新規提案なし」を必須条件にすると、
   成長期のAI（growth/valueAdded系）はほぼ配当しなくなる。これを狙いどおり
   とするか、もう少し緩めるか。
3. **dividendPropensityRatioの符号方向**: conservative＝配当性向を上げる、
   growth/valueAdded＝配当性向を下げる、という本提案の割当てが経営性格の
   物語と整合しているか（他の割当ても検討可能）。
4. **§20との整合確認**: 「強い配当AIを作らない」という制約を、この案が
   本当に満たしているか（基準配当がdistress時・CAPEX期に自動停止する
   点で担保しているつもりだが、追加の安全弁が必要か）。
5. **成功条件**: DIV-3の完了条件を「AI 5社のうち少なくとも数社が、
   32Turn中の一部Turnで配当を実施し、TSV Leaderboardに意味のある比較が
   生まれること」としてよいか。

## 6. 次のステップ（このまま合意いただけた場合）

1. `ManagementProfile`へ`dividendPropensityRatio`追加＋5社への割当て。
2. `policy.ts`（Standard AI意思決定生成）へ、上記の基準配当ルール＋
   バイアス適用を実装（`dividendDecision`を`undefined`固定から条件付き
   生成へ変更）。
3. `tsvLeaderboardBenchmark.ts`をAI配当ON/OFF比較に拡張し、
   §24と同じ「支配戦略化していないか」の診断を実施。
4. テスト追加（基準配当ルールの各条件・プロファイル別バイアスの適用・
   既存Player配当ロジックとの非干渉）。
5. 最終報告（本セッションと同じ形式）。
