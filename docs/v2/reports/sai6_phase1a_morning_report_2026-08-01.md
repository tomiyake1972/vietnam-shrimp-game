# SAI-6 Phase 1A 朝の報告（2026-08-01）

ブランチ: `feature/v2-sai6-standard-ai-capability`（`develop/v2`・`main`へは未マージ・変更なし）

## 1. 破綻連鎖の因果監査結果

「借入余力があるのに必要額を借りず、現金制約で原料調達が縮小し、生産不能・売上減少・
paymentDefaultへ連鎖している」という仮説を、`control`設定・4 seed×5社の20破綻ケースについて、
最初のpaymentDefaultの3四半期前〜default発生四半期の窓で検証した。

- **20ケース中5件（25%）でA類型（仮説どおりの連鎖）を確認**（sai5-ab-001/BAL・JPQ・VAP、
  sai5-ab-002/MASS、sai5-ab-004/VAP。破綻四半期は12〜24Q目に分布）
- 残り15件は6〜10Q目の早期破綻で、窓に入った時点ですでに借入余力自体が小さく
  （平均0.15M〜7.6M程度）、借入判断の是正では解決しない領域（D類型）
- B類型（借入では解決できない構造的赤字）・C類型（タイミングのズレ）は0件
- 仮説確認条件(a)借入余力残存・(b)必要額未満の借入・(c)調達縮小の継続・(d)A類型の存在は
  いずれも確認できた

詳細: `docs/v2/reports/sai6_phase1a_causal_audit_and_ab_report.md` §1、
`artifacts/sai6/phase1a/{classifications.json, window.csv}`

## 2. Phase 1A 実装判断

**実装した**（見送りではない）。条件(a)〜(d)がすべて満たされたため、資金見通しに基づく
必要借入の是正をWork item 2として実装した。ただし効果はA/B実測で僅少だった（§4参照）ため、
**フラグは既定OFFのまま据え置いている**（強制的な調整はしていない）。

## 3. 設計概要

```
[旧式・既定]  desiredAmountUsd = max(0, targetMinimumCashUsd - cashUsd)

[新式・fundingOutlookEnabled=true のときのみ]
reliableCashInflowsUsd  = 当期決済期到来の売掛金（確定額）
plannedCashOutflowsUsd  = 当期決済期到来の買掛金 + 既存借入の当期約定利息・元本
                        + 当期自身の調達・労務決定に基づく現金支出見積り
                        + fixture由来の販管費固定費
projectedEndingCashBeforeNewBorrowingUsd = cashUsd + reliableCashInflowsUsd - plannedCashOutflowsUsd
desiredAmountUsd = max(0, targetMinimumCashUsd - projectedEndingCashBeforeNewBorrowingUsd)
```

将来の市場結果・当期の乱数は一切参照しない。借入余力上限は既存の銀行審査
（`bankUnderwriting.ts`）がそのまま適用（重複実装なし）。意思決定順序（12段への再構成）は
変更していない（procurement/labor判断はfinance判断より前にすでに確定しており、順序変更は不要だった）。
`reconcileFundingPlan`（借入余力超過時の計画縮小）はPhase 1Bとして未実装のまま。

新規フラグ: `StandardAiParameters.fundingOutlookEnabled`（既定false）。
`AutoplayCaseConfig.fundingOutlookEnabled`（A/B比較用、他のSAI-5/6オプションと独立）。

## 4. 8Q/32Q A/B主要結果

Phase 1A単独ON/OFF（労務・価格等は変更していない）。

| 指標 | 8Q off | 8Q on | 32Q off | 32Q on |
|---|---:|---:|---:|---:|
| 破綻会社ケース | 9/20 | 9/20 | 20/20 | 20/20 |
| 生存期間の平均借入実行額/Q | 2.679M | 2.679M | 4.691M | 4.689M |
| 平均調達スケール比 | 0.3665 | 0.3665 | 0.4714 | 0.4713 |
| 平均原料不足（t/Q） | 9105.2 | 9105.2 | 7067.1 | 7070.1 |
| 平均営業利益（USD/Q） | 1.072M | 1.072M | 0.905M | 0.903M |

seed6個（追加2seed含む）32Qでも同様に差はほぼなし。全項目は
`artifacts/sai6/phase1a/ab_study.{json,md}`。

## 5. 原料制約・破綻・借入・利息への影響

**ほぼ影響なし**。破綻率・生存期間・調達スケール比・原料不足量・生産量・営業利益・
支払利息のいずれもON/OFFで実質同値だった。理由:

1. 原料制約（7,259 t/Q）が支配的すぎ、資金調達側の是正だけでは動かない
2. 早期破綻ケース（20件中15件）は借入余力自体がすでに枯渇しており対象外
3. `procurement.ts`自身の`cashPressure`ベースの自己抑制（finance判断より前に確定）が
   Phase 1Aの是正と独立に効いており、finance側だけを直しても調達数量の自己抑制は変わらない

