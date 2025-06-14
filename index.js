import { Client, GatewayIntentBits, Partials, AttachmentBuilder } from 'discord.js';
import sharp from 'sharp';
import { request } from 'undici';
import express from 'express';
import cropFrame from './cropFrame.js';

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

      // ── 額縁があればトリム
      const { buf: readyBuf, cropped } = await cropFrame(orig);

      // ── 回転補正 & メタ取得
      const img  = sharp(readyBuf).rotate();
      const meta = await img.metadata();
      const { width, height, format } = meta;

      // ── リサイズ不要ならスキップ
      if (Math.max(width, height) <= MAX_SIZE && !cropped) continue;

      // ── 出力フォーマット（PNG は PNG のまま）
      const supported = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'];
      const outFmt  = supported.includes(format) ? format : 'jpeg';
      const newExt  = outFmt === 'jpeg' ? '.jpg' : '.' + outFmt;

      // ── リサイズ
      const resized = await img
        .resize({
          width:  width >= height ? MAX_SIZE : null,
          height: height >  width ? MAX_SIZE : null,
          fit: 'inside',
          withoutEnlargement: true
        })
        .toFormat(
          outFmt,
          outFmt === 'jpeg' ? { mozjpeg: true } : undefined
        )
        .toBuffer();

      // ── ファイル名生成
      const base = at.name.replace(/\.[^.]+$/, '');
      const fileName = `${base}${cropped ? '_cropped' : ''}_resized${newExt}`;
      const file = new AttachmentBuilder(resized, { name: fileName });

      // ── 返信
      await msg.reply({
        content: `🔄 Processed ${at.name}${cropped ? ' (cropped)' : ''}`,
        files: [file]
      });
    } catch (err) {
      console.error('Process failed:', err);
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
