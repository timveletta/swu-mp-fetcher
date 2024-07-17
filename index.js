const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const SET_SHD_ID = 8;
const SET_SHD_NAME = "Shadows of the Galaxy";
const CARDS_API_URL = new URL(
  "/api/cards",
  "https://admin.starwarsunlimited.com"
);
const CARD_SEARCH_API_URL = new URL(
  "/autocomplete",
  "https://data.tcgplayer.com/"
);
const CARD_DETAILS_API_URL = new URL("https://mp-search-api.tcgplayer.com/");
const CARD_PRICE_POINTS_API_URL = new URL("https://mpapi.tcgplayer.com/");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let exchangeRateCache = null;

async function fetchCardList(setId, page = 1, cardList = []) {
  const cardListURL = new URL(CARDS_API_URL);

  cardListURL.searchParams.append(
    "filters[$and][1][expansion][id][$in][0]",
    setId
  );
  cardListURL.searchParams.append("pagination[page]", page);
  cardListURL.searchParams.append("pagination[pageSize]", 50);

  // only search for rares and legendaries cards
  cardListURL.searchParams.append("filters[$and][1][rarity][id][$in][0]", 17);
  cardListURL.searchParams.append("filters[$and][1][rarity][id][$in][1]", 12);

  console.log("Fetching card list page ", page);

  const result = await fetch(cardListURL);
  const json = await result.json();

  cardList.push(...json.data);

  if (page !== json.meta.pagination.pageCount) {
    return await fetchCardList(setId, ++page, cardList);
  }

  return cardList;
}

async function fetchTcgPlayerId(cardName, isHyperspace) {
  // Bazine is a special case because TCG player misspells it only for the hyperspace card
  if (isHyperspace && cardName === "Bazine Netal - Spy for the First Order") {
    cardName = "Bazine Natal - Spy for the First Order";
  }

  const productName = `${cardName}${isHyperspace ? " (Hyperspace)" : ""}`;
  const tcgPlayerSearchUrl = new URL(CARD_SEARCH_API_URL);

  tcgPlayerSearchUrl.searchParams.append("q", productName);
  tcgPlayerSearchUrl.searchParams.append("session-id", uuidv4());
  tcgPlayerSearchUrl.searchParams.append(
    "product-line-affinity",
    "Star+Wars:+Unlimited"
  );
  tcgPlayerSearchUrl.searchParams.append("algorithm", "product_line_affinity");

  // if I don't include this, it doesn't like cards with special characters in the name
  const result = await fetch(decodeURIComponent(tcgPlayerSearchUrl.toString()));
  const json = await result.json();

  let product = json.products.find((product) => {
    return (
      product["product-name"].replace(/[^a-zA-Z0-9\s]/g, "") ===
        productName.replace(/[^a-zA-Z0-9\s]/g, "") &&
      product["product-line-name"] === "Star Wars: Unlimited" &&
      product["set-name"] === SET_SHD_NAME
    );
  });

  // if multiple products found, take the highest confidence "score" one
  if (!product) {
    product = json.products
      .sort((productA, productB) => productB["score"] - productA["score"])
      .shift();
  }

  console.assert(
    product,
    `No TCG Player card found for: ${productName}`,
    decodeURIComponent(tcgPlayerSearchUrl.toString()),
    JSON.stringify(json.products)
  );

  return product && product["product-id"];
}

async function fetchTcgPlayerMarketPrice(tcgPlayerId) {
  const tcgPlayerCardPricePointsUrl = new URL(
    `/v2/product/${tcgPlayerId}/pricepoints`,
    CARD_PRICE_POINTS_API_URL
  );
  const tcgPlayerCardDetailsUrl = new URL(
    `/v1/product/${tcgPlayerId}/details`,
    CARD_DETAILS_API_URL
  );

  try {
    const result = await fetch(tcgPlayerCardPricePointsUrl);
    const json = await result.json();

    const normal = json.find(
      (pricePoint) => pricePoint.printingType === "Normal"
    );
    const foil = json.find((pricePoint) => pricePoint.printingType === "Foil");
    console.assert(
      normal,
      `No normal price point found for TCG Player ID: ${tcgPlayerId}`
    );
    console.assert(
      foil,
      `No foil price point found for TCG Player ID: ${tcgPlayerId}`
    );
    return { normal: normal.marketPrice, foil: foil.marketPrice };
  } catch {
    const result = await fetch(tcgPlayerCardDetailsUrl);
    const json = await result.json();

    return { normal: json.marketPrice, foil: 0 };
  }
}

async function fetchCardData(cardData) {
  const cardName = `${cardData.attributes.title}${
    cardData.attributes.subtitle ? ` - ${cardData.attributes.subtitle}` : ""
  }`;
  const cardNumber = cardData.attributes.cardNumber;
  const cardType = cardData.attributes.type.data.attributes.name;
  const isHyperspace = cardData.attributes.hyperspace;
  const isShowcase = cardData.attributes.showcase;
  const rarity = cardData.attributes.rarity.data.attributes.name;
  let tcgPlayerId = null;

  // TV: commenting this out because I changed the filters from the SWU website to
  // only get rare or legendary cards, I don't mind if you want to include it again
  // if (rarity === "Rare" || rarity === "Legendary") {

  // TCG Player appears to not like us firing a lot of requests at once
  // so we add an artificial delay

  await sleep(cardNumber * 10);
  tcgPlayerId = await fetchTcgPlayerId(cardName, isHyperspace);
  marketPricesUsd = await fetchTcgPlayerMarketPrice(tcgPlayerId);
  // }

  return {
    cardNumber,
    cardName,
    cardType,
    isHyperspace,
    isShowcase,
    tcgPlayerId: tcgPlayerId ? tcgPlayerId : "",
    marketPricesUsd,
    marketPricesAud: {
      normal: await getAUDPrice(marketPricesUsd.normal),
      foil: await getAUDPrice(marketPricesUsd.foil),
    },
    rarity,
  };
}

