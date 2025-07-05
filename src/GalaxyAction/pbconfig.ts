// Paperback extension configuration for GalaxyAction
import { ContentRating, SourceInfo, SourceIntents } from "@paperback/types";

const getVersion = (): string => {
    return "1.0.0";
};

export const DOMAIN = "https://galaxyaction.net";
export const LANGUAGE = "en";
export const DEFAULT_CONTENT_RATING = ContentRating.EVERYONE;

// Selectors and config for parsing
export const SEARCH_MANGA_SELECTOR = ".bsx";
export const USE_POST_IDS = false;

// Cloudflare bypass cookie key
export const CLOUDFLARE_COOKIE_KEY = "cf_clearance";

export default {
    name: "GalaxyAction",
    description: "Extension that pulls content from galaxyaction.net.",
    version: getVersion(),
    icon: "icon.png",
    language: "🇬🇧",
    contentRating: ContentRating.MATURE,
    badges: [],
    capabilities:
        SourceIntents.MANGA_CHAPTERS |
        SourceIntents.DISCOVER_SECIONS |
        SourceIntents.SETTINGS_UI |
        SourceIntents.MANGA_SEARCH |
        SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
    developers: [
        {
            name: "samipmainali",
            github: "https://github.com/samipmainali",
        },
    ],
} satisfies SourceInfo;
