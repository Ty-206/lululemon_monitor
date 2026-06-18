/**
 * Background Service Worker
 *
 * IMPROVEMENTS over v1:
 * 1. Badge count — shows number of products with status changes on the
 *    extension icon (inspired by SQDC extension's badge approach)
 * 2. Better new-color detection — compares color arrays from __NEXT_DATA__
 * 3. Responds to 'productPageChanged' from content script MutationObserver
 * 4. Retry + error handling — retries failed fetches once after a delay,
 *    tracks consecutive failures, and surfaces fetch health in the popup
 * 5. Price history — stores price changes over time per product,
 *    enabling "lowest price ever" display and trend tracking
 * 6. Notification grouping — batches notifications by type, sends summaries
 *    when 3+ of the same type fire at once
 * 7. HK/AU discount detection — detects SFCC markdown prices via
 *    cross-variant price comparison and markdown-prices HTML class
 * 8. Product discontinuation detection — marks products as discontinued
 *     after 3 consecutive 404 responses, skips them in future checks
 */

const CHECK_INTERVAL_MINUTES = 60; // fallback default
const ALARM_NAME = 'lululemon-check';
const RETRY_DELAY_MS = 5000;       // Wait 5s before retrying a failed fetch
const MAX_DISPLAY_FAILURES = 3;    // Show warning in popup after this many consecutive failures
const MAX_PRICE_HISTORY = 90;   // Keep at most 90 price history entries per product

const MAX_CONSECUTIVE_404 = 3;       // Mark product discontinued after this many consecutive 404s

const REGION_LABELS = { us: 'US', hk: 'HK', au: 'AU', jp: 'JP', kr: 'KR', uk: 'UK', ca: 'CA', fr: 'FR', vn: 'VN' };
const REGION_CURRENCY = { us: 'USD', hk: 'HKD', au: 'AUD', jp: 'JPY', kr: 'KRW', uk: 'GBP', ca: 'CAD', fr: 'EUR', vn: 'VND' };
const REGION_FLAGS = { us: '\u{1F1FA}\u{1F1F8}', hk: '\u{1F1ED}\u{1F1F0}', au: '\u{1F1E6}\u{1F1FA}', jp: '\u{1F1EF}\u{1F1F5}', kr: '\u{1F1F0}\u{1F1F7}', uk: '\u{1F1EC}\u{1F1E7}', ca: '\u{1F1E8}\u{1F1E6}', fr: '\u{1F1EB}\u{1F1F7}', vn: '\u{1F1FB}\u{1F1F3}' };

// ── Helpers ──────────────────────────────────────────────

async function getCheckInterval() {
  const { checkIntervalMinutes } = await chrome.storage.local.get('checkIntervalMinutes');
  return checkIntervalMinutes || CHECK_INTERVAL_MINUTES;
}

async function setupAlarm() {
  const interval = await getCheckInterval();
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: interval,
  });
  console.log(`[LuluTracker] Alarm set: every ${interval} minutes`);
}

function getProductRegion(url) {
  if (url.includes('shop.lululemon.com/en-ca')) return 'ca';
  if (url.includes('com.hk/en-vn')) return 'vn';
  if (url.includes('lululemon.com.hk')) return 'hk';
  if (url.includes('lululemon.com.au')) return 'au';
  if (url.includes('lululemon.co.jp')) return 'jp';
  if (url.includes('lululemon.co.kr')) return 'kr';
  if (url.includes('lululemon.co.uk')) return 'uk';
  if (url.includes('lululemon.fr')) return 'fr';
  return 'us';
}

/**
 * Extract color code from a product URL (US or international format).
 * US:   ?color=69702
 * Intl: ?dwvar_prod11710026_color=069299
 */
function getColorCodeFromUrl(url) {
  try {
    const params = new URLSearchParams(new URL(url).search);
    // US format
    const usColor = params.get('color');
    if (usColor) return usColor;
    // International (SFCC dwvar_) format
    for (const [key, val] of params.entries()) {
      if (key.startsWith('dwvar_') && key.endsWith('_color')) return val;
    }
  } catch { /* ignore */ }
  return null;
}

// ── Initialization ───────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
  updateBadge();
  console.log('[LuluTracker] Extension installed. Alarm set.');
});

chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) {
    setupAlarm();
  }
});

// ── Alarm handler ────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('[LuluTracker] Alarm fired. Checking all products...');
    await checkAllProducts();
  }
});

// ══════════════════════════════════════════════════════════
// FEATURE 1: Badge count on extension icon
// ══════════════════════════════════════════════════════════

