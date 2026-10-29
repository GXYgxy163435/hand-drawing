# 手绘｜Hand Drawing

基于 MediaPipe Hand Landmarker 的隔空手势绘画网页——不用鼠标、不碰屏幕，用悬空的手在摄像头前作画。

## 技术栈 / Stack

- 前端：原生 HTML / CSS / JavaScript（无框架、无构建工具）
- 手势识别：MediaPipe Tasks Vision `@mediapipe/tasks-vision@0.10.14`（HandLandmarker，GPU/CPU 自动降级）
- 画布：Canvas 2D（手写绘制 / 橡皮 / 直线 / 矩形 / 圆形 / 文字）

## 本地运行 / Run Locally

需要摄像头权限，必须在 `http://localhost` 安全上下文打开：

```bash
# VS Code 安装 Live Server 扩展，右键 index.html → Open with Live Server
# 或任意静态服务器：
npx serve .
```

打开后点「开始绘画」并允许摄像头权限，抬起食指即可作画。

## 手势 / Gestures

| 手势 | 动作 |
| --- | --- |
| 抬起食指 | 绘制线条 Draw |
| 按钮「清空画布」 | 一键清空 Clear |
| 摊开手掌停留 1 秒 | 导出 PNG Export |

## 工作流 / Workflow（四件套）

| 环节 | 工具 | 作用 |
| --- | --- | --- |
| 本地开发 | VS Code + Live Server | HTML/CSS/JS 分离开发与调试 |
| 版本管理 | Git + GitHub | 代码提交、历史留痕 |
| AI 辅助 | LM Studio | 本地代码补全与答疑 |
| 公网部署 | Cloudflare Workers/Pages | 上传静态文件生成公网链接 |

## 目录结构 / Structure

```
hand-drawing/
├── index.html      # 页面结构（导航 / 三栏布局 / 卡片 / footer）
├── style.css       # 三栏响应式样式（紫色主题、12 色色卡）
├── script.js       # MediaPipe 手势追踪 + Canvas 绘制核心逻辑
├── assets/
│   └── prototype-final.jpg  # 高保真 Prototype 设计稿
└── README.md
```

## 部署链接 / Deployed

- Cloudflare：https://calm-tree-9d54.2376661832.workers.dev/
- GitHub：https://github.com/GXYgxy163435/creative-programming-assignments（hand-drawing 目录）
