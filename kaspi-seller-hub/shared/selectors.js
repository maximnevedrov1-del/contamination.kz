/**
 * Kaspi Seller Hub — DOM selector registry.
 *
 * THE ONLY FILE YOU SHOULD NEED TO TOUCH WHEN KASPI CHANGES ITS LAYOUT.
 *
 * Loaded in three contexts:
 *   - content scripts (classic script, listed before content.js in manifest.json)
 *   - the service worker and extension pages (imported as a side-effect module)
 * It therefore exports nothing and publishes `globalThis.KSH_SELECTORS`.
 *
 * Conventions
 * -----------
 * - Every selector is an ARRAY of candidates, tried in order. Put the most specific
 *   one first and keep older variants as fallbacks after a layout change.
 * - A candidate starting with "xpath:" is evaluated as XPath, otherwise as CSS.
 * - Field specs: { sel: [...], attr?: 'href' | 'data-x' | ..., regex?: '...' }.
 *   Without `attr` the element's trimmed textContent is used. `regex` keeps the
 *   first capture group (or the whole match).
 * - Text maps (statusMap, paymentMap…) are lower-cased substrings in RU and KK.
 *
 * Every value marked TODO is a placeholder: open the seller cabinet, inspect the
 * element with DevTools and replace it. Diagnostics in Settings list each selector
 * that could not be found, per store.
 */
