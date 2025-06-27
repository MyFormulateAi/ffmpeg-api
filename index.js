const express = require("express");
const fs = require("fs");
const path = require("path");
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
  applicationKey: process.env.B2_APPLICATION_KEY
});

app.use(express.json({ limit: "50mb" }));

// request logger & health check
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] → ${req.method} ${req.url}`);
  next();
});
app.get("/health", (_req, res) => res.json({ ok: true }));

// helper: download URL → local file
async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.statusText}`);
  await streamPipeline(res.body, fs.createWriteStream(dest));
}

// helper: probe audio duration with ffmpeg
function getAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const probe = spawn(ffmpegPath, ["-i", file]);
    let stderr = "";
    probe.stderr.on("data", d => stderr += d.toString());
    probe.on("exit", () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (!m) return reject(new Error("Could not parse audio duration"));
      const secs = +m[1] * 3600 + +m[2] * 60 + +m[3];
      resolve(secs);
    });
    probe.on("error", reject);
  });
}

app.post("/generate-video", async (req, res) => {
  const { images, audioUrl } = req.body;
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "`images` must be a non-empty array" });
  }
  if (!audioUrl) {
    return res.status(400).json({ error: "`audioUrl` is required" });
  }

  // temp file paths
  const tmpDir = __dirname;
  const audioFile = path.join(tmpDir, "audio.mp3");
  const imgFiles = images.map((_, i) => path.join(tmpDir, `img${i}.jpg`));
  const concatFile = path.join(tmpDir, "ffmpeg_input.txt");
  const outputFile = path.join(tmpDir, "output.mp4");

  try {
    // 1) Download audio + images
    await downloadFile(audioUrl, audioFile);
    await Promise.all(images.map((url, i) => downloadFile(url, imgFiles[i])));

    // 2) Build ffmpeg concat list
    const duration = await getAudioDuration(audioFile);
    const perImage = duration / images.length;
    const listTxt = imgFiles
      .map(f => `file '${f}'\nduration ${perImage.toFixed(3)}`)
      .join("\n") +
      `\nfile '${imgFiles[imgFiles.length - 1]}'\n`;
    fs.writeFileSync(concatFile, listTxt);

    // 3) Run ffmpeg
    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-y",
        "-f", "concat", "-safe", "0", "-i", concatFile,
        "-i", audioFile,
        "-vsync", "vfr",
        "-pix_fmt", "yuv420p",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-shortest",
        outputFile
      ]);
      ff.stderr.on("data", d => process.stdout.write(d.toString()));
      ff.on("error", reject);
      ff.on("exit", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
    });

    // 4) Upload to B2
    await b2.authorize();
    const uploadUrlRes = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });
    const fileName = `videos/${uuidv4()}.mp4`;
    const buffer = fs.readFileSync(outputFile);

    await b2.uploadFile({
      uploadUrl: uploadUrlRes.data.uploadUrl,
      uploadAuthToken: uploadUrlRes.data.authorizationToken,
      fileName,
      data: buffer
    });

    const publicUrl = `https://${uploadUrlRes.data.bucketEndpoint}/file/${process.env.B2_BUCKET_ID}:${fileName}`;

    // 5) Clean up
    fs.unlinkSync(audioFile);
    fs.unlinkSync(concatFile);
    fs.unlinkSync(outputFile);
    imgFiles.forEach(f => fs.unlinkSync(f));

    // 6) Return the public URL
    res.json({ status: "success", videoUrl: publicUrl });
  } catch (err) {
    console.error(err);
    // attempt cleanup if things failed
    [audioFile, concatFile, outputFile, ...imgFiles]
      .forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));