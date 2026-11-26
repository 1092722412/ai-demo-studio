import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGenerated } from '../server/spec.mjs';

test('生成交付校验器保留项目字段、页面标识与技能摘要', () => {
  const generated = parseGenerated({
    skill: { name: 'bid-demo-system', sha256: 'a'.repeat(64) },
    project: {
      title: '配置比对', body: '<h1>配置比对</h1><input data-testid="routePrefix"><button data-testid="compare">比对</button>',
      css: 'body { color: #17293d; }', script: 'document.querySelector("button").onclick = () => {};',
      seedJson: '{"devices":[]}', stateJson: '{}',
      controls: [{ id: 'compare', label: '比对' }, { id: 'routePrefix', label: '路由前缀' }],
      acceptance: [{ operation: '点击比对', result: '展示实际差异' }],
    },
  });
  assert.equal(generated.title, '配置比对');
  assert.equal(generated.fields[0].id, 'compare');
  assert.equal(generated.fields[1].id, 'routePrefix');
  assert.equal(generated.skill.sha256, 'a'.repeat(64));
});

test('页面标识保留大小写，重复与非法标识有明确提示', () => {
  const result = {
    skill: { name: 'bid-demo-system', sha256: 'a'.repeat(64) },
    project: {
      title: '查询', body: '<h1>查询</h1>', css: 'body{}', script: 'void 0',
      seedJson: '{}', stateJson: '{}', acceptance: [{ operation: '查看', result: '显示' }],
      controls: [{ id: 'srcIp', label: '源 IP' }, { id: 'src_ip', label: '源 IP 文本' }],
    },
  };
  assert.deepEqual(parseGenerated(result).fields.map(({ id }) => id), ['srcIp', 'src_ip']);
  result.project.controls[1].id = 'srcIp';
  assert.throws(() => parseGenerated(result), /重复.*srcIp/);
  result.project.controls[1].id = '源Ip';
  assert.throws(() => parseGenerated(result), /第 2 个页面标识.*格式无效/);
});
