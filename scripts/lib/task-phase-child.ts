/**
 * task-phase-child.ts — 任务阶段的子进程夹具 (给恢复验收用真 SIGKILL)
 *
 * 环境变量:
 *   CHILD_HOME         隔离的 HOME
 *   CHILD_TASK         任务文本
 *   BOLLOON_TASK_FAULT 故障点 (before_payment / after_payment / after_install / before_execute / after_execute)
 *
 * 进程会在故障点被真 SIGKILL (由 task-runner 的 faultPoint 触发), 因此父进程要
 * 通过 `listGoals()` 找它留下的 Goal + 交易事实。
 */
const home = process.env.CHILD_HOME!;
const task = process.env.CHILD_TASK!;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.BOLLOON_X402_LOCAL_VERIFY = '1';

const path = await import('path');
const { runTask } = await import('../../src/agents/task/task-runner.js');
const fixtures = path.resolve('scripts/fixtures/skills');

const r = await runTask({ task, budget: '0.05', home, skillPaths: [fixtures] });
console.log(`CHILD_DONE ok=${r.ok} goal=${r.goalId} status=${r.card.status}`);
process.exit(0);
