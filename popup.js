/**
 * Popup Script
 *
 * Tabs:
 *   1. Products — track individual product pages (stock, price, colors)
 *   2. Collections — save filtered collection URLs as quick shortcuts
 */

document.addEventListener('DOMContentLoaded', init);

// Known Lululemon sort options (key = URL param value, value = display label)
// US site uses Ns param, international sites use srule param
const SORT_OPTIONS_US = {
  '': '推荐',
  'product.last_SKU_addition_dateTime|1': '最新上架',
  'RATINGS|1': '最高评分',
  'price|0': '价格：低 → 高',
  'price|1': '价格：高 → 低',
};

// International srule values by region
const SORT_OPTIONS_HK = {
  'HK-bestseller': '默认（畅销）',
  'Relevance': '相关度',
  'HK-C-N-': '最新上架',
  'Top sellers': '畅销',
  'Price Descending': '价格：高 → 低',
  'Price Ascending': '价格：低 → 高',
};

const SORT_OPTIONS_AU = {
  'aunz-standard-': '默认',
  'Relevance': '推荐',
  'Price Descending': '价格：高 → 低',
  'Price Ascending': '价格：低 → 高',
  'A-Z': 'A → Z',
  'Z-A': 'Z → A',
};

// ══════════════════════════════════════════════════════════
//  Cross-region price comparison state
// ══════════════════════════════════════════════════════════

const REGION_FLAGS = { us: '\u{1F1FA}\u{1F1F8}', hk: '\u{1F1ED}\u{1F1F0}', au: '\u{1F1E6}\u{1F1FA}', jp: '\u{1F1EF}\u{1F1F5}', kr: '\u{1F1F0}\u{1F1F7}', uk: '\u{1F1EC}\u{1F1E7}', ca: '\u{1F1E8}\u{1F1E6}', fr: '\u{1F1EB}\u{1F1F7}', vn: '\u{1F1FB}\u{1F1F3}' };
const REGION_CURRENCY = { us: 'USD', hk: 'HKD', au: 'AUD', jp: 'JPY', kr: 'KRW', uk: 'GBP', ca: 'CAD', fr: 'EUR', vn: 'VND' };
const REGION_LABELS = { us: 'US', hk: 'HK', au: 'AU', jp: 'JP', kr: 'KR', uk: 'UK', ca: 'CA', fr: 'FR', vn: 'VN' };
const REGION_DOMAINS = {
  'shop.lululemon.com': 'us',
  'shop.lululemon.com/en-ca': 'ca',
  'lululemon.com.hk': 'hk',
  'lululemon.com.au': 'au',
  'lululemon.co.jp': 'jp',
  'lululemon.co.kr': 'kr',
  'lululemon.co.uk': 'uk',
  'lululemon.fr': 'fr',
  'lululemon.com.hk/en-vn': 'vn',
};
const compareCache = new Map();
let currentCompareCurrency = 'USD';
let cachedExchangeRates = null;
let currentRegionFilter = 'all'; // 'all' | 'us' | 'hk' | 'au' | 'jp' | 'kr' | 'uk' | 'ca' | 'fr' | 'vn'

function getTrackedRegion(url) {
  if (url.includes('shop.lululemon.com/en-ca')) return 'ca';
  if (url.includes('shop.lululemon.com')) return 'us';
  if (url.includes('com.hk/en-vn')) return 'vn';
  if (url.includes('lululemon.com.hk')) return 'hk';
  if (url.includes('lululemon.com.au')) return 'au';
  if (url.includes('lululemon.co.jp')) return 'jp';
  if (url.includes('lululemon.co.kr')) return 'kr';
  if (url.includes('lululemon.co.uk')) return 'uk';
  if (url.includes('lululemon.fr')) return 'fr';
  return 'us';
}

function getCompareKey(product) {
  return `${product.productId}:${product.color}:${product.size}`;
}

function formatNativePrice(price, currency) {
  if (price === null || price === undefined) return 'N/A';
  switch (currency) {
    case 'USD': return `$${price}`;
    case 'HKD': return `HK$${price}`;
    case 'AUD': return `A$${price}`;
    case 'JPY': return `\u00A5${Math.round(price).toLocaleString()}`;
    case 'KRW': return `\u20A9${Math.round(price).toLocaleString()}`;
    case 'GBP': return `\u00A3${price.toFixed(2)}`;
    case 'CAD': return `CA$${price.toFixed(2)}`;
    case 'EUR': return `\u20AC${price.toFixed(2)}`;
    case 'VND': return `${price.toLocaleString()}\u20AB`;
    default: return `$${price}`;
  }
}

function formatConvertedPrice(amount, currency) {
  if (amount === null || amount === undefined) return 'N/A';
  switch (currency) {
    case 'USD': return `US$${amount.toFixed(2)}`;
    case 'HKD': return `HK$${amount.toFixed(2)}`;
    case 'AUD': return `A$${amount.toFixed(2)}`;
    case 'JPY': return `\u00A5${Math.round(amount).toLocaleString()}`;
    case 'KRW': return `\u20A9${Math.round(amount).toLocaleString()}`;
    case 'GBP': return `\u00A3${amount.toFixed(2)}`;
    case 'CAD': return `CA$${amount.toFixed(2)}`;
    case 'EUR': return `\u20AC${amount.toFixed(2)}`;
    case 'VND': return `${amount.toLocaleString()}\u20AB`;
    default: return `$${amount.toFixed(2)}`;
  }
}

function convertCurrency(amount, fromCurrency, toCurrency, rates) {
  if (!rates || amount === null || amount === undefined) return null;
  if (fromCurrency === toCurrency) return amount;
  const fromRate = rates[fromCurrency] || 1;
  const toRate = rates[toCurrency] || 1;
  return (amount / fromRate) * toRate;
}

/**
 * Detect if a URL belongs to any Lululemon domain.
 * Returns { isLulu: true, region: 'us'|'hk'|'au'|'other', isUS: bool }
 */
function detectLuluDomain(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host === 'shop.lululemon.com' && u.pathname.startsWith('/en-ca/')) return { isLulu: true, region: 'ca', isUS: false };
    if (host === 'shop.lululemon.com' || host === 'www.lululemon.com') return { isLulu: true, region: 'us', isUS: true };
    if (host.includes('com.hk') && u.pathname.startsWith('/en-vn/')) return { isLulu: true, region: 'vn', isUS: false };
    if (host === 'www.lululemon.com.hk' || host === 'lululemon.com.hk') return { isLulu: true, region: 'hk', isUS: false };
    if (host === 'www.lululemon.com.au' || host === 'lululemon.com.au') return { isLulu: true, region: 'au', isUS: false };
    if (host === 'www.lululemon.co.jp' || host === 'lululemon.co.jp') return { isLulu: true, region: 'jp', isUS: false };
    if (host === 'www.lululemon.co.kr' || host === 'lululemon.co.kr') return { isLulu: true, region: 'kr', isUS: false };
    if (host === 'www.lululemon.co.uk' || host === 'lululemon.co.uk') return { isLulu: true, region: 'uk', isUS: false };
    if (host === 'www.lululemon.fr' || host === 'lululemon.fr') return { isLulu: true, region: 'fr', isUS: false };
    if (host.includes('lululemon.com') || host.includes('lululemon.co.jp') || host.includes('lululemon.co.kr') || host.includes('lululemon.co.uk') || host.includes('lululemon.fr')) return { isLulu: true, region: 'other', isUS: false };
  } catch {}
  return { isLulu: false, region: null, isUS: false };
}

