// GalaxyAction Extension for Paperback - interacts with galaxyaction.net
// Handles manga discovery, search, details, chapters, and Cloudflare bypass

import {
    BasicRateLimiter,
    Chapter,
    ChapterDetails,
    ChapterProviding,
    CloudflareBypassRequestProviding,
    ContentRating,
    Cookie,
    CookieStorageInterceptor,
    DiscoverSection,
    DiscoverSectionItem,
    DiscoverSectionProviding,
    DiscoverSectionType,
    Extension,
    Form,
    MangaProviding,
    PagedResults,
    SearchFilter,
    SearchQuery,
    SearchResultItem,
    SearchResultsProviding,
    SettingsFormProviding,
    SourceInfo,
    SourceManga,
} from "@paperback/types";
import * as cheerio from "cheerio";
import { MangaReaderParser } from "./parser";
import {
    DEFAULT_CONTENT_RATING,
    DOMAIN,
    LANGUAGE,
    SEARCH_MANGA_SELECTOR,
    USE_POST_IDS,
} from "./pbconfig";

// Centralized constants for configuration and selectors
const CONSTANTS = {
    RATE_LIMIT: {
        REQUESTS: 20,
        INTERVAL: 1,
    },
    CACHE: {
        FILTER_DURATION: 5 * 60 * 1000, // 5 minutes (not used, but kept for reference)
    },
    SORTING: {
        VALID_SORTS: [
            "",
            "title",
            "titlereverse",
            "update",
            "latest",
            "popular",
        ],
    },
    SELECTORS: {
        SEARCH_MANGA: ".bsx",
        PAGINATION_NEXT: ".hpage a.r:contains('Next')",
        PAGINATION_NUMBERS: ".pagination .page-numbers",
    },
} as const;

export const GalaxyActionInfo: SourceInfo = {
    version: "1.0.0",
    name: "GalaxyAction",
    icon: "icon.png",
    description: "Extension for GalaxyAction.net",
    language: LANGUAGE,
    contentRating: DEFAULT_CONTENT_RATING,
    developers: [
        {
            name: "YourName",
            website: "",
        },
    ],
    badges: [],
    capabilities: [],
};