async function updateBadge() {
  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');

  const stockAlerts = trackedProducts.filter(p =>
    p.stockStatus === 'low_stock' || p.stockStatus === 'sold_out'
  ).length;
  const saleAlerts = trackedProducts.filter(p => p.onSale).length;
  const fetchErrors = trackedProducts.filter(p =>
    (p.consecutiveFailures || 0) >= MAX_DISPLAY_FAILURES
  ).length;
  const discontinuedCount = trackedProducts.filter(p => p.discontinued).length;
  const alertCount = stockAlerts + saleAlerts + fetchErrors + discontinuedCount;

  if (alertCount > 0) {
    chrome.action.setBadgeText({ text: alertCount.toString() });
    chrome.action.setBadgeBackgroundColor({
      color: stockAlerts > 0 ? '#d31334'
        : fetchErrors > 0 ? '#e65100'
        : '#1565c0'
    });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ══════════════════════════════════════════════════════════
// Discord webhook notifications — per-region
// ══════════════════════════════════════════════════════════

/**
 * Send a message to a Discord webhook URL.
 * Retries once on rate limit (429).
 */
async function sendDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl || !webhookUrl.startsWith('https://')) return false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok || response.status === 204) {
        console.log(`[LuluTracker] Discord notification sent successfully (attempt ${attempt})`);
        return true;
      }
      if (response.status === 429) {
        const retryAfter = parseFloat(response.headers.get('retry-after') || '1');
        console.log(`[LuluTracker] Discord rate limited, waiting ${retryAfter}s`);
        await new Promise(r => setTimeout(r, retryAfter * 1000 + 500));
      } else {
        console.warn(`[LuluTracker] Discord webhook returned HTTP ${response.status}`);
        return false;
      }
    } catch (err) {
      console.warn(`[LuluTracker] Discord send error (attempt ${attempt}):`, err.message);
      if (attempt === 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

/**
 * Build a Discord embed for a Lululemon product change notification.
 */
function buildDiscordEmbed(product, change, region) {
  const regionLabel = REGION_LABELS[region] || region.toUpperCase();
  const regionFlag = REGION_FLAGS[region] || '';
  const currency = REGION_CURRENCY[region] || 'USD';

  // Color: blue for all notifications
  const sizes = product.availableSizes || [];
  let color = 0x0099ff; // blue = default for all notifications

  // Type label (similar to Python's "Restock" / "Available")
  let typeLabel = 'Update';
  if (change.type === 'status_change') {
    typeLabel = change.to === 'in_stock' ? 'Restock' : change.to === 'sold_out' ? 'Sold Out' : 'Low Stock';
  } else if (change.type === 'price_change') {
    typeLabel = change.to < change.from ? 'Price Drop' : 'Price Up';
  } else if (change.type === 'went_on_sale') {
    typeLabel = 'On Sale';
  } else if (change.type === 'moved_to_markdown') {
    typeLabel = 'WMTM';
  } else if (change.type === 'new_color') {
    typeLabel = 'New Color';
  } else if (change.type === 'discontinued') {
    typeLabel = 'Discontinued';
  } else if (change.type === 'size_change') {
    const r = change.restocked || [];
    const d = change.depleted || [];
    if (r.length > 0 && d.length > 0) typeLabel = 'Size Change';
    else if (r.length > 0) typeLabel = 'Size Restock';
    else typeLabel = 'Size Sold Out';
  }

  // Price
  let priceStr = 'N/A';
  if (product.currentPrice != null) {
    if (change.type === 'price_change') {
      priceStr = `${currency} ${change.from} → ${change.to}`;
    } else if (product.onSale && product.originalPrice && product.originalPrice > product.currentPrice) {
      priceStr = `${currency} ${product.originalPrice} → ${product.currentPrice}`;
    } else {
      priceStr = `${currency} ${product.currentPrice}`;
    }
  }

  // Color / Size
  let colorSizeStr = product.color || 'N/A';
  if (product.size && product.size !== 'Not selected') {
    colorSizeStr += ` / ${product.size}`;
  }

  const fields = [
    { name: 'Price', value: priceStr, inline: true },
    { name: 'Type', value: typeLabel, inline: true },
    { name: 'On Sale', value: product.onSale ? '\u{1F7E2}' : '\u{1F534}', inline: true },
  ];

  // Sizes / Stock — two columns (matching Python script, only available sizes)
  const availableSizes = sizes.filter(s => s.available);
  if (availableSizes.length > 0) {
    const mid = Math.ceil(availableSizes.length / 2);
    const left = availableSizes.slice(0, mid);
    const right = availableSizes.slice(mid);

    const formatCol = (list) => {
      if (list.length === 0) return '\u200b';
      return list.map(s => s.size).join('\n');
    };

    fields.push({ name: 'Sizes / Stock', value: formatCol(left), inline: true });
    fields.push({ name: 'Sizes / Stock', value: formatCol(right), inline: true });
  }

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return {
    embeds: [{
      description: `### [${product.name}](${product.url})`,
      color,
      timestamp: now.toISOString(),
      author: {
        name: `Lululemon ${regionLabel}`,
        icon_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Lululemon_Athletica_logo.svg/1024px-Lululemon_Athletica_logo.svg.png',
      },
      footer: {
        text: `Lululemon Monitor v1.0 | By LuluTracker \u2022 [${timeStr}] ${dateStr}`,
      },
      fields,
      thumbnail: product.image ? { url: product.image } : undefined,
    }],
  };
}

/**
 * After checking all products, send Discord notifications per region.
 */
async function sendDiscordForNotifItems(notifItems) {
  if (notifItems.length === 0) return;

  const { regionWebhooks = {} } = await chrome.storage.local.get('regionWebhooks');
  const hasAnyWebhook = Object.values(regionWebhooks).some(u => u && u.startsWith('https://'));
  if (!hasAnyWebhook) {
    console.warn('[LuluTracker] sendDiscordForNotifItems skipped: no webhooks configured at all');
    return;
  }

  // Group notif items by region
  const byRegion = {};
  for (const item of notifItems) {
    const region = getProductRegion(item.product.url || item.url || '');
    if (!byRegion[region]) byRegion[region] = [];
    byRegion[region].push(item);
  }

  for (const [region, items] of Object.entries(byRegion)) {
    const webhookUrl = regionWebhooks[region];
    if (!webhookUrl || !webhookUrl.startsWith('https://')) {
      console.warn(`[LuluTracker] Skipping ${items.length} notifications: no webhook for region "${region}". Available: ${Object.keys(regionWebhooks).join(', ') || 'none'}`);
      continue;
    }

    // For multiple items in same region, send individual or batch (max 5 per batch)
    for (const item of items) {
      const embed = buildDiscordEmbed(item.product, item.change, region);
      await sendDiscordWebhook(webhookUrl, embed);
      // Small delay between messages to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

// ══════════════════════════════════════════════════════════
// Initial Discord notification — on first track
// ══════════════════════════════════════════════════════════

/**
 * Send a Discord notification when a product is first tracked.
 * Format references the Adidas monitor style: main image, price, available sizes.
 */
async function sendInitialDiscord(product) {
  const region = getProductRegion(product.url);
  const { regionWebhooks = {} } = await chrome.storage.local.get('regionWebhooks');
  const webhookUrl = regionWebhooks[region];
  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    console.warn(`[LuluTracker] sendInitialDiscord skipped: no webhook for region "${region}". Available regions: ${Object.keys(regionWebhooks).join(', ') || 'none'}`);
    return;
  }

  const regionLabel = REGION_LABELS[region] || region.toUpperCase();
  const regionFlag = REGION_FLAGS[region] || '';
  const currency = REGION_CURRENCY[region] || 'USD';

  // Color: green=discount, blue=normal, red=sold out (matches Python script logic)
  const sizes = product.availableSizes || [];
  const hasStock = sizes.some(s => s.available);
  let color = 0x0099ff; // blue = normal
  if (!hasStock) {
    color = 0xff0000; // red = sold out
  } else if (product.onSale && product.originalPrice && product.currentPrice != null && product.currentPrice < product.originalPrice) {
    color = 0x00ff00; // green = discount
  }

  // Price: "USD 128 → 78 USD" if discounted, else "USD 78 USD"
  let priceStr = 'N/A';
  if (product.currentPrice != null) {
    if (product.onSale && product.originalPrice && product.originalPrice > product.currentPrice) {
      priceStr = `${currency} ${product.originalPrice} → ${product.currentPrice}`;
    } else {
      priceStr = `${currency} ${product.currentPrice}`;
    }
  }

  // Color / Size
  let colorSizeStr = product.color || 'N/A';
  if (product.size && product.size !== 'Not selected') {
    colorSizeStr += ` / ${product.size}`;
  }

  const fields = [
    { name: 'Price', value: priceStr, inline: true },
    { name: 'Color / Size', value: colorSizeStr, inline: true },
    { name: 'On Sale', value: product.onSale ? '\u{1F7E2}' : '\u{1F534}', inline: true },
  ];

  // Sizes / Stock — two columns (matching Python script, only available sizes)
  const availableSizes = sizes.filter(s => s.available);
  if (availableSizes.length > 0) {
    const mid = Math.ceil(availableSizes.length / 2);
    const left = availableSizes.slice(0, mid);
    const right = availableSizes.slice(mid);

    const formatCol = (list) => {
      if (list.length === 0) return '\u200b';
      return list.map(s => s.size).join('\n');
    };

    fields.push({ name: 'Sizes / Stock', value: formatCol(left), inline: true });
    fields.push({ name: 'Sizes / Stock', value: formatCol(right), inline: true });
  }

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const embed = {
    description: `### [${product.name}](${product.url})`,
    color,
    timestamp: now.toISOString(),
    author: {
      name: `Lululemon ${regionLabel}`,
      icon_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Lululemon_Athletica_logo.svg/1024px-Lululemon_Athletica_logo.svg.png',
    },
    footer: {
      text: `Lululemon Monitor v1.0 | By LuluTracker \u2022 [${timeStr}] ${dateStr}`,
    },
    fields,
  };

  if (product.image) {
    embed.thumbnail = { url: product.image };
  }

  console.log(`[LuluTracker] Sending initial Discord notification for ${product.name}`);
  await sendDiscordWebhook(webhookUrl, { embeds: [embed] });
}

// ══════════════════════════════════════════════════════════
// Size sorting — lululemon uses both letter (XS…XXL) and numeric (0,2,4…)
// ══════════════════════════════════════════════════════════

const SIZE_LETTER_ORDER = ['XXXS','XXS','XS','S','M','L','XL','XXL','XXXL','4XL','5XL'];

function sortSizes(sizes) {
  return [...sizes].sort((a, b) => {
    const sa = String(a.size || '').trim().toUpperCase();
    const sb = String(b.size || '').trim().toUpperCase();
    const numA = parseFloat(sa);
    const numB = parseFloat(sb);
    const bothNumeric = !isNaN(numA) && !isNaN(numB);
    if (bothNumeric) return numA - numB;
    const idxA = SIZE_LETTER_ORDER.indexOf(sa);
    const idxB = SIZE_LETTER_ORDER.indexOf(sb);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return sa.localeCompare(sb);
  });
}

// ══════════════════════════════════════════════════════════
// FEATURE 4: Fetch with retry
//
// Wraps a single fetch attempt. On failure (network error or
// non-200 status), waits RETRY_DELAY_MS then tries once more.
// Returns { html, ok, error } so callers can track failures.
// ══════════════════════════════════════════════════════════

async function fetchWithRetry(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml',
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) {
        const html = await response.text();
        return { html, ok: true, error: null };
      }
      const status = response.status;
      console.warn(`[LuluTracker] HTTP ${status} for ${url} (attempt ${attempt}/2)`);
      if (status === 404) {
        return { html: null, ok: false, error: `HTTP 404 — product page not found` };
      }
      if (attempt === 1) {
        console.log(`[LuluTracker] Retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        return { html: null, ok: false, error: `HTTP ${status} after retry` };
      }
    } catch (err) {
      console.warn(`[LuluTracker] Fetch error for ${url} (attempt ${attempt}/2):`, err.message);
      if (attempt === 1) {
        console.log(`[LuluTracker] Retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        return { html: null, ok: false, error: `Network error: ${err.message}` };
      }
    }
  }
  return { html: null, ok: false, error: 'Unknown fetch failure' };
}


// ══════════════════════════════════════════════════════════
// FEATURE 5: Price history tracking
//
// Stores a priceHistory array on each product:
//   [{ price, date, wasOnSale }]
// Appends a new entry whenever the effective price changes.
// Capped at MAX_PRICE_HISTORY entries (oldest trimmed).
// ══════════════════════════════════════════════════════════
function appendPriceHistory(product, newPrice, wasOnSale) {
  if (newPrice === null || newPrice === undefined) return;
  if (!product.priceHistory) product.priceHistory = [];

  const last = product.priceHistory[product.priceHistory.length - 1];
  // Only append if price actually changed or this is the first entry
  if (last && last.price === newPrice && last.wasOnSale === wasOnSale) return;

  product.priceHistory.push({
    price: newPrice,
    date: Date.now(),
    wasOnSale: !!wasOnSale,
  });

  // Trim to max length (keep most recent)
  if (product.priceHistory.length > MAX_PRICE_HISTORY) {
    product.priceHistory = product.priceHistory.slice(-MAX_PRICE_HISTORY);
  }
}

// ── Core: Check all tracked products ─────────────────────

async function checkAllProducts() {
  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
  if (trackedProducts.length === 0) return;

  const updatedProducts = [];
  const notifItems = [];

  // Cache raw HTML by base URL to avoid re-fetching the same page,
  // but re-parse per product since parsed results are variant-specific.
  const htmlCache = {};
  const newColorNotifiedProductIds = new Set();

  for (const product of trackedProducts) {
    try {
      // Skip discontinued products — still update lastChecked to track check time
      if (product.discontinued) {
        updatedProducts.push({ ...product, lastChecked: Date.now() });
        continue;
      }

      const baseUrl = product.url.split('?')[0];
      let newData;
      let fetchError = null;

      if (htmlCache[baseUrl]) {
        newData = parseProductHtml(htmlCache[baseUrl], product);
      } else {
        const { html, ok, error } = await fetchWithRetry(product.url);
        if (ok) {
          htmlCache[baseUrl] = html;
          newData = parseProductHtml(html, product);
        } else {
          fetchError = error;
          newData = null;
        }
      }

      // ── Fetch failed — track failures, check for discontinuation ──
      if (!newData) {
        const failures = (product.consecutiveFailures || 0) + 1;
        console.warn(`[LuluTracker] Failed to fetch ${product.name}: ${fetchError} (failures: ${failures})`);

        let consecutive404s = product.consecutive404s || 0;
        let discontinued = product.discontinued || false;
        let discontinuedAt = product.discontinuedAt || null;

        if (fetchError && fetchError.includes('404')) {
          consecutive404s += 1;
          if (consecutive404s >= MAX_CONSECUTIVE_404 && !discontinued) {
            discontinued = true;
            discontinuedAt = Date.now();
            console.log(`[LuluTracker] Product marked discontinued after ${consecutive404s} consecutive 404s`);
            notifItems.push({
              product: { ...product, consecutive404s, discontinued, discontinuedAt },
              change: { type: 'discontinued' },
              url: product.url,
            });
          }
        } else {
          consecutive404s = 0;
        }

        updatedProducts.push({
          ...product,
          consecutiveFailures: failures,
          lastFetchError: fetchError,
          consecutive404s,
          discontinued,
          discontinuedAt,
          lastChecked: Date.now(), // track when check was attempted
        });
        continue;
      }

      // ── Fetch succeeded ──
      // Track price history (mutates product.priceHistory in place)
      appendPriceHistory(product, newData.currentPrice, newData.onSale);

      let changes = detectChanges(product, newData);

      // Deduplicate new_color notifications across variants of the same product
      if (product.productId && newColorNotifiedProductIds.has(product.productId)) {
        changes = changes.filter(c => c.type !== 'new_color');
      }
      if (changes.some(c => c.type === 'new_color') && product.productId) {
        newColorNotifiedProductIds.add(product.productId);
      }

      // Build a merged product with fresh data for notifications and storage
      const mergedProduct = {
        ...product,
        availableSizes: newData.availableSizes.length > 0
          ? newData.availableSizes : product.availableSizes,
      };

      // ── Check for normal → discount transition (US only) ──
      let markdownTransition = null;
      const hasSoldOutChange = changes.some(c => c.type === 'status_change' && c.to === 'sold_out');
      const isUSOnlySite = getProductRegion(product.url) === 'us';
      if (!product.url.includes('-MD/') && !product.url.includes('.html') && hasSoldOutChange && isUSOnlySite) {
        markdownTransition = await checkMarkdownTransition(product, newData);
        if (markdownTransition) {
          if (markdownTransition.change && typeof markdownTransition.change.salePrice === 'number') {
            appendPriceHistory(product, markdownTransition.change.salePrice, true);
          }
          changes = changes.filter(c => !(c.type === 'status_change' && c.to === 'sold_out'));
          notifItems.push({
            product: mergedProduct, change: markdownTransition.change, url: markdownTransition.discountUrl,
          });
        }
      }

      // Collect remaining notifications (no cooldown)
      for (const change of changes) {
        notifItems.push({ product: mergedProduct, change, url: product.url });
      }

      updatedProducts.push({
        ...product,
        currentPrice: newData.currentPrice !== null ? newData.currentPrice : product.currentPrice,
        originalPrice: newData.onSale ? (newData.originalPrice || product.originalPrice) : null,
        onSale: newData.onSale,
        stockStatus: markdownTransition ? 'in_stock' : newData.stockStatus,
        availableColors: newData.availableColors.length > 0
          ? newData.availableColors : product.availableColors,
        availableSizes: newData.availableSizes.length > 0
          ? newData.availableSizes : product.availableSizes,
        lastChecked: Date.now(),
        lastChange: (changes.length > 0 || markdownTransition)
          ? {
              type: markdownTransition ? 'moved_to_markdown' : changes[0]?.type,
              timestamp: Date.now(),
            }
          : product.lastChange,
        markdownUrl: markdownTransition
          ? markdownTransition.discountUrl : product.markdownUrl,
        priceHistory: product.priceHistory || [],
        consecutiveFailures: 0,
        lastFetchError: null,
        consecutive404s: 0,
        discontinued: false,
        discontinuedAt: product.discontinuedAt || null,
      });
    } catch (err) {
      console.error(`[LuluTracker] Error checking ${product.name}:`, err);
      updatedProducts.push({
        ...product,
        consecutiveFailures: (product.consecutiveFailures || 0) + 1,
        lastFetchError: err.message || 'Unexpected error during check',
        consecutive404s: product.consecutive404s || 0,
        discontinued: product.discontinued || false,
        discontinuedAt: product.discontinuedAt || null,
        lastChecked: Date.now(), // track when check was attempted
      });
    }
  }

  // ── Send Discord notifications per region ──
  sendDiscordForNotifItems(notifItems); // fire-and-forget (no await needed)

  // Merge updates back — re-read storage to preserve any adds/removes during the check
  const { trackedProducts: currentProducts = [] } = await chrome.storage.local.get('trackedProducts');
  const mergeKey = (p) => `${p.productId || (p.url ? p.url.split('?')[0] : '')}:${getProductRegion(p.url)}:${p.color}:${p.size}`;
  const updatedByKey = new Map(
    updatedProducts.map(p => [mergeKey(p), p])
  );
  const mergedProducts = currentProducts.map(p => {
    return updatedByKey.get(mergeKey(p)) || p;
  });

  await chrome.storage.local.set({ trackedProducts: mergedProducts });
  await updateBadge();
}

// ── Fetch & parse a product page ─────────────────────────

async function fetchProductStatus(product) {
  const { html, ok, error } = await fetchWithRetry(product.url);
  if (!ok) {
    console.warn(`[LuluTracker] Failed to fetch ${product.name}: ${error}`);
    return null;
  }
  return parseProductHtml(html, product);
}

/**
 * Parse fetched HTML — uses __NEXT_DATA__ for US, JSON-LD for SFCC.
 * Falls back to regex patterns.
 */
function parseProductHtml(html, product) {
  const result = {
    currentPrice: null,
    originalPrice: null,
    onSale: false,
    stockStatus: 'in_stock',
    availableColors: [],
    availableSizes: [], // Sizes available for the matching color
  };

  const isIntl = product.url.includes('.html') ||
    product.url.includes('lululemon.com.hk') ||
    product.url.includes('lululemon.com.au') ||
    product.url.includes('lululemon.co.jp') ||
    product.url.includes('lululemon.co.kr') ||
    product.url.includes('lululemon.co.uk') ||
    product.url.includes('lululemon.fr');

  // ── Strategy 1: Parse __NEXT_DATA__ (US site) ──
  const nextDataMatch = html.match(
    /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
      let queryData = null;
      for (const q of queries) {
        const data = q?.state?.data;
        if (data?.productSummary && data?.skus) {
          queryData = data;
          break;
        }
      }
      if (queryData) {
        if (queryData.productSummary?.isSoldOut) {
          result.stockStatus = 'sold_out';
        }
        if (queryData.colors) {
          result.availableColors = queryData.colors.map(c => ({
            code: c.code,
            name: c.name,
          }));
        }
        const colorCode = getColorCodeFromUrl(product.url);
        console.log(`[LuluTracker] Parsing ${product.name}: colorCode=${colorCode}, size=${product.size}`);

        if (colorCode && queryData.skus) {
          const matchingSku = queryData.skus.find(s => {
            const cMatch = s.color?.code === colorCode;
            const sMatch = !product.size || product.size === 'Not selected' ||
              s.size === product.size;
            return cMatch && sMatch;
          });

          if (matchingSku) {
            console.log(`[LuluTracker] Found SKU: available=${matchingSku.available}, onSale=${matchingSku.price?.onSale}`);
            if (matchingSku.price) {
              const listPrice = parseFloat(matchingSku.price.listPrice) || null;
              const salePrice = matchingSku.price.salePrice
                ? parseFloat(matchingSku.price.salePrice) : null;
              result.currentPrice = listPrice;
              if (salePrice && listPrice && salePrice < listPrice) {
                result.originalPrice = listPrice;
                result.currentPrice = salePrice;
                result.onSale = true;
              }
            }
            if (!matchingSku.available) {
              result.stockStatus = 'sold_out';
            }
          } else {
            console.log(`[LuluTracker] No matching SKU found for color=${colorCode} size=${product.size}`);
            if (product.size && product.size !== 'Not selected') {
              const colorDriver = queryData.colorDriver?.find(cd => cd.color === colorCode);
              if (colorDriver && !colorDriver.sizes.includes(product.size)) {
                result.stockStatus = 'sold_out';
              }
            }
          }
        }
        if (!result.currentPrice && queryData.skus.length > 0) {
          result.currentPrice = parseFloat(queryData.skus[0].price?.listPrice) || null;
        }

        // ── Extract available sizes for the matching color ──
        if (colorCode && queryData.skus) {
          result.availableSizes = sortSizes(queryData.skus
            .filter(s => s.color?.code === colorCode)
            .map(s => ({
              size: s.size || 'N/A',
              available: s.available || false,
              price: s.price?.salePrice != null
                ? parseFloat(s.price.salePrice)
                : s.price?.listPrice != null
                  ? parseFloat(s.price.listPrice)
                  : null,
            })));
        }
      }
    } catch (e) {
      console.warn('[LuluTracker] Failed to parse __NEXT_DATA__:', e);
    }
  }

  // ── Strategy 2: Parse JSON-LD ProductGroup (SFCC intl sites) ──
  if (isIntl || !nextDataMatch) {
    const ldMatches = html.matchAll(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
    );
    for (const ldMatch of ldMatches) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        if (ld['@type'] !== 'ProductGroup') continue;
        console.log(`[LuluTracker] Found JSON-LD ProductGroup: ${ld.name}, ${(ld.hasVariant || []).length} variants`);

        const variants = ld.hasVariant || [];

        const colorMap = new Map();
        for (const v of variants) {
          if (v.color && !colorMap.has(v.color)) {
            colorMap.set(v.color, { code: v.color, name: v.color });
          }
        }
        result.availableColors = [...colorMap.values()];

        const colorName = product.color;
        const colorVariants = colorName
          ? variants.filter(v => v.color === colorName) : [];
        console.log(`[LuluTracker] SFCC matching color="${colorName}": ${colorVariants.length} variants`);

        if (colorVariants.length > 0) {
          const price = parseFloat(colorVariants[0].offers?.price);
          if (price > 0) result.currentPrice = price;

          if (product.size && product.size !== 'Not selected') {
            const sizeMatch = colorVariants.find(v => v.size === product.size);
            if (sizeMatch) {
              const avail = sizeMatch.offers?.availability || '';
              if (avail.includes('OutOfStock')) {
                result.stockStatus = 'sold_out';
              }
            }
          }

          const allOut = colorVariants.every(v =>
            (v.offers?.availability || '').includes('OutOfStock')
          );
          if (allOut) result.stockStatus = 'sold_out';

          // ── Extract available sizes from JSON-LD variants (deduplicated by size) ──
          const sizeMap = new Map();
          for (const v of colorVariants) {
            const sz = v.size || 'N/A';
            if (!sizeMap.has(sz)) {
              sizeMap.set(sz, {
                size: sz,
                available: !(v.offers?.availability || '').includes('OutOfStock'),
                price: parseFloat(v.offers?.price) || null,
              });
            } else {
              // If duplicate size, keep the available one
              const existing = sizeMap.get(sz);
              const isAvail = !(v.offers?.availability || '').includes('OutOfStock');
              if (!existing.available && isAvail) {
                sizeMap.set(sz, {
                  size: sz,
                  available: true,
                  price: parseFloat(v.offers?.price) || null,
                });
              }
            }
          }
          result.availableSizes = sortSizes([...sizeMap.values()]);
        } else if (variants.length > 0) {
          // colorName 是颜色代码（如32493），JSON-LD中v.color是颜色名称（如Black），
          // 两者匹配不上时回退到第一个variant
          const price = parseFloat(variants[0].offers?.price);
          if (price > 0) {
            result.currentPrice = price;
            console.log(`[LuluTracker] SFCC fallback to first variant price: ${price}`);
          }

          // Check stock status for the first color
          const firstColor = variants[0].color;
          const firstColorVariants = variants.filter(v => v.color === firstColor);
          const allFirstColorOut = firstColorVariants.length > 0 &&
            firstColorVariants.every(v => (v.offers?.availability || '').includes('OutOfStock'));
          if (allFirstColorOut) {
            result.stockStatus = 'sold_out';
            console.log('[LuluTracker] SFCC fallback: all variants of first color sold out');
          }

          // ── Extract available sizes from first color's variants (deduplicated by size) ──
          const fallbackSizeMap = new Map();
          for (const v of firstColorVariants) {
            const sz = v.size || 'N/A';
            if (!fallbackSizeMap.has(sz)) {
              fallbackSizeMap.set(sz, {
                size: sz,
                available: !(v.offers?.availability || '').includes('OutOfStock'),
                price: parseFloat(v.offers?.price) || null,
              });
            } else {
              const existing = fallbackSizeMap.get(sz);
              const isAvail = !(v.offers?.availability || '').includes('OutOfStock');
              if (!existing.available && isAvail) {
                fallbackSizeMap.set(sz, {
                  size: sz,
                  available: true,
                  price: parseFloat(v.offers?.price) || null,
                });
              }
            }
          }
          result.availableSizes = sortSizes([...fallbackSizeMap.values()]);
        }

        // SFCC discount detection — skip JSON-LD comparison (colorName is a code,
        // v.color is a name, they never match). Rely on markdown-prices class below.
        break;
      } catch (e) {
        console.warn('[LuluTracker] Failed to parse JSON-LD:', e);
      }
    }
  }

  // ── Fallback: regex-based stock detection ──
  if (!isIntl) {
    const htmlLower = html.toLowerCase();
    if (html.includes('pdp-inventory-low-stock-warning') ||
        htmlLower.includes('hurry, only a few left') ||
        htmlLower.includes('only a few left') ||
        htmlLower.includes('almost gone')) {
      if (result.stockStatus !== 'sold_out') {
        result.stockStatus = 'low_stock';
        console.log('[LuluTracker] Detected low stock warning (server-rendered)');
      }
    }
    if (result.stockStatus !== 'sold_out' && result.stockStatus !== 'low_stock') {
      if (htmlLower.includes('>sold out<') || htmlLower.includes('>out of stock<')) {
        result.stockStatus = 'sold_out';
      }
    }
  } else {
    if (result.stockStatus === 'in_stock') {
      const visibleLowStock = html.match(
        /class="stock-avail-msg[^"]*"[^>]*style="[^"]*display:\s*block[^"]*"/
      );
      if (visibleLowStock) {
        result.stockStatus = 'low_stock';
        console.log('[LuluTracker] Detected visible low stock warning (SFCC)');
      }
    }

    // SFCC markdown-prices detection (HK/AU)
    if (isIntl && !result.onSale) {
      if (html.includes('markdown-prices')) {
        result.onSale = true;
        console.log('[LuluTracker] SFCC markdown-prices class detected in HTML');
        const mdPriceMatch = html.match(/class="markdown-prices"[^>]*>[\s\S]*?(?:HK|A|NZ)?\$(\d+(?:[,.]?\d+)*)/);
        if (mdPriceMatch && !result.currentPrice) {
          result.currentPrice = parseFloat(mdPriceMatch[1]);
        }
      }
    }
  }

  if (!result.currentPrice) {
    // 通用正则兜底：匹配价格标签中的数字
    const priceMatch = html.match(
      /data-lll-pl="price"[^>]*>[\s\S]*?([\d,]+(?:\.\d{2})?)/s
    ) || html.match(
      /class="[^"]*price[^"]*"[^>]*>[\s\S]*?([\d,]+(?:\.\d{2})?)/s
    ) || html.match(
      /"price"\s*:\s*"?([\d.]+)/s
    );
    if (priceMatch) {
      result.currentPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
      if (result.currentPrice) {
        console.log(`[LuluTracker] Regex fallback price: ${result.currentPrice}`);
      }
    }
  }

  return result;
}