// Filter code → human-readable name mapping
const FILTER_NAMES = {
  // Categories
  'oxc7': "Men's Clothes", 'h1v9': 'Coats & Jackets', 'w1md': 'Hoodies & Sweatshirts',
  'u9dn': 'Pants', 'f3j9': 'Shirts', 'jn1c': 'Shorts', '49w9': 'Underwear',
  // Product Lines
  'sddx': 'ABC', '6dav': 'License To Train', 'peaw': 'Metal Vent Tech',
  'egx7': 'Pace Breaker', 'yh99': 'Soft Jersey', 'esuu': 'Align',
  'j8y3': 'Always Down', 'pwhl': 'Always In Motion', 'c827': 'BeCalm',
  'k158': 'Beyondfeel', 'kg1k': 'Big Cozy', '06p9': 'Built To Move',
  '237s': 'Chargefeel', 'wq7k': 'Cityverse', '4f60': 'Cross Chill',
  '5g0x': 'Daydrift', '1xjq': 'Down for It All', 'xplg': 'Ease The Day',
  '7ki0': 'EasyFive', '8utp': 'EasySet', 'n5c2': 'Engineered Warmth',
  '3jyo': 'Everywhere', 'b4x4': 'Fast & Free', 'bsxs': 'Featherweight',
  '2fkn': 'Fundamental', 'h4uh': 'Grand Standard', '5t96': 'Navigation Down',
  'cjb2': 'Restfeel', '3s3c': 'Slacker', '1ok8': 'Smooth Spacer',
  '23e2': 'Soft Stretch', 'x8f0': 'Split Shift', 'k0lg': 'Steady State',
  'd6em': 'Textured Spacer', 'rw1e': 'Unrestricted Power', 't5t3': 'Wildfeel',
  'm2yt': 'Wunder Puff', '6lfx': 'Zero Tucks', 'qpwg': 'Zeroed In',
  // Subcategories
  '2my0': 'Hoodies', 'sgwg': 'Athletic Shorts', 'ug19': 'Half Zip',
  'g62m': 'Liner Shorts', 'mnkc': 'Athletic Jackets', 'x0md': 'Athletic Pants',
  'qqnm': 'Boxers', 'ovjw': 'Briefs', 'xv48': 'Crewneck Sweatshirts',
  'oh18': 'Pullover Sweaters', '58ei': 'Quarter Zip', '8182': 'Sweat Shorts',
  'qcjs': 'Track Jackets', 'go1x': 'Track Pants', 'dpfg': 'Track Shorts',
  // Sizes
  '00in': 'XS', 'vibs': 'S', 'qstj': 'M', 'u2m1': 'L',
  'q472': 'XL', 'o64u': 'XXL', 'x79j': 'XXXL',
  // Inseam
  'ldut': '3"', 'p9fe': '5"', 't5wf': '7"', 'lfne': '9"',
  'yyug': '27"', 'u756': '28"', 'kqrx': '29"', 'jehg': '30"',
  '7lsa': '31"', 'g23g': '32"', '4tkd': '34"',
  // Fit
  'ydf5': 'Tight Fit', 'oyr3': 'Slim Fit', '53ml': 'Classic Fit',
  'o9nl': 'Relaxed Fit', 'vc9j': 'Oversized Fit',
  // Colors
  'c1a0': 'Black', '110v': 'White', '6lm0': 'Grey', 'vjcx': 'Brown',
  'yr3d': 'Khaki', 'zrsk3': 'Neutral', 'sn78': 'Red', 'crj8': 'Pink',
  'vqp4': 'Burgundy', 'lls5': 'Orange', 'flnr': 'Yellow', 'w2wh': 'Green',
  'td6f': 'Olive', '0vt3': 'Blue', 'ea52': 'Navy', 'h084': 'Purple',
  'pspv': 'Pastel', '5l40': 'Neon', '2bcn': 'Striped', '9u7a': 'Printed',
  'um4i': 'Leopard Print', 'mtwv': 'Tie Dye',
  // Activity
  'ae4c': 'Workout', 'ynj2': 'Running', 'yk1r': 'Casual', '1m2d': 'Golf',
  'loe8': 'Lounge', 'f38a': 'Tennis', '4anx': 'Travel', 'pofs': 'Yoga',
  'qfse': 'Training',
  // Fabric
  '3wwi': 'Cotton', 'ir5y': 'Fleece', 'csjh': 'Luxtreme', 'by2w': 'Mesh',
  'nua5': 'Ripstop', '8bdf': 'Swift',
  // Features
  '8avr': 'Pocketed', 'n6yq': 'Multipack', 'd7ck': 'Anti Stink',
  '41ke': 'Drawstring', 'a1b7': 'Breathable', 'p21b': 'Lightweight',
  'h591': 'Quick Dry', 'og7t': 'Reflective', 'd5m8': 'Seamless',
  '7xon': 'Sun Protection', 'uoos': 'Water Repellant',
  // Weather/Season
  'fowa': 'Warm Weather', 'gjr2': 'Cold Weather',
  'w6qx': 'Spring', 'mi4u': 'Summer', '9olv': 'Fall', 'inmi': 'Winter',
};

