# パラメータ仕様

最終更新: 2026-07-15
関連: `docs/finance_spec.md`（計算式の詳細）, `docs/system_architecture.md`（Redis保存構造）

凡例：**〔main〕**=`main`ブランチに存在、**〔engine〕**=`claude/turn-processing-engine`ブランチのみに存在（未マージ）。

## 1. 会社基本情報〔main〕

出典: `app/lib/gameData.ts`の`CompanyProfile`/`COMPANIES`

| パラメータ | 型 | 単位 | 初期値（A/B/C/D/E） | 保存場所 | 画面表示 |
|---|---|---|---|---|---|
| `id` | `"A"\|"B"\|"C"\|"D"\|"E"` | - | 固定 | `gameData.ts`（コード定数、Redis非保存） | 全画面 |
| `name` | string | - | 社A/社B/社C/社D/社E | 同上 | 全画面 |
| `fullName` | string | - | Mekong Leader / Delta Processor / Premium Fresh / Pacific Volume / Rising Star | 同上 | 全画面 |
| `color` | string | - | blue/green/purple/orange/red | 同上 | UIの配色キーとしてのみ使用 |

**要確認（データ重複）**：会社の初期財務値（`cash`〜`processingCapacity`）は`app/lib/gameData.ts`の`COMPANIES`と、`app/api/game/route.ts`の`initialStates`の**2箇所に別々にハードコードされている**。現状は完全に一致した値だが、片方だけを編集すると値がずれるリスクがある構造。単一の情報源（`COMPANIES`を`initialStates`の代わりに参照する等）への統合は未実施。

## 2. 工場・生産能力〔main〕

出典: `app/lib/gameData.ts`

| パラメータ | 型 | 単位 | 初期値(A〜E) | 上限/下限 | 更新タイミング | 保存場所 |
|---|---|---|---|---|---|---|
| `farmingArea` | number | ha（推定、コード上明記なし） | 1800/1200/800/2200/700 | なし（コードに変更ロジックなし） | 変更されない（作成時のまま） | `game:{code}:company:{id}`（`CompanyState`） |
| `processingCapacity` | number | t/Q（画面表示ラベルより） | 8000/5000/3500/9000/3000 | なし（同上） | 変更されない | 同上 |

- 「工場新設・拡張」（フェーズ1の意思決定）を申請しても、`farmingArea`・`processingCapacity`が変化する処理は**未実装**（`docs/game_manual.md`参照）。

## 3. Worker（ワーカー）

コード全文検索の結果、`worker`/`ワーカー`に該当する実装は**一切存在しない**。パラメータ・型・UIいずれにも登場しない。**未実装**。

## 4. 製品区分〔engine〕

出典: `app/lib/gameEngine.ts`

| パラメータ | 型 | 単位 | 値 | 備考 |
|---|---|---|---|---|
| バルク変換比率 | 定数 | 原料トン/製品トン | 1.3（`BULK_RAW_PER_PRODUCT_TON`） | UIの説明文言（フェーズ4）と一致 |
| VAP変換比率 | 定数 | 原料トン/製品トン | 2.5（`VAP_RAW_PER_PRODUCT_TON`） | 同上 |
| VAP比率 | 入力値 | % | 意思決定`phase4_vap_ratio`、0〜100にクランプ、未提出時デフォルト30 | フェーズ4フォーム |

「製品区分」として明示的な列挙型（enum）は存在せず、市場キー文字列（例：`"EU（バルク）"`）に含まれる`"VAP"`の有無で判定している（`market.includes("VAP")`、`gameEngine.ts`）。**設計上の脆弱性（要確認）**：市場名の文字列を変更すると判定ロジックが壊れる。

## 5. 原料調達〔main / engine〕

