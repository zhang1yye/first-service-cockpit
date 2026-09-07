# APH 2.0 视觉一致性 QA

## 比较对象

- Source visual truth：`docs/design-evidence/aph-source-desktop.jpg`
- Implementation screenshot：`docs/design-evidence/cockpit-aph-desktop.jpg`
- Full-view comparison：`docs/design-evidence/aph-side-by-side.jpg`
- Mobile implementation：`docs/design-evidence/cockpit-aph-mobile.jpg`
- Source state：已登录 APH 2.0 首页，桌面端默认状态
- Implementation state：驾驶舱首页，接口未授权真实空态

## 视口与归一化

- APH 源截图：1686 × 873 px，CSS 视口 1686 × 873，1x。
- 驾驶舱桌面截图：1280 × 720 px，CSS 视口 1280 × 720，1x。
- 全景对照：两张截图等比缩放并补齐至 1280 × 720 后左右拼接，不拉伸内容。
- 驾驶舱移动端：390 × 844 CSS px，1x；无横向溢出。
- APH 当前页面是固定桌面布局，浏览器视口覆盖后仍报告 1686px 内容宽度，因此移动端只验证驾驶舱自身可用性，不对 APH 原站做虚假的逐像素移动端比较。

## 必查表面

### 字体与排版

- 通过。双方使用 APH 当前系统字体栈，基础字号 13px、行高 19.5px。
- 顶栏、页签、面板标题和小字号辅助信息的层级与 APH 一致。

### 间距与布局节奏

- 通过。顶栏 50px、左栏 60px、页签 46px。
- 内容背景、10px 面板间距、白色无圆角面板和紧凑信息密度与 APH 一致。
- 驾驶舱经营模块内容与 APH 门户内容不同，这是业务范围差异，不是壳层漂移。

### 色彩与视觉令牌

- 通过。背景 `#f5f6fa`、正文 `#4d5259`、激活红 `#cf001b`、黑色顶栏和浅灰边界与源页面一致。
- 空态使用淡黄信息条，明确表示接口未授权，未用模拟数据伪装正常状态。

### 图像与图标

- 通过。导航、便捷入口和 KPI 使用本地化的 APH 图标资产，没有使用 emoji、手绘 SVG 或文字首字替代。
- APH 品牌锁定图来自已登录源页面的可见品牌区，本地保存且不依赖 APH 热链。

### 文案与业务内容

- 通过。保留驾驶舱自己的经营、财务、项目、异常、月报和审核语义。
- “指标口径来自 API”“账号授权项目”“接口未授权”文案符合真实数据和权限边界。

## 交互与工程验证

- 导航：`/` → `/analysis` 路由通过，活动导航同步更新。
- 筛选：统计周期切换到“本年度”通过。
- 响应式：390 × 844 下无横向溢出，主要入口可见。
- 浏览器控制台：0 个 error。
- `npm run lint`：通过。
- `npm test`：构建通过，自动测试 2/2 通过。

## Findings

- 无 P0、P1、P2 问题。
- P3：正式并入 APH 代码库时，建议由 APH 团队提供官方原始品牌 PNG，以替换当前从已登录页面固化的品牌锁定图，进一步避免 JPEG 压缩。

## 比较历史

### Iteration 1

- 发现：旧页面使用字符化品牌标识、字符首字图标和 52/62/48px 近似尺寸。
- 修复：替换为真实 APH 品牌锁定图与导航图标；统一为 50/60/46px；修正字体、颜色、页签和移动端布局。
- 修复后证据：`docs/design-evidence/aph-side-by-side.jpg`。

### Iteration 2

- 发现：便捷入口、KPI 和页签前进控制仍有文字或字符图标。
- 修复：全部替换为本地 APH 图标资产；重新验证桌面、移动端、路由和筛选。
- 修复后证据：`docs/design-evidence/cockpit-aph-desktop.jpg`、`docs/design-evidence/cockpit-aph-mobile.jpg`。

