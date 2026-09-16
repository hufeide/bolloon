/**
 * mobile-privacy.test.ts — 隐私合规逻辑单测 (上架红线, 不允许只靠肉眼看 UI)
 *
 * 锁住四件事:
 *   ① 同意门判定 (未同意/版本过期/非法值 必须要求同意)
 *   ② 应用内政策摘要必须覆盖上架必填要素 (删要素即红) —— 且不许写与代码事实不符的话
 *   ③ 注销清单必须与"实际存在的库/键"一致 (库名改了忘改清单 = 合规缺口, 用源码文本交叉断言)
 *   ④ wipeLocalData 真删 (清 localStorage 键 + 删 4 个库), 且保留同意记录与界面偏好
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import 'fake-indexeddb/auto';

import {
  PRIVACY_CONSENT_KEY,
  PRIVACY_CONSENT_VERSION,
  PRIVACY_POLICY_URL,
  PRIVACY_SUMMARY,
  CONSENT_TEXT,
  WIPE_TARGETS,
  WIPE_NOTICE,
  WIPE_SLA_WORKDAYS,
  needsPrivacyConsent,
  consentRecord,
  filingDisplay,
  wipeLocalData,
} from '../web/mobile-privacy.ts';

const ROOT = process.cwd();

function makeLocalStorage() {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => void map.clear(),
    _map: map,
  };
}

let ls: ReturnType<typeof makeLocalStorage>;
beforeEach(() => {
  ls = makeLocalStorage();
  (globalThis as any).localStorage = ls;
});
afterEach(() => {
  delete (globalThis as any).localStorage;
});

describe('① 同意门判定', () => {
  it('未同意 / 未记录 → 需要弹门', () => {
    expect(needsPrivacyConsent(null)).toBe(true);
    expect(needsPrivacyConsent(undefined)).toBe(true);
    expect(needsPrivacyConsent('')).toBe(true);
  });

  it('版本不匹配 (政策实质变更后) → 重新征求同意', () => {
    expect(needsPrivacyConsent('0')).toBe(true);
    expect(needsPrivacyConsent(String(Number(PRIVACY_CONSENT_VERSION) + 1))).toBe(true);
    expect(needsPrivacyConsent('agreed')).toBe(true);
  });

  it('已同意当前版本 → 不再弹门 (允许首尾空白)', () => {
    expect(needsPrivacyConsent(PRIVACY_CONSENT_VERSION)).toBe(false);
    expect(needsPrivacyConsent(` ${PRIVACY_CONSENT_VERSION} `)).toBe(false);
    expect(needsPrivacyConsent(consentRecord())).toBe(false);
  });

  it('政策链接是 https 且指向 bolloon.cn/privacy.html', () => {
    expect(PRIVACY_POLICY_URL).toBe('https://bolloon.cn/privacy.html');
  });

  it('同意门文案齐备 (标题/正文/两个按钮/退出路径)', () => {
    for (const k of ['title', 'intro', 'agree', 'decline', 'policyLink',
      'declinedTitle', 'declinedBody', 'declinedReread', 'declinedExit'] as const) {
      expect(String(CONSENT_TEXT[k]).trim().length, `CONSENT_TEXT.${k}`).toBeGreaterThan(0);
    }
    expect(CONSENT_TEXT.intro).toContain('不会读取本机数据');
  });
});

describe('② 应用内政策摘要 (上架必填要素)', () => {
  const flat = PRIVACY_SUMMARY.map((s) => `${s.title}\n${s.body}`).join('\n');

  it('至少 6 个小节, 每节都有标题与正文', () => {
    expect(PRIVACY_SUMMARY.length).toBeGreaterThanOrEqual(6);
    for (const s of PRIVACY_SUMMARY) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.body.trim().length).toBeGreaterThan(10);
    }
  });

  it.each([
    ['收集类型', '收集什么'],
    ['用途', '用途'],
    ['存储位置', '存储'],
    ['保存期限', '期限'],
    ['第三方服务/SDK 清单', '第三方'],
    ['权限说明', '系统权限'],
    ['注销路径', '清除本机数据（注销）'],
    ['处理时限', `${WIPE_SLA_WORKDAYS} 个工作日`],
    ['联系方式', '@'],
  ])('含必填要素: %s', (_label, needle) => {
    expect(flat).toContain(needle);
  });

  it('不写与代码事实不符的话 (无统计 SDK / 权限上限 / 无障碍仅直装版 / 链上不可删)', () => {
    expect(flat).toContain('不集成任何广告、行为统计或崩溃上报 SDK');
    expect(flat).toContain('maxSdkVersion=30');
    expect(flat).toContain('neverForLocation');
    expect(flat).toContain('仅官网直装版本包含');
    expect(flat).toContain('区块链');
  });

  it('注销说明如实包含链上记录不可删', () => {
    expect(WIPE_NOTICE).toContain('无法删除');
    expect(WIPE_NOTICE).toContain(`${WIPE_SLA_WORKDAYS} 个工作日`);
  });
});

describe('③ 注销清单与实际存储一致 (源码交叉断言)', () => {
  it('清单里的 4 个库名真的存在于模块源码里 / 每个库都有删除路径', () => {
    const files = {
      'bolloon-mobile-data': 'src/web/mobile-data.ts',
      'bolloon-mobile': 'src/web/mobile-agent.ts',
      'bolloon-mobile-payments': 'src/web/mobile-payments.ts',
      bolloon: 'src/web/mobile-wallet.ts',
    } as const;
    for (const [db, file] of Object.entries(files)) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(src, `${file} 应声明库名 ${db}`).toMatch(new RegExp(`['"]${db}['"]`));
      expect(WIPE_TARGETS.databases as readonly string[]).toContain(db);
    }
  });

  it('没有第 5 个库被漏掉 (扫 src/web 里所有 indexedDB.open 的库名)', () => {
    const declared = new Set<string>(WIPE_TARGETS.databases as readonly string[]);
    const consts = new Map<string, string>();
    for (const f of fs.readdirSync(path.join(ROOT, 'src/web'))) {
      if (!f.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(ROOT, 'src/web', f), 'utf8');
      for (const m of src.matchAll(/const\s+(\w*DB\w*)\s*=\s*['"]([^'"]+)['"]/g)) consts.set(m[1], m[2]);
      for (const m of src.matchAll(/indexedDB\.open\(\s*['"]([^'"]+)['"]/g)) {
        expect(declared.has(m[1]), `${f} 直接 open 的库 ${m[1]} 不在注销清单里`).toBe(true);
      }
    }
    // 常量形式的库名也必须都在清单里 (mobile-wallet.ts 用的是 DB_NAME='bolloon')
    for (const [name, db] of consts) {
      if (/data|identity|payments|wallet/i.test(name) || db.startsWith('bolloon')) {
        expect(declared.has(db), `常量 ${name}='${db}' 不在注销清单里`).toBe(true);
      }
    }
  });

  it('保留键不含个人信息, 且必须保留同意记录', () => {
    expect(WIPE_TARGETS.keep as readonly string[]).toContain(PRIVACY_CONSENT_KEY);
    expect(WIPE_TARGETS.keep as readonly string[]).toContain('bolloon-lang');
  });

  it('备案号未填时如实说明「备案办理中」, 填了才展示编号', () => {
    expect(filingDisplay('')).toContain('备案办理中');
    expect(filingDisplay('  ')).toContain('备案办理中');
    expect(filingDisplay('浙ICP备12345678号-1A')).toBe('APP 备案号 浙ICP备12345678号-1A');
  });
});

describe('④ wipeLocalData 真删', () => {
  it('清掉本机键、保留同意与偏好、删掉 4 个库且无失败项', async () => {
    ls.setItem(PRIVACY_CONSENT_KEY, PRIVACY_CONSENT_VERSION);
    ls.setItem('bolloon-lang', 'en');
    ls.setItem('bolloon_theme', 'dark');
    ls.setItem('bolloon_avatar', 'data:image/jpeg;base64,xxx');
    ls.setItem('bolloon_mobile_peers', '["did:blln:abc"]');
    ls.setItem('bolloon.removedRemoteChannels', '[]');
    ls.setItem('unrelated-key', 'keep-me');

    const r = await wipeLocalData();

    expect(r.failed, JSON.stringify(r.failed)).toEqual([]);
    expect(r.deletedDatabases.sort()).toEqual(
      [...(WIPE_TARGETS.databases as readonly string[])].sort(),
    );
    expect(r.clearedStorageKeys).toContain('bolloon_avatar');
    expect(r.clearedStorageKeys).toContain('bolloon_mobile_peers');
    expect(r.clearedStorageKeys).toContain('bolloon.removedRemoteChannels');
    expect(ls.getItem('bolloon_avatar')).toBeNull();
    expect(ls.getItem(PRIVACY_CONSENT_KEY)).toBe(PRIVACY_CONSENT_VERSION);
    expect(ls.getItem('bolloon-lang')).toBe('en');
    expect(ls.getItem('unrelated-key')).toBe('keep-me');
  });

  it('IDB 真的被删 (删后可重新 open 且为空)', async () => {
    const { saveChannels, getChannels } = await import('../web/mobile-data.ts');
    await saveChannels([{ id: 'x', name: 'agent-x' }] as any);
    expect((await getChannels()).length).toBeGreaterThan(0);
    await wipeLocalData();
    expect((await getChannels()).length).toBe(0);
  });
});
