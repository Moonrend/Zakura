export type { ProviderPlugin, ProviderFactory, ProviderContext, InstanceHandle } from "./provider.js";
export { ProviderRegistry, globalRegistry } from "./registry.js";
export type { ContainerRuntime, CreateContainerOptions, RunningContainer } from "./runtime.js";
export {
  encryptJson,
  decryptJson,
  DecryptError,
  hashApiKey,
  generateApiKey,
  generateSecret,
  textResult,
} from "./crypto.js";

export {
  PathJailError,
  CONTAINER_WORKSPACE_ROOT,
  resolveInRoot,
  toWorkspacePath,
  toApiPath,
  entryName,
  scrubHostPathsInMessage,
} from "./path-jail.js";
export type {
  WorkspaceFs,
  WorkspaceFsProvider,
  WorkspaceFsEntry,
  ListOpts,
  ListResult,
  ListDetailedResult,
  ReadOpts,
  ReadResult,
  ReadTextResult,
  WriteResult,
  ReadBytesResult,
  WriteBytesResult,
  ArchiveResult,
  ExtractResult,
} from "./workspace-fs.js";
export { LocalWorkspaceFs, contentRevision, ensureWorkspaceDir } from "./local-workspace-fs.js";
export {
  matchExcludePattern,
  shouldExcludePath,
  mergeExcludePatterns,
  walkWorkspaceFiles,
  exportWorkspace,
  importWorkspace,
  exportWorkspaceToFile,
  importWorkspaceFromFile,
  writeArchiveFile,
  readArchiveFile,
  MANIFEST_PATH,
} from "./migration-archive.js";
export type {
  ExportOptions,
  ExportResult,
  ImportOptions,
  ImportResult,
  WalkedFile,
} from "./migration-archive.js";
export { generateRunnerToken, hashRunnerToken, isRunnerToken } from "./runner-token.js";
export { RunnerClient } from "./runner-client.js";
export type { RunnerClientOptions } from "./runner-client.js";
export { toDockerHostPath, unwrapShellCommand } from "./docker-path.js";
export {
  parseImageRef,
  normalizeImageRef,
  checkImageUpdate,
  checkImageUpdates,
  discoverDockerRegistryMirrors,
} from "./image-update-check.js";
export type {
  ImageRef,
  ImageDigestInfo,
  DockerLike,
  ImageInspectLike,
  ImageUpdateProbeOptions,
} from "./image-update-check.js";
export {
  ShellJob,
  ShellJobRegistry,
  DockerMuxParser,
  bindExecStream,
  formatShellToolResult,
  newShellJobId,
  tailText,
} from "./shell-job.js";
export type { ShellJobSnapshot } from "./shell-job.js";
export { StdioExec, StdioExecRegistry } from "./stdio-exec.js";
export type { StdioInspect, StdioExecOptions } from "./stdio-exec.js";
export {
  resolveDockerContextSocketPath,
  type DockerContextSocketOptions,
} from "./docker-endpoint.js";

export {
  redactString,
  sanitizeFields,
  errorFields,
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  HTTP_DURATION_BUCKETS_MS,
  HealthRegistry,
  OperationalLogger,
  parseLogLevel,
  classifyHttpRoute,
  classifyHttpStatus,
  classifyHttpMethod,
  Telemetry,
  initTelemetry,
  getTelemetry,
  resetTelemetry,
  log,
  recordPlatformFault,
  recordHttpRequest,
  componentLogger,
  observabilityHttpMiddleware,
  otlpExportEnabled,
  PLATFORM_ACTOR_ID,
  PLATFORM_ACTOR_IDS,
  normalizeActorId,
  idsFromSession,
  getLogContext,
  withLogContext,
  resolveOtlpLogsConfig,
  otlpDestinationHost,
  parseOtlpLogsPayload,
  stampOtlpActorIds,
  forwardOtlpLogsPayload,
  OtelLogsBridge,
} from "./observability/index.js";
export type {
  SanitizedFields,
  LabelSet,
  DependencyStatus,
  HealthCheck,
  HealthCheckResult,
  LiveStatus,
  ReadyStatus,
  LogLevel,
  LogFields,
  LogSink,
  LoggerOptions,
  OperationalEvent,
  HttpRouteClass,
  TelemetryOptions,
  ComponentLogger,
  LogActorIds,
  OtlpLogsConfig,
  ParsedOtlpRecord,
} from "./observability/index.js";
