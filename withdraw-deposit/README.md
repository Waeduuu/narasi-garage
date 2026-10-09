# Narasi Garage — Withdraw & Deposit

A brand-new, separate GitHub Pages page. It does **not** modify `narasi-garage/index.html`.

## What it records

Two forms: **Deposit** and **Withdraw**, each with Staff / IC Name, free-text Item / Description, optional Quantity, and optional Notes / Reason. No prices, money or fixed item list.

## GitHub Pages address

Place `index.html` in the `withdraw-deposit` folder of `Waeduuu/narasi-garage`. It references the already-existing Narasi Garage logo at `../Narasi_Garage.png`.

When the repository's GitHub Pages `main` branch root publishing is enabled, its URL is normally:

https://waeduuu.github.io/narasi-garage/withdraw-deposit/

## Connect Discord safely

Do **not** paste a Discord webhook directly into a public `index.html` or GitHub repository. Anyone could copy and abuse it.

1. Create a Discord webhook for a channel such as `#narasi-garage-logs`.
2. Create a new **Cloudflare Worker** and paste the contents of `discord-worker.js` into its editor, then deploy it.
3. In Worker **Settings > Variables and Secrets**, set:
   - Secret `DISCORD_WEBHOOK_URL` = your Discord webhook URL, without `?wait=true`.
   - Secret `ACCESS_KEY` = a long random password/shared access key distributed only to authorized users.
   - Plaintext `ALLOWED_ORIGIN` = `https://waeduuu.github.io` (exact origin, without ending slash).
4. Visit the GitHub Pages page. Click **Discord Settings**; enter your Worker's HTTPS URL and `ACCESS_KEY`, and save.
5. Submit a Deposit or Withdraw record. After successful relay delivery, it appears in the Discord channel.

**Security note:** Shared access keys are basic protection for a small trusted team; a fully production-grade service should use per-user authentication (e.g., Discord OAuth), server-side role checks and rate limiting. CORS by itself is *not* authentication. The Worker's URL and key are not preconfigured; until configured, the page cannot send logs.

## Data behavior

- Discord logs are permanent chat messages in your Discord channel unless deleted there.
- The page displays the last 30 successfully sent entries from **this browser** only (localStorage), not a shared synchronized database.
- Clicking Clear Local History does not delete Discord messages.
- This is not connected to actual FiveM inventory, and it does not enforce stock levels or support multi-user real-time balances.
- The relay access key is held in sessionStorage and is cleared when the browser tab session ends; browsers can still be inspected by anyone with local access.