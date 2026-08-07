// ShrimpX V2 — Company Labテストプレイ（Phase 8C） 上部バナー
//
// Phase 6.2の会社経営統合テスト環境（app/v2/company-lab/components/LabBanner.tsx、
// teal配色、「Redis保存なし・ブラウザ内のみで計算」）とは異なり、この/play系画面は
// Phase 8C-3A/3BのAPI経由でサーバー側（Redis）に永続化される。旧バナーの文言を
// そのまま流用すると実構成と矛盾するため（実環境E2E時に指摘）、専用バナーとして分離し、
// 配色（sky）も変えて一目で区別できるようにする。
// 本番の会社画面ではない（GM・開発者専用のテストプレイ環境である）ことは引き続き明示する。

export default function PlayLabBanner() {
  return (
    <div className="sticky top-0 z-50 w-full bg-sky-800 text-white px-3 py-2 text-center text-xs sm:text-sm font-bold tracking-wide shadow-md">
      🎮 ShrimpX V2 Company Labテストプレイ（Phase 8C・GM/開発者専用） — 本番会社画面ではありません・サーバー保存あり（Redisへ永続化・リロード後も再開可能）
    </div>
  );
}
