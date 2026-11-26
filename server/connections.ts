import { randomUUID } from 'node:crypto';
import type { AiAdapter, AiCapabilities, ResolvedConnection } from './ai/contracts.js';
import { createCredentialService, credentialStore, type CredentialStore } from './credentials.js';
import type { ConnectionRecord, StudioRepository } from './store/repository.js';

type ProbeResult = Awaited<ReturnType<AiAdapter['probe']>>;
type Probes = Partial<Record<ConnectionRecord['kind'], Pick<AiAdapter, 'probe'>>>;
const kinds = ['codex_app_server', 'external', 'api_key'] as const;
const optionFields = ['maxSteps', 'timeoutMs', 'maxOutputBytes'];

export function createConnectionsService(repository: StudioRepository, probes: Probes = {}, storage: CredentialStore = credentialStore) {
  const credentials = createCredentialService(storage);
  const lastProbes = new Map<string, ProbeResult & { at: string }>();
  function find(id: string) {
    const connection = repository.getConnection(id);
    if (!connection) throw new ConnectionError('VALIDATION_FAILED', 404, '未找到连接。');
    return connection;
  }
  function summary(connection: ConnectionRecord) {
    const { credentialRef, ...fields } = connection;
    return { ...fields, credentialConfigured: Boolean(credentialRef), lastProbe: lastProbes.get(connection.id) ?? null };
  }
  function commit(connection: ConnectionRecord, previous: ConnectionRecord | null) {
    return repository.transaction((tx) => {
      if (previous && tx.hasActiveConnectionTask(previous.id)) {
        throw new ConnectionError('RESOURCE_BUSY', 409, '连接正在被任务使用。');
      }
      if (previous && JSON.stringify(tx.getConnection(previous.id)) !== JSON.stringify(previous)) {
        throw new ConnectionError('EDIT_CONFLICT', 409, '连接已有修改，请重新读取。');
      }
      const saved = tx.saveConnection(connection);
      lastProbes.delete(connection.id);
      return summary(saved);
    });
  }
  async function save(id: string | null, body: unknown, clear = false) {
    const previous = id ? find(id) : null;
    if (previous && repository.hasActiveConnectionTask(previous.id)) {
      throw new ConnectionError('RESOURCE_BUSY', 409, '连接正在被任务使用。');
    }
    const input = record(body);
    const accepted = ['name', 'kind', 'provider', 'model', 'baseUrl', 'options', 'enabled', 'apiKey'];
    if (Object.keys(input).some((key) => !accepted.includes(key))) invalid();
    const kind = input.kind ?? previous?.kind;
    if (!kinds.includes(kind as ConnectionRecord['kind']) || (previous && kind !== previous.kind)) invalid('kind');
    const name = optionalText(input.name, previous?.name ?? null, 'name');
    if (!name) invalid('name');
    const now = new Date().toISOString();
    const next: ConnectionRecord = {
      id: id ?? 'conn-' + randomUUID(),
      name, kind: kind as ConnectionRecord['kind'],
      provider: optionalText(input.provider, previous?.provider ?? null, 'provider'),
      model: optionalText(input.model, previous?.model ?? null, 'model'),
      baseUrl: baseUrl(optionalText(input.baseUrl, previous?.baseUrl ?? null, 'baseUrl')),
      options: input.options === undefined ? previous?.options ?? {} : options(input.options),
      enabled: input.enabled === undefined ? previous?.enabled ?? true : flag(input.enabled),
      credentialRef: previous?.credentialRef ?? null,
      createdAt: previous?.createdAt ?? now, updatedAt: now,
    };
    if (!clear && input.apiKey === undefined) return commit(next, previous);
    const secret = clear ? null : input.apiKey;
    if (!clear && (kind !== 'api_key' || typeof secret !== 'string' || !secret.trim() || secret.length > 1200 || /[\r\n\0]/.test(secret))) invalid('apiKey');
    try {
      return await credentials.save(next.id, next.credentialRef, secret as string | null,
        (credentialRef) => commit({ ...next, credentialRef }, previous));
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError('CONNECTION_UNAVAILABLE', 503, '无法保存或清理连接凭据。');
    }
  }
  return {
    list: () => repository.listConnections().map(summary),
    create: (body: unknown) => save(null, body),
    update: (id: string, body: unknown) => save(id, body),
    clearCredential: (id: string) => save(id, {}, true),
    async probe(id: string) {
      const connection = find(id);
      const adapter = probes[connection.kind];
      let result: ProbeResult;
      if (!connection.enabled || !adapter) {
        result = { available: false, capabilities: emptyCapabilities(), detail: connection.enabled ? '该连接类型尚未接入。' : '此连接已停用。' };
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([
            (async () => {
              const credential = connection.kind === 'api_key' ? await credentials.read(connection.credentialRef) : null;
              if (connection.kind === 'api_key' && !credential) throw new ConnectionError('AUTH_REQUIRED', 401, '请先配置连接凭据。');
              const result = await adapter.probe({ ...resolveConnection(connection), credential });
              return {
                available: result.available === true,
                capabilities: {
                  streamText: result.capabilities.streamText === true, resume: result.capabilities.resume === true,
                  cancel: result.capabilities.cancel === true, tools: result.capabilities.tools === true,
                  structuredOutput: result.capabilities.structuredOutput === true,
                  purposes: result.capabilities.purposes.filter((purpose) => ['discuss', 'requirements', 'system', 'plan'].includes(purpose)),
                },
                detail: connection.kind === 'codex_app_server' ? result.detail
                  : result.available ? '连接探测通过。' : '连接探测未通过，请检查服务与凭据配置。',
              };
            })(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new ConnectionError('TIMEOUT', 504, '连接探测超时。')), 25_000);
            }),
          ]);
        } catch (error) {
          if (error instanceof ConnectionError) throw error;
          throw new ConnectionError('CONNECTION_UNAVAILABLE', 503, '连接探测失败。');
        } finally {
          clearTimeout(timer);
        }
      }
      if (JSON.stringify(repository.getConnection(id)) === JSON.stringify(connection)) {
        lastProbes.set(id, { ...result, at: new Date().toISOString() });
      }
      return result;
    },
  };
}

export function resolveConnection(connection: ConnectionRecord): ResolvedConnection {
  const kind = connection.kind === 'codex_app_server' ? 'codex' : connection.kind === 'external' ? 'workbuddy' : 'api-key';
  return { id: connection.id, kind, provider: connection.provider ?? kind, model: connection.model ?? '', baseUrl: connection.baseUrl };
}

class ConnectionError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string, readonly field?: string) { super(message); }
}

function emptyCapabilities(): AiCapabilities {
  return { streamText: false, resume: false, cancel: false, tools: false, structuredOutput: false, purposes: [] };
}

function invalid(field?: string): never {
  throw new ConnectionError('VALIDATION_FAILED', 422, '连接配置字段无效。', field);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, previous: string | null, field: string): string | null {
  if (value === undefined) return previous;
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 512) invalid(field);
  return value.trim();
}

function baseUrl(value: string | null): string | null {
  if (value === null) return null;
  let url: URL;
  try { url = new URL(value); } catch { return invalid('baseUrl'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid('baseUrl');
  return url.href;
}

function options(value: unknown) {
  const fields = Object.entries(record(value));
  for (const [key, setting] of fields) {
    if (!optionFields.includes(key) || typeof setting !== 'number' || !Number.isSafeInteger(setting) || setting <= 0) invalid('options');
  }
  return Object.fromEntries(fields);
}

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid('enabled');
  return value;
}
