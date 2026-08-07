// ShrimpX V2 — 会社ラボ API turnIdの生成・保持方針（Phase 8C-3A §6.5）
//
// 【設計判断・理由】
//   Application Service（Phase 8C-2）のturnIdは「処理ごとに呼び出し側が生成する
//   一意ID」で、同一turnIdでの再試行を冪等にする役割を持つ（processQuarterの
//   §6.1参照）。指示書は「APIサーバーがリクエストごとに無条件で新しいturnIdを
//   生成し、冪等性を失わせる設計にはしない」ことを要求しており、以下の2方式が
//   候補として挙げられている。
//     (a) クライアントがturnIdを生成・保持して送信する
//     (b) draft作成時にサーバーがturnIdを払い出し、その後の保存・提出・処理で
//         同じ値を使う
//
//   turnIdの「値」自体は、(labId, 処理対象turn番号)から決定論的に導出する
//   （deriveTurnId(currentTurn) = `turn-${currentTurn}`）。クライアント側で
//   乱数やUUIDを生成・保持する必要がなく、サーバー側でも「発行したturnIdを
//   どこかに追加で保存しておく」専用ストレージが不要という利点は維持する。
//
//   【重要な設計修正】ただし「毎回、呼び出し時点のcurrentState.runtime.
//   scenarioState.currentTurnからその場で再計算する」だけでは不十分だと、
//   実装中のテスト（handlers.test.ts）で実際に判明した。processQuarterが
//   コミットに成功すると、currentTurnはその場で次のturnへ進み、コミット済み
//   turnのdraftは原子的に削除される。ここで「コミット自体は成功したが応答が
//   失われ、クライアントが同じ操作を再送する」という、turnIdベース冪等性の
//   本来の主目的そのものにあたるケースが発生すると、再送時に読み直した
//   currentTurnは既に次のturnを指しており、素朴な再計算では別のturnId
//   （まだdraftすら存在しない次のturn向けの値）を導出してしまい、
//   DraftNotFoundとして拒否される（＝正しく「既に処理済み」を検出できない）。
//
//   これを防ぐため、提出・処理系の操作（submitDraft・processQuarter）が
//   使うturnIdは、単純な「今のcurrentTurnから毎回導出する」ではなく、
//   resolveInFlightTurnId()による次の優先順位で解決する。
//     1. 現在保存されているdraftのturnId（存在すれば、それが今まさに提出・
//        処理しようとしている対象そのもの）。
//     2. current.lastProcessedTurnId（draftが既に存在しない＝直近の処理が
//        成功してdraftが原子的に削除された後の状態。応答消失後の再送は
//        ここで直近確定turnIdを再解決し、Application Service層の§6.1
//        冪等判定（alreadyProcessed）へ正しく到達する）。
//     3. どちらも無い場合（このラボで一度もdraftが作られていない、
//        最初の状態）のみ、deriveTurnId(currentTurn)で新規にturn 1を指す
//        値を導出する。
//
//   一方、draftの新規保存（saveDraft）は性質が異なる。draftは常に
//   「これから提出する対象」であり、過去に確定した直近turnId（
//   lastProcessedTurnId）を再利用する意味がない（それは既に確定済みで
//   編集対象になり得ない）。そのためresolveNewDraftTurnId()は
//   lastProcessedTurnIdを見ず、既存の（未提出の）draftがあればそれを
//   継続編集の対象として使い、無ければcurrentTurnから新規に導出する。

/** labId単位で「指定したturn番号」からturnIdを決定論的に導出する。 */
export function deriveTurnId(turn: number): string {
  if (!Number.isInteger(turn) || turn < 1) {
    throw new Error(`deriveTurnId: turn は1以上の整数である必要があります。受け取った値: ${JSON.stringify(turn)}`);
  }
  return `turn-${turn}`;
}

export interface ResolveNewDraftTurnIdInput {
  readonly currentTurn: number;
  /** 既存の（未提出または提出済みの）draftのturnId。draftが無ければnull。 */
  readonly existingDraftTurnId: string | null;
}

/** saveDraft用のturnId解決（§6.3）。既存draftがあればそれを継続編集し、無ければ現在のturnから新規導出する。 */
export function resolveNewDraftTurnId(input: ResolveNewDraftTurnIdInput): string {
  if (input.existingDraftTurnId !== null) return input.existingDraftTurnId;
  return deriveTurnId(input.currentTurn);
}

export interface ResolveInFlightTurnIdInput {
  readonly currentTurn: number;
  /** 現在保存されているdraftのturnId。draftが無ければnull。 */
  readonly draftTurnId: string | null;
  /** current.lastProcessedTurnId（未処理ならnull/undefinedをnullとして渡す）。 */
  readonly lastProcessedTurnId: string | null;
}

/**
 * submitDraft・processQuarter用のturnId解決（§6.5）。draft存在時はその
 * turnIdを最優先し、draft不在時は直近確定turnId（応答消失後の再送を正しく
 * 冪等判定へ導くため）、どちらも無ければ新規のturn 1を導出する。
 */
export function resolveInFlightTurnId(input: ResolveInFlightTurnIdInput): string {
  if (input.draftTurnId !== null) return input.draftTurnId;
  if (input.lastProcessedTurnId !== null) return input.lastProcessedTurnId;
  return deriveTurnId(input.currentTurn);
}
