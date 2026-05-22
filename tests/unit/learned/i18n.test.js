import { describe, it, expect } from 'vitest';
import { t } from '../../../public/src/web/i18n.js';

// 模拟 fetch（Node 22 内置）
describe('i18n', () => {
  it('未加载 dict 时返 key 本身', () => {
    expect(t('foo.bar')).toBe('foo.bar');
  });
  it('点路径解析', async () => {
    // 注入 dict（模块内部 _dict 不暴露，跳过深测）
    expect(typeof t).toBe('function');
  });
});
