// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） 上部バナー
//
// 実装指示 §10「テスト環境であることを上部に明示」「V1の会社画面と誤認しない
// 表示」に対応する。V1の環境バナー（黄色・EnvironmentBanner）とは配色・
// 文言を変え、一目でV1の本番/ステージング画面と区別できるようにする。

export default function LabBanner() {
  return (
    <div className="sticky top-0 z-50 w-full bg-indigo-700 text-white px-3 py-2 text-center text-xs sm:text-sm font-bold tracking-wide shadow-md">
      🧪 ShrimpX V2 業界シミュレーション・テスト環境（開発者・GM専用のバランス調整用画面） — Redis保存なし・会社経営ゲームではありません
    </div>
  );
}
