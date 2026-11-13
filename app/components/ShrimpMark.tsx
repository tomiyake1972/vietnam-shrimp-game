// ShrimpX のマスコット。画面を明るくする変更にあわせて、見出しや待ち画面に置く
// 「かわいいエビ」の絵。外部画像は使わずインラインSVGにしてある（追加の読み込みが
// 発生せず、配色もテーマ側と一緒に管理できるため）。
//
// サイズは 24px 以上で使うこと。それより小さいと目・ひげ・尾が潰れて何の絵か
// 分からなくなる（実際に 16/20/24px を並べて確認した）。

export default function ShrimpMark({
  size = 32,
  className,
  title,
}: {
  size?: number;
  className?: string;
  /** 読み上げが必要な場所だけ渡す。省略時は装飾として扱う（aria-hidden）。 */
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {/* 尾びれ（3枚） */}
      <path d="M44 30c7-4 13-4 18-1-4 5-10 7-16 7z" fill="#fcc6b7" />
      <path d="M44 38c7 0 13 2 17 7-6 2-13 1-18-2z" fill="#fcc6b7" />
      <path d="M44 32c6 1 11 4 14 8-6 2-12 2-17 0z" fill="#f9a893" />
      {/* 背側の殻 */}
      <path d="M27 11c12 0 22 8 24 19 1 5 0 10-3 14l-9-5c2-3 3-7 2-11-2-8-8-12-15-12z" fill="#fb9d88" />
      {/* 胴体 */}
      <path d="M27 11c-10 0-17 7-17 15s7 15 16 15h11c3 0 5-2 4-5-3-10-7-16-14-16z" fill="#f98f7a" />
      <path d="M30 13c4 3 7 8 9 13" stroke="#ef7a63" strokeWidth="1.8" fill="none" strokeLinecap="round" opacity="0.55" />
      {/* ほっぺ */}
      <circle cx="13" cy="30" r="2.4" fill="#f4738c" opacity="0.45" />
      <circle cx="32" cy="31" r="2.4" fill="#f4738c" opacity="0.45" />
      {/* 目 */}
      <circle cx="19" cy="22" r="4.4" fill="#ffffff" />
      <circle cx="19.7" cy="22.5" r="2.8" fill="#3a2a2c" />
      <circle cx="20.9" cy="21.2" r="1.1" fill="#ffffff" />
      {/* ひげ */}
      <path d="M12 15C9 10 10 6 13 4M18 13c-2-5 0-10 4-12" stroke="#ef7a63" strokeWidth="2.3" fill="none" strokeLinecap="round" />
      {/* 脚 */}
      <path d="M17 41c-1 3-1 6 1 8M24 41c0 3 1 6 3 7M31 41c1 3 2 5 4 6" stroke="#ef7a63" strokeWidth="2.3" fill="none" strokeLinecap="round" />
      {/* 口 */}
      <path d="M23 28c2 2 5 2 7 0" stroke="#3a2a2c" strokeWidth="1.9" fill="none" strokeLinecap="round" />
    </svg>
  );
}
