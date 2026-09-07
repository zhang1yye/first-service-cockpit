(function () {
  "use strict";

  var RELEASE = "r80-current-site-fixes-20260816-v1";
  var PAGE_SIZE = 12;
  var scheduled = false;
  var expanded = false;

  function canonicalArrears() {
    if (location.pathname === "/arrears") {
      location.replace("/arrears/" + location.search + location.hash);
      return true;
    }
    return false;
  }

  if (canonicalArrears()) return;

  function normalizeArrearsLinks(root) {
    (root || document).querySelectorAll('a[href="/arrears"], a[href^="/arrears?"] , a[href^="/arrears#"]').forEach(function (link) {
      var url = new URL(link.href, location.href);
      url.pathname = "/arrears/";
      link.href = url.pathname + url.search + url.hash;
    });
  }

  function pagerButton(list) {
    var button = list.nextElementSibling;
    if (button && button.classList.contains("aph-r80-ai-pager")) return button;
    button = document.createElement("button");
    button.type = "button";
    button.className = "aph-r80-ai-pager";
    button.addEventListener("click", function () {
      expanded = !expanded;
      updateAiPager();
      if (!expanded) list.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    list.insertAdjacentElement("afterend", button);
    return button;
  }

  function clearPaging(list) {
    list.querySelectorAll(".r56-center-row[data-r80-page-hidden]").forEach(function (row) {
      row.hidden = false;
      row.removeAttribute("data-r80-page-hidden");
    });
    var button = list.nextElementSibling;
    if (button && button.classList.contains("aph-r80-ai-pager")) button.remove();
  }

  function updateAiPager() {
    scheduled = false;
    var list = document.querySelector('[data-r56-ai-center-app] .r56-center-list');
    if (!list) return;
    if (!matchMedia("(max-width: 640px)").matches) {
      clearPaging(list);
      return;
    }

    var rows = Array.from(list.querySelectorAll(".r56-center-row"));
    rows.forEach(function (row) {
      if (row.hasAttribute("data-r80-page-hidden")) {
        row.hidden = false;
        row.removeAttribute("data-r80-page-hidden");
      }
    });
    var available = rows.filter(function (row) {
      return getComputedStyle(row).display !== "none";
    });
    var hiddenCount = Math.max(0, available.length - PAGE_SIZE);
    available.forEach(function (row, index) {
      var shouldHide = !expanded && index >= PAGE_SIZE;
      if (shouldHide) {
        row.hidden = true;
        row.setAttribute("data-r80-page-hidden", "true");
      }
    });

    var button = pagerButton(list);
    if (!hiddenCount && !expanded) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    button.textContent = expanded
      ? "收起至前 " + PAGE_SIZE + " 个服务中心"
      : "显示其余 " + hiddenCount + " 个服务中心";
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      normalizeArrearsLinks(document);
      updateAiPager();
    });
  }

  document.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest("a[href]");
    if (!link) return;
    var url = new URL(link.href, location.href);
    if (url.origin === location.origin && url.pathname === "/arrears") {
      event.preventDefault();
      url.pathname = "/arrears/";
      location.assign(url.pathname + url.search + url.hash);
    }
  }, true);

  document.addEventListener("input", function (event) {
    if (!event.target.closest || !event.target.closest("[data-r56-ai-center-app]")) return;
    expanded = false;
    schedule();
  }, true);
  document.addEventListener("change", function (event) {
    if (!event.target.closest || !event.target.closest("[data-r56-ai-center-app]")) return;
    expanded = false;
    schedule();
  }, true);

  function boot() {
    if (!document.documentElement) {
      setTimeout(boot, 0);
      return;
    }
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    addEventListener("resize", schedule, { passive: true });
    document.documentElement.dataset.r80Release = RELEASE;
    schedule();
  }

  boot();
})();
