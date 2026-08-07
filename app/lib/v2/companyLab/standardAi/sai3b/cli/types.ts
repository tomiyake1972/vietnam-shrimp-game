// ShrimpX V2 — Phase SAI-3B-1: Excel生成CLI 共通型

export class Sai3bCliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Sai3bCliArgumentError";
  }
}

export interface ParsedSai3bCliArgs {
  readonly help: boolean;
  /** --input で指定された入力ディレクトリ（1つ以上、複数回指定可）。 */
  readonly inputDirs: readonly string[];
  readonly outputPath: string;
}

/** CLI層が実際のfsへアクセスする代わりに注入するI/O抽象。runCli.ts自体は
 *  process.argv・console・process.exit・実ファイルシステムに直接触れない
 *  （companyLab/cli・autoplay/cliと同じ方針。実際のfs呼び出しはscripts/
 *  sai3bExcel.tsだけが行う）。 */
export interface Sai3bCliIo {
  /** ファイルをUTF-8テキストとして読む。存在しない場合はundefinedを返す
   *  （例外を投げない）。 */
  readonly readFile: (path: string) => string | undefined;
}

export interface Sai3bCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** exitCode===0の場合のみ設定される、書き出すべきxlsxの内容。 */
  readonly xlsxBuffer?: Buffer;
  readonly outputPath?: string;
}
