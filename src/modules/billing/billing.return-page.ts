import { env } from '../../config/env.js';

/**
 * Landing page Stripe redirects to after checkout / billing-portal exit.
 *
 * This exists because the product is mobile-only: there is no web app for
 * Stripe to return the user to, and (for now) no registered deep link
 * either, so without this the user lands on a dead URL and is stranded
 * outside the app with no way back.
 *
 * Once the iOS/Android build registers a URL scheme, set
 * MOBILE_DEEP_LINK_BASE and this page starts bouncing straight into the app
 * instead — no code change needed here or in the checkout flow.
 */

export type ReturnStatus = 'success' | 'cancelled' | 'done';

/**
 * Only ever accept the three known values. The status arrives as a query
 * param (user-controllable), so it must never be interpolated into the page
 * — anything unrecognised silently becomes the neutral 'done' state.
 */
export function parseReturnStatus(raw: unknown): ReturnStatus {
  if (raw === 'success') return 'success';
  if (raw === 'cancelled') return 'cancelled';
  return 'done';
}

const COPY: Record<ReturnStatus, { title: string; body: string; icon: string; color: string }> = {
  success: {
    title: 'Payment successful',
    body: 'Your 7-day free trial has started. Head back to the Echoes app — your new plan is already active.',
    icon: '&#10003;',
    color: '#1a7f4b',
  },
  cancelled: {
    title: 'Checkout cancelled',
    body: 'No payment was taken and nothing changed on your account. You can head back to the Echoes app and try again any time.',
    icon: '&#10005;',
    color: '#8a6d1f',
  },
  done: {
    title: "You're all set",
    body: 'Your billing details are up to date. Head back to the Echoes app to carry on.',
    icon: '&#10003;',
    color: '#1a7f4b',
  },
};

export function renderBillingReturnPage(status: ReturnStatus): string {
  const { title, body, icon, color } = COPY[status];

  // Deep link is operator-set config (never user input). Empty until the
  // mobile app registers a scheme; when present we both auto-bounce and
  // offer a manual button, since auto-redirect is blocked in some browsers.
  const deepLink = env.MOBILE_DEEP_LINK_BASE
    ? `${env.MOBILE_DEEP_LINK_BASE}?status=${status}`
    : null;

  const autoRedirect = deepLink
    ? `<script>setTimeout(function(){window.location.replace(${JSON.stringify(deepLink)})},600)</script>`
    : '';

  const button = deepLink
    ? `<a class="btn" href="${escapeHtml(deepLink)}">Return to the app</a>`
    : `<p class="hint">You can close this page and switch back to the app.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} &middot; Echoes Remembered</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #faf9f7; color: #1c1b19;
  }
  .card {
    width: 100%; max-width: 420px; text-align: center;
    background: #fff; border-radius: 16px; padding: 40px 28px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 8px 32px rgba(0,0,0,.06);
  }
  .icon {
    width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 26px; color: #fff; background: ${color};
  }
  h1 { margin: 0 0 10px; font-size: 21px; font-weight: 600; letter-spacing: -.01em; }
  p { margin: 0; color: #5c5955; }
  .btn {
    display: inline-block; margin-top: 24px; padding: 13px 28px;
    background: #1c1b19; color: #fff; text-decoration: none;
    border-radius: 10px; font-weight: 500;
  }
  .hint { margin-top: 22px; font-size: 14px; color: #8a8681; }
  @media (prefers-color-scheme: dark) {
    body { background: #141311; color: #f2f0ed; }
    .card { background: #1f1e1c; box-shadow: none; }
    p { color: #a8a39d; }
    .btn { background: #f2f0ed; color: #1c1b19; }
    .hint { color: #78736d; }
  }
</style>
</head>
<body>
  <main class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${body}</p>
    ${button}
  </main>
  ${autoRedirect}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