| パラメータ | 型 | 単位 | 初期値・デフォルト | 上限/下限 | 保存場所 | 関係する計算式 |
|---|---|---|---|---|---|---|
| `phase2_farming`（養殖投入量） | string(数値) | トン（生体重） | 未提出時: `farmingArea×3` | 上限`farmingArea×5`（engine側でクランプ、UI側は非強制） | `game:{code}:decisions:{Y}Q{Q}:{id}`の`phases` | `finance_spec.md` §2 |
| `phase3_procurement`（外部調達量） | string(数値) | トン | 未提出時: 0 | UI表示は「0〜3000t」だが**コード上の強制なし** | 同上 | `finance_spec.md` §3 |
| `phase3_source`（調達先） | `"spot"\|"contract"\|""` | - | 未指定は`spot`扱い | - | 同上 | 単価: spot $2.3/kg, contract $1.9/kg（`PROCUREMENT_PRICE_PER_KG`, engine） |

## 6. 販売価格・市場配分〔engine〕

出典: `app/lib/gameEngine.ts`の`MARKET_PRICE_PER_KG`

| 市場キー | 製品区分 | 単価($/kg) | 意思決定キー |
|---|---|---|---|
| `EU（バルク）` | バルク | 3.8 | `phase5_EU（バルク）` |
| `日本（VAP）` | VAP | 8.5 | `phase5_日本（VAP）` |
| `米国（バルク）` | バルク | 3.6 | `phase5_米国（バルク）` |
| `国内（スポット）` | バルク | 3.2 | `phase5_国内（スポット）` |

- 価格は固定値であり、四半期・ゲームによって変動しない（市場変動イベント等は`docs/event_spec.md`のとおり未実装）。
- 「価格」自体をプレイヤーが指定する仕組みはない（フェーズ5フォームは数量のみ入力可能）。`gameData.ts`のフェーズ5説明文「販売先・価格・数量の決定」という記述と、実際のUI（数量のみ入力）は**一致していない（コードとの不一致・要確認）**。

## 7. 品質

コード全文検索の結果、`quality`/`品質`に該当する実装は**一切存在しない**。未実装。

## 8. 営業力

コード全文検索の結果、`営業力`に該当する実装は**一切存在しない**。未実装。

## 9. CTS-D / CTS-Q / QRP

コード全文検索の結果、`CTS`/`QRP`に該当する実装は**一切存在しない**。これらの用語自体がコード・コメント・UI文言のどこにも出現しない。未実装（用語の定義自体が本リポジトリには存在しないため、意味の推測も行わない）。

## 10. 借入〔engine〕

| パラメータ | 型 | 単位 | デフォルト | 上限/下限 | 保存場所 | 計算式 |
|---|---|---|---|---|---|---|
| `phase6_borrow`（短期借入） | string(数値) | $M | 0 | なし（コード上の上限チェックなし） | `decisions`の`phases` | `finance_spec.md` §9-10 |
| `phase6_repay`（長期借入返済） | string(数値) | $M | 0 | `min(希望額, max(debtBefore,0))`でクランプ | 同上 | 同上 |
| `phase6_equity`（増資申請） | `""\|"swf"\|"sogo"\|"asia"` | - | 申請なし | 選択肢による金額差なし（`finance_spec.md` §9参照） | 同上 | 同上 |

- **未実装**：借入枠（上限）、金利条件の会社ごとの差異、担保・格付けによる制限。

## 11. 現金〔engine〕

| パラメータ | 型 | 単位 | 初期値(A〜E) | 更新式 | 保存場所 |
|---|---|---|---|---|---|
| `cash` | number | $M | 20/20/6/15/5 | `finance_spec.md` §10 | `game:{code}:company:{id}` |

画面上、`cash < 8`の場合に赤字ハイライト表示される（`CompanyDashboard.tsx`の`Row`コンポーネント、`highlight`条件）。この閾値`8`の根拠はコード上に説明なし（**要確認**：デザイン上の目安値と推測されるが確定情報ではない）。

## 12. P&L〔engine〕

`docs/finance_spec.md` §6〜8, §12参照。保持されるのは`revenue`, `cogs`, `processingCost`, `interestExpense`, `overhead`, `netIncome`のみ。正式なP&L様式は未実装。

