export type AiPurpose = 'discuss' | 'requirements' | 'system' | 'plan';

export type AiCapabilities = {
  streamText: boolean;
  resume: boolean;
  cancel: boolean;
  tools: boolean;
  structuredOutput: boolean;
  purposes: AiPurpose[];
};

export type ContextBundle = {
  instruction: string;
  brief: string;
  requirements: Array<{
    id: string;
    text: string;
    outcome: string;
    sourceRef: { artifactId: string; locator: string; quote: string } | null;
  }>;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  fileIndex: Array<{ artifactId: string; path: string; bytes: number }>;
  currentPlan?: unknown;
  attachmentIndex?: Array<{ artifactId: string; path: string; mime: string; bytes: number; name: string }>;
  skill: { name: string; text: string; digest: string };
  toolNames: string[];
};

export type ResolvedConnection = {
  id: string;
  kind: 'codex' | 'workbuddy' | 'api-key';
  provider: string;
  model: string;
  baseUrl?: string | null;
  credential?: string | null;
};

export type AiInput = {
  taskId: string;
  projectId: string;
  conversationId: string;
  purpose: AiPurpose;
  messageId: string;
  context: ContextBundle;
  nativeSessionRef: string | null;
  limits: { maxSteps: number; timeoutMs: number; maxOutputBytes: number };
};

export type AiEvent =
  | { type: 'session.bound'; nativeSessionRef: string }
  | { type: 'message.delta'; text: string }
  | { type: 'tool.started'; callId: string; name: string; label: string }
  | { type: 'tool.finished'; callId: string; ok: boolean; summary: string }
  | {
      type: 'permission.requested';
      requestId: string;
      description: string;
      options: string[];
      questions?: Array<{
        id: string;
        header: string;
        question: string;
        isOther: boolean;
        isSecret: boolean;
        options: Array<{ label: string; description: string }> | null;
      }>;
    };

export type ToolCallContext = { taskId: string; projectId: string; purpose: AiPurpose };
export type ToolGateway = {
  call(
    name: string,
    args: unknown,
    context: ToolCallContext,
  ): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
};

export type AiRuntime = {
  connection: ResolvedConnection;
  projectRoot: string;
  signal: AbortSignal;
  emit(event: AiEvent): Promise<void>;
  tools: ToolGateway;
  awaitPermission?(event: Extract<AiEvent, { type: 'permission.requested' }>): Promise<unknown>;
};

export type SystemDelivery = {
  kind: 'system';
  project: Record<string, unknown>;
  skill: { name: string; digest: string };
};

export type RequirementsDelivery = {
  kind: 'requirements';
  items: Array<{
    id?: string;
    text: string;
    sourceRef?: { artifactId: string; locator: string; quote: string } | null;
    outcome: string;
    confirmed: false;
  }>;
};

export type PlanDelivery = { kind: 'plan'; draft: Record<string, unknown> };
export type AiDelivery = SystemDelivery | RequirementsDelivery | PlanDelivery | null;

export type AiResult = {
  reply: string;
  nativeSessionRef: string;
  delivery: AiDelivery;
};

export type AiErrorCode =
  | 'VALIDATION_FAILED'
  | 'CONNECTION_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'REQUEST_CONFLICT'
  | 'OUTPUT_INVALID'
  | 'SOURCE_CHECK_FAILED'
  | 'LIMIT_EXCEEDED'
  | 'TIMEOUT'
  | 'WORKER_LOST'
  | 'TASK_CANCELLED';

export class AiTaskError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly retryable = false,
    readonly confirmedStopped = true,
  ) {
    super(message);
    this.name = 'AiTaskError';
  }
}

export type AiAdapter = {
  probe(connection: ResolvedConnection): Promise<{
    available: boolean;
    capabilities: AiCapabilities;
    detail: string;
  }>;
  execute(input: AiInput, runtime: AiRuntime): Promise<AiResult>;
};
