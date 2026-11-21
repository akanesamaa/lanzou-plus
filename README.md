# Lanzou++

蓝奏云文件夹批量下载 userscript，仅供桌面浏览器使用，需要 Tampermonkey 等脚本管理器

实现细节和站点行为说明见 [docs/internals.md](docs/internals.md)。

## 功能

- 在文件夹分享页为每个文件添加复选框
- 自动加载全部文件页，不需要手动点「显示更多文件」
- 按文件名搜索，支持精确匹配和字符顺序模糊匹配
- 全选、清空已选
- 批量下载选中文件
- 下载中可停止，失败项可单独重试
- Firefox：隐藏 iframe 静默下载
- Chromium：固定单窗口下载，整批发完后 10 秒自动关闭
- 手机/纯触摸设备停用，不注入任何内容

## 使用

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开 [lanzou-plus.user.js](https://raw.githubusercontent.com/akanesamaa/lanzou-plus/main/lanzou-plus.user.js) 安装，或把脚本拖入 Tampermonkey
3. 打开蓝奏云文件夹分享页，输入提取码
4. 等待自动加载完成
5. 勾选文件，或先搜索再勾选
6. 点「下载」
7. 下载完点「清空已选」，再勾下一批

Chromium 第一次下载需要允许本页弹窗；Firefox 不需要。

## 大数据量

- 「全选」是选择全部文件，不是分批
- 没有自动分批
- 大量级建议手动分 50～100 个一批
- 每批之间用「清空已选」重置选择

## 许可证

MIT
