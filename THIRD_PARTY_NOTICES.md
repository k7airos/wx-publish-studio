# 第三方许可声明

本文件记录 wx-publish-studio（仓库名 `wx-publish-studio`）自身依赖的第三方组件许可。
本项目自身许可见 [LICENSE](LICENSE)。

> **判定口径**
>
> 1. **以包内 `LICENSE` 原文为准，`package.json` 的 `license` 字段只是线索。** 两者不一致时以随包分发的许可证原文为准；本表记录的版本号取自 `bun.lock` 锁定的安装结果。
> 2. 「需要随附 NOTICE 或署名」一列按所选分支的许可证原文判断：要求保留版权与许可声明的记为「需要随附许可文本」，要求标注来源的记为「需要署名」。
> 3. 双许可（dual license）组件按「选定分支」一列记录的分支使用，并在理由中写明选择依据。
> 4. 本表覆盖直接依赖与需要特别标注的传递依赖；其余传递依赖的许可均为 MIT / ISC / BSD / Apache-2.0 / MIT-0 / Unlicense 等宽松许可，随包的许可文本已包含在所安装的包内。
> 5. 随镜像分发时，本文件与 `LICENSE` 一起复制进运行镜像（见 `Dockerfile`）。

## 一、直接依赖

以下为 `package.json` 中声明的全部直接依赖及其 `package.json` 声明的许可字段。

### 运行时依赖（进入分发镜像）

| 包名 | 声明版本 | package.json 声明的 license | 需要随附 NOTICE 或署名 | 判定依据 |
| --- | --- | --- | --- | --- |
| `@akairos/design` | `^1.0.0`（锁定 1.0.0） | MIT | 需要随附许可文本 | 自有包，包内 `LICENSE` 为 MIT，版权人 Kairos |
| `@akairos/myno` | `0.4.5` | MIT | 需要随附许可文本 | 自有包，包内 `LICENSE` 为 MIT |
| `@akairos/pipeline` | `0.23.1` | MIT | 需要随附许可文本 | 自有包，包内 `LICENSE` 为 MIT |
| `@akairos/typeset-studio` | `0.4.1` | MIT | 需要随附许可文本 | 自有包，包内 `LICENSE` 为 MIT |
| `@milkdown/crepe` | `7.22.3` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `@milkdown/kit` | `7.22.3` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `@napi-rs/canvas` | `1.0.11` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT；平台二进制作为可选依赖随包安装 |
| `hono` | `4.13.13` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `image-size` | `2.0.4` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `lucide-react` | `1.60.0` | ISC | 需要随附许可文本 | 包内 `LICENSE` 为 ISC |
| `mdast-util-to-markdown` | `2.2.0` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `react` | `19.3.1` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `react-dom` | `19.3.1` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `remark-gfm` | `4.0.1` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `remark-parse` | `11.0.0` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `unified` | `11.0.5` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |

### 构建期依赖（一般不进入分发镜像）

| 包名 | 声明版本 | package.json 声明的 license | 需要随附 NOTICE 或署名 | 判定依据 |
| --- | --- | --- | --- | --- |
| `@happy-dom/global-registrator` | `21.0.3` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `@types/bun` | `1.4.3` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `@types/react` | `19.3.0` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `@types/react-dom` | `19.3.0` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `@vitejs/plugin-react` | `5.0.4` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `happy-dom` | `21.0.3` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |
| `vite` | `7.1.10` | MIT | 需要随附许可文本 | 包内 `LICENSE` 为 MIT |

### 例外：也随运行镜像分发的构建期依赖

| 包名 | 声明版本 | package.json 声明的 license | 需要随附 NOTICE 或署名 | 判定依据 |
| --- | --- | --- | --- | --- |
| `typescript` | `5.9.3` | Apache-2.0 | 需要随附许可文本 | 包内许可文件名为 **`LICENSE.txt`**（不是 `LICENSE`），原文为 Apache-2.0。虽然列在 `devDependencies`，但 `vue@3.5.44` 声明 `peerDependencies: { typescript: "*" }` 且 `peerDependenciesMeta.typescript.optional = true`；`vue` 由 `@milkdown/crepe` → `@milkdown/components` 引入（运行时链），锁文件中已解析的 `typescript@5.9.3` 满足该 optional peer，Bun 在 `bun install --frozen-lockfile --production` 时一并安装。**因此它实际进入运行镜像**（实测约 23MB）。Apache-2.0 要求保留许可文本与 NOTICE 声明，随包分发的 `LICENSE.txt` 与 `ThirdPartyNoticeText.txt` 满足该义务。 |

## 二、需要特别标注的传递依赖

以下是许可不是单一宽松许可、或要求署名的传递依赖。它们随上游包进入本项目的安装结果。

