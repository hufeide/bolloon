/**
 * address-broadcast-stranger.test.ts — 全球网络「陌生人首次建联」验签链路 (2026-09-15)
 *
 * 覆盖两个已修真 bug (src/network/agent-network.ts handleAddressBroadcast):
 *   ① 未知 DID 的广播以前必然验签失败 (registry 里没对方公钥) → 陌生人永远发现不了彼此;
 *   ② 验签通过后写进 registry 的 publicKey 原来是**自己的**公钥 → 对端后续签名消息全验不过。
 *
 * 真跑: 真 Ed25519 KeyManager 生成/签名/验签, 真 did:key 派生一致性检查。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { KeyManager } from '@diap/sdk';

const tmpHome = path.join(os.tmpdir(), 'bolloon-addrbc-' + Date.now());

let AgentRegistryCtor: any;
let didKeyMatchesPublicKey: any;

beforeAll(async () => {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true });
  const mod = await import('../network/agent-network.js');
  AgentRegistryCtor = mod.AgentRegistry;
  didKeyMatchesPublicKey = mod.didKeyMatchesPublicKey;
});

afterAll(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

/** 造一个「本机 registry」并把给定 keypair 注入进去 (绕过磁盘单例) */
async function makeRegistry(kp: any) {
  const reg = new AgentRegistryCtor();
  await reg.initialize();
  (reg as any).keyPair = { privateKey: kp.privateKey, publicKey: kp.publicKey, did: kp.did };
  return reg;
}

/** 按 createSignedBroadcast 的字段顺序签名, 造一条来自 kp 的地址广播 */
async function signedBroadcast(kp: any, overrides: Record<string, unknown> = {}) {
  const pub = Buffer.from(kp.publicKey).toString('hex');
  const payload: any = {
    type: 'address_broadcast',
    from: kp.did,
    name: 'Agent-A',
    peerId: '12D3KooWPeerA',
    multiaddrs: ['/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWPeerA'],
    relayAddr: undefined,
    canRelay: false,
    publicKey: pub,
    timestamp: Date.now(),
    ...overrides,
  };
  const signed = JSON.stringify({
    type: payload.type,
    from: payload.from,
    name: payload.name,
    peerId: payload.peerId,
    multiaddrs: payload.multiaddrs,
    relayAddr: payload.relayAddr,
    canRelay: payload.canRelay,
    publicKey: payload.publicKey,
    timestamp: payload.timestamp,
  });
  const sig = await KeyManager.sign(kp, new TextEncoder().encode(signed));
  return { ...payload, signature: Buffer.from(sig).toString('hex') };
}

describe('address_broadcast 陌生人首次建联', () => {
  it('did:key ↔ 公钥 派生一致性检查可用', async () => {
    const kp = KeyManager.generate();
    expect(kp.did.startsWith('did:key:z')).toBe(true);
    expect(await didKeyMatchesPublicKey(kp.did, Buffer.from(kp.publicKey).toString('hex'))).toBe(true);
    const other = KeyManager.generate();
    expect(await didKeyMatchesPublicKey(kp.did, Buffer.from(other.publicKey).toString('hex'))).toBe(false);
    expect(await didKeyMatchesPublicKey('did:pi:not-a-key', 'aa'.repeat(32))).toBeNull();
  });

  it('陌生人广播被接受, 且登记的是「对方的」公钥 + 之后对方签名可验', async () => {
    const kpA = KeyManager.generate();
    const kpB = KeyManager.generate();
    const regB = await makeRegistry(kpB);

    const broadcast = await signedBroadcast(kpA);
    const accepted = await regB.handleAddressBroadcast(broadcast);
    expect(accepted).toBe(true);

    const entry: any = (regB as any).agents.get(kpA.did);
    expect(entry).toBeTruthy();
    // ① 修 bug: 不能是 B 自己的公钥
    expect(entry.publicKey).not.toBe(Buffer.from(kpB.publicKey).toString('hex'));
    // ② 必须是 A 的公钥 (TOFU 自证)
    expect(entry.publicKey).toBe(Buffer.from(kpA.publicKey).toString('hex'));
    expect(entry.peerId).toBe('12D3KooWPeerA');

    // ③ 关键回归: A 之后发的签名消息在 B 这里能验过 (修 bug 前必然失败)
    const msg = JSON.stringify({ type: 'hello', from: kpA.did, payload: 'p', timestamp: Date.now() });
    const sig = await KeyManager.sign(kpA, new TextEncoder().encode(msg));
    expect(await regB.verifySignature(kpA.did, msg, sig)).toBe(true);
    // 伪造签名仍然验不过
    const badSig = await KeyManager.sign(kpB, new TextEncoder().encode(msg));
    expect(await regB.verifySignature(kpA.did, msg, badSig)).toBe(false);
  });

  it('did:key 不匹配 (冒充) → 拒收', async () => {
    const kpA = KeyManager.generate();
    const kpFake = KeyManager.generate();
    const regB = await makeRegistry(KeyManager.generate());
    // 用 A 的 DID 但带 Fake 的公钥, 并用 Fake 私钥签名 → 签名本身"自洽", 只有 DID↔公钥 绑定能拦
    const broadcast = await signedBroadcast(kpA, { publicKey: Buffer.from(kpFake.publicKey).toString('hex') });
    const accepted = await regB.handleAddressBroadcast(broadcast as any);
    // 签名用的是 A 的私钥, 公钥字段是 Fake → 绑定检查发现不一致 → 拒收
    expect(accepted).toBe(false);
    expect((regB as any).agents.has(kpA.did)).toBe(false);
  });

  it('未知 DID 且不带 publicKey → 拒收 (不能盲信)', async () => {
    const kpA = KeyManager.generate();
    const regB = await makeRegistry(KeyManager.generate());
    const broadcast = await signedBroadcast(kpA, { publicKey: undefined });
    expect(await regB.handleAddressBroadcast(broadcast as any)).toBe(false);
  });

  it('已知 DID 换成另一把公钥 → 拒收且不覆盖原公钥 (身份接管防护)', async () => {
    const kpA = KeyManager.generate();
    const kpC = KeyManager.generate();
    const regB = await makeRegistry(KeyManager.generate());
    const first = await signedBroadcast(kpA);
    expect(await regB.handleAddressBroadcast(first)).toBe(true);
    const pubA = Buffer.from(kpA.publicKey).toString('hex');
    // 同一 DID 携带 C 的公钥 (签名仍用 A 私钥也不会过, 且公钥字段不一致直接拒)
    const second = await signedBroadcast(kpA, {
      publicKey: Buffer.from(kpC.publicKey).toString('hex'),
      timestamp: Date.now(),
    });
    expect(await regB.handleAddressBroadcast(second as any)).toBe(false);
    expect(((regB as any).agents.get(kpA.did)).publicKey).toBe(pubA);
  });

  it('超 24h 的陈旧广播 → 拒收', async () => {
    const kpA = KeyManager.generate();
    const regB = await makeRegistry(KeyManager.generate());
    const stale = await signedBroadcast(kpA, { timestamp: Date.now() - 25 * 60 * 60 * 1000 });
    expect(await regB.handleAddressBroadcast(stale as any)).toBe(false);
  });
});
