// "Picked 4 U": reads listing IDs from the Airbnb search page plus the other result pages linked under it
// (fetched in the background), asks the backend for matches, and draws one row between the 2nd and 3rd results. Never changes or removes Airbnb's own nodes.
(() => {
  const CARD = '[itemprop="itemListElement"]';
  const ROOM = /\/rooms\/(\d+)/;

  let settings = { enabled: true, preference: "", collapsed: false };
  let host = null, root = null;
  let lastIds = "", lastResp = null, seq = 0;
  const session = crypto.randomUUID();
  // After the extension is reloaded, a script left in an open tab loses chrome.runtime ("orphaned").
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  document.querySelectorAll("#tywl-host").forEach((n) => n.remove()); // row left behind by an orphaned copy

  // ---------- read the page ----------
  function readCards() {
    const out = new Map(); // id (string, never a number: IDs exceed 2^53) -> card element
    let cards = [...document.querySelectorAll(CARD)];
    if (!cards.length) cards = [...document.querySelectorAll('a[href*="/rooms/"]')];
    for (const c of cards) {
      if (host && host.contains(c)) continue;
      const url = c.querySelector?.('meta[itemprop="url"]')?.content || c.getAttribute?.("href") ||
        c.querySelector?.('a[href*="/rooms/"]')?.getAttribute("href") || "";
      const m = url.match(ROOM);
      if (m && !out.has(m[1])) out.set(m[1], c);
    }
    return out;
  }

  function cardInfo(card) {
    const url = card.querySelector('meta[itemprop="url"]')?.content || card.getAttribute("href") || "";
    const spans = [...card.querySelectorAll("span")].map((s) => s.textContent.trim());
    const priceRow = card.querySelector('[data-testid="price-availability-row"]');
    const lines = priceRow ? priceRow.innerText.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    // e.g. "$224 USD for 1 night, originally $368 USD" -> keep the part before the comma; no amount -> no price
    const money = /[$€£¥]\s?\d|\d[\d,.]*\s?(USD|EUR|GBP)\b/;
    const priceLine = lines.find((l) => /for \d+ nights?/.test(l) && money.test(l)) || "";
    return {
      href: url.startsWith("http") ? url : new URL(url, location.origin).href,
      img: card.querySelector("img")?.src || "",
      name: card.querySelector('meta[itemprop="name"]')?.content ||
        card.querySelector('[data-testid="listing-card-name"]')?.textContent || "",
      type: card.querySelector('[data-testid="listing-card-title"]')?.textContent || "",
      rating: spans.find((t) => /^\d\.\d+ \(\d+\)$/.test(t) || t === "New") || "",
      price: (priceLine || "").split(",")[0],
    };
  }

  // ---------- other result pages ----------
  // Every pagination link shown under the results (ascending), skipping the "Last page" jump unless it is
  // next to the visible window. Each page's HTML embeds Airbnb's own results JSON (data-deferred-state-0),
  // so we read ids + card info from it without opening the page.
  const PER_PAGE = 18;
  const pageCache = new Map(); // search + page -> Promise<Map id -> info>
  let extraInfo = new Map();   // listings from the other pages used by the current request

  function currentPage() {
    try {
      const c = new URL(location.href).searchParams.get("cursor");
      return c ? Math.floor(JSON.parse(atob(c)).items_offset / PER_PAGE) + 1 : 1;
    } catch { return 1; }
  }

  function otherPageLinks() {
    const cur = currentPage(), pages = new Map();
    let last = null;
    for (const a of document.querySelectorAll("nav a[aria-label]")) {
      const label = a.getAttribute("aria-label");
      const n = +(label.match(/\bpage (\d+)/i)?.[1] || 0); // "Page 2 of 15", "Last page, page 15"
      if (!n || n === cur) continue;
      if (/^last/i.test(label)) last = { n, href: a.href };
      else pages.set(n, a.href);
    }
    if (last && Math.max(cur, ...pages.keys()) >= last.n - 1) pages.set(last.n, last.href);
    return [...pages].sort((a, b) => a[0] - b[0]);
  }

  function pageKey(href, n) {
    const u = new URL(href);
    for (const k of [...u.searchParams.keys()])
      if (/^(cursor|ref_|federated|pagination|search_type|source)/.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return u.pathname + "?" + u.searchParams + "#" + n;
  }

  function roomHref(id) {
    const here = new URL(location.href).searchParams, u = new URL("/rooms/" + id, location.origin);
    for (const [from, to] of [["checkin", "check_in"], ["checkout", "check_out"], ["adults", "adults"], ["children", "children"]])
      if (here.get(from)) u.searchParams.set(to, here.get(from));
    return u.href;
  }

  function findKey(o, key, depth = 0) {
    if (!o || typeof o !== "object" || depth > 12) return null;
    if (key in o) return o[key];
    for (const v of Object.values(o)) { const r = findKey(v, key, depth + 1); if (r) return r; }
    return null;
  }

  async function fetchPage(href, n) {
    const html = await (await fetch(href, { credentials: "include", signal: AbortSignal.timeout(8000) })).text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const results = findKey(JSON.parse(doc.getElementById("data-deferred-state-0").textContent), "searchResults") || [];
    const out = new Map();
    for (const r of results) {
      const id = r.demandStayListing?.id && atob(r.demandStayListing.id).split(":")[1];
      if (!id || !/^\d+$/.test(id)) continue;
      const pic = r.contextualPictures?.[0]?.picture;
      out.set(id, {
        href: roomHref(id), img: pic ? pic + "?im_w=720" : "", page: n,
        name: r.subtitle || r.nameLocalized?.localizedStringWithTranslationPreference || "",
        type: r.title || "", rating: r.avgRatingLocalized || "",
        price: (r.structuredDisplayPrice?.primaryLine?.accessibilityLabel || "").split(",")[0],
      });
    }
    return out;
  }

  async function otherPages(skip) {
    const maps = await Promise.all(otherPageLinks().map(([n, href]) => {
      const key = pageKey(href, n);
      if (!pageCache.has(key))
        pageCache.set(key, fetchPage(href, n).catch((e) => { pageCache.delete(key); console.debug("[tywl] page", n, e); return new Map(); }));
      return pageCache.get(key);
    }));
    const all = new Map();
    for (const m of maps) for (const [id, info] of m) if (!skip.has(id) && !all.has(id)) all.set(id, info);
    return all;
  }

  // The results grid = lowest common ancestor of the first two cards.
  function placement(cards) {
    const list = [...cards.values()];
    if (list.length < 3) return null;
    let grid = list[0].parentElement;
    while (grid && !grid.contains(list[1])) grid = grid.parentElement;
    if (!grid || getComputedStyle(grid).display !== "grid") return null;
    let child = list[1];
    while (child.parentElement !== grid) child = child.parentElement;
    return { grid, after: child };
  }

  // ---------- host + shadow DOM ----------
  function ensureHost(cards) {
    const p = placement(cards);
    if (!p) return false;
    if (!host) {
      host = document.createElement("div");
      host.id = "tywl-host";
      host.style.gridColumn = "1 / -1";
      root = host.attachShadow({ mode: "open" });
    }
    if (host.parentElement !== p.grid || host.previousElementSibling !== p.after) p.after.after(host);
    return true;
  }

  function removeHost() {
    host?.remove();
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const EASE = "cubic-bezier(.2,.8,.2,1)";

  const STYLE = `
    :host { all: initial; display: block; position: relative; }
    * { box-sizing: border-box; }
    /* wrap = 2px frame. While loading, a rotating Airbnb-pink glow runs around it. */
    .wrap { position: relative; padding: 2px; border-radius: 18px; overflow: hidden; isolation: isolate; }
    .wrap::before { content: ""; position: absolute; inset: -150%; z-index: -1; opacity: 0;
      background: conic-gradient(from 0deg, transparent 0 55%, #ff385c 72%, #e31c5f 82%, #d70466 90%, transparent 100%);
      animation: spin 2.4s linear infinite; transition: opacity .7s ease; }
    .wrap.loading::before { opacity: 1; }
    .wrap::after { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: 18px; opacity: 0;
      box-shadow: 0 0 0 1px rgba(255,56,92,.15), 0 8px 40px rgba(255,56,92,.18); transition: opacity .7s ease; }
    .wrap.loading::after { opacity: 1; }
    @keyframes spin { to { transform: rotate(1turn); } }

    .box { position: relative; overflow: hidden; border-radius: 16px; padding: 24px; background: #f7f7f7; color: #222;
      font-family: "Airbnb Cereal VF", Circular, -apple-system, system-ui, Roboto, "Helvetica Neue", sans-serif; }
    /* soft moving pink haze inside the box while loading */
    .haze { position: absolute; top: 0; bottom: 0; left: -30%; width: 160%; pointer-events: none; opacity: 0;
      transition: opacity .7s ease; background: radial-gradient(40% 140px at 50% 0%, rgba(255,56,92,.12), transparent 70%); }
    .loading .haze { opacity: 1; animation: drift 4s ease-in-out infinite alternate; }
    @keyframes drift { from { transform: translateX(-25%); } to { transform: translateX(25%); } }

    .progress { position: absolute; top: 0; left: 0; height: 3px; width: 0; border-radius: 0 3px 3px 0; opacity: 0;
      background: linear-gradient(90deg, #ff385c, #e31c5f, #d70466); }
    .loading .progress { opacity: 1; width: 92%; transition: width 16s cubic-bezier(.1,.6,.2,1), opacity .3s; }
    .done .progress { width: 100%; opacity: 0; transition: width .3s ease, opacity .5s ease .3s; }

    .head { position: relative; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    h2 { font-size: 22px; line-height: 26px; font-weight: 600; margin: 0; display: flex; align-items: center; }
    .spark { width: 0; height: 18px; margin-right: 0; flex-shrink: 0; color: #ff385c; opacity: 0; transform: scale(.4) rotate(-30deg);
      transition: opacity .4s, transform .5s ${EASE}, width .5s ${EASE}, margin .5s ${EASE}; }
    .loading .spark { width: 18px; margin-right: 8px; opacity: 1; transform: none; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 50% { transform: scale(.75) rotate(45deg); opacity: .6; } }
    .sum { font-size: 14px; line-height: 20px; color: #6a6a6a; margin: 6px 0 0; min-height: 20px; }
    .sum.swap { animation: swap .45s ${EASE} both; }
    @keyframes swap { from { opacity: 0; transform: translateY(6px); filter: blur(3px); } }
    .nav { display: flex; gap: 8px; flex-shrink: 0; }
    .nav button { width: 32px; height: 32px; border-radius: 50%; border: 1px solid #dddddd; background: #fff;
      font-size: 18px; line-height: 1; cursor: pointer; color: #222; transition: box-shadow .2s, transform .2s, opacity .3s; }
    .nav button:hover { box-shadow: 0 2px 4px rgba(0,0,0,.18); transform: scale(1.04); }
    .nav .arrow { opacity: 0; pointer-events: none; }
    .nav .toggle { display: grid; place-items: center; }
    .toggle svg { width: 14px; height: 14px; transition: transform .35s ${EASE}; }
    .collapsed .toggle svg { transform: rotate(180deg); }
    /* collapsed: header only, no glow; nothing is requested until it is expanded again */
    .collapsed .sum, .collapsed .body, .collapsed .note, .collapsed form, .collapsed .nav .arrow { display: none; }
    .hint { display: none; font-size: 14px; line-height: 20px; color: #6a6a6a; margin: 6px 0 0; }
    .collapsed .hint { display: block; animation: swap .45s ${EASE} both; }
    .wrap.collapsed::before, .wrap.collapsed::after, .collapsed .haze, .collapsed .progress { opacity: 0 !important; }
    .collapsed .spark { width: 0; margin-right: 0; opacity: 0; animation: none; }
    .has-cards .nav .arrow { opacity: 1; pointer-events: auto; }

    .row { position: relative; display: flex; gap: 16px; overflow-x: auto; scroll-behavior: smooth; scrollbar-width: none;
      margin-top: 16px; padding-bottom: 4px; }
    .row::-webkit-scrollbar { display: none; }
    .card { flex: 0 0 220px; width: 220px; min-width: 0; text-decoration: none; color: inherit; display: block; }
    .card.in { animation: rise .6s ${EASE} both; animation-delay: calc(var(--i) * 90ms); }
    @keyframes rise { from { opacity: 0; transform: translateY(18px) scale(.96); filter: blur(6px); } }
    .img { width: 220px; aspect-ratio: 20 / 19; border-radius: 12px; object-fit: cover; background: #e8e8e8; display: block;
      transition: transform .35s ${EASE}; }
    .card.in:hover .img { transform: scale(1.02); }
    .line { display: flex; justify-content: space-between; gap: 8px; margin-top: 10px; font-size: 14px; }
    .rate { flex-shrink: 0; white-space: nowrap; }
    .type { font-weight: 600; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .name, .price { font-size: 14px; color: #6a6a6a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .price { color: #222; margin-top: 2px; }
    .pg { color: #6a6a6a; }
    /* reason chip: one line, same height on every card, opens the review popover */
    .why { display: flex; align-items: center; gap: 6px; width: 100%; margin-top: 10px; padding: 7px 10px 7px 9px;
      border: 1px solid #dddddd; border-radius: 999px; background: #fff; color: #222; font: inherit; font-size: 13px;
      line-height: 16px; text-align: left; cursor: pointer; position: relative; overflow: hidden;
      transition: border-color .2s, box-shadow .2s, transform .15s; }
    .why:hover, .why.open { border-color: #222; box-shadow: 0 2px 6px rgba(0,0,0,.08); }
    .why:active { transform: scale(.98); }
    .why svg { width: 12px; height: 12px; flex-shrink: 0; color: #ff385c; }
    .why .lbl { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .why .cnt { color: #6a6a6a; white-space: nowrap; flex-shrink: 0; }
    .why .chev { margin-left: auto; color: #6a6a6a; flex-shrink: 0; transition: transform .25s ${EASE}; }
    .why.open .chev { transform: rotate(90deg); }
    /* one pink light sweep across each chip, right after its card lands */
    .card.in .why::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); pointer-events: none;
      background: linear-gradient(100deg, transparent 20%, rgba(255,56,92,.18) 50%, transparent 80%);
      animation: sweep 1.1s ease-out both; animation-delay: calc(var(--i) * 90ms + .45s); }
    @keyframes sweep { to { transform: translateX(100%); } }
    .link { display: block; text-decoration: none; color: inherit; }

    .pop { position: absolute; z-index: 10; width: 360px; max-width: calc(100% - 8px); background: #fff; color: #222;
      border-radius: 16px; box-shadow: 0 8px 28px rgba(0,0,0,.28); padding: 20px 20px 16px; transform-origin: top left;
      font-family: "Airbnb Cereal VF", Circular, -apple-system, system-ui, Roboto, "Helvetica Neue", sans-serif;
      animation: popin .32s ${EASE} both; }
    .pop.closing { animation: popout .18s ease both; }
    @keyframes popin { from { opacity: 0; transform: translateY(-6px) scale(.96); } }
    @keyframes popout { to { opacity: 0; transform: translateY(-4px) scale(.98); } }
    .pop-head { display: flex; gap: 12px; align-items: flex-start; }
    .pop-title { font-size: 16px; line-height: 20px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .pop-title svg { width: 14px; height: 14px; color: #ff385c; flex-shrink: 0; }
    .pop-sub { font-size: 14px; line-height: 20px; color: #6a6a6a; margin-top: 4px; }
    .pop-x { margin-left: auto; flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; border: 0; background: transparent;
      font-size: 18px; cursor: pointer; color: #222; }
    .pop-x:hover { background: #f7f7f7; }
    .rev { margin: 14px 0 0; padding-top: 14px; border-top: 1px solid #ebebeb; animation: rise .45s ${EASE} both;
      animation-delay: calc(var(--i) * 70ms + 80ms); }
    .rev blockquote { margin: 0; font-size: 14px; line-height: 21px; }
    .rev mark { background: #ffe8ed; color: #222; font-weight: 600; border-radius: 3px; padding: 0 2px; }
    .rev figcaption { margin-top: 6px; font-size: 12px; color: #6a6a6a; }
    .pop-foot { margin-top: 14px; font-size: 12px; color: #6a6a6a; }

    .skel .img, .skel .bar { background: linear-gradient(90deg, #e9e9e9 0%, #f6f6f6 40%, #ffe9ee 50%, #f6f6f6 60%, #e9e9e9 100%);
      background-size: 300% 100%; animation: shimmer 1.6s linear infinite; animation-delay: calc(var(--i) * 120ms); }
    .skel { animation: breathe 1.6s ease-in-out infinite; animation-delay: calc(var(--i) * 120ms); }
    @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -200% 0; } }
    @keyframes breathe { 50% { transform: translateY(-3px); } }
    .bar { height: 12px; border-radius: 6px; margin-top: 10px; }
    .skel.out { animation: fadeout .25s ease both; }
    @keyframes fadeout { to { opacity: 0; transform: scale(.97); filter: blur(4px); } }

    .msg { font-size: 15px; margin: 16px 0 0; animation: swap .5s ${EASE} both; }
    .note { font-size: 14px; color: #6a6a6a; margin: 12px 0 0; animation: swap .5s ${EASE} both; }
    .note:empty { display: none; }
    form { position: relative; display: flex; gap: 8px; margin-top: 16px; }
    input { flex: 1; padding: 10px 14px; border: 1px solid #b0b0b0; border-radius: 24px; font: inherit; font-size: 14px;
      background: #fff; color: #222; transition: border-color .2s, box-shadow .2s; }
    input:focus { outline: none; border-color: #222; box-shadow: 0 0 0 2px rgba(34,34,34,.08); }
    form button { border: 0; border-radius: 24px; padding: 0 18px; font: inherit; font-size: 14px; font-weight: 600; color: #fff;
      cursor: pointer; background: linear-gradient(90deg, #e61e4d, #e31c5f 50%, #d70466); transition: transform .15s, opacity .2s; }
    form button:active { transform: scale(.96); }
    form button:disabled { opacity: .45; cursor: default; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  `;

  const SPARK = '<svg class="spark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg>';
  const SPARK_SM = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg>';
  let el = null;       // references to the persistent parts of the row
  let steps = null;    // loading status timer

  function build() {
    root.innerHTML = `<style>${STYLE}</style>
      <div class="wrap"><div class="box"><div class="haze"></div><div class="progress"></div>
        <div class="head"><div><h2>${SPARK}Picked 4 U</h2><p class="sum"></p></div>
          <div class="nav"><button class="arrow prev" title="Previous">‹</button><button class="arrow next" title="Next">›</button>
          <button class="toggle" title="Collapse"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div>
        <p class="hint">Collapsed · expand to see picks from these listings</p>
        <div class="body"></div><p class="note"></p>
        <form><input placeholder="Search for something else, e.g. right next to pubs and live music" maxlength="500">
          <button type="submit">Send</button></form></div></div>`;
    const q = (s) => root.querySelector(s);
    el = { wrap: q(".wrap"), box: q(".box"), sum: q(".sum"), body: q(".body"), note: q(".note"),
           input: q("input"), send: q("form button") };
    q(".prev").addEventListener("click", () => q(".row")?.scrollBy({ left: -472 }));
    q(".next").addEventListener("click", () => q(".row")?.scrollBy({ left: 472 }));
    q(".toggle").addEventListener("click", () => setCollapsed(!settings.collapsed, true));
    el.wrap.classList.toggle("collapsed", settings.collapsed);
    q(".toggle").title = settings.collapsed ? "Expand" : "Collapse";
    el.body.addEventListener("click", (e) => {
      const btn = e.target.closest(".why");
      if (btn) { e.preventDefault(); openPop(btn); }
    });
    el.body.addEventListener("scroll", () => closePop(), true);
    q("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = el.input.value.trim();
      if (text) { el.input.value = ""; ask(text); }
    });
  }

  // ---------- review popover ----------
  let pop = null, popFor = null;

  function marked(r) {
    const chars = [...r.text]; // backend offsets count Unicode code points, not UTF-16 units
    let out = "", last = 0;
    for (const [a, b] of r.marks || []) {
      out += esc(chars.slice(last, a).join("")) + "<mark>" + esc(chars.slice(a, b).join("")) + "</mark>";
      last = b;
    }
    return out + esc(chars.slice(last).join(""));
  }

  const listText = (xs) => xs.length < 2 ? (xs[0] || "") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;
  const month = (d) => { try { return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }); } catch { return ""; } };

  function closePop(now = false) {
    if (!pop) return;
    const p = pop;
    pop = null;
    popFor?.classList.remove("open");
    popFor = null;
    host.style.zIndex = "";
    if (now) p.remove();
    else { p.classList.add("closing"); setTimeout(() => p.remove(), 180); }
  }

  function openPop(btn) {
    const same = popFor === btn;
    closePop(true);
    if (same) return;
    const it = el.items?.[+btn.dataset.i];
    if (!it) return;
    pop = document.createElement("div");
    pop.className = "pop";
    pop.setAttribute("role", "dialog");
    pop.innerHTML = `<div class="pop-head"><div><div class="pop-title">${SPARK_SM}${esc(it.label || "Why we picked it")}</div>
        <div class="pop-sub">${esc(it.reason)}</div></div><button class="pop-x" title="Close">×</button></div>
      ${(it.reviews || []).map((r, i) => `<figure class="rev" style="--i:${i}"><blockquote>${marked(r)}</blockquote>
        <figcaption>${r.wish ? `About “${esc(r.wish)}” · ` : ""}Guest review${r.date ? " · " + esc(month(r.date)) : ""}</figcaption></figure>`).join("")}
      <div class="pop-foot">${it.mentions > 3 ? `Top 3 of ${it.mentions} matching guest reviews` : "Matching guest reviews"}</div>`;
    root.appendChild(pop);
    const hr = host.getBoundingClientRect(), br = btn.getBoundingClientRect();
    const left = Math.max(0, Math.min(br.left - hr.left, hr.width - pop.offsetWidth));
    pop.style.left = left + "px";
    pop.style.top = br.bottom - hr.top + 8 + "px";
    pop.style.transformOrigin = `${br.left - hr.left - left + 20}px top`;
    host.style.zIndex = "5"; // float above the Airbnb cards below
    btn.classList.add("open");
    popFor = btn;
    pop.querySelector(".pop-x").addEventListener("click", () => closePop());
  }

  document.addEventListener("click", (e) => { if (pop && !e.composedPath().includes(pop) && !e.composedPath().includes(popFor)) closePop(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });

  function setSummary(text) {
    if (el.sum.textContent === text) return;
    el.sum.textContent = text;
    el.sum.classList.remove("swap"); void el.sum.offsetWidth; el.sum.classList.add("swap");
  }

  // Smoothly animate the box from its old height to the new one (FLIP).
  function morph(update) {
    const h0 = el.box.offsetHeight;
    update();
    const h1 = el.box.offsetHeight;
    if (h0 && Math.abs(h1 - h0) > 2) el.box.animate([{ height: h0 + "px" }, { height: h1 + "px" }], { duration: 500, easing: EASE });
  }

  function startSteps(n) {
    clearTimeout(steps);
    setSummary(`Found ${n} great listings`);
    steps = setTimeout(() => setSummary("AI is reading the reviews for these listings…"), 1400);
  }

  function render(state, data = {}) {
    if (!root) return;
    if (!el || !root.contains(el.box)) build();
    const cards = readCards();
    const loading = state === "loading";
    if (!loading) clearTimeout(steps);

    // results replace the skeleton: fade the placeholders out first, then morph in the real cards
    const skel = el.body.querySelectorAll(".skel");
    const apply = () => morph(() => {
      el.wrap.classList.toggle("loading", loading);
      el.wrap.classList.toggle("done", !loading);
      el.send.disabled = loading;
      let body = "";
      if (loading) {
        body = `<div class="row">${[0, 1, 2, 3].map((i) => `<div class="card skel" style="--i:${i}"><div class="img"></div>
          <div class="bar" style="width:80%"></div><div class="bar" style="width:55%"></div><div class="bar" style="height:30px"></div></div>`).join("")}</div>`;
        setSummary(""); // "Found N great listings" starts once the other pages are in (ask)
      } else if (state === "no_match") {
        body = `<p class="msg">We didn't find a place that suits you here.</p>`;
        setSummary("Try telling us a bit more below.");
      } else if (state === "ok") {
        const info = (id) => cards.has(id) ? cardInfo(cards.get(id)) : extraInfo.get(id);
        const items = data.items.filter((it) => info(it.listing_id));
        body = `<div class="row">${items.map((it, i) => {
          const c = info(it.listing_id);
          return `<div class="card in" style="--i:${i}">
            <a class="link" href="${esc(c.href)}" target="_blank" rel="noopener">
              <img class="img" src="${esc(c.img)}" alt="">
              <div class="line"><span class="type">${esc(c.type)}</span><span class="rate">${c.rating ? "★ " + esc(c.rating) : ""}</span></div>
              <div class="name">${esc(c.name)}</div>
              <div class="price">${esc(c.price)}${c.page ? `<span class="pg"> · page ${c.page}</span>` : ""}</div></a>
            <button class="why" data-i="${i}" title="${esc(it.reason)}">${SPARK_SM}<span class="lbl">${esc(it.label || it.reason)}</span>
              <span class="chev">›</span></button></div>`;
        }).join("")}</div>`;
        el.items = items;
        if (data.note) setSummary(data.summary || "");
        else {
          setSummary("Found it!");
          const mine = seq;
          clearTimeout(steps);
          steps = setTimeout(() => mine === seq && setSummary(data.summary || ""), 1800);
        }
      } else {
        setSummary(data.keepSummary || "");
      }
      closePop(true);
      if (state !== "keep") el.body.innerHTML = body;
      el.box.classList.toggle("has-cards", state === "ok" || (state === "keep" && !!el.body.querySelector(".card.in")));
      const missing = (data.missing || []).filter(Boolean);
      el.note.textContent = data.note ||
        (missing.length && state !== "loading" ? `No guest review in these results mentions ${listText(missing)}.` : "");
    });

    if (!loading && skel.length) {
      skel.forEach((s) => s.classList.add("out"));
      setTimeout(apply, 230);
    } else apply();
  }

  function show(resp) {
    if (resp.status === "ok") render("ok", resp);
    else if (resp.status === "no_match") render("no_match", resp);
    else if (resp.status === "refused") {
      // keep the earlier cards (if any) and show the polite message above the input
      const prev = lastResp?.status === "ok" ? lastResp : null;
      prev ? render("ok", { ...prev, note: resp.message }) : render("none", { note: resp.message });
      return;
    } else {
      removeHost(); // error: hide the row (details are in the console warning)
      return;
    }
    lastResp = resp;
  }

  // ---------- backend ----------
  async function ask(message = "") {
    const cards = readCards();
    const my = ++seq;
    render("loading");
    const extra = await otherPages(cards); // cached after the first fetch, so chat follow-ups are instant
    if (my !== seq) return;
    extraInfo = extra;
    const ids = [...cards.keys(), ...extra.keys()];
    if (!alive()) return shutdown();
    startSteps(ids.length);
    const payload = { session_id: session, listing_ids: ids, preference: settings.preference, message };
    const send = (retry) => chrome.runtime.sendMessage({ type: "recommend", payload }, (resp) => {
      if (my !== seq) return; // a newer request replaced this one
      const err = chrome.runtime.lastError?.message || "";
      // the service worker was stopped/restarted mid-request (e.g. extension reload): try once more
      if (retry && /channel closed|Receiving end does not exist/i.test(err) && alive()) return send(false);
      if (err || !resp || resp.status === "error") console.warn("[tywl] backend call failed:", err || resp);
      try { show(resp || { status: "error" }); } catch (e) { console.debug("[tywl]", e); }
    });
    try {
      send(true);
    } catch (e) {
      console.warn("[tywl] extension unavailable (reloaded?) - refresh the page:", e);
      shutdown();
    }
  }

  // stop this copy for good (the reloaded extension injects a fresh one on the next page load)
  function shutdown() {
    observer.disconnect();
    clearTimeout(timer);
    removeHost();
  }

  // ---------- collapse ----------
  function setCollapsed(c, save = false) {
    settings.collapsed = c;
    if (save && alive()) chrome.storage.local.set({ collapsed: c });
    if (el && root?.contains(el.box)) {
      closePop(true);
      morph(() => el.wrap.classList.toggle("collapsed", c));
      root.querySelector(".toggle").title = c ? "Expand" : "Collapse";
    }
    if (!c) tick(); // expanded: ask again only if the listings changed since the last request
  }

  // ---------- main loop ----------
  function tick() {
    if (!alive()) return shutdown();
    try {
      // injected on every Airbnb page (searching from the homepage is an in-app navigation, not a page load),
      // so only act on search result pages
      if (!location.pathname.startsWith("/s/")) return removeHost();
      if (!settings.enabled || !settings.preference) return removeHost();
      const cards = readCards();
      if (!ensureHost(cards)) return;
      const fresh = !el || !root.contains(el.box);
      if (fresh) build();
      if (settings.collapsed) return; // no requests while collapsed
      const ids = [...cards.keys()].join(",");
      if (ids !== lastIds) {
        lastIds = ids;
        ask();
      } else if (fresh) {
        lastResp ? show(lastResp) : ask();
      }
    } catch (e) {
      console.debug("[tywl]", e);
    }
  }

  let timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(tick, 800); };

  const observer = new MutationObserver((records) => {
    // ignore changes caused only by our own host
    const ours = records.every((r) => (host && host.contains(r.target)) ||
      [...r.addedNodes, ...r.removedNodes].every((n) => n === host));
    if (!ours || (host && !host.isConnected)) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) settings.enabled = changes.enabled.newValue !== false;
    if (changes.preference) settings.preference = changes.preference.newValue || "";
    if (changes.collapsed && changes.collapsed.newValue !== settings.collapsed) setCollapsed(changes.collapsed.newValue === true);
    if (changes.enabled || changes.preference) {
      lastIds = ""; lastResp = null;
      schedule();
    }
  });

  chrome.storage.local.get(["enabled", "preference", "collapsed"]).then((s) => {
    settings = { enabled: s.enabled !== false, preference: s.preference || "", collapsed: s.collapsed === true };
    tick();
  });
})();