async function init() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Currency selector
  const { compareCurrency } = await chrome.storage.local.get('compareCurrency');
  currentCompareCurrency = compareCurrency || 'USD';
  const currencySelect = document.getElementById('currency-selector');
  currencySelect.value = currentCompareCurrency;
  currencySelect.addEventListener('change', async (e) => {
    currentCompareCurrency = e.target.value;
    await chrome.storage.local.set({ compareCurrency: currentCompareCurrency });
    rerenderVisibleComparisons();
  });

  // Products tab
  await renderProductList();
  await detectCurrentPage();
  document.getElementById('btn-refresh').addEventListener('click', handleRefresh);

  // Collections tab
  await renderCollections();
  await detectCollectionPage();
  document.getElementById('btn-add-collection').addEventListener('click', handleAddCollection);
  document.getElementById('btn-save-collection').addEventListener('click', handleSaveCollectionPage);

  // Settings tab
  await initSettings();

  // Region filter bar
  await renderRegionFilter();
  document.getElementById('region-filter-all')?.addEventListener('click', () => setRegionFilter('all'));
  document.getElementById('region-filter-us')?.addEventListener('click', () => setRegionFilter('us'));
  document.getElementById('region-filter-hk')?.addEventListener('click', () => setRegionFilter('hk'));
  document.getElementById('region-filter-au')?.addEventListener('click', () => setRegionFilter('au'));
  document.getElementById('region-filter-jp')?.addEventListener('click', () => setRegionFilter('jp'));
  document.getElementById('region-filter-kr')?.addEventListener('click', () => setRegionFilter('kr'));
  document.getElementById('region-filter-uk')?.addEventListener('click', () => setRegionFilter('uk'));
  document.getElementById('region-filter-ca')?.addEventListener('click', () => setRegionFilter('ca'));
  document.getElementById('region-filter-fr')?.addEventListener('click', () => setRegionFilter('fr'));
  document.getElementById('region-filter-vn')?.addEventListener('click', () => setRegionFilter('vn'));

  // Batch import buttons
  document.querySelectorAll('.btn-batch-add').forEach(btn => {
    btn.addEventListener('click', () => handleBatchAdd(btn.dataset.region));
  });

  // ── 货号+颜色号 快速添加（全地区） ──
  const codeProductInput = document.getElementById('code-product-input');
  const codeColorInput = document.getElementById('code-color-input');
  const codeUrlPreview = document.getElementById('code-url-preview');
  const codeAddStatus = document.getElementById('code-add-status');
  const btnCodeAdd = document.getElementById('btn-code-add');

  const REGION_FLAGS_MAP = { us: '\u{1F1FA}\u{1F1F8}', hk: '\u{1F1ED}\u{1F1F0}', au: '\u{1F1E6}\u{1F1FA}', jp: '\u{1F1EF}\u{1F1F5}', kr: '\u{1F1F0}\u{1F1F7}', uk: '\u{1F1EC}\u{1F1E7}', ca: '\u{1F1E8}\u{1F1E6}', fr: '\u{1F1EB}\u{1F1F7}', vn: '\u{1F1FB}\u{1F1F3}' };

  let codePreviewTimeout = null;
  async function updateCodePreview() {
    const productCode = codeProductInput.value.trim();
    const colorCode = codeColorInput.value.trim();
    if (!productCode) {
      codeUrlPreview.textContent = '';
      return;
    }
    // 预览 US 区的 URL 作为示例
    const result = await chrome.runtime.sendMessage({
      action: 'buildProductUrl',
      region: 'us',
      productCode,
      colorCode,
    });
    codeUrlPreview.textContent = result.url ? `预览(US)：${result.url}` : '无法生成 URL';
  }

  codeProductInput.addEventListener('input', () => {
    if (codePreviewTimeout) clearTimeout(codePreviewTimeout);
    codePreviewTimeout = setTimeout(updateCodePreview, 300);
  });
  codeColorInput.addEventListener('input', () => {
    if (codePreviewTimeout) clearTimeout(codePreviewTimeout);
    codePreviewTimeout = setTimeout(updateCodePreview, 300);
  });

  btnCodeAdd.addEventListener('click', async () => {
    const productCode = codeProductInput.value.trim();
    const colorCode = codeColorInput.value.trim();

    if (!productCode) {
      showMessage('请输入货号', 'error');
      return;
    }
    if (!colorCode) {
      showMessage('请输入颜色号', 'error');
      return;
    }

    btnCodeAdd.disabled = true;
    btnCodeAdd.textContent = '正在扫描全地区...';
    codeAddStatus.textContent = '';
    codeAddStatus.className = 'code-add-status';

    try {
      const result = await chrome.runtime.sendMessage({
        action: 'addProductByCodeAllRegions',
        productCode,
        colorCode,
      });

      const { results = [], added = 0, total = 0 } = result;

      if (added > 0) {
        const successRegions = results
          .filter(r => r.success)
          .map(r => `${REGION_FLAGS_MAP[r.region] || r.region} ${r.region.toUpperCase()}`)
          .join(', ');
        codeAddStatus.textContent = `已添加 ${successRegions}（${added}/${total} 个地区）`;
        codeAddStatus.className = 'code-add-status';
        showMessage(`成功追踪 ${added} 个地区`, 'success');
        codeProductInput.value = '';
        codeColorInput.value = '';
        codeUrlPreview.textContent = '';
        await renderProductList();
        await renderRegionFilter();
      } else {
        codeAddStatus.textContent = '所有地区都没有找到该商品，请检查货号和颜色号';
        codeAddStatus.className = 'code-add-status error';
        showMessage('所有地区均未找到该商品', 'error');
      }
    } catch (err) {
      codeAddStatus.textContent = '添加失败：' + (err.message || '未知错误');
      codeAddStatus.className = 'code-add-status error';
      showMessage('添加失败：' + (err.message || '未知错误'), 'error');
    } finally {
      btnCodeAdd.disabled = false;
      btnCodeAdd.textContent = '全地区追踪';
    }
  });

  // SPA navigation listener
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'productPageChanged') {
      setTimeout(() => detectCurrentPage(), 500);
    }
  });
}

// ══════════════════════════════════════════════════════════
//  Tab switching
// ══════════════════════════════════════════════════════════

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tabName)
  );
  document.querySelectorAll('.tab-content').forEach(c =>
    c.classList.toggle('active', c.id === `tab-${tabName}`)
  );
}

// ══════════════════════════════════════════════════════════
//  Products tab
// ══════════════════════════════════════════════════════════

async function detectCurrentPage() {
  const trackSection = document.getElementById('track-section');
  const preview = document.getElementById('current-product-preview');
  const btnTrack = document.getElementById('btn-track');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !detectLuluDomain(tab.url).isLulu || !tab.url.includes('/p/')) {
      trackSection.classList.add('hidden');
      return;
    }

    let productData;
    try {
      productData = await sendMessageToTab(tab.id, { action: 'extractProductData' });
    } catch (e) {
      trackSection.classList.add('hidden');
      return;
    }

    if (!productData || !productData.name) {
      trackSection.classList.add('hidden');
      return;
    }

    trackSection.classList.remove('hidden');
    const priceText = productData.currentPrice ? ` · $${productData.currentPrice}` : '';
    const regionTag = productData.region ? `<span class="region-tag">${escapeHtml(productData.region)}</span> ` : '';
    preview.innerHTML = `
      <strong>${escapeHtml(productData.name)}</strong><br>
      <span class="preview-meta">${regionTag}${escapeHtml(productData.color)} · 尺码：${escapeHtml(productData.size === 'Not selected' ? '未选择' : productData.size)}${priceText}</span>
    `;

    const existingProducts = await getProducts();
    const alreadyTracked = existingProducts.some(p =>
      p.productId === productData.productId && p.color === productData.color && p.size === productData.size && getTrackedRegion(p.url) === getTrackedRegion(productData.url)
    );

    const newBtn = btnTrack.cloneNode(true);
    btnTrack.replaceWith(newBtn);

    if (alreadyTracked) {
      newBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg> 已在追踪`;
      newBtn.disabled = true;
    } else {
      newBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg> 追踪此商品`;
      newBtn.addEventListener('click', () => handleTrack(productData, newBtn));
    }
  } catch (err) {
    console.error('Error detecting page:', err);
    trackSection.classList.add('hidden');
  }
}

