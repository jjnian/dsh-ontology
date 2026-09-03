# dsh-better-sidebar — ontology 分支

> **本仓库是 [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的 fork**，
> `ontology` 分支在其基础上新增了两个侧边栏 tab。

## 本分支新增内容

- **🧬 血缘图（lineage）**：SVG 画布渲染分层血缘图，支持平移缩放 / 节点拖拽 / 搜索 / 节点详情；从会话事件日志抽取模型生成的 `{ nodes, edges }` 图（模型可调用 `lineage_graph` 工具），或加载工作区 JSON 文件；带本体（ontology）语义层与版本对比
- **🗄️ 数据库查看器（database）**：多引擎（MySQL 5.7/8.0+、PostgreSQL 10+、DM8）连接管理与查询，保存/编辑/测试连接、按类型浏览对象、展开表查看列/键/索引、执行 SQL；凭据保存在插件设置中，请求由 host 代理
- **多语言 i18n**：新增 tab 的文案已同步全部语言包

## 安装

```sh
pnpm build && pnpm pack
dsh plugin --profile web add file:./dsh-better-sidebar-0.18.0-alpha.0.tgz
```

## 许可

MIT（继承原仓库）