import { load } from "cheerio";
import { Data, Effect } from "effect";
import { parseMoney } from "./catalog";

export class ExtractionError extends Data.TaggedError("ExtractionError")<{
  readonly message: string;
  readonly url: string;
}> {}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function normalizeDisplayedPrice(text: string) {
  const decimal = text.replace(/^\$/, "");

  if (!/^(0|[1-9]\d*)\.\d{3,}$/.test(decimal)) return text;

  const amount = Number(decimal);
  const rounded = amount.toFixed(2);
  // Page arithmetic can display 497.17 + 20 as 517.1700000000001.
  // Accept only a Number's own representation within floating-point noise of cents.
  const tolerance = Math.min(1e-9, Math.abs(amount) * Number.EPSILON);

  if (
    String(amount) !== decimal ||
    Math.abs(amount - Number(rounded)) > tolerance
  )
    return text;

  return rounded;
}

export interface ProductChoice {
  key: string;
  label: string;
}

/** One observed page state. Unselected options have no inferred prices. */
export interface ProductSnapshot {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  storage: ProductChoice[];
  selectedStorage: string | undefined;
  colors: ProductChoice[];
}

export function parseListing(
  html: string,
  url: string,
): Effect.Effect<{ links: string[]; productLinks: string[] }, ExtractionError> {
  return Effect.gen(function* () {
    const invalid = (message: string) => new ExtractionError({ url, message });
    const $ = load(html);

    if ($(".test-site #side-menu").length !== 1)
      return yield* invalid(`Missing catalog navigation: ${url}`);

    const cards = $('.test-site [itemtype="https://schema.org/Product"]');

    for (const element of cards) {
      if ($(element).find("a.title[href]").length !== 1)
        return yield* invalid(
          `Missing or ambiguous product link in catalog card: ${url}`,
        );
    }

    for (const element of $(
      ".test-site #side-menu a, .test-site .pagination a",
    )) {
      if (!$(element).attr("href"))
        return yield* invalid(`Missing navigation link destination: ${url}`);
    }

    const pagination = $(".test-site .pagination");

    if (
      $(".test-site #static-pagination").children().length &&
      pagination.length !== 1
    )
      return yield* invalid(`Missing or ambiguous static pagination: ${url}`);

    for (const element of pagination.find("li:not(.active):not(.disabled)")) {
      if ($(element).find("a[href]").length !== 1)
        return yield* invalid(`Missing or ambiguous pagination link: ${url}`);
    }

    const count = $(".test-site .item-count");

    if (count.length) {
      const match = /^(\d+) items?$/.exec(normalize(count.text()));
      const advertised = match?.[1] && Number(match[1]);
      const pageUrl = yield* Effect.try({
        try: () => new URL(url),
        catch: () => invalid(`Invalid catalog URL: ${url}`),
      });
      const page = Number(pageUrl.searchParams.get("page") ?? "1");

      if (
        count.length !== 1 ||
        !advertised ||
        !Number.isSafeInteger(advertised) ||
        !Number.isSafeInteger(page) ||
        page < 1
      )
        return yield* invalid(
          `Invalid or empty advertised catalog count: ${url}`,
        );

      // The static site displays six items per page; pinned by the real category fixture.
      const expected = Math.min(6, advertised - (page - 1) * 6);

      if (expected <= 0 || cards.length !== expected)
        return yield* invalid(
          `Catalog card count disagrees with advertised inventory: ${url}`,
        );

      if (advertised > 6 && pagination.find("a[href]").length === 0)
        return yield* invalid(
          `Missing pagination for advertised inventory: ${url}`,
        );
    } else if (
      $(".test-site .subcategory-link.active").length &&
      cards.length === 0
    ) {
      return yield* invalid(
        `Selected catalog category is unexpectedly empty: ${url}`,
      );
    }

    const links = new Set<string>();
    const productLinks = new Set<string>();

    for (const element of $(
      ".test-site #side-menu a[href], .test-site .pagination a[href], .test-site a.title[href]",
    )) {
      const href = $(element).attr("href");

      if (!href) return yield* invalid(`Empty catalog link: ${url}`);

      const target = yield* Effect.try({
        try: () => new URL(href, url),
        catch: () => invalid(`Invalid catalog link at ${url}: ${href}`),
      });
      target.hash = "";

      if ($(element).is("a.title")) {
        if (!/\/product\/\d+\/?$/.test(target.pathname))
          return yield* invalid(`Unexpected product link: ${target.href}`);

        productLinks.add(target.href);
      } else links.add(target.href);
    }

    return { links: [...links], productLinks: [...productLinks] };
  });
}

