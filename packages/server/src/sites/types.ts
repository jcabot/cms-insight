export interface LastAnalysis {
  finishedAt: string;
  headline: string;
}

export interface SiteEntry {
  id: string;
  label: string;
  relPath: string;
  addedAt: string;
  postCount?: number;
  lastAnalyses?: Record<string, LastAnalysis>;
}

export interface SiteRegistryFile {
  version: 1;
  sites: SiteEntry[];
  activeSiteId?: string;
}
