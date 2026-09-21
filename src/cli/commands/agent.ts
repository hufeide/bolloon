/**
 * agent.ts — P3 `bolloon agent register|manifest|discover|inspect`
 *
 * 全部是现有服务的薄包装:
 *   register → `agent-gateway.gatewayRegisterAgent()` (warm registry + 写服务声明, 落 ~/.bolloon/agent-registry.json)
 *              `--manifest` 时另调 `agent-manifest-protocol.setLocalManifest()` (进程内, 不落盘 —— 如实标注)
 *   manifest → `agent-manifest-protocol.getLocalManifest()`
 *   discover → `agent-registry.discover(q)` (OrbitDB 优先, 失败回退本地文件)
 *   inspect  → `agent-registry.list()` 按 agentId 命中 / 远端 manifest 缓存 (`getRemoteManifests`)
 *
 * 找不到能力 → §3 `CAPABILITY_NOT_FOUND` (next_action `redefine_capability`); **绝不**因此发起付款 (§9 第 3 条)。
 */

import {
  type CliFlags, type CommandResult, okEnvelope, failEnvelope,
  line, title, hint, plain, opt, has,
} from '../protocol-envelope.js';

export const AGENT_USAGE = `
${title('bolloon agent')}
  bolloon agent discover <能力> [--json]       按能力发现服务 (registry, OrbitDB 优先/本地回退)
  bolloon agent register --capability <能力> [--name 名] [--price 0.05] [--per query] [--description 说明] [--wallet 0x..]
  bolloon agent manifest [--json]              本进程内的 manifest (agents/capabilities)
  bolloon agent inspect <agentId|能力> [--json] 看某个 agent 的声明 (钱包/服务/能力/信誉)

选项: --json · --quiet · --request-id <id> · --timeout <ms>
`;