// ── Detect changes ───────────────────────────────────────

async function checkMarkdownTransition(product, newData) {
  const trackedColorCode = getColorCodeFromUrl(product.url);
  if (!trackedColorCode) return null;

  const colorStillExists = newData.availableColors.some(c => c.code === trackedColorCode);
  if (colorStillExists) return null;

  console.log(`[LuluTracker] Color ${trackedColorCode} disappeared from normal page. Checking markdown...`);

  const mdUrl = product.url.replace(/(\/_\/)/, '-MD$1');

  try {
    const { html, ok } = await fetchWithRetry(mdUrl);
    if (!ok) {
      console.log(`[LuluTracker] Markdown page fetch failed`);
      return null;
    }

    const ndMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!ndMatch) return null;

    const nextData = JSON.parse(ndMatch[1]);
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
    let mdQueryData = null;
    for (const q of queries) {
      const d = q?.state?.data;
      if (d?.productSummary && d?.skus) {
        mdQueryData = d;
        break;
      }
    }
    if (!mdQueryData) return null;

    const mdColor = mdQueryData.colors?.find(c => c.code === trackedColorCode);
    if (!mdColor) return null;

    const mdSku = mdQueryData.skus.find(s =>
      s.color?.code === trackedColorCode &&
      (!product.size || product.size === 'Not selected' || s.size === product.size)
    );

    const salePrice = mdSku?.price?.salePrice
      ? parseFloat(mdSku.price.salePrice) : null;
    const listPrice = mdSku?.price?.listPrice
      ? parseFloat(mdSku.price.listPrice) : product.currentPrice;

    if (salePrice === null && listPrice === null) {
      console.log('[LuluTracker] Found color on markdown page but no price data');
      return null;
    }

    const mdProductId = mdQueryData.productSummary?.productId || '';
    const mdSlug = mdQueryData.productSummary?.unifiedId || '';
    const parentCat = mdQueryData.productSummary?.parentCategoryUnifiedId || '';
    const discountUrl = `https://shop.lululemon.com/p/${parentCat}/${mdSlug}/_/${mdProductId}?color=${trackedColorCode}${product.size && product.size !== 'Not selected' ? '&sz=' + product.size : ''}`;

    console.log(`[LuluTracker] Found color on markdown page! Sale price: $${salePrice} (was $${listPrice})`);

    return {
      discountUrl,
      change: {
        type: 'moved_to_markdown',
        salePrice: salePrice ?? listPrice,
        listPrice: listPrice ?? salePrice,
      },
    };
  } catch (err) {
    console.warn(`[LuluTracker] Error checking markdown page:`, err);
    return null;
  }
}

