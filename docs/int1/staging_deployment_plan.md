# INT-1 候補 — Staging 配備計画と復旧計画

更新: 2026-10-07 JST / 状態: **未配備**。この計画の実行には承認が必要。

## 1. 前提（現時点の状態）

- 統合候補は `/home/user/vietnam-shrimp-game/.worktrees/int1`（ローカルworktree）にある。
- ローカルbranch `local/int1-candidate-20261006`、基点 `a79ec99a477c0f13765856cf63666436fac8e014`、**追加commit 0本**。
- commit / push / PR / 共有RCへのmerge / Preview deploy / production deploy / 共有Redis変更は**いずれも未実施**。

## 2. 配備までの手順（承認後）

| # | 操作 | 必要な承認 |
| --- | --- | --- |
| 1 | 統合候補を1本以上のcommitにする（基点 a79ec99 の上） | commit承認 |
| 2 | 専用branch（例 `integration-prep/v2-int1-training-candidate`）へ normal push する。force push はしない | push承認（branch名の確定を含む） |
| 3 | Staging 環境へ Preview deploy する | Staging配備承認 |
| 4 | Staging で研修前チェックリストA・Bを実施する | — |
| 5 | 受入後に共有RCへmerge するかを別途判断する | RC merge承認（本計画の範囲外） |

**共有RC（`integration/v2-rc-20260830`）および production へは、承認前に一切反映しない。**

## 3. 使用する環境とデータの分離確認

| 項目 | 研修試行（Staging） | production | 分離の根拠 |
| --- | --- | --- | --- |
| Redis接続 | `STAGING_KV_REST_API_URL` / `STAGING_KV_REST_API_TOKEN` | `KV_REST_API_URL` / `KV_REST_API_TOKEN` | `app/lib/v2/redis` が `appEnvironment` に応じて環境変数名を切り替える。**他方への暗黙フォールバックは行わない**（未設定なら明示的にエラーになる。ビルド時に実際にそのエラーで停止することを確認済み） |
| Redis キー接頭辞 | `staging:v2:simulationRun:` | `v2:simulationRun:` | `app/lib/v2/redis/simulationRunRedisKeys.ts` の `prefixFor(appEnv)`。production 以外は必ず `staging:` 接頭辞が付く |
| 管理認証 | `STAGING_ADMIN_TOKEN` | 別トークン | staging 専用の管理セッションCookie |
| 保存形式 | v9 | （配備前は v8） | `CURRENT_SIMULATION_RUN_PERSISTED_VERSION = 9` |

配備前の確認事項:
- [ ] Staging の Redis が production と別インスタンス（別URL）であることを、環境変数の値ではなくURLのホストで確認する。
- [ ] 既存の保存済みRunを削除・書き換えしない（研修用に新規Runを作る）。
- [ ] 本検証で使った隔離ローカルRedis（port 6401）は停止済みで、データを残していない。

## 4. 保存形式 v9 を考慮した復旧計画

### 4.1 最重要の制約
統合候補のコードで保存した Run は **必ず schemaVersion 9** で書かれる（`persistRun.ts` と `handlers.ts` が `CURRENT_SIMULATION_RUN_PERSISTED_VERSION` をそのまま書くため、Crowding を使わない Run でも 9 になる）。

`isReadableSimulationRunSchema` は「現行より新しい版だけを拒否する」方針であり、**v8 までしか読めない旧コード（基準RC単体 / D1単体 / O1単体）へ戻すと、v9 で保存した Run は読めなくなる**。前方互換は意図的に持たせていない（知らない契約のデータを推測で解釈しないため）。

### 4.2 復旧手順（コードを戻す場合）
1. v9 で保存した Run を旧コードで開こうとしない。開くと `SimulationRunSchemaError` になる。
2. 既存 Run の `schemaVersion` を書き換えて版を下げることは**行わない**（saved Run の変更は禁止事項）。
3. 研修を続ける必要がある場合は、戻したコードで**新しい Run を作り直す**。進行中の Run は復旧できない前提で運用する。
4. 旧 v1〜v8 の保存物は v9 コードでそのまま読める（migration 不要）。したがって「前へ進む」方向の互換性は確保されている。

