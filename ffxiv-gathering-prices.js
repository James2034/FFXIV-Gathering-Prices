// ffxiv-gathering-prices.js
// Run: node ffxiv-gathering-prices.js
// Optional: node ffxiv-gathering-prices.js Crystal 50

const DC_OR_WORLD = process.argv[2] || "Mateus";
const RESULT_LIMIT = Number.parseInt(process.argv[3] ?? "50", 10);

const XIVAPI_BASE = "https://v2.xivapi.com/api";
const UNIVERSALIS_BASE = "https://universalis.app/api/v2";
const GATHERING_PAGE_SIZE = 500;
const HISTORY_ENTRIES = 50;
const ONE_DAY_IN_SECONDS = 24 * 60 * 60;
const UNIVERSALIS_BATCH_SIZE = 100;
const MAP_NAME_REGEX = /^Timeworn.*Map$/i;

async function fetchJson(url) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}\n${url}`);
  }

  return res.json();
}

async function getGatherableItems() {
  const fields = [
    "Item.Name",
    "Item.ItemSearchCategory.Name",
    "Item.IsUntradable",
    "GatheringItemLevel.GatheringItemLevel",
    "GatheringItemLevel.Stars",
    "IsHidden",
  ].join(",");
  const itemsById = new Map();
  let after = null;

  while (true) {
    const afterParam = after === null ? "" : `&after=${after}`;
    const url = `${XIVAPI_BASE}/sheet/GatheringItem?fields=${fields}&limit=${GATHERING_PAGE_SIZE}${afterParam}`;
    const data = await fetchJson(url);
    const rows = data.rows ?? [];

    for (const row of rows) {
      const item = row.fields?.Item;
      const itemFields = item?.fields;
      const id = item?.row_id ?? item?.value;
      const name = itemFields?.Name;

      if (
        !id ||
        !name ||
        MAP_NAME_REGEX.test(name) ||
        item?.sheet !== "Item" ||
        itemFields?.IsUntradable
      ) {
        continue;
      }

      itemsById.set(id, {
        id,
        name,
        category: itemFields.ItemSearchCategory?.fields?.Name || "Unknown",
        gatheringLevel:
          row.fields?.GatheringItemLevel?.fields?.GatheringItemLevel ?? "Unknown",
        stars: row.fields?.GatheringItemLevel?.fields?.Stars ?? 0,
        hidden: Boolean(row.fields?.IsHidden),
      });
    }

    if (rows.length < GATHERING_PAGE_SIZE) {
      break;
    }

    const lastRowId = rows.at(-1)?.row_id;
    if (lastRowId === undefined || lastRowId === after) {
      break;
    }
    after = lastRowId;
  }

  return [...itemsById.values()];
}

async function getUniversalisData(items) {
  const oneDayAgo = Math.floor(Date.now() / 1000) - ONE_DAY_IN_SECONDS;
  const pricedItems = [];

  for (let i = 0; i < items.length; i += UNIVERSALIS_BATCH_SIZE) {
    const batch = items.slice(i, i + UNIVERSALIS_BATCH_SIZE);
    const ids = batch.map(item => item.id).join(",");
    const url = `${UNIVERSALIS_BASE}/${DC_OR_WORLD}/${ids}?entries=${HISTORY_ENTRIES}`;
    const data = await fetchJson(url);
    const marketById = data.items ?? { [batch[0].id]: data };

    pricedItems.push(
      ...batch.map(item => {
        const market = marketById[item.id];

        const listings = market?.listings ?? [];
        const sales = market?.recentHistory ?? [];

        const lowestListing = listings.length
          ? Math.min(...listings.map(listing => listing.pricePerUnit))
          : null;

        const avgRecentSale = sales.length
          ? Math.round(
              sales.reduce((sum, sale) => sum + sale.pricePerUnit, 0) /
                sales.length
            )
          : null;

        const salesLast24Hours = sales.filter(sale => sale.timestamp >= oneDayAgo);
        const listingsSoldLast24Hours = salesLast24Hours.length;
        const soldLast24Hours = salesLast24Hours
          .reduce((sum, sale) => sum + (sale.quantity ?? 1), 0);

        // For gathering and selling yourself, your "profit" is basically the expected sale price.
        const expectedSalePrice =
          lowestListing !== null && avgRecentSale !== null
            ? Math.min(lowestListing, avgRecentSale)
            : avgRecentSale ?? lowestListing;

        // Score favors items that sell for more and have moved in the last 24 hours.
        const score =
          expectedSalePrice !== null
            ? expectedSalePrice * Math.min(soldLast24Hours, 10) * listingsSoldLast24Hours
            : 0;

        return {
          ...item,
          lowestListing,
          avgRecentSale,
          listingsSoldLast24Hours,
          soldLast24Hours,
          expectedSalePrice,
          score,
        };
      })
    );
  }

  return pricedItems;
}

async function main() {
  console.log(`Checking gatherable item prices for: ${DC_OR_WORLD}\n`);

  const items = await getGatherableItems();

  if (!items.length) {
    console.log("No gatherable items found.");
    return;
  }

  console.log(`Found ${items.length} gatherable marketable items. Fetching prices...\n`);

  const pricedItems = await getUniversalisData(items);

  const sorted = pricedItems
    .filter(item => item.lowestListing !== null || item.avgRecentSale !== null)
    .sort((a, b) => b.score - a.score);
  const displayItems =
    Number.isFinite(RESULT_LIMIT) && RESULT_LIMIT > 0
      ? sorted.slice(0, RESULT_LIMIT)
      : sorted;

  console.table(
    displayItems.map(item => ({
      Item: item.name,
      Category: item.category,
      "Gather Lv": item.gatheringLevel,
      Stars: item.stars,
      Hidden: item.hidden ? "Yes" : "No",
      "Lowest Listing": item.lowestListing ?? "No listings",
      "Avg Recent Sale": item.avgRecentSale ?? "No sales",
      "Expected Sale": item.expectedSalePrice ?? "Unknown",
      "Listings Sold 24h": item.listingsSoldLast24Hours,
      "Sold 24h": item.soldLast24Hours,
      Score: item.score,
    }))
  );

  const best = sorted.find(item => item.score > 0);

  if (best) {
    console.log(
      `\nBest pick: ${best.name} - expected sale price ${best.expectedSalePrice} gil, ${best.soldLast24Hours} sold in the last 24 hours.`
    );
  } else {
    console.log("\nNo clear best pick found from current listings and recent sales.");
  }
}

main().catch(err => {
  console.error("Error:", err.message);
});
