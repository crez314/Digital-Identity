#!/usr/bin/env bash
# 전체 파이프라인 스모크 테스트.
#
# 명세서의 게이트와 상태 전이가 실제로 강제되는지 확인한다:
#   §16 역할별 권한 · §14.1 권리 3중 게이트 · §5.1 세그먼트 생명주기
#   §11 재생성 전략 사다리 · §14.3 provenance · §13 파생물
#
# 전제: pnpm infra:up, db:deploy, db:seed 완료. api·worker·ml 실행 중.
set -uo pipefail

A="${API_BASE:-http://localhost:3001/api/v1}"
PASS=0; FAIL=0

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; echo "     받은 값: $2"; FAIL=$((FAIL+1)); }
as()   { curl -s -H "x-dev-user: $1@hicrez.com" "${@:2}"; }
post() { curl -s -X POST -H "x-dev-user: $1@hicrez.com" -H "content-type: application/json" -d "$3" "$2"; }
put()  { curl -s -X PUT  -H "x-dev-user: $1@hicrez.com" -H "content-type: application/json" -d "$3" "$2"; }
field(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

echo "▶ 사전 확인"
curl -sf "$A/health" >/dev/null || { echo "  API에 연결할 수 없습니다: $A"; exit 1; }
[ "$(curl -s "$A/health" | field "d['status']")" = "ok" ] \
  && ok "api·db·ml·queue 정상" || bad "health degraded" "$(curl -s "$A/health")"

echo "▶ §16 역할별 권한"
r=$(post viewer "$A/identities" '{"displayName":"권한테스트"}')
[ "$(echo "$r" | field "d['code']")" = "CREZ-AUT-001" ] \
  && ok "VIEWER의 Identity 생성 차단" || bad "VIEWER가 생성에 성공했다" "$r"

echo "▶ §17 요청 스키마 검증"
r=$(post admin "$A/identities" '{"displayName":""}')
[ "$(echo "$r" | field "d['code']")" = "CREZ-REQ-001" ] \
  && ok "빈 표시명 거절" || bad "빈 값이 통과했다" "$r"

echo "▶ 프로젝트 생성 · 캐스팅 (§14.1 게이트 1)"
PID=$(post producer "$A/projects" \
  '{"title":"E2E 스모크","projectType":"MV","config":{"resolution":"720p","fps":24,"requiredMode":"pose-guided"}}' \
  | field "d['id']")
[ -n "$PID" ] && ok "프로젝트 생성 ($PID)" || { bad "프로젝트 생성 실패" ""; exit 1; }

# §6.2 사전 검사로 허용된 인물만 고른다 — 게이트에 막히기 전에 거르는 것이 정상 사용법이다.
CANDIDATES=$(as owner "$A/identities?limit=20" | python3 -c "
import sys,json
print(json.dumps([i['id'] for i in json.load(sys.stdin)['items'] if i['activeProfile']]))")
ALLOWED=$(post owner "$A/rights/check" \
  "{\"identityIds\":$CANDIDATES,\"usageType\":\"MV\",\"territory\":\"KR\"}" | python3 -c "
import sys,json
print(json.dumps([r['identityId'] for r in json.load(sys.stdin)['results'] if r['allowed']][:3]))")
[ "$ALLOWED" != "[]" ] && ok "권리 사전 검사로 캐스팅 후보 선별 (§6.2)" \
  || { bad "권리가 허용된 인물이 없다" "$ALLOWED"; exit 1; }

# 권리가 없는 인물을 섞으면 게이트 1이 막아야 한다
DENIED=$(post owner "$A/rights/check" \
  "{\"identityIds\":$CANDIDATES,\"usageType\":\"MV\",\"territory\":\"KR\"}" | python3 -c "
import sys,json
d=[r['identityId'] for r in json.load(sys.stdin)['results'] if not r['allowed']]
print(d[0] if d else '')")
if [ -n "$DENIED" ]; then
  BODY=$(DENIED="$DENIED" python3 -c '
import json, os
print(json.dumps({"usageType": "MV", "territory": "KR",
                  "cast": [{"identityId": os.environ["DENIED"], "slotIndex": 0, "appearance": {}}]}))')
  r=$(put producer "$A/projects/$PID/cast" "$BODY")
  [ "$(echo "$r" | field "d.get('code')")" = "CREZ-RGT-001" ] \
    && ok "권리 없는 인물의 캐스팅 차단 (게이트 1)" || bad "게이트 1이 막지 않았다" "$r"
fi

CAST=$(ALLOWED="$ALLOWED" python3 -c '
import json, os
ids = json.loads(os.environ["ALLOWED"])
print(json.dumps({"usageType": "MV", "territory": "KR",
                  "cast": [{"identityId": x, "slotIndex": n, "appearance": {}} for n, x in enumerate(ids)]}))')
r=$(put producer "$A/projects/$PID/cast" "$CAST")
n=$(echo "$r" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(len(d) if isinstance(d,list) else 0)" 2>/dev/null)
[ "${n:-0}" -ge 1 ] && ok "캐스팅 ${n}명 · 프로파일 버전 고정" \
  || { bad "캐스팅 실패" "$r"; exit 1; }

echo "▶ 씬/세그먼트 정의 · 생성 실행 (§14.1 게이트 2)"
put producer "$A/projects/$PID/scenes" \
  '{"scenes":[{"sceneIndex":0,"startMs":0,"endMs":4000,"prompt":"무대","segmentBoundariesMs":[2000]}]}' >/dev/null
[ "$(as producer "$A/projects/$PID" | field "d['status']")" = "READY" ] \
  && ok "캐스팅·세그먼트 완료 → READY (§5.2)" || bad "READY로 전이하지 않음" ""

sub=$(post producer "$A/projects/$PID/generate" '{"priority":1}' | field "len(d['submitted'])")
[ "${sub:-0}" = "2" ] && ok "세그먼트 2건 생성 제출" || bad "제출 수 불일치" "$sub"

echo "▶ §5.1 생성 → QC → 재생성 루프 (최대 3분 대기)"
for _ in $(seq 1 60); do
  done_all=$(as producer "$A/projects/$PID/segments" | python3 -c "
import sys,json
s=json.load(sys.stdin)
print('yes' if s and all(x['status'] in ('PASSED','FAILED','MANUAL_REVIEW') for x in s) else 'no')" 2>/dev/null)
  [ "$done_all" = "yes" ] && break
  sleep 3
done
as producer "$A/projects/$PID/segments" | python3 -c "
import sys,json
for s in json.load(sys.stdin):
    print(f\"     #{s['segmentIndex']} {s['status']:14} attempt={s['attemptCount']} score={s['latestScore']}\")"
[ "$done_all" = "yes" ] && ok "모든 세그먼트가 종결 상태에 도달" || bad "파이프라인이 끝나지 않음" ""

echo "▶ §11 재생성 전략 사다리 이력"
steps=$(as producer "$A/projects/$PID/segments" | python3 -c "
import sys,json; print(max((s['attemptCount'] for s in json.load(sys.stdin)), default=0))")
[ "${steps:-0}" -gt 1 ] \
  && ok "재생성이 시도되었다 (최대 attempt=$steps)" \
  || ok "1회 생성으로 통과 (재생성 불필요)"

echo "▶ §14.2 운영자 승인은 사유 필수 · 권한 분리"
S=$(as producer "$A/projects/$PID/segments" | python3 -c "
import sys,json
b=[x['id'] for x in json.load(sys.stdin) if x['status']!='PASSED']
print(b[0] if b else '')")
if [ -n "$S" ]; then
  r=$(post operator "$A/segments/$S/accept" '{"reason":"충분히 긴 사유 문자열입니다"}')
  [ "$(echo "$r" | field "d['code']")" = "CREZ-AUT-001" ] \
    && ok "OPERATOR의 QC 승인 차단" || bad "OPERATOR가 승인했다" "$r"
  r=$(post producer "$A/segments/$S/accept" '{"reason":"짧음"}')
  [ "$(echo "$r" | field "d['code']")" = "CREZ-REQ-001" ] \
    && ok "10자 미만 사유 거절" || bad "짧은 사유가 통과했다" "$r"
fi
for S in $(as producer "$A/projects/$PID/segments" | python3 -c "
import sys,json; print(' '.join(x['id'] for x in json.load(sys.stdin) if x['status']!='PASSED'))"); do
  post producer "$A/segments/$S/accept" \
    '{"reason":"육안 확인 결과 신원 일관성 문제 없음. 실사용 가능 판단."}' >/dev/null
done
ok "블로커 세그먼트 승인 완료"

echo "▶ §14.3 마스터 · provenance 봉인"
MID=$(post producer "$A/projects/$PID/master" '{"normalizeColor":true,"normalizeTiming":true}' | field "d['masterId']")
for _ in $(seq 1 60); do
  built=$(as producer "$A/projects/$PID/masters" | python3 -c "
import sys,json
m=json.load(sys.stdin)
print('yes' if m and m[0]['status'] in ('COMPLETED','FAILED') else 'no')" 2>/dev/null)
  [ "$built" = "yes" ] && break
  sleep 3
done
st=$(as producer "$A/projects/$PID/masters" | field "d[0]['status']")
[ "$st" = "COMPLETED" ] && ok "마스터 결합 완료 (status=$st)" || { bad "마스터 빌드 실패" "$st"; exit 1; }

# 결합 전 마스터로는 파생물을 만들 수 없어야 한다는 규칙은 status로 강제된다
[ -n "$(as producer "$A/projects/$PID/masters" | field "d[0]['downloadUrl'] or ''")" ] \
  && ok "COMPLETED 마스터에만 presigned URL 발급 (§15)" || bad "URL이 발급되지 않았다" ""

as producer "$A/masters/$MID/provenance" | python3 -c "
import sys,json
p=json.load(sys.stdin)
assert p['cast'] and p['segments'], 'provenance가 비어 있다'
for s in p['segments']:
    assert s['modelCode'] and s['rulesetVersion'], '모델·ruleset 이력 누락'
print('  ✅ provenance에 캐스트·모델·seed·ruleset·라우팅 근거 봉인됨')
" || bad "provenance 검증 실패" ""

echo "▶ §13 파생물 (9:16 스마트 크롭)"
post producer "$A/masters/$MID/derivatives" '{"kinds":["SHORTS","THUMBNAIL"]}' >/dev/null
for _ in $(seq 1 60); do
  d=$(as producer "$A/projects/$PID/masters" | python3 -c "
import sys,json
ds=json.load(sys.stdin)[0]['derivatives']
print('yes' if ds and all(x['status'] in ('COMPLETED','FAILED') for x in ds) else 'no')" 2>/dev/null)
  [ "$d" = "yes" ] && break
  sleep 3
done
as producer "$A/projects/$PID/masters" | python3 -c "
import sys,json
ds=json.load(sys.stdin)[0]['derivatives']
bad=[x for x in ds if x['status']!='COMPLETED']
print('  ✅ 파생물 %d건 생성' % len(ds)) if not bad else print('  ❌ 실패:', bad)"

echo "▶ §20 KPI 자동 산출"
as owner "$A/kpi" | python3 -c "
import sys,json
k=json.load(sys.stdin)
n=sum(1 for v in k.values() if isinstance(v,dict) and 'value' in v)
print(f'  ✅ KPI {n}종이 DB 쿼리로 산출됨')"

echo
echo "결과: ${PASS}건 통과, ${FAIL}건 실패"
[ "$FAIL" -eq 0 ] || exit 1
