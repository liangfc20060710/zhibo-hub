# 智播中枢 · ZHIBO NEXUS

> 面向直播电商的**分布式多智能体全流程运营平台**。以 Node.js 本地确定性内核驱动多个对等智能体协同，配合浏览器单页控制台，完整呈现「选品策划 → 直播执行 → 弹幕响应 → 复盘归因」的闭环。

---

## 一、项目介绍

智播中枢模拟了一个真实直播电商团队的 AI 协作系统。系统中没有单一的"中心大脑"，而是由多个具有不同认知范式的对等智能体（Actor）通过消息总线、共享黑板与共识投票协作完成任务，并通过热备副本实现容灾。

- **运行模式**：`local-deterministic`（本地确定性内核）。所有"大模型"推理、数据生成均由内置算法在本地完成，结果可复现，**不依赖任何外部 API 或网络**。
- **架构分层**：五层 · 事件驱动 + 协议化（智能体通信层 / 工具协议层 / 内核能力层 / 编排层 / 可观测性层）。
- **零外部依赖**：仅使用 Node.js 原生模块，开箱即跑，无需 `npm install`。

### 核心能力

| 能力 | 说明 |
|---|---|
| 多智能体协同 | 4 个主角色 + 2 个热备副本，基于消息信封、合同网（CNP）招标与共识投票协作 |
| 认知范式 | Plan-Execute、ReAct·Stream、ReAct + Bandit、Reflexion + 因果归因 |
| 直播执行 | 开播 / 暂停 / 恢复 / 结束，弹幕自动分类与 ReAct 话术响应 |
| 安全护栏 | 违禁词、价格底线（0.85）、最大折扣（0.2）、高风险动作否决 |
| 在线学习 | Beta 伯努利多臂老虎机（Thompson Sampling）动态选择策略 |
| 因果复盘 | 双比例检验、ATT 估计、置信区间、因果 DAG 归因 |
| 流式引擎 | 时间窗口批处理、背压控制、丢弃统计与 P50/P95/P99 延迟 |
| 工具热插拔 | 运行时挂载 / 移除 MCP 工具，无需重启、不改智能体代码 |
| 可观测性 | 全链路 Trace、事件 SSE 实时推送、验收打分与压力测试 |

---

## 二、技术栈与依赖

| 项 | 要求 / 说明 |
|---|---|
| 运行时 | **Node.js ≥ 20**（在 Node 22 上验证通过），使用原生 ES Module（`.mjs`） |
| 外部 npm 依赖 | **无**（`package.json` 中不声明任何 dependencies） |
| 用到的原生模块 | `node:http`、`node:fs`、`node:path`、`node:url`、`node:child_process`、`node:events`、`node:test` 等 |
| 前端 | 原生 HTML + CSS + JavaScript（无框架），通过 SSE 与 REST API 通信 |

---

## 三、目录结构与文件说明

```
智播中枢-zhibo-hub/
├── .gitignore                     # Git 忽略规则
├── legacy-node/                   # 后端 Node 服务
│   ├── package.json               # 项目元信息与 npm 脚本
│   ├── server.mjs                 # HTTP 服务器入口（静态托管 + REST API + SSE）
│   ├── ui-acceptance.mjs          # 基于 CDP 的 UI 自动化验收脚本
│   ├── src/                       # 后端源码
│   └── test/                      # 自动化测试
└── public/                        # 前端单页控制台
    ├── index.html                 # 控制台页面骨架
    ├── css/app.css                # 深色控制台样式
    ├── js/app.js                  # 前端状态、API、SSE 与交互逻辑
    └── assets/                    # 图标与图片素材
```

### 后端 `legacy-node/`

| 文件 | 作用 |
|---|---|
| `package.json` | 定义项目名称、版本、`type: module`、`engines` 与 `start/dev/test` 脚本 |
| `server.mjs` | 程序入口。用原生 `http` 创建服务，负责静态资源托管、`/api` 路由分发、SSE 事件广播；默认监听 `127.0.0.1:4173` |
| `ui-acceptance.mjs` | 通过 Chrome DevTools Protocol 驱动浏览器，按选择器契约逐项验证页面交互 |

### 后端源码 `legacy-node/src/`

| 路径 | 作用 |
|---|---|
| `orchestrator.mjs` | **核心运行时 `ZhiboRuntime`**，装配并统筹所有子系统（LLM、记忆、总线、黑板、护栏、注册表、流引擎、智能体等） |
| `data.mjs` | 全部种子数据：商品、用户、弹幕池、历史场次、历史复盘、默认配置、历史决策与历史 Trace |
| `acceptance.mjs` | 验收流程 `runAcceptance`，执行压测与全部探针并产出评分报告 |
| `agent_core/llm.mjs` | 本地确定性"大模型" `LocalLLM`：意图分类、话术生成、方案叙事、复盘反思 |
| `agent_core/memory.mjs` | 记忆系统 `MemorySystem`：情景记忆存储与相关性检索 |
| `agent_core/util.mjs` | 通用工具：唯一 ID、数值取整、百分位、伪随机数、正态 CDF、双比例检验等 |
| `agents/actors.mjs` | `Actor` 基类与四个智能体实现：策选 Selector、场控 Controller、言枢 Speaker、观澜 Analyst |
| `a2a_layer/envelope.mjs` | 消息信封 `createEnvelope`、言语行为类型（PERFORMATIVES）与合法性校验 |
| `a2a_layer/bus.mjs` | 消息总线 `MessageBus`，负责智能体间消息路由 |
| `a2a_layer/blackboard.mjs` | 共享黑板 `Blackboard`，存放当前阶段、商品、流量、风险等全局状态 |
| `causal/engine.mjs` | 因果引擎 `CausalEngine`：ATT 估计、双比例检验、显著性与置信区间 |
| `guardrails/rules.mjs` | 合规护栏 `Guardrails`：违禁词、价格底线、折扣上限与高风险动作否决 |
| `learning/bandit.mjs` | Beta 多臂老虎机 `BetaBandit`，基于 Thompson Sampling 选择策略臂 |
| `mcp_layer/registry.mjs` | MCP 工具注册表 `MCPRegistry`，管理工具注册、审批与调用 |
| `mcp_layer/tools.mjs` | 内置工具定义 `createBuiltinTools` 与热插拔工具工厂 `createHotplugTool` |
| `observability/tracer.mjs` | 链路追踪器 `Tracer`，记录调用链与耗时 |
| `stream_engine/engine.mjs` | 流式引擎 `StreamEngine`：时间窗口批处理、背压与延迟统计 |

