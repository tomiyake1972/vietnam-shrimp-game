# 別件記録 — Production プロジェクトの APP_ENV が Production 対象に無い

記録: 2026-10-08
扱い: **別件。今回（BW-1）では変更しない。** 調査は読み取りのみで行った。

## 何を見つけたか

Vercel プロジェクト `vietnam-shrimp-game`（Production）の環境変数を
Vercel API（`GET /v9/projects/{id}/env`、値は取得していない）で一覧したところ、
`APP_ENV` の `target` が `["preview"]` だけだった。`production` が入っていない。
同じ応答の `hiddenProductionEnvCount` は 0 で、隠れている Production 変数も無い。

比較のため、Staging プロジェクト `vietnam-shrimp-game-staging` では
`APP_ENV` の `target` は `["production","preview"]` になっている。

## なぜ気にする必要があるか

`app/lib/env.ts` の `resolveAppEnvironment()` は、Vercel 上で動いていて
（`process.env.VERCEL` が真）`APP_ENV` が未設定・不正値のとき、
フォールバックせず例外で停止する設計になっている。これは
「APP_ENV の設定漏れでテスト環境が本番と誤判定され、prefix 無しで本番データと
同じキー空間へ書き込む事故」を防ぐための意図的な fail closed である。

したがって、`vietnam-shrimp-game` の Production デプロイでこの経路が通ると、
その時点で停止する可能性がある。

## 確認できていないこと

- 実際に Production デプロイが動いているかどうか（このプロジェクトの
  Production デプロイのランタイム挙動は確認していない）。
- チーム共有の環境変数（Shared Environment Variables）で `APP_ENV` が
  供給されていないか。プロジェクト個別の一覧には現れないため、別途確認が必要。
- 上記いずれかで実際には供給されている可能性があるため、**不具合と断定していない。**

## 次にやるとよいこと（今回はやらない）

1. Vercel → `tomiyake` → Settings → Environment Variables（チーム共有）で
   `APP_ENV` が定義されているかを見る。
2. 無ければ、`vietnam-shrimp-game` の Production 対象へ `APP_ENV=production` を
   設定するかどうかを判断する。**値の意味が本番/テストの分岐そのものなので、
   勝手に設定しない。**
