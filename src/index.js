import "dotenv/config";
import { Telegraf } from "telegraf";
import yauzl from "yauzl";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const required = [
  "BOT_TOKEN",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME"
];

for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} is missing from environment variables.`);
}

const token = process.env.BOT_TOKEN;
const bot = new Telegraf(token);
const admins = new Set((process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const approved = new Set(admins);
const baseDir = path.resolve(process.env.WORK_DIR || "./data");
const maxZip = Number(process.env.MAX_ZIP_MB || 20) * 1024 * 1024;
const maxExpanded = Number(process.env.MAX_EXTRACTED_MB || 700) * 1024 * 1024;
const maxFiles = Number(process.env.MAX_FILES || 5000);
const maxVideo = Number(process.env.MAX_VIDEO_MB || 500) * 1024 * 1024;
const maxQueue = Number(process.env.MAX_QUEUE || 3);
const timeout = Number(process.env.JOB_TIMEOUT_MINUTES || 90) * 60000;
const bucket = process.env.R2_BUCKET_NAME;
const expiresSeconds = Math.min(
  604800,
  Math.max(60, Number(process.env.R2_URL_EXPIRES_SECONDS || 86400))
);

const endpoint = process.env.R2_ENDPOINT ||
  `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const s3 = new S3Client({
  region: "auto",
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

await fs.promises.mkdir(baseDir, { recursive: true });

const queue = [];
let active = null;
let working = false;

const isAdmin = id => admins.has(String(id));
const isApproved = id => approved.has(String(id));

function resolveNpmCommand(command) {
  const npmExecPath = process.env.npm_execpath;

  if (npmExecPath && fs.existsSync(npmExecPath)) {
    const npmBinDir = path.dirname(npmExecPath);
    const cliName = command === "npm" ? "npm-cli.js" : "npx-cli.js";
    const cliPath = path.join(npmBinDir, cliName);

    if (fs.existsSync(cliPath)) {
      return { executable: process.execPath, argsPrefix: [cliPath], shell: false };
    }
  }

  if (process.platform === "win32") {
    return { executable: `${command}.cmd`, argsPrefix: [], shell: true };
  }

  return { executable: command, argsPrefix: [], shell: false };
}

function execute(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const resolved = resolveNpmCommand(command);
    const child = spawn(resolved.executable, [...resolved.argsPrefix, ...args], {
      cwd,
      shell: resolved.shell,
      env: { ...process.env, CI: "1", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let logs = "";
    const collect = chunk => {
      logs += chunk.toString();
      if (logs.length > 12000) logs = logs.slice(-12000);
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeout);

    child.once("error", error => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new Error(
          `${command} executable পাওয়া যায়নি। Hosting-এ npm/npx install এবং PATH-এ থাকতে হবে। ` +
          `Platform: ${process.platform}; PATH: ${process.env.PATH || "missing"}`
        ));
      } else {
        reject(error);
      }
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(logs);
      else reject(new Error(
        `${command} failed\nExit code: ${code}\nSignal: ${signal || "none"}\nLogs:\n${logs.slice(-8000)}`
      ));
    });
  });
}

