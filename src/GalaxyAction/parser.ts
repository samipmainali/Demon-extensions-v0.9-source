// Responsible for parsing HTML responses from galaxyaction.net
// Extracts manga details, chapter lists, chapter pages, search results, and discover sections

import {
    Chapter,
    ChapterDetails,
    ContentRating,
    DiscoverSection,
    DiscoverSectionItem,
    DiscoverSectionType,
    SearchResultItem,
    SourceManga,
    Tag,
    TagSection,
} from "@paperback/types";
import { CheerioAPI } from "cheerio";

export class MangaReaderParser {
    // Parses manga details from the details page HTML
    async parseMangaDetails(
        $: CheerioAPI,
        mangaId: string,
        source: { domain: string; defaultContentRating: ContentRating },
    ): Promise<SourceManga> {
        const title: string = Application.decodeHTMLEntities(
            $("h1.entry-title").text().trim(),
        );
        const secondaryTitles: string[] = [];
        // Extract author and artist
        const author: string = Application.decodeHTMLEntities(
            $("span:contains('Author'), span:contains('Author(s)')")
                .parent()
                .find("a")
                .first()
                .text()
                .trim(),
        );
        const artist: string = Application.decodeHTMLEntities(
            $("span:contains('Artist'), span:contains('Artist(s)')")
                .parent()
                .find("a")
                .first()
                .text()
                .trim(),
        );
        // Extract synopsis/description
        const synopsis: string = Application.decodeHTMLEntities(
            $(
                "div.description, div.summary, .manga-description, .entry-content",
            )
                .first()
                .text()
                .trim(),
        );
        const shareUrl: string = `${source.domain}/manga/${mangaId}`;
        const image: string = $("div.thumb img").first().attr("src") || "";
        // Extract status
        let status = "Ongoing";
        const statusImptdt = $(".imptdt:contains('Status') i")
            .first()
            .text()
            .trim();
        if (statusImptdt) {
            const normalized = statusImptdt.toLowerCase();
            if (["completed", "finished"].includes(normalized)) {
                status = "Completed";
            } else if (["hiatus", "on hold"].includes(normalized)) {
                status = "Hiatus";
            } else if (["cancelled", "dropped"].includes(normalized)) {
                status = "Cancelled";
            } else {
                status =
                    statusImptdt.charAt(0).toUpperCase() +
                    statusImptdt.slice(1);
            }
        }
        // Extract genres and content rating
        let contentRating = ContentRating.EVERYONE;
        const genreKeywords: string[] = [];
        const genres: Tag[] = [];
        $("span.mgen a").each((_, obj) => {
            const title = $(obj).text().trim();
            const id = this.idCleaner($(obj).attr("href") || "");
            if (!title || !id) return;
            genreKeywords.push(title.toLowerCase());
            genres.push({ id, title });
        });
        const filteredGenres = genres.filter(
            (g) => !(g.id === "debug" && g.title === "DEBUG"),
        );
        if (genreKeywords.some((g) => ["adult", "18+", "nsfw"].includes(g))) {
            contentRating = ContentRating.ADULT;
        } else if (genreKeywords.some((g) => ["mature", "ecchi"].includes(g))) {
            contentRating = ContentRating.MATURE;
        }
        // Extract rating if available
        let rating: number | undefined = undefined;
        const ratingElem = $(".num[itemprop='ratingValue']");
        if (ratingElem.length > 0) {
            const ratingStr = ratingElem.attr("content") || ratingElem.text();
            const parsed = parseFloat(ratingStr);
            if (!isNaN(parsed)) {
                rating = parsed / 10;
            }
        } else {
            const numScoreElem = $(".numscore").first();
            if (numScoreElem.length > 0) {
                const ratingStr = numScoreElem.text();
                const parsed = parseFloat(ratingStr);
                if (!isNaN(parsed)) {
                    rating = parsed / 10;
                }
            }
        }
        const tagGroups: TagSection[] = [
            { id: "genres", title: "Genres", tags: filteredGenres },
        ];
        return {
            mangaId,
            mangaInfo: {
                shareUrl: shareUrl,
                primaryTitle: title,
                secondaryTitles: secondaryTitles,
                thumbnailUrl: image,
                author: author,
                artist: artist,
                tagGroups: tagGroups,
                synopsis: synopsis,
                contentRating: contentRating,
                status: status,
                ...(rating !== undefined ? { rating } : {}),
            },
        };
    }