async function renderProductList() {
  const listEl = document.getElementById('product-list');
  const emptyState = document.getElementById('empty-state');
  const products = await getProducts();

  listEl.querySelectorAll('.product-card').forEach(el => el.remove());

  // Filter by region
  const filteredProducts = currentRegionFilter === 'all'
    ? products
    : products.filter(p => getTrackedRegion(p.url) === currentRegionFilter);

  // Update empty state message based on filter
  if (products.length === 0) {
    emptyState.classList.remove('hidden');
    emptyState.querySelector('p:first-of-type').textContent = '暂未追踪任何商品';
    emptyState.querySelector('.hint').textContent = '访问 Lululemon 商品页面，点击"追踪此商品"即可添加';
    return;
  }
  if (filteredProducts.length === 0) {
    emptyState.classList.remove('hidden');
    emptyState.querySelector('p:first-of-type').textContent = `${REGION_LABELS[currentRegionFilter]} 地区暂无商品`;
    emptyState.querySelector('.hint').textContent = '请选择其他地区筛选，或添加该地区的商品';
    return;
  }
  emptyState.classList.add('hidden');

  filteredProducts.forEach((product, index) => {
    const card = document.createElement('div');
    card.className = 'product-card';

    const hasRecentChange = product.lastChange &&
      (Date.now() - product.lastChange.timestamp) < 2 * 60 * 60 * 1000;
    if (hasRecentChange) card.classList.add('has-change');
    if (product.discontinued) card.classList.add('is-discontinued');

    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete') || e.target.closest('.toggle') ||
          e.target.closest('.btn-compare') || e.target.closest('.comparison-row')) return;
      chrome.tabs.create({ url: product.url });
    });

    let thumbHtml = product.image
      ? `<img class="product-thumb" src="${escapeHtml(product.image)}" alt="">`
      : `<div class="product-thumb-placeholder">🏷</div>`;

    let priceHtml = '';
    if (product.currentPrice) {
      if (product.onSale && product.originalPrice) {
        priceHtml = `<span class="product-price sale">$${product.currentPrice} <span class="original">$${product.originalPrice}</span></span>`;
      } else {
        priceHtml = `<span class="product-price">$${product.currentPrice}</span>`;
      }
    }

    const statusLabel = getStatusLabel(product.stockStatus);
    const statusClass = product.discontinued ? 'discontinued' : (product.stockStatus || 'in_stock');
    const saleBadgeHtml = product.onSale ? '<span class="status-badge on_sale">促销中</span>' : '';

    const fetchFailures = product.consecutiveFailures || 0;
    const fetchErrorHtml = fetchFailures >= 3
      ? `<span class="status-badge fetch_error" title="${escapeHtml(product.lastFetchError || '检查失败')}">⚠ 抓取异常</span>`
      : '';

    const discontinuedHtml = product.discontinued
      ? '<span class="status-badge discontinued">已下架</span>'
      : '';
    const changeHtml = hasRecentChange ? '<span class="change-dot" title="检测到最近变动"></span>' : '';
    const markdownHtml = product.markdownUrl
      ? `<a class="markdown-link" href="${escapeHtml(product.markdownUrl)}" title="在 We Made Too Much 查看">🏷️ 查看折扣</a>`
      : '';

    const priceHistoryHtml = getPriceHistoryHtml(product);
    const compareButtonHtml = product.discontinued
      ? ''
      : '<button class="btn-compare" title="跨地区比价">\u{1F310}</button>';

    card.innerHTML = `
      ${thumbHtml}
      <div class="product-info">
        <div class="product-name" title="${escapeHtml(product.name)}">
          ${changeHtml}${escapeHtml(product.name)}
        </div>
        <div class="product-meta">${product.region ? `<span class="region-tag">${escapeHtml(product.region)}</span> ` : ''}${escapeHtml(product.color)} · ${escapeHtml(product.size === 'Not selected' ? '未选择' : product.size)}</div>
        <div class="product-status-row">
          <span class="status-badge ${statusClass}">${statusLabel}</span>
          ${saleBadgeHtml}
          ${fetchErrorHtml}
            ${discontinuedHtml}
          ${priceHtml}
          ${markdownHtml}
          ${compareButtonHtml}
        </div>
        ${priceHistoryHtml}
        <div class="product-settings">
          <label class="toggle" title="追踪该商品线的新颜色">
            <input type="checkbox" ${product.trackNewColors ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
          <span class="toggle-label">新颜色</span>
        </div>
        <div class="comparison-container"></div>
      </div>
      <button class="btn-delete" data-product-id="${escapeHtml(product.productId)}" data-product-url="${escapeHtml(product.url)}" data-color="${escapeHtml(product.color)}" data-size="${escapeHtml(product.size)}" title="停止追踪">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;

    const mdLink = card.querySelector('.markdown-link');
    if (mdLink) {
      mdLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.tabs.create({ url: mdLink.href });
      });
    }

    card.querySelector('.btn-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      await chrome.runtime.sendMessage({
        action: 'removeProduct',
        productId: btn.dataset.productId,
        color: btn.dataset.color,
        size: btn.dataset.size,
        productUrl: btn.dataset.productUrl,
      });
      showMessage('已移除追踪。', 'info');
      await renderProductList();
    });

    const compareBtn = card.querySelector('.btn-compare');
    if (compareBtn) {
      compareBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleCompare(product, card, compareBtn);
      });
    }

    const toggle = card.querySelector('.toggle input');
    toggle.addEventListener('change', async (e) => {
      e.stopPropagation();
      const { trackedProducts = [] } = await chrome.storage.local.get('trackedProducts');
      const match = trackedProducts.find(p =>
        p.productId === product.productId && p.color === product.color && p.size === product.size
      );
      if (match) {
        match.trackNewColors = e.target.checked;
        await chrome.storage.local.set({ trackedProducts });
      }
    });

    listEl.appendChild(card);
  });

  updateFooter(products);
}

async function handleTrack(productData, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = '添加中...';
  const result = await chrome.runtime.sendMessage({ action: 'addProduct', product: productData });
  if (result.success) {
    showMessage('已开始追踪此商品！', 'success');
    btnEl.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg> 已在追踪`;
    await renderProductList();
  } else {
    showMessage(result.reason || '添加失败。', 'error');
    btnEl.disabled = false;
    btnEl.textContent = '追踪此商品';
  }
}

async function handleRefresh() {
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('spinning');
  showMessage('正在检查所有商品...', 'info');
  await chrome.runtime.sendMessage({ action: 'checkNow' });
  btn.classList.remove('spinning');
  showMessage('全部商品已检查！', 'success');
  await renderProductList();
  setTimeout(() => document.getElementById('message').classList.add('hidden'), 2000);
}

// ══════════════════════════════════════════════════════════
//  Collections tab
// ══════════════════════════════════════════════════════════

/**
 * Parse a Lululemon collection URL (both US and international formats).
 *
 * US format:
 *   https://shop.lululemon.com/c/men-clothes/n1{code1}z{code2}?Ns=sort
 *   → filterCodes: ['oxc7', 'peaw'], sort via Ns param
 *
 * International format:
 *   https://www.lululemon.com.hk/en-hk/c/men?prefn1=collection&prefv1=Metal+Vent+Tech|Pace+Breaker&srule=HK-C-N-
 *   → filterNames: ['Metal Vent Tech', 'Pace Breaker'], sort via srule param
 */
function parseCollectionUrl(url) {
  try {
    const u = new URL(url);
    const { isLulu, isUS, region } = detectLuluDomain(url);
    if (!isLulu) return null;

    // Must contain /c/ in the path
    if (!u.pathname.includes('/c/')) return null;

    if (isUS) {
      return parseUSCollectionUrl(u, url);
    } else {
      return parseIntlCollectionUrl(u, url, region);
    }
  } catch {
    return null;
  }
}

