import { Client, GatewayIntentBits, Partials, AttachmentBuilder } from 'discord.js';
import sharp from 'sharp';
import { request } from 'undici';
import express from 'express';

// ──────────── 環境変数 ────────────
const TOKEN           = process.env.DISCORD_TOKEN;
const TARGET_CHANNEL  = process.env.TARGET_CHANNEL_ID;      // 監視対象 (親 or スレッド)
const MAX_SIZE        = Number(process.env.MAX_SIZE) || 2048;

// ──────────── Discord クライアント ────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent          // 添付取得の安全策
  ],
  partials: [Partials.Message, Partials.Channel]
});

// ──────────── 共通ハンドラ ────────────
async function handleImageMessage(msg) {
  // 親チャンネルまたはスレッド？
  const ok =
    msg.channel.id === TARGET_CHANNEL ||
    msg.channel.parentId === TARGET_CHANNEL;
  if (!ok) return;

  if (msg.partial) await msg.fetch();               // 欠損補完

  if (!msg.attachments.size) return;                // 画像無し

  for (const [, at] of msg.attachments) {
    if (at.contentType && !at.contentType.startsWith('image/')) continue;

    try {
      // ── 元画像取得
      const res  = await request(at.url);
      const orig = Buffer.from(await res.body.arrayBuffer());

      // ── メタデータ取得
      const img  = sharp(orig).rotate();            // EXIF に合わせ自動回転
      const meta = await img.metadata();
      const { width, height, format } = meta;

      if (Math.max(width, height) <= MAX_SIZE) continue; // 小さいなら無視

      // ── 出力フォーマット（PNG は PNG のまま）
      const supported = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'];
      const outFmt  = supported.includes(format) ? format : 'jpeg';
      const newExt  = outFmt === 'jpeg' ? '.jpg' : '.' + outFmt;

      // ── リサイズ
      const buf = await img
        .resize({
          width:  width >= height ? MAX_SIZE : null,
          height: height >  width ? MAX_SIZE : null,
          fit: 'inside',
          withoutEnlargement: true
        })
        [`to${outFmt.charAt(0).toUpperCase() + outFmt.slice(1)}`]()
        .toBuffer();

      // ── 返信
      const fileName = at.name.replace(/\.[^.]+$/, '') + `_resized${newExt}`;
      const file     = new AttachmentBuilder(buf, { name: fileName });

      await msg.reply({ content: `🔄 Resized ${at.name}`, files: [file] });
    } catch (e) {
      console.error('Resize failed:', e);
    }
  }
}

// ──────────── イベント登録 ────────────
client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));

client.on('messageCreate', async msg => {
  // 添付が載っていれば即処理、無ければ messageUpdate を待つ
  if (msg.attachments.size) return handleImageMessage(msg);

  // まだアップロード中の可能性：同 ID の messageUpdate を待機
  const onUpdate = async (oldMsg, newMsg) => {
    if (newMsg.id !== msg.id) return;
    client.off('messageUpdate', onUpdate);           // 一度だけ処理
    await handleImageMessage(newMsg);
  };
  client.on('messageUpdate', onUpdate);
});

client.on('messageUpdate', handleImageMessage);      // 後添付のみのケースも拾う

// ──────────── Keep-alive HTTP ────────────
const app  = express();
const PORT = process.env.PORT || 8080;
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/',      (_, res) => res.send('Bot Alive'));
app.listen(PORT, () => console.log(`Keep-alive server on :${PORT}`));

client.login(TOKEN);