## Implementation Checklist

- [x] APH 壳层尺寸与令牌统一
- [x] 真实 APH 品牌和图标本地化
- [x] 桌面与移动端验证
- [x] 关键导航与筛选交互验证
- [x] APH SSO、路由、权限和 API 接入契约
- [x] 构建、测试和 lint

final result: passed

# R22 首页核心指标卡空间平衡增量 QA

## 比较对象

- Source visual truth：`docs/design-evidence/r22-core-card-balance-source.png`
- Implementation full view：`docs/design-evidence/r22-core-card-balance-production.png`
- Implementation focused region：`docs/design-evidence/r22-core-card-balance-production-card.png`
- Focused side-by-side comparison：`docs/design-evidence/r22-core-card-balance-comparison.png`
- 状态：云端已登录、首页默认桌面视图、真实经营数据。

## 视口与归一化

- 源问题截图：1234 × 470 px。
- 云端实现全景：1920 × 1837 px，对应 1920 × 929 CSS 视口的整页截图。
- 云端核心指标卡：607 × 218 px。
- 对照图：源图和实现图等比缩放并居中到 606 × 236 px，再横向拼接为 1212 × 236 px；未拉伸内容。

## 必查表面

- 字体与排版：通过。标题独占第一行；主数值和累计完成率标签位于第二行同一水平层级。
- 间距与布局节奏：通过。主数值与标签水平间距实测 18px，进度条与底部指标区保持独立层级。
- 色彩与视觉令牌：通过。保留 APH 红、灰色辅助文本、橙色进度和原卡片背景。
- 图像与资产：通过。没有新增或替换图形资产，仅调整现有 DOM 的 CSS 网格。
- 文案与内容：通过。标题、累计执行、完成率、三项预算数据及跳转均保留。

## Findings

- 无 P0、P1、P2 视觉问题。
- 主数值与完成率标签无重叠；进度条与底部三项指标无重叠。
- 文档、卡片横纵方向均无溢出。
- 生产控制台仅有既存的 `/api/ai/brief` 与 `/api/ai/week-focus` 409 数据状态响应，与本次样式层无关。

## 比较历史

### Iteration 1

- 发现：原卡片上半区把标题、主数值、完成率标签纵向堆叠在左侧，右侧形成大块空白，信息密度失衡。
- 修复：标题保留首行；主数值与完成率标签改为同排；进度条单独一行；卡片总高度与底部三项指标不变。
- 修复后证据：`docs/design-evidence/r22-core-card-balance-comparison.png`。

## 交互与工程验证

- 核心指标卡尺寸：606.7 × 218px，与改动前一致。
- 主数值和完成率标签：`valueBadgeOverlap=false`。
- 进度条和底部指标：`progressLowerOverlap=false`。
- 卡片横向、纵向及页面横向溢出均为 0。
- 卡片跳转仍为 `/payment`。
- 自动化测试：130/130 通过。
- 云端服务 active，R22 样式返回 HTTP 200 并已加载。

## Implementation Checklist

- [x] 主数值与完成率调整为同一水平层级
- [x] 保留进度条和底部三项指标
- [x] 保持卡片高度、真实数据及跳转不变
- [x] 检查溢出、重叠、资源加载和自动化回归
- [x] 完成云端真实数据截图复核

final result: passed

---

# R20 收缴率目标与视觉层级增量 QA

## 比较对象

- Source visual truth：`docs/design-evidence/r20-collection-target-source.png`
- Implementation full view：`docs/design-evidence/r20-collection-target-production.png`
- Implementation focused region：`docs/design-evidence/r20-collection-target-production-card.png`
- Focused side-by-side comparison：`docs/design-evidence/r20-collection-target-comparison.png`
- 状态：云端已登录、首页默认桌面视图、真实收缴率 63.24%、当期考核目标 88.39%。

## 视口与归一化

