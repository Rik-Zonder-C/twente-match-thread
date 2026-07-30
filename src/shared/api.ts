export type ErrorRsp = {error: string; status: number}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  OnAppInstall: 'internal/on/app/install',
  SyncMatches: 'internal/scheduler/sync-matches',
  PostThread: 'internal/scheduler/post-thread',
  MenuSyncNow: 'internal/on/menu/sync-now',
  MenuTestPost: 'internal/on/menu/test-post',
  MenuOverview: 'internal/on/menu/overview',
} as const

export const EndpointMethod = {
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.SyncMatches]: 'POST',
  [Endpoint.PostThread]: 'POST',
  [Endpoint.MenuSyncNow]: 'POST',
  [Endpoint.MenuTestPost]: 'POST',
  [Endpoint.MenuOverview]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
