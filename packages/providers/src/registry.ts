import type { GenerationProvider, ModelDescriptor } from './types';
import { MockProvider } from './adapters/mock';
import { ExternalHttpProvider } from './adapters/external-http';

/** 모델 레코드(ai_model) → 어댑터 인스턴스 해석 */
export class ProviderRegistry {
  private readonly cache = new Map<string, GenerationProvider>();

  resolve(model: ModelDescriptor): GenerationProvider {
    const cached = this.cache.get(model.code);
    if (cached) return cached;

    let provider: GenerationProvider;
    if (model.code.startsWith('mock') || process.env.GEN_MOCK_ENABLED === 'true' && !model.endpoint) {
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
