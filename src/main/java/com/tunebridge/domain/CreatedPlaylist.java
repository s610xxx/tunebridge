package com.tunebridge.domain;

import java.util.Map;

public record CreatedPlaylist(
        String id,
        String name,
        String url,
        int trackCount,
        Map<String, String> metadata
) {
    public CreatedPlaylist {
        metadata = metadata == null ? Map.of() : Map.copyOf(metadata);
    }

    public static CreatedPlaylist of(String id, String name, String url, int trackCount) {
        return new CreatedPlaylist(id, name, url, trackCount, Map.of());
    }
}