    // Extracts chapter list from the manga page
    parseChapterList(
        $: CheerioAPI,
        sourceManga: SourceManga,
        source: { domain: string; language: string },
    ): Chapter[] {
        const chapters: Chapter[] = [];
        const nodeArray = $("li[data-num]");
        const total = nodeArray.length;
        nodeArray.each((i, obj) => {
            const sortingIndex = total - i;
            const href = $("a", obj).attr("href") || "";
            if (
                !href ||
                href.startsWith("#") ||
                href.includes("{{") ||
                href.includes("}}")
            )
                return;
            let chapterId = href;
            if (href.startsWith("http")) {
                const match = href.match(/^https?:\/\/[^/]+(\/.*)$/);
                if (match) chapterId = match[1];
            }
            const chapName = $(".chapternum", obj).text().trim();
            const chapterDate = $(".chapterdate", obj).text().trim();
            const chapNumRegex = chapterId.match(
                /(?:chapter|ch.*?)(\d+\.?\d?(?:[-_]\d+)?)|(\d+\.?\d?(?:[-_]\d+)?)$/,
            );
            let chapNum: string | number =
                chapNumRegex && chapNumRegex[1]
                    ? chapNumRegex[1].replace(/[-_]/gm, ".")
                    : (chapNumRegex?.[2] ?? "0");
            chapNum = parseFloat(chapNum) ?? 0;
            const mangaTime = this.parseDate(chapterDate);
            if (!chapterId || chapterId === "#") {
                return;
            }
            chapters.push({
                sourceManga: sourceManga,
                chapterId: chapterId,
                langCode: source.language,
                chapNum: chapNum,
                title: chapName ? Application.decodeHTMLEntities(chapName) : "",
                publishDate: mangaTime,
                sortingIndex: sortingIndex,
            });
        });
        return chapters;
    }

    // Extracts image URLs for a chapter
    async parseChapterDetails(
        $: CheerioAPI,
        chapter: Chapter,
    ): Promise<ChapterDetails> {
        const pages: string[] = [];
        const images =
            this.extractImagesFromScript($) || this.extractImagesFromReader($);
        pages.push(...images);
        return {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            pages: pages,
        };
    }