/** registry 预热 (有界): CLI 一次性命令里不许无限等 OrbitDB */
async function warmBounded(ms: number): Promise<boolean> {
  try {
    const { warmAgentRegistry } = await import('../../agents/agent-registry.js');
    return await Promise.race([
      warmAgentRegistry().then((v) => !!v),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  } catch { return false; }
}

async function localDid(): Promise<string> {
  const { getUserOwnerDid } = await import('../../agents/agent-identity.js');
  const fromUser = getUserOwnerDid();
  if (fromUser) return fromUser;
  try {
    const { getGatewayJoinState } = await import('../../agents/gateway-join.js');
    const st = await getGatewayJoinState();
    return String(st?.did || '');
  } catch { return ''; }
}

export async function agentCommand(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[0];
  switch (sub) {
    case 'register': return agentRegister(flags);
    case 'manifest': return agentManifest(flags);
    case 'discover': return agentDiscover(flags);
    case 'inspect': return agentInspect(flags);
    default:
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 agent 子命令: ${sub}` : '缺少 agent 子命令', { usage: plain(AGENT_USAGE.trim()) }, [], 'needs_human'),
        human: AGENT_USAGE,
      };
  }
}

// ── agent discover ──────────────────────────────────────────────────────────

async function agentDiscover(flags: CliFlags): Promise<CommandResult> {
  const q = flags.positionals[1] || opt(flags, '--capability') || '';
  const ready = await warmBounded(flags.timeoutMs ?? 8_000);
  const { getAgentRegistry } = await import('../../agents/agent-registry.js');
  const reg = getAgentRegistry(await localDid() || 'local');
  const hits = await reg.discover(q);
  const data = {
    query: q,
    count: hits.length,
    registryReady: ready,
    services: hits.map((s) => ({
      agentId: s.agentId, name: s.name, wallet: s.wallet,
      capability: s.service?.name, description: s.service?.description,
      price: s.service?.price, capabilities: s.capabilities || [],
    })),
  };
  if (!hits.length) {
    return {
      // §3 CAPABILITY_NOT_FOUND: ✅可重试 (**只重查发现**, 绝不因此重发付款)
      envelope: failEnvelope('CAPABILITY_NOT_FOUND', q ? `registry 里找不到能力/关键字 '${q}'` : 'registry 里没有任何服务声明', data, [], 'redefine_capability'),
      human: `${title('bolloon agent discover')}\n${line('查询', q || '(全部)')}\n  没找到 (registry ready=${ready})\n\n${hint('下一步: 换关键词重查 (发现是只读的, 重试安全); 或让对方先声明能力 —— 查不到 ≠ 网络上没有, 更不要因此付款')}`,
    };
  }
  return {
    envelope: okEnvelope('OK', `找到 ${hits.length} 个匹配 '${q || '全部'}' 的服务`, data, hits.map((s) => s.agentId), null),
    human: [
      title(`bolloon agent discover ${q || '(全部)'}`),
      line('命中', `${hits.length} 个 (registry ready=${ready})`),
      ...hits.slice(0, 20).map((s) => `\n   ${s.name} [${s.service?.name}] ${s.service?.price?.amount || '?'} ${s.service?.price?.currency || ''}/${s.service?.price?.per || ''}\n     agentId: ${s.agentId}\n     wallet:  ${s.wallet || '(无)'}`),
    ].join('\n'),
  };
}

// ── agent register ──────────────────────────────────────────────────────────

async function agentRegister(flags: CliFlags): Promise<CommandResult> {
  const capability = opt(flags, '--capability') || flags.positionals[1];
  if (!capability) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 --capability (要声明什么能力)', { usage: plain(AGENT_USAGE.trim()) }, [], 'needs_human'),
      human: `${AGENT_USAGE}\n${hint('示例: bolloon agent register --capability research --price 0.05 --per query --name 我的研究体')}`,
    };
  }
  const did = await localDid();
  if (!did) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '本机还没有 DID 身份, 无法声明能力', { did: '' }, [], 'needs_human'),
      human: `${title('bolloon agent register')}\n  本机还没有 DID 身份\n\n${hint('下一步: bolloon setup (生成 ~/.bolloon/identity/user.json) 或 bolloon network join 入网')}`,
    };
  }
  const name = opt(flags, '--name') || 'bolloon-agent';
  const wallet = opt(flags, '--wallet') || '';
  const { gatewayRegisterAgent } = await import('../../agents/agent-gateway.js');
  const r = await gatewayRegisterAgent(
    {
      capability,
      price: opt(flags, '--price') || '0',
      currency: opt(flags, '--currency') || 'USDC',
      per: opt(flags, '--per') || 'query',
      description: opt(flags, '--description'),
      wallet,
      endpoint: opt(flags, '--endpoint'),
    } as any,
    { did, name, wallet },
  );

  // `--manifest`: 额外登记进程内 manifest (agent-manifest-protocol **不落盘**, 如实标注)
  let manifest: Record<string, unknown> | null = null;
  if (has(flags, '--manifest')) {
    const { setLocalManifest, getLocalManifest } = await import('../../agents/agent-manifest-protocol.js');
    setLocalManifest({ ownerName: name, ownerPublicKey: did, agents: [{ id: `${name}-main`, name, capabilities: [capability], status: 'active' }] });
    const m = getLocalManifest();
    manifest = { registered: (m.agents || []).length > 0, persisted: false, agents: (m.agents || []).map((a) => a.id) };
  }

  const data = { agentId: did, name, capability, wallet: wallet || null, registryPath: '~/.bolloon/agent-registry.json', manifest };
  if (!r.ok) {
    return {
      envelope: failEnvelope('INTERNAL_ERROR', `服务声明没写成功: ${r.error || '未知原因'}`, data, [did], 'needs_human'),
      human: `${title('bolloon agent register')}\n  ✗ 没写成功: ${r.error || '未知原因'}`,
    };
  }
  return {
    envelope: okEnvelope('AGENT_REGISTERED', `已声明能力 '${capability}' (agentId=${did})`, data, [did], null),
    human: `${title('bolloon agent register')}\n${line('agentId', did)}\n${line('名称', name)}\n${line('能力', capability)}\n${line('价格', `${opt(flags, '--price') || '0'} ${opt(flags, '--currency') || 'USDC'}/${opt(flags, '--per') || 'query'}`)}\n${line('账号钱包', wallet || '(未给)')}${manifest ? `\n${line('manifest', manifest.registered ? '本进程已登记 (不落盘)' : '登记后读回为空')}` : ''}\n\n${hint('下一步: bolloon agent discover ' + capability + ' 自查能不能被发现')}`,
  };
}

// ── agent manifest ──────────────────────────────────────────────────────────

async function agentManifest(flags: CliFlags): Promise<CommandResult> {
  const { getLocalManifest, getRemoteManifests } = await import('../../agents/agent-manifest-protocol.js');
  const m = getLocalManifest();
  const remote = getRemoteManifests();
  const data = {
    scope: 'in-process',
    persisted: false,
    ownerName: m.ownerName || '',
    ownerPublicKey: m.ownerPublicKey || '',
    publishedAt: m.publishedAt || 0,
    agents: (m.agents || []).map((a) => ({ id: a.id, name: a.name, capabilities: a.capabilities, status: a.status })),
    remoteManifests: remote.map((r) => ({ ownerPublicKey: r.ownerPublicKey, ownerName: r.ownerName, agents: (r.agents || []).length })),
    note: 'local manifest 是**进程内**结构 (agent-manifest-protocol 不落盘): 一次性 CLI 命令里读不到 = 这个进程还没登记过, 不等于本机没注册过 (注册发生在运行中的 Runtime 进程内)',
  };
  return {
    envelope: okEnvelope('OK', `本进程 manifest: agents=${data.agents.length}, 远端缓存=${remote.length} 份`, data, data.ownerPublicKey ? [data.ownerPublicKey] : [], null),
    human: [
      title('bolloon agent manifest (本进程)'),
      line('ownerName', data.ownerName || '(空)'),
      line('ownerDid', data.ownerPublicKey || '(空)'),
      line('agents', data.agents.length),
      ...data.agents.map((a) => `      · ${a.id} [${a.capabilities.join(',')}] ${a.status}`),
      line('远端 manifest 缓存', remote.length),
      `\n  ${data.note}`,
    ].join('\n'),
  };
}

// ── agent inspect ───────────────────────────────────────────────────────────

async function agentInspect(flags: CliFlags): Promise<CommandResult> {
  const target = flags.positionals[1] || opt(flags, '--capability') || '';
  if (!target) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少要查看的 agentId 或能力名', { usage: plain(AGENT_USAGE.trim()) }, [], 'needs_human'),
      human: AGENT_USAGE,
    };
  }
  const ready = await warmBounded(flags.timeoutMs ?? 8_000);
  const { getAgentRegistry } = await import('../../agents/agent-registry.js');
  const reg = getAgentRegistry((await localDid()) || 'local');
  const all = await reg.list();
  const byId = all.find((s) => s.agentId === target);
  const byCap = byId ? undefined : all.find((s) => (s.capabilities || []).includes(target) || s.service?.name === target);
  const hit = byId || byCap;
  if (hit) {
    return {
      envelope: okEnvelope('OK', `找到 ${hit.agentId}`, {
        registryReady: ready, matchedBy: byId ? 'agentId' : 'capability',
        agent: {
          agentId: hit.agentId, name: hit.name, wallet: hit.wallet,
          service: hit.service, capabilities: hit.capabilities || [],
          endpoint: hit.endpoint || null, reputation: hit.reputation || null,
          registeredAt: hit.registeredAt || null, updatedAt: hit.updatedAt || null,
        },
      }, [hit.agentId], null),
      human: [
        title(`bolloon agent inspect ${target}`),
        line('agentId', hit.agentId),
        line('名称', hit.name),
        line('能力', (hit.capabilities || []).join(', ')),
        line('服务', `${hit.service?.name} — ${hit.service?.description || ''}`),
        line('价格', `${hit.service?.price?.amount} ${hit.service?.price?.currency}/${hit.service?.price?.per}`),
        line('收款钱包', hit.wallet || '(未声明)'),
        line('信誉', hit.reputation ? `${hit.reputation.score} (${hit.reputation.tasks} 次)` : '(无记录)'),
        line('更新时间', hit.updatedAt || '(无)'),
      ].join('\n'),
    };
  }
  // 远端 manifest 缓存兜底 (对方节点握手时换来的人)
  const { getRemoteManifests } = await import('../../agents/agent-manifest-protocol.js');
  const remoteHit = getRemoteManifests().find((r) => r.ownerPublicKey === target || (r.agents || []).some((a) => a.id === target || (a.capabilities || []).includes(target)));
  if (remoteHit) {
    return {
      envelope: okEnvelope('OK', `在远端 manifest 缓存里找到 ${target}`, {
        registryReady: ready, matchedBy: 'remote-manifest',
        owner: { ownerPublicKey: remoteHit.ownerPublicKey, ownerName: remoteHit.ownerName },
        agents: (remoteHit.agents || []).map((a) => ({ id: a.id, name: a.name, capabilities: a.capabilities, status: a.status })),
      }, [remoteHit.ownerPublicKey], null),
      human: `${title(`bolloon agent inspect ${target}`)}\n${line('来源', '远端 manifest 缓存 (P2P 握手换来)')}\n${line('owner', `${remoteHit.ownerName} ${remoteHit.ownerPublicKey}`)}\n${(remoteHit.agents || []).map((a) => `      · ${a.id} [${(a.capabilities || []).join(',')}]`).join('\n')}`,
    };
  }
  return {
    envelope: failEnvelope('CAPABILITY_NOT_FOUND', `registry 与远端缓存里都没有 '${target}'`, { registryReady: ready, query: target, knownAgents: all.map((s) => s.agentId) }, [], 'redefine_capability'),
    human: `${title(`bolloon agent inspect ${target}`)}\n  没找到 (registry ready=${ready}, 本机已知 ${all.length} 个服务)\n\n${hint('下一步: bolloon agent discover <关键字> 换词重查 (只读, 重试安全)')}`,
  };
}