- 源标注图：1100 × 348 px，为卡片放大截图。
- 云端实现全景：1720 × 868 px，对应 1720 × 868 CSS 视口。
- 云端实现卡片裁切：541 × 165 px。
- 对照图：源图和实现图分别等比缩放并居中到 550 × 174 px 画布，再横向拼接为 1100 × 174 px；未拉伸内容。

## 必查表面

- 字体与排版：通过。当前收缴率使用 23px/29px、金额使用 20px/26px、标签使用 12px/18px、目标值使用 13px/16px；数字使用等宽数字特性，字重和基线统一，无换行或截断。
- 间距与布局节奏：通过。卡片保持 164px 高，正文 100px；环图、金额区严格 `251.164px / 251.164px` 等分。目标徽标放在标题行右侧，不侵占正文。
- 色彩与视觉令牌：通过。沿用 APH 红、深灰数字、浅灰说明和淡红边界；降低旧环形阴影，进度弧改为细描边与圆角端点。
- 图像与资产：通过。沿用现有业务组件的圆环与图标资产，只调整其呈现样式；没有引入占位图、低清素材或新的近似图形。
- 文案与内容：通过。明确展示“当期考核目标 88.39%”和“距目标 25.15%”；应收、实收及当前收缴率保持真实接口值。

## Findings

- 无 P0、P1、P2 问题。
- 无遗留 P3。环图、目标、当前值和金额已形成清晰层级，卡片在目标视口内完整显示。

## 交互与工程验证

- 云端卡片点击仍进入 `/collection?tab=details`。
- 卡片、正文和金额区均无横向或纵向溢出。
- R20 CSS 与 JS 均从云端成功加载，发布标记正确。
- 自动化测试：124/124 通过。
- 云端服务状态：active；`/api/health` 返回 `status=ok, live=true`。

## 比较历史

### Iteration 1

- 发现：新增目标后，右侧金额容器继承旧的双行网格，内容高度达到 120px，超出 100px 正文区。
- 修复：将金额容器固定为正文高度，并将每条金额改成同一行的“标签 + 数值”两列网格。
- 修复后证据：正文、环图、金额区均为 100px 高，所有 overflow 检查为 false。

### Iteration 2

- 发现：无新的 P0、P1、P2。
- 结果：云端真实数据截图与源图完成同尺寸并排复核，目标值、字号、环图和金额对齐通过。
- 修复后证据：`docs/design-evidence/r20-collection-target-comparison.png`。

## Implementation Checklist

- [x] 展示华北地区当期考核目标 88.39%
- [x] 优化环形进度描边、圆角端点和数字层级
- [x] 统一应收、实收标签与数值字号
- [x] 保持左右各占一半和原数据口径
- [x] 完成云端真实数据、交互、溢出与自动化回归

final result: passed

---

# R19 收缴率环形图尺寸增量 QA

## 比较对象

- Source visual truth：`docs/design-evidence/r19-collection-ring-source.png`
- Implementation full view：`docs/design-evidence/r19-collection-ring-local.png`
- Implementation focused region：`docs/design-evidence/r19-collection-ring-local-card.png`
- Focused side-by-side comparison：`docs/design-evidence/r19-collection-ring-comparison.png`
- 状态：首页已登录、默认桌面视图、收缴率复合卡静态状态。

## 视口与归一化

- 源标注图：1096 × 360 px。
- 实现全景：1721 × 873 px，对应 1721 × 873 CSS 视口。
- 实现卡片裁切：541 × 165 px；对照图将源图保持 360px 高，将实现裁切等比缩放至 360px 高后横向拼接，不拉伸。
- 浏览器报告 `devicePixelRatio: 2`，截图接口输出按 CSS 像素尺寸保存；对照时只比较卡片内容比例，不比较浏览器缩放造成的绝对像素。

## 必查表面

