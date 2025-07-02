const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");
const ffmpegPath = require("ffmpeg-static");
const pidusage = require("pidusage");
const B2 = require("backblaze-b2");
const { v4: uuidv4 } = require("uuid");

const streamPipeline = promisify(pipeline);
const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

function logMem(stage) {
  const m = process.memoryUsage();
  console.log(
    `[MEM ${stage}] rss=${(m.rss/1024/1024).toFixed(1)}MB heapUsed=${(m.heapUsed/1024/1024).toFixed(1)}MB`
  );
}

const b2 = new B2({
  applicationKeyId: process.env.B2_KEY_ID,
  applicationKey:   process.env.B2_APPLICATION_KEY
});

app.use(express.json({ limit: "50mb" }));

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
  logMem("start");
  const { images, audioUrl } = req.body;
  if (!Array.isArray(images) || images.length === 0)
    return res.status(400).json({ error: "`images` must be a non-empty array" });
  if (!audioUrl)
    return res.status(400).json({ error: "`audioUrl` is required" });

  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), "video-"));
  const audioFile  = path.join(tmpDir, "audio.mp3");
  const imgFiles   = images.map((_, i) => path.join(tmpDir, `img${i}.jpg`));
  const concatFile = path.join(tmpDir, "ffmpeg_input.txt");
  const outputFile = path.join(tmpDir, "output.mp4");

  try {
    // 1) download audio & images
    await downloadFile(audioUrl, audioFile);
    for (let i = 0; i < images.length; i++) {
      await downloadFile(images[i], imgFiles[i]);
    }
    logMem("after-downloads");

    // 2) build concat list
    const duration = await getAudioDuration(audioFile);
    const perImage = duration / images.length;
    const listTxt = imgFiles
      .map(f => `file '${f}'\nduration ${perImage.toFixed(3)}`)
      .join("\n");
    fs.writeFileSync(concatFile, listTxt);
    logMem("after-concat-list");

    // 3) run ffmpeg with minimal-memory x264 settings
    logMem("before-ffmpeg");
    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-y",

        // limit to one thread
        "-threads", "1",

        // concat and input
        "-f",    "concat", "-safe", "0", "-i", concatFile,
        "-i",    audioFile,

        // scale & crop portrait
        "-vf",   "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",

        // x264 encode with ultrafast/zerolatency + no bframes/ref
        "-c:v",  "libx264",
        "-preset","ultrafast",
        "-tune",  "zerolatency",
        "-x264-params","bframes=0:ref=1",
        "-crf",   "20",

        "-c:a",  "aac",
        "-pix_fmt","yuv420p",

        // stop at audio end
        "-t",    duration.toFixed(3),

        outputFile
      ]);

      // poll ffmpeg mem
      const poll = setInterval(() => {
        pidusage(ff.pid, (e, stats) => {
          if (!e) {
            console.log(
              `[FFMPEG MEM] rss=${(stats.memory/1024/1024).toFixed(1)}MB cpu=${stats.cpu.toFixed(1)}%`
            );
          }
        });
      }, 5000);

      ff.stderr.on("data", d => process.stdout.write(d.toString()));
      ff.on("error", err => {
        clearInterval(poll);
        reject(err);
      });
      ff.on("exit", code => {
        clearInterval(poll);
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`));
      });
    });
    logMem("after-ffmpeg");

    // 4) upload to B2
    logMem("before-upload");
    const authRes      = await b2.authorize();
    const downloadUrl  = authRes.data.downloadUrl;
    const uploadUrlRes = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });
    const fileName     = `videos/${uuidv4()}.mp4`;
    const sha1         = await computeSHA1(outputFile);
    const stats        = fs.statSync(outputFile);

    const uploadResp = await fetch(uploadUrlRes.data.uploadUrl, {
      method:  "POST",
      headers: {
        Authorization:       uploadUrlRes.data.authorizationToken,
        "X-Bz-File-Name":    encodeURIComponent(fileName),
        "Content-Type":      "b2/x-auto",
        "Content-Length":    stats.size,
        "X-Bz-Content-Sha1": sha1
      },
      duplex: "half",
      body:   fs.createReadStream(outputFile)
    });
    if (!uploadResp.ok) throw new Error(`B2 upload failed: ${uploadResp.statusText}`);
    logMem("after-upload");

    // cleanup & respond
    const publicUrl = `${downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${fileName}`;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logMem("after-cleanup");

    res.json({ status: "success", videoUrl: publicUrl });
    logMem("after-response");

  } catch (err) {
    console.error(err);
    logMem("on-error");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));