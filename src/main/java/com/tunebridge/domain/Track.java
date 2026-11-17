package com.tunebridge.domain;

public record Track(
        String providerTrackId,
        String title,
        String artist,
        String album,
        int durationSec,
        String artworkUrl,
        int songType
) {
    public Track {
        providerTrackId = safe(providerTrackId);
        title = safe(title);
        artist = safe(artist);
        album = safe(album);
        artworkUrl = safe(artworkUrl);
    }

    public static Track of(String id, String title, String artist, String album, int durationSec) {
        return new Track(id, title, artist, album, durationSec, "", 0);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
