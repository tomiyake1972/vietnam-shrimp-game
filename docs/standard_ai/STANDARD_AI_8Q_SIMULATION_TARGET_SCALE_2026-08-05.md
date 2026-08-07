# Standard AI Target Scale統合版 8Q（および16Q延長）シミュレーション結果報告

作成: Cowork #05（AI設定）／2026-08-05
実行方法: `baseline`シナリオ・5社（BAL/JPQ/VAP/CONSV/MASS）・8Q（一部BALのみ16Qへ延長）。
一時デバッグスクリプト、実行後削除済み。

## 1. 複利成長は解消（引き続き確認）

`hire>15`または`layoff>15`のアノマリーは8Q・16Qいずれの実行でも0件だった。BALの営業人員推移（8Q）:

```
turn1 headcount=18 hire=0
turn2 headcount=18 hire=9
turn3 headcount=27 hire=9
turn4 headcount=36 hire=9
turn5 headcount=45 hire=9
turn6 headcount=54 hire=9
turn7 headcount=63 hire=9
turn8 headcount=72 hire=9
```

**線形**（毎期+9人固定、ガバナー`max(5,round(18×0.5))=9`）。前回報告（Target Scale導入前）の複利的成長（18→27→41→62→93→140）と比較して、増加ペースは変わらず一定である。

## 2. Target Scale Bandは安定（三宅さんご指示§18対応の確認）

`targetScaleCapacityWeightInBaseline`を0.5→1.0（実効生産能力のみを基準）へ修正した後、BALのTarget Scale Bandは全8ターンで`[20,520-23,598-27,702]`t/期のまま**完全に一定**だった（修正前は毎ターン変動し、§18に抵触していた。詳細は`STANDARD_AI_STRATEGIC_INTENT_AND_TARGET_SCALE.md`§4.2参照）。

## 3. 重要な発見: 8Q（16Qでも）ではTarget Scaleへ未到達

**三宅さんご指示§31の成功基準「Targetに到達すると採用が止まる」を、8Q・16Qいずれの実行でも実証できていない。** BALを16Qまで延長実行した結果:

```
turn8  headcount=72  currentSales=8,841t   （Target Scale min=20,520t）
turn16 headcount=144 currentSales=11,528t  （Target Scale min=20,520t、引き続き未到達）
```

16ターン・144人まで増員しても、実現販売量（現実的販売量、`realisticSalesAtHeadcount`）はTarget Scale帯のminにすら届いていない。営業採用は毎ターン、ガバナー上限（9人/期）いっぱいまで続いている。

### 3.1 原因（バグではなく、既存の営業capacity式の構造的な帰結）

これは実装のバグではなく、Test14 Turn1/Turn2の実データ分析（`TEST14_TURN1_VS_TURN2_SALES_CAPACITY_DECOMPOSITION.md`）で既に確認していた事実と整合する。現行の営業capacity式（Michaelis-Menten型飽和曲線、`processingCapacity(h) = baseline + increment × h/(h+saturationHeadcount)`）は、headcountが増えるほど1人あたりの追加容量が急激に逓減する。1市場あたりの半飽和点（`capacitySaturationHeadcount=10`）に対し、144人を5市場に配分しても1市場あたり平均約29人程度にしかならず、`h/(h+10)`は0.74程度までしか上がらない。Target Scale（実効生産能力ベース）に到達するには、この飽和曲線の性質上、非常に多くの追加人員が必要になる。

### 3.2 これは問題なのか

- **複利成長ではない**（線形、ガバナーにより速度は一定）ため、三宅さんご指示§22の最重要確認事項「18→27→41→62→93→140のような指数増加をしないこと」は満たしている。
- 各採用は実際にmarginal contributionが給与を上回る（`SALES_HIRING_NOT_ECONOMIC`で止まっていない＝経済的に正当）ため、「無意味な増員」ではない。
- ただし、Target Scaleに到達する前に他のゲート（生産余力・資金・Worker）が先に効くことを期待していたが、この8Q/16Qウィンドウでは生産余力ゲート（`SALES_HIRING_BLOCKED_BY_PRODUCTION`）も発火していない。BALの生産能力（20,520t/期）に対し、実現販売量（11,528t/期@144人）はまだ半分程度であり、生産余力にも十分な余裕が残っているためである。

### 3.3 今回あえて実施しなかった対応（チューニング保留）

三宅さんの前回ご指示「チューニングしすぎないでください。まず問題を報告してください」を踏襲し、以下はいずれも今回実施していない。

- 営業capacity式の飽和パラメータ自体の変更（#04領域、三宅さんご指示§32で変更禁止）。
- Target Scale Bandの算定方法を「実効生産能力ベース」から別の基準へ変更すること。
- ガバナーの上限を引き上げて到達を早めること。
- 追加の人為的な停止条件（例: 経過ターン数によるハードキャップ）の新設。

## 4. MASSの非採用: Target Scale情報を含めて再確認

前回報告と同じ結論（`SALES_HIRING_BLOCKED_BY_LIQUIDITY`が主因）に加え、Target Scale帯との関係も確認した。MASSは全8ターンで`SALES_CAPACITY_BELOW_TARGET_SCALE`（Target Scale帯のminを大きく下回る）と診断されており、**Target Scale側は「採用すべき」方向を一貫して示しているにもかかわらず、資金制約（liquidity gate）が優先してブロックしている**ことが確認できた。これは三宅さんご指示§17「Target Scale自体は維持しつつ、現時点では資金制約がprimary bottleneckと診断する」という設計方針どおりの挙動である。

## 5. 5社サマリ（8Q時点）

| 会社 | headcount(t1→t8) | hire合計 | Target Scale min到達 | 主なブロック要因 |
|---|---|---|---|---|
| BAL | 18→72 | 44人 | 未到達 | ガバナー上限（経済的には継続採用可） |
| JPQ | 14→42 | 28人 | 未到達（未計測） | turn6・7で採用停止（要因未追跡） |
| VAP | 14→42 | 21人 | 未到達（未計測） | turn6以降で採用停止（要因未追跡） |
| CONSV | 10→40 | 30人 | 未到達（未計測） | ガバナー上限で継続採用 |
| MASS | 22→22 | 0人 | 未到達 | 資金制約（liquidity gate） |

## 6. 次回セッションへの推奨

1. Target Scale未到達のまま増員が続くこと自体は「バグ」ではなく「営業capacity式の飽和が非常に強い」という既知の事実の帰結だが、三宅さんのご判断として、Target Scale到達を早める方向（Target Scale算定方法・ガバナー上限・営業capacity式のいずれを見直すか）を検討いただきたい。
2. JPQ・VAPのturn6・7採用停止理由の個別診断（前回報告からの継続課題）。
3. Target Scale Bandの粘着性は今回のセッション内で修正済みだが、より長期（32Q等）での挙動確認は未実施。