function detectChanges(oldProduct, newData) {
  const changes = [];

  if (oldProduct.stockStatus !== newData.stockStatus) {
    changes.push({
      type: 'status_change',
      from: oldProduct.stockStatus,
      to: newData.stockStatus,
    });
  }

  if (oldProduct.currentPrice && newData.currentPrice &&
      oldProduct.currentPrice !== newData.currentPrice) {
    changes.push({
      type: 'price_change',
      from: oldProduct.currentPrice,
      to: newData.currentPrice,
    });
  }

  if (!oldProduct.onSale && newData.onSale) {
    changes.push({ type: 'went_on_sale' });
  }

  // 只在 oldProduct 已有颜色数据时才检测新颜色，避免首次监控时把所有颜色都当"新"
  if (oldProduct.trackNewColors && oldProduct.availableColors?.length > 0 && newData.availableColors?.length > 0) {
    const oldCodes = new Set(oldProduct.availableColors.map(c => c.code));
    for (const newColor of newData.availableColors) {
      if (!oldCodes.has(newColor.code)) {
        changes.push({ type: 'new_color', color: newColor.name });
      }
    }
  }

  // Per-size stock change detection
  // 只在 oldProduct 已有尺码数据时才检测，避免首次监控误报
  const oldSizes = oldProduct.availableSizes || [];
  const newSizes = newData.availableSizes || [];
  if (oldSizes.length > 0 && newSizes.length > 0) {
    const oldMap = new Map(oldSizes.map(s => [s.size, s.available]));
    const newMap = new Map(newSizes.map(s => [s.size, s.available]));
    const restocked = []; // 无货 → 有货
    const depleted = [];  // 有货 → 无货
    for (const [size, isAvail] of newMap) {
      const wasAvail = oldMap.get(size);
      if (wasAvail === undefined) continue;
      if (!wasAvail && isAvail) restocked.push(size);
      if (wasAvail && !isAvail) depleted.push(size);
    }
    if (restocked.length > 0 || depleted.length > 0) {
      changes.push({ type: 'size_change', restocked, depleted });
    }
  }

  return changes;
}

