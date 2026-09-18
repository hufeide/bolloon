/* card.js — 名片渲染 (Canvas 2D, 纯本地; 挂在 window.BCardRender)
 *
 * 约束:
 *   · 不用外部字体/图片;canvas 内只用系统字体栈 (sans-serif), 头像用用户自选图的 blob/data
 *   · 导出用 canvas.toDataURL('image/png') → 已是完整 data:uri, 交给 writeTempFile 时不要截断
 *   · 750×1000 固定画布, 通过 CSS 宽度自适应显示 (跨端一致)
 */
(function (global) {
  'use strict';

  var W = 750;
  var H = 1000;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /** 按宽度折行 (中文按字断, 英文按词) */
  function wrapText(ctx, text, maxWidth) {
    var s = String(text || '');
    var lines = [];
    var line = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '\n') { lines.push(line); line = ''; continue; }
      var test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawAvatarPlaceholder(ctx, cx, cy, r, name) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = '#26272d';
    ctx.fill();
    var ch = String(name || '智').slice(0, 1);
    ctx.fillStyle = '#ff2e4d';
    ctx.font = '600 52px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, cx, cy + 2);
    ctx.restore();
  }

  /**
   * 渲染名片。返回 { ok, canvas, error }
   * @param canvas 目标 canvas (750×1000)
   * @param profile 身份数据
   * @param avatarImage 已 onload 的 Image 或 null
   */
  function render(canvas, profile, avatarImage) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: '当前环境不支持 Canvas 2D' };

    canvas.width = W;
    canvas.height = H;

    // 背景
    ctx.fillStyle = '#0f1012';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#17181b';
    roundRect(ctx, 40, 40, W - 80, H - 80, 28);
    ctx.fill();

    // 顶部品牌条
    ctx.fillStyle = '#ff2e4d';
    roundRect(ctx, 40, 40, W - 80, 8, 4);
    ctx.fill();

    // 头像
    var cx = 40 + 70 + 46;
    var cy = 40 + 60 + 46;
    if (avatarImage) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 46, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatarImage, cx - 46, cy - 46, 92, 92);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 46, 0, Math.PI * 2);
      ctx.strokeStyle = '#2a2b30';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    } else {
      drawAvatarPlaceholder(ctx, cx, cy, 46, profile.name);
    }

    // 昵称
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 46px sans-serif';
    var name = String(profile.name || '未命名智能体');
    ctx.fillText(name.length > 12 ? name.slice(0, 12) + '…' : name, 230, 40 + 60 + 36);

    // 简介
    ctx.font = '26px sans-serif';
    ctx.fillStyle = '#9a9aa3';
    var bioLines = wrapText(ctx, profile.bio || '（还没有简介）', W - 80 - 190);
    for (var i = 0; i < Math.min(bioLines.length, 2); i++) {
      ctx.fillText(bioLines[i], 230, 40 + 60 + 76 + i * 36);
    }

    var y = 300;

    // 标签
    var tags = Array.isArray(profile.tags) ? profile.tags.slice(0, 5) : [];
    if (tags.length) {
      ctx.font = '24px sans-serif';
      var x = 80;
      for (var t = 0; t < tags.length; t++) {
        var label = tags[t];
        var w = ctx.measureText(label).width + 36;
        if (x + w > W - 80) { x = 80; y += 62; }
        ctx.fillStyle = '#22232a';
        roundRect(ctx, x, y, w, 48, 24);
        ctx.fill();
        ctx.fillStyle = '#d6d6dd';
        ctx.fillText(label, x + 18, y + 33);
        x += w + 14;
      }
      y += 86;
    } else {
      y += 10;
    }

    // 分隔线
    ctx.strokeStyle = '#24252b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(80, y);
    ctx.lineTo(W - 80, y);
    ctx.stroke();
    y += 52;

    // 智能体标识 (完整值太长会溢出 → 折行显示)
    ctx.fillStyle = '#77777f';
    ctx.font = '22px sans-serif';
    ctx.fillText('智能体标识', 80, y);
    y += 40;
    ctx.fillStyle = '#e6e6ea';
    ctx.font = '26px ui-monospace, Menlo, monospace';
    var idLines = wrapText(ctx, String(profile.agentId || '（未填）'), W - 160);
    for (var k = 0; k < Math.min(idLines.length, 2); k++) {
      ctx.fillText(idLines[k], 80, y);
      y += 36;
    }
    if (idLines.length > 2) y += 4;
    y += 28;

    // 接入点 (只显示 host 与模型, 不显示 key)
    var ep = profile.endpoint || {};
    var host = '';
    if (ep.baseUrl) {
      var m = /^[a-z]+:\/\/([^/]+)/i.exec(String(ep.baseUrl));
      host = m ? m[1] : String(ep.baseUrl);
    }
    ctx.fillStyle = '#77777f';
    ctx.font = '22px sans-serif';
    ctx.fillText('接入点', 80, y);
    y += 40;
    ctx.fillStyle = '#e6e6ea';
    ctx.font = '26px sans-serif';
    ctx.fillText(host ? host : '（未填 · 在 App 里接入）', 80, y);
    y += 40;
    if (ep.model) {
      ctx.fillStyle = '#9a9aa3';
      ctx.font = '24px sans-serif';
      ctx.fillText('模型: ' + String(ep.model).slice(0, 40), 80, y);
      y += 40;
    }
    if (ep.key) {
      ctx.fillStyle = '#9a9aa3';
      ctx.font = '24px sans-serif';
      ctx.fillText('Key: ****' + String(ep.key).slice(-4), 80, y);
      y += 40;
    }

    // 底部说明
    var footY = H - 40 - 96;
    ctx.strokeStyle = '#24252b';
    ctx.beginPath();
    ctx.moveTo(80, footY);
    ctx.lineTo(W - 80, footY);
    ctx.stroke();
    ctx.fillStyle = '#77777f';
    ctx.font = '24px sans-serif';
    ctx.fillText('把这张卡发给朋友,对方在 App 智能体里', 80, footY + 44);
    ctx.fillText('粘贴「交接串」即可建联', 80, footY + 80);

    return { ok: true, canvas: canvas };
  }

  /** 导出为完整 data:uri (直接可传 writeTempFile / postNote 的 url) */
  function toDataUri(canvas) {
    try { return canvas.toDataURL('image/png'); } catch (e) { return ''; }
  }

  /** 头像缩放: 最长边 maxSide, 输出 jpeg data:uri (避免大 Base64 进本地存储) */
  function downscaleImage(img, maxSide, quality) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) return '';
    var scale = Math.min(1, maxSide / Math.max(w, h));
    var tw = Math.max(1, Math.round(w * scale));
    var th = Math.max(1, Math.round(h * scale));
    var c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    var ctx = c.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(img, 0, 0, tw, th);
    try { return c.toDataURL('image/jpeg', quality || 0.85); } catch (e) { return ''; }
  }

  global.BCardRender = {
    W: W,
    H: H,
    render: render,
    toDataUri: toDataUri,
    downscaleImage: downscaleImage,
    wrapText: wrapText
  };
})(window);
