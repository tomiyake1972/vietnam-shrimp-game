# Standard AI 営業採用モジュール 8ターン×5社シミュレーション結果報告

作成: Cowork #05（AI設定）／2026-08-05
実行方法: `initializeCompanyLab`/`buildCompanyOwnState`/`buildPublicMarketInfo`/`buildStandardAiObservation`/
`generateStandardAiDecisionWithDiagnostics`/`advanceCompanyLabQuarter` を用い、`baseline`シナリオ・
seed `sai-8q-summary-2026-08-05`・8ターン・5社（BAL/JPQ/VAP/CONSV/MASS）で新設モジュールを実際に接続して実行した
（一時デバッグスクリプト、実行後削除済み）。

**本文書の目的は問題の報告であり、チューニング（修正）はまだ行っていない。** 三宅さんのご指示
「チューニングしすぎないでください。まず問題を報告してください。」に従う。

## 1. 重大な発見：BAL/JPQ/VAP/CONSVの営業人員数が指数的に増加した

BALの実際の出力（turn / headcount / hire / layoff / cash / fgTotal / primaryConstraint）:

```
turn1 headcount=18  hire=0  layoff=0  cash=30,000,000  fgTotal=0     primaryConstraint=sales_shortage
turn2 headcount=18  hire=9  layoff=0  cash=62,465,708  fgTotal=3,108 primaryConstraint=worker_surplus
turn3 headcount=27  hire=14 layoff=0  cash=58,854,550  fgTotal=3,649 primaryConstraint=worker_surplus
turn4 headcount=41  hire=21 layoff=0  cash=58,712,379  fgTotal=1,695 primaryConstraint=sales_shortage
turn5 headcount=62  hire=31 layoff=0  cash=61,315,948  fgTotal=1,343 primaryConstraint=sales_shortage
turn6 headcount=93  hire=47 layoff=0  cash=35,988,891  fgTotal=1,784 primaryConstraint=worker_shortage
turn7 headcount=140 hire=0  layoff=0  cash=28,641,738  fgTotal=734   primaryConstraint=worker_shortage
turn8 headcount=140 hire=0  layoff=0  cash=26,522,157  fgTotal=849   primaryConstraint=worker_shortage
```

JPQ・VAP・CONSVも同様の複利的増加パターンを示した（同じ安全上限式に支配されているため、形状は共通）。
一方、**MASSは8ターン全てで採用ゼロ（headcount=22で固定、`sales_shortage`が毎ターン継続）**——こちらも別途注記する
（§3参照）。

## 2. 根本原因：安全上限が「現在の（既に膨張した）人数」に対する相対値になっている

`salesForceHiring.ts`の安全上限:

```ts
const MAX_HIRE_PER_QUARTER_ABSOLUTE_FLOOR = 5;
const MAX_HIRE_PER_QUARTER_RELATIVE_RATIO = 0.5;
function maxHireCountThisQuarter(currentHeadcount: number): number {
  return Math.max(MAX_HIRE_PER_QUARTER_ABSOLUTE_FLOOR, Math.round(currentHeadcount * MAX_HIRE_PER_QUARTER_RELATIVE_RATIO));
}
```

この上限は「1回の判断で極端な人数を動かさない」ための意思決定ガバナーとして設計したが、`currentHeadcount`が
**その四半期の期初人数**であるため、採用が起きるたびに次の四半期の上限も一緒に大きくなる。結果として、
market opportunity側の停止条件（A/D/E/G/H）に達する前は、ほぼ毎四半期「現在人数の50%」に近い数だけ採用が続き、
18→27→41→62→93→140と約1.5倍/四半期の複利成長になった。turn7でようやく`worker_shortage`が主要制約として
採用を完全に止めている（Worker側の制約が最終的なブレーキとして機能したこと自体は、設計意図どおり——
「Workerが処理できない増員はしない」というご指示§6-Fの停止条件は機能している）。

これは三宅さんのご指示§22で明示的に警告されていた失敗モード
「salespeople endlessly increasing」に正確に該当する。

## 3. 別の観察：MASSは8ターン採用ゼロのまま

MASSはheadcount=22で固定、`primaryConstraint=sales_shortage`が毎ターン継続した。BAL等と異なり採用が
一度も発生しなかった。今回のシミュレーションでは原因の深掘りは行っていない（停止条件A〜Hのどれが
毎ターン採用をブロックしているかは、診断エントリのreason codeを個社別に追跡する必要がある）。
次回セッションでの調査候補として記録する。

## 4. 確認できた「壊れていない」点（回帰なし）

- 8ターン×5社、32ターン×5社のいずれも例外なく完走。
- `salesForceHireCount`/`salesForceLayoffCount`を含む全数値フィールドが有限（NaN・Infinityなし）。
- 採用・減員が同一四半期に同時発生しない（設計どおり）。
- 決定論性（同一入力→同一出力）を維持。
- turn7以降、`worker_shortage`によって採用が実際に止まっている——安全上限だけに依存しているわけではなく、
  Worker制約という独立したブレーキが最終的に効いている。

