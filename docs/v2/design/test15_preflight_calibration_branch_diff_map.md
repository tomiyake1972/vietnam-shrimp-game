# test15-preflight-calibration ブランチ 固有差分マップ（読み取り専用分析）

三宅さん指示（2026-08-05、Test15統合の一時停止後のドキュメントのみラウンド）への対応。

**本ドキュメントは分析成果物のみである。マージ・リベース・コード変更は一切行っていない。
`/tmp/test15_integration`は読み取りのみで内容変更なし（本ラウンド終了時点でも
`1921298`のまま保全）。どのコミットを持ち越すべきかの推奨・判断は行わない。**

対象：`feature/v2-test15-preflight-calibration`（HEAD `1921298`）の、`pd_labor`との
共通祖先`c28caf0`からの固有6コミット。`git log`/`git diff`を実際に実行して確認した
（コミットタイトルからの推測ではない）。

## 0. 分岐構造

`git merge-base 5f1fa87 1921298` = `c28caf0`（`feature/v2-test15-investment-environment-integrated`
の最終コミットと一致）。この共通祖先から:
- `pd_labor`（`5f1fa87`）側は29コミット独自に進んだ（加工品市場進化本実装・PD価値ベース
  価格モデル設計等）。
- `test15_integration`（`1921298`）側は6コミット独自に進んだ（内容は以下）。

両ブランチは互いに他方の固有コミットを一切含まない（`git merge-base --is-ancestor`で
双方向とも偽であることを確認済み）。

## 1. 固有6コミットの内容（`git diff c28caf0..1921298`で全ファイルを実測確認）

変更ファイルは以下15件のみ。**`app/lib/v2/companyLab/standardAi/*`を含む生産本体コード
（`app/lib/v2`配下の非テストファイル）への変更はゼロ**（`git diff c28caf0..1921298 --stat -- app/lib/`
で本体コードの差分が存在しないことを確認済み。ヒットするのは全て`__tests__/`配下のみ）。

| コミット | ファイル | 種別 | 分類 |
|---|---|---|---|
| `a0b0a16` (Phase5) | `scripts/test15PdMechanizationPreflightCalibration.ts` (672行) | 分析スクリプト | analysis scripts |
| | `app/lib/v2/companyLab/__tests__/test15PdMechanizationPreflightCalibration.test.ts` (168行) | テスト | tests |
| | `docs/v2/reports/test15_pd_mechanization_preflight_calibration_report.md` (205行) | 報告書 | docs/calibration results |
| `1562fcc` (Phase6) | `scripts/test15NewFactoryConstructionPreflightCalibration.ts` (554行) | 分析スクリプト | analysis scripts |
| | `app/lib/v2/companyLab/__tests__/test15NewFactoryConstructionPreflightCalibration.test.ts` (118行) | テスト | tests |
| | `docs/v2/reports/test15_new_factory_construction_preflight_calibration_report.md` (293行) | 報告書 | docs/calibration results |
| `57fe528` (Phase7) | `scripts/test15VapProductDevelopmentPreflightCalibration.ts` (320行) | 分析スクリプト | analysis scripts |
| | `app/lib/v2/companyLab/__tests__/test15VapProductDevelopmentPreflightCalibration.test.ts` (101行) | テスト | tests |
| | `docs/v2/reports/test15_vap_product_development_preflight_calibration_report.md` (219行) | 報告書 | docs/calibration results |
| `4cdf3a1` (Phase8) | `scripts/test15StandardAiIntegratedAutoplay.ts` (278行) | 分析スクリプト | analysis scripts |
| | `app/lib/v2/companyLab/__tests__/test15StandardAiIntegratedAutoplay.test.ts` (63行) | テスト | tests |
| | `docs/v2/reports/test15_standard_ai_integrated_autoplay_report.md` (234行) | 報告書（**5社全社が16四半期以内に債務超過に陥るという重要な所見を含む**） | docs/calibration results |
| `00de1e3` (Phase9) | `docs/v2/reports/test15_preview_deploy_and_smoke_test_report.md` (165行) | 報告書（Vercel Preview・スモークテスト結果） | docs |
| `1921298` (Phase10) | `docs/v2/testplay/test15_preflight_calibration_report.md` (321行) | 統合報告書 | docs |
| | `docs/v2/testplay/test15_start_briefing.md` (97行) | Test15開始ブリーフィング | docs |