// ── Message handler ──────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'addProduct') {
    addProduct(message.product).then(async (result) => {
      await updateBadge();
      sendResponse(result);
    });
    return true;
  }
  if (message.action === 'removeProduct') {
    removeProduct(message.productId, message.color, message.size, message.productUrl).then(async (result) => {
      await updateBadge();
      sendResponse(result);
    });
    return true;
  }
  if (message.action === 'getProducts') {
    chrome.storage.local.get('trackedProducts', (data) => {
      sendResponse(data.trackedProducts || []);
    });
    return true;
  }
  if (message.action === 'checkNow') {
    checkAllProducts().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === 'clearChangeBadge') {
    clearChangeMarkers().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === 'comparePrices') {
    handleComparePrices(message).then(sendResponse);
    return true;
  }
  if (message.action === 'addProductsFromUrls') {
    addProductsFromUrls(message.urls)
      .then(sendResponse)
      .catch((err) => {
        console.error('[LuluTracker] addProductsFromUrls failed:', err);
        sendResponse({ added: 0, skipped: 0, errors: message.urls.length });
      });
    return true;
  }
  if (message.action === 'updateAlarm') {
    chrome.alarms.clear(ALARM_NAME).then(() => {
      chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: 1,
        periodInMinutes: message.intervalMinutes || 60,
      });
      console.log(`[LuluTracker] Alarm updated: every ${message.intervalMinutes} minutes`);
      sendResponse({ success: true });
    });
    return true;
  }
  if (message.action === 'getExchangeRates') {
    fetchExchangeRates()
      .then(rates => sendResponse({ rates }))
      .catch(() => sendResponse({ rates: null }));
    return true;
  }
  if (message.action === 'buildProductUrl') {
    const url = buildProductUrl(message.region, message.productCode, message.colorCode);
    sendResponse({ url });
    return false;
  }
  if (message.action === 'addProductByCode') {
    addProductByCode(message.region, message.productCode, message.colorCode)
      .then(sendResponse)
      .catch((err) => {
        console.error('[LuluTracker] addProductByCode failed:', err);
        sendResponse({ success: false, reason: err.message || '添加失败' });
      });
    return true;
  }
  if (message.action === 'addProductByCodeAllRegions') {
    addProductByCodeAllRegions(message.productCode, message.colorCode)
      .then(sendResponse)
      .catch((err) => {
        console.error('[LuluTracker] addProductByCodeAllRegions failed:', err);
        sendResponse({ results: [], added: 0, total: 0, error: err.message });
      });
    return true;
  }
  // 'productPageChanged' is handled by popup.js — no background action needed
});

