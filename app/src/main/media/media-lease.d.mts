export interface MediaHashLeaseOptions {
  maxWaitMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

export interface MediaHashLease {
  readonly token: string;
  readonly path: string;
  assertOwned(): Promise<void>;
  release(): Promise<boolean>;
}

export declare class MediaLeaseOwnershipError extends Error {
  readonly code: "MEDIA_LEASE_OWNERSHIP_LOST";
}

export declare function acquireHashLease(directory: string, hash: string, options?: MediaHashLeaseOptions): Promise<MediaHashLease>;
