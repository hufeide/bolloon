# minitools — 小红书小工具 (离线 H5 zip) 工作区

事实来源: **`.skill/minitool-zip-builder/` v1.6.0**(官方构建指南, 含 7 篇 reference + 2 个审计脚本)。
**动手改代码前必须先读对应 reference**(SKILL.md 的硬要求, 不要凭记忆写)。

## 一句话约束 (详细以 reference 为准)

| 维度 | 硬约束 |
|---|---|
| 包结构 | `index.html` **必须在 zip 根目录**;压缩的是"目录内容"不是目录本身;禁 `node_modules`/`.git`/`.DS_Store`/`*.map`/构建配置 |
| 文件类型 | 只允许 `.html .css .js .png .jpg .jpeg .gif .webp .svg .woff .woff2 .json` |
| 脚本 | **必须外置** `<script src="./app.js">`;**经典脚本**(无 `type="module"`、无 `import/export`);无内联 `<script>`、无 `onclick=`、无 `javascript:`;无 `eval`/`new Function`/WASM |
| 网络 | **纯本地不联网**: 无 `fetch`/XHR/WebSocket/EventSource;所有资源(含字体)必须打进包, 相对路径 `./assets/...`, 禁绝对路径与 `<base>` |
| 端能力 | 禁: 定位 / 剪贴板 API / 蓝牙USB HID串口 / 传感器 / Worker / 屏幕共享 / requestFullscreen / 电池连接信息 / WebAuthn / `window.open` / `window.prompt` / `location.href` 跳转 / `target="_blank"` / `<a download>` / iframe / `<form>` 跳转提交 |
| 可用 | DOM/CSS/Canvas2D/WebGL · `localStorage`/`IndexedDB`/Cookie · `<input type="file">` · `getUserMedia`(用户手势+授权) · `alert`/`confirm` · `window.xhs.miniTool.*`(JSBridge, 参数以 `jsbridge-api.md` 为准) |
| 内核基线 | JS 面向 **Chrome 61 / ES2017**;CSS 用「Chrome 61 基线层 + 能力检测增强层」, 只为实际用到的现代特性做局部回退 |
| 体积 | zip **≤10 MiB**(建议 ≤2 MiB);单条 Base64 解码 ≤1 MiB(>100 KiB 优先改独立文件);文本解压合计 >5 MiB 要人工复核 |
| WebGL | 只在确需时用;DPR ≤min(dpr,1.5)、像素 ≤200 万、纹理边长 ≤2048、显存 ≤64 MiB、draw call ≤100/帧、三角 ≤100k/帧;必须有降档 + `visibilitychange` 暂停 + `webglcontextlost` 兜底 + 非 WebGL 兜底 |

## 流水线

```bash
node minitools/build.mjs                    # 校验 + 打包 minitools/starter
node minitools/build.mjs minitools/<工具名>  # 指定工具 (里面要有 src/)
```

`build.mjs` 做三件事:

1. **结构 + CSP + 端能力 + 体积**静态门禁(ERROR 直接拒绝打包, 按 spec §6 / device-capabilities §7 / performance-budget §1 逐条实现);
2. 调用 skill 自带的 `audit_artifact.mjs` 与 `audit_artifact.py`(两个运行时都跑, 原样打印);
3. **打包并复核 zip** —— `cd src && zip -r ... .`(保证 `index.html` 在根)、再检查包内没有系统垃圾/禁止文件/超限。

退出码: `0` 无 ERROR · `1` 有 ERROR(不产出 zip) · `2` 环境/用法错误。

> 注意: skill 自带的两个审计脚本**只做体积检查**(目录文本体积、zip ≤10MiB), 对"内联脚本/外部引用/禁用 API/路径穿越"这类问题会报 `PASS`。
> 所以 `build.mjs` 的第二层门禁不是可选项 —— 实测一个含 14 处违规的目录, 两个官方脚本都 PASS, 只有本流水线拦住了。

## 自检要点(交付前逐条过)

