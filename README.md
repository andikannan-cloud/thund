# CipherStream — Encrypted GitHub Pages Video Vault

A zero-knowledge static video streaming website built for **GitHub Pages** that keeps raw video files, thumbnails, and titles hidden in your repository while playing seamlessly as standard `.mp4` streams inside the unlocked web app on **Android** and **Windows**.

---

## Key Architecture

1. **No Raw Videos or Thumbnails in GitHub**
   - Every uploaded video in `assets/videos/` is automatically encrypted (`AES-256-GCM`) and renamed to a random filename with a non-video extension (e.g., `bnfwhjxuusdsnaxy.q7p`, `jmk6kyugkjpzzvkq.x7j`).
   - Video poster frames are extracted in memory during the workflow and sealed inside `assets/core.vlt` — zero `.jpg`/`.png` thumbnail files exist in the repository.

2. **Zero-Knowledge Hybrid Cryptography (`PBKDF2` + `AES-256-GCM` + `RSA-OAEP-2048`)**
   - Your security passkey is **never stored** in HTML, JavaScript, YAML workflows, or GitHub Secrets.
   - GitHub Actions encrypts newly uploaded videos using only the `RSA-OAEP` **public key**.
   - Only your passkey can derive the `PBKDF2-SHA256` (`310,000` iterations) key needed to unwrap the `RSA-OAEP` private key in browser RAM and restore the `.mp4` streams.

3. **Smart Multi-Part Grouping**
   - Upload multi-part videos named like `something_00.mp4`, `something_01.mp4`, `something_02.mp4` into `assets/videos/`.
   - On the home gallery, grouped parts automatically merge into **one single card** displaying one cover thumbnail.
   - Opening a grouped card gives you two modes:
     - **Playlist Player**: Standard streaming layout with auto-next, part switcher, and `Loop All` / `Loop Part` / `Loop Off`.
     - **See All Together**: Side-by-side / stacked multi-player view to watch and control all parts together on one screen.

---

## Deploying to GitHub Pages (One-Time Setup)

1. Push this repository to GitHub (e.g., on branch `main`).
2. In your GitHub repo, go to **Settings → Actions → General → Workflow permissions**:
   - Select **Read and write permissions** and click **Save** (allows the workflow bot to replace uploaded `.mp4` files with encrypted blobs).
3. Go to **Settings → Pages**:
   - Under **Build and deployment → Source**, choose **Deploy from a branch**.
   - Select branch **`main`** and folder **`/ (root)`**, then click **Save**.

---

## Uploading New Videos

1. Open `assets/videos/` in your GitHub repository and click **Add file → Upload files** (or push via Git).
2. Drop single videos (`my_clip.mp4`) or multi-part sets (`trip_00.mp4`, `trip_01.mp4`) and commit.
3. `.github/workflows/transform-videos.yml` runs automatically:
   - Normalizes codecs to browser-ready H.264/AAC `+faststart` `.mp4` if needed.
   - Encrypts each video into a random blob inside `assets/videos/`.
   - Seals metadata & thumbnail into `assets/core.vlt`.
   - Deletes the original `.mp4` files and commits back to your branch, triggering GitHub Pages deployment.

---

## Local Commands (Optional)

```bash
# Transform any new videos placed in assets/videos/ locally
node .github/scripts/encode-videos.mjs

# Rotate / change the vault passkey without re-encoding videos
node .github/scripts/setup-passkey.mjs "<NEW_PASSKEY>" "<CURRENT_PASSKEY>"
```
