// ShrimpX V2 — 相談役AI  Google Drive共同作業資料（interfaceのみ・MVPでは未接続）
//
// 【実装判断（実装指示§18・§57の明示要求）】
// アプリ本体からGoogle Driveを直接検索するには、Google OAuth（service account または
// ユーザー委任）・スコープ付与・トークン保管・Vercel環境変数の追加が必要になる。
// これは「新しい認証・外部連携の大規模実装」に当たるため、実装指示§57に従い
// **MVPでは実装しない**。
//
// 代わりに、
//   ・GitHub / repo docs → live retrieval（knowledge/retrieval.ts で実際に検索する）
//   ・Google Drive       → architecture / interfaceのみ（このファイル）
// とする。相談役AIには「Drive資料は現在参照できない」ことを事実として伝え、
// Drive上にしか無い情報を推測で語らせない。
//
// 【将来の接続方針】
// このモジュールのDriveWorkingMaterialProviderを実装したものを注入すれば、
// retrieval層の呼び出し側を変えずにDrive検索を追加できる。返す資料は必ず
// authority="WORKING" / sourceType="WORKING_MATERIAL" とし、GitHub正式版
// （FORMAL / CURRENT_IMPLEMENTATION）を置き換えないこと。

import { RetrievedExcerpt } from "./retrieval";

/** 共同作業フォルダ（正式仕様の置き場ではない）。 */
export const DRIVE_WORKING_FOLDER_URL = "https://drive.google.com/drive/folders/1gxIj9aJEeSe_r7XPli6zSBh_qQFg0mzs";

/**
 * 実装指示§15で名前が挙がっている既知の資料。
 * **中身は取得していない**。「そういう資料が存在する」という事実だけを相談役AIへ伝え、
 * 「Driveにある資料の内容」を推測で語らせないために使う。
 */
export interface KnownWorkingMaterial {
  readonly title: string;
  readonly location: "GOOGLE_DRIVE";
  readonly authority: "WORKING" | "HISTORICAL";
  readonly caution: string;
}

export const KNOWN_WORKING_MATERIALS: readonly KnownWorkingMaterial[] = [
  {
    title: "パラメータ文書ｖ.6.pdf",
    location: "GOOGLE_DRIVE",
    authority: "HISTORICAL",
    caution: "古い仕様を含む可能性がある。現行仕様は必ずGitHubの文書・現行コードを優先すること。",
  },
  {
    title: "game_manual v.1.pdf",
    location: "GOOGLE_DRIVE",
    authority: "HISTORICAL",
    caution: "古い仕様を含む可能性がある。現行仕様は必ずGitHubの文書・現行コードを優先すること。",
  },
  {
    title: "memo_20250713.md",
    location: "GOOGLE_DRIVE",
    authority: "WORKING",
    caution: "作業メモ。正式仕様ではない。",
  },
];

/** 将来Drive検索を接続する際のインターフェース。MVPでは実装しない。 */
export interface DriveWorkingMaterialProvider {
  search(query: string, limit: number): Promise<readonly RetrievedExcerpt[]>;
}

/**
 * 相談役AIのcontextへ入れる「Drive資料の扱い」の宣言。
 * 内容ではなく「参照できるか／どう扱うか」だけを渡す。
 */
export interface DriveAccessDeclaration {
  readonly connected: false;
  readonly folderUrl: string;
  readonly policy: string;
  readonly knownMaterials: readonly KnownWorkingMaterial[];
}

export function buildDriveAccessDeclaration(): DriveAccessDeclaration {
  return {
    connected: false,
    folderUrl: DRIVE_WORKING_FOLDER_URL,
    policy:
      "Google Drive共同作業フォルダは、このMVPでは接続されていません（新しい認証・外部連携を伴うため未実装）。" +
      "したがってDrive上の資料の中身は一切参照できません。存在が知られている資料についても、" +
      "その内容を推測して述べてはいけません。Driveは作業資料置き場であり、GitHubの正式文書・現行コードを置き換えるものではありません。",
    knownMaterials: KNOWN_WORKING_MATERIALS,
  };
}
