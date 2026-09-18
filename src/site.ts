import { load } from "cheerio";
import { Data, Effect } from "effect";
import { centsToNumber, parseMoney } from "./catalog";
import type { SourceProduct, SourceVariant } from "./types";

export class ExtractionError extends Data.TaggedError("ExtractionError")<{
  readonly message: string;
  readonly url: string;
}> {}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

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
): Effect.Effect<SourceProduct, ExtractionError> {
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
      yield* requiredText("h4.price", "price"),
    ).pipe(Effect.mapError((error) => invalid(error.message)));

    const currencies = wrapper.find('[itemprop="priceCurrency"]');

    if (currencies.length !== 1 || currencies.attr("content") !== "USD")
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
    const variants: SourceVariant[] = [];

    if (buttons.length > 0) {
      if (normalize(wrapper.find("label.memory").text()) !== "HDD:")
        return yield* invalid(`Unknown configuration control: ${url}`);

      if (
        buttons.filter(".active").length !== 1 ||
        buttons.filter(".active").attr("value") !== "128"
      ) {
        return yield* invalid(`Unverified initial storage selection: ${url}`);
      }

      // First-party EcommerceProduct.updatePrice; browser-verified in docs/source-behavior.md.
      const additions: Record<string, number> = {
        "128": 0,
        "256": 2000,
        "512": 4000,
        "1024": 6000,
      };

      for (const element of buttons) {
        const button = $(element);
        const key = button.attr("value") ?? "";
        const addition = Object.hasOwn(additions, key)
          ? additions[key]
          : undefined;

        if (addition === undefined || normalize(button.text()) !== key)
          return yield* invalid(
            `Unknown storage option ${JSON.stringify(key)}: ${url}`,
          );

        if (button.is(":disabled") || button.attr("aria-disabled") === "true")
          continue;

        const priceCents = price + addition;
        yield* centsToNumber(priceCents).pipe(
          Effect.mapError((error) => invalid(error.message)),
        );

        variants.push({ key, label: `${key} GB`, priceCents });
      }

      if (variants.length === 0)
        return yield* invalid(`No enabled storage options: ${url}`);
    } else {
      if (wrapper.find(".swatches, label.memory").length)
        return yield* invalid(`Missing storage buttons: ${url}`);

      variants.push({ key: "base", priceCents: price });
    }

    const colors: string[] = [];

    for (const element of wrapper.find(".dropdown")) {
      const select = $(element).children("select");

      if (select.length !== 1 || select.find("option").length === 0)
        return yield* invalid(`Missing or ambiguous color control: ${url}`);
    }

    for (const element of wrapper.find("select")) {
      const select = $(element);

      if (
        select.attr("aria-label")?.toLowerCase() !== "color" ||
        !select.parent().is(".dropdown")
      )
        return yield* invalid(`Unknown selectable option: ${url}`);

      if (select.is(":disabled")) continue;

      for (const optionElement of select.find("option")) {
        const option = $(optionElement);

        if (option.is(":disabled") || option.attr("value") === "") continue;

        const text = normalize(option.text());

        if (!text) return yield* invalid(`Empty color option: ${url}`);

        colors.push(text);
      }
    }

    return {
      id: identity.href,
      name,
      description,
      variants,
      colors: [...new Set(colors)].sort(),
    };
  });
}
