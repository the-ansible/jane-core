/**
 * Time-bucketed event tracker for the dashboard histogram.
 * 60-second buckets, 60-minute retention (60 buckets max).
 */

const BUCKET_WIDTH_MS = 60_000;
const MAX_BUCKETS = 60;

export interface TimelineBucket {
  startMs: number;
  total: number;
  byChannel: Record<string, number>;
  byTier: Record<string, number>;
  byDirection: Record<string, number>;
  byUrgency: Record<string, number>;
  byCategory: Record<string, number>;
  byRouting: Record<string, number>;
  deduplicated: number;
  classified: number;
  errors: number;
}

export interface TimelineEventInfo {
  channelType?: string;
  direction?: string;
  tier?: string;
  urgency?: string;
  category?: string;
  routing?: string;
}

const buckets = new Map<number, TimelineBucket>();

function bucketKey(ts: number): number {
  return Math.floor(ts / BUCKET_WIDTH_MS) * BUCKET_WIDTH_MS;
}

function getOrCreateBucket(ts: number): TimelineBucket {
  const key = bucketKey(ts);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      startMs: key,
      total: 0,
      byChannel: {},
      byTier: {},
      byDirection: {},
      byUrgency: {},
      byCategory: {},
      byRouting: {},
      deduplicated: 0,
      classified: 0,
      errors: 0,
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

function incDimension(dim: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  dim[key] = (dim[key] || 0) + 1;
}

function prune(): void {
  const cutoff = bucketKey(Date.now()) - MAX_BUCKETS * BUCKET_WIDTH_MS;
  for (const key of buckets.keys()) {
    if (key < cutoff) buckets.delete(key);
  }
}

export function recordTimelineEvent(info: TimelineEventInfo): void {
  const bucket = getOrCreateBucket(Date.now());
  bucket.total++;
  bucket.classified++;
  incDimension(bucket.byChannel, info.channelType);
  incDimension(bucket.byTier, info.tier);
  incDimension(bucket.byDirection, info.direction);
  incDimension(bucket.byUrgency, info.urgency);
  incDimension(bucket.byCategory, info.category);
  incDimension(bucket.byRouting, info.routing);
}

export function recordTimelineDedup(): void {
  const bucket = getOrCreateBucket(Date.now());
  bucket.total++;
  bucket.deduplicated++;
}

export function recordTimelineError(): void {
  const bucket = getOrCreateBucket(Date.now());
  bucket.errors++;
}

export function getTimeline(): TimelineBucket[] {
  prune();
  return Array.from(buckets.values()).sort((a, b) => a.startMs - b.startMs);
}

export function resetTimeline(): void {
  buckets.clear();
}
