// ==UserScript==
// @name         StayInBrowser
// @namespace    local.stay-in-safari
// @version      1.0.0
// @description  Block websites from launching external apps and keep navigation in your browser
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        none
// @compatible   safari
// @compatible   chrome
// @compatible   firefox
// @compatible   edge
// ==/UserScript==

// Changelog
// 1.0.0 - Stable release with stronger navigation isolation and multi-tab optimizations.
// 0.1.5 - Improved navigation handling and reduced foreground/background overhead.

(function () {
  'use strict';

  const CONFIG = {
    enabled: true,
    debug: false,
    forceSameTab: true,
    blockMailto: true,
    blockTelephone: true,
    blockUniversalLinks: true,
    blockProtocolHandlerRegistration: true,
    applySiteCompatibilityHints: true,
    isolateHighRiskNavigation: true,
    showBlockedToast: false,
    allowedSchemes: ['http:', 'https:'],
    allowedHosts: [],
    blockedHosts: [],
  };

  const INSTALL_KEY = Symbol.for('local.stayinbrowser.installed.v1');
  if (window[INSTALL_KEY]) return;
  try {
    Object.defineProperty(window, INSTALL_KEY, { value: true, configurable: false });
  } catch (_) {
    window[INSTALL_KEY] = true;
  }

  const stats = {
    interceptedClicks: 0,
    blockedCustomSchemes: 0,
    interceptedWindowOpen: 0,
    rewrittenWebLinks: 0,
    blockedIframes: 0,
    blockedEmbeds: 0,
    blockedProtocolRegistrations: 0,
    interceptedNavigations: 0,
    blockedAppControls: 0,
    appliedCompatibilityHints: 0,
    isolatedWebViewsOpened: 0,
  };
  const originals = Object.create(null);
  const WEB_EVENTS = new Set(['click', 'auxclick']);
  const IS_TOP_LEVEL = (() => {
    try { return window.top === window; } catch (_) { return false; }
  })();
  const CLICK_SELECTOR = [
    'a[href]', 'area[href]', '[data-url]', '[data-href]', '[data-link]',
    '[data-app-url]', '[data-scheme]', '[onclick]',
  ].join(',');
  const APP_CONTROL_SCAN_SELECTOR = [
    'm-open-app', 'wx-open-launch-app',
    '[class*="open-app"]', '[class*="openapp"]', '[class*="launch-app"]',
    '[class*="call-app"]', '[class*="wake-app"]', '[class*="app-banner"]',
    '[class*="open-in-app"]', '[id*="open-app"]', '[id*="openapp"]',
    '[data-action*="open-app"]', '[data-action*="openapp"]',
  ].join(',');
  const BILI_HOSTS = new Set([
    'bilibili.com', 'www.bilibili.com', 'm.bilibili.com',
    'search.bilibili.com', 'space.bilibili.com', 't.bilibili.com',
    'b23.tv', 'bili2233.cn',
  ]);
  const BILI_HINT_HOSTS = new Set([
    'bilibili.com', 'www.bilibili.com', 'm.bilibili.com',
    'search.bilibili.com', 'space.bilibili.com', 't.bilibili.com',
  ]);
  const BILI_NO_APP_HINT = 'edge_cebianlan';
  const APP_WORD_RE = /(?:^|[-_\s])(open-?app|launch-?app|call-?app|wake-?app|awaken|download-?app|app-?banner|app-?link|open-?in-?app)(?:$|[-_\s])/i;
  const NAVIGATION_SINK_ATTRIBUTES = new Set([
    'href', 'src', 'data', 'action', 'formaction',
  ]);
  const PHONE_SCHEMES = new Set(['tel:', 'sms:', 'facetime:', 'facetime-audio:']);
  const SAFE_SPECIAL = new Set(['about:', 'blob:']);
  let enabled = !!CONFIG.enabled;
  let internalNavigation = false;
  let isolatedWebView = null;

  function log(message, detail) {
    if (!CONFIG.debug) return;
    console.debug('[StayInBrowser] ' + message, Object.assign({
      sourcePage: location.href,
    }, detail || {}));
  }

  function hostMatches(host, rules) {
    host = String(host || '').toLowerCase().replace(/\.$/, '');
    return rules.some((rule) => {
      rule = String(rule || '').toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
      return rule && (host === rule || host.endsWith('.' + rule));
    });
  }

  function parseURL(value, base) {
    if (value instanceof URL) return value;
    if (value == null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    try {
      return new URL(raw, base || document.baseURI || location.href);
    } catch (_) {
      return null;
    }
  }

  function decision(value, source) {
    const raw = value == null ? '' : String(value).trim();
    if (!raw) return { action: 'allow', raw, url: null };

    // Fragment-only navigation is harmless and must keep SPA/page anchors working.
    if (raw[0] === '#') return { action: 'allow', raw, url: parseURL(raw) };

    const url = parseURL(raw);
    if (!url) return { action: 'block', raw, url: null, reason: 'invalid URL' };
    const protocol = url.protocol.toLowerCase();

    if (hostMatches(url.hostname, CONFIG.allowedHosts)) {
      return { action: 'allow', raw, url };
    }
    if (hostMatches(url.hostname, CONFIG.blockedHosts)) {
      return { action: 'block', raw, url, reason: 'blocked host' };
    }
    if (CONFIG.allowedSchemes.map(String).map((s) => s.toLowerCase()).includes(protocol)) {
      return { action: 'web', raw, url, rewritten: normalizeWebURL(url, source) };
    }
    if (protocol === 'mailto:' && !CONFIG.blockMailto) return { action: 'allow', raw, url };
    if (PHONE_SCHEMES.has(protocol) && !CONFIG.blockTelephone) return { action: 'allow', raw, url };

    // about:blank and same-origin blob: are useful to sites, media and downloads. They
    // are allowed only outside external-navigation sinks; data:/javascript: are never
    // sent to window.open, frames, forms or synthetic link clicks by this script.
    if (SAFE_SPECIAL.has(protocol) && source === 'link-default') {
      return { action: 'allow', raw, url };
    }
    return { action: 'block', raw, url, reason: 'custom or unsafe scheme' };
  }

  function normalizeWebURL(input, source) {
    let url;
    try {
      url = new URL(input.href);
    } catch (_) {
      return input;
    }
    if (!CONFIG.blockUniversalLinks) return url;

    const before = url.href;
    const host = url.hostname.toLowerCase();

    // Some sites expose a first-party web-only channel hint. Preserve it on all
    // internal links so server-rendered pages disable their own app-launch UI.
    if (CONFIG.applySiteCompatibilityHints && BILI_HINT_HOSTS.has(host)) {
      url.searchParams.set('bsource', BILI_NO_APP_HINT);
    }

    // Normalize only recognizable Bilibili video paths; keep query and hash intact.
    if ((host === 'm.bilibili.com' || host === 'bilibili.com') &&
        /^\/video\/(?:BV[0-9A-Za-z]+|av\d+)(?:\/|$)/i.test(url.pathname)) {
      url.hostname = 'www.bilibili.com';
      url.protocol = 'https:';
    }

    // Common redirect pages often carry a complete web target as a query value.
    // Extraction is intentionally conservative to avoid changing ordinary links.
    if ((BILI_HOSTS.has(host) || /\/(?:redirect|jump|out|link)(?:\/|$)/i.test(url.pathname))) {
      for (const key of ['url', 'target', 'destination', 'redirect_url']) {
        const nested = url.searchParams.get(key);
        if (!nested) continue;
        const nestedDecision = decision(nested, 'redirect-query');
        if (nestedDecision.action === 'web') {
          url = nestedDecision.rewritten || nestedDecision.url;
          break;
        }
      }
    }

    if (url.href !== before) {
      stats.rewrittenWebLinks++;
      log('rewritten universal link', {
        originalURL: before, rewrittenURL: url.href, source,
      });
    }
    return url;
  }

  function toast(text) {
    if (!CONFIG.showBlockedToast || !document.documentElement) return;
    const el = document.createElement('div');
    el.textContent = text;
    el.setAttribute('style', [
      'position:fixed', 'left:50%', 'bottom:10vh', 'transform:translateX(-50%)',
      'z-index:2147483647', 'padding:9px 14px', 'border-radius:8px',
      'background:rgba(0,0,0,.82)', 'color:#fff', 'font:13px -apple-system,sans-serif',
      'pointer-events:none',
    ].join(';'));
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

  function recordBlock(result, source) {
    const isAppControl = result.kind === 'app-control';
    if (isAppControl) stats.blockedAppControls++;
    else stats.blockedCustomSchemes++;
    log(isAppControl ? 'blocked app-launch control' : 'blocked custom scheme', {
      originalURL: result.raw, rewrittenURL: null, source,
    });
    toast('已阻止打开其他 App');
  }

  function appControlIdentity(el) {
    return [
      el.localName || '', el.id || '',
      typeof el.className === 'string' ? el.className : '',
      el.getAttribute('data-action') || '',
      el.getAttribute('data-testid') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
    ].join(' ');
  }

  function looksLikeAppControl(el) {
    if (!(el instanceof Element)) return false;
    const identity = appControlIdentity(el);
    if (APP_WORD_RE.test(identity)) return true;
    if (el.childElementCount > 6) return false;
    const shortText = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 72);
    const explicitText = /^(?:(?:打开|唤醒|前往|下载|去|进入).{0,10}(?:App|APP|客户端).{0,18}|(?:App|APP|客户端).{0,10}(?:打开|内打开|查看|体验).{0,18}|(?:open|launch|continue|view|watch|download|use).{0,18}(?:in\s+)?(?:the\s+)?app.{0,18})$/i;
    return explicitText.test(shortText);
  }

  function findAppControl(start) {
    let current = start instanceof Element ? start : null;
    for (let depth = 0; current && depth < 8; depth++) {
      if (looksLikeAppControl(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function hardenInitialState(value) {
    if (!value || typeof value !== 'object') return value;
    try {
      if (value.common && typeof value.common === 'object') {
        value.common.noCallApp = true;
        const limits = value.common.serverConfig &&
          value.common.serverConfig.openappDialogConfig;
        if (limits && typeof limits === 'object') {
          for (const key of Object.keys(limits)) limits[key] = 0;
        }
      }
    } catch (_) {}
    return value;
  }

  function installSiteCompatibilityHints() {
    if (!CONFIG.applySiteCompatibilityHints) return;
    const pageURL = parseURL(location.href);
    if (!pageURL || !BILI_HINT_HOSTS.has(pageURL.hostname.toLowerCase())) return;

    try {
      if (pageURL.searchParams.get('bsource') !== BILI_NO_APP_HINT) {
        pageURL.searchParams.set('bsource', BILI_NO_APP_HINT);
        history.replaceState(history.state, document.title, pageURL.href);
        stats.appliedCompatibilityHints++;
      }
    } catch (_) {}

    // The mobile site assigns its server-rendered state after document-start.
    // Intercept that one assignment and turn on the site's own no-call-app flag.
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, '__INITIAL_STATE__');
      if (!descriptor || descriptor.configurable) {
        let initialState = hardenInitialState(window.__INITIAL_STATE__);
        Object.defineProperty(window, '__INITIAL_STATE__', {
          configurable: true,
          enumerable: true,
          get() { return initialState; },
          set(value) {
            initialState = hardenInitialState(value);
            stats.appliedCompatibilityHints++;
          },
        });
      }
    } catch (_) {}
  }

  function stopEvent(event, result, source) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
    stats.interceptedClicks++;
    if (result.action === 'block') recordBlock(result, source);
    log('intercepted click', {
      originalURL: result.raw,
      rewrittenURL: result.rewritten ? result.rewritten.href : null,
      source,
    });
  }

  function nativeNavigate(url, replace) {
    if (!url || internalNavigation) return;
    internalNavigation = true;
    try {
      const fn = replace ? originals.locationReplace : originals.locationAssign;
      if (typeof fn === 'function') fn.call(location, url.href);
      else location.href = url.href;
    } finally {
      // The page normally unloads. Resetting also keeps same-document navigation safe.
      setTimeout(() => { internalNavigation = false; }, 0);
    }
  }

  function shouldOpenIsolatedWebView(url) {
    if (!CONFIG.blockUniversalLinks || !CONFIG.isolateHighRiskNavigation || !url) return false;
    if (!IS_TOP_LEVEL) return false;
    const current = parseURL(location.href);
    if (!current || current.protocol !== 'https:' || url.protocol !== 'https:') return false;
    const currentHost = current.hostname.toLowerCase();
    const targetHost = url.hostname.toLowerCase();
    const isIsolatedTarget =
      (targetHost === 'space.bilibili.com' && /^\/\d+(?:\/|$)/.test(url.pathname)) ||
      (targetHost === 'm.bilibili.com' && /^\/space\/\d+(?:\/|$)/.test(url.pathname));
    return isIsolatedTarget && currentHost !== targetHost && BILI_HOSTS.has(currentHost);
  }

  function closeIsolatedWebView() {
    if (!isolatedWebView) return;
    try { isolatedWebView.remove(); } catch (_) {}
    isolatedWebView = null;
  }

  function openIsolatedWebView(url) {
    if (!shouldOpenIsolatedWebView(url) || !document.documentElement) return false;
    closeIsolatedWebView();

    const overlay = document.createElement('div');
    overlay.id = 'stayinbrowser-isolated-webview';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Isolated web view');
    overlay.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'background:#fff',
      'padding-top:env(safe-area-inset-top)',
    ].join(';'));

    const toolbar = document.createElement('div');
    toolbar.setAttribute('style', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'min-height:44px', 'padding:0 12px', 'flex:0 0 auto',
      'border-bottom:1px solid rgba(0,0,0,.12)', 'background:#fff',
      'color:#111', 'font:14px -apple-system,BlinkMacSystemFont,sans-serif',
    ].join(';'));

    const title = document.createElement('span');
    title.textContent = '网页 / Web';

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭 / Close';
    close.setAttribute('style', [
      'border:0', 'padding:8px', 'background:transparent', 'color:#1677ff',
      'font:14px -apple-system,BlinkMacSystemFont,sans-serif', 'cursor:pointer',
    ].join(';'));
    close.addEventListener('click', closeIsolatedWebView, { capture: true });

    const frame = document.createElement('iframe');
    frame.setAttribute('title', 'Isolated web view');
    frame.setAttribute('sandbox', [
      'allow-downloads', 'allow-forms', 'allow-modals',
      'allow-presentation', 'allow-same-origin', 'allow-scripts',
    ].join(' '));
    frame.setAttribute('allow', 'encrypted-media; fullscreen; picture-in-picture');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.setAttribute('style', 'display:block;width:100%;height:100%;flex:1 1 auto;border:0;background:#fff');
    frame.setAttribute('src', url.href);

    toolbar.appendChild(title);
    toolbar.appendChild(close);
    overlay.appendChild(toolbar);
    overlay.appendChild(frame);
    document.documentElement.appendChild(overlay);
    isolatedWebView = overlay;
    stats.isolatedWebViewsOpened++;
    log('opened navigation in sandboxed web view', {
      originalURL: url.href, rewrittenURL: url.href, source: 'isolated web view',
    });
    return true;
  }

  function navigateWeb(url, replace) {
    if (openIsolatedWebView(url)) return;
    nativeNavigate(url, replace);
  }

  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isolatedWebView) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeIsolatedWebView();
    }
  }, { capture: true, passive: false });

  function appControlCandidate(el) {
    return {
      el,
      result: {
        action: 'block',
        kind: 'app-control',
        raw: (el.textContent || appControlIdentity(el)).trim().slice(0, 120),
        url: null,
        reason: 'app-launch control',
      },
    };
  }

  function candidateFromClickable(el) {
    const values = [];
    if (el.matches('a[href],area[href]')) values.push(el.getAttribute('href'));
    for (const name of ['data-app-url', 'data-scheme', 'data-url', 'data-href', 'data-link']) {
      if (el.hasAttribute(name)) values.push(el.getAttribute(name));
    }
    // Inline handlers are inspected only for literal scheme/URL strings.
    const onclick = el.getAttribute('onclick');
    if (onclick) {
      const matches = onclick.match(/(?:https?:\/\/|[a-z][a-z0-9+.-]*:)[^'"\s)]+/ig);
      if (matches) values.push(...matches);
    }
    for (const value of values) {
      const result = decision(value, 'user-event');
      if (result.action === 'block') return { el, result };
    }
    const primary = values.find((v) => v != null && String(v).trim());
    return primary ? { el, result: decision(primary, 'user-event') } : null;
  }

  function candidateFromElement(start) {
    if (!(start instanceof Element)) return null;
    const appControl = findAppControl(start);
    if (appControl) return appControlCandidate(appControl);
    const el = start.closest(CLICK_SELECTOR);
    return el ? candidateFromClickable(el) : null;
  }

  function candidateFromEvent(event) {
    if (typeof event.composedPath === 'function') {
      let clickable = null;
      for (const item of event.composedPath()) {
        if (!(item instanceof Element)) continue;
        if (looksLikeAppControl(item)) return appControlCandidate(item);
        if (!clickable && item.matches(CLICK_SELECTOR)) clickable = item;
      }
      if (clickable) return candidateFromClickable(clickable);
    }
    return candidateFromElement(event.target);
  }

  function onUserEvent(event) {
    if (!enabled || event.defaultPrevented) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    const found = candidateFromEvent(event);
    if (!found) return;
    const { el, result } = found;

    // touchend only blocks confirmed unsafe targets; click performs web navigation.
    if (!WEB_EVENTS.has(event.type)) {
      if (result.action === 'block') stopEvent(event, result, event.type);
      return;
    }
    if (result.action === 'block') {
      stopEvent(event, result, event.type);
      return;
    }
    if (result.action !== 'web') return;

    const url = result.rewritten || result.url;
    if (!url) return;
    if (CONFIG.forceSameTab) {
      stopEvent(event, result, event.type);
      if (el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement) {
        el.removeAttribute('target');
        el.removeAttribute('download');
      }
      navigateWeb(url, false);
    }
  }

  for (const type of [
    'click', 'auxclick', 'touchend', 'keydown',
  ]) {
    window.addEventListener(type, onUserEvent, { capture: true, passive: false });
  }

  function hookWindowOpen() {
    originals.windowOpen = window.open;
    if (typeof originals.windowOpen !== 'function') return;
    const wrappedOpen = function (url, target, features) {
      if (!enabled || url == null || url === '') {
        return originals.windowOpen.apply(this, arguments);
      }
      const result = decision(url, 'window.open');
      stats.interceptedWindowOpen++;
      log('intercepted window.open', {
        originalURL: result.raw,
        rewrittenURL: result.rewritten ? result.rewritten.href : null,
        source: 'window.open',
      });
      if (result.action === 'block') {
        recordBlock(result, 'window.open');
        return null;
      }
      if (result.action === 'web' && CONFIG.forceSameTab) {
        navigateWeb(result.rewritten || result.url, false);
        return window;
      }
      return originals.windowOpen.call(this, url, target, features);
    };
    try { window.open = wrappedOpen; } catch (_) {}
  }

  function hookLocationMethods() {
    // WebKit normally exposes Location.href and window.location as non-configurable
    // platform properties. Direct assignments (location.href=, window.location=,
    // top.location=) therefore cannot be reliably replaced by a Userscript.
    // Capturing events, sanitizing DOM sinks and pagehide/visibility defenses cover
    // the practical cases; assign()/replace() are wrapped only when WebKit permits it.
    try {
      originals.locationAssign = location.assign;
      originals.locationReplace = location.replace;
    } catch (_) {}
    for (const name of ['assign', 'replace']) {
      const original = originals['location' + (name === 'assign' ? 'Assign' : 'Replace')];
      if (typeof original !== 'function') continue;
      const wrapped = function (url) {
        if (!enabled || internalNavigation) return original.call(this, url);
        const result = decision(url, 'location.' + name);
        if (result.action === 'block') {
          recordBlock(result, 'location.' + name);
          return;
        }
        const destination = result.rewritten || result.url;
        if (result.action === 'web' && openIsolatedWebView(destination)) return;
        return original.call(this, (destination || {}).href || url);
      };
      try { location[name] = wrapped; } catch (_) {}
      try {
        const proto = Object.getPrototypeOf(location);
        if (proto && Object.prototype.hasOwnProperty.call(proto, name)) proto[name] = wrapped;
      } catch (_) {}
    }
  }

  function hookHistory() {
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      originals['history_' + name] = original;
      if (typeof original !== 'function') continue;
      try {
        history[name] = function (state, title, url) {
          if (!enabled || url == null) return original.apply(this, arguments);
          const result = decision(url, 'history.' + name);
          if (result.action === 'block') {
            recordBlock(result, 'history.' + name);
            return;
          }
          return original.call(this, state, title, (result.rewritten || result.url || {}).href || url);
        };
      } catch (_) {}
    }
  }

  function hookNavigationAPI() {
    const navigation = window.navigation;
    if (!navigation || typeof navigation.addEventListener !== 'function') return;
    navigation.addEventListener('navigate', function (event) {
      if (!enabled || internalNavigation || !event.destination) return;
      const result = decision(event.destination.url, 'Navigation API');
      if (result.action === 'block') {
        if (event.cancelable) event.preventDefault();
        stats.interceptedNavigations++;
        recordBlock(result, 'Navigation API');
        return;
      }
      const destination = result.rewritten || result.url;
      if (result.action === 'web' && shouldOpenIsolatedWebView(destination) && event.cancelable) {
        event.preventDefault();
        stats.interceptedNavigations++;
        openIsolatedWebView(destination);
      }
    }, { capture: true });
  }

  function hookProtocolRegistration() {
    if (!navigator || typeof navigator.registerProtocolHandler !== 'function') return;
    originals.registerProtocolHandler = navigator.registerProtocolHandler;
    try {
      navigator.registerProtocolHandler = function (scheme, url) {
        if (enabled && CONFIG.blockProtocolHandlerRegistration) {
          const result = {
            action: 'block',
            raw: String(scheme || '') + ' -> ' + String(url || ''),
          };
          stats.blockedProtocolRegistrations++;
          recordBlock(result, 'navigator.registerProtocolHandler');
          return;
        }
        return originals.registerProtocolHandler.apply(this, arguments);
      };
    } catch (_) {}
  }

  function formDestination(form, submitter) {
    if (submitter && typeof submitter.getAttribute === 'function') {
      const override = submitter.getAttribute('formaction');
      if (override) return override;
    }
    return form.getAttribute('action') || location.href;
  }

  function hookElementMethods() {
    originals.anchorClick = HTMLAnchorElement.prototype.click;
    try {
      HTMLAnchorElement.prototype.click = function () {
        if (!enabled) return originals.anchorClick.call(this);
        const result = decision(this.getAttribute('href') || this.href, 'anchor.click');
        if (result.action === 'block') {
          recordBlock(result, 'anchor.click');
          return;
        }
        if (result.action === 'web' && CONFIG.forceSameTab) {
          this.removeAttribute('target');
          navigateWeb(result.rewritten || result.url, false);
          return;
        }
        return originals.anchorClick.call(this);
      };
    } catch (_) {}

    for (const name of ['submit', 'requestSubmit']) {
      const original = HTMLFormElement.prototype[name];
      originals['form_' + name] = original;
      if (typeof original !== 'function') continue;
      try {
        HTMLFormElement.prototype[name] = function () {
          if (enabled) {
            const submitter = name === 'requestSubmit' ? arguments[0] : null;
            const result = decision(formDestination(this, submitter), 'form.' + name);
            if (result.action === 'block') {
              recordBlock(result, 'form.' + name);
              return;
            }
            if (CONFIG.forceSameTab) this.removeAttribute('target');
          }
          return original.apply(this, arguments);
        };
      } catch (_) {}
    }

    // submit events also cover user submission and requestSubmit implementations.
    window.addEventListener('submit', function (event) {
      if (!enabled || !(event.target instanceof HTMLFormElement)) return;
      const form = event.target;
      const result = decision(formDestination(form, event.submitter), 'form submit event');
      if (result.action === 'block') {
        event.preventDefault();
        event.stopImmediatePropagation();
        recordBlock(result, 'form submit event');
      } else if (CONFIG.forceSameTab) {
        form.removeAttribute('target');
      }
    }, { capture: true });
  }

  function hookNavigationSinks() {
    // MutationObserver is asynchronous. These wrappers reject dangerous values at
    // assignment time, before a newly-created iframe/anchor/form can navigate.
    originals.setAttribute = Element.prototype.setAttribute;
    try {
      Element.prototype.setAttribute = function (name, value) {
        const lower = String(name).toLowerCase();
        if (!enabled || !NAVIGATION_SINK_ATTRIBUTES.has(lower)) {
          return originals.setAttribute.call(this, name, value);
        }
        const isSink =
          ((this instanceof HTMLAnchorElement || this instanceof HTMLAreaElement) && lower === 'href') ||
          (this instanceof HTMLIFrameElement && lower === 'src') ||
          (this instanceof HTMLFormElement && lower === 'action') ||
          ((this instanceof HTMLButtonElement || this instanceof HTMLInputElement) &&
            lower === 'formaction') ||
          (this instanceof HTMLObjectElement && lower === 'data') ||
          (this instanceof HTMLEmbedElement && lower === 'src');
        if (isSink) {
          const result = decision(value, 'setAttribute ' + lower);
          if (result.action === 'block') {
            if (this instanceof HTMLIFrameElement) stats.blockedIframes++;
            if (this instanceof HTMLObjectElement || this instanceof HTMLEmbedElement) {
              stats.blockedEmbeds++;
            }
            recordBlock(result, 'setAttribute ' + lower);
            return;
          }
          if (result.action === 'web') value = (result.rewritten || result.url).href;
        }
        return originals.setAttribute.call(this, name, value);
      };
    } catch (_) {}

    const sinks = [
      [HTMLAnchorElement.prototype, 'href', 'anchor.href'],
      [HTMLAreaElement.prototype, 'href', 'area.href'],
      [HTMLIFrameElement.prototype, 'src', 'iframe.src'],
      [HTMLFormElement.prototype, 'action', 'form.action'],
      [HTMLButtonElement.prototype, 'formAction', 'button.formAction'],
      [HTMLInputElement.prototype, 'formAction', 'input.formAction'],
      [HTMLObjectElement.prototype, 'data', 'object.data'],
      [HTMLEmbedElement.prototype, 'src', 'embed.src'],
    ];
    for (const [proto, property, source] of sinks) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(proto, property);
        if (!descriptor || typeof descriptor.set !== 'function' ||
            typeof descriptor.get !== 'function' || descriptor.configurable === false) continue;
        Object.defineProperty(proto, property, Object.assign({}, descriptor, {
          get: descriptor.get,
          set(value) {
            if (enabled) {
              const result = decision(value, source);
              if (result.action === 'block') {
                if (this instanceof HTMLIFrameElement) stats.blockedIframes++;
                if (this instanceof HTMLObjectElement || this instanceof HTMLEmbedElement) {
                  stats.blockedEmbeds++;
                }
                recordBlock(result, source);
                return;
              }
              if (result.action === 'web') value = (result.rewritten || result.url).href;
            }
            descriptor.set.call(this, value);
          },
        }));
      } catch (_) {
        // Some WebKit builds expose non-configurable native descriptors.
      }
    }
  }

  function sanitizeElement(el) {
    if (!enabled || !(el instanceof Element)) return;

    if (el.matches('a[href],area[href]')) {
      const raw = el.getAttribute('href');
      const result = decision(raw, 'DOM link');
      if (result.action === 'block') {
        el.removeAttribute('href');
        el.setAttribute('data-stayinbrowser-blocked-href', raw || '');
        recordBlock(result, 'DOM link');
      } else if (result.action === 'web') {
        const url = result.rewritten || result.url;
        if (url && url.href !== el.href) el.setAttribute('href', url.href);
        if (CONFIG.forceSameTab) el.removeAttribute('target');
      }
    } else if (el.matches('iframe[src]')) {
      const raw = el.getAttribute('src');
      const result = decision(raw, 'iframe src');
      if (result.action === 'block') {
        el.removeAttribute('src');
        el.setAttribute('data-stayinbrowser-blocked-src', raw || '');
        stats.blockedIframes++;
        recordBlock(result, 'iframe src');
      }
    } else if (el.matches('form[action]')) {
      const raw = el.getAttribute('action');
      const result = decision(raw, 'form action');
      if (result.action === 'block') {
        el.removeAttribute('action');
        el.setAttribute('data-stayinbrowser-blocked-action', raw || '');
        recordBlock(result, 'form action');
      } else if (CONFIG.forceSameTab) {
        el.removeAttribute('target');
      }
    } else if (el.matches('button[formaction],input[formaction]')) {
      const raw = el.getAttribute('formaction');
      const result = decision(raw, 'submitter formaction');
      if (result.action === 'block') {
        el.removeAttribute('formaction');
        el.setAttribute('data-stayinbrowser-blocked-formaction', raw || '');
        recordBlock(result, 'submitter formaction');
      }
    } else if (el.matches('object[data],embed[src]')) {
      const attribute = el.matches('object[data]') ? 'data' : 'src';
      const raw = el.getAttribute(attribute);
      const result = decision(raw, el.localName + ' ' + attribute);
      if (result.action === 'block') {
        el.removeAttribute(attribute);
        el.setAttribute('data-stayinbrowser-blocked-' + attribute, raw || '');
        stats.blockedEmbeds++;
        recordBlock(result, el.localName + ' ' + attribute);
      }
    } else if (el.matches('meta[http-equiv]') &&
               /^refresh$/i.test(el.getAttribute('http-equiv') || '')) {
      const content = el.getAttribute('content') || '';
      const match = content.match(/url\s*=\s*(['"]?)(.*?)\1\s*$/i);
      if (match) {
        const result = decision(match[2], 'meta refresh');
        if (result.action === 'block') {
          el.remove();
          recordBlock(result, 'meta refresh');
        }
      }
    }

    if (el instanceof HTMLIFrameElement) attachFrame(el);
    hideObviousAppControl(el);
  }

  function sanitizeTree(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    if (root instanceof Element) sanitizeElement(root);
    const matches = root.querySelectorAll(
      'a[href],area[href],iframe[src],iframe,form[action],button[formaction],input[formaction],object[data],embed[src],meta[http-equiv],' + APP_CONTROL_SCAN_SELECTOR
    );
    for (const el of matches) sanitizeElement(el);
  }

  function injectFrame(frame) {
    if (!enabled) return;
    try {
      const child = frame.contentWindow;
      if (!child || child === window || child[INSTALL_KEY]) return;
      // Same-origin frames normally execute this @match script themselves. For
      // srcdoc/about:blank frames, best-effort event protection is installed here.
      child.addEventListener('click', onUserEvent, { capture: true, passive: false });
      child.addEventListener('auxclick', onUserEvent, { capture: true, passive: false });
      sanitizeTree(frame.contentDocument && frame.contentDocument.documentElement);
    } catch (_) {
      // Cross-origin frame: access is intentionally ignored.
    }
  }

  function attachFrame(frame) {
    if (frame.dataset.stayinbrowserObserved) return;
    frame.dataset.stayinbrowserObserved = '1';
    frame.addEventListener('load', () => injectFrame(frame), { capture: true });
    injectFrame(frame);
  }

  function hideObviousAppControl(el) {
    if (looksLikeAppControl(el)) {
      el.setAttribute('data-stayinbrowser-app-control', 'hidden');
    }
  }

  function installStyle() {
    const style = document.createElement('style');
    style.id = 'stayinbrowser-style';
    style.textContent =
      '[data-stayinbrowser-app-control="hidden"]{display:none!important}';
    (document.head || document.documentElement).appendChild(style);
  }

  const observedRoots = new WeakSet();

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return null;
    observedRoots.add(root);
    const observer = new MutationObserver((records) => {
      if (!enabled || document.hidden) return;
      for (const record of records) {
        if (record.type === 'attributes') {
          sanitizeElement(record.target);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) sanitizeTree(node);
        }
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'href', 'src', 'data', 'action', 'formaction',
        'target', 'content', 'http-equiv',
      ],
    });
    return observer;
  }

  function hookShadowDOM() {
    originals.attachShadow = Element.prototype.attachShadow;
    if (typeof originals.attachShadow !== 'function') return;
    try {
      Element.prototype.attachShadow = function () {
        const root = originals.attachShadow.apply(this, arguments);
        if (enabled) {
          sanitizeTree(root);
          observeRoot(root);
        }
        return root;
      };
    } catch (_) {}
  }

  installSiteCompatibilityHints();
  hookWindowOpen();
  hookLocationMethods();
  hookHistory();
  hookNavigationAPI();
  hookProtocolRegistration();
  hookElementMethods();
  if (IS_TOP_LEVEL) {
    hookNavigationSinks();
    hookShadowDOM();
  }

  const startDOMProtection = () => {
    if (!IS_TOP_LEVEL || !document.documentElement) return;
    installStyle();
    sanitizeTree(document.documentElement);
    observeRoot(document);
  };
  if (IS_TOP_LEVEL) {
    if (document.documentElement) startDOMProtection();
    else document.addEventListener('readystatechange', startDOMProtection, { once: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) sanitizeTree(document.documentElement);
    });
  }

  const diagnostic = Object.freeze({
    getStats() { return Object.assign({}, stats, { enabled }); },
    resetStats() {
      for (const key of Object.keys(stats)) stats[key] = 0;
      return this.getStats();
    },
    enable() { enabled = true; return true; },
    disable() { enabled = false; return false; },
  });
  for (const name of ['StayInBrowser']) {
    try {
      Object.defineProperty(window, name, {
        value: diagnostic, writable: false, configurable: false, enumerable: false,
      });
    } catch (_) {}
  }
})();
