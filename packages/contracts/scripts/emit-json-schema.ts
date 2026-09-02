/**
 * §3: packages/contracts가 단일 출처.
 * ML DTO를 JSON Schema로 내보내 Python(Pydantic) 쪽에서 소비한다.
 * CI는 이 스크립트를 다시 돌려 산출물이 커밋본과 동일한지 검사한다(스키마 불일치 차단).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as Ml from '../src/ml';
import * as Jobs from '../src/jobs';
import * as Qc from '../src/qc';

const OUT = resolve(__dirname, '../../../services/ml/schemas/contracts.schema.json');

const definitions: Record<string, unknown> = {};

function add(name: string, schema: unknown) {
  const s = schema as { safeParse?: unknown };
  if (!s || typeof s.safeParse !== 'function') return;
  definitions[name] = zodToJsonSchema(schema as never, { name, $refStrategy: 'none' });
}

for (const [name, value] of Object.entries(Ml)) add(name, value);
for (const name of ['IdentityMetrics', 'ScoreWeights', 'QcThresholds'] as const) {
  add(name, (Qc as Record<string, unknown>)[name]);
}
for (const name of ['JobBase', 'QcJobPayload', 'GenerationJobPayload'] as const) {
  add(name, (Jobs as Record<string, unknown>)[name]);
}

const doc = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'CREZ DICE contracts (generated — do not edit by hand)',
  generatedFrom: 'packages/contracts/src/{ml,qc,jobs}.ts',
  definitions,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${OUT} (${Object.keys(definitions).length} definitions)`);