- 字体与排版：通过。环内主值由 22px 调至 24px，差值为 13px/18px；字重、字族与原 APH 卡片一致，无换行或截断。
- 间距与布局节奏：通过。环图由 88px 放大至 100px；卡片保持 164px 高，正文区 102px，环图上下各保留约 1px 安全空间；左右仍严格各占一半。
- 色彩与视觉令牌：通过。沿用原危险状态红、浅灰底环、淡红投影和分隔线，没有新增颜色。
- 图像与资产：通过。继续使用组件原有 SVG 圆环和图标资产，只调整既有图形容器尺寸；无替代图形或低清资源。
- 文案与内容：通过。收缴率、差值、应收和实收文案及数据均未修改。

## Findings

- 无 P0、P1、P2 问题。
- 无遗留 P3。放大后的环图已填补左区空白，同时未压迫标题、分隔线或右侧金额。

## 交互与工程验证

- 卡片及正文无横向或纵向溢出。
- 左右网格实测为 `251.164px / 251.164px`，等分结构未改变。
- 浏览器控制台：0 个 error。
- 自动化测试：120/120 通过。

## 比较历史

### Iteration 1

- 发现：原环图仅 88px，左半区留白偏多，环内文字视觉权重不足。
- 修复：环图调整为 100px；主值调整为 24px；差值调整为 13px；仅收紧收缴率卡上下内边距以提供 102px 正文空间。
- 修复后证据：`docs/design-evidence/r19-collection-ring-comparison.png`。

## Implementation Checklist

- [x] 放大环图和环内文字
- [x] 保留卡片高度及左右等分
- [x] 保留右侧金额区和业务数据
- [x] 检查溢出、控制台和自动化回归

final result: passed

---

# R21 收缴率环内文字安全区增量 QA

## 比较对象

- Source visual truth：`docs/design-evidence/r21-ring-safe-type-source.png`
- Implementation full view：`docs/design-evidence/r21-ring-safe-type-production.png`
- Implementation focused region：`docs/design-evidence/r21-ring-safe-type-production-left.png`
- Focused side-by-side comparison：`docs/design-evidence/r21-ring-safe-type-comparison.png`
- 状态：云端已登录、首页默认桌面视图、真实收缴率 63.24%、距目标 25.15%。

## 视口与归一化

- 源问题截图：542 × 346 px。
- 云端实现全景：1720 × 868 px，对应 1720 × 868 CSS 视口。
- 云端左半区裁切：271 × 165 px。
- 对照图：源图和实现图分别等比缩放并居中到 271 × 173 px，再横向拼接为 542 × 173 px；未拉伸内容。

## 必查表面

- 字体与排版：通过。当前值改为 18px/23px，距目标改为 9px/13px；两者分别实测宽 60.16px 和 60.52px，均小于 70px 安全内径。
- 间距与布局节奏：通过。环内文字容器固定为 70 × 70px，四周各留 15px；圆环仍为 100 × 100px，卡片及左右等分未改变。
- 色彩与视觉令牌：通过。保留 APH 红、灰色辅助文本和浅色底环，没有新增颜色。
- 图像与资产：通过。没有增加或替换图形资产，仅约束原组件文字安全区。
- 文案与内容：通过。真实当前值、距目标和标题区 88.39% 考核目标均保留。

## Findings

- 无 P0、P1、P2 问题。
- 环内主值和辅助值均未触碰圆环，文字容器无裁切、无溢出。

## 比较历史

### Iteration 1

- 发现：R20 的 23px 当前值和 11.5px 辅助值超出约 70px 的圆环安全内径，遮挡右侧进度弧。
- 修复：将当前值调整为 18px/23px，将辅助值调整为 9px/13px，并把中心内容限制在 70 × 70px 安全区。
- 修复后证据：`docs/design-evidence/r21-ring-safe-type-comparison.png`。

## 交互与工程验证

- 当前值宽 60.16px，安全区宽 70px，`mainFits=true`。
- 辅助值宽 60.52px，安全区宽 70px，`subFits=true`。
- 中心容器、圆环及卡片均无横向或纵向溢出。
- 自动化测试：127/127 通过。
- 云端服务 active，R21 样式已加载。

