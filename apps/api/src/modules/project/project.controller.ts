import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Sse } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { interval, map, merge, type Observable } from 'rxjs';
import {
  ConfirmMappingsRequest, CreateProjectRequest, GenerateRequest, PromptReferenceConfirmRequest,
  PromptReferenceUploadRequest, SetCastRequest, SetScenesRequest, SourceVideoUploadUrlRequest,
  UpdateProjectRequest, UpdateSegmentRequest,
} from '@crez/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, TraceId } from '../../common/auth/current-user.decorator';
import { RequirePermission } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { EventsService } from '../../common/events/events.service';
import { ProjectService } from './project.service';
import { GenerationService } from './generation.service';

/** §6.3 Project / 생성 API */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectController {
  constructor(
    private readonly svc: ProjectService,
    private readonly generation: GenerationService,
    private readonly events: EventsService,
  ) {}

  @Post()
  @RequirePermission('PROJECT_CREATE')
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateProjectRequest)) body: CreateProjectRequest) {
    return this.svc.create(user, body);
  }

  @Get()
  @RequirePermission('READ')
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list(user, { status, cursor, limit: limit ? Number(limit) : undefined });
  }

  @Get(':id')
  @RequirePermission('READ')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.toDto(id, user);
  }

  @Patch(':id')
  @RequirePermission('PROJECT_CREATE')
  @ApiOperation({ summary: '제목·생성 설정(방식·해상도·지정 모델) 변경. 생성 설정은 DRAFT·READY에서만' })
  update(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateProjectRequest)) body: UpdateProjectRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.update(user, id, body, traceId);
  }

  @Delete(':id')
  @RequirePermission('PROJECT_CREATE')
  @ApiOperation({ summary: '프로젝트 삭제. 생성 기록·결과·스토리지 파일까지 지운다. 생성 중이면 거절' })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string, @TraceId() traceId: string) {
    return this.svc.remove(user, id, traceId);
  }

  @Get(':id/dashboard')
  @RequirePermission('READ')
  @ApiOperation({ summary: '세그먼트 상태 집계와 MANUAL_REVIEW 블로커 (§5.2)' })
  dashboard(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.dashboard(user, id);
  }

  @Put(':id/cast')
  @RequirePermission('PROJECT_CREATE')
  @ApiOperation({ summary: '출연 인물 확정. 권리검사 후 profile version 고정' })
  setCast(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Body(new ZodValidationPipe(SetCastRequest)) body: SetCastRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.setCast(user, id, body, traceId);
  }

  @Get(':id/cast')
  @RequirePermission('READ')
  getCast(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.getCast(user, id);
  }

  @Post(':id/source-videos/upload-url')
  @RequirePermission('PROJECT_RUN')
  sourceUploadUrl(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Body(new ZodValidationPipe(SourceVideoUploadUrlRequest)) body: SourceVideoUploadUrlRequest,
  ) {
    return this.svc.sourceUploadUrl(user, id, body);
  }

  @Post(':id/source-videos/:sid/analyze')
  @RequirePermission('PROJECT_RUN')
  @ApiOperation({ summary: '인물 검출·트래킹 분석 시작' })
  analyze(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Param('sid') sid: string, @TraceId() traceId: string,
  ) {
    return this.svc.analyzeSource(user, id, sid, traceId);
  }

  @Get(':id/source-videos/:sid/tracks')
  @RequirePermission('READ')
  @ApiOperation({ summary: '검출된 트랙 + 자동 매핑 제안 (§9.1)' })
  tracks(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('sid') sid: string) {
    return this.svc.getTracks(user, id, sid);
  }

  @Put(':id/mappings')
  @RequirePermission('MAPPING_WRITE')
  @ApiOperation({ summary: '트랙 ↔ 캐스트 매핑 확정 (운영자 수정 반영)' })
  mappings(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Body(new ZodValidationPipe(ConfirmMappingsRequest)) body: ConfirmMappingsRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.confirmMappings(user, id, body, traceId);
  }

  @Put(':id/scenes')
  @RequirePermission('PROJECT_CREATE')
  @ApiOperation({ summary: '씬/세그먼트 분할 정의' })
  scenes(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Body(new ZodValidationPipe(SetScenesRequest)) body: SetScenesRequest,
  ) {
    return this.svc.setScenes(user, id, body.scenes);
  }

  @Post(':id/generate')
  @RequirePermission('PROJECT_RUN')
  @ApiOperation({ summary: '생성 실행. 제출 직전 권리 재검사 (§14.1 게이트 2)' })
  generate(
    @CurrentUser() user: AuthUser, @Param('id') id: string,
    @Body(new ZodValidationPipe(GenerateRequest)) body: GenerateRequest,
    @TraceId() traceId: string,
  ) {
    return this.generation.generate(user, id, body, traceId);
  }

  @Get(':id/segments')
  @RequirePermission('READ')
  segments(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.listSegments(user, id);
  }

  @Patch(':id/segments/:segmentId')
  @RequirePermission('PROJECT_RUN')
  @ApiOperation({ summary: '세그먼트 프롬프트 수정. 비우면 씬 프롬프트를 쓴다. 다음 생성부터 반영' })
  updateSegment(
    @CurrentUser() user: AuthUser, @Param('id') id: string, @Param('segmentId') segmentId: string,
    @Body(new ZodValidationPipe(UpdateSegmentRequest)) body: UpdateSegmentRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.updateSegmentPrompt(user, id, segmentId, body, traceId);
  }

  @Post(':id/segments/:segmentId/references/upload-url')
  @RequirePermission('PROJECT_RUN')
  @ApiOperation({ summary: '프롬프트 참고 이미지(배경·의상·헤어) 업로드 URL 발급' })
  referenceUploadUrl(
    @CurrentUser() user: AuthUser, @Param('id') id: string, @Param('segmentId') segmentId: string,
    @Body(new ZodValidationPipe(PromptReferenceUploadRequest)) body: PromptReferenceUploadRequest,
  ) {
    return this.svc.createReferenceUploadUrl(user, id, segmentId, body);
  }

  @Post(':id/segments/:segmentId/references/:referenceId/confirm')
  @RequirePermission('PROJECT_RUN')
  @ApiOperation({ summary: '참고 이미지 업로드 확정. 다음 생성부터 모델에 전달' })
  confirmReference(
    @CurrentUser() user: AuthUser, @Param('id') id: string, @Param('segmentId') segmentId: string,
    @Param('referenceId') referenceId: string,
    @Body(new ZodValidationPipe(PromptReferenceConfirmRequest)) body: PromptReferenceConfirmRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.confirmReference(user, id, segmentId, referenceId, body, traceId);
  }

  @Delete(':id/segments/:segmentId/references/:referenceId')
  @RequirePermission('PROJECT_RUN')
  @ApiOperation({ summary: '참고 이미지 삭제. 생성에 쓰인 적 있으면 보존하고 이후 생성에서만 뺀다' })
  removeReference(
    @CurrentUser() user: AuthUser, @Param('id') id: string, @Param('segmentId') segmentId: string,
    @Param('referenceId') referenceId: string, @TraceId() traceId: string,
  ) {
    return this.svc.removeReference(user, id, segmentId, referenceId, traceId);
  }

  @Sse(':id/events')
  @RequirePermission('READ')
  @ApiOperation({ summary: 'SSE. 진행률·상태 변경 실시간 스트림' })
  events$(@Param('id') id: string): Observable<{ data: unknown }> {
    // 프록시 타임아웃 방지용 heartbeat
    const heartbeat = interval(15000).pipe(
      map(() => ({ data: { type: 'HEARTBEAT', projectId: id, payload: {}, at: new Date().toISOString() } })),
    );
    return merge(this.events.stream(id), heartbeat);
  }

  @Post(':id/cancel')
  @RequirePermission('PROJECT_RUN')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @TraceId() traceId: string) {
    return this.generation.cancel(user, id, traceId);
  }
}