### 4.3 Redis 側の性質（復旧時に壊れないことの根拠・隔離Redisで実測）
- 昇格済みの canonical キー（`:dataset:{rev}` / `:resume:{rev}` / `:pack:{rev}`）は PERSIST により **TTL を持たない**（実測 PTTL = -1）。コードを入れ替えても消えない。
- 未公開の staging キー（`:staging:{writeToken}:{part}`）だけが1時間TTLを持つ。中断・失敗した保存の残骸は自然に回収される（実測 PTTL ≈ 3599999ms）。
- manifest の公開は Lua で原子的であり、CAS 失敗時は正規キーへの最初の書き込みより前に戻る（CONFLICT の return が最初の RENAME より前にある）。中途半端な公開状態は残らない。
- **対照実験**: product の Lua から PERSIST を外すと、短縮TTL経過後に canonical の3パートが消えて manifest だけが残る（＝公開済みなのに読めない Run）。PERSIST が必要であることを実測で確認した。

### 4.4 研修中に Run が壊れた場合
| 症状 | 復旧 |
| --- | --- |
| 保存が競合で拒否される | 画面を再読み込みしてから操作をやり直す。データは壊れていない |
| 保存が403で失敗する | 「こちらから再ログイン」→ 戻って「1 Turn」を押し直す |
| Turn進行が「意思決定が不正です」で止まる | GM が Console の「この会社を操作」から代理で確定し直す |
| Run そのものが読めない | その Run の続行は諦め、新規 Run を作る。既存 Run は書き換えない（監査のため残す） |

## 5. 進行中Runの復旧経路（隔離Redisで実証した結果）

検証スクリプト: `scripts/int1/verifyRecoveryPaths.ts` / ログ: `docs/int1/logs/recovery-paths.log`
（隔離ローカルRedis port 6403・6405。共有Redisへは接続していない。）

### 5.1 使える経路 — 正常保存状態からの再開
| 確認項目 | 結果（実測） |
| --- | --- |
| 最新 revision が正本として読める | 公開中 revision 6 / `loadRun` schemaVersion 9 / completedTurns 3 |
| 保存済み状態から再開して次Turnを進められる | 復元後 history 3Turn・salesModelId `tiered-v200-crowding-v1` 維持・次Turn進行 成功 |
| dataset / resume / pack がすべて復元される | 3つすべて true |
| 保存時点の確定提出が resume に入っている | 入っている（Turn実行後の保存では消費済みで空になる。これは正常） |

→ **v9対応コードを維持したまま、最後に保存が成立した地点から再開できる。** これが唯一の正規の復旧経路である。

### 5.2 使えない経路（実測した制限）
| 項目 | 結果（実測） | 意味 |
| --- | --- | --- |
| 1つ前の revision へ戻す | 旧 revision の dataset/resume/pack は公開時に削除される（EXISTS 0/0/0） | **「1つ前の保存状態へ戻す」ための保存物は残らない** |
| 旧 revision へ戻す公開API | `simulation-runs` API の公開関数は `handleSaveSimulationRunPart` / `handleSaveSimulationRun` / `handleLoadSimulationRun` / `handleListSimulationRuns` / `handleDeleteSimulationRun` のみ | **ロールバック用のAPI・UIは存在しない** |
| 監査用Excelからの復元 | 先頭4バイト `504b0304`（ZIP/xlsx）・214KB | **分析用の出力であり、Runを復元する保存物ではない**（resumePayload を含まない） |
| バックアップ / export-import によるRun復元 | 該当機能は見つからなかった | Runの外部バックアップから戻す経路は無い |

旧 revision の削除は `redisRepository.ts` の `commitRunManifest` 内の後始末（容量管理のための既存設計）であり、今回変更していない。

### 5.3 研修運用上の判断材料（司令塔向け）
- **保存が成立している限り、進行中Runは続けられる。** 1Turnごとに保存されるため、失う範囲は最大でも「保存に失敗した最後のTurn」1回ぶんである。
- **保存が失敗したTurnは失われる。** Console は失敗を明示し（`persistence-blocked-banner`）、以降のTurn進行を無効化するため、気づかないまま進み続けることはない。失敗したTurnは再実行する。
- **任意の過去Turnへ戻すことはできない。** 「Turn 10 の状態に戻してやり直す」という運用は現状できない。
- **最後の手段**: v8 コードへ戻す場合、v9 で保存したRunは読めなくなる（§4.1）。これは進行中Runの復旧ではなく、**研修を最初からやり直す**ための選択肢として扱う。
- 大型の復旧機構（任意Turnへのロールバック、Runのexport/import）は今回開発していない。必要であれば別の修正単位として判断を仰ぐ。