| 包名 | 锁定版本 | package.json 声明的 license | 选定分支 | 需要随附 NOTICE 或署名 | 判定依据 |
| --- | --- | --- | --- | --- | --- |
| `vue` | `3.5.44` | MIT | MIT | 需要随附许可文本 | 运行时传递依赖：`@milkdown/crepe` → `@milkdown/components` 依赖 `vue@^3.5.20`。包内 `LICENSE` 为 MIT（Copyright (c) 2018-present, Yuxi (Evan) You）。同时是 `typescript` 的 optional peer 来源，见上表。 |
| `dompurify` | `3.4.17` | `(MPL-2.0 OR Apache-2.0)` | Apache-2.0 | 需要随附许可文本 | 双许可。选 Apache-2.0 分支：宽松许可、无文件级 copyleft 传染义务，与本项目 MIT 许可兼容，且不增加随附义务。经 `@milkdown/crepe` / `@milkdown/components` 引入（运行时）。 |
| `json-schema` | `0.4.0` | `(AFL-2.1 OR BSD-3-Clause)` | BSD-3-Clause | 需要随附许可文本 | 双许可。选 BSD-3-Clause 分支：宽松许可、无 copyleft 传染义务，与本项目 MIT 许可兼容。经 `jsprim` → `http-signature` → `request` → `cos-nodejs-sdk-v5` 引入（运行时）。 |
| `caniuse-lite` | `1.0.30001816` | `CC-BY-4.0` | CC-BY-4.0 | 需要署名（仅在分发其数据时） | Creative Commons Attribution 4.0 要求标注来源。经 `browserslist` 引入，属构建期依赖。实测本项目的镜像与 `dist/` 产物**均不含** caniuse-lite 的数据文件，因此本次分发不触发该署名要求；将来若把该数据打进产物，需在分发物中标注来源。 |

## 二之二、`@akairos/pipeline` 的 optionalDependencies

`@akairos/pipeline` 的 `optionalDependencies`（`@napi-rs/canvas`、`cos-nodejs-sdk-v5`）会随运行镜像一并安装，其许可需要与本表一并核对：

| 包名 | 锁定版本 | package.json 声明的 license | 包内许可文件原文 | 需要随附 NOTICE 或署名 | 判定依据 |
| --- | --- | --- | --- | --- | --- |
| `@napi-rs/canvas` | `1.0.11` | MIT | MIT（Copyright (c) 2020 lynweklm@gmail.com） | 需要随附许可文本 | 同时是本项目的直接依赖（封面渲染）。 |
| `cos-nodejs-sdk-v5` | `2.15.4` | ISC | **MIT**（Copyright (c) 2017-present 腾讯云） | 需要随附许可文本 | 按「以包内 `LICENSE` 原文为准」的口径，此包按 **MIT** 记录，而非 `package.json` 声明的 ISC；两者都属宽松许可，随包分发的 `LICENSE` 已满足保留许可文本的义务。 |

## 三、自有包的授权意图

`@akairos/design`、`@akairos/myno`、`@akairos/pipeline`、`@akairos/typeset-studio` 是作者 Kairos 维护的自有包，均以 MIT 授权发布，包内 `LICENSE` 原文为准：

- `@akairos/design`：Copyright (c) 2026 Kairos
- `@akairos/myno`：Copyright (c) 2026 aatrooox
- `@akairos/pipeline`：Copyright (c) 2026 aatrooox
- `@akairos/typeset-studio`：Copyright (c) 2026 Typeset Studio Contributors

这四个包在本项目中的分发同样适用 MIT 的「保留版权与许可声明」义务。

## 四、对上游默认文案的本地覆盖

`@akairos/myno` 等上游包的默认主题与插件示例里带有**某个具体公众号的名称**（以「公众号 + 分隔符/引号 + 名称」的形式出现，也有个别只以裸名称出现）。本项目**不修改上游包**，而是在构建期把这些名称替换成中性文案后再分发。

- 这是对上游**默认文案**的本地覆盖，不涉及对上游**代码**的改动，也不改变上游包的许可条件；上游包本身仍按其原始许可条款发布与使用。
- 覆盖规则集中在一处（`scripts/brand-copy.ts`），且**不写死任何具体名称**：构建期从上游包产物里自动发现这些名称，再按通用规则中性化。
- 替换后产物里只要还残留任何上游默认名称、或残留「公众号 + 分隔符/引号」的品牌结构，构建直接失败，不会静默把名称带进分发产物。
- 升级上游包后必须复核这套机制是否仍然覆盖上游的新写法（见下表「何时可升级」一列）。

## 五、依赖版本策略

本轮（OSS-1）**保留现有 pin，不做升级**：

| 包 | 固定版本 | 理由 | 复查日期 | 何时可升级 |
| --- | --- | --- | --- | --- |
| `@akairos/myno` | `0.4.5` | 与现网部署一致，避免排版行为漂移 | 2026-10-22 | 上游给出兼容本项目快照／哈希合同的版本后，按定向测试结论升级；**升级时必须复核 `scripts/brand-copy.ts` 的中性化规则是否仍然覆盖上游写法**（实测 0.4.7 仍含同样写法，单纯升级不能解决） |
| `@akairos/pipeline` | `0.23.1` | 与现网 Worker 镜像的合同一致 | 2026-10-22 | 同上；需同时确认 Worker 能力声明 |
| `@akairos/typeset-studio` | `0.4.1` | 与现网封面／排版合同一致 | 2026-10-22 | 同上；需复核封面快照版本 |
| `@akairos/design` | `1.0.0`（声明 `^1.0.0`，锁定 1.0.0） | 仅提供设计令牌，视觉影响可控 | 2026-10-22 | 令牌变更需走一次界面走查 |

其余依赖同样以 `bun.lock` 锁定版本为准。升级任一自有包时，必须重跑 `bun run check`、`bun run build` 与相关定向测试，并复核 `THIRD_PARTY_NOTICES.md` 中的许可结论是否仍成立。
