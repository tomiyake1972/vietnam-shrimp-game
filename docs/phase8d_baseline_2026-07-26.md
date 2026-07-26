# Phase 8D-0 — 基準状態（旧仕様）の保存

作成日：2026年7月26日
対象フェーズ：Phase 8D「設備投資・工場スペース・Worker・能力表示の再設計」

Phase 8D で仕様を変更する前の状態を、比較用の基準として残すための文書です。
**実ゲーム（ラボ `test12`）は削除も初期化も再実行もしていません。**

---

## 1. 実ゲーム（旧仕様のテストプレイ）の所在

| 項目 | 値 |
|---|---|
| ラボID | `Test12` |
| プレイヤー会社 | `BAL`（バランス型水産） |
| 進行状況 | Turn 1（2015Q1）・Turn 2（2015Q2）が確定済み、Turn 3（2015Q3）は未提出 |
| 保存先 | Upstash Redis（ステージング接頭辞 `staging:v2:companyLab:Test12:*`） |
| 取得手段 | 管理者ZIPダウンロード画面（`/v2/company-lab/play/export/Test12?turn=<N>&companyId=BAL`） |
| 取得済みデータ | `Test12_BAL_turn1_export.zip` / `Test12_BAL_turn2_export (1).zip`（共有フォルダに保管済み） |

**Phase 8D では、このラボに対する破壊的操作（初期化・再実行・スキーマ変更）を一切行っていません。**
旧仕様の比較対象として、そのまま残します。

Turn 1・Turn 2 の確定値（PL/BS/CF・市場価格・設備案件・Worker人数・生産能力・在庫）は、
上記 ZIP（JSON 4本＋ゲーム自動生成 Excel 2本）に完全な形で保存済みであり、
Phase 8D の変更後もそのまま読み出せます（後方互換性は §3 の方法で確保）。

---

## 2. 再現可能な基準シミュレーション

実ゲームは1つしかなく、繰り返し比較に使えません。そこで「同じ入力なら同じ結果になる」
という決定論性そのものを、テストとして固定しました。

### 構成（これが基準状態を再生成するための唯一の情報）

```
scenarioId : baseline
mode       : canonical
seed       : phase8d-baseline
turns      : 32
意思決定    : 全5社とも generateAutoPolicyDecision（決定論的ルールベース自動方針）
```

### 再生成コマンド

```bash
npx tsx --test app/lib/v2/companyLab/__tests__/phase8dBaseline.test.ts
```

### 固定した性質（`phase8dBaseline.test.ts`）

1. 32四半期を完走し、5社ぶんの会社サマリー・財務結果が全ターンそろう
2. 同じ seed で2回実行した結果が完全に一致する（決定論性）
3. 確定履歴のあらゆる数値に `NaN` / `Infinity` が発生しない
4. **自動方針は設備投資を一切提案しない**（`buildCapexDecision` が常に空を返す）
5. 生産配分量・未処理量・稼働率に不正な負値が発生しない

### 4番が重要な理由

Phase 8D では投資案件テンプレート（`capex/parameters.ts`）を変更します。
自動方針が投資を一切提案しないことをテストで固定しておけば、
**テンプレート変更がこの32四半期シミュレーションの結果を変え得ない**ことが構造的に保証され、
「エンジンのふるまいを壊していない」ことを同じ数値で確認し続けられます。

### 期待値を直書きしていない理由

期待値をテスト内で独自計算すると、エンジンの誤りをテストが追認してしまいます。
数値そのものの妥当性は各モジュールの既存テストが担い、この基準テストは
「性質（決定論性・完走・不正値なし）」だけを固定します。

---

## 3. 既存保存データとの後方互換性

Phase 8D で永続化スキーマへ追加したフィールドは、いずれも**キーの有無で判定し、
存在しなければ安全な既定値で復元**します（旧データのマイグレーション処理は不要）。

| 追加フィールド | 旧データを読んだときの既定値 |
|---|---|
| `workforceState`（Worker総人数） | 各社の `fixture.workerBaseline.regularHeadcount` から再構成 |
| `Factory.totalFactorySpaceUnits`（工場スペース総量） | 基礎能力と係数から決定論的に導出 |
| `Factory.coldStorageCapacity`（冷凍保管能力） | 同上（凍結・包装処理能力を基準に導出） |

`CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION` は 1 → 2 へ上げましたが、
上位バージョンのみを拒否する検証（`validateCompanyLabPersistedState`）のため、
**`schemaVersion: 1` の既存データはそのまま読み込めます。**
この点は `phase8dPersistence.test.ts` の「旧schemaの保存データを読み込める」テストで固定しています。