## 5. 今回あえて実施しなかった対応（チューニング保留）

三宅さんのご指示に従い、以下はいずれも**今回実施しなかった**。

- 安全上限を「期初人数」でなく「シーズン開始時の人数」や絶対数キャップに変更すること。
- `MAX_HIRE_PER_QUARTER_RELATIVE_RATIO`の値を下げること。
- 複利成長を抑える追加の停止条件（例: 直近N四半期の累積採用率キャップ）を新設すること。
- MASSの非採用の原因調査・修正。

## 6. 【追記・2026-08-05】三宅さんレビュー受領後の修正と再検証

三宅さんより本報告への受入判定を受領し、「安全上限が複利成長を許可する式になっている」「Target Sales Force方式へ修正すべき」「MASS非採用の原因を診断すべき」との具体的な指示を受け、以下を実施した。

### 6.1 Target Sales Force方式への修正

`salesForceHiring.ts`のマージナル採用ループを、「反復回数の恣意的上限で打ち切る」設計から、「自然停止条件（A/D/E/G/H）まで評価してTarget Sales Force（必要な将来営業能力）を先に計算し、その不足分を、会社の**静的な基準規模**（`fixture.salesForceHeadcountTotal`、ターンをまたいでも変わらない）に対するガバナーでキャップして今四半期へ反映する」設計へ変更した。詳細は`STANDARD_AI_SALESFORCE_HIRING_DESIGN.md`§4を参照。

### 6.2 再実行結果: 複利成長は解消

同じ`baseline`シナリオ・5社・8ターンで再実行した結果（BALのみ抜粋、全社分は§6.4参照）:

```
turn1 BAL headcount=18 hire=0 layoff=0
turn2 BAL headcount=18 hire=9
turn3 BAL headcount=27 hire=9
turn4 BAL headcount=36 hire=9
turn5 BAL headcount=45 hire=9
turn6 BAL headcount=54 hire=9
turn7 BAL headcount=63 hire=9
turn8 BAL headcount=72 hire=9
```

BAL（静的基準規模18人、ガバナー`max(5,round(18×0.5))=9人/期`）は、修正前の18→27→41→62→93→140（複利）から、18→27→36→45→54→63→72（**線形**、毎期+9人固定）へ変わった。JPQ・VAP（基準14人、ガバナー7人/期）・CONSV（基準10人、ガバナー5人/期）も同様に線形化し、8ターンを通じて`hire>10`のアノマリーは0件だった（修正前は複数ターンで検出）。この結果は回帰テスト（`salesForceHiring.test.ts`「複利成長しない」）で固定化した。

### 6.3 MASS非採用の原因: 解明済み

診断reason codeを個社別に追跡した結果、MASSが8ターン採用ゼロだった理由が判明した。

```
turn1: SALES_HIRING_NOT_ECONOMIC（限界貢献利益が営業給与を下回る）
turn2〜8: SALES_HIRING_BLOCKED_BY_LIQUIDITY（現金の最低バッファ余力を超えるため採用見送り）
```

MASSは実際にturn6で現金がほぼ0まで低下しており（cash=0）、turn7・8でも$3M前後と低水準が続いた。したがって「営業機会があるのに採用しない」という一見不可解な状態は、**資金制約による正当な判断**であることが確認できた。バグではなく、モジュールが意図通り「positive NPVでもcash timingが危険なら見送る」というご指示§6-Hのロジックを働かせた結果である。MASSの資金繰り自体（cash=0まで低下すること自体の是非）は、Standard AIの営業採用モジュールの範囲外（生産・調達・資金の他モジュールの挙動）であり、別途の調査対象として申し送る。

### 6.4 全社再実行データ（turn/company/headcount/hire/layoff/cash/fgTotal）

