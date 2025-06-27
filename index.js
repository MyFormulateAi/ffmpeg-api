const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");
const ffmpegPath = require("ffmpeg-static");

const streamPipeline = promisify(pipeline);
const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname)));

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.statusText}`);
  await streamPipeline(res.body, fs.createWriteStream(dest));
}

function getAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const probe = spawn(ffmpegPath, ["-i", file]);
    let stderr = "";
    probe.stderr.on("data", d => (stderr += d.toString()));
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
    return res.status(400).json({ error: "Send an array of image URLs in `images`" });
  }
  if (!audioUrl) {
    return res.status(400).json({ error: "Send an `audioUrl` in the body" });
  }

  const audioFile = path.join(__dirname, "audio.mp3");
  try {
    // download audio + images
    await downloadFile(audioUrl, audioFile);
    const imgFiles = images.map((_, i) => `img${i}.jpg`);
    await Promise.all(images.map((url, i) => downloadFile(url, imgFiles[i])));

    // build concat list
    const audioDuration = await getAudioDuration(audioFile);
    const perImage = audioDuration / images.length;
    const listTxt =
      imgFiles.map(f => `file '${f}'\nduration ${perImage.toFixed(3)}`).join("\n") +
      `\nfile '${imgFiles[imgFiles.length - 1]}'\n`;
    fs.writeFileSync("ffmpeg_input.txt", listTxt);

    // run ffmpeg
    const ff = spawn(ffmpegPath, [
      "-y",
      "-f", "concat", "-safe", "0", "-i", "ffmpeg_input.txt",
      "-i", audioFile,
      "-vsync", "vfr",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264",
      "-c:a", "aac",
      "-shortest",
      "output.mp4"
    ]);

    ff.stderr.on("data", d => process.stdout.write(d.toString()));
    ff.on("error", err => res.status(500).json({ error: "ffmpeg spawn failed" }));

    ff.on("exit", code => {
      // cleanup
      fs.unlinkSync("ffmpeg_input.txt");
      fs.unlinkSync(audioFile);
      imgFiles.forEach(f => fs.unlinkSync(f));

      if (code !== 0) {
        return res.status(500).json({ error: `ffmpeg exited ${code}` });
      }
      res.json({ status: "success", videoUrl: "/output.mp4" });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));