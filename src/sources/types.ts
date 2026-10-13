export type LinkType = "github" | "notion";

export interface Link {
  /** 專案內唯一的 4 碼短 id，/link remove 用 */
  id: string;
  type: LinkType;
  /** github：owner/repo；notion：32 碼 page / database id */
  target: string;
  title: string;
  url: string;
  addedAt: string;
  addedBy?: string;
  lastSyncAt?: string;
  lastChangeAt?: string;
  error?: string;
  /** github 每個 endpoint 的 ETag，沒變時回 304 不算額度 */
  etags?: Record<string, string>;
}

export interface SyncResult {
  changed: boolean;
  title: string;
  files: string[];
}
