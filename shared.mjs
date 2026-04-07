// 匹配 "MS65" 或 "MS65+" 等紧凑格式
const GRADE_START_RE =
  /^(?:PO|FR|AG|VG|VF|EF|XF|AU|MS|PR|PF|SP|F|G)\d{1,2}[+*]?$/i;
// 匹配 "PR" "MS" 等单独的等级前缀（数字在下一个 token）
const GRADE_PREFIX_RE =
  /^(?:PO|FR|AG|VG|VF|EF|XF|AU|MS|PR|PF|SP)$/i;

export function normalizeText(value) {
  return (value || "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizePathSegment(value, fallback = "unknown") {
  const cleaned = normalizeText(value)
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._+\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[._ ]+|[._ ]+$/g, "");
  return cleaned || fallback;
}

export function canonicalizeLotUrl(url) {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function parseSaleLot(url) {
  const match = canonicalizeLotUrl(url).match(/\/a\/(\d+)-(\d+)\.s$/i);
  return {
    saleNo: match?.[1] || null,
    lotNo: match?.[2] || null,
  };
}

export function parseService(...candidates) {
  for (const candidate of candidates) {
    const match = normalizeText(candidate).match(/\b(NGC|PCGS)\b/i);
    if (match) {
      return match[1].toUpperCase();
    }
  }
  return null;
}

export function parseGrade(title, service) {
  if (!title || !service) {
    return null;
  }

  const text = normalizeText(title).replace(/\.{4,}/g, ".");
  const serviceRegex = new RegExp(`\\b${service}\\b`, "i");
  const serviceMatch = text.match(serviceRegex);
  if (!serviceMatch || serviceMatch.index == null) {
    return null;
  }

  const leftSide = text.slice(0, serviceMatch.index).replace(/[ .]+$/g, "");
  if (!leftSide) {
    return null;
  }

  const tokens = leftSide.split(" ");
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    // 紧凑格式: "MS65", "PR63+"
    if (GRADE_START_RE.test(tokens[index])) {
      return normalizeText(tokens.slice(index).join(" "));
    }
    // 分离格式: "PR 63", "MS 65" — 前缀在前一个 token
    if (/^\d{1,2}[+*]?$/.test(tokens[index]) && index > 0 && GRADE_PREFIX_RE.test(tokens[index - 1])) {
      return normalizeText(tokens.slice(index - 1).join(" "));
    }
  }

  return null;
}

function matchFirst(html, regex) {
  const match = html.match(regex);
  return normalizeText(match?.[1] || "");
}

