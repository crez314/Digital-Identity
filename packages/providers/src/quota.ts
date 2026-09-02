import type { QuotaView } from './router';

/**
 * §8: generation 큐 동시성은 모델별 quota 기반.
 * 동시 실행 슬롯을 Redis 카운터로 관리하는 것이 운영 구성이나,
 * 라우팅 시점에는 스냅샷만 필요하므로 읽기 전용 뷰로 주입한다.
 */
export class StaticQuotaView implements QuotaView {
  constructor(private readonly slots: Record<string, number>, private readonly defaultSlots = 4) {}
  remaining(modelCode: string): number {
    return this.slots[modelCode] ?? this.defaultSlots;
  }
  available(modelCode: string): boolean {
    return this.remaining(modelCode) > 0;
  }
}
