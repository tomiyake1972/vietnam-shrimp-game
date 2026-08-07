// ShrimpX V2 — 会社ラボ API labIdのサーバー生成（Phase 8C-3A §6.1）
//
// 既存V2の識別子設計（app/api/game/route.tsのgenerateGameCodeCandidate /
// generateUniqueGameCode）と同じ方式を踏襲する: ランダムな英数字コードを生成し、
// 既存Repositoryに対して存在確認（labExists）を行い、衝突すれば再試行する。
// V1のgameCodeと同じ手法を採用する理由は、この手法が既に本番運用で実績のある
// 十分に衝突しにくい方式であり、新しい採番方式を導入する必要がないため。

import { CompanyLabStateRepository } from "../../../../lib/v2/companyLab/persistence/repository";

const MAX_LAB_ID_GENERATION_ATTEMPTS = 10;

function generateLabIdCandidate(): string {
  // V1のgenerateGameCodeCandidate（Math.random().toString(36)による6桁英数字）と
  // 同じ生成方式。"lab-"接頭辞により、ログ・Redisキー上でV1のgameCodeと視覚的に
  // 区別しやすくする（Redisキー名前空間自体は既にcompanyLabRedisKeys.tsでV1と
  // 完全分離されているため、衝突回避としては不要だが、可読性のために付与する）。
  return `lab-${Math.random().toString(36).substring(2, 8)}`;
}

/** 既存labIdと衝突しない一意なlabIdを発行する。一定回数試行しても得られない場合は例外を投げる。 */
export async function generateUniqueLabId(repository: CompanyLabStateRepository): Promise<string> {
  for (let attempt = 0; attempt < MAX_LAB_ID_GENERATION_ATTEMPTS; attempt++) {
    const candidate = generateLabIdCandidate();
    const exists = await repository.labExists(candidate);
    if (!exists) return candidate;
  }
  throw new Error(`labIdの生成に${MAX_LAB_ID_GENERATION_ATTEMPTS}回失敗しました（既存labIdとの衝突が続いています）。`);
}
