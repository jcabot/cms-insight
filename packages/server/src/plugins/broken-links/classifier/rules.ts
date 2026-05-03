import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Verdict } from '../sidecar.js';
import defaultRules from './rules.json' with { type: 'json' };

export interface ParkingPlatform {
  name: string;
  match: string[];
}

export interface TopicBucket {
  keywords: string[];
  min_density: number;
}

export interface ClassifierRules {
  parking_platforms: ParkingPlatform[];
  soft_404_patterns: string[];
  generic_parking_patterns: string[];
  generic_parking_max_text_bytes: number;
  topic_buckets: Record<string, TopicBucket>;
}

export interface ClassifierInput {
  status: number;
  finalUrl: string;
  originalHref: string;
  body: string;
  contentType: string;
  crossDomainRedirect: boolean;
  anchorText: string;
}

export interface ClassifierOutput {
  verdict: Verdict;
  reason_code: string;
  reason_detail?: string;
}

const DEFAULTS: ClassifierRules = defaultRules as ClassifierRules;

export async function loadDefaultRules(): Promise<ClassifierRules> {
  return DEFAULTS;
}

export async function loadRules(contentDir: string): Promise<ClassifierRules> {
  const overridePath = path.join(contentDir, '.cmsinsight', 'rules.json');
  try {
    const overrideText = await fs.readFile(overridePath, 'utf8');
    const override = JSON.parse(overrideText) as Partial<ClassifierRules>;
    return { ...DEFAULTS, ...override };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULTS;
    throw err;
  }
}

const STRIP_TAGS = /<\/?(?:script|style|nav|footer)[^>]*>[\s\S]*?<\/(?:script|style|nav|footer)>/gi;
const TAG_RE = /<[^>]*>/g;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;

function visibleText(html: string): string {
  return html.replace(STRIP_TAGS, ' ').replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function tokenCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function keywordDensity(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const matches = lower.match(re);
    if (matches) hits += matches.length;
  }
  const tokens = tokenCount(text);
  if (tokens === 0) return 0;
  return hits / tokens;
}

function anchorBucketHit(anchorText: string, keywords: string[]): boolean {
  const lower = anchorText.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

export function classify(input: ClassifierInput, rules: ClassifierRules): ClassifierOutput {
  const lower = input.body.toLowerCase();
  const title = decodeEntities(TITLE_RE.exec(input.body)?.[1] ?? '').toLowerCase();
  const h1 = decodeEntities(H1_RE.exec(input.body)?.[1] ?? '').toLowerCase();

  // Rule 1: Soft 404
  if (input.status === 200) {
    for (const pat of rules.soft_404_patterns) {
      const re = new RegExp(pat, 'i');
      if (re.test(title) || re.test(h1)) {
        return {
          verdict: 'BROKEN',
          reason_code: 'soft_404',
          reason_detail: title || h1 || undefined,
        };
      }
    }
  }

  // Rule 2: Parking platform fingerprint
  for (const platform of rules.parking_platforms) {
    for (const sig of platform.match) {
      if (lower.includes(sig.toLowerCase())) {
        return {
          verdict: 'BROKEN',
          reason_code: `parked_${platform.name}`,
          reason_detail: `Parked (${platform.name})`,
        };
      }
    }
  }

  // Rule 3: Generic parking
  const visible = visibleText(input.body);
  const visibleBytes = Buffer.byteLength(visible, 'utf8');
  for (const pat of rules.generic_parking_patterns) {
    const re = new RegExp(pat, 'i');
    if (re.test(visible) && visibleBytes < rules.generic_parking_max_text_bytes) {
      return {
        verdict: 'BROKEN',
        reason_code: 'parked_generic',
        reason_detail: 'Generic parking page',
      };
    }
  }

  // Rule 4 + 5 + 6: Topic buckets
  for (const [bucketName, bucket] of Object.entries(rules.topic_buckets)) {
    const density = keywordDensity(visible, bucket.keywords);
    if (density >= bucket.min_density) {
      const anchorHit = anchorBucketHit(input.anchorText, bucket.keywords);
      if (anchorHit) continue; // anchor matches bucket; not a topic shift
      const code = input.crossDomainRedirect ? `topic_shift_${bucketName}` : `${bucketName}_content`;
      return {
        verdict: 'SUSPICIOUS',
        reason_code: code,
        reason_detail: `${bucketName} content density ${density.toFixed(3)}`,
      };
    }
  }

  return { verdict: 'OK', reason_code: 'ok' };
}
