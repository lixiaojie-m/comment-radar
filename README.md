# 评论雷达 · Comment Radar

相关内容只读监控 + LLM 评分起草 + 人工审核发布的评论引流辅助工具。

**边界纪律**（对应运营方案《KOL 引流与创作者合作冷启动策略》§评论纪律）：
本工具只做「找内容」和「写草稿」，**不做自动发布**。发布永远由人工在原文页面手动完成——这是为了守住三条线：平台风控（营销号判定）、账号安全（固定 1–2 个号是稀缺资产）、真实性（干货式评论的价值来源）。

## 工作流

```
定时抓取（B站搜索 / 知乎热榜 / HN，只读、不登录任何账号）
  → 去重入库
  → LLM 相关度评分（< 阈值进低分归档）
  → 达标条目按话术库生成干货式草稿（参考最近已发评论避免雷同）
  → 待审队列：人工改两笔 → 复制 → 打开原文手动发布 → 回来标记已发布
```

## 快速开始

要求 Node ≥ 18.14，无任何 npm 依赖。

```bash
node src/server.js          # 首次启动自动从 config.example.json 生成 config.json
# 打开 http://localhost:8787，默认密码 changeme（立刻去设置页改掉）
```

评分和起草需要一个 OpenAI 兼容的 LLM key（设置页填写），没有 key 时条目停留在「未评分」，配好后点「立即抓取」可补跑。

## 配置（config.json，均可在设置页改）

| 字段 | 说明 |
| --- | --- |
| `keywords` | 监控关键词，用于 B 站搜索 / HN 检索 |
| `sources` | 数据源开关 `bilibili` / `zhihu` / `hackernews` |
| `fetchIntervalMinutes` | 抓取间隔（最小 5 分钟），保存后即时生效 |
| `lookbackDays` | 只收最近 N 天发布的内容 |
| `scoreThreshold` | 评分阈值，低于此分进低分归档 |
| `llm` | `baseUrl` / `model` / `apiKey`，任何 OpenAI 兼容接口 |
| `productContext` | 产品口径，AI 评分与起草的背景知识 |
| `playbook` | 评论纪律（硬约束）+ 话术示例（学语气不照抄） |

## 数据源现状

| 源 | 方式 | 说明 |
| --- | --- | --- |
| B 站 | 视频搜索 API（匿名 cookie） | 按发布时间取最近内容，关键词驱动 |
| 知乎 | 移动端热榜 API | 全量热榜靠 LLM 筛选；搜索接口有签名门槛，暂未接入 |
| Hacker News | Algolia 官方 API | 英文内容，默认关闭 |
| 即刻 / 公众号 / 小红书 | — | 反爬或需登录，未接入（v1 范围外） |

源健康状态显示在侧栏底部：绿 = 正常，红 = 失败（悬停看错误），灰 = 未启用。单源失败不影响其他源。

## 部署

当前生产部署在 NAS（nas-host）上，以 Docker 常驻容器运行：

```bash
PORT=8788 bash deploy/deploy-nas.sh     # 前提：本机公钥已加入 NAS 账号 authorized_keys
```

- 容器名 `comment-radar`，`--restart unless-stopped`（NAS 重启后自动拉起）
- 持久化：`/opt/comment-radar/conf/`（配置，目录挂载）与 `data/`（数据），bind mount，重建容器不丢数据
- 访问：`http://nas-host:8788`（NAS 的 8787 被 NAS 系统服务占用，外网端口用 8788）
- 基础镜像用 NAS 本地已有的 `node:22-bookworm`（Docker Hub 直拉会卡住）
- LLM 配置为 DeepSeek（`https://api.deepseek.com` / `deepseek-chat`），key 在网页设置页填写

其他环境可用 `deploy/deploy.sh`（systemd 方式，需要 root）。

数据落在 `data/store.json`（JSON 文件存储，每天自动清理 45 天前的终态条目）。设置页可随时导出全部数据。

## 目录结构

```
src/
  server.js        HTTP 服务：静态资源 + API + 鉴权
  scheduler.js     定时调度（间隔即时生效）
  pipeline.js      抓取 → 去重 → 评分 → 起草 管线
  store.js         JSON 文件存储（原子写、防抖持久化）
  config.js        配置读写与合并
  llm.js           OpenAI 兼容客户端：批量评分 + 单条起草
  sources/         数据源（每个源一个文件，失败降级不中断）
public/            前端：单页、无框架、无构建、无 CDN 依赖（局域网离线可用）
deploy/            systemd 单元 + 一键部署脚本
```