function extractTitle(html) {
  return (
    matchFirst(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    matchFirst(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
  );
}

function extractCertificationText(html) {
  return matchFirst(
    html,
    />\s*(View Certification Details from (?:NGC|PCGS))\s*</i,
  );
}

function buildImageUrl(productId) {
  return `https://dyn1.heritagestatic.com/ha?p=${productId}&w=850&h=600&it=product`;
}

// 从 heritagestatic URL 提取 productId
function extractProductId(url) {
  if (!url) return null;
  const decoded = url.replace(/&amp;/g, "&");
  try {
    const parsed = new URL(decoded);
    if ((parsed.searchParams.get("it") || "").toLowerCase() !== "product") {
      return null;
    }
    return parsed.searchParams.get("p") || null;
  } catch {
    return null;
  }
}

export function extractImageUrls(html) {
  const matches =
    html.match(/https:\/\/dyn1\.heritagestatic\.com\/ha\?[^"'<> ]+/gi) || [];
  const largeIds = [];
  const fallbackIds = [];
  const seen = new Set();

  for (const rawUrl of matches) {
    const decoded = rawUrl.replace(/&amp;/g, "&");
    let parsed;
    try {
      parsed = new URL(decoded);
    } catch {
      continue;
    }
    if ((parsed.searchParams.get("it") || "").toLowerCase() !== "product") {
      continue;
    }
    const productId = parsed.searchParams.get("p");
    if (!productId || seen.has(productId)) {
      continue;
    }
    seen.add(productId);
    const width = Number(parsed.searchParams.get("w") || 0);
    const height = Number(parsed.searchParams.get("h") || 0);
    if (width >= 600 || height >= 600) {
      largeIds.push(productId);
    } else {
      fallbackIds.push(productId);
    }
  }

  const ids = largeIds.length ? largeIds : fallbackIds;
  return ids.map(buildImageUrl);
}

// FIX: 不编码 ~ 字符
export function buildSearchPageUrl(url, pageSize, pageIndex) {
  const parsed = new URL(url);
  parsed.searchParams.delete("page");
  parsed.searchParams.set("layout", "list");
  const base = parsed.toString();
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}page=${pageSize}~${pageIndex}`;
}

// ── 搜索页直出：从搜索页 HTML 提取完整 item 信息（不再需要详情页） ──
export function parseSearchResultsHtml(html, sourceUrl) {
  const parsedSourceUrl = new URL(sourceUrl);
  const pageToken = parsedSourceUrl.searchParams.get("page") || "10~1";
  const currentPage = Number(pageToken.split("~")[1] || 1);

  // 1) 提取描述链接 → title + canonicalUrl
  const descRegex =
    /<a[^>]+href=["']([^"']*\/itm\/[^"']*ListView-ShortDescription[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const items = [];
  const seen = new Set();
  const itemMap = new Map(); // canonicalUrl → item

  let m;
  while ((m = descRegex.exec(html))) {
    const rawUrl = m[1].replace(/&amp;/g, "&");
    const text = normalizeText(m[2].replace(/<[^>]+>/g, " "));
    const canonicalUrl = canonicalizeLotUrl(new URL(rawUrl, sourceUrl).toString());
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);

    const { saleNo, lotNo } = parseSaleLot(canonicalUrl);
    const service = parseService(text);
    const grade = parseGrade(text, service);

    const item = {
      url: canonicalUrl,
      title: text,
      service,
      grade,
      saleNo,
      lotNo,
      imageUrls: [],
    };
    items.push(item);
    itemMap.set(canonicalUrl, item);
  }

  // 2) 提取缩略图链接 → 正面 src + 反面 data-image2
  const thumbRegex =
    /<a[^>]+href=["']([^"']*\/itm\/[^"']*ListView-Thumbnail[^"']*)["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']([^>]*)>/gi;
  let tm;
  while ((tm = thumbRegex.exec(html))) {
    const thumbUrl = tm[1].replace(/&amp;/g, "&");
    const imgSrc = tm[2].replace(/&amp;/g, "&");
    const restAttrs = tm[3].replace(/&amp;/g, "&");
    const canonicalUrl = canonicalizeLotUrl(new URL(thumbUrl, sourceUrl).toString());

    const item = itemMap.get(canonicalUrl);
    if (!item) continue;

    const ids = new Set();

    // 正面图 (src)
    const frontId = extractProductId(imgSrc);
    if (frontId && !ids.has(frontId)) {
      ids.add(frontId);
      item.imageUrls.push(buildImageUrl(frontId));
    }

    // 反面图 (data-image2)
    const dataImg2Match = restAttrs.match(/data-image2=["']([^"']+)["']/i);
    if (dataImg2Match) {
      const backId = extractProductId(dataImg2Match[1]);
      if (backId && !ids.has(backId)) {
        ids.add(backId);
        item.imageUrls.push(buildImageUrl(backId));
      }
    }
  }

  // 3) 翻页信息
  const pageRegex = /page=(\d+)~(\d+)/gi;
  const visiblePages = [];
  let pm;
  while ((pm = pageRegex.exec(html))) {
    visiblePages.push(Number(pm[2]));
  }

  return {
    currentPage,
    maxVisiblePage: visiblePages.length ? Math.max(...visiblePages) : currentPage,
    items,
  };
}

// ── 详情页解析（保留备用） ──
export function parseDetailHtml(html, url, fallbackTitle = "") {
  const title = extractTitle(html) || normalizeText(fallbackTitle);
  const certificationText = extractCertificationText(html);
  const service = parseService(certificationText, title, fallbackTitle);
  const grade =
    parseGrade(title, service) || parseGrade(fallbackTitle, service);
  const imageUrls = extractImageUrls(html);
  const { saleNo, lotNo } = parseSaleLot(url);

  return {
    url: canonicalizeLotUrl(url),
    title,
    certificationText,
    service,
    grade,
    saleNo,
    lotNo,
    imageUrls,
  };
}

// ── 下载任务生成 ──
export function buildDownloadTasks(detail, rootDir = "heritage_morgan") {
  const serviceFolder = sanitizePathSegment(
    (detail.service || "unknown").toLowerCase(),
    "unknown_service",
  );
  const gradeFolder = sanitizePathSegment(detail.grade || "", "unknown_grade");
  const saleLotFolder = sanitizePathSegment(
    `sale${detail.saleNo || "unknown"}_lot${detail.lotNo || "unknown"}`,
    "unknown_lot",
  );

  return (detail.imageUrls || []).map((url, index) => ({
    url,
    filename: `${rootDir}/${serviceFolder}/${gradeFolder}/${saleLotFolder}/${String(
      index + 1,
    ).padStart(2, "0")}.jpg`,
  }));
}
