/**
 * Work Memory API request/response types, adapted for CLI apikey auth.
 *
 * Only project + session types are included (worklog/report are web-only).
 */

// ─── Common ─────────────────────────────────────────────────────────

/** Backend standard response envelope */
export interface ApiResponse<T = unknown> {
  code: number;
  msg?: string;
  data?: T;
}

export interface PageParams {
  pageSize?: number;
  cursor?: string;
}

// ─── Project management ──────────────────────────────────────────────

export interface CreateProjectRequest {
  displayName: string;
  lookbackDays: number;
  reportLanguage: string;
}

export interface CreateProjectResponse {
  projectId: string;
  displayName?: string;
  creatorUserId?: string;
  members?: string[];
  lookbackDays?: number;
  reportLanguage?: string;
  createdAt?: number;
  lastSyncAt?: number;
}

// ─── Batch sync ─────────────────────────────────────────────────────

export interface SyncSessionItem {
  id: string;
  agent: 'claude-code' | 'codex' | 'claude-science';
  path: string;
  cwd: string;
  mtimeMs: number;
  sizeBytes: number;
  meta?: Record<string, unknown>;
  fileId?: string;
  objectStorageUri?: string;
}

export interface SyncRequest {
  projectId: string;
  lookbackDays: number;
  windowStartIso?: string;
  sessions?: SyncSessionItem[];
}

export interface SyncTypeStats {
  received: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export interface SyncResponse {
  sessions?: SyncTypeStats;
  errors?: unknown[];
  receivedTs?: string;
}

// ─── Data browsing ──────────────────────────────────────────────────

export type FileBrowseType = 'all' | 'session';

export interface FileBrowseRequest extends PageParams {
  projectId: string;
  type: FileBrowseType;
}
