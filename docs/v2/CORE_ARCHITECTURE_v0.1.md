# ShrimpX V2 コアアーキテクチャ Phase 0（v0.1）

本ドキュメントは `feature/v2-core-foundation` ブランチで実装した Phase 0A（V2安全基盤）
および Phase 0B（V2コア/ターン骨格）の設計・責務範囲を記録する。

## 1. Phase 0 の責務範囲

Phase 0 は「V1と物理的に共有するRedis上で、V2が安全に自分の名前空間だけへ
読み書きできること」と「ターンの骨格（フェーズ状態機械・遅延効果・乱数・
GameSessionの最小骨格）」だけを対象とする。以下は明示的にスコープ外（未実装）：

- 国際HOSO価格・国別生産モデル・潜在需要モデル・PD/VAPプレミアム
- ベトナム国内原料の需給・清算
- 営業スタッフ・営業計画・ContractBook業務ロジック
- 市場別信頼スコアの実計算
- 品質投資・事故、緊急生産
- 自社養殖/輸入/国内調達の実処理
- Worker・工場・機械
- 財務（借入・再建）
- 生成AI、UI、新規API、Vercelへのデプロイ

市場価格形成モジュール仕様書（v0.2）は、型境界・将来拡張点の確認のみに使用し、
価格計算式は一切実装していない。

## 2. ディレクトリ構成

```
app/lib/v2/
  core/
    version.ts           APP_VERSION/APP_ENV検証、schemaVersion/engineVersion/balanceVersion定数
    units.ts              共通単位のbranded type + スマートコンストラクタ + 丸め関数
    period.ts              四半期Period（PeriodV2）
    random.ts               決定論的疑似乱数（RandomStream）
    turnPhase.ts            TurnPhase状態機械（P0〜P8）
    scheduledEffects.ts     遅延効果キュー
    gameSession.ts          V2 GameSession最小骨格 + Phase0プレースホルダ型
    __tests__/              上記のユニットテスト
  redis/
    redisKeys.ts            V2名前空間のRedisキー生成
    redisKeyGuard.ts         V2名前空間のRedisキー許可判定（純粋関数）
    __tests__/
  index.ts                  バレルエクスポート
docs/v2/
  CORE_ARCHITECTURE_v0.1.md 本ドキュメント
```

V1側の既存ファイル（`app/lib/env.ts`, `app/lib/redis.ts`, `app/lib/redisKeys.ts`,
`app/lib/redisKeyGuard.ts` 等）には一切手を加えていない。V2条件分岐をV1ファイルへ
追加する代わりに、V2コードはこの `app/lib/v2/` ディレクトリへ完全に分離した。

## 3. V1/V2分離の設計判断

- `app/lib/v2/core/version.ts` は V1 の `app/lib/env.ts` をimportしない。
  `process.env.APP_VERSION` / `process.env.APP_ENV` を独立して読み取り検証する。
- `app/lib/v2/redis/redisKeyGuard.ts` は V1 の `app/lib/redisKeyGuard.ts` を
  importしない。v1行の許可ルール（`games`/`game:*`、`staging:games`/`staging:game:*`）
  はこのファイル内に独立して再実装しており、V1側のルールとロジック上重複している。
  これは意図的な設計判断であり、理由は「V1とV2のキー検証ロジックが誤って結合し、
  片方の変更がもう片方に波及する事故を防ぐこと」にある。将来V1側のルールを変更
  しても、V2側のテスト・挙動には一切影響しない（逆も同様）。
- 既存のRedisクライアント（`app/lib/redis.ts` の `redis` インスタンス）自体は
  V1/V2で共有する前提だが、V2コードはこのクライアントに対して
  `app/lib/v2/redis/redisKeys.ts` で生成したキー以外を直接書かない、という運用と
  `assertAllowedKeysV2` によるガードをセットで使うことで、V2キー生成を経由しない
  書き込みを防ぐ。ただし、Phase 0時点では実際のRedis書き込み処理（Application層）
  自体を実装していないため、このガードは現時点ではまだどこからも呼ばれていない
  ライブラリ関数の状態である（Phase 1でApplication層から利用される想定）。

## 4. APP_VERSION / APP_ENV と Redisキー分離

`app/lib/v2/core/version.ts`:

- `AppVersion = "v1" | "v2"`
- `AppEnvV2 = "production" | "staging"`（V1が許容する `"development"`/`"preview"` は
  V2では意図的に許容しない — ユーザー仕様「production または staging」への厳密対応。
  V1より厳格なポリシーであり、これは**仕様からの変更点ではなく、V2固有の追加制約**
  として明記する）
- `assertAppVersion` / `assertAppEnvV2` は未設定・不正値を必ず例外にする
  （fail closed。デフォルト値へのフォールバックは一切行わない）

`app/lib/v2/redis/redisKeyGuard.ts` の `assertAllowedKeysV2(keys, appVersion, appEnv)` は
以下の4象限だけを許可する純粋関数（env変数読み取り・Redis接続に非依存）：

| APP_VERSION | APP_ENV | 許可されるキー |
|---|---|---|
| v1 | production | `games`（完全一致）, `game:*`（プレフィックス） |
| v1 | staging | `staging:games`, `staging:game:*` |
| v2 | production | `v2:games`, `v2:game:*` |
| v2 | staging | `staging:v2:games`, `staging:v2:game:*` |

判定は「リストキーとの完全一致」または「itemプレフィックスとの前方一致」の
2パターンのみを許可し、部分文字列一致は行わない。これにより
`staging:v2:game:X` を v1-staging の `staging:game:` プレフィックスと誤認したり
（`staging:` の直後が `game:` ではなく `v2:game:` であるため不一致）、
`staging:v2:foo` を v2-staging の `staging:v2:game:` プレフィックスと誤認する
（`staging:v2:` の直後が `game:` ではなく `foo` であるため不一致）ような
近似衝突を確実に拒否する。テストは `app/lib/v2/redis/__tests__/redisKeyGuard.test.ts`
に4象限それぞれの許可/拒否、クロスコンタミネーション、近似衝突ケースを網羅している。

## 5. 共通単位（units.ts）の設計選択

**branded（nominal）type + スマートコンストラクタ関数**を採用し、value object
（クラス）は採用しなかった。理由：

1. **直列化のしやすさ** — branded typeの実体はただのnumberなので
   `JSON.stringify`/`JSON.parse`（Redis保存・snapshot・API応答）をそのまま通せる。
   クラスにすると読み戻し時にプレーンオブジェクトへ壊れ、`toJSON`/`fromJSON`の
   相互変換が別途必要になる。
2. **演算のしやすさ** — branded typeはnumberとしてそのまま四則演算に使え、
   既存V1コード（プレーンnumberを直接計算式に書く書き方）との書き味の落差が小さい。
3. **ランタイムコストゼロ** — コンパイル時の型情報のみで実行時オブジェクトを
   新規に作らない。

トレードオフとして、`as HosoEqTons` のような型アサーションを直接書けば境界検証を
回避できてしまう。この回避を防ぐ機械的な強制（ESLintルール等）はPhase 0では
未実装であり、**運用上の注意点として次フェーズ以降の改善候補**とする。

実装した単位: `HosoEqTons`（HOSO換算トン、0以上）、`UsdPerHosoEqKg`（USD/HOSO換算kg、
0以上）、`UsdM`（USD百万、下限なし＝赤字・債務超過を許容）、`Ratio`（[0,1]）、
`Score0to100`（[0,100]）、および四半期を表す `PeriodV2`（`period.ts`、"YYYYQn"形式、
2015Q1起点）。すべて `assertFiniteNumber` でNaN/Infinity/非numberを拒否したうえで
範囲検証する。丸めは `roundUsdM`/`roundHosoEqTons`/`roundUsdPerHosoEqKg`/`roundRatio`/
`roundScore` に集約し、計算コード中に無秩序な `Math.round` を書かない方針とした。
**丸め桁数（USD百万=2桁、HOSO換算トン=2桁、価格=4桁、比率=4桁、スコア=2桁）は
仕様書v0.1/v0.2に明記がないため、Phase 0時点の暫定値である**（§8参照）。

## 6. TurnPhase状態機械

`app/lib/v2/core/turnPhase.ts` は全体実装計画書 第3章のフェーズ表に対応する
P0_OPEN 〜 P8_CLOSE の9段階を `TURN_PHASE_ORDER` で固定順序として定義する。

