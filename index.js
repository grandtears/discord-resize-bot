import { Client, GatewayIntentBits, Partials, AttachmentBuilder } from 'discord.js';
import sharp from 'sharp';
import { request } from 'undici';

const TOKEN           = process.env.DISCORD_TOKEN;
const TARGET_CHANNEL  = process.env.TARGET_CHANNEL_ID;  // 監視対象
const MAX_SIZE        = 2048;                           // 長辺の上限

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async msg => {
  console.log('[DBG] messageCreate:', msg.id, msg.attachments.size, msg.content);
  if (msg.channel.id !== TARGET_CHANNEL) return;           // 別チャンネルは無視
  if (!msg.attachments.size) return;                       // 添付なしは無視

  for (const [, attach] of msg.attachments) {
    if (!attach.contentType?.startsWith('image/')) continue;

    try {
      // 画像をバッファで取得
      const res  = await request(attach.url);
      const orig = Buffer.from(await res.body.arrayBuffer());

      const img  = sharp(orig);
      const meta = await img.metadata();
      const { width, height } = meta;

      // すでに長辺 ≦ MAX_SIZE ならスキップ
      if (Math.max(width, height) <= MAX_SIZE) continue;

      // リサイズ（長辺だけ 2048 に収める）
      const resized = await img
        .resize({ width: width >= height ? MAX_SIZE : null,
                  height: height > width ? MAX_SIZE : null,
                  fit: 'inside',
                  withoutEnlargement: true })
        .toFormat('jpeg', { mozjpeg: true })
        .toBuffer();

      // ファイル名: 元ファイルに _2048  suffix
      const fileName = attach.name.replace(/\.[^.]+$/, '') + '_2048.jpg';
      const file = new AttachmentBuilder(resized, { name: fileName });

      // 元メッセージに返信でアップロード
      await msg.reply({ content: `🔄 Resized ${attach.name}`, files: [file] });
    } catch (e) {
      console.error('Resize failed:', e);
    }
  }
});

// ここから HTTP Keep-Alive 用
import express from 'express';
const PORT = process.env.PORT || 8080;   // Render が PORT を注入

const app = express();
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/',      (_, res) => res.send('Bot Alive')); // HealthCheck 兼トップ

app.listen(PORT, () => console.log(`Keep-alive server on :${PORT}`));


client.login(TOKEN);
