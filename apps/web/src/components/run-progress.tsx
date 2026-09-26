'use client';

/**
 * 생성 실행 알림.
 *
 * 실행 버튼을 눌러도 화면이 그대로여서 진행 중인지 알 수 없었다. 라우팅 단계에서 1초 만에 실패하면
 * 구간 상태만 조용히 FAILED로 바뀌어, 눌렀는지조차 헷갈린다. 그래서 진행 중에는 무엇이 몇 개 도는지,
 * 끝나면 성공·실패 수와 실패 사유를 이 알림에 띄운다.
 *
 * 화면을 가리지 않도록 모달이 아니라 오른쪽 아래 카드로 둔다 — 생성은 몇 분씩 걸려서
 * 그동안 다른 작업을 막으면 안 된다.
 */
export interface RunError {
  code?: string;
  message?: string;
  at: string;
  /** 정책 거부 뒤 자동 재제출이 걸린 오류 — 아직 끝난 게 아니다 */
  retrying?: boolean;
}

export interface RunProgressProps {
  /** 이번 실행으로 큐에 들어간 구간 수. 화면을 새로 연 뒤에는 null(진행 중인 것만 보여 준다) */
  submitted: number | null;
  running: number;
  passed: number;
  review: number;
  failed: number;
  errors: RunError[];
  onClose: () => void;
}

export function RunProgress({ submitted, running, passed, review, failed, errors, onClose }: RunProgressProps) {
  const finished = passed + review + failed;
  const total = submitted ?? running + finished;
  if (submitted === null && running === 0) return null;

  // 큐에 넣은 직후에는 아직 워커가 집어가기 전이라 도는 것도 끝난 것도 없다 — 그 사이를 '시작하는 중'으로 둔다
  const starting = running === 0 && finished === 0 && errors.length === 0 && submitted !== null;
  const done = running === 0 && !starting && submitted !== null;
  const ratio = total > 0 ? Math.min(1, finished / total) : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-[22rem] rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {running > 0 || starting ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          ) : null}
          <span className="text-sm font-medium">
            {starting
              ? `생성을 시작하는 중 — 구간 ${total}개`
              : running > 0
              ? `생성 중 — 구간 ${running}개`
              : failed > 0
              ? '생성이 실패로 끝났습니다'
              : '생성이 끝났습니다'}
          </span>
        </div>
        <button type="button" onClick={onClose} aria-label="알림 닫기" className="text-neutral-400 hover:text-neutral-600">
          ×
        </button>
      </div>

      {total > 0 ? (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800">
            <div
              className={`h-full transition-all ${failed > 0 ? 'bg-red-500' : running > 0 ? 'bg-blue-500' : 'bg-green-600'}`}
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
            <span>전체 {total}</span>
            {passed > 0 ? <span className="text-green-600">통과 {passed}</span> : null}
            {review > 0 ? <span className="text-violet-600">검토 대기 {review}</span> : null}
            {failed > 0 ? <span className="text-red-600">실패 {failed}</span> : null}
          </div>
        </div>
      ) : null}

      {errors.length > 0 ? (
        // 자동 재제출이 걸린 오류는 빨강으로 두지 않는다 — 사람이 끝난 줄 알고 초기화하면 재시도가 헛돈다
        <div
          className={
            errors[0].retrying
              ? 'mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs dark:border-amber-900 dark:bg-amber-950'
              : 'mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs dark:border-red-900 dark:bg-red-950'
          }
        >
          {errors[0].code ? (
            <div className={`font-mono text-[11px] ${errors[0].retrying ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400'}`}>
              {errors[0].code}
            </div>
          ) : null}
          <div className={`mt-0.5 ${errors[0].retrying ? 'text-amber-900 dark:text-amber-200' : 'text-red-900 dark:text-red-200'}`}>
            {errors[0].message ?? '생성에 실패했습니다'}
          </div>
          {errors.length > 1 ? (
            <div className={errors[0].retrying ? 'mt-1 text-amber-700' : 'mt-1 text-red-700'}>외 {errors.length - 1}건</div>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-[11px] text-neutral-500">
        {running > 0 || starting
          ? '이 화면을 닫아도 생성은 계속됩니다. 구간 목록과 실시간 이벤트에서 진행 상황을 볼 수 있습니다.'
          : done && failed > 0
          ? '구간 목록의 ‘초기화’로 되돌린 뒤 원인을 고치고 다시 실행하세요.'
          : '결과는 구간 목록에서 확인하세요.'}
      </p>
    </div>
  );
}
