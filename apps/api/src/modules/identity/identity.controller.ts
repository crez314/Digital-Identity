import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AssetUploadUrlRequest, ConfirmAssetRequest, CreateIdentityRequest, UpdateIdentityRequest, MoveAssetSlotRequest,
} from '@crez/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, TraceId } from '../../common/auth/current-user.decorator';
import { RequirePermission } from '../../common/auth/roles.decorator';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdentityService } from './identity.service';

/** §6.1 Identity API */
@ApiTags('identities')
@ApiBearerAuth()
@Controller('identities')
export class IdentityController {
  constructor(private readonly svc: IdentityService) {}

  @Post()
  @RequirePermission('IDENTITY_WRITE')
  @ApiOperation({ summary: 'Identity 생성. code 미지정 시 CRZ-Annn 자동 발번' })
  // 파이프는 @Body에만 건다. @UsePipes로 메서드에 걸면 traceId 같은 다른 파라미터까지 검증 대상이 된다.
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateIdentityRequest)) body: CreateIdentityRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.create(user, body, traceId);
  }

  @Get()
  @RequirePermission('READ')
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list(user.orgId, { status, q, cursor, limit: limit ? Number(limit) : undefined });
  }

  @Get(':id')
  @RequirePermission('READ')
  get(@Param('id') id: string) {
    return this.svc.toDto(id);
  }

  @Patch(':id')
  @RequirePermission('IDENTITY_WRITE')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateIdentityRequest)) body: unknown,
    @TraceId() traceId: string,
  ) {
    return this.svc.update(user, id, body as { displayName?: string; status?: string }, traceId);
  }

  @Delete(':id')
  @RequirePermission('IDENTITY_WRITE')
  @ApiOperation({ summary: 'Identity 삭제. 사진·프로파일·권리 기록·스토리지 파일까지 지운다. 캐스팅 중이면 거절' })
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string, @TraceId() traceId: string) {
    return this.svc.remove(user, id, traceId);
  }

  @Post(':id/assets/upload-url')
  @RequirePermission('IDENTITY_WRITE')
  @ApiOperation({ summary: 'presigned PUT URL 발급 (§15 15분 만료)' })
  uploadUrl(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AssetUploadUrlRequest)) body: AssetUploadUrlRequest,
  ) {
    return this.svc.createUploadUrl(user, id, body);
  }

  @Post(':id/assets')
  @RequirePermission('IDENTITY_WRITE')
  @ApiOperation({ summary: '업로드 완료 확정. 품질 검사 큐 투입' })
  confirmAsset(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ConfirmAssetRequest)) body: ConfirmAssetRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.confirmAsset(user, id, body, traceId);
  }

  @Patch(':id/assets/:assetId')
  @RequirePermission('IDENTITY_WRITE')
  @ApiOperation({ summary: '사진을 다른 캡처 슬롯으로 옮긴다. 슬롯 기준이 다르므로 옮긴 뒤 다시 판정한다' })
  moveAssetSlot(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Body(new ZodValidationPipe(MoveAssetSlotRequest)) body: MoveAssetSlotRequest,
    @TraceId() traceId: string,
  ) {
    return this.svc.moveAssetSlot(user, id, assetId, body.captureSlot, traceId);
  }

  @Post(':id/assets/recheck')
  @RequirePermission('IDENTITY_WRITE')
  @ApiOperation({ summary: '업로드된 이미지를 현재 기준으로 다시 품질검사. 사용자가 뺀 자산은 제외' })
  recheckAssets(@CurrentUser() user: AuthUser, @Param('id') id: string, @TraceId() traceId: string) {
    return this.svc.recheckAssets(user, id, traceId);
  }

  @Get(':id/assets')
  @RequirePermission('READ')
  @ApiOperation({ summary: '자산 목록. 캡처 슬롯 충족률 포함' })
  listAssets(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.listAssets(user, id);
  }

  @Delete(':id/assets/:assetId')
  @RequirePermission('IDENTITY_WRITE')
  @ApiOperation({ summary: '자산 삭제. 프로파일 빌드에 쓰였을 수 있는 자산은 비활성화만 한다' })
  removeAsset(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @TraceId() traceId: string,
  ) {
    return this.svc.removeAsset(user, id, assetId, traceId);
  }

  @Post(':id/profile/build')
  @RequirePermission('IDENTITY_WRITE')
  @ApiOperation({ summary: '프로파일 신규 버전 빌드 요청 → jobId 반환' })
  buildProfile(@CurrentUser() user: AuthUser, @Param('id') id: string, @TraceId() traceId: string) {
    return this.svc.buildProfile(user, id, traceId);
  }

  @Get(':id/profiles')
  @RequirePermission('READ')
  listProfiles(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.listProfiles(user, id);
  }

  @Post(':id/profiles/:v/activate')
  @RequirePermission('IDENTITY_WRITE')
  @ApiOperation({ summary: '해당 버전을 ACTIVE로 승격' })
  activateProfile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('v', ParseIntPipe) v: number,
    @TraceId() traceId: string,
  ) {
    return this.svc.activateProfile(user, id, v, traceId);
  }
}
