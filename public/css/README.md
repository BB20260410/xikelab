# public/css/ — 按 view 拆分目标

> 当前：style.css 3931 行单文件
> 目标：按 view 拆成 7-10 个文件，主 style.css 改成 import

## 拆分计划（v0.82+）
- base.css       — token / reset / 全局
- layout.css     — .app grid / sidebar / inspector
- modal.css      — .modal-* + .confirm-modal
- room.css       — .room-* 4 房模式
- sidebar.css    — sidebar + session-list
- inspector.css  — inspector + tabs
- form.css       — input / button / cxbtn
- utility.css    — .muted / .hint-text / hidden

## 已经准备好的 token starter
- lobe-tokens-extension.css（W4 学习产出）→ 完整迁移后可移这里