- [ ] 通读 `index.html`: DOCTYPE / `lang` / `charset` / viewport 含 `width=device-width, initial-scale=1.0, viewport-fit=cover`
- [ ] 事件全部 `addEventListener`;视图切换用 JS 切 DOM(单页), 不用跳转
- [ ] 每个 `<script src>` / `<link href>` / `<img src>` 的资源都真的在包内, 且是 `./` 相对路径
- [ ] 被禁能力**无调用、无残留**(用 `device-capabilities.md` §7 清单 grep 一遍)
- [ ] 长列表分页/虚拟滚动;首屏不做大文件解析与全量 DOM 构建
- [ ] Base64 体积门禁;音视频用包内文件(禁 `data:` 媒体)
- [ ] WebGL(若用): 预算 + 降档 + context lost 兜底
- [ ] **静态检查 ≠ 真机实测**: 没有运行数据时必须标注「性能未实测」, 不得声称真机性能合格

## 目录

```
minitools/
├── build.mjs            # 校验 + 打包流水线 (唯一的打包入口)
├── dist/                # 产物 zip (gitignore; 由 build.mjs 生成)
├── starter/             # 极简合规骨架 (还留着当参考)
│   └── src/{index.html, assets/{app.js,style.css}}
└── agent-card/          # ★ 当前小工具: 智能体名片 (身份采集 + 名片 + 交接串)
    └── src/
        ├── index.html
        └── assets/{store.js, card.js, app.js, style.css}   # 经典脚本, 按依赖顺序加载
```

## agent-card — 智能体名片

**定位(重要)**: 小工具**不能联网**(容器禁 `fetch`/XHR/WebSocket),JSBridge 也**只有 4 个 API**
(`postNote` / `saveImageToPhotosAlbum` / `openRedPage` / `writeTempFile`),**没有入网或发消息接口**。
所以真正的**入网与交流由 App 侧智能体完成**;这个工具负责:

| 视图 | 做什么 |
|---|---|
| 身份 | 昵称 / 简介 / 标签 / 头像(本地压缩到 256px 再存) / 智能体标识(可贴 App 里的真实 DID, 留空自动生成本地短码) / **接入点**(自己的 baseUrl + 模型 + Key, 仅本机, 名片只显示 Key 尾 4 位) |
| 名片 | Canvas 750×1000 生成名片 → **存相册**(`writeTempFile` → `saveImageToPhotosAlbum`)/ **发布笔记**(`postNote`, 标题≤20 正文≤1000 已按规范截断)/ **跳转 App 页**(`openRedPage`, `type` 与 `keyword` 可填, 未命中规则表时如实报错并提示换 type) |
| 社交 | **交接串**(`BOLLOONCARD1:<base64>`, 可长按选中复制 —— 容器禁剪贴板 API)/ 导入别人的交接串 → 联系人列表(可删)/ 边界说明 |

约定与实现要点:

- **本地标识 ≠ 密码学身份**: 不填 App 的 DID 时用离线 FNV/djb2 短码(`local-xxxx`), 并在界面上说明它不是 DID。
- **Key 从不进名片正面、不进交接串**(交接串只带 `keyTail`)。
- 数据落 `localStorage`(按小工具隔离, **不保证永久**), 界面提示用交接串自行备份;坏 JSON 会安全退回空档案。
- 头像/名片图走 Canvas 导出, **不把长 Base64 写回源码**;头像选图用 `blob:` 预览并在 `pagehide` 回收。
- 复制靠"展示可选中文本"(`user-select: text`), 因为 `navigator.clipboard` 与 `execCommand('copy')` 都被禁。
- 跳转 App 页前先落盘本地状态(跳转会离开当前页面)。

## 状态

- [x] skill 安装到 `.skill/minitool-zip-builder`(v1.6.0)
- [x] 校验/打包流水线(**0 ERROR**; 负例 14 处违规全部拦住; skill 自带脚本对同一负例只报 PASS —— 它们只查体积)
- [x] 合规骨架 `starter/`
- [x] **agent-card v1** —— 静态门禁 0 ERROR/WARN · 真 Chrome UI 验收 **23/23** · zip 0.01 MiB
- [ ] 真机(容器)验证 —— 需要把 zip 传进小红书容器;PC 模拟器行为与真机差异见 `cross-platform-h5.md`
- [ ] 待定: 二维码(纯 JS 生成器, 无 WASM)/ 多张名片 / postNote 文案模板 / 是否需要从 App 读回真实 DID