## 6. 副作用・未解決の問題

- **重要な副次的発見**: `scripts/sai6Phase0Study.ts`の資金枠余裕・借入余力超過統計
  （Phase 0-5報告書の"0/208"）が**符号規約の誤り**により実態を反映していない疑いを発見した。
  `operatingDirect`の支出項目は負値で保持されるが、同スクリプトの資金枠余裕計算式は
  正の金額として引き算しており、実質的に加算になっていた（試しに符号を補正すると今度は
  逆に640/640件が超過と出るが、これは当期の売上入金を考慮していないための別の欠陥で、
  どちらも信頼できる指標ではない）。今回の因果監査・Phase 1A実装は独立に正しい符号で
  計算しており影響を受けていないが、**`sai6Phase0Study.ts`自体の修正・再計測は未実施**
  （`docs/v2/reports/sai6_phase0_measurement_report.md`に訂正の追記のみ行った）。
- `procurement.ts`の`cashConstrainedProcurementDampingAtSeverePressure`自己抑制と
  finance側の資金見通しの関係が未整理（Phase 1C以降で扱うべき論点）
- 早期破綻（6〜10Q目）ケースの根本原因は初期資本構成にある可能性が高く、Phase 1A/1Bの対象外
- Phase 0-5の推奨初期閾値（15%/3Q/15%/1Q）はPhase 1D本体実装後に別途検証が必要（未検証のまま）

## 7. 追加・変更したテスト

`app/lib/v2/companyLab/standardAi/decision/__tests__/financeFundingOutlook.test.ts`（10件、新規）:
現金不足時の借入増額・回収見込みの反映・不足額ちょうどの算出・借入余力上限の遵守・
資金十分時の判断不変・将来売掛金の除外・二重計上防止・フラグOFF時のビット単位一致（6Q回帰含む）・
JSON往復後の一致・完全な決定論性。いずれも結果レベル（借入額・現金・調達数量）まで検証。

リグレッション注入5件（すべて対応テストの失敗を確認、注入コードは元へ戻しコミットしていない）:
回収見込みを0に固定／回収を二重計上／借入余力クランプ除去／必要借入を常に0に固定／
将来の売掛金を入金に含める。

## 8. すべての検証結果

- 対象テスト: 10/10合格
- `npm test`: 1985/1985合格（既存1975件＋新規10件、退行なし）
- `npx tsc --noEmit`: エラーなし
- `npm run lint`: エラーなし（既存の無関係な警告4件のみ、新規警告なし）
- `npm run build`: 成功
- 同一seed再現性: 確認（決定論的テストで合格）
- フラグOFF時の完全互換性: 確認（既存決定と`deepEqual`、6Q回帰再実行でも一致）
- 8Q/32Q A/B: 実施（§4）
- CSV品質チェック（`window.csv`）: NaN/Infinity/欠損値/重複キー、いずれも0件

## 9. 作成・更新した成果物

- `scripts/sai6Phase1ACausalAudit.ts`（新規、因果監査）
- `scripts/sai6Phase1AAbStudy.ts`（新規、A/B実測）
- `app/lib/v2/companyLab/standardAi/decision/__tests__/financeFundingOutlook.test.ts`（新規）
- `docs/v2/reports/sai6_phase1a_causal_audit_and_ab_report.md`（新規）
- `docs/v2/reports/sai6_phase1a_morning_report_2026-08-01.md`（本ファイル、新規）
- `docs/v2/reports/sai6_phase0_measurement_report.md`（符号バグの訂正追記）
- `docs/v2/design/sai6_standard_ai_capability_design.md`（Phase 1A〜1Gへ分割、§2.2式を更新）
- `app/lib/v2/companyLab/standardAi/decision/finance.ts`／`policy.ts`／`parameters.ts`／
  `reasonCodes.ts`／`autoplay/runCase.ts`（Phase 1A実装）
- `artifacts/sai6/phase1a/`（Git管理外の生データ: causal audit・A/B）

## 10. コミット・push状況

| コミット | 内容 |
|---|---|
| `2876f6e` | 因果監査スクリプト・Phase 0-5報告書の符号バグ訂正追記 |
| `c117519` | Phase 1A実装・テスト・A/B実測・設計書更新 |

`origin/feature/v2-sai6-standard-ai-capability`へpush済み。作業ツリーはクリーン。

## 11. develop/v2・mainの確認

- `develop/v2`: `f6b4e45`のまま変更なし
- `main`: `3ae9485`のまま変更なし

---

労務調整・価格戦略・`pendingHires`・設備休止・次のSAIフェーズへは着手していない
（ご指示どおり、時間に余裕があっても本Phase 1Aの範囲にとどめた）。