## Implementation Checklist

- [x] 当前值完全置于圆环安全内径内
- [x] 距目标文字完全置于圆环安全内径内
- [x] 保留 88.39% 考核目标和真实数据
- [x] 保持卡片尺寸、环图尺寸和左右等分
- [x] 完成云端真实数据截图复核

final result: passed

---

# R23 经营分组与服务中心数字号统一增量 QA

## 比较对象

- Source visual truth：`docs/design-evidence/r23-scope-count-type-source.png`
- Implementation full view：`docs/design-evidence/r23-scope-count-type-production.png`
- Implementation focused region：`docs/design-evidence/r23-scope-count-type-production-card.png`
- Focused side-by-side comparison：`docs/design-evidence/r23-scope-count-type-comparison.png`
- 状态：云端已登录、首页默认桌面视图、真实经营数据。

## 视口与归一化

- 源问题截图：1124 × 350 px。
- 云端实现截图：1920 × 929 px，对应 1920 × 929 CSS 视口。
- 云端经营分组卡裁切：607 × 164 px。
- 对照图：源图与实现图等比缩放并居中到 607 × 190 px，再横向拼接为 1214 × 190 px；未拉伸内容。

## 必查表面

- 字体与排版：通过。主数 `9` 与总数 `56` 均为 34px/42px、600 字重，基线一致。
- 间距与布局节奏：通过。数值组保持水平居中，标题和底部说明位置不变。
- 色彩与视觉令牌：通过。保留原有主次文字颜色，不改变 APH 红色图标和浅色卡片。
- 图像与资产：通过。没有新增或替换任何图形资产。
- 文案与内容：通过。`9 / 56` 及经营分组说明均未改动。

## Findings

- 无 P0、P1、P2 问题。
- 两个数字字号、行高和字重完全一致，未出现换行、裁切或溢出。

## 比较历史

### Iteration 1

- 发现：旧样式将总数 `56` 固定为 22px，而主数 `9` 为 34px，视觉权重不一致。
- 修复：覆盖旧的次级字号规则，将总数统一为 34px/42px、600 字重；数据和布局保持不变。
- 修复后证据：`docs/design-evidence/r23-scope-count-type-comparison.png`。

## 交互与工程验证

- R23 样式资源已在 R22 后加载并返回 HTTP 200。
- 经营分组卡仍保持原网格位置和卡片尺寸。
- 自动化测试：133/133 通过。
- 云端服务 active，健康检查正常。

## Implementation Checklist

- [x] 统一 `9` 与 `56` 的字号、行高和字重
- [x] 保留斜杠、颜色层级和居中布局
- [x] 不修改业务数据和其它卡片
- [x] 完成全量测试、云端发布和真实页面截图复核

final result: passed

---

# R24 次级页面布局统一 QA

## 范围与边界

- 本轮优化：项目管理、经营工作台、AI 预警中心、AI 经营月报、研发审核系统。
- 明确保留：每日回款明细、回款执行评估、收缴率明细不加载 R24 路由样式。
- 未修改收缴率接口、统计口径、业务数据和权限逻辑。

## Before / After

- Before：项目管理头部与指标区占高过大，首屏只能看到少量项目明细。
- After：压缩头部、指标与筛选工具栏，首屏明细行数增加，表格仍保持完整字段。
- Before：经营工作台左右主卡高度不一致，操作入口呈悬空短栏。
- After：经营判断和下一步操作卡等高，左右视觉重量一致。
- Before：AI 预警单条来源告警只占一列；AI 月报门禁信息重复且工具栏分散。
- After：单条来源告警通栏展示；AI 月报只保留必要门禁说明，筛选、模式与导出归并为一条工具栏。
- Before：研发审核页次要文字与卡片边界偏弱。
- After：提升边界和辅助文字对比度，不改变原功能与权限。

## 云端证据

