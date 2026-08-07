// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 上部バナー
//
// industry-lab（Phase3、インディゴ配色）とは配色を変え、一目で別画面（Phase6.2の
// 会社経営統合テスト環境）だと区別できるようにする。本画面はGM・開発者向けの
// 統合テスト環境であり、本番の会社画面ではないことを明示する
// （Redis保存なし・ブラウザ内のみの決定論的計算）。

export default function LabBanner() {
  return (
    <div className="sticky top-0 z-50 w-full bg-teal-700 text-white px-3 py-2 text-center text-xs sm:text-sm font-bold tracking-wide shadow-md">
      🏭 ShrimpX V2 会社経営統合テスト環境（Phase 6.2・GM/開発者専用） — 本番会社画面ではありません・Redis保存なし・ブラウザ内のみで計算
    </div>
  );
}
