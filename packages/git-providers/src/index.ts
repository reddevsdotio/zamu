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
  type RepositoryInfo,
  type TreeEntry,
  type WebhookHeaders,
  type WebhookRefusal,
  type WebhookVerification,
  type Whoami,
} from './types';
export { signWebhook, verifyWebhook } from './webhooks';
