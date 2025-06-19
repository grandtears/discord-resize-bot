import { Client, GatewayIntentBits, Partials, AttachmentBuilder } from 'discord.js';
import sharp from 'sharp';
import { request } from 'undici';
import express from 'express';
import cropFrame from './cropFrame.js';

// ──────────── 環境変数 ────────────
const TOKEN = process.env.DISCORD_TOKEN;
const TARGET_CHANNEL = process.env.TARGET_CHANNEL_ID
const MAX_SIZE = Number(process.env.MAX_SIZE) || 2048;

const TRIM_TARGET_WIDTH = Number(process.env.TRIM_TARGET_WIDTH) || 2048;
const TRIM_TARGET_HEIGHT = Number(process.env.TRIM_TARGET_HEIGHT) || 1440;
const TRIM_LEFT = Number(process.env.TRIM_LEFT) || 64;
const TRIM_TOP = Number(process.env.TRIM_TOP) || 69;
const TRIM_WIDTH = Number(process.env.TRIM_WIDTH) || 1920;
const TRIM_HEIGHT = Number(process.env.TRIM_HEIGHT) || 1080;

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
            const res = await request(at.url);
            const orig = Buffer.from(await res.body.arrayBuffer());

            // ── メタデータ取得
            const img = sharp(orig).rotate();            // EXIF に合わせ自動回転
            const meta = await img.metadata();
            const { width, height, format } = meta;

            let processedBuffer;
            let actionMessage = '';
            let newFileName;

            // ── 白縁判定ロジック: 画像サイズが指定のサイズと一致するかどうか
            if (width === TRIM_TARGET_WIDTH && height === TRIM_TARGET_HEIGHT) {
                // トリミング対象の画像
                actionMessage = `🖼️ Trimmed ${at.name}`;
                newFileName = at.name.replace(/\.[^.]+$/, '') + `_trimmed.${format || 'jpg'}`; // フォーマットが不明な場合はjpgをデフォルトに
                
                processedBuffer = await sharp(orig) // trim処理のために元のbufferからsharpインスタンスを作成
                    .extract({ left: TRIM_LEFT, top: TRIM_TOP, width: TRIM_WIDTH, height: TRIM_HEIGHT })
                    .toBuffer();

            } else if (Math.max(width, height) > MAX_SIZE) { // 白縁なしで、かつ大きいならリサイズ
                // ── 出力フォーマット（PNG は PNG のまま）
                const supported = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'];
                const outFmt = supported.includes(format) ? format : 'jpeg';
                const newExt = outFmt === 'jpeg' ? '.jpg' : '.' + outFmt;

                // ── リサイズ
                processedBuffer = await img
                    .resize({
                        width: width >= height ? MAX_SIZE : null,
                        height: height > width ? MAX_SIZE : null,
                        fit: 'inside',
                        withoutEnlargement: true
                    })
                    .toFormat(
                        outFmt,
                        outFmt === 'jpeg' ? { mozjpeg: true } : undefined
                    )
                    .toBuffer();
                actionMessage = `🔄 Resized ${at.name}`;
                newFileName = at.name.replace(/\.[^.]+$/, '') + `_resized${newExt}`;
            } else {
                // トリミングもリサイズも不要な場合は何もしない
                continue; 
            }

            // ── 返信
            if (processedBuffer) {
                const file = new AttachmentBuilder(processedBuffer, { name: newFileName });
                await msg.reply({ content: actionMessage, files: [file] });
            }

        } catch (e) {
            console.error('Image processing failed:', e);
            msg.channel.send(`画像の処理中にエラーが発生しました: ${e.message}`);
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
const app = express();
const PORT = process.env.PORT || 8080;
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (_, res) => res.send('Bot Alive'));
app.listen(PORT, () => console.log(`Keep-alive server on :${PORT}`));

client.login(TOKEN);