async function addProduct(product) {
  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
  const exists = trackedProducts.some(p =>
    p.productId === product.productId &&
    p.color === product.color &&
    p.size === product.size &&
    getProductRegion(p.url) === getProductRegion(product.url)
  );
  if (exists) return { success: false, reason: '已在追踪此商品。' };

  const newProduct = {
    ...product,
    addedAt: Date.now(),
    trackNewColors: true,
    lastChange: null,
    consecutiveFailures: 0,
    lastFetchError: null,
    consecutive404s: 0,
    discontinued: false,
    discontinuedAt: null,
    priceHistory: [],
  };

  // Immediately fetch the live page to establish the correct baseline
  try {
    const liveData = await fetchProductStatus(newProduct);
    if (liveData) {
      if (liveData.availableColors.length > 0) {
        newProduct.availableColors = liveData.availableColors;
      }
      if (liveData.currentPrice !== null) newProduct.currentPrice = liveData.currentPrice;
      if (liveData.originalPrice !== null) newProduct.originalPrice = liveData.originalPrice;
      newProduct.onSale = liveData.onSale;
      newProduct.stockStatus = liveData.stockStatus;
      newProduct.availableSizes = liveData.availableSizes || [];
      newProduct.lastChecked = Date.now();
      newProduct.consecutiveFailures = 0;
      newProduct.lastFetchError = null;
      console.log(`[LuluTracker] Baseline fetch: ${liveData.availableColors.length} colors, ${liveData.availableSizes.length} sizes stored`);

      if (newProduct.currentPrice) {
        appendPriceHistory(newProduct, newProduct.currentPrice, newProduct.onSale);
      }

      // Send initial Discord notification
      const region = getProductRegion(newProduct.url);
      console.log(`[LuluTracker] About to send initial Discord: region=${region}, url=${newProduct.url}`);
      try {
        await sendInitialDiscord(newProduct);
        console.log(`[LuluTracker] Initial Discord OK for ${newProduct.name}`);
      } catch (err) {
        console.error(`[LuluTracker] Initial Discord FAILED for ${newProduct.name}:`, err);
      }
    }
  } catch (err) {
    console.warn('[LuluTracker] Baseline fetch failed, using content script data:', err);
  }

  trackedProducts.push(newProduct);
  await chrome.storage.local.set({ trackedProducts });
  return { success: true };
}

/**
 * Parse minimal product info from a Lululemon product page HTML.
 * Returns { name, image, productId, color, size, currentPrice, ... } or null on failure.
 */
function parseMinimalProductInfo(html, url) {
  const productId = extractProductIdFromUrl(url);
  const color = extractColorFromUrl(url);
  const size = extractSizeFromUrl(url) || 'Not selected';

  let name = null;
  let image = null;
  let currentPrice = null;
  let originalPrice = null;
  let onSale = false;
  let stockStatus = 'in_stock';

  // Try __NEXT_DATA__ (US)
  const ndMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1]);
      const queries = nd?.props?.pageProps?.dehydratedState?.queries || [];
      for (const q of queries) {
        const data = q?.state?.data;
        if (data?.productSummary && data?.skus) {
          name = data.productSummary.displayName || null;
          if (data.productSummary.images?.[0]?.src) {
            image = data.productSummary.images[0].src;
          }
          if (data.productSummary.isSoldOut) stockStatus = 'sold_out';

          if (color && data.skus) {
            const sku = data.skus.find(s =>
              s.color?.code === color &&
              (!size || size === 'Not selected' || s.size === size)
            );
            if (sku?.price) {
              currentPrice = parseFloat(sku.price.listPrice) || null;
              if (sku.price.salePrice) {
                const sp = parseFloat(sku.price.salePrice);
                if (sp < currentPrice) {
                  originalPrice = currentPrice;
                  currentPrice = sp;
                  onSale = true;
                }
              }
            }
            if (sku && !sku.available) stockStatus = 'sold_out';
          }
          break;
        }
      }
    } catch {}
  }

  // Try JSON-LD (intl)
  if (!name) {
    const ldMatches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
    for (const m of ldMatches) {
      try {
        const ld = JSON.parse(m[1]);
        if (ld['@type'] === 'ProductGroup') {
          name = ld.name;
          if (ld.hasVariant?.[0]?.image) image = ld.hasVariant[0].image;
          // color 是颜色代码（如32493），JSON-LD中v.color是颜色名称（如Black），
          // 匹配不上时回退到第一个variant
          const colorVariant = color
            ? (ld.hasVariant?.find(v => v.color === color) || ld.hasVariant?.[0])
            : ld.hasVariant?.[0];
          if (colorVariant?.offers?.price) {
            currentPrice = parseFloat(colorVariant.offers.price);
          }
        } else if (ld['@type'] === 'Product') {
          name = ld.name;
          if (ld.image) image = ld.image;
          if (ld.offers?.price) currentPrice = parseFloat(ld.offers.price);
        }
        if (name) break;
      } catch {}
    }
  }

  // Fallback: try og:title and og:image meta tags
  if (!name) {
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    name = ogTitle ? ogTitle[1] : null;
  }
  if (!image) {
    const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    image = ogImage ? ogImage[1] : null;
  }

  if (!name && !image && !currentPrice) return null;

  return {
    productId, color, size,
    name: name || 'Unknown',
    image: image || null,
    url,
    region: getProductRegion(url),
    currentPrice: currentPrice || null,
    originalPrice: originalPrice || null,
    onSale,
    stockStatus,
    availableSizes: [],
    availableColors: [],
  };
}

function extractProductIdFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    // US: /p/cat/slug/_/prod12345678
    // Intl: /en-hk/p/slug/_/prod12345678.html
    const parts = path.replace(/\.html$/, '').split('/');
    return parts[parts.length - 1] || parts[parts.length - 2] || null;
  } catch { return null; }
}

function extractColorFromUrl(url) {
  try {
    const params = new URLSearchParams(new URL(url).search);
    // US format: ?color=12345
    const us = params.get('color');
    if (us) return us;
    // Intl format: dwvar_prod12345_color=069299
    for (const [k, v] of params.entries()) {
      if (k.startsWith('dwvar_') && k.endsWith('_color')) return v;
    }
  } catch {}
  return null;
}

function extractSizeFromUrl(url) {
  try {
    const params = new URLSearchParams(new URL(url).search);
    // US: ?sz=S
    const us = params.get('sz');
    if (us) return us;
    // Intl: dwvar_prod12345_size=M
    for (const [k, v] of params.entries()) {
      if (k.startsWith('dwvar_') && k.endsWith('_size')) return v;
    }
  } catch {}
  return null;
}

/**
 * Batch add products from a list of URLs.
 * Fetches each URL, parses basic info, and adds to trackedProducts.
 */
async function addProductsFromUrls(urls) {
  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
  let added = 0, skipped = 0, errors = 0;

  // Process in batches of 3 to avoid overwhelming the network
  const batchSize = 3;
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (url) => {
      try {
        const { html, ok } = await fetchWithRetry(url);
        if (!ok) {
          console.warn(`[LuluTracker] Batch add: failed to fetch ${url}`);
          return { error: true };
        }

        const info = parseMinimalProductInfo(html, url);
        if (!info || !info.name) {
          console.warn(`[LuluTracker] Batch add: failed to parse ${url}`);
          return { error: true };
        }

        const mergeKey = (p) => `${p.productId || url.split('?')[0]}:${getProductRegion(p.url)}:${p.color || 'unknown'}:${p.size || 'Not selected'}`;
        const exists = trackedProducts.some(p => mergeKey(p) === mergeKey(info));
        if (exists) return { skipped: true };

        const product = {
          ...info,
          addedAt: Date.now(),
          trackNewColors: true,
          lastChange: null,
          consecutiveFailures: 0,
          lastFetchError: null,
          consecutive404s: 0,
          discontinued: false,
          discontinuedAt: null,
          priceHistory: [],
        };

        if (product.currentPrice) {
          appendPriceHistory(product, product.currentPrice, product.onSale);
        }

        // Send initial Discord notification (fire-and-forget, don't block)
        sendInitialDiscord(product).catch(err => {
          console.warn(`[LuluTracker] Initial Discord failed for ${product.name}:`, err.message);
        });

        trackedProducts.push(product);
        return { added: true };
      } catch (err) {
        console.warn(`[LuluTracker] Batch add error for ${url}:`, err);
        return { error: true };
      }
    }));

    for (const r of results) {
      if (r.error) errors++;
      else if (r.skipped) skipped++;
      else if (r.added) added++;
    }
  }

  await chrome.storage.local.set({ trackedProducts });
  await updateBadge();
  console.log(`[LuluTracker] Batch add complete: ${added} added, ${skipped} skipped, ${errors} errors`);
  return { added, skipped, errors };
}

