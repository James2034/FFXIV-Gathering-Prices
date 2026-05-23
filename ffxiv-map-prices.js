// ffxiv-map-prices.js
// Run: node ffxiv-map-prices.js
// Optional: node ffxiv-map-prices.js Crystal

const DC_OR_WORLD = process.argv[2] || "Mateus";

const XIVAPI_BASE = "https://v2.xivapi.com/api";
const UNIVERSALIS_BASE = "https://universalis.app/api/v2";
const HISTORY_ENTRIES = 50;
const ONE_DAY_IN_SECONDS = 24 * 60 * 60;

async function fetchJson(url) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}\n${url}`);
  }

  return res.json();
}

async function getTimewornMaps() {
  const query = encodeURIComponent('Name~"Timeworn"');
  const results = [];
  let url = `${XIVAPI_BASE}/search?sheets=Item&query=${query}&fields=Name&limit=100`;

  while (url) {
    const data = await fetchJson(url);
    results.push(...(data.results ?? []));

    url = data.next
      ? `${XIVAPI_BASE}/search?fields=Name&limit=100&cursor=${encodeURIComponent(data.next)}`
      : null;
  }

  const regex = /^Timeworn.*Map$/i;

  return results
    .filter(item => regex.test(item.fields?.Name))
    .map(item => ({
      id: item.row_id,
      name: item.fields.Name,
    }));
}

async function getUniversalisData(maps) {
  const ids = maps.map(map => map.id).join(",");
  const url = `${UNIVERSALIS_BASE}/${DC_OR_WORLD}/${ids}?entries=${HISTORY_ENTRIES}`;

  const data = await fetchJson(url);
  const oneDayAgo = Math.floor(Date.now() / 1000) - ONE_DAY_IN_SECONDS;

  return maps.map(map => {
    const market = data.items?.[map.id];

    const listings = market?.listings ?? [];
    const sales = market?.recentHistory ?? [];

    const lowestListing = listings.length
      ? Math.min(...listings.map(l => l.pricePerUnit))
      : null;

    const avgRecentSale = sales.length
      ? Math.round(
          sales.reduce((sum, sale) => sum + sale.pricePerUnit, 0) /
            sales.length
        )
      : null;

    const recentSales = sales.length;
    const soldLast24Hours = sales
      .filter(sale => sale.timestamp >= oneDayAgo)
      .reduce((sum, sale) => sum + (sale.quantity ?? 1), 0);

    // For gathering and selling yourself, your "profit" is basically the expected sale price.
    const expectedSalePrice =
      lowestListing !== null && avgRecentSale !== null
        ? Math.min(lowestListing, avgRecentSale)
        : avgRecentSale ?? lowestListing;

    // Score favors maps that sell for more and have moved in the last 24 hours.
    const score =
      expectedSalePrice !== null
        ? expectedSalePrice * Math.min(soldLast24Hours, 10)
        : 0;

    return {
      name: map.name,
      id: map.id,
      lowestListing,
      avgRecentSale,
      recentSales,
      soldLast24Hours,
      expectedSalePrice,
      score,
    };
  });
}

async function main() {
  console.log(`Checking Timeworn Map prices for: ${DC_OR_WORLD}\n`);

  const maps = await getTimewornMaps();

  if (!maps.length) {
    console.log("No Timeworn Maps found.");
    return;
  }

  const pricedMaps = await getUniversalisData(maps);

  const sorted = pricedMaps
    .filter(map => map.lowestListing !== null || map.avgRecentSale !== null)
    .sort((a, b) => b.score - a.score);

  console.table(
    sorted.map(map => ({
      Map: map.name,
      "Lowest Listing": map.lowestListing ?? "No listings",
      "Avg Recent Sale": map.avgRecentSale ?? "No sales",
      "Expected Sale": map.expectedSalePrice ?? "Unknown",
      "Recent Sales": map.recentSales,
      "Sold 24h": map.soldLast24Hours,
      Score: map.score,
    }))
  );

  const best = sorted.find(map => map.score > 0);

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
