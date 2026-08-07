# 既存ManagementProfile / OrientationProfile監査

2026-08-04 Cowork #05（AI設定）実施

**注記**: 本文書はコードの読み取りのみであり、いずれの数値も変更していない。

## 1. ManagementProfile（経営性格、`managementProfile.ts`）

| Company | Profile | Growth bias | Liquidity/leverage bias | 特記 |
|---|---|---|---|---|
| BAL | balanced | 0（基準） | 0（基準） | ゼロプロファイル。他4社の差分基準。 |
| MASS | growth | 販売積極性+5%・値引き許容+5%・輸入依存+5%・採用ペース+5% | （安全ガードは対象外、変更なし） | 能力を積極的に売り切る、量とシェアを優先。 |
| JPQ | opportunistic | 販売積極性+3%・在庫是正反応+8% | （同上） | 市場変化への反応速度重視。既存の閾値・ヒステリシスは変更していない。 |
| VAP | valueAdded | PD/VAP受注量係数+0.05・PD/VAP capex前倒し+0.05 | 養殖自給+5% | 高付加価値重視。 |
| CONSV | conservative | 販売積極性-3%・値引き許容-5%・輸入依存-5%・在庫是正-5%・採用ペース-5% | 養殖自給-5% | 利益率・資金繰りの安定重視。CFO視点。 |

いずれの比率も`MAX_BIAS_RATIO`（±10%）以内、安全ガード（現金バッファ・借入健全性しきい値等）は5社完全同一。

## 2. OrientationProfile（市場・商品志向、`orientationProfile.ts`）

| Company | Profile ID | Market orientation | Product orientation | growthTrendResponsiveness | oversupplyRetreatSensitivity |
|---|---|---|---|---|---|
| BAL | balancedGeneralist | 全市場1.0（中立） | 全商品1.0（中立） | 0.5 | 0.5 |
| MASS | chinaVolume | CN1.25／US0.85／EU0.85／JP0.8／OTHER1.1 | HOSO1.2／PD0.95／VAP0.85 | 0.3 | 0.4 |
| JPQ | japanQuality | CN0.8／US0.8／EU0.9／**JP1.25**／OTHER0.9 | HOSO0.85／PD0.95／**VAP1.2** | 0.7 | 0.6 |
| VAP | usProcessedGrowth | CN0.85／**US1.25**／EU1.0／JP0.95／OTHER0.95 | HOSO0.85／**PD1.2**／VAP1.1 | 0.9 | 0.2 |
| CONSV | europePdConservative | CN0.95／US1.0／**EU1.25**／JP0.85／OTHER0.95 | HOSO0.95／**PD1.15**／VAP1.05 | 0.2 | 0.9 |

いずれの倍率も市場0.80〜1.25／商品0.85〜1.20の許容範囲内。会社IDによる分岐は`COMPANY_ORIENTATION_BY_COMPANY_ID`の1箇所のみ。

## 3. 5社をMission/Vision付きの企業像として解釈した場合の案

これは既存Profile値からの**解釈の提案**であり、まだMission/Visionをコードへ与えていない。

- **BAL（balanced × balancedGeneralist）**: 「特定の市場・商品へ過度に依存せず、バランスの取れた成長を志向する会社」。Standard企業のMission/Vision案（ベトナム社会・世界経済への貢献、5-7年で規模倍増）と最も自然に対応する会社像であり、今回のMission/Vision設計のベースラインとして扱うのが妥当。
- **MASS（growth × chinaVolume）**: 「中国市場での量的シェア獲得を通じて事業規模拡大を目指す会社」。Mission的には「エビ消費拡大への貢献」を量的規模で追求するタイプと解釈できるが、Vision的な収益性目標（税引後利益80M）との整合は、財務体質面の懸念（本ラウンドのTest14分析・5社回帰で確認した継続的なBELOW_TARGET_BUFFER）から緊張関係がありうる。
- **JPQ（opportunistic × japanQuality）**: 「日本市場でのVAP品質重視の先行者優位を狙い、市場変化には素早く反応する会社」。Mission的には「消費国の人々に食べやすい形で提供する」というVAP重視の付加価値化路線と最も直接的に整合する。
- **VAP（valueAdded × usProcessedGrowth）**: 「米国市場でのPD/VAP成長を、積極的な設備投資で先取りする会社」。Growth Vision（規模倍増）とValue-added Missionの両方に強く整合する会社像。
- **CONSV（conservative × europePdConservative）**: 「欧州市場を主力に、PD中心の安定した事業運営を志向する会社」。Missionの「ベトナム社会・世界経済への貢献」は共有しつつ、Vision（5-7年で規模倍増）についてはより保守的なペース（達成帯の7年ライン寄り）を志向する会社像として整合的。

## 4. 今回変更していない事項の確認

`MANAGEMENT_PROFILES`・`COMPANY_ORIENTATION_PROFILES`・`MANAGEMENT_PROFILE_BY_COMPANY_ID`・`COMPANY_ORIENTATION_BY_COMPANY_ID`のいずれの値も本ラウンドで変更していない（`git diff`で該当ファイルへの変更が無いことを確認済み）。
