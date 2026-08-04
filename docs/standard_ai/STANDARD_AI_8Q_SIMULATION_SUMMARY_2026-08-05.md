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

## 6. 次回セッションへの推奨（判断は三宅さんへ）

1. 安全上限の基準を「現在人数」ではなく、固定値、または「シーズン最初の人数」等、複利成長しない基準へ
   変更するかどうかの方針決定。
2. MASSが8ターン採用ゼロだった理由の診断ログ調査。
3. 上記2点は#05側のロジック調整であり、#04のゲームパラメータ変更ではない。
