import sharp from 'sharp';

/**
 * 白い額縁が“十分な厚み”で存在する場合にだけ内側を切り抜く。
 * @param {Buffer} buf 入力画像バッファ
 * @returns {Promise<{ buf: Buffer, cropped: boolean }>}
 *          cropped が true なら額縁除去済み
 */
export default async function cropFrame(buf) {
  // ── RGBA 生データ取得
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const CH = 4;                               // RGBA チャンネル数
  const WHITE = 245;                          // “白”判定の下限
  const isWhite = (i) =>
    data[i] >= WHITE && data[i + 1] >= WHITE && data[i + 2] >= WHITE;

  const STEP  = 10;      // スキャン間引きピクセル
  const NEED  = 0.95;    // その行/列の非白割合がこれ以上なら境界
  const MIN   = 6;       // 枠と認める最小厚み(px)

  let top = 0, bottom = height - 1, left = 0, right = width - 1;

  // ── 上端
  for (let y = 0; y < height; y++) {
    let nonWhite = 0;
    for (let x = 0; x < width; x += STEP)
      if (!isWhite((y * width + x) * CH)) nonWhite++;
    if (nonWhite / (width / STEP) >= NEED) { top = y; break; }
  }
  // ── 下端
  for (let y = height - 1; y >= 0; y--) {
    let nonWhite = 0;
    for (let x = 0; x < width; x += STEP)
      if (!isWhite((y * width + x) * CH)) nonWhite++;
    if (nonWhite / (width / STEP) >= NEED) { bottom = y; break; }
  }
  // ── 左端
  for (let x = 0; x < width; x++) {
    let nonWhite = 0;
    for (let y = top; y <= bottom; y += STEP)
      if (!isWhite((y * width + x) * CH)) nonWhite++;
    if (nonWhite / ((bottom - top) / STEP + 1) >= NEED) { left = x; break; }
  }
  // ── 右端
  for (let x = width - 1; x >= 0; x--) {
    let nonWhite = 0;
    for (let y = top; y <= bottom; y += STEP)
      if (!isWhite((y * width + x) * CH)) nonWhite++;
    if (nonWhite / ((bottom - top) / STEP + 1) >= NEED) { right = x; break; }
  }

  // ── 枠厚チェック
  const borders = [
    top,
    height - 1 - bottom,
    left,
    width - 1 - right,
  ];
  if (Math.min(...borders) < MIN) {
    // 枠なし → そのまま返す
    return { buf, cropped: false };
  }

  // ── 切り抜き
  const w = right - left + 1;
  const h = bottom - top + 1;
  const cropped = await sharp(buf)
    .extract({ left, top, width: w, height: h })
    .png()
    .toBuffer();

  return { buf: cropped, cropped: true };
}