### 测试 `legacy-node/test/`

| 文件 | 作用 |
|---|---|
| `api.test.mjs` | 启动服务子进程，验证完整 HTTP 操作回路、安全闸门与 SSE |
| `kernel.test.mjs` | 不经过网络，直接验证内核的方案、容灾、压测、验收等能力 |

### 前端 `public/`

| 路径 | 作用 |
|---|---|
| `index.html` | 单页控制台骨架（左侧导航、中间工作区、右侧 Copilot、抽屉与弹窗容器） |
| `css/app.css` | 深色专业控制台全部样式，含响应式断点 |
| `js/app.js` | 前端 Store / API 封装 / SSE 接收 / 七视图渲染 / 事件委托 / 抽屉与确认框 |
| `assets/favicon.svg` | 站点图标（六边形网络节点） |
| `assets/live-stage.jpg` | 直播舞台背景图 |

---

## 四、部署与运行步骤

### 1. 环境准备

确认已安装 Node.js 且版本不低于 20：

```bash
node --version    # 期望 v20.x 或更高
```

> 本项目零外部依赖，**不需要执行 `npm install`**。

### 2. 启动服务

进入后端目录并启动：

```bash
cd legacy-node
node server.mjs      # 等价于 npm start
```

看到如下输出即表示启动成功：

```
智播中枢 · ZHIBO NEXUS
API + 控制台  http://127.0.0.1:4173
本地确定性内核 · 零外部依赖 · 演示数据
```

### 3. 打开控制台

在浏览器访问：

```
http://127.0.0.1:4173/
```

打开后点击右上角「生成方案」即可开始体验完整流程。

### 4. 运行测试

```bash
cd legacy-node
npm test            # 等价于 node --test test/*.test.mjs
```

### 5. 自定义端口与监听地址

通过环境变量覆盖默认配置：

```bash
# 自定义端口
PORT=8080 node server.mjs

# 允许局域网内其他设备（含手机）访问
HOST=0.0.0.0 PORT=4173 node server.mjs
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `4173` | 服务监听端口 |
| `HOST` | `127.0.0.1` | 监听地址，设为 `0.0.0.0` 可对外提供访问 |

### 开发模式

`npm run dev` 使用 `node --watch`，文件改动后自动重启服务。

---

## 五、HTTP API 概览

服务同时提供 REST 接口与 SSE 实时推送。除特别标注外，写操作均为 `POST`，响应体通常包含最新 `state`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/state` | 获取完整状态快照 |
| GET | `/api/events` | SSE 事件流（首事件 `hello` 带完整状态） |
| GET | `/api/trace/:id` | 查询单条链路详情 |
| GET | `/api/acceptance?force=1` | 运行 / 读取验收报告 |
| POST | `/api/prepare` | 生成直播方案 |
| POST | `/api/live/start` `/stop` `/pause` `/resume` | 直播生命周期控制 |
| POST | `/api/danmaku` | 注入弹幕并获取响应 |
| POST | `/api/scenario` | 运行预设情景（如负面舆情） |
| POST | `/api/review` | 生成本场复盘报告 |
| POST | `/api/fault` | 智能体故障注入 / 恢复（容灾） |
| POST | `/api/tools/hotplug` `/remove` `/call` | 工具热插拔、移除与调用 |
| POST | `/api/stress` | 压力测试（默认 800 事件） |
| POST | `/api/chat` | 与 Copilot 对话 |
| POST | `/api/reset` | 重置会话到初始状态 |

---

## 六、控制台七大视图

| 视图 | 内容 |
|---|---|
| 总览 | 核心 KPI、目标节奏、共享黑板、快捷操作、最近决策与合同网招标 |
| 智能体矩阵 | 全部智能体卡片、负载/可靠性、容灾控制与故障注入 |
| 直播中控 | 直播舞台、弹幕流、智能体 ReAct 响应与直播控制 |
| 决策台账 | 全部决策卡片，支持按动作 / 触发 / 智能体 / 证据搜索 |
| 复盘实验室 | KPI、因果 DAG、ATT 与显著性、转化漏斗、教训与后续行动 |
| 协议工坊 | MCP 工具注册表与运行时热插拔表单 |
| 系统验收 | 验收打分、意图链路压测、流处理内核指标 |

---

## 七、说明与常见问题

- **数据是否真实？** 所有数据均为本地确定性算法生成的演示数据，使用固定随机种子，多次运行结果一致。
- **是否需要联网？** 不需要。意图理解、话术、指标全部由本地内核完成。
- **`index.html` / `package.json` 能否改名？** 不能。它们是浏览器与 Node 固定识别的文件名；扩展名（`.mjs/.js/.css` 等）也需保留。
- **如何在手机访问？** 先用 `HOST=0.0.0.0 node server.mjs` 启动，确保手机与电脑在同一网络，再通过电脑局域网 IP 访问；也可结合内网穿透工具暴露到公网。

> （注：部分内容由豆包 AI 生成）