(() => {
  const SELECTORS = {
    /** Bump when you edit this file — shown in Settings › Diagnostics. */
    version: '0.1.0-placeholder',

    /**
     * Tabs the extension treats as Kaspi seller tabs. Must stay in sync with
     * `host_permissions` / `content_scripts.matches` in manifest.json.
     */
    // "http://localhost/*" = DEMO mode (demo/ folder, see README). Remove it here and in
    // manifest.json before publishing the extension.
    // "file:///*/mc/store-*" = DEMO pages opened by double-click (demo/mc/store-*.html).
    tabMatchPatterns: ['https://kaspi.kz/mc/*', 'https://*.kaspi.kz/*', 'http://localhost/*', 'file:///*/mc/store-*'],

    /** Page detection — substrings matched against location.href (first hit wins). */
    pages: {
      orders: ['#/orders', '/orders'], // TODO: orders list route
      orderDetails: ['#/orders/', '/order/'], // TODO: single order route
      returns: ['#/returns', '/returns'], // TODO
      refusals: ['#/refusals', '/cancellations'], // TODO
      analytics: ['#/analytics', '/analytics', '/statistics'], // TODO
      chat: ['#/chat', '/messages'], // TODO
      login: ['/login', '/signin', 'idmc.shop.kaspi.kz'], // TODO: auth pages
      // URL markers of the seller cabinet. Kaspi tabs outside the cabinet (the
      // public shop, etc.) are ignored and never reported as "not logged in".
      cabinet: ['/mc/', '/mc#', 'mc.shop.kaspi.kz'], // TODO
    },

    /**
     * URL templates, relative to the store tab's origin. {orderId} and
     * {conversationId} are substituted. Used ONLY after an explicit user click
     * (pack, process return, open conversation) — polling never navigates.
     */
    urls: {
      home: '/mc/', // TODO
      ordersList: '/mc/#/orders?status=NEW', // TODO
      orderDetails: '/mc/#/orders/{orderId}', // TODO
      returnsList: '/mc/#/returns', // TODO
      returnDetails: '/mc/#/returns/{orderId}', // TODO
      refusalsList: '/mc/#/refusals', // TODO
      refusalDetails: '/mc/#/refusals/{orderId}', // TODO
      analytics: '/mc/#/analytics', // TODO
      chat: '/mc/#/chat', // TODO
      chatThread: '/mc/#/chat/{conversationId}', // TODO
    },

    /** Session / store identity. */
    session: {
      // Element present only when the seller is logged in (e.g. the account menu).
      authMarker: ['[data-testid="merchant-menu"]', '.merchant-header__profile', 'header .user-menu'], // TODO
      // Login form — if present the tab is treated as "not authenticated".
      loginForm: ['form[action*="login"]', 'input[type="password"]'], // TODO
      // Human-readable store name in the cabinet header.
      shopName: { sel: ['[data-testid="merchant-name"]', '.merchant-header__name', 'header .shop-name'] }, // TODO
      // Stable merchant/store identifier (attribute or text). Falls back to the name.
      shopId: { sel: ['[data-merchant-id]', '[data-testid="merchant-id"]'], attr: 'data-merchant-id', regex: '(\\d+)' }, // TODO
    },

    /** Orders list (Заказы). One row per order. */
    orders: {
      table: ['[data-testid="orders-table"]', 'table.orders-table', '.orders-list'], // TODO
      row: ['[data-testid="order-row"]', 'table.orders-table tbody tr', '.orders-list .order-item'], // TODO
      fields: {
        id: { sel: ['[data-testid="order-code"]', 'td.order-code', '.order-item__code'], regex: '(\\d{6,})' }, // TODO
        date: { sel: ['[data-testid="order-date"]', 'td.order-date', '.order-item__date'] }, // TODO
        status: { sel: ['[data-testid="order-status"]', 'td.order-status', '.order-item__status'] }, // TODO
        amount: { sel: ['[data-testid="order-total"]', 'td.order-total', '.order-item__total'] }, // TODO
        payment: { sel: ['[data-testid="order-payment"]', 'td.order-payment', '.order-item__payment'] }, // TODO
        customer: { sel: ['[data-testid="order-customer"]', 'td.order-customer', '.order-item__customer'] }, // TODO
        link: { sel: ['a[href*="orders/"]'], attr: 'href' }, // TODO: link to the order page
      },
      // "Упаковать" button — inside a row OR on the order details page.
      packButton: [
        '[data-testid="pack-button"]',
        'xpath:.//button[contains(., "Упаковать") or contains(., "Қаптау")]',
      ], // TODO
      // Confirmation dialog button after clicking "Упаковать", if Kaspi asks.
      packConfirm: [
        '[role="dialog"] [data-testid="confirm"]',
        'xpath://div[@role="dialog"]//button[contains(., "Подтвердить") or contains(., "Растау")]',
      ], // TODO
      // Something that proves packing succeeded (status badge / toast).
      packedMarker: ['[data-testid="status-packed"]', '.toast-success', '.notification--success'], // TODO
    },

    /** Order details page — used when the order is not in the visible list. */
    orderDetails: {
      root: ['[data-testid="order-details"]', '.order-details'], // TODO
      id: { sel: ['[data-testid="order-details-code"]', '.order-details__code'], regex: '(\\d{6,})' }, // TODO
      packButton: ['[data-testid="order-details-pack"]', 'xpath://button[contains(., "Упаковать") or contains(., "Қаптау")]'], // TODO
    },

    /** Invoice (накладная) that Kaspi produces after packing. */
    invoice: {
      // Download link for the generated waybill/invoice (PDF or HTML).
      link: [
        '[data-testid="invoice-link"]',
        'a[href*="waybill"]',
        'a[href*="invoice"]',
        'xpath://a[contains(., "Накладная") or contains(., "Жүкқұжат")]',
      ], // TODO
      // Inline invoice markup if Kaspi renders it into the page instead of a file.
      container: ['[data-testid="invoice-preview"]', '.invoice-preview'], // TODO
      // Only fetch invoice files from these origins (plus the tab's own origin).
      allowedOrigins: ['https://kaspi.kz'], // TODO
      waitTimeoutMs: 15000,
    },

    /** Returns list (Возвраты). Same shape as orders + reason. */
    returns: {
      row: ['[data-testid="return-row"]', 'table.returns-table tbody tr'], // TODO
      fields: {
        id: { sel: ['[data-testid="return-order-code"]', 'td.order-code'], regex: '(\\d{6,})' }, // TODO
        date: { sel: ['[data-testid="return-date"]', 'td.return-date'] }, // TODO
        status: { sel: ['[data-testid="return-status"]', 'td.return-status'] }, // TODO
        amount: { sel: ['[data-testid="return-amount"]', 'td.return-amount'] }, // TODO
        payment: { sel: ['[data-testid="return-payment"]'] }, // TODO (often absent)
        reason: { sel: ['[data-testid="return-reason"]', 'td.return-reason'] }, // TODO
        link: { sel: ['a[href*="returns/"]'], attr: 'href' }, // TODO
      },
    },

    /** Refusals / cancellations (Отказы). */
    refusals: {
      row: ['[data-testid="refusal-row"]', 'table.refusals-table tbody tr'], // TODO
      fields: {
        id: { sel: ['[data-testid="refusal-order-code"]', 'td.order-code'], regex: '(\\d{6,})' }, // TODO
        date: { sel: ['[data-testid="refusal-date"]', 'td.refusal-date'] }, // TODO
        status: { sel: ['[data-testid="refusal-status"]', 'td.refusal-status'] }, // TODO
        amount: { sel: ['[data-testid="refusal-amount"]', 'td.refusal-amount'] }, // TODO
        payment: { sel: ['[data-testid="refusal-payment"]'] }, // TODO
        reason: { sel: ['[data-testid="refusal-reason"]', 'td.refusal-reason'] }, // TODO
        link: { sel: ['a[href*="refusals/"]'], attr: 'href' }, // TODO
      },
    },

    /** Store analytics page (Аналитика / Статистика). Only parsed when visible. */
    analytics: {
      kpi: {
        revenue: { sel: ['[data-testid="kpi-revenue"] .value', '.stats-card--revenue .value'] }, // TODO
        orders: { sel: ['[data-testid="kpi-orders"] .value', '.stats-card--orders .value'] }, // TODO
        views: { sel: ['[data-testid="kpi-views"] .value', '.stats-card--views .value'] }, // TODO
        returns: { sel: ['[data-testid="kpi-returns"] .value'] }, // TODO
        refusals: { sel: ['[data-testid="kpi-refusals"] .value'] }, // TODO
      },
      // Daily breakdown table (date / revenue / orders) if the page shows one.
      seriesRow: ['[data-testid="daily-stats"] tbody tr', '.stats-table tbody tr'], // TODO
      seriesFields: {
        date: { sel: ['td:nth-child(1)'] }, // TODO
        revenue: { sel: ['td:nth-child(2)'] }, // TODO
        orders: { sel: ['td:nth-child(3)'] }, // TODO
      },
      // Top products table.
      productRow: ['[data-testid="top-products"] tbody tr', '.top-products tbody tr'], // TODO
      productFields: {
        sku: { sel: ['td:nth-child(1)'] }, // TODO
        name: { sel: ['td:nth-child(2)'] }, // TODO
        revenue: { sel: ['td:nth-child(3)'] }, // TODO
        units: { sel: ['td:nth-child(4)'] }, // TODO
        returns: { sel: ['td:nth-child(5)'] }, // TODO
      },
    },

    /** Customer chat inside the seller cabinet. */
    chat: {
      // Conversation list (left column in Kaspi's chat).
      conversationItem: ['[data-testid="chat-conversation"]', '.chat-list__item'], // TODO
      conversationFields: {
        id: { sel: ['xpath:.'], attr: 'data-conversation-id' }, // TODO: attribute on the item itself
        customer: { sel: ['[data-testid="chat-customer"]', '.chat-list__name'] }, // TODO
        preview: { sel: ['[data-testid="chat-preview"]', '.chat-list__preview'] }, // TODO
        time: { sel: ['[data-testid="chat-time"]', '.chat-list__time', 'time'] }, // TODO
        unread: { sel: ['[data-testid="chat-unread"]', '.chat-list__badge'], regex: '(\\d+)' }, // TODO
        orderId: { sel: ['[data-testid="chat-order"]'], regex: '(\\d{6,})' }, // TODO (optional)
      },
      // Currently open thread.
      threadRoot: ['[data-testid="chat-thread"]', '.chat-thread'], // TODO
      // REQUIRED for replies: id of the open thread. A reply is sent only when it equals
      // conversationFields.id of the clicked conversation (prevents answering the wrong customer).
      threadId: { sel: ['[data-testid="chat-thread"]'], attr: 'data-conversation-id' }, // TODO
      message: ['[data-testid="chat-message"]', '.chat-thread__message'], // TODO
      messageFields: {
        id: { sel: ['xpath:.'], attr: 'data-message-id' }, // TODO
        text: { sel: ['[data-testid="chat-message-text"]', '.chat-thread__text'] }, // TODO
        time: { sel: ['[data-testid="chat-message-time"]', 'time'] }, // TODO
      },
      // Class/attribute that marks a message as sent BY THE SELLER.
      outgoingMarker: ['.chat-thread__message--outgoing', '[data-direction="out"]'], // TODO
      input: ['[data-testid="chat-input"]', '.chat-composer textarea', '.chat-composer [contenteditable="true"]'], // TODO
      sendButton: ['[data-testid="chat-send"]', '.chat-composer button[type="submit"]'], // TODO
    },

    /** Raw status text → normalized status. Lower-case substrings, RU + KK. */
    statusMap: {
      new: ['новый', 'новые', 'жаңа', 'ожидает упаковки'],
      accepted: ['принят', 'қабылданды'],
      packed: ['упакован', 'қапталды', 'готов к передаче'],
      delivering: ['доставк', 'передан', 'жеткізу'],
      delivered: ['выдан', 'доставлен', 'жеткізілді', 'берілді'],
      cancelled: ['отмен', 'бас тарт', 'тоқтатыл'],
      returned: ['возврат', 'қайтар'],
      refused: ['отказ', 'бас тарту'],
    },
    paymentMap: {
      paid: ['оплачен', 'төленді', 'оплата получена'],
      pending: ['ожида', 'не подтвержд', 'күтілуде', 'расталмаған'],
      failed: ['ошибк', 'отклон', 'не оплачен', 'қате', 'төленбеді'],
    },

    /**
     * Optional: JSON responses the Kaspi page itself loads (captured by
     * content/network-tap.js in the page context). `url` is a regex string;
     * `list` is a dot-path to the array; `fields` map our keys to dot-paths.
     * Leave `url` empty to disable a source.
     */
    network: {
      orders: { url: '', list: 'data', fields: { id: 'code', date: 'creationDate', status: 'status', amount: 'totalPrice', payment: 'paymentStatus', customer: 'customer.name' } }, // TODO
      returns: { url: '', list: 'data', fields: { id: 'orderCode', date: 'date', status: 'status', amount: 'amount', reason: 'reason' } }, // TODO
      refusals: { url: '', list: 'data', fields: { id: 'orderCode', date: 'date', status: 'status', amount: 'amount', reason: 'reason' } }, // TODO
      analytics: { url: '', list: 'days', fields: { date: 'date', revenue: 'revenue', orders: 'orders' } }, // TODO
      chat: { url: '', list: 'conversations', fields: { id: 'id', customer: 'customer.name', preview: 'lastMessage.text', time: 'lastMessage.date', unread: 'unreadCount' } }, // TODO
    },

    /**
     * Official Kaspi Shop API (token per store: cabinet › Настройки › Токен API).
     * Docs: guide.kaspi.kz/partner/ru/shop/api/orders/*. Not a DOM selector, but kept
     * here so endpoints can be patched in the same place.
     */
    api: {
      base: 'https://kaspi.kz/shop/api/v2',
      // Card creation (guide.kaspi.kz/partner/ru/shop/api/goods/q3216–q3222): categories,
      // attributes, attribute values, POST import, import status, import result.
      productsBase: 'https://kaspi.kz/shop/api/products',
      importPollMinutes: 2, // how often pending card uploads are re-checked
      importGiveUpHours: 72,
      // Order states — the list endpoint returns nothing without a state filter.
      states: ['NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE'],
      windowDays: 14, // creationDate range per request
      firstSyncDays: 90, // history loaded the first time a store is connected
      syncDays: 28, // re-read on every later sync (older orders stay cached)
      pageSize: 100, // documented maximum
      concurrency: 3, // parallel requests per store
      entriesPerSync: 300, // order contents (one request each) fetched per sync and store
      // Quick start: the first sync reads orders in progress + the archive of the last few days and
      // shows them at once; older archive is read one window per sync (backfill) up to firstSyncDays.
      quickStartDays: 7,
      quickStartEntries: 30, // order contents on the first sync (the rest come with later syncs)
      requestTimeoutMs: 25000, // one request
      storeSyncMs: 180000, // one store in one sync: a store that hangs does not hold the others
      cabinetOrderUrl: 'https://kaspi.kz/mc/#/orders/{code}', // TODO: link to the order in the cabinet
    },

    /** Human-like pacing for user-triggered bulk actions. */
    timing: {
      actionDelayMs: 1200, // pause between two actions in the same store
      waitTimeoutMs: 10000, // max wait for an element to appear
      navigationTimeoutMs: 20000, // max wait for a store tab to load
    },
  };

  const deepFreeze = (o) => {
    Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v));
    return Object.freeze(o);
  };

  globalThis.KSH_SELECTORS = deepFreeze(SELECTORS);
})();
