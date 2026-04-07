import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDownloadTasks,
  buildSearchPageUrl,
  parseDetailHtml,
  parseSearchResultsHtml,
} from "./shared.mjs";

const SAMPLE_URL =
  "https://coins.ha.com/itm/morgan-dollars/1893-o-1-ms65-deep-mirror-prooflike-pcgs-without-question-this-is-one-of-the-finest-known-specimens-of-this-date-to-survive-the/a/388-2313.s";

const SAMPLE_HTML = `
  <html>
    <head>
      <title>1893-O $1 MS65 Deep Mirror Prooflike PCGS. | Lot #2313 | Heritage Auctions</title>
      <meta property="og:title" content="1893-O $1 MS65 Deep Mirror Prooflike PCGS. | Lot #2313 | Heritage Auctions">
    </head>
    <body>
      <h1>1893-O $1 MS65 Deep Mirror Prooflike PCGS.</h1>
      <a href="https://www.pcgs.com/cert/123/456">View Certification Details from PCGS</a>
      <img src="https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618323&w=850&h=600&it=product">
      <img src="https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618324&w=850&h=600&it=product">
    </body>
  </html>
`;

const SEARCH_HTML = `
  <html>
    <body>
      <a href="https://coins.ha.com/itm/morgan-dollars/1893-o-1-ms65-deep-mirror-prooflike-pcgs-without-question-this-is-one-of-the-finest-known-specimens-of-this-date-to-survive-the/a/388-2313.s?ic4=ListView-ShortDescription-071515">
        1893-O $1 MS65 Deep Mirror Prooflike PCGS.
      </a>
      <a href="https://coins.ha.com/itm/morgan-dollars/1893-o-1-ms65-deep-mirror-prooflike-pcgs-without-question-this-is-one-of-the-finest-known-specimens-of-this-date-to-survive-the/a/388-2313.s?ic4=ListView-Thumbnail-071515" class="photo-holder preview-image-thumb thumbnail">
        <img
          src="https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618323&w=120&h=300&it=product"
          data-image2="https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618324&w=80&h=120&it=product"
        >
      </a>
      <a href="https://coins.ha.com/itm/morgan-dollars/1892-s-1-ms66-pcgs-only-12-million-morgan-dollars-were-coined-at-the-san-francisco-mint-in-1892-and-many-of-these-immediately-went-into/a/394-3319.s?ic4=ListView-ShortDescription-071515">
        1892-S $1 MS66 PCGS.
      </a>
      <a href="https://www.ha.com/c/search/results.zx?term=morgan&si=1&archive_state=5327&sold_status=1526&sb=1&mode=archive&page=50~3&layout=list">3</a>
      <a href="https://www.ha.com/c/search/results.zx?term=morgan&si=1&archive_state=5327&sold_status=1526&sb=1&mode=archive&page=50~4&layout=list">4</a>
    </body>
  </html>
`;

test("parseDetailHtml extracts service grade sale-lot and image urls", () => {
  const detail = parseDetailHtml(SAMPLE_HTML, SAMPLE_URL, "");

  assert.equal(detail.service, "PCGS");
  assert.equal(detail.grade, "MS65 Deep Mirror Prooflike");
  assert.equal(detail.saleNo, "388");
  assert.equal(detail.lotNo, "2313");
  assert.deepEqual(detail.imageUrls, [
    "https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618323&w=850&h=600&it=product",
    "https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618324&w=850&h=600&it=product",
  ]);
});

test("buildDownloadTasks creates numbered filenames under service/grade/lot", () => {
  const detail = parseDetailHtml(SAMPLE_HTML, SAMPLE_URL, "");
  const tasks = buildDownloadTasks(detail, "heritage_morgan");

  assert.deepEqual(
    tasks.map((task) => task.filename),
    [
      "heritage_morgan/pcgs/MS65_Deep_Mirror_Prooflike/sale388_lot2313/01.jpg",
      "heritage_morgan/pcgs/MS65_Deep_Mirror_Prooflike/sale388_lot2313/02.jpg",
    ],
  );
});

test("buildSearchPageUrl keeps ~ unencoded", () => {
  const url = buildSearchPageUrl(
    "https://www.ha.com/c/search/results.zx?term=morgan&si=1&archive_state=5327&sold_status=1526&sb=1&mode=archive&page=10~2&layout=list",
    50,
    1,
  );

  assert.ok(url.includes("page=50~1"), `URL should contain page=50~1 but got: ${url}`);
  assert.ok(!url.includes("%7E"), "URL should not contain encoded ~");
});

test("parseSearchResultsHtml extracts full item metadata from search page", () => {
  const page = parseSearchResultsHtml(
    SEARCH_HTML,
    "https://www.ha.com/c/search/results.zx?term=morgan&si=1&archive_state=5327&sold_status=1526&sb=1&mode=archive&page=50~2&layout=list",
  );

  assert.equal(page.items.length, 2);
  assert.equal(page.currentPage, 2);
  assert.equal(page.maxVisiblePage, 4);
  assert.deepEqual(page.items.map((item) => item.url), [
    "https://coins.ha.com/itm/morgan-dollars/1893-o-1-ms65-deep-mirror-prooflike-pcgs-without-question-this-is-one-of-the-finest-known-specimens-of-this-date-to-survive-the/a/388-2313.s",
    "https://coins.ha.com/itm/morgan-dollars/1892-s-1-ms66-pcgs-only-12-million-morgan-dollars-were-coined-at-the-san-francisco-mint-in-1892-and-many-of-these-immediately-went-into/a/394-3319.s",
  ]);
  assert.equal(page.items[0].service, "PCGS");
  assert.equal(page.items[0].grade, "MS65 Deep Mirror Prooflike");
  assert.equal(page.items[0].saleNo, "388");
  assert.equal(page.items[0].lotNo, "2313");
  assert.deepEqual(page.items[0].imageUrls, [
    "https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618323&w=850&h=600&it=product",
    "https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618324&w=850&h=600&it=product",
  ]);
});

test("buildDownloadTasks works directly from search-page item with front and back images", () => {
  assert.deepEqual(
    buildDownloadTasks(
      {
        service: "PCGS",
        grade: "MS65 Deep Mirror Prooflike",
        saleNo: "388",
        lotNo: "2313",
        imageUrls: [
        "https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618323&w=850&h=600&it=product",
        "https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618324&w=850&h=600&it=product",
        ],
      },
      "heritage_morgan",
    ),
    [
      {
        url: "https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618323&w=850&h=600&it=product",
        filename: "heritage_morgan/pcgs/MS65_Deep_Mirror_Prooflike/sale388_lot2313/01.jpg",
      },
      {
        url: "https://dyn1.heritagestatic.com/ha?p=1-6-1-8-1618324&w=850&h=600&it=product",
        filename: "heritage_morgan/pcgs/MS65_Deep_Mirror_Prooflike/sale388_lot2313/02.jpg",
      },
    ],
  );
});