## 13. BS〔main（初期値）／engine（更新）〕

| パラメータ | 型 | 単位 | 初期値(A/B/C/D/E) | 更新式 |
|---|---|---|---|---|
| `totalAssets` | number | $M | 270/155/114/270/105 | `finance_spec.md` §10 |
| `equity` | number | $M | 100/45/40/90/25 | 同上 |
| `debtEquityRatio` | number | 倍(x) | 1.3/2.4/1.75/2.0/2.8 | 同上（`debt/equity`、equity≤0時は99固定） |
| 負債（画面表示のみ、フィールドとしては非保持） | number | $M | `totalAssets-equity`で算出 | `CompanyDashboard.tsx`で都度計算（保存されるフィールドではない） |

D/E比率が2.5を超えると画面上で黄色ハイライト表示される（`CompanyDashboard.tsx`）。この閾値もコード上に説明なし（**要確認**）。

## 14. CF

独立したキャッシュフロー計算書（営業/投資/財務CF区分）は**未実装**。`cash`の増減自体は`finance_spec.md` §10の式で一括計算される。

## 15. 信用スコア〔main（初期値）／engine（更新）〕

| パラメータ | 型 | 単位 | 初期値(A/B/C/D/E) | 上限/下限 | 更新式 |
|---|---|---|---|---|---|
| `creditScore` | number | 点（0〜100） | 98/75/65/85/60 | 0〜100にクランプ | `finance_spec.md` §11 |

画面上「/ 100点」のプログレスバーとして表示（`CompanyDashboard.tsx`）。信用スコア60が増資金額の分岐点として利用される（`finance_spec.md` §9）。

## 16. システム・情報管理関連

| 項目 | 型 | 保存場所 | 備考 |
|---|---|---|---|
| `gameCode` | string(6桁) | Redisキー名の一部、`GameSession.gameCode` | 衝突チェックなし（要確認） |
| `title` | string | `GameSession.title` | GM入力、未入力時は`ゲーム ${gameCode}` |
| `createdAt` | ISO8601文字列 | `GameSession.createdAt` | 作成時刻 |
| `currentYear`/`currentQuarter` | number | `GameSession` | `docs/game_manual.md` §3参照 |
| `currentPhase` | number(0〜6) | `GameSession` | 初期値0。〔engine〕ターン処理後に0へリセットされる。プレイヤー画面側のフェーズ切替はローカルstate（`CompanyDashboard.tsx`の`currentPhase`）で行われ、`GameSession.currentPhase`とは**連動していない**（要確認：フィールドが存在するが実際には使われていない可能性） |
| `status` | `"setup"\|"playing"\|"finished"` | `GameSession` | コード全文検索の結果、常に`"playing"`が設定されるのみで、`"setup"`/`"finished"`に遷移する処理は存在しない（未実装） |
| `players` | `Record<CompanyId, PlayerType>` | `GameSession` | `docs/ai_company_spec.md`参照 |
| `confirmedOrders` | `Record<CompanyId, ConfirmedOrder[]>` | `GameSession` | 常に空配列で初期化され、どこからも読み書きされない（未実装・死んだデータ） |
| `history` | `string[]` | `GameSession` | 〔engine〕処理済み四半期キー（例`"2015Q1"`）の配列。`main`ブランチにはこのフィールド自体が存在しない |

## 17. 未確定パラメータ一覧（このドキュメント作成時点でTODO/要確認としたもの）

- `farmingArea`・`processingCapacity`の正式な単位定義（ha, t/Qという表記はUIラベルからの推定）
- 現金ハイライト閾値（$8M）、D/E比率ハイライト閾値（2.5x）の設計根拠
- `GameSession.currentPhase`フィールドの実際の用途（UIのローカルstateと二重管理になっていないか）
- ゲームコードの衝突可能性への対処方針
- 外部調達量・短期借入額の上限値（UI文言はあるが強制なし）
