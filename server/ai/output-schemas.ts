import { AiTaskError, type PlanDelivery, type RequirementsDelivery } from './contracts.js';
import type { SourceRef } from '../attachments.js';
import { planObject } from '../plans.js';

const sourceRefSchema = {
  type: 'object', additionalProperties: false, required: ['artifactId', 'locator', 'quote'],
  properties: { artifactId: { type: 'string' }, locator: { type: 'string' }, quote: { type: 'string' } },
};

export const requirementsOutputSchema = {
  type: 'object', additionalProperties: false, required: ['reply', 'items'],
  properties: {
    reply: { type: 'string' },
    items: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['text', 'outcome', 'sourceRef'],
      properties: { text: { type: 'string' }, outcome: { type: 'string' }, sourceRef: { anyOf: [sourceRefSchema, { type: 'null' }] } },
    } },
  },
};

export const planOutputSchema = {
  type: 'object', additionalProperties: false, required: ['reply', 'draftJson'],
  properties: { reply: { type: 'string' }, draftJson: { type: ['string', 'null'] } },
};

export function mapPlanOutput(value: unknown) {
  const output = planObject(value);
  if (output && Object.keys(output).length === 2 && typeof output.reply === 'string'
      && /[\u3400-\u9fff]/.test(output.reply)) {
    const reply = output.reply.trim();
    if (output.draftJson === null) return { reply, delivery: null };
    if (typeof output.draftJson === 'string') {
      try {
        const draft = planObject(JSON.parse(output.draftJson));
        if (draft) {
          const delivery: PlanDelivery = { kind: 'plan', draft };
          return { reply, delivery };
        }
      } catch {
        // 无法解析时统一返回结构错误。
      }
    }
  }
  throw new AiTaskError('OUTPUT_INVALID', 'Codex 返回的方案须为 JSON 草稿对象或 null。');
}

export function mapRequirementsOutput(value: unknown, sources: readonly SourceRef[]) {
  const output = exact(value, ['reply', 'items']);
  if (typeof output.reply !== 'string' || !/[\u3400-\u9fff]/.test(output.reply) || !Array.isArray(output.items)) invalid();
  const items: RequirementsDelivery['items'] = output.items.map((value) => {
    const item = exact(value, ['text', 'outcome', 'sourceRef']);
    if (typeof item.text !== 'string' || !item.text.trim() || typeof item.outcome !== 'string' || !item.outcome.trim()) invalid();
    let sourceRef: SourceRef | null = null;
    if (item.sourceRef !== null) {
      const { artifactId, locator, quote } = exact(item.sourceRef, ['artifactId', 'locator', 'quote']);
      if (typeof artifactId !== 'string' || typeof locator !== 'string' || typeof quote !== 'string' || !quote.trim()) invalid();
      if (!sources.some((source) => source.artifactId === artifactId && source.locator === locator && source.quote.includes(quote))) {
        throw new AiTaskError('OUTPUT_INVALID', '需求摘录与本轮读取的附件原文不一致。');
      }
      sourceRef = { artifactId, locator, quote };
    }
    return { text: item.text.trim(), outcome: item.outcome.trim(), sourceRef, confirmed: false };
  });
  const delivery: RequirementsDelivery = { kind: 'requirements', items };
  return { reply: output.reply.trim(), delivery };
}

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
      || !keys.every((key) => Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}

function invalid(): never {
  throw new AiTaskError('OUTPUT_INVALID', 'Codex 返回的需求条目未通过结构校验。');
}
