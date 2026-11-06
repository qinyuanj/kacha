# 画布开启 `onlyRenderVisibleElements` 的副作用（2026-11-06）

回答 [画布只渲染可见节点的副作用](https://github.com/qinyuanj/kacha/issues/48)，背景见 [大画板打开时图片加载偏重](https://github.com/qinyuanj/kacha/issues/44)。

依据版本：`@xyflow/react` 12.11.6、`@xyflow/system` 0.0.82（`client/node_modules` 实装版本）。源码引用以 tag `@xyflow/react@12.11.6` 为准，行号指 `node_modules` 里的 `dist/esm/index.mjs`。

来源：

- xyflow 源码：[`graph.ts`](https://github.com/xyflow/xyflow/blob/%40xyflow/react%4012.11.6/packages/system/src/utils/graph.ts)（`getNodesInside`、`getFitViewNodes`）、[`store.ts`](https://github.com/xyflow/xyflow/blob/%40xyflow/react%4012.11.6/packages/system/src/utils/store.ts)（`adoptUserNodes`、`parseHandles`）、[`edges/general.ts`](https://github.com/xyflow/xyflow/blob/%40xyflow/react%4012.11.6/packages/system/src/utils/edges/general.ts)（`isEdgeVisible`）、[`edges/positions.ts`](https://github.com/xyflow/xyflow/blob/%40xyflow/react%4012.11.6/packages/system/src/utils/edges/positions.ts)（`getEdgePosition`）、[`useVisibleNodeIds.ts`](https://github.com/xyflow/xyflow/blob/%40xyflow/react%4012.11.6/packages/react/src/hooks/useVisibleNodeIds.ts)、[`useVisibleEdgeIds.ts`](https://github.com/xyflow/xyflow/blob/%40xyflow/react%4012.11.6/packages/react/src/hooks/useVisibleEdgeIds.ts)、[`NodeToolbar.tsx`](https://github.com/xyflow/xyflow/blob/%40xyflow/react%4012.11.6/packages/react/src/additional-components/NodeToolbar/NodeToolbar.tsx)
- 官方文档：`ReactFlow` 组件属性的 JSDoc（`dist/esm/types/component-props.d.ts`），以及 [Server Side Rendering](https://reactflow.dev/learn/advanced-use/ssr-ssg-configuration) 里的 `width`/`height`/`initialWidth`/`handles` 说明。[Performance](https://reactflow.dev/learn/advanced-use/performance) 页没有提到这个属性。
- xyflow GitHub issues：[#3883](https://github.com/xyflow/xyflow/issues/3883)、[#4239 评论](https://github.com/xyflow/xyflow/issues/4239#issuecomment-2194870473)、[#5656](https://github.com/xyflow/xyflow/issues/5656)、[#6080](https://github.com/xyflow/xyflow/issues/6080)、[#5487](https://github.com/xyflow/xyflow/issues/5487)、[#4926](https://github.com/xyflow/xyflow/issues/4926)、[#3816](https://github.com/xyflow/xyflow/issues/3816)、[#4516](https://github.com/xyflow/xyflow/issues/4516)、[#4329](https://github.com/xyflow/xyflow/issues/4329)、[#3573](https://github.com/xyflow/xyflow/issues/3573)、[#2444](https://github.com/xyflow/xyflow/issues/2444)
- 本仓库：`client/src/ui/BoardCanvas.tsx`、`useCanvasInteraction.ts`、`edges.tsx`、`nodes.tsx`、`hoverInfo.tsx`

## 结论

1. **可以开启，核心交互不受影响。** 连线（含一端在视口外）、框选与多选、删除、fitView（Ctrl+0、Controls 按钮）、定位节点（`setCenter`）、悬浮动作条（`NodeToolbar`）和 MiniMap 都从 store 的 `nodeLookup` 取尺寸和端口位置，不依赖节点是否挂载。前提是保留画布现有的 `measured` 回传（见「必须保留」）。
2. **只开这个属性，解决不了 #44 打开画板时的下载量。** React Flow 会把所有还没测量的节点强制渲染一次（`forceInitialRender`），所以首次打开时 207 个 `<img>` 仍然全部挂载并设置 `src`，请求照样发出。属性生效在这之后：节点离开视口就卸载，DOM、布局和离屏解码随之减少。要减少首次请求，还需要配套做下面的「修补 A」。
3. **需要修补**：图片延迟加载或预先提供端口信息（A），悬浮动作条残留（B），节点卸载时丢失本地状态（C），以及 `autoFocus` 残留（D）。
4. **可以接受的已知限制**：连线按两端节点的包围盒判断是否可见（#6080，仍开放）；平移时节点反复挂载、卸载会有点卡，而且不能设缓冲区（#3883、#5656）；离屏节点内容变化后要等进入视口才重新测量。

## 机制（源码事实）

- **可见节点**：`useVisibleNodeIds` 调用 `getNodesInside(nodeLookup, 视口, transform, partially = true)`。满足下面任一条件的节点会被渲染：
  - 与视口有重叠（部分可见也算）；
  - `node.internals.handleBounds` 为空，也就是还没测量过（`forceInitialRender`，system `index.mjs` 第 340 行）；
  - `node.dragging` 为真。

  尺寸依次取 `measured`、`width`、`initialWidth`，都没有时取 0。
- **首次渲染全部节点**：官方确认这是现状（#3883 开放中，标题就是 "Currently all nodes get rendered initially even if one uses `onlyRenderVisibleElements`"）。
- **测量结果的保留**：`adoptUserNodes` 遇到新的 user node 对象时会重建内部节点。这时 `parseHandles` 的规则是：user node 没带 `handles` 也没带 `measured`，`handleBounds` 就重置为 `undefined`，节点会被重新测量（源码注释："if user re-initializes the node or removes `measured` … we reset the handleBounds"）。#3816 正是踩了这个坑：持久化的节点带着 width/height，却没有 measured。
- **可见连线**：`useVisibleEdgeIds` 只要求两端节点都在 `nodeLookup` 中，并且两端节点包围盒的并集与视口重叠（`isEdgeVisible`）。它不要求端点节点已挂载。路径坐标由 `getEdgePosition` 从 `internals.handleBounds`（或 `node.handles`）计算，同样不读 DOM。
- **fitView**：`getFitViewNodes` 默认只纳入 `measured.width/height` 非空的节点。传 `includeHiddenNodes: true` 时改用 `getNodeDimensions`，依次回退到 `width` 和 `initialWidth`（#5841 的修复）。
- **NodeToolbar**：从 `nodeLookup` 取节点算包围盒，节点没挂载也能定位。
- **框选**：`getNodesInside(nodeLookup, 框, …, Partial, true)` 遍历的是全部内部节点，与是否渲染无关。
- **MiniMap**：渲染 `nodeLookup` 中所有有尺寸的节点（`nodeHasDimensions` 同样会回退到 `width`、`initialWidth`），不受裁剪影响。
- **官方表态**：JSDoc 原文是 "This might improve performance when you have a large number of nodes and edges but also adds an overhead"。维护者在 #4239 里测过，瓶颈是 React 组件的挂载和卸载，不是可见性计算：2500 个节点的可见性计算约 0.25ms，而重渲染要 80ms。所以开启后平移时 "tends to be laggy as nodes & edges need to be constantly mounted and unmounted"。目前没有缓冲区参数，也不能把个别节点排除在裁剪之外（#5656 已作为 #3883 的重复关闭，#5487 维护者答复 "not possible at the moment"，#4926 转到 #4239 讨论）。

## 逐项对照本仓库实现

### 安全

| 功能 | 实现 | 为什么安全 |
|---|---|---|
| 连线一端在视口外 | `edges.tsx` 用 `getBezierPath`，坐标来自 RF props | 首次强制渲染后，所有节点都有 `handleBounds`。画布每次重建节点都会带上 `measured: measured[n.id]`，`parseHandles` 因此保留旧的 `handleBounds`。#4516、#4329（显式 width/height 加离屏节点导致连线不出现）在这里不会触发，因为节点都至少测量过一次。 |
| 框选 / Shift 加选 | `selectionOnDrag` + `SelectionMode.Partial` + `useCanvasInteraction` 的保留选区逻辑 | 框选遍历 `nodeLookup`，选区存在画布 state（`selectedNodes`），离屏的已选节点仍然保持选中。 |
| 删除、复制、方向键微移、运行选中 | 以画板模型和 `selectedRef` 为准 | 不依赖 DOM。 |
| fitView（Ctrl+0、Controls） | `flow.fitView({ duration })` | 所有节点首次都测量过，`measured` 被保留，所以都计入。只有采用修补 A2 时才需要改，见下文。 |
| 定位节点（运行指示跳转） | `flow.setCenter(board.pos + measured ?? size)` | 只用模型坐标，目标节点进入视口后自然挂载。 |
| 多选时的悬浮动作条位置 | `<NodeToolbar nodeId={[...selectedNodes]}>` | 包围盒来自 `nodeLookup`，离屏的选中节点也计入。 |
| MiniMap | `<MiniMap pannable zoomable />` | 照常显示全板，而且是 SVG 矩形，不加载图片。 |
| 拖线建节点、落点判定 | `dropTargetAt` 用 `elementFromPoint` | 指针下方的元素一定在视口内，已经挂载。 |
| 连线悬浮信息 | `onEdgeMouseMove`、`HoverSpan` | `useHoverLayer` 在 wheel 和 pointerdown 时收起浮层，触控板平移、右键拖动都会先收起，卸载后不会残留。 |

### 必须保留

- **`BoardCanvas` 把 `dimensions` 变更写进 `measured` state，并在 `nodes` 里回传。** 这条在开启后变成承重逻辑。删掉它或改成不回传，每次重建节点都会清空 `handleBounds`，所有节点又会被强制渲染一次，连线也会闪断。建议加注释，并补一个回归测试或断言。

### 需要修补

**A. 首次打开时请求全部图片（#44 的主要诉求）**

强制首渲染会挂载每个图片节点，以及提示词节点里的参考图缩略图，并给 `<img>` 设置 `src`。按 HTML 规范，非 lazy 的 `img` 一设置 `src` 就开始抓取，元素随后卸载也不保证能取消请求。可选做法：

- **A1（最小改动，推荐先做）**：`nodes.tsx` 的 `Thumb` 和 `reference-guide` 两处 `<img>` 加 `loading="lazy" decoding="async"`。ReactFlow 外层 wrapper 带内联样式 `overflow: hidden`（`index.mjs` 第 3760 行），离屏节点被裁剪，浏览器只会加载视口附近的 lazy 图片。Chromium 的 lazy 加载有预加载距离，对滚动容器还会外扩 scroll margin，所以视口外一段距离内的图片仍可能被加载，但不会是全部。即使节点处在首帧强制渲染里，这条也成立。**这一点需要实测**：在 183 节点画板上用 DevTools Network 对比开启前后的请求数和传输量。
- **A2（彻底一些）**：让图片节点（reference、result）跳过首帧强制渲染。它们的宽高在画布里已经由 `imageBox` 算好；端口固定是左侧 `in` 和右侧 `out`，可以给 user node 加 `handles: [{ id, type, position, x, y, width, height }]`。坐标要和 `.port` 的 CSS 尺寸一致，缺图节点高度未知，不能加。代价有三：
  - 提供 `handles` 后，RF 只用它，不再读 DOM 测量的端口位置；
  - 缩放节点时要同步重算 `handles`；
  - 这些节点在进入视口前没有 `measured`，默认 fitView 不会计入它们，所以 Ctrl+0 和 `<Controls fitViewOptions>` 都要传 `includeHiddenNodes: true`，改用 `width`/`height` 回退值。

  提示词和任务节点高度会随内容变化，端口数量也不固定，不适合预先提供，仍然走一次强制渲染。不过它们只有提示词节点里的参考图缩略图涉及图片，这部分靠 A1 处理。
- A1 和 A2 都和 #44 的缓存头、缩略图方案正交，可以叠加。

**B. 悬浮动作条残留**

`hovered` 只在 `onNodeMouseLeave` 中清除。节点在光标下方被平移出视口并卸载后，不会再收到 mouseleave，`hovered` 保持原值。节点回到视口时，动作条会在没有悬浮的情况下重新出现。修法任选其一：

- `ImageNode` 在 effect 的清理函数里通知画布清除 `hovered`（例如在 `BoardContext` 上加一个 `leaveNode(id)`）；
- 或者在 `onMoveStart` 时调用 `hideActionBarSoon()`。这样做的副作用是滚轮缩放时动作条也会先收起。

**C. 节点卸载时丢失本地状态**

React Flow 不支持把单个节点排除在裁剪之外（#5487、#4926）。下面这些组件内 state 会随卸载丢失：

- `PromptNodeView` 的 `pending`（下游有执行记录时，等待「断开 / 不断开」三选一的未提交文本）和 `keep`。正在输入时用触控板把节点平移出视口，未提交的文本会丢失，焦点也会丢。
- 宽高比手填控件的 `draft`、`open`、`hint`，以及 `TaskNodeView` 的 `infoOpen`。丢了影响不大。
- `Thumb` 的 `missing`：重新挂载后会再请求一次图片，然后再次触发 onError，结果正确。

建议把 `pending`/`keep` 提升到画布层，按节点 id 存储。如果接受「平移走即放弃未提交编辑」，至少要在文档或交互说明里写明。

**D. `autoFocus` 残留**

`focusPrompt` 设置后不会清除。「以此继续编辑」新建的提示词如果落在视口外，当时不会挂载，聚焦不生效；等它日后进入视口第一次挂载时，`useEffect` 会抢走焦点。修法：聚焦一次后清除 `focusPrompt`，或者新建后先 `setCenter` 到新节点。

### 可接受的已知限制（无需修补，知会即可）

- **连线可见性按包围盒判断**：`isEdgeVisible` 用两端节点包围盒的并集判断。两端都在视口外、但路径穿过视口的连线，只要包围盒与视口重叠就会渲染，这一点没问题。回绕的贝塞尔曲线（目标在源的左侧）会凸出包围盒，凸出的部分可能在视口边缘提前消失。#6080 提议加自定义判定，仍开放。本画板连线基本是左进右出，影响很小。
- **平移卡顿与挂载闪现**：节点刚接触视口边缘才挂载，图片随后才开始解码，可能闪一下。这个功能没有缓冲区参数（#3883、#5656）。如果实测明显，可以结合 #44 的缩略图方案降低单张图片的解码成本。
- **离屏节点不会重新测量**：任务节点在视口外运行，摘要或状态改变导致高度变化时，`measured` 和端口位置要等它进入视口、ResizeObserver 重测后才更新。连线端点可能跳一下。
- **拖动中节点离开视口**：本画板是受控模式，重建节点时没有回传 `dragging`，所以 `getNodesInside` 的 `|| node.dragging` 保护不生效。正常拖动时，节点在光标下方，并且有 autoPan，不会离开视口。只有把节点拖出画布区域时，它才可能在拖动途中被卸载（类似 #2444）。d3-drag 的监听挂在 window 上，拖动预计不会中断，但需要手测确认 `onNodeDragStop` 仍然触发（它关系到撤销步合并键 `activeDrag` 能否复位）。如果有问题，可以在 `position` 变更带 `dragging` 时把它回传到 user node。
- **e2e**：`e2e/common/boards.ts` 用 `.react-flow__node[data-id=…]` 定位节点。如果测试画板有节点初始就在视口外，开启后这些定位会失效。开启后需要跑一遍全量 e2e。

## 建议落地顺序

1. 开启 `onlyRenderVisibleElements`，同时做 B、D，并给 `measured` 回传加注释和测试。
2. 做 A1，在 183 节点画板上实测打开时的请求数和传输量。如果首帧仍有大量请求，再评估 A2（以及 fitView 的 `includeHiddenNodes`）。
3. C 按产品取舍：提升 `pending` 状态，或者接受并说明。
4. 收尾时跑全量 e2e，并手测：拖动节点出画布再拖回、触控板平移时悬浮动作条的表现、正在输入时平移走提示词节点。