function parseUSCollectionUrl(u, fullUrl) {
  // Match /c/{category}/n1{codes}
  const pathMatch = u.pathname.match(/^(\/c\/[^/]+\/)n1(.+)$/);
  if (pathMatch) {
    return {
      format: 'us',
      basePath: pathMatch[1],
      filterCodes: pathMatch[2].split('z').filter(Boolean),
      filterNames: [], // resolved via FILTER_NAMES lookup
      sort: u.searchParams.get('Ns') || '',
      sortType: 'Ns',
      fullUrl,
      extraParams: {},
    };
  }
  // /c/{category} without filter codes
  const simpleMatch = u.pathname.match(/^(\/c\/[^/]+)\/?$/);
  if (simpleMatch) {
    return {
      format: 'us',
      basePath: simpleMatch[1] + '/',
      filterCodes: [],
      filterNames: [],
      sort: u.searchParams.get('Ns') || '',
      sortType: 'Ns',
      fullUrl,
      extraParams: {},
    };
  }
  return null;
}

function parseIntlCollectionUrl(u, fullUrl, region) {
  // Extract the category path: /en-hk/c/men  or  /en-au/c/men  or  /zh-tw/c/men
  const pathMatch = u.pathname.match(/^(\/[^/]+\/c\/[^/?]+)\/?$/);
  const basePath = pathMatch ? pathMatch[1] : u.pathname;

  // Filters: prefn1=collection, prefv1=A|B|C  (pipe-separated, URL-encoded)
  const prefv1 = u.searchParams.get('prefv1') || '';
  const filterNames = prefv1
    ? prefv1.split('|').map(f => f.trim()).filter(Boolean)
    : [];

  // Sort rule
  const srule = u.searchParams.get('srule') || '';

  // Preserve other params (like pmid, prefn1, etc.)
  const extraParams = {};
  for (const [key, val] of u.searchParams.entries()) {
    if (!['prefv1', 'srule'].includes(key)) {
      extraParams[key] = val;
    }
  }

  return {
    format: 'intl',
    region,
    basePath,
    filterCodes: [], // international doesn't use codes
    filterNames,
    sort: srule,
    sortType: 'srule',
    fullUrl,
    extraParams,
  };
}

/**
 * Rebuild a collection URL from parsed parts.
 */
function buildCollectionUrl(parsed, activeFilters) {
  if (parsed.format === 'us') {
    return buildUSCollectionUrl(parsed, activeFilters);
  } else {
    return buildIntlCollectionUrl(parsed, activeFilters);
  }
}

function buildUSCollectionUrl(parsed, activeCodes) {
  let url = `https://shop.lululemon.com${parsed.basePath}`;
  if (activeCodes.length > 0) {
    url += `n1${activeCodes.join('z')}`;
  }
  if (parsed.sort) url += `?Ns=${encodeURIComponent(parsed.sort)}`;
  return url;
}

function buildIntlCollectionUrl(parsed, activeNames) {
  const baseUrl = parsed.fullUrl || parsed.url;
  if (!baseUrl) return '';
  const u = new URL(baseUrl);

  // Rebuild with only active filters
  if (activeNames.length > 0) {
    u.searchParams.set('prefv1', activeNames.join('|'));
  } else {
    u.searchParams.delete('prefv1');
    u.searchParams.delete('prefn1');
  }

  // Update srule if changed
  if (parsed.sort) {
    u.searchParams.set('srule', parsed.sort);
  } else {
    u.searchParams.delete('srule');
  }

  // searchParams.set() encodes spaces as '+' which is what Lululemon expects
  return u.toString();
}

/**
 * Get a display label for a filter — uses FILTER_NAMES for US codes,
 * returns the name directly for international format.
 */
function getFilterDisplayLabel(code, format) {
  if (format === 'us') return FILTER_NAMES[code] || code;
  return code; // international already stores human-readable names
}

/**
 * Get the available sort options for a parsed collection.
 */
function getSortOptions(parsed) {
  if (parsed.format === 'us') return SORT_OPTIONS_US;
  if (parsed.region === 'hk') return SORT_OPTIONS_HK;
  if (parsed.region === 'au') return SORT_OPTIONS_AU;
  // Fallback: combine known options
  const opts = { ...SORT_OPTIONS_HK, ...SORT_OPTIONS_AU };
  if (parsed.sort && !opts[parsed.sort]) {
    opts[parsed.sort] = parsed.sort; // show raw value if unknown
  }
  return opts;
}

/**
 * Detect if the current tab is a Lululemon collection page (/c/).
 * If so, show a "Save This Collection" button.
 */
async function detectCollectionPage() {
  const section = document.getElementById('collection-save-section');
  const preview = document.getElementById('collection-page-preview');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) { section.classList.add('hidden'); return; }

    const { isLulu } = detectLuluDomain(tab.url);
    if (!isLulu || !tab.url.includes('/c/')) {
      section.classList.add('hidden');
      return;
    }

    const parsed = parseCollectionUrl(tab.url);
    if (!parsed) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');

    // Derive a name from the tab title
    const pageTitle = tab.title
      ?.replace(/\s*\|.*$/, '')
      .replace(/lululemon/i, '')
      .trim() || 'Collection';

    // Get filter list based on format
    const filters = parsed.format === 'us'
      ? parsed.filterCodes.map(c => FILTER_NAMES[c] || c)
      : parsed.filterNames;
    const filterText = filters.length > 0
      ? filters.join(', ')
      : '无筛选条件';

    const sortOpts = getSortOptions(parsed);
    const sortLabel = sortOpts[parsed.sort] || parsed.sort || '默认';
    const regionTag = parsed.region && parsed.region !== 'us'
      ? ` <span class="region-tag">${parsed.region.toUpperCase()}</span>`
      : '';

    preview.innerHTML = `
      <strong>${escapeHtml(pageTitle)}${regionTag}</strong><br>
      <span class="preview-meta">${escapeHtml(filterText)} · 排序：${escapeHtml(sortLabel)}</span>
    `;

    // Check if already saved
    const collections = await getCollections();
    const alreadySaved = collections.some(c => c.url === tab.url);

    const btn = document.getElementById('btn-save-collection');
    if (alreadySaved) {
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 已保存`;
      btn.disabled = true;
    } else {
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> 保存此收藏`;
      btn.disabled = false;
      btn.dataset.url = tab.url;
      btn.dataset.name = pageTitle;
    }
  } catch (err) {
    console.error('Error detecting collection page:', err);
    section.classList.add('hidden');
  }
}

