# Remotion Telegram Bot + Cloudflare R2 (Node.js, no Docker)

This bot receives an approved user's Remotion ZIP, extracts it, installs dependencies, renders an MP4, uploads the MP4 to a private Cloudflare R2 bucket using multipart upload, and sends a temporary presigned download link in Telegram.

## Requirements

- Node.js 20+
- npm and npx available to the Node process
- Host permits `child_process.spawn`
- Chromium-compatible libraries and FFmpeg for Remotion
- Enough RAM, CPU, disk and execution time for rendering
- Cloudflare R2 bucket and an R2 API token with **Object Read & Write** permission scoped to the target bucket

Node.js hosting does not automatically guarantee these requirements. In particular, a 512 MB RAM free hosting plan may not be sufficient for Remotion Chromium rendering.

## Setup

1. Create a Telegram bot with BotFather.
2. Copy `.env.example` to `.env`.
3. Fill in `BOT_TOKEN` and your numeric Telegram ID in `ADMIN_IDS`.
4. Fill in the R2 values:
   - `R2_ACCOUNT_ID`: Cloudflare Account ID
   - `R2_ACCESS_KEY_ID`: R2 Access Key ID
   - `R2_SECRET_ACCESS_KEY`: R2 Secret Access Key
   - `R2_BUCKET_NAME`: e.g. `remotion-videos`
   - `R2_ENDPOINT`: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
5. Install dependencies: `npm install`
6. Start: `npm start`

## Environment variables

- `MAX_ZIP_MB`: incoming ZIP size limit (default 20)
- `MAX_EXTRACTED_MB`: extracted project size limit (default 700)
- `MAX_FILES`: extracted file count limit (default 5000)
- `MAX_VIDEO_MB`: rendered video size limit (default 500)
- `MAX_QUEUE`: waiting jobs limit (default 3)
- `JOB_TIMEOUT_MINUTES`: each child process timeout (default 90)
- `R2_URL_EXPIRES_SECONDS`: presigned link validity (default 86400 / 24 hours; maximum 604800 / 7 days)

## Cloudflare R2 cleanup

The bot uploads objects under the `renders/` prefix. To avoid filling the R2 free storage allowance, configure a bucket lifecycle rule in Cloudflare R2 to expire objects with prefix `renders/` after 1 day (or your preferred retention period). The presigned link expires after the time set in `R2_URL_EXPIRES_SECONDS`; the object lifecycle rule is separate and deletes the stored object.

## Telegram delivery

This version does **not** upload the MP4 as a Telegram attachment. It uploads the MP4 to private R2 and sends a temporary download URL. This avoids the standard Telegram Bot API's ordinary 50 MB upload limit.

## Commands

- `/start`, `/id`, `/status`
- Admin: `/approve TELEGRAM_ID`, `/revoke TELEGRAM_ID`, `/users`, `/queue`

## Security warning

Uploaded ZIP projects are untrusted code. `npm install` may run package lifecycle scripts, and Remotion rendering executes project code. Only approve trusted users. Do not run this as a public ZIP-rendering service without proper sandboxing/isolation. Keep API credentials in hosting environment variables and never commit `.env`.

## Important hosting limitation

This bot still needs to run `npm install`, `npx remotion browser ensure`, and `npx remotion render`. Cloudflare R2 only stores the final video; it does not provide rendering compute. If Botkeep blocks child processes, lacks npm/npx, or cannot run Chromium/FFmpeg within its 512 MB RAM limit, rendering will still fail. R2 integration cannot fix a hosting limitation.