export function parseProduct(
  html: string,
  url: string,
  observedCurrency?: "USD",
): Effect.Effect<ProductSnapshot, ExtractionError> {
  return Effect.gen(function* () {
    const invalid = (message: string) => new ExtractionError({ url, message });
    const $ = load(html);
    const wrapper = $(".test-site .product-wrapper");

    if (wrapper.length !== 1)
      return yield* invalid(`Expected one product detail at ${url}`);

    const requiredText = (selector: string, field: string) =>
      Effect.gen(function* () {
        const elements = wrapper.find(selector);
        const text = normalize(elements.text());

        if (elements.length !== 1 || !text)
          return yield* invalid(`Missing or ambiguous ${field}: ${url}`);

        return text;
      });

    const name = yield* requiredText("h4.title", "name");
    const description = yield* requiredText(".description", "description");
    const price = yield* parseMoney(
      normalizeDisplayedPrice(yield* requiredText("h4.price", "price")),
    ).pipe(Effect.mapError((error) => invalid(error.message)));

    const currencies = wrapper.find('[itemprop="priceCurrency"]');

    // Some controls replace the price heading, removing its nested metadata.
    // A browser reader may retain the currency validated earlier on this page.
    if (
      currencies.length > 1 ||
      (currencies.length === 1 && currencies.attr("content") !== "USD") ||
      (currencies.length === 0 && observedCurrency !== "USD")
    )
      return yield* invalid(`Unsupported or missing currency: ${url}`);

    const identity = yield* Effect.try({
      try: () => new URL(url),
      catch: () => invalid(`Invalid product identity: ${url}`),
    });

    if (!/\/product\/\d+\/?$/.test(identity.pathname))
      return yield* invalid(`Invalid product identity: ${url}`);

    identity.hash = "";
    identity.search = "";
    identity.pathname = identity.pathname.replace(/\/$/, "");

    const buttons = wrapper.find(".swatches button");
    const storage: ProductChoice[] = [];
    let selectedStorage: string | undefined;

    if (buttons.length > 0) {
      if (
        wrapper.find(".swatches").length !== 1 ||
        normalize(wrapper.find("label.memory").text()) !== "HDD:"
      )
        return yield* invalid(`Unknown configuration control: ${url}`);

      if (buttons.filter(".active").length !== 1)
        return yield* invalid(`Missing or ambiguous storage selection: ${url}`);

      selectedStorage = buttons.filter(".active").attr("value");
      const keys = new Set<string>();

      for (const element of buttons) {
        const button = $(element);
        const key = button.attr("value") ?? "";
        const text = normalize(button.text());

        if (!key || !text || keys.has(key))
          return yield* invalid(
            `Missing or duplicate storage option ${JSON.stringify(key)}: ${url}`,
          );

        keys.add(key);

        if (button.is(":disabled") || button.attr("aria-disabled") === "true")
          continue;

        storage.push({ key, label: /^\d+$/.test(text) ? `${text} GB` : text });
      }

      if (storage.length === 0)
        return yield* invalid(`No enabled storage options: ${url}`);

      if (!storage.some((choice) => choice.key === selectedStorage))
        return yield* invalid(`Selected storage is not enabled: ${url}`);
    } else {
      if (wrapper.find(".swatches, label.memory").length)
        return yield* invalid(`Missing storage buttons: ${url}`);
    }

    if (
      wrapper.find(
        'input:not([type="hidden"]), textarea, [role="combobox"], [role="radio"], [role="checkbox"]',
      ).length ||
      wrapper.find("button").length !== buttons.length ||
      wrapper.find("select").length > 1
    )
      return yield* invalid(`Unknown selectable option: ${url}`);

    const colors = new Map<string, ProductChoice>();

    for (const element of wrapper.find(".dropdown")) {
      const select = $(element).children("select");

      if (select.length !== 1 || select.find("option").length === 0)
        return yield* invalid(`Missing or ambiguous color control: ${url}`);
    }

    for (const element of wrapper.find("select")) {
      const select = $(element);

      if (
        select.attr("aria-label")?.toLowerCase() !== "color" ||
        !select.parent().is(".dropdown") ||
        select.is("[multiple]")
      )
        return yield* invalid(`Unknown selectable option: ${url}`);

      if (select.is(":disabled")) continue;

      for (const optionElement of select.find("option")) {
        const option = $(optionElement);

        if (
          option.is(":disabled") ||
          option.closest("optgroup[disabled]").length ||
          option.attr("aria-disabled") === "true" ||
          option.attr("value") === ""
        )
          continue;

        const text = normalize(option.text());
        const key = option.attr("value") ?? option.text().trim();

        if (!text || !key) return yield* invalid(`Empty color option: ${url}`);

        if (colors.has(key) && colors.get(key)?.label !== text)
          return yield* invalid(`Conflicting color option: ${url}`);

        colors.set(key, { key, label: text });
      }

      if (!colors.size)
        return yield* invalid(`No enabled color options: ${url}`);
    }

    return {
      id: identity.href,
      name,
      description,
      priceCents: price,
      storage,
      selectedStorage,
      colors: [...colors.values()],
    };
  });
}