async function handleSaveCollectionPage() {
  const btn = document.getElementById('btn-save-collection');
  const url = btn.dataset.url;
  const name = btn.dataset.name || 'My Collection';
  if (!url) return;

  await saveCollection(name, url);
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 已保存！`;
  btn.disabled = true;
  await renderCollections();
}

async function handleAddCollection() {
  const nameInput = document.getElementById('collection-name-input');
  const urlInput = document.getElementById('collection-url-input');
  const url = urlInput.value.trim();
  const name = nameInput.value.trim();

  if (!url) {
    showMessage('请输入 URL。', 'error');
    return;
  }
  const { isLulu } = detectLuluDomain(url);
  if (!isLulu || !url.includes('/c/')) {
    showMessage('必须为 Lululemon 收藏页面（含 /c/）。', 'error');
    return;
  }

  await saveCollection(name || '我的收藏', url);
  nameInput.value = '';
  urlInput.value = '';
  showMessage('收藏已保存！', 'success');
  setTimeout(() => document.getElementById('message').classList.add('hidden'), 1500);
  await renderCollections();
}

async function saveCollection(name, url) {
  const collections = await getCollections();
  if (collections.some(c => c.url === url)) return;

  const parsed = parseCollectionUrl(url);
  collections.push({
    name,
    url,
    format: parsed?.format || 'us',
    region: parsed?.region || 'us',
    basePath: parsed?.basePath || '',
    filterCodes: parsed?.filterCodes || [],
    filterNames: parsed?.filterNames || [],
    sort: parsed?.sort || '',
    sortType: parsed?.sortType || 'Ns',
    extraParams: parsed?.extraParams || {},
    addedAt: Date.now(),
  });
  await chrome.storage.local.set({ savedCollections: collections });
}

async function renderCollections() {
  const listEl = document.getElementById('collection-list');
  const emptyState = document.getElementById('collection-empty');
  const collections = await getCollections();

  listEl.querySelectorAll('.collection-card').forEach(el => el.remove());

  if (collections.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  collections.forEach((col, index) => {
    const card = document.createElement('div');
    card.className = 'collection-card';
    card.dataset.format = col.format || 'us';

    // Determine filters to display: use codes for US, names for intl
    const isUS = (col.format || 'us') === 'us';
    const filterItems = isUS
      ? (col.filterCodes || [])
      : (col.filterNames || []);

    // Filter chips — clickable to toggle on/off
    const chipsHtml = filterItems.map(item => {
      const label = isUS ? (FILTER_NAMES[item] || item) : item;
      return `<span class="filter-chip active" data-code="${escapeHtml(item)}" title="${escapeHtml(item)}">${escapeHtml(label)}</span>`;
    }).join('');

    // Sort dropdown — different options per format
    const sortOpts = getSortOptions(col);
    const sortOptionsHtml = Object.entries(sortOpts).map(([val, label]) =>
      `<option value="${escapeHtml(val)}" ${col.sort === val ? 'selected' : ''}>${escapeHtml(label)}</option>`
    ).join('');

    // Region badge
    const regionBadge = col.region && col.region !== 'us'
      ? `<span class="region-tag">${col.region.toUpperCase()}</span>`
      : '';

    card.innerHTML = `
      <div class="collection-main">
        <div class="collection-name-row">
          <span class="collection-name">${escapeHtml(col.name)} ${regionBadge}</span>
          <div class="collection-actions">
            <button class="icon-btn-sm btn-edit" data-index="${index}" title="编辑名称">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button class="icon-btn-sm btn-delete-col" data-index="${index}" title="删除">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="collection-meta-row">
          <select class="sort-select" data-index="${index}">${sortOptionsHtml}</select>
          <button class="btn-open" title="在新标签页打开">打开 →</button>
        </div>
        ${filterItems.length > 0 ? `<div class="collection-chips">${chipsHtml}</div>` : ''}
      </div>
    `;

    // Open button — builds URL from active filters + selected sort
    card.querySelector('.btn-open').addEventListener('click', () => {
      const activeFilters = getActiveFilters(card);
      const sort = card.querySelector('.sort-select').value;

      // Build a parsed-like object to pass to buildCollectionUrl
      const buildData = { ...col, sort };
      const url = buildCollectionUrl(buildData, activeFilters);
      chrome.tabs.create({ url });
    });

    // Sort change → update stored sort
    card.querySelector('.sort-select').addEventListener('change', async (e) => {
      const idx = parseInt(e.target.dataset.index);
      const allCollections = await getCollections();
      allCollections[idx].sort = e.target.value;
      // Rebuild the full URL with new sort
      const activeFilters = isUS
        ? allCollections[idx].filterCodes
        : allCollections[idx].filterNames;
      allCollections[idx].url = buildCollectionUrl(allCollections[idx], activeFilters);
      await chrome.storage.local.set({ savedCollections: allCollections });
    });

    // Filter chips — click to toggle active/disabled
    card.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        chip.classList.toggle('disabled');
      });
    });

    // Edit name
    card.querySelector('.btn-edit').addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.index);
      const nameEl = card.querySelector('.collection-name');
      const currentName = collections[idx].name;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'edit-name-input';
      input.value = currentName;
      input.maxLength = 60;
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      let saved = false;
      const save = async () => {
        if (saved) return;
        saved = true;
        const newName = input.value.trim() || currentName;
        const fresh = await getCollections();
        if (idx < fresh.length) {
          fresh[idx].name = newName;
          await chrome.storage.local.set({ savedCollections: fresh });
        }
        await renderCollections();
      };

      input.addEventListener('blur', save);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') save();
        if (ev.key === 'Escape') renderCollections();
      });
    });

    // Delete
    card.querySelector('.btn-delete-col').addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(e.currentTarget.dataset.index);
      const fresh = await getCollections();
      if (idx < fresh.length) {
        fresh.splice(idx, 1);
        await chrome.storage.local.set({ savedCollections: fresh });
      }
      await renderCollections();
    });

    listEl.appendChild(card);
  });
}

/**
 * Read currently active (non-disabled) filter chips from a card element.
 */
function getActiveFilters(cardEl) {
  const filters = [];
  cardEl.querySelectorAll('.filter-chip.active').forEach(c => {
    filters.push(c.dataset.code);
  });
  return filters;
}

// ══════════════════════════════════════════════════════════
//  Price comparison
// ══════════════════════════════════════════════════════════

async function handleCompare(product, card, btn) {
  const container = card.querySelector('.comparison-container');
  const key = getCompareKey(product);

  // Toggle off
  if (btn.classList.contains('active')) {
    btn.classList.remove('active');
    container.innerHTML = '';
    return;
  }

  btn.classList.add('active');

  // Use cache if available
  if (compareCache.has(key)) {
    const cached = compareCache.get(key);
    cachedExchangeRates = cached.rates;
    renderComparisonRow(container, cached.regions, cached.rates, currentCompareCurrency);
    return;
  }

  // Show loading
  container.innerHTML = '<div class="comparison-loading"><div class="spinner-small"></div><span>正在比价\u2026</span></div>';

  const trackedRegion = getTrackedRegion(product.url);
  const result = await chrome.runtime.sendMessage({
    action: 'comparePrices',
    productId: product.productId,
    trackedRegion,
    trackedPrice: product.currentPrice,
    trackedCurrency: REGION_CURRENCY[trackedRegion],
    trackedColor: product.color,
  });

  if (!result || !result.regions) {
    container.innerHTML = '<div class="comparison-loading" style="color:#c62828">比价失败</div>';
    return;
  }

  compareCache.set(key, result);
  cachedExchangeRates = result.rates;
  renderComparisonRow(container, result.regions, result.rates, currentCompareCurrency);
}

function renderComparisonRow(container, regions, rates, displayCurrency) {
  const regionOrder = ['us', 'hk', 'au', 'jp', 'kr', 'uk', 'ca', 'fr', 'vn'];
  const entries = [];
  let cheapestUSD = Infinity;
  let cheapestRegion = null;

  for (const r of regionOrder) {
    const data = regions[r];
    if (!data || !data.available || data.price === null) {
      entries.push({ region: r, price: null, currency: null, available: false, convertedUSD: null });
      continue;
    }
    const convertedUSD = rates ? convertCurrency(data.price, data.currency, 'USD', rates) : null;
    entries.push({ region: r, price: data.price, currency: data.currency, available: true, convertedUSD });
    if (convertedUSD !== null && convertedUSD < cheapestUSD) {
      cheapestUSD = convertedUSD;
      cheapestRegion = r;
    }
  }

  // Native prices row
  const nativeParts = entries.map(e => {
    const flag = REGION_FLAGS[e.region];
    if (!e.available) return `<span class="comp-region unavailable">${flag} N/A</span>`;
    const cls = e.region === cheapestRegion ? 'comp-region cheapest' : 'comp-region';
    return `<span class="${cls}">${flag} ${escapeHtml(formatNativePrice(e.price, e.currency))}</span>`;
  });
  const nativeHtml = nativeParts.join('<span class="comp-sep">|</span>');

  // Converted prices row
  let convertedHtml = '';
  if (rates) {
    const convertedParts = entries.map(e => {
      if (!e.available || e.price === null) return 'N/A';
      const converted = convertCurrency(e.price, e.currency, displayCurrency, rates);
      return formatConvertedPrice(converted, displayCurrency);
    });
    convertedHtml = `<div class="comparison-converted">(${convertedParts.join(' | ')})</div>`;
  }

  container.innerHTML = `
    <div class="comparison-row">
      <div class="comparison-native">${nativeHtml}</div>
      ${convertedHtml}
    </div>
  `;
}

function rerenderVisibleComparisons() {
  document.querySelectorAll('.product-card').forEach(card => {
    const btn = card.querySelector('.btn-compare');
    if (!btn || !btn.classList.contains('active')) return;
    const container = card.querySelector('.comparison-container');
    if (!container || container.innerHTML === '') return;

    // Find the product key from the delete button's data attributes
    const delBtn = card.querySelector('.btn-delete');
    if (!delBtn) return;
    const key = `${delBtn.dataset.productId}:${delBtn.dataset.color}:${delBtn.dataset.size}`;

    const cached = compareCache.get(key);
    if (cached) {
      renderComparisonRow(container, cached.regions, cached.rates, currentCompareCurrency);
    }
  });
}

// ══════════════════════════════════════════════════════════
//  Shared helpers
// ══════════════════════════════════════════════════════════

function getProducts() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getProducts' }, (p) => resolve(p || []));
  });
}

function getCollections() {
  return new Promise((resolve) => {
    chrome.storage.local.get('savedCollections', (d) => resolve(d.savedCollections || []));
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(response);
    });
  });
}

function showMessage(text, type = 'info') {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = `message ${type}`;
  el.classList.remove('hidden');
}

function getStatusLabel(status) {
  switch (status) {
    case 'low_stock': return '⚠ 库存紧张';
    case 'sold_out': return '已售罄';
    case 'in_stock': return '有库存';
    case 'discontinued': return '\u274C 已下架';
    default: return '有库存';
  }
}

function updateFooter(products) {
  const el = document.getElementById('last-check');
  const filteredProducts = currentRegionFilter === 'all'
    ? products
    : products.filter(p => getTrackedRegion(p.url) === currentRegionFilter);
  if (filteredProducts.length === 0) { el.textContent = ''; return; }
  const latest = Math.max(...filteredProducts.map(p => p.lastChecked || 0));
  const countText = currentRegionFilter !== 'all'
    ? ` (${filteredProducts.length}/${products.length})` : '';
  if (latest > 0) el.textContent = `上次检查：${timeAgo(latest)}${countText}`;

  // Update frequency label in footer
  chrome.storage.local.get('checkIntervalMinutes', ({ checkIntervalMinutes = 60 }) => {
    const freqSpan = document.querySelector('.footer-right span:last-child');
    if (!freqSpan) return;
    if (checkIntervalMinutes < 60) freqSpan.textContent = `每 ${checkIntervalMinutes} 分钟检查一次`;
    else if (checkIntervalMinutes === 60) freqSpan.textContent = `每小时检查一次`;
    else freqSpan.textContent = `每 ${checkIntervalMinutes / 60} 小时检查一次`;
  });
}

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  return `${Math.floor(hrs / 24)} 天前`;
}

/**
 * Build price history display HTML for a product card.
 * Shows: lowest price ever badge, price trend arrow, and tooltip with recent entries.
 */
function getPriceHistoryHtml(product) {
  const history = product.priceHistory || [];
  if (history.length === 0) return '';

  const prices = history.map(h => h.price).filter(p => typeof p === 'number' && p > 0);
  if (prices.length === 0) return '';

  const lowestPrice = Math.min(...prices);
  const highestPrice = Math.max(...prices);
  const currentPrice = product.currentPrice;

  // Trend: compare current to previous entry
  let trendHtml = '';
  if (history.length >= 2 && currentPrice) {
    const prev = history[history.length - 2].price;
    if (currentPrice < prev) {
      trendHtml = '<span class="price-trend down" title="价格下降">▼</span>';
    } else if (currentPrice > prev) {
      trendHtml = '<span class="price-trend up" title="价格上涨">▲</span>';
    }
  }

  // Lowest price badge — only show if current price is NOT the lowest, or if we have real history
  let lowestHtml = '';
  if (prices.length >= 2 && lowestPrice < highestPrice) {
    const isAtLowest = currentPrice && currentPrice <= lowestPrice;
    if (isAtLowest) {
      lowestHtml = '<span class="price-history-badge lowest" title="这是有记录以来的最低价！">★ 历史最低</span>';
    } else {
      lowestHtml = `<span class="price-history-badge" title="历史最低价：$${lowestPrice}">最低：$${lowestPrice}</span>`;
    }
  }

  // Build tooltip with recent price entries (last 5)
  const recentEntries = history.slice(-5);
  const tooltipLines = recentEntries.map(h => {
    const date = new Date(h.date);
    const dateStr = `${date.getMonth()+1}/${date.getDate()}`;
    const saleTag = h.wasOnSale ? ' (促销)' : '';
    return `$${h.price}${saleTag} — ${dateStr}`;
  });
  const tooltipText = tooltipLines.join('\n');

  if (!lowestHtml && !trendHtml) return '';

  return `<div class="price-history-row" title="${escapeHtml(tooltipText)}">${trendHtml}${lowestHtml}</div>`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ══════════════════════════════════════════════════════════
//  Settings tab — per-region Discord webhook config
// ══════════════════════════════════════════════════════════

async function initSettings() {
  const { regionWebhooks = {} } = await chrome.storage.local.get('regionWebhooks');

  // Iterate all .webhook-input elements (auto-discovers all regions from the DOM)
  document.querySelectorAll('.webhook-input').forEach(input => {
    const region = input.id.replace('webhook-', '');
    if (!region) return;

    // Load saved value
    const savedUrl = regionWebhooks[region] || '';
    input.value = savedUrl;
    if (savedUrl) input.classList.add('has-value');

    // Save helper
    const save = async () => {
      const url = input.value.trim();
      const { regionWebhooks: current = {} } = await chrome.storage.local.get('regionWebhooks');
      if (url) {
        current[region] = url;
        input.classList.add('has-value');
      } else {
        delete current[region];
        input.classList.remove('has-value');
      }
      await chrome.storage.local.set({ regionWebhooks: current });
    };

    // Blur: save immediately when user clicks/tabs away
    input.addEventListener('blur', save);

    // Input: debounced auto-save while typing
    let saveTimeout = null;
    input.addEventListener('input', () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(save, 600);
    });
  });

  // ── Check interval selector ──
  const freqSelect = document.getElementById('check-interval-select');
  const freqNote = document.getElementById('freq-note');
  const { checkIntervalMinutes } = await chrome.storage.local.get('checkIntervalMinutes');
  if (checkIntervalMinutes && freqSelect) {
    freqSelect.value = String(checkIntervalMinutes);
  }
  updateFreqNote(freqSelect, freqNote);

  freqSelect?.addEventListener('change', async () => {
    const minutes = parseInt(freqSelect.value, 10);
    await chrome.storage.local.set({ checkIntervalMinutes: minutes });
    chrome.runtime.sendMessage({ action: 'updateAlarm', intervalMinutes: minutes });
    updateFreqNote(freqSelect, freqNote);
    // updateFooter needs products, skip here — it's already called in renderProductList
  });
}

/**
 * Update frequency note text.
 */
function updateFreqNote(select, note) {
  if (!select || !note) return;
  const mins = parseInt(select.value, 10);
  if (mins < 60) note.textContent = `（每 ${mins} 分钟检查一次）`;
  else if (mins === 60) note.textContent = `（每 1 小时检查一次）`;
  else note.textContent = `（每 ${mins / 60} 小时检查一次）`;
}

// ══════════════════════════════════════════════════════════
//  Region filter bar
// ══════════════════════════════════════════════════════════

async function renderRegionFilter() {
  const products = await getProducts();
  const productList = document.getElementById('product-list');

  // Remove existing filter bar if any
  const existing = document.getElementById('region-filter-bar');
  if (existing) existing.remove();

  if (products.length === 0) return;

  // Count products per region
  const counts = { all: products.length, us: 0, hk: 0, au: 0, jp: 0, kr: 0, uk: 0, ca: 0, fr: 0, vn: 0 };
  for (const p of products) {
    const r = getTrackedRegion(p.url);
    if (counts[r] !== undefined) counts[r]++;
  }

  const bar = document.createElement('div');
  bar.id = 'region-filter-bar';
  bar.className = 'region-filter-bar';

  const chips = [
    { region: 'all', flag: '\u{1F310}', label: `全部 (${counts.all})` },
    { region: 'us', flag: '\u{1F1FA}\u{1F1F8}', label: `美国 (${counts.us})` },
    { region: 'hk', flag: '\u{1F1ED}\u{1F1F0}', label: `香港 (${counts.hk})` },
    { region: 'au', flag: '\u{1F1E6}\u{1F1FA}', label: `澳洲 (${counts.au})` },
    { region: 'jp', flag: '\u{1F1EF}\u{1F1F5}', label: `日本 (${counts.jp})` },
    { region: 'kr', flag: '\u{1F1F0}\u{1F1F7}', label: `韩国 (${counts.kr})` },
    { region: 'uk', flag: '\u{1F1EC}\u{1F1E7}', label: `英国 (${counts.uk})` },
    { region: 'ca', flag: '\u{1F1E8}\u{1F1E6}', label: `加拿大 (${counts.ca})` },
    { region: 'fr', flag: '\u{1F1EB}\u{1F1F7}', label: `法国 (${counts.fr})` },
    { region: 'vn', flag: '\u{1F1FB}\u{1F1F3}', label: `越南 (${counts.vn})` },
  ];

  chips.forEach(({ region, flag, label }) => {
    const chip = document.createElement('span');
    chip.className = 'region-filter-chip';
    if (currentRegionFilter === region) chip.classList.add('active');
    chip.id = `region-filter-${region}`;
    chip.textContent = `${flag} ${label}`;
    chip.addEventListener('click', () => setRegionFilter(region));
    bar.appendChild(chip);
  });

  // Insert after message element, before product-list
  const messageEl = document.getElementById('message');
  messageEl.after(bar);
}

function setRegionFilter(region) {
  currentRegionFilter = region;
  // Update chip active states
  document.querySelectorAll('.region-filter-chip').forEach(chip => {
    chip.classList.toggle('active', chip.id === `region-filter-${region}`);
  });
  renderProductList();
}

// ══════════════════════════════════════════════════════════
//  Batch import — per region URL list
// ══════════════════════════════════════════════════════════

async function handleBatchAdd(region) {
  const textarea = document.getElementById(`batch-urls-${region}`);
  const btn = document.querySelector(`.btn-batch-add[data-region="${region}"]`);
  const statusEl = document.getElementById(`batch-status-${region}`);
  const raw = textarea.value.trim();

  if (!raw) {
    statusEl.textContent = '请粘贴商品 URL';
    statusEl.className = 'batch-status error';
    return;
  }

  // Parse URLs — one per line, skip empty/comments
  const urls = raw.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.startsWith('http'));

  if (urls.length === 0) {
    statusEl.textContent = '未找到有效 URL';
    statusEl.className = 'batch-status error';
    return;
  }

  // Validate each URL belongs to the correct region
  const invalidUrls = urls.filter(url => {
    const { isLulu, region: urlRegion } = detectLuluDomain(url);
    return !isLulu || urlRegion !== region;
  });
  if (invalidUrls.length > 0) {
    statusEl.textContent = `${invalidUrls.length} 个 URL 不属于 ${REGION_LABELS[region]} 地区，已跳过`;
    statusEl.className = 'batch-status error';
    // Still process valid ones
  }

  const validUrls = urls.filter(url => {
    const { isLulu, region: urlRegion } = detectLuluDomain(url);
    return isLulu && urlRegion === region;
  });

  if (validUrls.length === 0) {
    statusEl.textContent = '没有属于该地区的有效 Lululemon URL';
    statusEl.className = 'batch-status error';
    return;
  }

  btn.disabled = true;
  statusEl.textContent = `正在添加 ${validUrls.length} 个商品...`;
  statusEl.className = 'batch-status';

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'addProductsFromUrls',
      urls: validUrls,
    }) || { added: 0, skipped: 0, errors: validUrls.length };

    const { added, skipped, errors } = result;
    let msg = `成功添加 ${added} 个商品`;
    if (skipped > 0) msg += `，${skipped} 个已存在`;
    if (errors > 0) msg += `，${errors} 个失败`;
    statusEl.textContent = msg;
    statusEl.className = errors > 0 ? 'batch-status error' : 'batch-status success';

    // Clear textarea on success
    if (added > 0) {
      textarea.value = '';
      await renderProductList();
      await renderRegionFilter();
    }
  } catch (err) {
    statusEl.textContent = `批量添加失败：${err.message}`;
    statusEl.className = 'batch-status error';
  } finally {
    btn.disabled = false;
  }
}

