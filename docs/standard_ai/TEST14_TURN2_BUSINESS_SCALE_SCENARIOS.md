# Test14 Turn2 — Conservative / Base / Growth Scenario 仮適用（診断専用）

2026-08-04 Cowork #05（AI設定）実施

**注記**: Test14 Turn2 reconstructed case（38人、`TEST14_TURN2_BUSINESS_SCALE_PROFILE.md`と同じ再現データ）への仮分析。具体的な数値を人間案へ合わせる調整は一切行っていない。Growth Scenarioの増分（営業+20%・正社員+10%）は暫定的なイラストレーションであり、Mission/Vision確定後に再設計する前提である。

## 1. 3Scenario一覧

| 項目 | Conservative | Base | Growth（暫定） |
|---|---|---|---|
| Sales scale (t) | 9,960.8 | 9,960.8 | 10,912.3 |
| Production scale (t) | 17,100.0 | 17,100.0 | 17,100.0 |
| Sales headcount | 38（現状） | 38（現状） | 46（+20%、暫定） |
| Labor need（正社員数） | 6,000（現状） | 6,000（現状） | 6,600（+10%、暫定） |
| Raw need (t) | supportedScaleTons=null（会社固有調達余地はunknownのため判定対象外、下記§3参照） | 同左 | 同左（原料軸自体は今回拡張していない） |
| Cash need（target buffer内で支えられる規模, t） | 15,151.3 | 15,151.3 | 14,943.3（労務コスト増でわずかに悪化） |
| Borrowing need/unknown | unknown（未配線） | unknown | unknown |
| Capex requirement | 不要（Production 17,100t > 各Scenarioのbinding以外の軸） | 不要 | 不要（Sales/Labor増だけで、Production/Financeのいずれもまだbindingにならない） |
| Main risk | Salesが人間案規模に届かない（binding axis）。RawMaterialは判定対象外のため制約として数値化されていない点に留意（下記§3参照） | 同左 | 採用増だけでは資金の制約は解消しない。RawMaterial軸は依然unknownのまま |

Conservative/Baseの数値が一致しているのは、本実装のBusiness Scale Profile自体が、Sales軸に「現有人員の最適再配分（Volume-oriented Shadow）」を既に組み込んでいるためである（`BUSINESS_SCALE_PROFILE_DESIGN_AND_IMPLEMENTATION.md`§3参照）。したがって両Scenarioの違いは「この上限まで実際に踏み込むという前提を明示するかどうか」のみであり、数値としての差は今回生じていない。

## 2. 人間案（Sales≈15,236t・Production≈16,000〜17,000t・Worker≈5,000・国内原料≈14,300t・輸入0・養殖≈500t・営業採用+10・借入0・capex検討中）との比較

**どのScenarioに近いか**: 人間案の販売規模（15,236t）は、Conservative/Base（9,960.8t）・Growth（10,912.3t）のいずれも上回っている。Business Scale ProfileのSales軸だけで見れば、人間案は本診断の3Scenarioのいずれよりも積極的（Growthのさらに先）である。一方、生産規模（16,000〜17,000t）はProduction軸の上限（17,100t）とほぼ一致し、Finance軸（15,151.3t）にも近い。つまり**人間案は、Salesについては本診断のGrowth Scenarioを上回る規模を実現しつつ、Production・Financeについては本診断のBase/Growthとほぼ同水域に収まっている**という、軸ごとに異なる位置関係にある。

**人間案が積極的に解消しようとしている制約**: 営業採用+10人（38→48人相当）は、本診断のGrowth Scenarioの営業採用想定（38→46人、+20%）とほぼ同規模であり、人間案も「営業人員のADJUSTABLE_NEXT_PERIOD制約を穏やかに緩める」という同じレバーを選んでいる。共通前処理・凍結包装capexの検討も、本診断のProduction軸のbinding constraint（凍結包装、17,100t）が人間案の生産規模（16,000〜17,000t）に対してほぼ余裕を使い切っていることと整合し、人間案は正しくこの制約を認識して次の一手として検討していると解釈できる。

**人間案が軽く見ている可能性のあるリスク**: 本診断のFinance軸（target buffer内で支えられる規模=15,151.3t）は、人間案の販売規模（15,236t）とほぼ同水準（差-84.7t）であり、`TEST14_TURN2_HUMAN_PLAN_CASH_BRIDGE.md`で報告した「Capex抜きでも既に-$0.92Mの目標バッファ不足」という結論と一致する。人間案がこの規模でcapexを実施すればさらに厳しくなることも、この診断から独立に再確認できる。

**AI側の現在のGame RuleとPlayer側の現実認識の差**: 本診断のSales軸（9,960.8t、Volume-oriented Shadowの上限）は、人間案の販売規模（15,236t）に遠く届かない。これは`TEST14_TURN2_RECONSTRUCTED_CASE_38_HEADCOUNT_SHADOW_ANALYSIS.md`で既報のとおり、現行の営業容量モデル（Michaelis-Menten型飽和カーブ）が想定する上限を、実際のプレイでは何らかの経路で超えている可能性を示す。この差は、営業容量モデルの校正不足（#04確認事項）である可能性と、市場別の真の需要規模がこのモデルの前提より大きい可能性の両方があり、本診断単独では判別できない。

## 3. RawMaterial軸に関する重要な留保（2026-08-04修正）

**修正内容**: 以前の版では、RawMaterial軸の`supportedScaleTons`を「期首在庫＋当期確実な入荷」（securedRawScaleTons）＝0.0tとして直接扱っていたが、三宅さんの指摘（「分からない」と「0tしかできない」は全く違う）を受けて修正した。現在は、会社固有の国内追加購入可能上限（companyPurchasableScaleTons）が観測構造上恒常的にunknownである以上、RawMaterial軸の`supportedScaleTons`自体をnullとし、Business Scaleのbinding判定（3Scenario比較の対象）から自動的に除外している。securedRawScaleTons（=0.0t、今すぐ確実に使える下限）とprocurementNeededScaleTons（=他4軸の最小値まで届くために必要な追加調達量、本ケースでは約9,960.8t）、publicMarketAvailabilityState（本ケースではSURPLUS）は、参考情報として別途保持している。

**Scenario比較への影響**: RawMaterial軸を数値上の変数として動かしていない点（Conservative/Base/Growthともnullのまま）は変わらない。これは意図的な設計判断で、会社固有の国内購入可能上限が観測不能なため、Growth Scenarioで「原料調達も拡大する」という前提を憶測で置かなかったことによる。したがって本Scenario比較は、**原料調達の会社固有上限は不明という前提のもとでの、Sales/Labor/Production/Finance側の比較**として読むべきであり、RawMaterial軸自体の「Growthでどこまで拡張できるか」は今回未評価である（`BUSINESS_SCALE_OBSERVATION_GAPS_AND_04_HANDOFF.md`の#04確認事項）。