- `advanceTurnPhase(current)` は「次の1手」を計算する純粋関数。P8_CLOSE以外は
  同一Period内で次のフェーズへ、P8_CLOSEからは `nextPeriod()` でPeriodを1つ
  進めてP0_OPENへ戻る。
- `assertLegalTurnPhaseTransition(current, target)` は、`target` が
  `advanceTurnPhase(current)` の結果と完全に一致する場合のみ合法とする。
  これにより、スキップ（P0→P2）、後退（P1→P0）、同一フェーズへの二重実行
  （P1→P1）をすべて機械的に拒否する。
- **スナップショット復元・管理者による強制上書きはこの関数の対象外**とした。
  これらは「通常の1手」ではなく任意の状態への直接書き換えであるため、
  本関数に混在させず、将来のApplication層が別経路で扱う設計とする
  （ユーザー要件どおり）。

## 7. 遅延効果キュー（scheduledEffects.ts）

`ScheduledEffect<TPayload>` はジェネリックであり `any` を一切使わない。
`payload` の型は将来、各ドメイン（営業/輸入/養殖/投資等）が判別可能なunion
（`kind` フィールドで判別）として指定する想定。Phase 0では業務ロジックを
実装しないため、`gameSession.ts` では `UnimplementedEffectPayload`
（`{ kind: string; [key: string]: unknown }`）という境界型のみを置いている。

キュー操作（`scheduleEffect`/`dueEffects`/`markManifested`）はすべて引数を破壊せず
新しい配列を返す純粋関数。`manifested` フラグを用いた二重発現防止は
`markManifested` 内で「既にmanifested=trueの効果を再度マークしようとしたら例外」
という形で実装した。キューの要素はクラスやFunctionを含まないプレーンオブジェクトの
readonly配列であり、`JSON.stringify`/`JSON.parse` で意味が保たれる
（Redis/snapshot互換の要件を満たす）。

このキューが将来扱う想定のラグ（Phase 0では未実装）: 営業スタッフ+2期/-1期、
Worker+/-1期、輸入原料+1期、自社養殖収穫+2期、工場・機械のプロジェクト完成期。

## 8. 決定論的乱数（random.ts）

`Math.random()` を一切使用しない。文字列シードをcyrb53系の32bitハッシュへ変換し、
mulberry32アルゴリズム（追加npm依存なしで実装可能な軽量PRNG）でストリームを
生成する `RandomStream` クラスを実装した。

- 同一シードから作った2つの `RandomStream` は同一の消費順序で同一の値列を生成する。
- 異なるシードは異なる値列を生成する。
- `next()`（[0,1)）、`nextInt(min,max)`（整数範囲）、`chance(p)`（確率判定）、
  `pick(items)`（配列選択）を提供し、呼び出し順がそのまま消費順序になる。
- インスタンスごとに内部stateを保持するミュータブルなオブジェクトであり、
  Redisやグローバル変数には一切依存しない。ドメインエンジンから直接
  `createRandomStream(seed)` で生成して使う想定。

## 9. V2 GameSession最小骨格

`app/lib/v2/core/gameSession.ts` の `GameSessionV2` は以下を含む最小骨格：
`schemaVersion`（`2`固定）、`engineVersion`、`balanceVersion`、`gameCode`、
`currentPeriod`、`currentTurnPhase`、`randomSeed`、`createdAt`/`updatedAt`、
`companyIds`、`scheduledEffects`、`processedPhasesThisPeriod`（同一Period内での
二重実行検知の補助記録）、`industryState`、`companyStates`。

`industryState`/`companyStates` は要求どおり `any` を使わず、
`IndustryStatePhase0`（`{ _phase0Placeholder: true }`）、
`CompanyStatePhase0`（`{ companyId: string; _phase0Placeholder: true }`）という
**明示的に「まだ何も定義されていない」ことを表すPhase0限定の型**とした。
後続Phaseでは、この2つの型を業務フィールドを持つ具体的な型に置き換えていく
（＝拡張は型の中身を追加する形で行い、`GameSessionV2` 自体の骨格は変えない想定）。

`createInitialGameSessionV2()` は `createdAt`/`updatedAt` を含む全フィールドを
呼び出し側から渡された `now`（ISO8601文字列）から計算する純粋関数とし、
`Date.now()`等への暗黙依存を排除してテスト可能にした。

