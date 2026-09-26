/**
 * 프롬프트 위험 검사 (§10, §11).
 *
 * 생성 결과가 QC에서 IDENTITY_DRIFT로 떨어지는 원인 상당수는 모델 성능이 아니라
 * "프롬프트가 시작 이미지와 충돌"하는 경우다. image-to-video는 시작 이미지 1장을 이어 붙이므로
 * 다른 장소·다른 인물·외모 변경을 요구하면 모델이 장면을 갈아 끼우면서 인물이 교체된다.
 *
 * 실행 전에 그 위험을 찾아 job 이력에 남기고 운영자에게 보여준다.
 * 막지는 않는다 — 판단은 운영자가 한다. 대신 실패했을 때 "왜"를 바로 알 수 있게 한다.
 */

export type PromptRiskKind =
  /** 다른 인물이 함께 등장하도록 요구 — 주 피사체가 교체될 수 있다 */
  | 'MULTI_PERSON'
  /** 시작 이미지와 다른 장소·상황 요구 — 장면 전환으로 이어진다 */
  | 'SCENE_CHANGE'
  /** 외모(머리·옷·나이) 변경 요구 — 신원 일치도가 직접 떨어진다 */
  | 'APPEARANCE_CHANGE'
  /** 컷 전환을 직접 요구 */
  | 'CUT';

export interface PromptRisk {
  kind: PromptRiskKind;
  /** 걸린 표현 — 운영자가 어느 단어를 고쳐야 하는지 알 수 있게 그대로 돌려준다 */
  term: string;
  message: string;
}

interface RiskRule {
  kind: PromptRiskKind;
  terms: string[];
  message: string;
}

// 한국어/영어 표현을 함께 본다. 형태소 분석 없이 부분 일치로 잡되, 오탐이 적은 표현만 넣는다.
const RULES: RiskRule[] = [
  {
    kind: 'MULTI_PERSON',
    terms: [
      '멤버들', '맴버들', '멤버와', '맴버와', '다른 사람', '사람들과', '친구들', '여러 명', '여러명',
      '그룹으로', '단체로', '백댄서', '군무',
      'with members', 'group of people', 'other people', 'crowd', 'backup dancers', 'band members',
    ],
    message: '다른 인물이 함께 등장하도록 요구합니다 — 시작 이미지 1장으로 이어 붙이는 모델에서는 '
      + '주 피사체가 새 인물로 교체되기 쉽습니다. 인물 수를 늘리려면 여러 인물을 캐스팅한 뒤 '
      + '다중 인물을 지원하는 모델로 생성하세요.',
  },
  {
    kind: 'SCENE_CHANGE',
    terms: [
      '무대에서', '무대로', '해변에서', '거리에서', '다른 장소', '장소를 바꿔', '배경을 바꿔', '배경 바꿔',
      'on stage', 'on a stage', 'different location', 'change the background', 'change location',
    ],
    message: '시작 이미지와 다른 장소를 요구합니다 — 모델이 장면을 전환하면서 인물까지 바뀝니다. '
      + '원하는 장소가 있으면 그 장소에서 찍은 사진을 레퍼런스로 올리세요.',
  },
  {
    kind: 'APPEARANCE_CHANGE',
    terms: [
      '헤어 스타일은', '헤어스타일은', '헤어스타일을', '머리 스타일', '머리를 바꿔', '염색',
      '옷을 바꿔', '의상을 바꿔', '더 어리게', '더 젊게', '살을 빼', '성형',
      'change hairstyle', 'different hairstyle', 'change clothes', 'younger face', 'restyle hair',
    ],
    message: '인물의 외모를 바꾸도록 요구합니다 — 신원 일치도(얼굴 유사도)를 직접 떨어뜨려 QC에서 걸립니다. '
      + '외모를 바꾸려면 그 외모로 찍은 사진으로 새 프로필을 만들어 캐스팅하세요.',
  },
  {
    kind: 'CUT',
    terms: ['컷 전환', '장면 전환', '여러 장면', 'jump cut', 'scene transition', 'multiple shots'],
    message: '컷 전환을 요구합니다 — 구간 하나는 한 컷으로 생성하는 것이 원칙입니다(§5.1). '
      + '컷을 나누려면 구간을 나누세요.',
  },
];

/** 시작 이미지 1장으로 이어 붙이는 모드 — 프롬프트 충돌에 가장 취약하다 */
const SINGLE_START_FRAME_MODES = new Set(['i2v']);

export interface InspectPromptOptions {
  /** 생성 모드 (i2v / t2v / v2v / multi 등) */
  mode: string;
  /** 캐스팅된 인물 수 */
  castCount: number;
}

/**
 * 프롬프트에서 신원 이탈 위험 표현을 찾는다.
 * 같은 종류는 처음 걸린 표현 하나만 돌려준다 — 같은 경고를 여러 줄 보여줄 이유가 없다.
 */
export function inspectPrompt(prompt: string | null, opts: InspectPromptOptions): PromptRisk[] {
  const text = (prompt ?? '').trim();
  if (!text) return [];
  const lower = text.toLowerCase();

  const risks: PromptRisk[] = [];
  for (const rule of RULES) {
    // 여러 인물을 실제로 캐스팅했다면 "멤버들과"는 요구사항이지 위험이 아니다
    if (rule.kind === 'MULTI_PERSON' && opts.castCount > 1) continue;
    // 장면 전환 위험은 시작 이미지가 있는 모드에서만 의미가 있다
    if (rule.kind === 'SCENE_CHANGE' && !SINGLE_START_FRAME_MODES.has(opts.mode)) continue;

    const term = rule.terms.find((t) => lower.includes(t.toLowerCase()));
    if (term) risks.push({ kind: rule.kind, term, message: rule.message });
  }
  return risks;
}

/** 로그·이벤트에 한 줄로 남길 요약 */
export function summarizeRisks(risks: PromptRisk[]): string {
  if (risks.length === 0) return '';
  return risks.map((r) => `${r.kind}("${r.term}")`).join(', ');
}
