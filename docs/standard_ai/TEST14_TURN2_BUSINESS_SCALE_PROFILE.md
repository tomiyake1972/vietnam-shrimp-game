# Test14 Turn2 — Business Scale Profile（reconstructed case・38人・5軸）

2026-08-04 Cowork #05（AI設定）実施

**注記**: 実際のTest14保存状態へのアクセス手段がないため（本文書は再現データに基づくreconstructed caseである）、`baseline`/BAL/turn2の再現ケースに対し、Phase F-2で確立した手法（observationの`salesForceHeadcountTotal`フィールドだけを38へ上書きし、本番アルゴリズムをその場で再実行）で得た値を使用している。**実際のRedis保存状態を取得したものではない（reconstructed case）。** 期首現金・AR・既存借入・正社員数（6,000人）は再現ケースの値であり、実際のTest14（38人規模で運営されてきた会社）の値とは異なる。

## 1. 5軸プロファイル

| Axis | Supported scale (t) | Confidence | Constraint | Headroom（人間案15,236t比） | Expansion |
|---|---|---|---|---|---|
| Sales | 9,960.8 | MEDIUM | ADJUSTABLE_NEXT_PERIOD | **-5,275.2（不足）** | 営業人員追加採用（次期、需要側拡張余地は観測不能） |
| Production | 17,100.0 | HIGH | EXPANDABLE_WITH_CAPEX | +1,864.0（余裕） | 凍結・包装capex（binding constraint） |
| Labor | 27,576.3 | HIGH | ADJUSTABLE_NEXT_PERIOD | +12,340.3（大きく余裕） | 正社員追加採用（次期） |
| RawMaterial | **該当なし（null、下記§2参照）** | UNKNOWN | UNCERTAIN | 判定対象外 | 会社固有の追加購入可能上限が観測構造上不明のため拡張余地を診断できない |
| Finance | 15,151.3 | MEDIUM | EXPANDABLE_WITH_FINANCING | -84.7（ほぼ一致） | 追加借入（観測不能のため範囲不明） |

**2026-08-04修正（三宅さんの指摘を反映）**: RawMaterial軸は`securedRawScaleTons`（今すぐ確実に使える下限、本ケースでは0.0t）／`procurementNeededScaleTons`（他4軸の最小値まで届くために必要な追加調達量、本ケースでは9,960.8t）／`publicMarketAvailabilityState`（本ケースではSURPLUS）／`companyPurchasableScaleTons`（常にunknown=null）へ分解した。会社固有の購入可能上限が観測不能である以上、この軸の`supportedScaleTons`自体をnullとし、Business Scaleのbinding判定（下記§2のmin()相当の比較）から自動的に除外している。「分からない」を「0tしかできない」という数値で表現しないための修正であり、以前の版で報告していた「RawMaterial=0.0tが数値上のbinding axis」という記述は誤りだったため撤回する。

## 2. 現在のBinding Axis

**単一の最小値へは要約しない**という前提のもと、supportedScaleTonsが判定可能な4軸（Sales/Production/Labor/Finance。RawMaterialはcompanyPurchasableScaleTonsがunknownのため判定対象外）を並べて見ると次のことが言える。

- **Sales**（9,960.8t）は、人間案の販売規模（15,236t）に対して明確に不足している。これは38人の営業人員をShadow Allocation（volume-oriented）で最適配分した場合の上限であり、Phase F-2で確認したJP集中を解消しても届かない規模である。
- **RawMaterial**は今回の修正により判定対象外（null）である。今すぐ確実に使える原料の下限（securedRawScaleTons=0.0t）は、毎期の調達決定（国内買付・輸入・養殖）で原料を確保する運転資金型ビジネスモデルの性質を反映した値に過ぎず、会社の事業規模の上限を意味しない（詳細は`BUSINESS_SCALE_OBSERVATION_GAPS_AND_04_HANDOFF.md`）。
- **Production**（17,100t）・**Labor**（27,576t）・**Finance**（15,151t）はいずれも人間案の規模（15,236〜16,500t）と同等か、それを上回る。

**この5軸を見た場合の解釈**: 判定可能な4軸の中で最も厳しい実質的なbinding axisはSales（9,960.8t）である。これはPhase F-2/F-4で確認した「営業人員配分ロジックの問題」と「市場別絶対需要の観測不能性」の複合結果であり、単純な営業人員不足だけが原因とは言えない。

## 3. Salesを改善した場合の次のBottleneck

Salesが仮に人間案規模（15,236t）まで伸びた場合、次にbindingになるのはFinance（15,151.3t、目標最低現金バッファを割らない範囲での上限）である。ほぼ同水準（-84.7t）であるため、「営業を伸ばした直後に資金繰りが次の制約になる」という、Phase F-7のCash Bridge分析（人間案スケールでheadroom -$0.92M）と整合する結論が、Business Scale Profileの観点からも独立に得られた。Financeの次はProduction（17,100t）が僅かな余裕を残して控えている。

## 4. Sales-supported Scaleの値そのものについての留保

Sales軸の9,960.8tは、Phase F-2で計算したVolume-oriented Shadowの合計（同じ38人ケースで9,960.8t）をそのまま使用している。この値は営業人員の飽和特性（Michaelis-Menten型容量関数）だけに基づく上限であり、市場別の真の需要規模を反映していない。人間案の実績（15,236t）がこの上限を上回っているという事実は、(a) 現行の営業容量モデルが実際のゲームにおける達成可能量を過小評価している、(b) 人間案の判断がモデル上の制約を超える結果を生んでいる（ゲームルールの再現性の問題）、(c) 市場別の真の需要がこのモデルの想定より大きく、営業容量以外の経路（CTS・価格対応等）で達成された、のいずれかであり、本診断だけでは一意に判別できない。#04確認事項として記載する。
