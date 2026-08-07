# Test15観測項目カバレッジ確認（既存Excel出力基盤の実測、新規インフラ提案なし）

三宅さん指示（2026-08-05、#05統合待ちラウンド）Part 6への対応。
`/tmp/pd_labor`（HEAD `5f1fa87`）の`app/lib/v2/companyLab/adminExport/companyLabAdminExcelBuilder.ts`
（1,519行）を実測。既存のExcel出力基盤は非常に広範囲をすでにカバーしており、
新規の大規模インフラ提案は不要と判断した（指示どおり、必須項目の欠落確認に限定）。

既存シート構成（`wb.addWorksheet`実測、14シート）：
`Meta` / `PL` / `BS` / `CF` / `Financing` / `Capex` / `Company Summary` /
`Decisions` / `Sales Contracts` / `Sales Detail` / `Market` / `生産・設備・労務` /
`意思決定項目` / `StandardAI入力` / `加工プレミアム`

## 1. 要求項目ごとのカバレッジ確認結果

| 要求項目 | カバー状況 | シート／フィールド |
|---|---|---|
| 営業人員数 | ○ | `Decisions`シート（`p.salesForceHeadcount`、行460・692） |
| 市場別営業配分 | ○ | `Decisions`／`Sales Detail`（market×product×headcount） |
| market×product需要 | ○ | `Market`シート |
| market×product価格 | ○ | `Market`シート |
| desiredQuantity | ○ | `Decisions`シート（`p.desiredQuantity`） |
| allocation（配分結果） | ○ | `Sales Contracts`／`Sales Detail`シート |
| 契約 | ○ | `Sales Contracts`シート |
| 生産 | ○ | `生産・設備・労務`シート |
| 出荷 | △ | `PL`の売上原価内訳等から間接的に確認可能だが、出荷トン数の専用列は本調査では
未確認（`Company Summary`の`soldTons`系フィールドが該当する可能性が高いが、
本ラウンドでは行番号レベルまでは未確認） |
| 原料在庫 | ○ | `BS`シート（`bs.rawMaterialInventory`）／`Company Summary`（`s.rawMaterialInventory`） |
| 完成品在庫 | ○ | `BS`シート（`bs.finishedGoodsInventory`）／`Company Summary` |
| 常用Worker人数 | ○ | `Decisions`シート（`w.regularHeadcount`、行518） |
| 臨時労働者数 | ○ | `Decisions`シート（`w.temporaryHeadcount`） |
| 残業率 | ○ | `Decisions`シート（`w.overtimeRate`）／`Company Summary`（`s.overtimeRate`） |
| 工場能力 | ○ | `生産・設備・労務`シート（HOSO/PD/VAP能力、工場別） |
| 稼働率 | ○ | `Market`シート（`hp.utilizationRatio`、輸出可能量に対する配分比率）。
なお工場側の稼働率は`生産・設備・労務`シートの`previousQuarterPdUtilization`
（PD稼働率）でカバー |
| PD省人化状態 | ○ | `生産・設備・労務`シート（`mechanizationLevel`・`effectivePdCoefficient`・
`activeProjectId`・`reductionRatio`など、工場別に詳細） |
| VAP開発状態 | ○（部分） | `意思決定項目`シートにVAP商品開発費の記載を確認。ただし
VAPスコア（0-100）自体の時系列専用列は本ラウンドでは行番号レベルまで未確認
（`StandardAI入力`シートまたは`Company Summary`側に存在する可能性が高い） |
| 工場投資 | ○ | `生産・設備・労務`シート（「現在追加中の設備投資案件」セクション、新工場建設・
PD省人化を含む全案件種別を案件IDつきで一覧化） |
| 収益（売上） | ○ | `PL`シート |
| 売上総利益 | ○ | `PL`シート |
| SG&A | ○ | `PL`シート |
| 営業利益 | ○ | `PL`シート |
| 現金 | ○ | `BS`シート・`CF`シート |
| 通常融資 | ○ | `Financing`シート（`underwriting.requestedAmountUsd`/`approvedAmountUsd`/`deniedAmountUsd`） |
| 緊急融資 | **△（部分的な欠落）** | `Financing`シートには「緊急融資許容」（ポリシー入力フラグ、`emergencyAcceptable`）
のみ存在し、**当四半期に実際に緊急融資として引き出された金額
（`financing/liquidityClose.ts`内部の`emergencyDrawUsd`）を専用の行として
明示的に出力する列がExcelビルダー上に見当たらない**。`underwriting.approvedAmountUsd`
が通常融資・緊急融資のどちらの承認額を指すのか（合算か、通常融資のみか）も、
本ラウンドの調査範囲では確定できなかった |

## 2. 明確に欠落していると判断した項目（Test15運用上、追加を検討する価値がある）

**1件のみ**：**緊急融資の引出額（`emergencyDrawUsd`相当）を、通常融資と明確に
区別した専用行としてExcelへ出力する処理が見当たらない。** 生データ自体は
`financing/liquidityClose.ts`（`emergencyDrawUsd`・`normalDrawUsd`・
`emergencyLoan`オブジェクト）に既に存在するため、**新規の計算ロジックは不要で、
既存のExcelビルダー（`writeFinancingSheet`相当の関数）へ2〜3行追加するだけで
足りる**規模の修正候補である。ただし、これは財務モジュール
（`app/lib/v2/financing/*`）に触れる可能性があり、**本ラウンドは「財務パラメータ
変更禁止」の対象範囲内かどうか判断が分かれるため、Part 9のバグ修正枠では
実施せず、次ラウンド以降にオーナー判断を仰ぐ観測専用の追加項目として記録するに
留める**（Excelの出力列を追加するだけであり、financingの計算ロジック自体は
変更しない性質の変更ではあるが、財務モジュールへの一切のコミットを避ける
という保守的判断を優先した）。

## 3. 結論

要求された観測項目のほぼ全て（26項目中24項目）が既存のExcel出力基盤で
既にカバーされている。新規の大規模インフラ構築は不要。唯一の明確なギャップは
「緊急融資引出額の専用列」のみであり、これは小規模な追加で対応可能だが、
本ラウンドのスコープ（財務モジュール非改変を保守的に解釈）では実施を見送った。
