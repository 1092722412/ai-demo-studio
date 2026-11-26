export type Project = {
  id: string;
  title: string;
  brief: string;
  stage: string;
  connectionId: string | null;
  currentSourceId: string | null;
  currentVideoId: string | null;
  currentConversationId: string | null;
  activeTasks: string[];
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  conversationId: string;
  taskId: string | null;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  state: 'pending' | 'complete' | 'partial';
  createdAt: string;
};

export type Task = {
  taskId: string;
  projectId: string;
  conversationId: string | null;
  kind: string;
  purpose: string | null;
  state: 'queued' | 'running' | 'waiting_input' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  phase: string;
  result: unknown;
  error: { code: string; message: string; retryable: boolean } | null;
  lastSeq: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};

export type TaskEvent = {
  taskId: string;
  seq: number;
  type: string;
  at: string;
  payload: Record<string, unknown>;
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly field?: string, readonly taskId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = payload?.error ?? {};
    throw new ApiError(
      typeof failure.message === 'string' ? failure.message : '本地工作台请求失败。',
      response.status,
      typeof failure.code === 'string' ? failure.code : 'CONNECTION_UNAVAILABLE',
      typeof failure.field === 'string' ? failure.field : undefined,
      typeof failure.taskId === 'string' ? failure.taskId : undefined,
    );
  }
  return payload.data as T;
}

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const api = {
  listProjects: () => request<Project[]>('/api/v1/projects'),
  getProject: (id: string) => request<Project>(`/api/v1/projects/${encodeURIComponent(id)}`),
  createProject: (body: { title: string; brief: string }) => request<Project>('/api/v1/projects', json(body)),
  patchProject: (id: string, body: { title?: string; brief?: string }) =>
    request<Project>(`/api/v1/projects/${encodeURIComponent(id)}`, json(body, 'PATCH')),
  listMessages: (projectId: string, conversationId?: string | null) => {
    const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';
    return request<{ conversationId?: string; items: Message[]; nextAfterId: string | null }>(`/api/v1/projects/${encodeURIComponent(projectId)}/messages${query}`);
  },
  postMessage: (projectId: string, body: { requestId: string; conversationId?: string; purpose: 'discuss'; text: string }) =>
    request<{ taskId: string; projectId: string; conversationId: string; state: Task['state']; requestId: string }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/messages`, json(body),
    ),
  getTask: (taskId: string) => request<Task>(`/api/v1/tasks/${encodeURIComponent(taskId)}`),
  respondInput: (taskId: string, body: { requestId: string; choice?: string; text?: string; response?: Record<string, unknown> }) =>
    request<Task>(`/api/v1/tasks/${encodeURIComponent(taskId)}/input`, json(body)),
  cancelTask: (taskId: string) => request<Task>(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, json({ reason: 'user-requested' })),
};

export function isTaskActive(state: Task['state'] | undefined): boolean {
  return state === 'queued' || state === 'running' || state === 'waiting_input' || state === 'cancelling';
}