- `docs/design-evidence/r24-projects-production.png`
- `docs/design-evidence/r24-command-production.png`
- `docs/design-evidence/r24-ai-alerts-production.png`
- `docs/design-evidence/r24-ai-report-production.png`
- `docs/design-evidence/r24-review-production.png`

## 工程与浏览器验证

- 自动化测试：137/137 通过。
- 云端服务：`first-service-cockpit.service` active。
- 健康检查：`/api/health` 返回 `status=ok`、`live=true`。
- R24 v2 CSS/JS 均返回 HTTP 200，并使用 immutable 缓存。
- 5 个目标页面桌面视口均无横向溢出。
- AI 月报导出操作已归入右侧模式操作区，筛选区不再混入导出按钮。
- 每日回款明细、回款执行评估、收缴率明细的 R24 路由类均为空，且无横向溢出。
- 控制台未发现驾驶舱应用脚本异常；仅记录到浏览器扩展消息通道关闭提示。

## Implementation Checklist

- [x] 项目管理提升首屏数据密度
- [x] 经营工作台左右主卡等高
- [x] AI 预警来源卡和空状态层级清晰
- [x] AI 月报去重并统一工具栏顺序
- [x] 研发审核页提升可读性
- [x] 三张已验收明细页保持不变
- [x] 完成云端发布、健康检查和真实页面截图回归

final result: passed

---

# R25 全站有效路由误 404 修复 QA

## 问题与根因

- 系统管理入口的链接在 DOM 中被改为 `/system/`，但原 SPA 点击处理仍拦截该链接并执行站内路由，最终显示“未找到这个页面”。
- 主驾驶舱有效路由带尾斜杠时没有统一归一，`/command/`、`/payment/`、`/collection/`、`/daily/`、AI、审核和登录等地址会进入误 404。
- 系统管理独立页仍使用 `/alerts`、`/report` 两条历史地址。

## Before / After

- Before：点击系统管理后地址为 `/system/`，页面内容却是驾驶舱 404。
- After：系统管理、后台、欠费和独立审核入口统一执行整页导航，不再被 SPA 拦截。
- Before：有效 SPA 页面末尾多一个 `/` 即进入误 404。
- After：有效路由自动归一到正式无尾斜杠路径，查询参数和锚点保持不变。
- Before：旧 AI 地址进入 404。
- After：`/alerts`、`/report` 自动迁移到 `/ai-alerts`、`/ai-report`，系统管理页链接同步修正。
- 真正不存在的地址继续显示站内 404，没有改成错误的首页兜底。

## 云端证据

- `docs/design-evidence/r25-system-route-production.png`
- 云端系统管理页标题为“系统管理 · 第一服务华北地区”，使用界面和后台管理入口均正常显示。

## 工程与浏览器验证

- 自动化测试：141/141 通过。
- 修复前复现 10 个有效地址误 404；修复后 11 类有效/历史地址均进入正确页面。
- `/projects/1/` 自动归一为 `/projects/1`，项目详情仍可打开。
- 云端系统管理入口键盘激活后正确整页跳转到 `/system/`。
- 系统管理页 AI 预警入口和 AI 月报入口分别指向 `/ai-alerts`、`/ai-report`，实际点击不再进入 404。
- 未知地址 `/not-a-real-cockpit-page/` 仍显示站内 404。
- 发布后健康检查返回 `status=ok`、`live=true`，服务保持 active。
- 发布后未发现新的路由相关应用异常；修复前 `/projects/` 的旧错误已由路径归一消除。

## Implementation Checklist

- [x] 独立页面入口强制整页导航
- [x] 全部现行 SPA 路由兼容尾斜杠
- [x] 项目详情尾斜杠兼容
- [x] 两条历史 AI 地址自动迁移
- [x] 系统管理页旧链接修正
- [x] 真正未知地址继续保留 404
- [x] 完成全量测试、云端发布和浏览器逐页回归

final result: passed
