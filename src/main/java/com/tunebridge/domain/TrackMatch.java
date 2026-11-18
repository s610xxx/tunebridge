package com.tunebridge.domain;

public record TrackMatch(
        Track source,
        boolean matched,
        boolean lowConfidence,
        String targetTrackId,
        String targetTitle,
        String targetArtist,
        String targetAlbum,
        String targetArtworkUrl,
        double score,
        String note
) {
    public static TrackMatch unmatched(Track source, String note) {
        return new TrackMatch(source, false, false, "", "", "", "", "", 0.0, note);
    }

    public static TrackMatch matched(Track source, Track target, double score, boolean lowConfidence, String note) {
        return new TrackMatch(source, true, lowConfidence,
                target.providerTrackId(), target.title(), target.artist(), target.album(),
                target.artworkUrl(), score, note);
    }
}