（`.gitignore`への5行追加が`a0b0a16`に含まれるが、内容確認の結果Test15スクリプト実行時の
一時出力除外設定のみで、production挙動には無関係）

## 2. Test15自体に必要な本番配線か、純粋な過去分析出力かの分離

**結論：この6コミットには production への配線は一切含まれない。全てが「分析・検証・
報告」の付加物であり、`app/lib`本体コードへの変更はゼロ件。**

- **本番配線として持ち越しが必要なもの**：**なし**。6コミットの`app/lib`配下の変更は
  全て`__tests__/`ディレクトリ内（＝検証用テストコードそのものであり、production
  ロジックではない）。
- **一回限りの検証出力で、そのまま残す必要性が薄いもの**：
  - `docs/v2/reports/test15_*_preflight_calibration_report.md`（4本、Phase5〜8）：
    特定時点・特定パラメータでの数値検証結果。ブランチ統合時点のコードや
    パラメータが変われば数値自体は再現しない可能性があり、**「その時点のスナップショット」
    としての参照価値**はあるが、Test15運用そのものには不要。
  - `docs/v2/reports/test15_preview_deploy_and_smoke_test_report.md`（Phase9）：
    push権限なしによりブロックされたという結果は、本ラウンドで再現された事象と
    完全に一致する（同一のgit proxy 403エラー）。**この報告書自体は歴史的記録として
    有用**だが、ブロック状況は今も変わっていないため、内容の更新なしに転用はできない。
- **再利用価値が高く、Test15運用の土台として持ち越す価値があるもの**（判断はオーナー
  に委ねるが、材料として明記）：
  - `scripts/test15*.ts`（4本、計1,824行）：新工場建設・PD省人化・VAP開発・標準AI
    統合オートプレイそれぞれのマッチドペア比較検証の**再実行可能な**スクリプト。
    本体コードとは独立して動くため、コンフリクトリスクは低い。
  - `app/lib/v2/companyLab/__tests__/test15*.test.ts`（4本）：上記スクリプトに
    対応する回帰テスト。
  - `docs/v2/testplay/test15_preflight_calibration_report.md`・
    `test15_start_briefing.md`（Phase10統合報告書＋開始ブリーフィング）：
    Test15を実際に開始する際の「人間プレイヤーが重点確認すべき事項」の優先順位リスト
    を含み、これは本ラウンドの`/tmp/test15_integration`調査でも確認した通り、
    今も有効な内容（原料供給の水位法配分の実体験確認、新工場建設×販売計画連動時の
    採算検証等）。
  - `test15_standard_ai_integrated_autoplay_report.md`（Phase8）に記録された所見
    ——**現行パラメータ下では標準AIが全5社を3seed全てで16四半期以内に債務超過・
    支払不能へ導き、常用ワーカー人数が全社・全seed・全四半期で6,300人固定（一度も
    採用・解雇なし）**——は、Standard AI自体を変更しないこの回のスコープ外ではあるが、
    Test15を実際に始める際に人間プレイヤー・オーナーが認識しておくべき重要な
    背景情報であるため、単なる「過去の一回限りの出力」に格納したままにせず、
    Test15開始判断の材料として扱うことを推奨する（ただし取り扱いの判断自体は
    オーナー・#05側に委ねる）。

## 3. まとめ表

| 分類 | 該当コミット/ファイル数 | production配線か | 持ち越し検討の要否（判断はオーナー） |
|---|---|---|---|
| 分析スクリプト | 4本（1,824行） | 否 | 再実行可能・独立性高、持ち越し価値あり |
| テスト | 4本（450行） | 否（テストのみ） | スクリプトとセットで検討 |
| Excel出力 | 該当ファイルなし（この6コミットには含まれず、`c28caf0`以前の`c88f8d2`/`81f91da`等ですでに`pd_labor`側にも存在） | — | — |
| 校正結果ドキュメント（Phase5〜8） | 4本 | 否 | スナップショットとして参照価値のみ、本体は不要 |
| Preview/スモークテスト結果 | 1本 | 否 | 状況不変のため内容更新なしの転用は不可 |
| 統合報告書・開始ブリーフィング | 2本 | 否 | Test15開始判断の実務資料として有用 |
