# Mindustry Schematic Storage

本仓库用于存储 Mindustry 蓝图（`.msch` 文件），并提供独立的搜索索引构建脚本。

机器人将蓝图文件同步到 `schematics/`。

## 构建搜索索引 / Build the search index

在仓库根目录用 Node.js 22 或更新版本运行以下命令。

```sh
node build-search-index.mjs
```

脚本读取 `schematics/`，在仓库根目录生成 `search-index.js`。克隆仓库或同步新蓝图后运行一次即可。可用 `--schematics <目录>` 和 `--out <文件.js>` 指定其他路径。构建遇到损坏的蓝图会报告文件路径。

`search-index.js` 是独立的 ES module，可在浏览器和 Node.js 中直接导入。默认导出使用 JSON 数据结构，包含格式版本、按蓝图编号查找的 `documents`、字符和建筑的倒排表 `postings` 及原版内容词表 `catalog`。每条记录包含文件路径、尺寸、原名、简介、标签、信息板和建筑数量。`path` 使用 `/`，默认相对于仓库根目录，自定义来源时相对于输入目录的上一级。

```js
import index, { search } from './search-index.js'

console.log(index.documents[140])
console.log(search('銅'))                    // 与 '铜' 等效
console.log(search('橋', 'block', 2))         // 所有匹配桥种的数量合计恰好为 2
console.log(search('硅', 'output'))           // 建筑的产出能力
```

`search(text, field = 'all', count)` 按字面子串匹配，返回按编号升序排列的蓝图记录。可指定 `name`、`description`、`author`（作者标签、简介及信息板）、`label`、`message`、`block`、`material`、`input`、`output` 或 `unit`。默认 `all` 搜索文本、建筑、运行输入输出及单位能力。用 `material` 检索建造材料，用 `unit` 检索建筑能生产、升级或组装的单位。简繁及全角半角在匹配时归一化，返回的记录保留原文。

运行 `node --test` 执行回归测试。词表版本和许可见 [数据来源](search-data/SOURCES.md)。

This repository stores Mindustry `.msch` files under `schematics/`. Run `node build-search-index.mjs` with Node.js 22+ to generate a standalone JavaScript module containing a JSON-compatible search index.
