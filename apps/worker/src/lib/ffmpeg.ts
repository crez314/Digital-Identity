import { spawn } from 'node:child_process';
import { logger } from '@crez/shared';

/**
 * §1.1 / §7.3 FFmpeg 6 LGPL 빌드를 별도 프로세스로 호출한다.
 * x264·x265 등 GPL 코덱은 링크하지 않으며, H.264/HEVC 인코딩은
 * 하드웨어 인코더(NVENC) 또는 로열티가 커버되는 대안을 사용한다.
 */
export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

/** LGPL 빌드에서 사용할 비디오 인코더. 기본값은 하드웨어 인코더가 없는 환경을 고려해 mpeg4. */
export const VIDEO_ENCODER = process.env.FFMPEG_VIDEO_ENCODER ?? 'h264_videotoolbox';
export const FALLBACK_ENCODER = 'mpeg4';

export async function run(bin: string, args: string[], timeoutMs = 900000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += String(d); });
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout || stderr);
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function probe(path: string): Promise<{ durationMs: number; fps: number; width: number; height: number }> {
  const out = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path,
  ], 60000);
  const json = JSON.parse(out) as {
    streams: Array<{ codec_type: string; width?: number; height?: number; r_frame_rate?: string }>;
    format: { duration?: string };
  };
  const v = json.streams.find((s) => s.codec_type === 'video');
  const [num, den] = (v?.r_frame_rate ?? '30/1').split('/').map(Number);
  return {
    durationMs: Math.round(Number(json.format.duration ?? 0) * 1000),
    fps: den ? num / den : 30,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
  };
}

/** 인코더가 없는 환경에서 자동으로 폴백한다 (로컬 개발 편의) */
export async function encodeWithFallback(args: (encoder: string) => string[]): Promise<void> {
  try {
    await run(FFMPEG, args(VIDEO_ENCODER));
  } catch (e) {
    logger.warn({ encoder: VIDEO_ENCODER, err: String(e).slice(0, 300) }, 'primary encoder failed — falling back');
    await run(FFMPEG, args(FALLBACK_ENCODER));
  }
}