class GalaxyActionExtension
    implements
        Extension,
        SearchResultsProviding,
        MangaProviding,
        ChapterProviding,
        DiscoverSectionProviding,
        SettingsFormProviding,
        CloudflareBypassRequestProviding
{
    // Extension metadata and configuration
    readonly domain: string = DOMAIN;
    readonly name: string = "GalaxyAction";
    readonly defaultContentRating: ContentRating = DEFAULT_CONTENT_RATING;
    readonly language: string = LANGUAGE;
    readonly usePostIds: boolean = USE_POST_IDS;
    readonly searchMangaSelector: string = SEARCH_MANGA_SELECTOR;
    readonly directoryPath: string = "manga";

    // HTML parser for manga details, chapters, etc.
    parser: MangaReaderParser = new MangaReaderParser();

    // Maps genre labels to IDs for use in filters and details
    genreIdLabelMap: Record<string, string> = {};

    // Global rate limiter to avoid hitting server too fast
    globalRateLimiter = new BasicRateLimiter("ratelimiter", {
        numberOfRequests: CONSTANTS.RATE_LIMIT.REQUESTS,
        bufferInterval: CONSTANTS.RATE_LIMIT.INTERVAL,
        ignoreImages: true,
    });

    // Handles persistent cookie storage (for Cloudflare and login)
    cookieStorageInterceptor = new CookieStorageInterceptor({
        storage: "stateManager",
    });

    // In-memory cache for filter options (genres, status, type) for the session
    private filterOptionsCache: {
        genres: { id: string; value: string }[];
        status: { id: string; value: string }[];
        type: { id: string; value: string }[];
    } | null = null;

    // In-memory cache for sorting options for the session
    private sortingOptionsCache: { id: string; label: string }[] | null = null;

    // Register the cookie interceptor on extension initialization
    async initialise(): Promise<void> {
        this.cookieStorageInterceptor.registerInterceptor();
    }

    // Settings UI (not used, but required by interface)
    async getSettingsForm(): Promise<Form> {
        return {
            getSections: () => [],
            reloadForm: () => {},
            requiresExplicitSubmission: false,
        };
    }

    // Fetch manga details by ID (parses the manga details page)
    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        // Normalize mangaId to ensure it doesn't include /manga/ or a full URL
        let cleanId = mangaId;
        if (cleanId.startsWith("http")) {
            const match = cleanId.match(/\/manga\/([^/]+)/);
            if (match) cleanId = match[1];
        } else if (cleanId.startsWith("/manga/")) {
            cleanId = cleanId.replace("/manga/", "");
        }
        const url = `${this.domain}/manga/${cleanId}`;
        const [, buffer] = await Application.scheduleRequest({
            url,
            method: "GET",
        });
        const $ = cheerio.load(Application.arrayBufferToUTF8String(buffer));
        return await this.parser.parseMangaDetails($, cleanId, this);
    }

    // Fetch chapter list for a manga
    async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
        const url = `${this.domain}/manga/${sourceManga.mangaId}`;
        const [, buffer] = await Application.scheduleRequest({
            url,
            method: "GET",
        });
        const $ = cheerio.load(Application.arrayBufferToUTF8String(buffer));
        return this.parser.parseChapterList($, sourceManga, this);
    }

    // Fetch details for a specific chapter (pages/images)
    async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
        // Always fetch fresh data
        const url = `${this.domain}${chapter.chapterId}`;
        const [, buffer] = await Application.scheduleRequest({
            url,
            method: "GET",
        });
        const $ = cheerio.load(Application.arrayBufferToUTF8String(buffer));
        return await this.parser.parseChapterDetails($, chapter);
    }

    // Provide discover sections for the UI (recent, trending, popular)
    async getDiscoverSections(): Promise<DiscoverSection[]> {
        // Discover sections for the homepage, including Weekly Manga as a horizontal carousel
        return [
            {
                id: "weekly_manga",
                title: "Weekly Manga",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "recently_updated",
                title: "Recently Updated",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "currently_trending",
                title: "Currently Trending",
                type: DiscoverSectionType.simpleCarousel,
            },
            {
                id: "most_popular",
                title: "Most Popular",
                type: DiscoverSectionType.simpleCarousel,
            },
        ];
    }

    // Fetch items for a discover section (with pagination)
    async getDiscoverSectionItems(
        section: DiscoverSection,
        metadata: { page?: number } | undefined,
    ): Promise<PagedResults<DiscoverSectionItem>> {
        // Weekly Manga section as a horizontal carousel (simpleCarousel)
        // Uses #wpop-items .serieslist.wpop-weekly ul li to target the weekly manga list
        if (section.id === "weekly_manga") {
            const url = `${this.domain}/manga`;
            const [, buffer] = await Application.scheduleRequest({
                url,
                method: "GET",
            });
            const html = Application.arrayBufferToUTF8String(buffer);
            const $ = cheerio.load(html);

            const items: DiscoverSectionItem[] = [];
            $("#wpop-items .serieslist.wpop-weekly ul li").each((i, li) => {
                if (i >= 12) return false; // Limit to 12 items for performance
                const a = $(li).find(".imgseries a.series");
                const href = a.attr("href") || "";
                const img = a.find("img").attr("src") || "";
                const title = $(li)
                    .find(".leftseries h2 a.series")
                    .text()
                    .trim();
                if (!href || !title) return;
                // Use the same idCleaner as everywhere else for consistent mangaId
                const mangaId = this.parser.idCleaner(href);
                if (!mangaId || mangaId === "undefined" || mangaId === "null")
                    return;
                items.push({
                    type: "simpleCarouselItem",
                    mangaId,
                    imageUrl: img,
                    title,
                    subtitle:
                        $(li)
                            .find(".leftseries span")
                            .text()
                            .replace(/\s+/g, " ")
                            .trim() || undefined,
                    contentRating: undefined, // Optionally set if you can parse it
                });
            });
            // If this section is empty, check the selector or the site's HTML.
            return { items, metadata: undefined };
        }
        // Standard discover section logic (recently updated, trending, popular)
        const page = metadata?.page ?? 1;
        let order = "";
        switch (section.id) {
            case "recently_updated":
                order = "update";
                break;
            case "currently_trending":
                order = "trending";
                break;
            case "most_popular":
                order = "popular";
                break;
            default:
                order = "";
        }
        const url = `${DOMAIN}/manga/?order=${order}&page=${page}`;
        const [, buffer] = await Application.scheduleRequest({
            url,
            method: "GET",
        });
        const $ = cheerio.load(Application.arrayBufferToUTF8String(buffer));
        const items = await this.parser.parseDiscoverSections($, section, this);
        return { items, metadata: { page: page + 1 } };
    }

    // Fetch and cache filter options (genres, status, type) for the session
    async getSearchFilters(): Promise<SearchFilter[]> {
        // Check cache first
        if (this.filterOptionsCache) {
            const { genres, status, type } = this.filterOptionsCache;
            return this.buildSearchFilters(genres, status, type);
        }

        // Fetch fresh data from the /manga page
        const url = `${this.domain}/manga`;
        const [, buffer] = await Application.scheduleRequest({
            url,
            method: "GET",
        });
        const html = Application.arrayBufferToUTF8String(buffer);
        const $ = cheerio.load(html);

        // Parse all filter options in one pass
        const genreOptions: { id: string; value: string }[] = [];
        const statusOptions: { id: string; value: string }[] = [];
        const typeOptions: { id: string; value: string }[] = [];

        // Reset genre mapping
        this.genreIdLabelMap = {};

        // Parse genres
        $(".filter .genrez input.genre-item").each((_, el) => {
            const id = $(el).val()?.toString() || "";
            const label = $(el).next("label").text().trim();
            if (id && label) {
                genreOptions.push({ id, value: label });
                this.genreIdLabelMap[label.toLowerCase()] = id;
            }
        });

        // Parse status options
        $(".filter .dropdown-menu.c1 input[name='status']").each((_, el) => {
            const id = $(el).val()?.toString() || "";
            const label = $(el).next("label").text().trim();
            if (label) statusOptions.push({ id, value: label });
        });

        // Parse type options
        $(".filter .dropdown-menu.c1 input[name='type']").each((_, el) => {
            const id = $(el).val()?.toString() || "";
            const label = $(el).next("label").text().trim();
            if (label) typeOptions.push({ id, value: label });
        });

        // Cache the results for the session
        this.filterOptionsCache = {
            genres: genreOptions,
            status: statusOptions,
            type: typeOptions,
        };

        return this.buildSearchFilters(
            genreOptions,
            statusOptions,
            typeOptions,
        );
    }

    // Helper to build the SearchFilter[] array for the UI
    private buildSearchFilters(
        genreOptions: { id: string; value: string }[],
        statusOptions: { id: string; value: string }[],
        typeOptions: { id: string; value: string }[],
    ): SearchFilter[] {
        return [
            {
                type: "multiselect",
                id: "genre",
                title: "Genre",
                options: genreOptions,
                value: {},
                allowExclusion: false,
                allowEmptySelection: true,
                maximum: undefined,
            },
            {
                type: "dropdown",
                id: "status",
                title: "Status",
                options: statusOptions,
                value: "",
            },
            {
                type: "dropdown",
                id: "type",
                title: "Type",
                options: typeOptions,
                value: "",
            },
        ];
    }

    // Helper to build the search URL for manga search
    private buildSearchUrl(params: string[], page: number): string {
        const urlParams = [...params];
        // Add page parameter first for clarity
        if (page > 1) {
            urlParams.unshift(`page=${page}`);
        }
        return `${this.domain}/manga/?${urlParams.join("&")}`;
    }

    // Helper to extract search parameters from query and sorting
    private extractSearchParams(
        query: SearchQuery,
        sortingMethod?: { id: string; label: string },
    ): string[] {
        const params: string[] = [];

        // Add filters
        if (query.filters) {
            for (const filter of query.filters) {
                if (filter.id === "genre" && typeof filter.value === "object") {
                    for (const [genreId, state] of Object.entries(
                        filter.value,
                    )) {
                        if (state === "included") {
                            params.push(
                                `genre[]=${encodeURIComponent(genreId)}`,
                            );
                        }
                    }
                } else if (
                    filter.id === "status" &&
                    typeof filter.value === "string" &&
                    filter.value
                ) {
                    params.push(`status=${encodeURIComponent(filter.value)}`);
                } else if (
                    filter.id === "type" &&
                    typeof filter.value === "string" &&
                    filter.value
                ) {
                    params.push(`type=${encodeURIComponent(filter.value)}`);
                }
            }
        }

        // Add search parameter
        if (query.title && query.title.trim().length > 0) {
            params.push(`s=${encodeURIComponent(query.title.trim())}`);
        }

        // Add sorting parameter
        const validSorts = CONSTANTS.SORTING.VALID_SORTS as readonly string[];
        let orderValue = "";
        if (sortingMethod?.id) {
            orderValue = sortingMethod.id;
        } else {
            const queryObj = query as unknown as Record<string, unknown>;
            orderValue =
                (queryObj.sort as string) || (queryObj.order as string) || "";
        }
        if (!validSorts.includes(orderValue)) {
            orderValue = "";
        }
        params.push(`order=${encodeURIComponent(orderValue)}`);
        return params;
    }

    // Main search method for manga (with filters, sorting, and pagination)
    async getSearchResults(
        query: SearchQuery,
        metadata: { page?: number } | undefined,
        sortingMethod?: { id: string; label: string },
    ): Promise<PagedResults<SearchResultItem>> {
        const page = metadata?.page ?? 1;
        const params = this.extractSearchParams(query, sortingMethod);
        const url = this.buildSearchUrl(params, page);
        const [, buffer] = await Application.scheduleRequest({
            url,
            method: "GET",
        });
        const $ = cheerio.load(Application.arrayBufferToUTF8String(buffer));
        const items = await this.parser.parseSearchResults($, this);

        // Pagination detection
        let hasNextPage = false;
        if (query.title || query.filters) {
            // For filtered/search, look for Next button
            hasNextPage = $(CONSTANTS.SELECTORS.PAGINATION_NEXT).length > 0;
        } else {
            // For normal search, use page number block
            let maxPage = 1;
            $(CONSTANTS.SELECTORS.PAGINATION_NUMBERS).each((_, el) => {
                const text = $(el).text().trim();
                const num = parseInt(text);
                if (!isNaN(num) && num > maxPage) maxPage = num;
            });
            hasNextPage = page < maxPage;
        }

        return {
            items,
            metadata: hasNextPage ? { page: page + 1 } : undefined,
        };
    }

    // Store Cloudflare cookies for bypassing protection
    async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
        for (const cookie of cookies) {
            this.cookieStorageInterceptor.setCookie(cookie);
        }
    }

    // Dynamically fetch and cache sorting options for the session
    public async getSortingOptions(): Promise<{ id: string; label: string }[]> {
        if (this.sortingOptionsCache) {
            return this.sortingOptionsCache;
        }
        const url = `${this.domain}/manga`;
        const [, buffer] = await Application.scheduleRequest({
            url,
            method: "GET",
        });
        const html = Application.arrayBufferToUTF8String(buffer);
        const $ = cheerio.load(html);
        const sortingOptions: { id: string; label: string }[] = [];
        $("ul.dropdown-menu.c1 input[name='order']").each((_, el) => {
            const id = $(el).val()?.toString() ?? "";
            const label = $(el).next("label").text().trim();
            if (label) sortingOptions.push({ id, label });
        });
        this.sortingOptionsCache = sortingOptions;
        return sortingOptions;
    }

    // Manually inject a Cloudflare cookie (for manual bypass)
    async injectCloudflareCookies(cfClearanceValue: string): Promise<void> {
        if (!cfClearanceValue || cfClearanceValue.trim() === "") {
            throw new Error("cf_clearance value cannot be empty");
        }
        const cloudflareCookie: Cookie = {
            name: "cf_clearance",
            value: cfClearanceValue.trim(),
            domain: "galaxyaction.net",
            path: "/",
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
        };
        await this.saveCloudflareBypassCookies([cloudflareCookie]);
    }
}

// Export the extension instance
export const GalaxyAction = new GalaxyActionExtension();
