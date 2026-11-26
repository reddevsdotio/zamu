// Git provider adapters: one interface for reading repositories on GitHub, GitLab and Gitea/Forgejo,
// webhook verification and the host safety check. Core reaches providers only through this package.

export { createProvider } from './create';
export {
  GitHostRefused,
  GitNotFound,
  GitProviderError,
  type GitProviderErrorKind,
  GitRateLimited,
  GitUnauthorized,
  GitUnexpected,
  GitUnreachable,
  isGitProviderError,
} from './errors';
export {
  type AddressClass,
  type BaseUrlOptions,
  classifyAddress,
  deriveApiBaseUrl,
  deriveWebBaseUrl,
  type HostCheck,
  type HostPolicy,
  type HostRefusal,
  hostnameOf,
  isAllowedHost,
  type LookupFn,
  normalizeHost,
} from './hosts';
export { isUnderFolder } from './paths';
export { MAX_UPDATED_REQUESTS, parseRequestUrl } from './requests';
export {
  type BlobRef,
  type CreateProviderOptions,
  type FetchFn,
  type FileContent,
  type GitProvider,
  MAX_OPEN_REQUESTS,
  type OpenRequest,
  type OpenRequestList,
  PROVIDER_KINDS,
  type ProviderKind,
  REQUEST_ACTIONS,
  REQUEST_STATES,
  type RepositoryInfo,
  type RequestAction,
  type RequestInfo,
  type RequestState,
  type RequestUrl,
  type TreeEntry,
  type WebhookHeaders,
  type WebhookPushOrOther,
  type WebhookRefusal,
  type WebhookRequestEvent,
  type WebhookVerification,
  type Whoami,
} from './types';
export { signWebhook, verifyWebhook } from './webhooks';