```
turn1 BAL headcount=18 hire=0 layoff=0 cash=30,000,000 fgTotal=0
turn1 MASS headcount=22 hire=0 layoff=0 cash=30,000,000 fgTotal=0
turn1 JPQ headcount=14 hire=0 layoff=0 cash=25,000,000 fgTotal=0
turn1 VAP headcount=14 hire=0 layoff=0 cash=22,000,000 fgTotal=0
turn1 CONSV headcount=10 hire=0 layoff=0 cash=35,000,000 fgTotal=0
turn2 BAL headcount=18 hire=9 layoff=0 cash=62,691,011 fgTotal=2,811
turn2 MASS headcount=22 hire=0 layoff=0 cash=35,288,996 fgTotal=3,235
turn2 JPQ headcount=14 hire=7 layoff=0 cash=33,181,552 fgTotal=2,835
turn2 VAP headcount=14 hire=7 layoff=0 cash=35,172,700 fgTotal=3,841
turn2 CONSV headcount=10 hire=5 layoff=0 cash=37,497,466 fgTotal=3,621
turn3 BAL headcount=27 hire=9 layoff=0 cash=58,532,036 fgTotal=3,543
turn3 MASS headcount=22 hire=0 layoff=0 cash=16,048,263 fgTotal=4,200
turn3 JPQ headcount=21 hire=7 layoff=0 cash=28,656,224 fgTotal=2,915
turn3 VAP headcount=21 hire=7 layoff=0 cash=31,604,668 fgTotal=2,734
turn3 CONSV headcount=15 hire=5 layoff=0 cash=30,615,592 fgTotal=2,747
turn4 BAL headcount=36 hire=9 layoff=0 cash=58,344,872 fgTotal=1,766
turn4 MASS headcount=22 hire=0 layoff=0 cash=16,745,599 fgTotal=3,128
turn4 JPQ headcount=28 hire=7 layoff=0 cash=30,306,275 fgTotal=1,494
turn4 VAP headcount=28 hire=7 layoff=0 cash=35,829,494 fgTotal=836
turn4 CONSV headcount=20 hire=5 layoff=0 cash=35,197,185 fgTotal=875
turn5 BAL headcount=45 hire=9 layoff=0 cash=61,110,566 fgTotal=1,249
turn5 MASS headcount=22 hire=0 layoff=0 cash=18,960,116 fgTotal=2,018
turn5 JPQ headcount=35 hire=7 layoff=0 cash=31,856,822 fgTotal=1,583
turn5 VAP headcount=35 hire=7 layoff=0 cash=39,447,966 fgTotal=827
turn5 CONSV headcount=25 hire=5 layoff=0 cash=38,158,462 fgTotal=948
turn6 BAL headcount=54 hire=9 layoff=0 cash=37,123,722 fgTotal=2,336
turn6 MASS headcount=22 hire=0 layoff=0 cash=0 fgTotal=1,931
turn6 JPQ headcount=42 hire=0 layoff=0 cash=19,293,953 fgTotal=2,530
turn6 VAP headcount=42 hire=0 layoff=0 cash=20,977,478 fgTotal=1,532
turn6 CONSV headcount=30 hire=5 layoff=0 cash=35,642,856 fgTotal=1,554
turn7 BAL headcount=63 hire=9 layoff=0 cash=33,039,064 fgTotal=2,885
turn7 MASS headcount=22 hire=0 layoff=0 cash=2,974,628 fgTotal=1,593
turn7 JPQ headcount=42 hire=0 layoff=0 cash=19,153,762 fgTotal=2,883
turn7 VAP headcount=42 hire=0 layoff=0 cash=18,444,768 fgTotal=2,228
turn7 CONSV headcount=35 hire=5 layoff=0 cash=32,561,392 fgTotal=1,502
turn8 BAL headcount=72 hire=9 layoff=0 cash=32,425,898 fgTotal=2,669
turn8 MASS headcount=22 hire=0 layoff=0 cash=3,924,702 fgTotal=0
turn8 JPQ headcount=42 hire=7 layoff=0 cash=24,176,369 fgTotal=2,987
turn8 VAP headcount=42 hire=0 layoff=0 cash=19,232,704 fgTotal=2,219
turn8 CONSV headcount=40 hire=5 layoff=0 cash=31,901,206 fgTotal=1,103
```

`hire>10`または`layoff>10`のアノマリーは0件。JPQ・VAPがturn6・7で採用0（生産余力・資金等の他ゲートで停止したと推測されるが、reason code個別追跡は今回未実施）になっている点は、今後の観察対象として記録する。

### 6.5 今回あえて実施しなかった対応

- JPQ・VAPのturn6・7の採用停止理由のreason code個別追跡（MASSのみ深掘りした）。
- ガバナーの基準規模（静的値）自体を動的に更新すべきかどうかの検討（§4.3既知の限界参照、三宅さんの追加ご判断が必要）。
- MASSの資金繰り自体（cash≈0まで低下すること）の原因調査（営業採用モジュールの範囲外）。

## 7. 次回セッションへの推奨（判断は三宅さんへ）

1. ガバナーの基準規模（静的な会社設立時の営業人員数）を、将来的に動的な基準（例: 直近N四半期の平均等）へ変更すべきかどうかの方針決定。
2. JPQ・VAPのturn6・7採用停止理由の個別診断（MASSと同じ手法で追加調査可能）。
3. MASSの資金繰り悪化（cash≈0）の原因調査（Financial Capacity診断モジュールとの統合、または生産・調達側の挙動確認）。
4. 上記はいずれも#05側のロジック・診断調整であり、#04のゲームパラメータ変更ではない。
