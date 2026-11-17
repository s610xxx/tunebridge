package com.tunebridge.domain;

import java.util.List;

public record Playlist(
        String id,
        String name,
        String description,
        String coverUrl,
        String owner,
        String webUrl,
        List<Track> tracks
) {
    public Playlist {
        id = safe(id);
        name = safe(name);
        description = safe(description);
        coverUrl = safe(coverUrl);
        owner = safe(owner);
        webUrl = safe(webUrl);
        tracks = tracks == null ? List.of() : List.copyOf(tracks);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