    // Extracts image URLs from the ts_reader.run script
    public extractImagesFromScript($: CheerioAPI): string[] {
        const images: string[] = [];
        const scriptContent = $("script")
            .map((_, el) => $(el).html() || "")
            .get()
            .find((script) => script.includes("ts_reader.run"));
        if (!scriptContent) return images;
        const imagesMatch = scriptContent.match(/"images"\s*:\s*(\[[^\]]*\])/);
        if (!imagesMatch?.[1]) return images;
        try {
            const cleanArray = imagesMatch[1]
                .replace(/'/g, '"')
                .replace(/,]/g, "]")
                .replace(/,\s*]/g, "]");
            const imageArray = JSON.parse(cleanArray) as string[];
            if (Array.isArray(imageArray)) {
                for (const url of imageArray) {
                    if (this.isValidImageUrl(url)) {
                        images.push(url);
                    }
                }
            }
        } catch {
            const urlMatches = imagesMatch[1].match(/"([^"\\]+)"/g);
            if (urlMatches) {
                for (const match of urlMatches) {
                    const url = match.replace(/"/g, "");
                    if (this.isValidImageUrl(url)) {
                        images.push(url);
                    }
                }
            }
        }
        return images;
    }

    // Extracts image URLs from the #readerarea fallback
    public extractImagesFromReader($: CheerioAPI): string[] {
        const images: string[] = [];
        $("#readerarea img").each((_, obj) => {
            const src = $(obj).attr("src") || $(obj).attr("data-src") || "";
            if (this.isValidImageUrl(src)) {
                images.push(src);
            }
        });
        return images;
    }

    // Checks if a URL is a valid image (not SVG or empty)
    private isValidImageUrl(url: string): boolean {
        return Boolean(
            url &&
                typeof url === "string" &&
                url.trim().length > 0 &&
                !url.includes("readerarea.svg") &&
                !url.includes("data:image/svg"),
        );
    }

    // Parses search results from the search page
    async parseSearchResults(
        $: CheerioAPI,
        source: { searchMangaSelector: string; usePostIds: boolean },
    ): Promise<SearchResultItem[]> {
        const items: SearchResultItem[] = [];
        const selector = source.searchMangaSelector || ".bsx";
        $(selector).each((_, obj) => {
            const a = $("a", obj);
            const href = a.attr("href") || "";
            const title = $(".tt", obj).text().trim();
            const image = encodeURI($(".limit img", obj).attr("src") || "");
            const subtitle = $(".epxs", obj).text().trim();
            if (!href || !title) return;
            const mangaId = this.idCleaner(href);
            if (!mangaId || mangaId === "undefined" || mangaId === "null")
                return;
            items.push({
                mangaId: mangaId,
                imageUrl: image,
                title: Application.decodeHTMLEntities(title),
                subtitle: Application.decodeHTMLEntities(subtitle),
            });
        });
        return items;
    }

    // Parses discover section items (carousel, featured, etc.)
    async parseDiscoverSections(
        $: CheerioAPI,
        section: DiscoverSection,
        source: { searchMangaSelector: string; usePostIds: boolean },
    ): Promise<DiscoverSectionItem[]> {
        const items: DiscoverSectionItem[] = [];
        const selector = source.searchMangaSelector || ".bsx";
        $(selector).each((_, obj) => {
            const a = $("a", obj);
            const href = a.attr("href") || "";
            const title = $(".tt", obj).text().trim();
            const image = encodeURI($(".limit img", obj).attr("src") || "");
            const subtitle = $(".epxs", obj).text().trim();
            if (!href || !title) return;
            const mangaId = this.idCleaner(href);
            if (!mangaId || mangaId === "undefined" || mangaId === "null")
                return;
            switch (section.type) {
                case DiscoverSectionType.featured:
                    items.push({
                        mangaId: mangaId,
                        imageUrl: image,
                        title: Application.decodeHTMLEntities(title),
                        supertitle: Application.decodeHTMLEntities(subtitle),
                        type: "featuredCarouselItem",
                    });
                    break;
                case DiscoverSectionType.prominentCarousel:
                    items.push({
                        mangaId: mangaId,
                        imageUrl: image,
                        title: Application.decodeHTMLEntities(title),
                        subtitle: Application.decodeHTMLEntities(subtitle),
                        type: "prominentCarouselItem",
                    });
                    break;
                case DiscoverSectionType.simpleCarousel:
                    items.push({
                        mangaId: mangaId,
                        imageUrl: image,
                        title: Application.decodeHTMLEntities(title),
                        subtitle: Application.decodeHTMLEntities(subtitle),
                        type: "simpleCarouselItem",
                    });
                    break;
            }
        });
        return items;
    }

    // Returns the directory path for manga (usually "manga")
    parseDirectoryPath(): string {
        return "manga";
    }

    // Extracts the last part of a URL (used for IDs)
    public idCleaner(url: string): string {
        if (!url || typeof url !== "string") return "";
        const cleanUrl = url.split("?")[0];
        const parts = cleanUrl.split("/").filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : cleanUrl;
    }

    // Parses dates from various formats
    private parseDate(dateString: string): Date {
        if (!dateString) return new Date();
        const date = dateString.trim();
        if (date.includes("ago") || date.includes("just now")) {
            return new Date();
        }
        const parsedDate = new Date(date);
        return isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
    }
}