/**
 * 通过货号和颜色号添加商品追踪。
 * 构建URL → 获取页面 → 解析信息 → 加入追踪列表。
 *
 * @param {string} region - 地区代码
 * @param {string} productCode - 货号
 * @param {string} colorCode - 颜色号
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
async function addProductByCode(region, productCode, colorCode) {
  const url = buildProductUrl(region, productCode, colorCode);
  if (!url) {
    return { success: false, reason: `不支持的地区: ${region}` };
  }

  console.log(`[LuluTracker] addProductByCode: region=${region}, pid=${productCode}, color=${colorCode} → ${url}`);

  const result = await addProductsFromUrls([url]);
  if (result.added > 0) {
    return { success: true, url };
  } else if (result.skipped > 0) {
    return { success: false, reason: '已在追踪此商品' };
  } else {
    return { success: false, reason: `获取商品信息失败 (${result.errors} 个错误)` };
  }
}

/**
 * 统一输入货号和颜色号，自动尝试所有地区。
 * 如果某个区没有这个货号/颜色号（404 或解析失败），则静默跳过。
 *
 * @param {string} productCode - 货号
 * @param {string} colorCode - 颜色号
 * @returns {Promise<{results: Array<{region, success, reason?}>, added: number, total: number}>}
 */
async function addProductByCodeAllRegions(productCode, colorCode) {
  const regions = ['us', 'ca', 'hk', 'au', 'jp', 'kr', 'uk', 'fr', 'vn'];
  const urls = regions
    .map(r => ({ region: r, url: buildProductUrl(r, productCode, colorCode) }))
    .filter(x => x.url);

  if (urls.length === 0) {
    return { results: [], added: 0, total: 0 };
  }

  console.log(`[LuluTracker] addProductByCodeAllRegions: pid=${productCode}, color=${colorCode}, ${urls.length} regions`);

  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
  const results = [];

  // 并行处理，每批 3 个地区
  const batchSize = 3;
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async ({ region, url }) => {
      try {
        const { html, ok } = await fetchWithRetry(url);
        if (!ok) {
          console.log(`[LuluTracker] AllRegions: ${region} — fetch failed, skipping`);
          return { region, success: false, reason: 'not_found' };
        }

        const info = parseMinimalProductInfo(html, url);
        if (!info || !info.name) {
          console.log(`[LuluTracker] AllRegions: ${region} — parse failed, skipping`);
          return { region, success: false, reason: 'parse_failed' };
        }

        // parseMinimalProductInfo 用颜色代码匹配 JSON-LD 颜色名称，经常匹配失败导致价格丢失。
        // 用 parseProductHtml 补充数据，它有正则回退提取价格，更可靠。
        // 注意：parseProductHtml 需要 product 对象，不是 url 字符串
        if (!info.currentPrice || !info.availableSizes?.length) {
          try {
            const fullInfo = parseProductHtml(html, info);
            if (fullInfo) {
              if (fullInfo.currentPrice) info.currentPrice = fullInfo.currentPrice;
              if (fullInfo.onSale !== undefined) info.onSale = fullInfo.onSale;
              if (fullInfo.originalPrice) info.originalPrice = fullInfo.originalPrice;
              if (fullInfo.currency) info.currency = fullInfo.currency;
              if (fullInfo.stockStatus) info.stockStatus = fullInfo.stockStatus;
              if (fullInfo.availableColors?.length) info.availableColors = fullInfo.availableColors;
              if (fullInfo.availableSizes?.length) info.availableSizes = fullInfo.availableSizes;
              console.log(`[LuluTracker] AllRegions: ${region} — data supplemented: price=${info.currentPrice}, colors=${info.availableColors?.length}, sizes=${info.availableSizes?.length}`);
            }
          } catch (e) {
            console.warn(`[LuluTracker] AllRegions: ${region} — parseProductHtml fallback failed:`, e.message);
          }
        }

        const mergeKey = (p) =>
          `${p.productId || url.split('?')[0]}:${getProductRegion(p.url)}:${p.color || 'unknown'}:${p.size || 'Not selected'}`;
        const exists = trackedProducts.some(p => mergeKey(p) === mergeKey(info));
        if (exists) {
          console.log(`[LuluTracker] AllRegions: ${region} — already tracked`);
          return { region, success: false, reason: 'already_tracked' };
        }

        const product = {
          ...info,
          addedAt: Date.now(),
          trackNewColors: true,
          lastChange: null,
          consecutiveFailures: 0,
          lastFetchError: null,
          consecutive404s: 0,
          discontinued: false,
          discontinuedAt: null,
          priceHistory: [],
        };

        if (product.currentPrice) {
          appendPriceHistory(product, product.currentPrice, product.onSale);
        }

        sendInitialDiscord(product).catch(err => {
          console.warn(`[LuluTracker] Initial Discord failed for ${product.name}:`, err.message);
        });

        trackedProducts.push(product);
        console.log(`[LuluTracker] AllRegions: ${region} — added!`);
        return { region, success: true, url };
      } catch (err) {
        console.warn(`[LuluTracker] AllRegions: ${region} — error:`, err.message);
        return { region, success: false, reason: err.message };
      }
    }));

    results.push(...batchResults);
  }

  await chrome.storage.local.set({ trackedProducts });
  await updateBadge();

  const added = results.filter(r => r.success).length;
  console.log(`[LuluTracker] AllRegions done: ${added}/${urls.length} regions added`);
  return { results, added, total: urls.length };
}

async function removeProduct(productId, color, size, productUrl) {
    const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
    const index = trackedProducts.findIndex(p =>
        p.productId === productId && p.color === color && p.size === size && getProductRegion(p.url) === getProductRegion(productUrl)
    );
    if (index >= 0) {
        trackedProducts.splice(index, 1);
        await chrome.storage.local.set({ trackedProducts });
        return { success: true };
    }
    return { success: false };
}

// ══════════════════════════════════════════════════════════
// Cross-region price comparison
// ══════════════════════════════════════════════════════════

const REGION_URLS = {
  us: (pid) => `https://shop.lululemon.com/p/_/_/${pid}`,
  ca: (pid) => `https://shop.lululemon.com/en-ca/p/_/_/${pid}`,
  hk: (pid) => `https://www.lululemon.com.hk/en-hk/p/_/${pid}.html`,
  au: (pid) => `https://www.lululemon.com.au/en-au/p/_/${pid}.html`,
  jp: (pid) => `https://www.lululemon.co.jp/ja-jp/p/_/${pid}.html`,
  kr: (pid) => `https://www.lululemon.co.kr/ko-kr/p/_/${pid}.html`,
  uk: (pid) => `https://www.lululemon.co.uk/en-gb/p/_/${pid}.html`,
  fr: (pid) => `https://www.lululemon.fr/fr-fr/p/_/${pid}.html`,
  vn: (pid) => `https://www.lululemon.com.hk/en-vn/p/_/${pid}.html`,
};

/**
 * 通过货号和颜色号构建各区的完整商品URL。
 * ~ 是通配符，访问时服务器会自动解析为真实的分类/product slug。
 *
 * 两类格式：
 *   US/CA (Next.js):  /p/~/~/_/prod{id}?color={code}
 *   国际站 (SFCC):    /{locale}/p/~/prod{id}.html?dwvar_prod{id}_color={code}
 *
 * @param {string} region - 地区代码: us, ca, hk, au, jp, kr, uk, fr, vn
 * @param {string} productCode - 货号, 如 prod835113 或 835113
 * @param {string} [colorCode] - 颜色号, 如 32493
 * @returns {string|null} 完整的商品URL, 或 null
 */
