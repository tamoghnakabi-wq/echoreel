# Echoreel

Post a video once. Echoreel relays it to your other accounts.

Echoreel is a free desktop app for macOS and Windows. It watches your YouTube, Instagram and TikTok accounts, and when you upload a new video on one of them it posts the same video to the others, with your caption. You can also drop a video into the app and send it everywhere at once.

**Download:** [echoreel.vercel.app](https://echoreel.vercel.app) · [all releases](https://github.com/tamoghnakabi-wq/echoreel/releases)

## What it does

- **Relays new uploads.** A new YouTube Short becomes a Reel and a TikTok; a new Reel becomes a Short and a TikTok; and so on. You choose the routes.
- **Never loops.** Echoreel recognises its own relays (and re-uploads of the same video, by comparing frames), so a relayed video is never relayed back.
- **Only new videos.** When you connect an account, the videos already on it are left alone.
- **Ask first (optional).** New videos wait in the app until you check the captions and click Relay.
- **Fits the format.** Landscape videos are placed on a 9:16 frame over a blurred copy for Reels and TikTok.
- **Retries.** A failed post is retried after 1, 5, 15, 60 and 180 minutes; an expired sign-in asks you to reconnect.
- **Updates itself.** New versions download in the background, are checked against a signing key built into the app, and install when Echoreel is idle.

## How it posts (and the platforms' limits)

Echoreel signs in with **your own developer apps**, so there's no Echoreel server and your accounts stay yours. The setup guides in the app take about 10 minutes per platform.

| Platform | Needs | Limits for apps that haven't been reviewed |
|---|---|---|
| YouTube | A Google Cloud project with the YouTube Data API and a Desktop OAuth client | Uploads through the API stay **private** until Google approves your project in the YouTube API audit. By default Echoreel prepares the video, copies the title and description, and opens YouTube Studio for a one-click finish. |
| Instagram | A Creator or Business account and a Meta app (Instagram API with Instagram Login) | Reels need a public link to the video, so Echoreel shares the file for a few minutes through a temporary Cloudflare link while Instagram fetches it. |
| TikTok | A TikTok developer app (Login Kit + Content Posting API) in sandbox mode | Videos go to your TikTok **inbox**; tap the notification in the TikTok app to post. Direct posting needs TikTok's review. |

## Installing

- **macOS** (Apple silicon or Intel): open the `.dmg` and drag Echoreel to Applications. The app isn't notarised by Apple, so the first time macOS says it can't check it: open **System Settings → Privacy & Security** and click **Open Anyway**.
- **Windows** (x64): run the installer. Windows SmartScreen may warn about an unrecognised app: click **More info → Run anyway**.

## Building

Requires Node 22+.

```bash
npm install
npm run tools        # downloads ffmpeg, ffprobe, yt-dlp and cloudflared for this machine into tools/
npm start            # build and run
npm test             # end-to-end test of the relay engine against mock platform APIs
npm run dist:mac     # or dist:win: package with electron-builder into release/
```

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when a `v*` tag is pushed: the packaged apps are self-tested on macOS and Windows, then published with a signed `echoreel-update.json` that the in-app updater reads.

## Privacy

Sign-ins are stored encrypted on your computer (macOS Keychain / Windows DPAPI). Echoreel talks only to YouTube, Instagram, TikTok, GitHub (for updates) and, while posting a Reel, Cloudflare's temporary link service.

## License

MIT
