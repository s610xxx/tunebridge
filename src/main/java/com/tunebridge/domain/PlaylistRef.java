package com.tunebridge.domain;

/**
 * A playlist the connected source account offers for batch migration. Tracks are deliberately left
 * out: the count is only a hint for selection, and the real list is read when the item runs.
 */
public record PlaylistRef(String id, String name, String url, String coverUrl, int trackCount) {

    public PlaylistRef {
        id = safe(id);
        name = safe(name);
        url = safe(url);
        coverUrl = safe(coverUrl);
        trackCount = Math.max(0, trackCount);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
