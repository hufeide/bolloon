/**
 * p2p-info.ts — 本机 P2P 连接信息出口 (2026-09-18)
 *
 * 目的: 把"我这台机器/这台手机怎么被别的智能体拨通"变成**一条可抄走的连接信息**
 *   (peerId + 可拨入 multiaddr),好递给名片/交接串/对方智能体。
 * 诚实原则: 只报真实拿到的;拿不到就说清原因与下一步,不编 peerId、不假装"能连通"。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface P2pRelayService {
  active: boolean;
  protocol?: string;
  maxReservations?: number;
  reservations?: number;
}

export interface P2pInfo {
  ok: boolean;
  /** live=本进程内节点在跑;persisted=只读到落盘记录;none=没有可用信息 */
  source: 'live' | 'persisted' | 'none';
  did?: string;
  name?: string;
  peerId?: string;
  /** 本机可被拨入的地址 (libp2p getMultiaddrs, 通常含 /p2p/<peerId>) */
  multiaddrs: string[];
  /** 经 circuit relay 的可拨入地址 */
  relayAddrs: string[];
  isRelay: boolean;
  relayService?: P2pRelayService;
  natStatus?: string;
  capabilities?: string[];
  joinedAt?: string;
  note?: string;
}

function home(): string { return process.env.HOME || os.homedir(); }

function readJsonSafe(p: string): any | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readIdentity(): { did?: string; name?: string } {
  const p = path.join(home(), '.bolloon', 'identity', 'user.json');
  const j = readJsonSafe(p);
  return { did: j?.did, name: j?.name };
}

function readGatewayJoin(): any | null {
  return readJsonSafe(path.join(home(), '.bolloon', 'gateway-join.json'));
}

/** 确保地址带 /p2p/<peerId> 段 (没有就补上, 否则对端拨不通) */
export function ensureDialable(addr: string, peerId?: string): string {
  const a = String(addr || '').trim();
  if (!a) return a;
  if (a.includes('/p2p/')) return a;
  return peerId ? `${a}/p2p/${peerId}` : a;
}

export async function getLocalP2pInfo(): Promise<P2pInfo> {
  const info: P2pInfo = { ok: false, source: 'none', multiaddrs: [], relayAddrs: [], isRelay: false };
  const id = readIdentity();
  info.did = id.did;
  info.name = id.name;

  // ① 先看本进程里节点是否真的在跑
  try {
    const mod: any = await import('../network/p2p.js');
    const net = mod.p2pNetwork;
    const node = net?.getNode?.();
    if (net && node) {
      const peerId = String(net.getNodePeerId?.() || '');
      if (peerId) {
        info.source = 'live';
        info.peerId = peerId;
        // 优先给浏览器/手机能用的 ws 地址; 没有 ws 时回退到节点真实全部地址 (不编造)
        let raw: string[] = (net.getWsMultiaddrs?.() || []).map((m: any) => String(m));
        if (!raw.length) {
          try {
            raw = (node.getMultiaddrs?.() || []).map((m: any) => String(m));
          } catch { raw = []; }
        }
        info.multiaddrs = raw.map((m) => ensureDialable(m, peerId));
        try {
          const ra: string[] = (net.getRelayAddrs?.() || []).map((m: any) => String(m));
          info.relayAddrs = ra.map((m) => ensureDialable(m, peerId));
        } catch { /* 没有中继也能继续 */ }
        try {
          const svc = net.getRelayServiceInfo?.();
          if (svc) {
            info.isRelay = !!svc.active;
            info.relayService = {
              active: !!svc.active,
              protocol: svc.protocol,
              maxReservations: svc.maxReservations,
              reservations: svc.reservations,
            };
          }
        } catch { /* 忽略 */ }
        try {
          const nat = net.getNatStatus?.();
          if (nat) info.natStatus = String(nat.status || nat.kind || JSON.stringify(nat).slice(0, 60));
        } catch { /* 忽略 */ }
      }
    }
  } catch { /* 客户端环境没有 p2p 模块 → 走落盘记录 */ }

  // ② 落盘记录兜底 (CLI 一次性命令里节点通常没跑)
  const gj = readGatewayJoin();
  if (gj) {
    info.joinedAt = gj.joinedAt;
    info.capabilities = Array.isArray(gj.capabilities) ? gj.capabilities : undefined;
    if (!info.peerId && gj.peerId) { info.peerId = String(gj.peerId); info.source = 'persisted'; }
    if (!info.did && gj.did) info.did = String(gj.did);
    if (!info.name && gj.name) info.name = String(gj.name);
  }

  if (info.peerId && !info.multiaddrs.length) {
    info.note = '只拿到 peerId (落盘记录), 当前进程没有运行中的 P2P 节点 → 可拨入地址需要一个在跑的节点来生成 '
      + '(启动: `bolloon --web` 或让智能体执行 join_global_gateway; 之后在此重跑 `bolloon p2p`)';
  } else if (!info.peerId) {
    info.note = '还没有本机 peerId: 先让智能体入网 (read https://bolloon.cn/bolloon-gateway-join.md) 或启动 P2P 节点, 再跑 `bolloon p2p`';
  } else if (!info.multiaddrs.length) {
    info.note = '节点在跑, 但当前没有被拨入地址 (可能只有拨出能力); 若在手机端需先建立 relay 预约';
  } else {
    info.note = undefined;
  }

  info.ok = !!info.peerId;
  return info;
}

