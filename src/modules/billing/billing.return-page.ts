/**
 * Landing page Stripe redirects to after checkout / billing-portal exit.
 *
 * The product is mobile-only — there is no web app for Stripe to return the
 * user to. So this page's job is to hand them back to the Echoes app via its
 * registered `echoes://` scheme (iOS) or an Android `intent://` link, and to
 * show a plain "head back to the app" message if that doesn't fire.
 *
 * SECURITY: the app links below are a FIXED table of constants, written out
 * literally. Nothing from the request — not the status string, not any other
 * query param, not the User-Agent — is ever concatenated into a link. The
 * status is only used as a lookup key after being whitelisted to one of three
 * values, and the User-Agent only picks between the iOS and Android row. The
 * links carry `status` and nothing else (no session id, user id or token), so
 * even if another app hijacked the `echoes://` scheme there'd be nothing in it
 * worth stealing.
 */

export type ReturnStatus = 'success' | 'cancelled' | 'portal';
export type AppPlatform = 'ios' | 'android';

/**
 * Exact-match whitelist. The status arrives as a query param (attacker-
 * controllable), so only the literal strings 'success' and 'cancelled' are
 * honoured. Everything else — missing, wrong case, array, junk — becomes the
 * neutral 'portal' state, which only means "you're back, refresh your billing
 * state". That also covers Stripe portal sessions created before this change,
 * whose return URL carries no status at all. Never maps junk to 'success'.
 */
export function parseReturnStatus(raw: unknown): ReturnStatus {
  if (raw === 'success') return 'success';
  if (raw === 'cancelled') return 'cancelled';
  return 'portal';
}

/**
 * Which app link to offer. Android is checked first (its UA never contains
 * "iPhone"). Anything else — desktop, unknown, an iPad in desktop mode —
 * gets no link, just the "switch back to the app" message.
 */
export function detectPlatform(userAgent: string | undefined): AppPlatform | null {
  if (!userAgent) return null;
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  return null;
}

// Written out literally on purpose — see SECURITY note above. These are the
// exact strings the mobile team specified; do not build them from parts.
const APP_LINKS: Record<AppPlatform, Record<ReturnStatus, string>> = {
  ios: {
    success: 'echoes://billing/return?status=success',
    cancelled: 'echoes://billing/return?status=cancelled',
    portal: 'echoes://billing/return?status=portal',
  },
  android: {
    success: 'intent://billing/return?status=success#Intent;scheme=echoes;package=com.echoes;end',
    cancelled: 'intent://billing/return?status=cancelled#Intent;scheme=echoes;package=com.echoes;end',
    portal: 'intent://billing/return?status=portal#Intent;scheme=echoes;package=com.echoes;end',
  },
};

const COPY: Record<ReturnStatus, { title: string; body: string; icon: string; color: string }> = {
  success: {
    title: 'Payment successful',
    body: 'Your 7-day free trial is starting. Head back to the Echoes app — your new plan will show up in a moment.',
    icon: '&#10003;',
    color: '#1a7f4b',
  },
  cancelled: {
    title: 'Checkout cancelled',
    body: 'No payment was taken and nothing changed on your account. You can head back to the Echoes app and try again any time.',
    icon: '&#10005;',
    color: '#8a6d1f',
  },
  portal: {
    title: "You're all set",
    body: 'Your billing details are up to date. Head back to the Echoes app to carry on.',
    icon: '&#10003;',
    color: '#1a7f4b',
  },
};

export function renderBillingReturnPage(status: ReturnStatus, platform: AppPlatform | null): string {
  const { title, body, icon, color } = COPY[status];
  const appLink = platform ? APP_LINKS[platform][status] : null;

  // Auto-open the app, plus a visible button: browsers (Android Chrome in
  // particular) can refuse an automatic jump to an intent:// link that wasn't
  // triggered by a tap, so the button is the reliable path, not just a backup.
  const autoRedirect = appLink
    ? `<script>setTimeout(function(){window.location.replace(${JSON.stringify(appLink)})},600)</script>`
    : '';

  const action = appLink
    ? `<a class="btn" href="${escapeHtml(appLink)}">Open the Echoes app</a>`
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
    ${action}
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
