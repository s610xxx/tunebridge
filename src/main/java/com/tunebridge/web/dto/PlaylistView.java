package com.tunebridge.web.dto;

import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.Track;
import java.util.List;

public record PlaylistView(
        String id,
        String name,
        String description,
        String coverUrl,
        String owner,
        String webUrl,
        int totalTracks,
        boolean truncated,
        List<TrackView> tracks
) {
    public static PlaylistView from(Playlist playlist, int maxTracks) {
        List<Track> all = playlist.tracks();
        int limit = maxTracks <= 0 ? all.size() : Math.min(all.size(), maxTracks);
        List<TrackView> tracks = all.subList(0, limit).stream().map(TrackView::from).toList();
        return new PlaylistView(playlist.id(), playlist.name(), playlist.description(),
                playlist.coverUrl(), playlist.owner(), playlist.webUrl(),
                all.size(), all.size() > limit, tracks);
    }

    public record TrackView(
            String id,
            String title,
            String artist,
            String album,
            int durationSec,
            String artworkUrl
    ) {
        public static TrackView from(Track track) {
            return new TrackView(track.providerTrackId(), track.title(), track.artist(),
                    track.album(), track.durationSec(), track.artworkUrl());
        }
    }
}
