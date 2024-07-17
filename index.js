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

  const product = json.products.find(
    (product) =>
      product["product-name"] === productName &&
      product["product-line-name"] === "Star Wars: Unlimited" &&
      product["set-name"] === SET_SHD_NAME
  );

  console.assert(
    product,
    `No TCG Player card found for: ${productName}`,
    decodeURIComponent(tcgPlayerSearchUrl.toString()),
    JSON.stringify(json.products)
  );

  return product && product["product-id"];
}

async function fetchTcgPlayerMarketPrice(tcgPlayerId) {
  const tcgPlayerCardDetailsUrl = new URL(
    `/v1/product/${tcgPlayerId}/details`,
    CARD_DETAILS_API_URL
  );

  //   console.log("Fetching card details at ", tcgPlayerCardDetailsUrl);

  const result = await fetch(tcgPlayerCardDetailsUrl);
  const json = await result.json();

  return json.marketPrice;
}

async function fetchCardData(cardData) {
  const cardName = `${cardData.attributes.title}${
    cardData.attributes.subtitle ? ` - ${cardData.attributes.subtitle}` : ""
  }`;
  const cardNumber = cardData.attributes.cardNumber;
  const isHyperspace = cardData.attributes.hyperspace;
  const isShowcase = cardData.attributes.showcase;
  const rarity = cardData.attributes.rarity.data.attributes.name
  let tcgPlayerId = null;
  let marketPriceUsd = 0

  if(rarity === 'Rare' || rarity === 'Legendary') {
    // TCG Player appears to not like us firing a lot of requests at once
    // so we add an artificial delay
    await sleep(cardNumber * 10);

    tcgPlayerId = await fetchTcgPlayerId(cardName, isHyperspace);
    marketPriceUsd = tcgPlayerId
      ? await fetchTcgPlayerMarketPrice(tcgPlayerId)
      : 0;
  }

  return {
    cardNumber,
    cardName,
    isHyperspace,
    isShowcase,
    tcgPlayerId: tcgPlayerId ? tcgPlayerId : '',
    marketPriceUsd,
    marketPriceAud: await getAUDPrice(marketPriceUsd),
    rarity
  };
}

async function writeToFile(fileName, data) {
  fs.writeFileSync(fileName, JSON.stringify(data));
}

async function getExchangeRate() {
  if (exchangeRateCache) return exchangeRateCache;
  try {
      const response = await fetch('https://open.er-api.com/v6/latest/USD');
      const data = await response.json();
      exchangeRateCache = data.rates.AUD;
      return exchangeRateCache;
  } catch (error) {
      console.error('Failed to fetch exchange rate:', error);
      return null;
  }
}

async function getAUDPrice(price) {
  const exchangeRate = await getExchangeRate()
  const convertedPrice = price * exchangeRate * 1.1;
  let roundedPrice = Math.floor(convertedPrice * 2) / 2;
  return roundedPrice.toFixed(2)
}

async function main() {
  const cardList = await fetchCardList(SET_SHD_ID);

  const result = await Promise.all(cardList.map(fetchCardData));
  // console.log(result.filter(card => card.rarity === 'Rare' || card.rarity === 'Legendary').filter(card => card.marketPriceAud > 2).sort((a, b) => b.marketPriceUsd - a.marketPriceUsd))
  // console.log(result);

  writeToFile("./card-list.json", result.filter(card => card.rarity === 'Rare' || card.rarity === 'Legendary').sort((a, b) => b.marketPriceUsd - a.marketPriceUsd));
}

main();
