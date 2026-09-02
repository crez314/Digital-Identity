export const QUEUE_NAMES = ['ingest', 'analysis', 'generation', 'qc', 'regeneration', 'media'] as const;
export type QueueNameT = (typeof QUEUE_NAMES)[number];
