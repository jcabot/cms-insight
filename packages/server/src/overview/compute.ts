import type { PostType } from '@cms-insight/plugin-api';
import type { ContentPost } from '../content/post.js';

export interface OverviewSummary {
  totals: {
    posts: number;
    pages: number;
    by_status: Record<string, number>;
  };
  categories: { name: string; count: number }[];
  tags: { name: string; count: number }[];
  by_year: { year: number; count: number }[];
  recent_modified: {
    type: PostType;
    slug: string;
    title: string;
    modified_gmt: string | undefined;
  }[];
  orphan_pages: { slug: string; title: string; parent: number }[];
}

function bumpRecord(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function yearOf(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const m = iso.match(/^(\d{4})/);
  if (!m || !m[1]) return undefined;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : undefined;
}

export function computeOverview(posts: ReadonlyArray<ContentPost>): OverviewSummary {
  let postCount = 0;
  let pageCount = 0;
  const byStatus: Record<string, number> = {};
  const cats: Record<string, number> = {};
  const tags: Record<string, number> = {};
  const years: Record<number, number> = {};

  const knownIds = new Set<number>();
  for (const p of posts) {
    if (p.type === 'page' && typeof p.id === 'number') knownIds.add(p.id);
  }

  const recentArr: ContentPost[] = [];

  for (const p of posts) {
    if (p.type === 'post') postCount++;
    else pageCount++;
    bumpRecord(byStatus, p.status);

    const fm = p.frontMatter;
    if (Array.isArray(fm.categories)) {
      for (const c of fm.categories) bumpRecord(cats, String(c));
    }
    if (Array.isArray(fm.tags)) {
      for (const t of fm.tags) bumpRecord(tags, String(t));
    }
    const yr = yearOf(typeof fm.date_gmt === 'string' ? fm.date_gmt : undefined);
    if (yr !== undefined) years[yr] = (years[yr] ?? 0) + 1;

    recentArr.push(p);
  }

  recentArr.sort((a, b) => {
    const am = String(a.frontMatter.modified_gmt ?? '');
    const bm = String(b.frontMatter.modified_gmt ?? '');
    return bm.localeCompare(am);
  });

  const orphans: OverviewSummary['orphan_pages'] = [];
  for (const p of posts) {
    if (p.type !== 'page') continue;
    const parent = p.frontMatter.parent;
    if (typeof parent === 'number' && parent !== 0 && !knownIds.has(parent)) {
      orphans.push({ slug: p.slug, title: p.title, parent });
    }
  }

  const categoriesList = Object.entries(cats)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const tagsList = Object.entries(tags)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const byYearList = Object.entries(years)
    .map(([y, c]) => ({ year: Number(y), count: c }))
    .sort((a, b) => b.year - a.year);

  return {
    totals: { posts: postCount, pages: pageCount, by_status: byStatus },
    categories: categoriesList,
    tags: tagsList,
    by_year: byYearList,
    recent_modified: recentArr.slice(0, 10).map((p) => ({
      type: p.type,
      slug: p.slug,
      title: p.title,
      modified_gmt:
        typeof p.frontMatter.modified_gmt === 'string' ? p.frontMatter.modified_gmt : undefined,
    })),
    orphan_pages: orphans,
  };
}
