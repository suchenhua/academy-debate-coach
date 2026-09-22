/* 本副本的身份指纹 —— 由安装根目录推导，只上报 sha1 前 12 位，不暴露真实路径。
 *
 * 为什么需要它：多个副本（Pro / Flash / 旧安装 / 桌面上解压了三份 zip）默认都用同一个端口，
 * 而调用方只要看到端口上有服务就复用 —— 结果「点哪个快捷方式打开的都是同一个版本」。
 * 反过来，端口被非本 App 的服务占了（任何本地 HTTP 服务）时，server.js 会自己 +1 挪走，
 * 调用方若还死盯原来那个端口等，就是「双击后卡 45 秒然后什么都不出现」。
 * 把指纹随 /api/status 上报，两边就都能判断「这个 server 到底是不是自己这份」。
 *
 * 注意：算不出同一个指纹（比如同一份目录换了盘符映射名）时，失败方向是
 * 「不复用、另起一个自己的」而不是「错连到别人的」—— 宁可多起一个进程。
 */
'use strict';
const crypto = require('crypto');
const path = require('path');

function instanceRoot(rootDir) {
  return crypto.createHash('sha1')
    .update(String(rootDir == null ? '' : rootDir).toLowerCase().replace(/\\/g, '/'), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

module.exports = { instanceRoot, SELF: instanceRoot(path.resolve(__dirname, '..')) };
