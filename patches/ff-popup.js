// Chrome host behavior the popup relies on that Firefox lacks. Values are
// Chrome's on Windows.
(() => {
  const root = document.getElementById("app-container");
  const html = document.documentElement;

  let isActionPopup = false;
  try {
    isActionPopup = chrome.extension.getViews({ type: "popup" }).includes(window);
  } catch {}

  // Chrome's extension-page font follows the browser UI language
  // (IDS_WEB_FONT_FAMILY); ff-popup.css holds the default.
  const UI_FONTS = {
    th: "Tahoma, sans-serif",
    bn: "Vrinda",
    ml: '"Segoe UI", Arial, AnjaliOldLipi, Rachana, Kartika',
    ja: '"Segoe UI", Arial, Meiryo, sans-serif',
    ko: '"Segoe UI", Arial, "Malgun Gothic", Gulim, sans-serif',
    "zh-CN": '"Segoe UI", Arial, "Microsoft Yahei", sans-serif',
    "zh-TW": '"Segoe UI", Arial, "Microsoft Jhenghei", sans-serif',
  };
  const uiLanguage = chrome.i18n.getUILanguage();
  const uiFont = UI_FONTS[uiLanguage] || UI_FONTS[uiLanguage.split("-")[0]];
  if (uiFont) document.body.style.fontFamily = uiFont;

  // Chrome sizes an action popup to the document's scroll height, so content
  // overflowing a fixed-height box stays visible. Firefox uses the root
  // element's preferred size and clips the overflow, which hides the popup's
  // "Songs" bar and library list (they sit below a 200px container). Grow the
  // root, not <body>: <body> is the boundary of the popup's floating menus.
  let frame = 0;
  const sync = () => {
    frame = 0;
    html.style.minHeight = `${root.scrollHeight}px`;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(sync);
  };

  // `line-height: normal` for Arial: Blink rounds ascent, descent and line
  // gap to device pixels separately, Gecko differently, so button text comes
  // out up to 1px taller in Firefox. Apply Blink's value to button text that
  // Arial renders itself (fallback fonts for other scripts have their own
  // metrics). ff-popup.css uses it with zero specificity, so line heights
  // the popup sets itself still win.
  const ARIAL = { ascent: 1854, descent: 434, lineGap: 67, unitsPerEm: 2048 };
  const ARIAL_TEXT = /^[\s -ɏͰ-ϿЀ-ӿ -⁯₠-⃏]*$/;
  const LH_MARK = "data-ff-arial-lh";
  const arialLineHeight = (fontPx) => {
    const dpr = window.devicePixelRatio || 1;
    const scale = (fontPx * dpr) / ARIAL.unitsPerEm;
    const devicePx = Math.round(ARIAL.ascent * scale) + Math.round(ARIAL.descent * scale) + Math.round(ARIAL.lineGap * scale);
    return `${devicePx / dpr}px`;
  };
  const syncButtonLineHeights = () => {
    for (const el of document.body.querySelectorAll(`[${LH_MARK}]`)) {
      if (!el.closest("button") || !ARIAL_TEXT.test(el.closest("button").textContent)) {
        el.removeAttribute(LH_MARK);
        el.style.removeProperty("--ff-arial-lh");
      }
    }
    for (const button of document.body.querySelectorAll("button")) {
      if (!ARIAL_TEXT.test(button.textContent)) continue;
      for (const el of [button, ...button.querySelectorAll("*")]) {
        const style = getComputedStyle(el);
        if (!style.fontFamily.startsWith("Arial")) continue;
        // Only replace `normal`, not a line height set on or inherited from
        // the popup's own CSS. A child that merely inherits its marked
        // parent's value has `normal` in Chrome as well.
        const parent = el.parentElement;
        const inheritsMark =
          el !== button && parent.hasAttribute(LH_MARK) && style.lineHeight === getComputedStyle(parent).lineHeight;
        if (!el.hasAttribute(LH_MARK) && style.lineHeight !== "normal" && !inheritsMark) continue;
        el.style.setProperty("--ff-arial-lh", arialLineHeight(parseFloat(style.fontSize)));
        el.setAttribute(LH_MARK, "");
      }
    }
  };
  const onDprChange = () => {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        syncButtonLineHeights();
        onDprChange();
      },
      { once: true },
    );
  };

  // Chrome makes a scroller a Tab stop only while it has no focusable
  // content; Gecko always does. The library list is the popup's only
  // scroller that can contain focusable controls (a hovered row's buttons).
  const LIBRARY_LIST = ".RLHtwz_RlwPoJIR5A33T";
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const SKIP_MARK = "data-ff-scroller-skip";
  const syncLibraryTabStop = () => {
    for (const list of root.querySelectorAll(LIBRARY_LIST)) {
      const hasFocusable = !!list.querySelector(FOCUSABLE);
      if (hasFocusable && !list.hasAttribute("tabindex")) {
        list.setAttribute("tabindex", "-1");
        list.setAttribute(SKIP_MARK, "");
      } else if (!hasFocusable && list.hasAttribute(SKIP_MARK)) {
        list.removeAttribute("tabindex");
        list.removeAttribute(SKIP_MARK);
      }
    }
  };

  if (root) {
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    // The popup's floating menus are rendered outside #app-container.
    new MutationObserver((records) => {
      // Ignore the observer's own attribute writes.
      if (records.some((r) => r.type !== "attributes" || (r.attributeName !== LH_MARK && r.attributeName !== "style"))) {
        syncButtonLineHeights();
        syncLibraryTabStop();
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    new ResizeObserver(schedule).observe(root);
    // Images (cover art) change heights without a DOM mutation.
    document.addEventListener("load", schedule, true);
    schedule();
    syncButtonLineHeights();
    syncLibraryTabStop();
    onDprChange();

    // A tabindex of -1 makes the list mouse-focusable in Gecko; a click inside
    // it must not leave (or keep) a keyboard ring on the whole list.
    document.addEventListener(
      "mousedown",
      (e) => {
        const el = document.activeElement;
        if (el && el.matches(LIBRARY_LIST) && e.target !== el && el.contains(e.target)) el.blur();
      },
      true,
    );
  }

  if (isActionPopup) {
    // The popup opens its links from a timer after the click. Chrome then
    // ignores the click's modifier keys and always opens a foreground tab
    // next to the active tab of the popup's window (that tab switch destroys
    // the popup); Firefox carries Ctrl/Shift over (background tab, new window)
    // and keeps the popup open on top. The Rate button opens its page
    // synchronously in Chrome, so modifiers do apply there: build.py routes
    // it to the native window.open.
    globalThis.ffNativeOpen = window.open.bind(window);
    window.open = (url) => {
      const href = url === undefined || url === null || url === "" ? "about:blank" : new URL(String(url), location.href).href;
      chrome.windows
        .getCurrent()
        .then(async (win) => {
          const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
          await chrome.tabs.create({
            url: href,
            active: true,
            windowId: win.id,
            ...(active ? { index: active.index + 1, openerTabId: active.id } : {}),
          });
        })
        .catch(() => {});
      return null;
    };
    chrome.windows
      .getCurrent()
      .then(({ id }) => {
        chrome.tabs.onActivated.addListener(({ windowId }) => {
          if (windowId === id) window.close();
        });
      })
      .catch(() => {});
  }

  // Chrome makes a mouse-focused control :focus-visible on any key press
  // without Ctrl/Alt/Meta; Gecko keeps it hidden. focus() on the already
  // focused element is a no-op in Gecko, hence the blur.
  let refocusing = false;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const el = document.activeElement;
      if (!el || el === document.body || el.matches(LIBRARY_LIST) || el.matches(":focus-visible")) return;
      refocusing = true;
      try {
        el.blur();
        el.focus({ focusVisible: true, preventScroll: true });
      } finally {
        refocusing = false;
      }
    },
    true,
  );

  // Chrome scrolls a keyboard-focused, partly clipped element fully into view
  // with the nearest edge (but not one that only becomes :focus-visible
  // through a key press). Gecko centers a barely visible target before
  // focusin, so undo its scroll first.
  let scrollSnapshot = [];
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Tab") return;
      scrollSnapshot = [];
      for (const el of document.body.querySelectorAll("*")) {
        if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
          scrollSnapshot.push([el, el.scrollTop, el.scrollLeft]);
        }
      }
    },
    true,
  );
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (refocusing || !(el instanceof Element) || !el.matches(":focus-visible")) return;
    // Blink centers a target that is entirely outside its scroller and only
    // brings a partly visible one into view.
    const scrollers = scrollSnapshot.filter(([scroller]) => scroller.isConnected && scroller.contains(el));
    for (const [scroller, top, left] of scrollers) {
      scroller.scrollTop = top;
      scroller.scrollLeft = left;
    }
    const box = el.getBoundingClientRect();
    const hidden = scrollers.some(([scroller]) => {
      const view = scroller.getBoundingClientRect();
      return box.bottom <= view.top || box.top >= view.bottom || box.right <= view.left || box.left >= view.right;
    });
    scrollSnapshot = [];
    el.scrollIntoView({ block: hidden ? "center" : "nearest", inline: hidden ? "center" : "nearest" });
  });

  // Chrome dispatches a click whose press and release happened on different
  // elements to their common ancestor: dragging off a library row does not
  // open it, dragging between two parts of a row does. Gecko targets the
  // pressed element.
  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted || e.detail === 0 || !(e.target instanceof Element)) return;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (hit && e.target.contains(hit)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      let common = hit ? e.target : null;
      while (common && !common.contains(hit)) common = common.parentElement;
      if (!common || common === document.documentElement) return;
      common.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          detail: e.detail,
          button: e.button,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
        }),
      );
    },
    true,
  );
})();