## 10. テスト

`npm test`（`tsx --test "app/lib/**/__tests__/**/*.test.ts"`）で75件全て成功
（既存V1テスト11件を含む）。ユーザー指定の23項目の対応関係:

1. APP_VERSION未設定の拒否 — `core/__tests__/version.test.ts`
2. APP_VERSION不正値の拒否 — 同上
3. v1/production 許可/拒否 — `redis/__tests__/redisKeyGuard.test.ts`
4. v1/staging 許可/拒否 — 同上
5. v2/production 許可/拒否 — 同上
6. v2/staging 許可/拒否 — 同上
7. V1/V2クロスコンタミネーション拒否 — 同上（4象限すべて個別テスト化）
8. 近似衝突キー（`staging:v2:foo`等）拒否 — 同上
9. 通常の単位生成 — `core/__tests__/units.test.ts`
10. 負数量/NaN/Infinityの拒否 — 同上
11. ratio>1・score>100の範囲検証 — 同上
12. Periodの通常の次期計算 — `core/__tests__/period.test.ts`
13. 年末→翌年Q1遷移 — 同上
14. 通常のTurnPhase遷移 — `core/__tests__/turnPhase.test.ts`
15. フェーズのスキップ/後退拒否 — 同上
16. P8→次期P0遷移 — 同上
17. 効果が指定Periodでのみ発現 — `core/__tests__/scheduledEffects.test.ts`
18. 効果の二重発現拒否 — 同上
19. 同一シード→同一乱数列 — `core/__tests__/random.test.ts`
20. 異なるシード→異なる乱数列 — 同上
21. V2初期GameSessionのバージョン値 — `core/__tests__/gameSession.test.ts`
22. JSON保存・復元での意味保持 — 同上（および scheduledEffects.test.ts でも別途検証）
23. 既存V1テストが引き続き成功 — `npm test` 全体実行で確認（V1側の11テストを含む75件が成功）

## 11. 検証結果サマリ

- `npm test`: 75 pass / 0 fail（既存V1の11件を含む）
- `npx tsc --noEmit`: エラー0件
- `npx eslint app/lib/v2`: エラー・警告0件
- `npm run build`: コンパイル・型チェックは成功。ページデータ収集フェーズで
  既存V1 API route（`/api/game/[gameCode]/admin/clone`）が `STAGING_KV_REST_API_URL`
  等の未設定により失敗するが、これはこのサンドボックスにRedis環境変数が
  設定されていないことによるものであり、V1側の既存コード・挙動であって
  V2の変更によって新規に発生したものではない（V2側の新規ファイルはビルドの
  コンパイル・型チェック段階を問題なく通過している）。

## 12. 仕様書からの変更・補完点（Phase 0時点）

- 丸め桁数（§5）は仕様書に明記がないための暫定値。
- APP_ENVの許容値をV1より厳格化（`production`/`staging`のみ、
  `development`/`preview`は不許可）— ユーザー仕様の文言に厳密対応した結果の
  追加制約であり、仕様との矛盾ではない。
- V2の `redisKeyGuard.ts` はV1のものと意図的にコード共有しない（§3）。

## 13. 未実装項目（このラウンドでは扱わない）

§1に列挙した業務モジュール全般に加え、Phase 0内でも以下は未実装：

- `assertAllowedKeysV2` を実際のRedis読み書き経路（Application層）から呼び出す配線
- ESLintによる `as <BrandedType>` アサーションの機械的検出・禁止
- V2用のAPIルート・UI・Vercelデプロイ設定

## 14. Phase 1着手前にレビューしてほしい点

- 丸め桁数の暫定値（USD百万=2桁、価格=4桁等）がバランス調整方針と整合するか
- `UnimplementedEffectPayload` の形（`kind`判別unionへ将来置き換える設計）が
  各業務モジュールの効果ペイロード設計と整合するか
- APP_ENVをV2で`production`/`staging`のみに限定した点が、実際のVercel環境
  （development/previewが実際に発生しうるか）と運用上矛盾しないか
- `processedPhasesThisPeriod` の使い道（現状は記録のみで、Application層側の
  検証ロジックは未実装）をPhase 1でどう使うか
