import type { StudioRepository } from './store/repository.js';

const defaults = {
  moveMs: 650, preClickMs: 300,
  tts: { voice: null as string | null, rate: '+0%', pitch: '+0Hz', volume: '+0%' },
  subtitle: { position: 'lowerSafe', font: 'Microsoft YaHei', sizePx: 42, color: '#FFFFFF', background: '#111111', opacity: 0.82 },
  output: { fps: 30, scale: 'nativeContain', video: 'h264', audio: 'aac' },
};
const forced = { display: 'singlePrimary', devtools: 'networkBeforeCapture', capture: 'fullDesktopWithTaskbar', input: 'pyautogui', observe: 'cdpReadOnly' } as const;
export type EffectiveProfile = typeof defaults & typeof forced;

export function resolveProfile(global: unknown = {}, project: unknown = {}): EffectiveProfile {
  const merged = deepMerge(deepMerge(defaults, applyPatch({}, validateSettings(global))), applyPatch({}, validateSettings(project)));
  return { ...merged, ...forced } as EffectiveProfile;
}

export function resolveSpeech(profile: EffectiveProfile, override: unknown) {
  const effective = applyPatch(profile.tts, validateSettings({ tts: override }).tts as Record<string, unknown>);
  const { voice, rate, pitch, volume } = effective;
  if (typeof voice !== 'string' || typeof rate !== 'string' || typeof pitch !== 'string' || typeof volume !== 'string') {
    throw new SettingsError('VALIDATION_FAILED', '请先在设置中选择普通话音色。', 422, 'tts.voice');
  }
  return { voice, rate, pitch, volume };
}

export function validateSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError('VALIDATION_FAILED', '配置必须是对象。');
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'moveMs' || key === 'preClickMs') {
      if (item !== null && !integerIn(item, key === 'moveMs' ? 100 : 50, 10000)) invalid(key);
      result[key] = item;
    } else if (key === 'tts' || key === 'subtitle' || key === 'output') {
      if (!item || typeof item !== 'object' || Array.isArray(item)) invalid(key);
      const allowed = key === 'tts' ? ['voice', 'rate', 'pitch', 'volume'] : key === 'subtitle'
        ? ['position', 'font', 'sizePx', 'color', 'background', 'opacity'] : ['fps', 'scale', 'video', 'audio'];
      const nested: Record<string, unknown> = {};
      for (const [leaf, leafValue] of Object.entries(item as Record<string, unknown>)) {
        if (!allowed.includes(leaf)) invalid(`${key}.${leaf}`);
        if (leafValue !== null && !validLeaf(leaf, leafValue)) invalid(`${key}.${leaf}`);
        nested[leaf] = leafValue;
      }
      result[key] = nested;
    } else invalid(key);
  }
  return result;
}

export function createSettingsService(repository: StudioRepository) {
  return {
    read(scope: string) {
      const record = repository.ensureSettings(scope);
      const global = scope === 'global' ? record : repository.ensureSettings('global');
      const projectValues = scope === 'global' ? {} : record.values;
      const effective = resolveProfile(global.values, projectValues);
      const sources: Record<string, string> = {};
      for (const [key, value] of Object.entries(effective)) {
        if (!(key in defaults)) { sources[key] = 'system'; continue; }
        for (const leaf of value && typeof value === 'object' ? Object.keys(value) : ['']) {
          const field = leaf ? `${key}.${leaf}` : key;
          sources[field] = hasValue(projectValues, key, leaf) ? 'project' : hasValue(global.values, key, leaf) ? 'global' : 'default';
        }
      }
      return { scope, values: record.values, effective, sources, editToken: record.editToken, updatedAt: record.updatedAt };
    },
    save(scope: string, values: unknown, ifMatch: string | null) {
      if (!ifMatch) throw new SettingsError('EDIT_PRECONDITION_REQUIRED', '保存配置必须提供 If-Match。', 428);
      const record = repository.ensureSettings(scope);
      const patch = validateSettings(values);
      const merged = applyPatch(record.values as Record<string, unknown>, patch);
      const saved = repository.compareAndSaveSettings({ scope, expectedEditToken: ifMatch.replace(/^"([^"\s]+)"$/, '$1'), values: merged, updatedAt: new Date().toISOString() });
      if (!saved.saved) throw new SettingsError('EDIT_CONFLICT', '配置已被其他操作修改，请重新读取。', 409);
      return this.read(scope);
    },
  };
}

export class SettingsError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = code === 'EDIT_CONFLICT' ? 409 : 422, readonly field?: string) { super(message); }
}

function applyPatch(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = applyPatch((result[key] as Record<string, unknown>) ?? {}, value as Record<string, unknown>);
      if (Object.keys(nested).length) result[key] = nested;
      else delete result[key];
    }
    else if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
}
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) result[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? deepMerge((result[key] as Record<string, unknown>) ?? {}, value as Record<string, unknown>) : value;
  return result;
}
function invalid(field: string): never { throw new SettingsError('VALIDATION_FAILED', `配置字段无效：${field}。`, 422, field); }

function hasValue(values: unknown, key: string, leaf: string): boolean {
  const value = (values as Record<string, unknown>)[key];
  return leaf ? Boolean(value && (value as Record<string, unknown>)[leaf] != null) : value != null;
}

function integerIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function validLeaf(leaf: string, value: unknown): boolean {
  switch (leaf) {
    case 'voice': return typeof value === 'string' && /^zh-CN-[A-Za-z]+Neural$/.test(value);
    case 'font': return typeof value === 'string' && value.trim().length > 0;
    case 'rate': case 'volume': return typeof value === 'string' && /^[+-]\d+%$/.test(value);
    case 'pitch': return typeof value === 'string' && /^[+-]\d+Hz$/.test(value);
    case 'color': case 'background': return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value);
    case 'position': return value === 'lowerSafe' || value === 'upperSafe';
    case 'sizePx': return integerIn(value, 12, 160);
    case 'opacity': return typeof value === 'number' && value >= 0 && value <= 1;
    case 'fps': return value === 15 || value === 24 || value === 25 || value === 30;
    case 'scale': return value === 'nativeContain';
    case 'video': return value === 'h264';
    case 'audio': return value === 'aac';
    default: return false;
  }
}