/** 人可读 + 可直接抄进小工具/名片 (peerId 与 multiaddr 分开列, 方便逐项粘贴) */
export function formatP2pInfoText(info: P2pInfo): string {
  const lines: string[] = [];
  lines.push('── 本机 P2P 连接信息 ──────────────────────────────');
  lines.push(`来源: ${info.source === 'live' ? '运行中的节点 (live)' : info.source === 'persisted' ? '落盘记录 (persisted)' : '无'}`);
  if (info.name) lines.push(`名称: ${info.name}`);
  if (info.did) lines.push(`身份: ${info.did}`);
  lines.push(`peerId: ${info.peerId || '(未拿到)'}`);
  if (info.capabilities?.length) lines.push(`能力: ${info.capabilities.join(', ')}`);
  if (info.natStatus) lines.push(`NAT: ${info.natStatus}`);
  lines.push(`本机是中继: ${info.isRelay ? '是' : '否'}${info.relayService?.active ? ` (协议 ${info.relayService.protocol || '-'}, 预约 ${info.relayService.reservations ?? '-'}/${info.relayService.maxReservations ?? '-'})` : ''}`);
  if (info.multiaddrs.length) {
    lines.push('可拨入地址:');
    for (const m of info.multiaddrs.slice(0, 6)) lines.push(`  ${m}`);
  } else {
    lines.push('可拨入地址: (当前没有 —— 对端暂时拨不进来)');
  }
  if (info.relayAddrs.length) {
    lines.push('经中继可拨入:');
    for (const m of info.relayAddrs.slice(0, 4)) lines.push(`  ${m}`);
  }
  if (info.note) lines.push(`说明: ${info.note}`);
  lines.push('── 抄进小工具: 地址填上面的 multiaddr (含 /p2p/ 段), peerId 填上面的 peerId ──');
  return lines.join('\n');
}

/** 机器可读 (给小工具/App/验收脚本用; 字段名与名片里的 p2p 结构对齐) */
export function formatP2pInfoJson(info: P2pInfo): string {
  const primary = info.relayAddrs[0] || info.multiaddrs[0] || '';
  return JSON.stringify({
    schema: 'bolloon-p2p-info/1',
    ok: info.ok,
    source: info.source,
    did: info.did || '',
    name: info.name || '',
    peerId: info.peerId || '',
    multiaddr: primary,
    multiaddrs: info.multiaddrs,
    relayAddrs: info.relayAddrs,
    isRelay: info.isRelay,
    relayService: info.relayService || null,
    natStatus: info.natStatus || null,
    capabilities: info.capabilities || [],
    note: info.note || null,
    /** 直接可用的名片字段 (小工具 agent-card 的 p2p 结构) */
    cardP2p: { peerId: info.peerId || '', multiaddr: primary, relay: info.isRelay ? (info.peerId || '') : '' },
  }, null, 2);
}
