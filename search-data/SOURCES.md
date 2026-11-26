# 搜索词表数据来源

## Mindustry v160.4

`catalog.json` 的 `blocks` 和 `names` 取自 Anuken 与 Mindustry 贡献者发布的 v160.4，提交为 `4368c6e60eece15bb15db22f66f88b42d00bef79`。上游采用 GNU GPL 第 3 版。[定版源码](https://github.com/Anuken/Mindustry/tree/4368c6e60eece15bb15db22f66f88b42d00bef79) · [许可证原文](licenses/Mindustry-GPL-3.0.txt)

- 方块 ID 取 381 条定版建筑索引与 412 条简体中文方块名称的并集，共 416 条。名称去掉游戏显示用的颜色标记。4 个没有中文名称的矿墙沿用英文 ID。`names` 收录物品、液体和单位的中文名，另补搜索用的通用冷却液 `coolant`。 [简体中文资源](https://github.com/Anuken/Mindustry/blob/4368c6e60eece15bb15db22f66f88b42d00bef79/core/assets/bundles/bundle_zh_CN.properties)
- 生成时调用 `ensureBlockIoIndex()` 读取定版源码。`materials` 取每座方块的建造需求，已展开引用其他方块成本的倍率。对每个方块调用 `buildSearchIoPartsFromBlocks([id])`，将物品和液体的输入、输出分别写入 `itemInputs`、`itemOutputs`、`liquidInputs`、`liquidOutputs`。单位工厂的物品输入取全部计划所需物品的并集。`units` 收录工厂、重构器和组装厂能产出的单位，具体蓝图的配置和连接决定实际产链。ID 按字母排序，省略空字段。 [建筑定义](https://github.com/Anuken/Mindustry/blob/4368c6e60eece15bb15db22f66f88b42d00bef79/core/src/mindustry/content/Blocks.java)

## OpenCC 单字折叠

`folding` 派生自 `opencc-js@1.4.2` 随包的 `opencc-js/dict/TSCharacters`。这份字表由 `opencc-data@1.4.2` 的 OpenCC 字典生成，采用 Apache License 2.0。[opencc-js 发行包](https://www.npmjs.com/package/opencc-js/v/1.4.2) · [原始字典](https://github.com/nk2028/opencc-data/blob/4bcdc1064a298884d673dee8bbe91b2508cac6f5/data/TSCharacters.txt) · [许可证原文](licenses/OpenCC-Apache-2.0.txt) · [发行包第三方声明](licenses/opencc-js-THIRD_PARTY_LICENSES.md)

生成时将单字的多步转换折叠至最终字形（如 `薴 → 苧 → 苎`），省去恒等映射。余下 3,222 对按源字的 Unicode 码点升序排列，以“源字、目标字”交错连接。读取时按码点迭代，例如 JavaScript 的 `Array.from(folding)`。映射范围仅限单字。

原始字典保留以下声明。

```text
# Open Chinese Convert (OpenCC) Dictionary
# File: TSCharacters.txt
# License: Apache-2.0 (see LICENSE)
# Source: https://github.com/BYVoid/OpenCC
```
