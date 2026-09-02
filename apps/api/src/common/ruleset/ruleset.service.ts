import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@crez/db';
import { QcThresholds, ScoreWeights } from '@crez/contracts';
import { CrezError, ErrorCode } from '@crez/shared';
import type { RoutingWeights } from '@crez/providers';
import { PRISMA } from '../prisma.module';

/**
 * §10 점수 가중치·임계값은 DB ruleset 레코드로 관리한다. 코드에 하드코딩하지 않는다.
 * 적용된 버전은 qc_run.ruleset_version에 기록되어 재현 가능해야 한다.
 */
export interface ActiveRuleset {
  version: string;
  weights: ScoreWeights;
  thresholds: QcThresholds;
}

@Injectable()
export class RulesetService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async active(): Promise<ActiveRuleset> {
    const row = await this.prisma.qcRuleset.findFirst({ where: { isActive: true } });
    if (!row) throw new CrezError(ErrorCode.QC_RULESET_NOT_FOUND, '활성 QC ruleset이 없습니다', null, 500);
    return {
      version: row.version,
      weights: ScoreWeights.parse(row.weights),
      thresholds: QcThresholds.parse(row.thresholds),
    };
  }

  async byVersion(version: string): Promise<ActiveRuleset> {
    const row = await this.prisma.qcRuleset.findUnique({ where: { version } });
    if (!row) throw new CrezError(ErrorCode.QC_RULESET_NOT_FOUND, `ruleset ${version} 없음`, null, 404);
    return {
      version: row.version,
      weights: ScoreWeights.parse(row.weights),
      thresholds: QcThresholds.parse(row.thresholds),
    };
  }

  async list() {
    return this.prisma.qcRuleset.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /** 새 버전 등록. 활성화는 별도 호출로 분리해 실수로 즉시 반영되지 않게 한다. */
  async create(input: { version: string; weights: ScoreWeights; thresholds: QcThresholds; note?: string }) {
    return this.prisma.qcRuleset.create({
      data: {
        version: input.version,
        weights: input.weights as never,
        thresholds: input.thresholds as never,
        note: input.note ?? null,
        isActive: false,
      },
    });
  }

  async activate(version: string) {
    return this.prisma.$transaction([
      this.prisma.qcRuleset.updateMany({ where: { isActive: true }, data: { isActive: false } }),
      this.prisma.qcRuleset.update({ where: { version }, data: { isActive: true } }),
    ]);
  }

  /** §12 Model Router 가중치 */
  async activeRouting(): Promise<{ version: string; weights: RoutingWeights }> {
    const row = await this.prisma.routingRuleset.findFirst({ where: { isActive: true } });
    if (!row) {
      return { version: 'fallback', weights: { identity: 0.45, motion: 0.2, quality: 0.15, speed: 0.1, cost: 0.1 } };
    }
    return { version: row.version, weights: row.weights as unknown as RoutingWeights };
  }
}
