// index.js

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");
const ffmpegPath = require("ffmpeg-static");
const B2 = require("backblaze-b2");
const { v4: uuidv4 } = require("uuid");

const streamPipeline = promisify(pipeline);
const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// configure B2 client
const b2 = new B2({
  applicationKeyId: process.env.B2_KEY_ID,
  applicationKey:   process.env.B2_APPLICATION_KEY
});

app.use(express.json({ limit: "50mb" }));
app.use(express.static(__dirname));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] → ${req.method} ${req.url}`);
  next();
});
app.get("/health", (_req, res) => res.json({ ok: true }));

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.statusText}`);
  await streamPipeline(res.body, fs.createWriteStream(dest));
}

function getAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const probe = spawn(ffmpegPath, ["-i", file]);
    let stderr = "";
    probe.stderr.on("data", d => stderr += d.toString());
    probe.on("exit", () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!m) return reject(new Error("Could not parse audio duration"));
      resolve(+m[1]*3600 + +m[2]*60 + +m[3]);
    });
    probe.on("error", reject);
  });
}

function computeSHA1(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const rs = fs.createReadStream(filePath);
    rs.on("data", chunk => hash.update(chunk));
    rs.on("end", () => resolve(hash.digest("hex")));
    rs.on("error", reject);
  });
}

app.post("/generate-video", async (req, res) => {
  const { images, audioUrl } = req.body;
  if (!Array.isArray(images) || images.length === 0)
    return res.status(400).json({ error: "`images` must be a non-empty array" });
  if (!audioUrl)
    return res.status(400).json({ error: "`audioUrl` is required" });

  // make a temp working directory
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), "video-"));
  const audioFile  = path.join(tmpDir, "audio.mp3");
  const imgFiles   = images.map((_, i) => path.join(tmpDir, `img${i}.jpg`));
  const concatFile = path.join(tmpDir, "ffmpeg_input.txt");
  const outputFile = path.join(tmpDir, "output.mp4");

  try {
    // 1) download audio + images
    await downloadFile(audioUrl, audioFile);
    for (let i = 0; i < images.length; i++) {
      await downloadFile(images[i], imgFiles[i]);
    }

    // 2) build concat list
    const duration = await getAudioDuration(audioFile);
    const perImage = duration / images.length;
    const listTxt = imgFiles
      .map(f => `file '${f}'\nduration ${perImage.toFixed(3)}`)
      .join("\n");
    fs.writeFileSync(concatFile, listTxt);

    // 3) run ffmpeg (portrait + exact audio length)
    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-y",
        "-f",    "concat", "-safe", "0", "-i", concatFile,
        "-i",    audioFile,
        "-vf",   "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
        "-c:v",  "libx264",
        "-c:a",  "aac",
        "-pix_fmt", "yuv420p",
        "-t",    duration.toFixed(3),
        outputFile
      ]);
      ff.stderr.on("data", d => process.stdout.write(d.toString()));
      ff.on("error", reject);
      ff.on("exit", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
    });

    // 4) upload to B2 by streaming with manual SHA1
    const authRes     = await b2.authorize();
    const downloadUrl = authRes.data.downloadUrl;
    const uploadUrlRes = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });
    const fileName    = `videos/${uuidv4()}.mp4`;
    const sha1        = await computeSHA1(outputFile);
    const stats       = fs.statSync(outputFile);

    const uploadResp = await fetch(uploadUrlRes.data.uploadUrl, {
      method: "POST",
      headers: {
        Authorization:       uploadUrlRes.data.authorizationToken,
        "X-Bz-File-Name":    encodeURIComponent(fileName),
        "Content-Type":      "b2/x-auto",
        "Content-Length":    stats.size,
        "X-Bz-Content-Sha1": sha1
      },
      duplex: "half",
      body: fs.createReadStream(outputFile)
    });
    if (!uploadResp.ok) throw new Error(`B2 upload failed: ${uploadResp.statusText}`);

    const publicUrl = `${downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${fileName}`;

    // 5) cleanup temp files & dir
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // 6) respond
    res.json({ status: "success", videoUrl: publicUrl });

  } catch (err) {
    console.error(err);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));