async function writeToFile(fileName, data) {
  fs.writeFileSync(fileName, JSON.stringify(data));
}

async function getExchangeRate() {
  if (exchangeRateCache) return exchangeRateCache;
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await response.json();
    exchangeRateCache = data.rates.AUD;
    console.log("Current exchange rate is: ", exchangeRateCache);
    return exchangeRateCache;
  } catch (error) {
    console.error("Failed to fetch exchange rate:", error);
    return null;
  }
}

async function getAUDPrice(price) {
  const exchangeRate = await getExchangeRate();
  const convertedPrice = price * exchangeRate * 1.1;
  let roundedPrice = Math.floor(convertedPrice * 2) / 2;
  return Number(roundedPrice.toFixed(2));
}

// creates a product name that Square is happy with because it starts with a # and has - instead of spaces
function generateProductId(cardName) {
  return `#${cardName
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase()}`;
}

// find details about the intended structure of the call to Square at
// https://developer.squareup.com/reference/square/catalog-api/batch-upsert-catalog-objects
function prepareSquareBatchUpsert(cardListResults) {
  return {
    idempotency_key: uuidv4(),
    batches: [
      // batches will need to be split up if more than 1000 items are being added
      {
        objects: cardListResults
          .filter((card) => !card.isHyperspace) // filter out hyperspaces because they will be listed as variations
          .map((card) => {
            const itemId = generateProductId(card.cardName);
            const hyperspaceCard = cardListResults.find(
              (otherCard) =>
                otherCard.cardName.toLowerCase() ===
                  card.cardName.toLowerCase() && otherCard.isHyperspace // convert everything to lowercase because Wrecker - BOOM!
            );

            console.assert(
              hyperspaceCard,
              `No hyperspace card found for ${card.cardName}`
            );

            const variations = [
              {
                type: "ITEM_VARIATION",
                id: `${itemId}-regular-nonfoil`,
                item_variation_data: {
                  itemId,
                  name: card.cardName,
                  pricing_type: "FIXED_PRICING",
                  sellable: true,
                  stockable: true,
                  track_inventory: true,
                  price_money: {
                    currency: "AUD",
                    amount: card.marketPricesAud.normal * 100, // square wants prices in cents
                  },
                },
              },
              {
                type: "ITEM_VARIATION",
                id: `${itemId}-regular-foil`,
                item_variation_data: {
                  itemId,
                  name: card.cardName,
                  pricing_type: "FIXED_PRICING",
                  sellable: true,
                  stockable: true,
                  track_inventory: true,
                  price_money: {
                    currency: "AUD",
                    amount:
                      card.marketPricesAud.foil !== 0
                        ? card.marketPricesAud.foil * 100
                        : card.marketPricesAud.normal * 100, // not sure how you want to handle it when TCG Player doesn't list a price for the foil
                  },
                },
              },
            ];

            if (hyperspaceCard) {
              variations.push(
                {
                  type: "ITEM_VARIATION",
                  id: `${itemId}-hyperspace-nonfoil`,
                  item_variation_data: {
                    itemId,
                    name: card.cardName,
                    pricing_type: "FIXED_PRICING",
                    sellable: true,
                    stockable: true,
                    track_inventory: true,
                    price_money: {
                      currency: "AUD",
                      amount: hyperspaceCard.marketPricesAud.normal * 100,
                    },
                  },
                },
                {
                  type: "ITEM_VARIATION",
                  id: `${itemId}-hyperspace-foil`,
                  item_variation_data: {
                    itemId,
                    name: card.cardName,
                    pricing_type: "FIXED_PRICING",
                    sellable: true,
                    stockable: true,
                    track_inventory: true,
                    price_money: {
                      currency: "AUD",
                      amount:
                        hyperspaceCard.marketPricesAud.foil !== 0
                          ? hyperspaceCard.marketPricesAud.foil * 100
                          : hyperspaceCard.marketPricesAud.normal * 100, // not sure how you want to handle it when TCG Player doesn't list a price for the foil
                    },
                  },
                }
              );
            }

            return {
              type: "ITEM",
              id: itemId,
              item_data: {
                name: card.cardName,
                description_html: `<p>Star Wars Unlimited</p><p>Set: Shadows of the Galaxy</p><p>Rarity ${card.rarity}</p><p>Type ${card.type}</p>`,
                available_online: true,
                available_for_pickup: true,
                variations,
              },
              categories: [
                {
                  id: "VHF4QESYJ6PLCE34HDKAUHJI", // Shadows of the Galaxy
                },
              ],
            };
          }),
      },
    ],
  };
}

async function main() {
  const cardList = await fetchCardList(SET_SHD_ID);

  const result = await Promise.all(cardList.map(fetchCardData));

  writeToFile("./square-upsert.json", prepareSquareBatchUpsert(result));
}

main();