function buildProductUrl(region, productCode, colorCode) {
  const pid = String(productCode).trim();
  // 自动补全 prod 前缀
  const fullPid = pid.startsWith('prod') ? pid : 'prod' + pid;
  const color = colorCode ? String(colorCode).trim() : '';

  switch (region) {
    // ── Type A: US/CA — Next.js 格式 ──
    case 'us':
      return `https://shop.lululemon.com/p/~/~/_/${fullPid}${color ? '?color=' + color : ''}`;
    case 'ca':
      return `https://shop.lululemon.com/en-ca/p/~/~/_/${fullPid}${color ? '?color=' + color : ''}`;
    // ── Type B: 国际站 SFCC 格式 ──
    case 'hk':
      return `https://www.lululemon.com.hk/en-hk/p/~/${fullPid}.html${color ? '?dwvar_' + fullPid + '_color=' + color : ''}`;
    case 'au':
      return `https://www.lululemon.com.au/en-au/p/~/${fullPid}.html${color ? '?dwvar_' + fullPid + '_color=' + color : ''}`;
    case 'jp':
      return `https://www.lululemon.co.jp/ja-jp/p/~/${fullPid}.html${color ? '?dwvar_' + fullPid + '_color=' + color : ''}`;
    case 'kr':
      return `https://www.lululemon.co.kr/ko-kr/p/~/${fullPid}.html${color ? '?dwvar_' + fullPid + '_color=' + color : ''}`;
    case 'uk':
      return `https://www.lululemon.co.uk/en-gb/p/~/${fullPid}.html${color ? '?dwvar_' + fullPid + '_color=' + color : ''}`;
    case 'fr':
      return `https://www.lululemon.fr/fr-fr/p/~/${fullPid}.html${color ? '?dwvar_' + fullPid + '_color=' + color : ''}`;
    case 'vn':
      return `https://www.lululemon.com.hk/en-vn/p/~/${fullPid}.html${color ? '?dwvar_' + fullPid + '_color=' + color : ''}`;
    default:
      return null;
  }
}
const REGION_CURRENCY_MAP = { us: 'USD', hk: 'HKD', au: 'AUD', jp: 'JPY', kr: 'KRW', uk: 'GBP', ca: 'CAD', fr: 'EUR', vn: 'VND' };

const SFCC_API_CONFIG = {
    hk: { host: 'https://www.lululemon.com.hk', site: 'Sites-HK-Site', locale: 'en_HK' },
    au: { host: 'https://www.lululemon.com.au', site: 'Sites-AU-Site', locale: 'en_AU' },
    jp: { host: 'https://www.lululemon.co.jp', site: 'Sites-JP-Site', locale: 'ja_JP' },
    kr: { host: 'https://www.lululemon.co.kr', site: 'Sites-KR-Site', locale: 'ko_KR' },
    uk: { host: 'https://www.lululemon.co.uk', site: 'Sites-UK-Site', locale: 'en_GB' },
    fr: { host: 'https://www.lululemon.fr', site: 'Sites-FR-Site', locale: 'fr_FR' },
    vn: { host: 'https://www.lululemon.com.hk', site: 'Sites-HK-Site', locale: 'en_VN' },
};

async function fetchExchangeRates() {
  const { exchangeRates } = await chrome.storage.local.get('exchangeRates');
  if (exchangeRates && (Date.now() - exchangeRates.lastUpdated) < 24 * 60 * 60 * 1000) {
    return exchangeRates.rates;
  }
  const response = await fetch('https://open.er-api.com/v6/latest/USD');
  const data = await response.json();
  if (data.result === 'success') {
    const cached = { rates: data.rates, lastUpdated: Date.now() };
    await chrome.storage.local.set({ exchangeRates: cached });
    return data.rates;
  }
  if (exchangeRates) return exchangeRates.rates;
  throw new Error('Failed to fetch exchange rates');
}

function extractFirstVariantPrice(html) {
  const ldMatches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  for (const m of ldMatches) {
    try {
      const ld = JSON.parse(m[1]);
      if (ld['@type'] === 'ProductGroup' && ld.hasVariant?.length > 0) {
        const p = parseFloat(ld.hasVariant[0].offers?.price);
        if (p > 0) return p;
      }
    } catch {}
  }
  return null;
}

/**
 * Fetch price from SFCC international sites using the Product-ShowQuickView JSON API.
  * This is more reliable than fetching full HTML pages because:
   * - Returns structured JSON (no HTML parsing needed)
    * - Smaller response size (~120KB vs ~500KB HTML)
     * - Less likely to be blocked by bot detection
      */
async function fetchSfccPrice(region, productId) {
    const config = SFCC_API_CONFIG[region];
    if (!config) return null;

    const url = `${config.host}/on/demandware.store/${config.site}/${config.locale}/Product-ShowQuickView?pid=${productId}`;
    console.log(`[LuluTracker] SFCC API fetch: ${region} → ${url}`);

    try {
          const response = await fetch(url, {
                  headers: {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                            'Accept': 'application/json, text/html',
                  },
          });

          if (!response.ok) {
                  console.warn(`[LuluTracker] SFCC API ${region}: HTTP ${response.status}`);
                  return null;
          }

          const data = await response.json();
          const product = data?.product;
          if (!product) {
                  console.warn(`[LuluTracker] SFCC API ${region}: No product in response`);
                  return null;
          }

          // Extract price — SFCC returns either range (min/max) or flat price
          let price = null;
          const priceData = product.price;
          if (priceData?.min?.sales?.value) {
                  price = priceData.min.sales.value;
          } else if (priceData?.sales?.value) {
                  price = priceData.sales.value;
          }

          // Detect if on sale (list price > sales price)
          let onSale = false;
          let originalPrice = null;
          if (priceData?.min?.list?.value && priceData.min.list.value > price) {
                  onSale = true;
                  originalPrice = priceData.min.list.value;
          } else if (priceData?.list?.value && priceData.list.value > price) {
                  onSale = true;
                  originalPrice = priceData.list.value;
          }

          // Check availability
          const available = product.available !== false && price !== null;

          console.log(`[LuluTracker] SFCC API ${region}: price=${price}, currency=${REGION_CURRENCY_MAP[region]}, available=${available}`);

          return {
                  price,
                  currency: REGION_CURRENCY_MAP[region],
                  available,
                  onSale,
                  originalPrice,
          };
    } catch (err) {
          console.warn(`[LuluTracker] SFCC API ${region} error:`, err.message);
          return null;
    }
}

async function handleComparePrices({ productId, trackedRegion, trackedPrice, trackedCurrency, trackedColor }) {
  const regions = ['us', 'hk', 'au', 'jp', 'kr', 'uk', 'ca', 'fr', 'vn'];
  const results = {};

  results[trackedRegion] = {
    price: trackedPrice,
    currency: trackedCurrency || REGION_CURRENCY_MAP[trackedRegion],
    available: trackedPrice !== null && trackedPrice !== undefined,
  };

  const otherRegions = regions.filter(r => r !== trackedRegion);
  const fetchPromises = otherRegions.map(async (region) => {
          // Use SFCC JSON API for international regions (more reliable than HTML parsing)
          if (SFCC_API_CONFIG[region]) {
                    const sfccResult = await fetchSfccPrice(region, productId);
                    if (sfccResult) {
                                return { region, data: sfccResult };
                    }
                    return { region, data: { price: null, currency: REGION_CURRENCY_MAP[region], available: false } };
          }
          // US region: use HTML fetch + parse approach
    const url = REGION_URLS[region](productId);
    try {
const { html, ok, error } = await fetchWithRetry(url);
              if (!ok) {
                          console.warn(`[LuluTracker] Compare: ${region} fetch failed: ${error}`);
                          return { region, data: { price: null, currency: REGION_CURRENCY_MAP[region], available: false } };
              }
              const fakeProduct = { url, color: trackedColor || null, size: null };
      const parsed = parseProductHtml(html, fakeProduct);

      // Fallback: if parser didn't find a price (e.g. no color match), grab first variant from JSON-LD
      if (parsed.currentPrice === null) {
        parsed.currentPrice = extractFirstVariantPrice(html);
      }

      return {
        region,
        data: {
          price: parsed.currentPrice,
          currency: REGION_CURRENCY_MAP[region],
          stockStatus: parsed.stockStatus,
          onSale: parsed.onSale,
          available: parsed.currentPrice !== null,
        },
      };
    } catch (err) {
      console.warn(`[LuluTracker] Compare fetch failed for ${region}:`, err.message);
      return { region, data: { price: null, currency: REGION_CURRENCY_MAP[region], available: false } };
    }
  });

  const settled = await Promise.allSettled(fetchPromises);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results[result.value.region] = result.value.data;
    }
  }

  let rates = null;
  try {
    rates = await fetchExchangeRates();
  } catch (e) {
    console.warn('[LuluTracker] Failed to fetch exchange rates:', e);
  }

  return { regions: results, rates };
}

async function clearChangeMarkers() {
  const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
  for (const p of trackedProducts) {
    p.lastChange = null;
  }
  await chrome.storage.local.set({ trackedProducts });
  await updateBadge();
}