async function downloadZip(fileId, target) {
  const url = await bot.telegram.getFileLink(fileId);
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Telegram ZIP download failed: HTTP ${response.status}`);
  }

  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxZip) {
    throw new Error(`ZIP সর্বোচ্চ ${process.env.MAX_ZIP_MB || 20} MB হতে পারবে।`);
  }

  let received = 0;
  const stream = Readable.fromWeb(response.body);

  stream.on("data", chunk => {
    received += chunk.length;
    if (received > maxZip) stream.destroy(new Error("ZIP file size limit exceeded."));
  });

  await pipeline(stream, fs.createWriteStream(target, { flags: "wx" }));
}

function extractZip(zipFile, outputDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);

      let expanded = 0;
      let count = 0;
      let done = false;

      const fail = error => {
        if (done) return;
        done = true;
        try { zip.close(); } catch {}
        reject(error);
      };

      zip.on("error", fail);
      zip.on("end", () => {
        if (!done) {
          done = true;
          resolve();
        }
      });

      zip.on("entry", entry => {
        if (done) return;

        const name = entry.fileName.replace(/\\/g, "/");
        if (
          name.startsWith("/") ||
          /^[a-zA-Z]:/.test(name) ||
          name.split("/").includes("..")
        ) {
          return fail(new Error("ZIP-এ unsafe file path পাওয়া গেছে।"));
        }

        count += 1;
        if (count > maxFiles) return fail(new Error("ZIP-এ অতিরিক্ত file রয়েছে।"));

        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0o170000) === 0o120000) {
          return fail(new Error("ZIP symlink file গ্রহণ করা হবে না।"));
        }

        const target = path.resolve(outputDir, name);
        if (target !== outputDir && !target.startsWith(outputDir + path.sep)) {
          return fail(new Error("ZIP path validation failed."));
        }

        if (name.endsWith("/")) {
          fs.promises.mkdir(target, { recursive: true })
            .then(() => zip.readEntry())
            .catch(fail);
          return;
        }

        expanded += entry.uncompressedSize || 0;
        if (expanded > maxExpanded) {
          return fail(new Error("Extracted ZIP size limit অতিক্রম করেছে।"));
        }

        fs.promises.mkdir(path.dirname(target), { recursive: true }).then(() => {
          zip.openReadStream(entry, (streamError, input) => {
            if (streamError) return fail(streamError);

            pipeline(input, fs.createWriteStream(target, { flags: "wx" }))
              .then(() => zip.readEntry())
              .catch(fail);
          });
        }).catch(fail);
      });

      zip.readEntry();
    });
  });
}

function locateProject(folder) {
  if (fs.existsSync(path.join(folder, "package.json"))) return folder;

  const candidates = fs.readdirSync(folder, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => path.join(folder, item.name))
    .filter(item => fs.existsSync(path.join(item, "package.json")));

  if (candidates.length === 1) return candidates[0];

  throw new Error("ZIP-এর root অথবা একটি top-level folder-এ package.json থাকতে হবে।");
}

async function uploadVideo(videoPath, userId) {
  const objectKey = `renders/${userId}/${Date.now()}-${crypto.randomUUID()}.mp4`;

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: objectKey,
      Body: fs.createReadStream(videoPath),
      ContentType: "video/mp4",
      ContentDisposition: `attachment; filename="${path.basename(objectKey)}"`
    },
    partSize: 8 * 1024 * 1024,
    queueSize: 2,
    leavePartsOnError: false
  });

  await upload.done();

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ResponseContentType: "video/mp4"
    }),
    { expiresIn: expiresSeconds }
  );

  return { url, objectKey };
}

async function processJob(job) {
  const jobDir = path.join(baseDir, `${Date.now()}-${crypto.randomUUID()}`);
  const projectDir = path.join(jobDir, "project");
  const zipPath = path.join(jobDir, "upload.zip");

  await fs.promises.mkdir(projectDir, { recursive: true });

  try {
    await job.ctx.reply("📥 ZIP download হচ্ছে...");
    await downloadZip(job.fileId, zipPath);

    await job.ctx.reply("📦 ZIP extract হচ্ছে...");
    await extractZip(zipPath, projectDir);

    const cwd = locateProject(projectDir);
    const pkg = JSON.parse(await fs.promises.readFile(path.join(cwd, "package.json"), "utf8"));

    if (!pkg.dependencies?.remotion && !pkg.devDependencies?.remotion) {
      throw new Error("package.json-এ remotion dependency পাওয়া যায়নি।");
    }

    await job.ctx.reply("📦 npm install চলছে...");
    await execute("npm", ["install", "--no-audit", "--no-fund"], cwd);

    await job.ctx.reply("🌐 Remotion browser setup হচ্ছে...");
    await execute("npx", ["remotion", "browser", "ensure"], cwd);

    await fs.promises.mkdir(path.join(cwd, "out"), { recursive: true });

    await job.ctx.reply("🎬 Rendering শুরু হয়েছে...");
    await execute("npx", [
      "remotion", "render", "src/index.ts", "Main", "out/video.mp4"
    ], cwd);

    const videoPath = path.join(cwd, "out", "video.mp4");
    const stat = await fs.promises.stat(videoPath);

    if (!stat.isFile() || stat.size === 0) {
      throw new Error("Render শেষ হয়েছে, কিন্তু out/video.mp4 পাওয়া যায়নি।");
    }

    const videoMb = stat.size / (1024 * 1024);
    if (stat.size > maxVideo) {
      throw new Error(
        `ভিডিও ${videoMb.toFixed(1)} MB; MAX_VIDEO_MB=${process.env.MAX_VIDEO_MB || 500} limit অতিক্রম করেছে।`
      );
    }

    await job.ctx.reply(
      `☁️ ভিডিও R2-তে Upload হচ্ছে (${videoMb.toFixed(1)} MB)।`
    );

    const { url } = await uploadVideo(videoPath, job.userId);

    const hours = (expiresSeconds / 3600).toFixed(0);
    await job.ctx.reply(
      `✅ Remotion render সম্পন্ন!\n` +
      `📦 ভিডিও সাইজ: ${videoMb.toFixed(1)} MB\n` +
      `🔗 Download link (${hours} ঘণ্টা পর্যন্ত কাজ করবে):\n${url}`,
      { disable_web_page_preview: true }
    );
  } finally {
    await fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runQueue() {
  if (working) return;
  working = true;

  while (queue.length > 0) {
    active = queue.shift();

    try {
      await processJob(active);
    } catch (error) {
      console.error("Render job failed:", error);
      await active.ctx.reply(
        `❌ Render failed:\n${String(error.message || error).slice(-3500)}`
      ).catch(() => {});
    }

    active = null;
  }

  working = false;
}

bot.start(ctx => {
  const id = String(ctx.from.id);
  return ctx.reply(
    `তোমার Telegram ID: ${id}\n` +
    (isApproved(id)
      ? "Approved! তোমার Remotion ZIP project পাঠাও।"
      : "Bot ব্যবহার করতে Admin approval লাগবে। /id দিয়ে ID Admin-কে পাঠাও।")
  );
});

bot.command("id", ctx => ctx.reply(`Telegram ID: ${ctx.from.id}`));

bot.command("approve", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("এই command শুধু Admin ব্যবহার করতে পারবে।");

  const id = ctx.message.text.split(/\s+/)[1];
  if (!id || !/^\d+$/.test(id)) return ctx.reply("ব্যবহার: /approve TELEGRAM_ID");

  approved.add(id);
  return ctx.reply(`✅ User ${id} approved হয়েছে।`);
});

bot.command("revoke", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("এই command শুধু Admin ব্যবহার করতে পারবে।");

  const id = ctx.message.text.split(/\s+/)[1];
  if (!id || !/^\d+$/.test(id)) return ctx.reply("ব্যবহার: /revoke TELEGRAM_ID");

  if (!isAdmin(id)) approved.delete(id);
  return ctx.reply(`User ${id} access revoke করা হয়েছে।`);
});

bot.command("users", ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("শুধু Admin ব্যবহার করতে পারবে।");
  return ctx.reply(`Approved users:\n${[...approved].join("\n") || "None"}`);
});

bot.command("queue", ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("শুধু Admin ব্যবহার করতে পারবে।");
  return ctx.reply(`Active job: ${active?.userId || "None"}\nWaiting jobs: ${queue.length}`);
});

bot.command("status", ctx => {
  return ctx.reply(
    `Bot online\nWaiting: ${queue.length}\nRendering: ${active ? "Yes" : "No"}`
  );
});

bot.on("document", async ctx => {
  const userId = String(ctx.from.id);

  if (!isApproved(userId)) {
    return ctx.reply("⛔ তুমি approved নও। /id দিয়ে ID Admin-কে পাঠাও।");
  }

  const document = ctx.message.document;
  if (!(document.file_name || "").toLowerCase().endsWith(".zip")) {
    return ctx.reply("একটি .zip Remotion project পাঠাও।");
  }

  if (document.file_size && document.file_size > maxZip) {
    return ctx.reply(`ZIP সর্বোচ্চ ${process.env.MAX_ZIP_MB || 20} MB হতে পারবে।`);
  }

  if (active?.userId === userId || queue.some(job => job.userId === userId)) {
    return ctx.reply("তোমার একটি job ইতিমধ্যে চলছে বা queue-তে আছে।");
  }

  if (queue.length >= maxQueue) {
    return ctx.reply("⏳ Queue পূর্ণ। পরে আবার চেষ্টা করো।");
  }

  queue.push({ userId, fileId: document.file_id, ctx });
  await ctx.reply(`✅ Queue-তে যোগ হয়েছে। Waiting: ${queue.length}`);
  runQueue();
});

bot.catch((error, ctx) => {
  console.error("Telegram bot error:", error);
  ctx?.reply("Bot-এ সমস্যা হয়েছে।").catch(() => {});
});

await bot.launch();
console.log("Remotion Telegram R2 bot started.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
