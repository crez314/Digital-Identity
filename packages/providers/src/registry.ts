import type { GenerationProvider, ModelDescriptor } from './types';
import { MockProvider } from './adapters/mock';
import { ExternalHttpProvider } from './adapters/external-http';
import { HiggsfieldProvider, HIGGSFIELD_ENDPOINTS } from './adapters/higgsfield';

/**
 * 모델 레코드(ai_model) → 어댑터 인스턴스 해석.
 *
 * 해석 순서
 *   1. code가 'higgsfield-'로 시작하면 Higgsfield 어댑터 (실제 상용 API)
 *   2. code가 'mock'으로 시작하면 개발용 mock
 *   3. 그 외에는 범용 HTTP 어댑터
 *
 * mock으로의 자동 폴백은 두지 않는다. 자격증명이 없으면 조용히 가짜 영상을 만드는 대신
 * 어댑터가 명시적으로 실패해야 한다 — 그래야 "생성된 줄 알았는데 mock이었다"가 생기지 않는다.
 */
export class ProviderRegistry {
  private readonly cache = new Map<string, GenerationProvider>();

  resolve(model: ModelDescriptor): GenerationProvider {
    const cached = this.cache.get(model.code);
    if (cached) return cached;

    let provider: GenerationProvider;

    if (model.code.startsWith('higgsfield-')) {
      const endpoint = HIGGSFIELD_ENDPOINTS[model.code]
        ?? (model.capabilities as { endpoint?: string }).endpoint
        ?? model.endpoint;
      if (!endpoint) {
        throw new Error(`higgsfield 모델 ${model.code}의 엔드포인트를 알 수 없습니다`);
      }
      provider = new HiggsfieldProvider(model.code, { endpoint });
    } else if (model.code.startsWith('mock')) {
      provider = new MockProvider();
    } else {
      provider = new ExternalHttpProvider({
        code: model.code,
        baseUrl: model.endpoint ?? process.env.GEN_EXTERNAL_BASE_URL ?? '',
        apiKey: process.env.GEN_EXTERNAL_API_KEY ?? '',
        contentPolicyCodes: ['content_policy', 'safety_rejected', 'nsfw'],
      });
    }

    this.cache.set(model.code, provider);
    return provider;
  }
}

export const providerRegistry = new ProviderRegistry();
