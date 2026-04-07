(() => {
  const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
  const anchors = Array.from(
    document.querySelectorAll('a[href*="/itm/"][href*="ListView-ShortDescription"]'),
  );
  const seen = new Set();
  const items = [];

  for (const anchor of anchors) {
    const href = new URL(anchor.href, location.href);
    href.search = "";
    href.hash = "";
    const canonicalUrl = href.toString();
    if (seen.has(canonicalUrl)) {
      continue;
    }
    seen.add(canonicalUrl);
    items.push({
      url: canonicalUrl,
      title: normalize(anchor.innerText || anchor.textContent || ""),
    });
  }

  window.__haMorganItems = items;
  console.log(`Captured ${items.length} Heritage lots.`);
  console.table(items.map(({ url, title }) => ({ url, title: title.slice(0, 120) })));
  return items;
})();
